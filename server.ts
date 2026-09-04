import express from "express";
import path from "path";
import { GoogleGenAI, Type } from "@google/genai";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { decodeWavBase64, forcedAlignLineWords, arbitrateDualWordTimestamps, alignSpeechWordsToLyrics, detectGlobalVocalOnset } from "./server/forcedAlignment.js";
import { recognizeAudioWithWordTimestamps } from "./server/speechToText.js";
import { alignAudioWordsLocally } from "./src/utils/aligner.js";

dotenv.config();

const app = express();
const PORT = 3000;

// Support larger audio payloads (WAV files can be several MBs)
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Initialize Google GenAI client lazily or when requested
function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is not configured.");
  }
  return new GoogleGenAI({ apiKey });
}

// Health check endpoint
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

// Dedicated Forced-Alignment Word Refining endpoint
app.post("/api/forced-align-words", async (req, res) => {
  try {
    const { audioBase64, linesWithTiming } = req.body;
    if (!audioBase64 || !Array.isArray(linesWithTiming)) {
      return res.status(400).json({ error: "Missing audioBase64 or linesWithTiming." });
    }

    const pcm = decodeWavBase64(audioBase64);
    const updated = linesWithTiming.map((item: any) => {
      const words = (item.text || "").split(/\s+/).filter(Boolean);
      const existingCandidateAi = Array.isArray(item.words) && item.words.length === words.length
        ? item.words
        : null;

      const alignedWords = arbitrateDualWordTimestamps(words, existingCandidateAi, item.startTime, item.endTime, pcm);
      const totalScore = alignedWords.reduce((acc, w) => acc + (w.acousticScore || 80), 0);
      const lineAcousticScore = Math.round(totalScore / Math.max(1, alignedWords.length));

      return {
        ...item,
        words: alignedWords,
        lineAcousticScore,
      };
    });

    return res.json({ success: true, items: updated });
  } catch (err: any) {
    console.error("Error in /api/forced-align-words:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Dedicated Forced-Alignment Word & Line endpoint using Gemini
app.post("/api/precise-word-alignment", async (req, res) => {
  try {
    const { audioBase64, referenceLyrics, mode = "word", modelName = "gemini-3.7-flash", debugLabel = "" } = req.body;
    const logTag = debugLabel ? ` [${debugLabel}]` : '';
    if (!audioBase64 || !referenceLyrics) {
      return res.status(400).json({ error: "Missing audioBase64 or referenceLyrics." });
    }

    const cleanAudioBase64 = String(audioBase64).replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "");

    if (mode === 'micro-chunk') {
      try {
        // Convert incoming base64 back into a raw node binary buffer
        const audioBuffer = Buffer.from(cleanAudioBase64, 'base64');

        // Execute local mathematical forced-alignment on the raw audio signal bytes
        const precisionTimings = await alignAudioWordsLocally(audioBuffer, referenceLyrics);
        
        // Return the millisecond-accurate timing directly to the client
        return res.json(precisionTimings);
      } catch (localAlignErr: any) {
        console.warn("Local phonetic aligner failed, falling back to Gemini:", localAlignErr);
        // Fall through to Gemini if local decode fails
      }
    }

    const isMicroChunkMode = mode === "micro-chunk";
    const isWordMode = mode === "word";
    const ai = getGeminiClient();

    const chunkSystemInstruction = `You are an expert, sub-second phonetic subtitle alignment system processing a short 3-6 second audio snippet. Your sole task is to align the provided verbatim text lyrics to the exact millisecond they are clearly articulated in the audio track.

CRITICAL TIMING & VERBAL LAWS:
1. HUMMING IS NOT SPEECH: Do not map written words onto introductory humming, vocal ad-libs without text ("Mmmm", "Ooh", "Aah"), or instrumental sections. Set "isVerbalSpeech" to false ONLY if a timing block represents instrumental space or non-verbal humming tracks. Set to true for all actual spoken or sung lyrics.
2. EXPLICIT ONSET REQUIREMENT: The "relativeStart" of the very first word must reflect the exact millisecond the first consonant sound is clearly formed by the speaker/singer (consonant attack onset).
3. CONTINUOUS TIMELINES: The "relativeStart" of a word must sequentially follow the "relativeEnd" of the previous word.
4. VERBATIM COUNTS: You must output exactly one JSON object for every individual word in the target line string. Do not alter text or combine separate words into a single element.`;

    const wordSystemInstruction = `You are an expert, sub-second phonetic subtitle alignment system. Your sole task is to align the provided verbatim text lyrics to the exact millisecond they are clearly articulated in the audio track.

CRITICAL TIMING & VERBAL LAWS:
1. HUMMING IS NOT SPEECH: Do not map written words onto introductory humming, vocal ad-libs without text ("Mmmm", "Ooh", "Aah"), or instrumental sections.
2. EXPLICIT ONSET REQUIREMENT: The "startTime" of each word must reflect the exact millisecond the leading consonant sound or initial vowel sound is clearly formed by the singer (true phonetic acoustic attack onset, not the middle of the vowel).
3. PHRASE-PACING & ANTI-RUSHING LAW: In vocal singing tracks, words naturally space out to match musical measure beats. Do NOT rush or compress words into the front portion of a musical bar. Listen for the actual acoustic vowel burst of each individual word across the entire sung line.
4. STRUCTURAL SECTION TIMINGS: When words belong to a new phrase or verse (e.g. after a pause), lock the start timestamp directly onto the singer's vocal attack after the breath/pause.
5. TRUE ACOUSTIC WORD DURATION & GAPS: Output the true startTime (vocal attack) and endTime (vocal release/consonant closure) for each word. Typical sung word durations are 0.18s to 0.45s (or up to 0.65s for sustained vowels). Do not stretch words across silent inter-word breath gaps (0.10s to 0.30s) or across multi-second instrumental pauses between verses.
6. COMPLETE COVERAGE: Return every requested word in sequence without dropping words or skipping lines.`;

    const systemInstruction = isMicroChunkMode
      ? chunkSystemInstruction
      : isWordMode
      ? wordSystemInstruction
      : `You are an advanced Audio-to-Lyric Line Aligner. Your sole job is to take the provided .wav audio file and the exact list of lyric lines provided by the user, and find the start and end timestamps for each full line.

OUTPUT FORMAT REQUIREMENTS:
You must output a single, valid JSON array containing objects structured exactly like this example:
[
  { "lineIndex": 1, "text": "The exact text of line 1", "startTime": 2.100, "endTime": 6.400 }
]

CRITICAL RULES FOR ACCURACY:
1. STRICT VERBATIM MATCHING: Use only the exact words provided in the lyric text lines.
2. TIME BOUNDARIES: Identify start and end times in seconds down to the millisecond for each full line.
3. SEQUENTIAL ORDER: Ensure lines are sequentially ordered in chronological sequence without overlap.`;

    const chunkResponseSchema = {
      type: Type.ARRAY,
      description: "Sequential chronological list of every individual word token spoken in the track.",
      items: {
        type: Type.OBJECT,
        properties: {
          word: {
            type: Type.STRING,
            description: "The exact verbatim word from the lyric sheet."
          },
          relativeStart: {
            type: Type.NUMBER,
            description: "Start time in seconds relative to the start of this short clip (0.0)"
          },
          relativeEnd: {
            type: Type.NUMBER,
            description: "End time in seconds relative to the start of this short clip"
          },
          isVerbalSpeech: {
            type: Type.BOOLEAN,
            description: "Set to false ONLY if this timing block represents instrumental space or non-verbal humming tracks. Set to true for all actual spoken or sung lyrics."
          }
        },
        required: ["word", "relativeStart", "relativeEnd", "isVerbalSpeech"]
      }
    };

    const wordResponseSchema = {
      type: Type.ARRAY,
      description: "Sequential chronological list of every individual word token spoken in the track.",
      items: {
        type: Type.OBJECT,
        properties: {
          word: {
            type: Type.STRING,
            description: "The exact verbatim word from the lyric sheet."
          },
          startTime: {
            type: Type.NUMBER,
            description: "Absolute timestamp in seconds from the beginning of the audio track (e.g., 14.240)."
          },
          endTime: {
            type: Type.NUMBER,
            description: "Absolute timestamp in seconds when the pronunciation of the word finishes."
          },
          isVerbalSpeech: {
            type: Type.BOOLEAN,
            description: "Set to false ONLY if this timing block represents instrumental space or non-verbal humming tracks. Set to true for all actual spoken or sung lyrics."
          }
        },
        required: ["word", "startTime", "endTime", "isVerbalSpeech"],
      },
    };

    const lineResponseSchema = {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          lineIndex: { type: Type.INTEGER },
          text: { type: Type.STRING },
          startTime: { type: Type.NUMBER },
          endTime: { type: Type.NUMBER },
        },
        required: ["lineIndex", "text", "startTime", "endTime"],
      },
    };

    const responseSchema = isMicroChunkMode
      ? chunkResponseSchema
      : isWordMode
      ? wordResponseSchema
      : lineResponseSchema;

    const candidateModels = Array.from(new Set([
      modelName,
      "gemini-2.5-flash",
      "gemini-3.7-flash",
      "gemini-flash-latest",
      "gemini-2.5-pro",
      "gemini-3.1-flash-lite",
    ])).filter(Boolean);

    let alignedData: any[] = [];
    let lastError: any = null;
    // True when every Gemini candidate model failed (quota/availability) and we fell back
    // to the naive whole-span proportional/syllable-weight distribution below, which has no
    // real acoustic basis at all - the client needs to know this so it doesn't mistake a
    // well-formed but low-quality guess for a genuine alignment result.
    let usedProportionalFallback = false;

    const promptText = isMicroChunkMode
      ? `Here is the single lyric line to align to this short audio clip with millisecond precision:\n\n${referenceLyrics}`
      : isWordMode
      ? `Here is the exact reference text to align word-for-word with the provided audio wave file:\n\n${referenceLyrics}`
      : `Here is the exact reference lyrics to align line-by-line with the provided audio wave file:\n\n${referenceLyrics}`;

    for (const candidate of candidateModels) {
      // Single attempt per candidate, not two: retrying the SAME model after a brief 500ms
      // pause rarely succeeds when it's genuinely busy/quota-exhausted, and doubling the
      // request count per candidate was a major contributor to both very long total run
      // times and burning through daily quota in just one or two runs. Move on to the next
      // candidate immediately instead.
      for (let attempt = 1; attempt <= 1; attempt++) {
        try {
          const response = await ai.models.generateContent({
            model: candidate,
            contents: [
              {
                role: "user",
                parts: [
                  {
                    inlineData: {
                      mimeType: "audio/wav",
                      data: cleanAudioBase64,
                    },
                  },
                  {
                    text: promptText,
                  },
                ],
              },
            ],
            config: {
              systemInstruction,
              temperature: 0.0,
              responseMimeType: "application/json",
              responseSchema,
            },
          });

          if (response && response.text) {
            alignedData = JSON.parse(response.text.trim());
            console.log(`Model ${candidate} succeeded.${logTag}`);
            break;
          }
        } catch (err: any) {
          lastError = err;
          const isUnavailable = err?.status === "UNAVAILABLE" || err?.code === 503 || String(err?.message || "").includes("503");
          const isRateLimited = err?.status === "RESOURCE_EXHAUSTED" || err?.code === 429 || String(err?.message || "").includes("429");
          
          if (isUnavailable && attempt === 1) {
            console.log(`Model ${candidate} is temporarily busy (503), retrying with backoff...${logTag}`);
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }

          console.log(`Model ${candidate} not available (${isRateLimited ? 'quota exhausted' : 'busy'}), switching to next candidate...${logTag}`);
          break; // move to next candidate model immediately
        }
      }

      if (alignedData && alignedData.length > 0) {
        break;
      }
    }

    // If Gemini models are experiencing high demand / outages, fall back to phonetic acoustic alignment
    if (alignedData.length === 0) {
      console.log("Gemini models busy, activating server acoustic-phonetic alignment.");
      usedProportionalFallback = true;
      const pcmData = decodeWavBase64(audioBase64);
      const duration = pcmData?.duration || 180;
      const detectedOnset = Math.max(0.5, detectGlobalVocalOnset(pcmData));
      const activeSpan = Math.max(2, duration - detectedOnset - 1.0);

      if (isMicroChunkMode) {
        const rawWords = referenceLyrics.split(/\s+/).filter(Boolean);
        const weights = rawWords.map((w: string) => {
          const clean = w.toLowerCase().replace(/[^a-z0-9]/g, '');
          const vowels = clean.match(/[aeiouy]{1,2}/g);
          let syl = vowels ? vowels.length : 1;
          if (clean.endsWith('e') && !clean.endsWith('le') && syl > 1) syl -= 1;
          return Math.max(1, syl * 2 + clean.length * 0.3);
        });
        const totalW = weights.reduce((a: number, b: number) => a + b, 0) || 1;
        const chunkDuration = Math.max(0.5, pcmData?.duration || 3.5);
        let cur = 0.05;
        const span = Math.max(0.2, chunkDuration - 0.1);

        alignedData = rawWords.map((w: string, idx: number) => {
          const dur = (weights[idx] / totalW) * span;
          const wStart = cur;
          const wEnd = idx === rawWords.length - 1 ? chunkDuration : cur + dur;
          cur = wEnd;
          return {
            word: w,
            relativeStart: +wStart.toFixed(3),
            relativeEnd: +wEnd.toFixed(3),
          };
        });
      } else if (isWordMode) {
        const rawWords = referenceLyrics.split(/\s+/).filter(Boolean);
        const weights = rawWords.map((w) => {
          const clean = w.toLowerCase().replace(/[^a-z0-9]/g, '');
          const vowels = clean.match(/[aeiouy]{1,2}/g);
          let syl = vowels ? vowels.length : 1;
          if (clean.endsWith('e') && !clean.endsWith('le') && syl > 1) syl -= 1;
          return Math.max(1, syl * 2 + clean.length * 0.3);
        });
        const totalW = weights.reduce((a, b) => a + b, 0) || 1;
        let cur = detectedOnset;

        alignedData = rawWords.map((w, idx) => {
          const dur = (weights[idx] / totalW) * activeSpan;
          const wStart = cur;
          const wEnd = idx === rawWords.length - 1 ? (detectedOnset + activeSpan) : cur + dur;
          cur = wEnd;
          return {
            word: w,
            startTime: +wStart.toFixed(3),
            endTime: +wEnd.toFixed(3),
          };
        });
      } else {
        const lines = referenceLyrics.split("\n").map((l: string) => l.trim()).filter(Boolean);
        const step = activeSpan / Math.max(1, lines.length);
        alignedData = lines.map((l: string, idx: number) => ({
          lineIndex: idx + 1,
          text: l,
          startTime: +(detectedOnset + idx * step).toFixed(3),
          endTime: +(detectedOnset + (idx + 1) * step).toFixed(3),
        }));
      }
    }

    if (isMicroChunkMode) {
      return res.json({ data: alignedData, usedProportionalFallback });
    }

    return res.json({
      success: true,
      mode,
      words: isWordMode ? alignedData : undefined,
      items: !isWordMode ? alignedData : undefined,
      data: alignedData,
      usedProportionalFallback,
    });
  } catch (err: any) {
    console.error("Error in /api/precise-word-alignment:", err);
    return res.status(500).json({ error: err.message || "Failed to align audio." });
  }
});

// Align lyrics to audio endpoint - Fast Single-Pass Global Macro Route
app.post("/api/align-lyrics", async (req, res) => {
  try {
    const {
      audioBase64,
      mimeType = "audio/wav",
      lyricsText,
      lyricsLines,
      lines,
      mode = "line",
      audioDuration,
      analysis,
      firstLineAnchor,
    } = req.body;

    if (!audioBase64) {
      return res.status(400).json({ error: "Missing required audioBase64." });
    }

    const cleanAudioBase64 = String(audioBase64).replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "");

    // Prepare clean line list from any supported format
    const inputLines: string[] = Array.isArray(lyricsLines) && lyricsLines.length > 0
      ? lyricsLines
      : Array.isArray(lines) && lines.length > 0
      ? lines
      : typeof lyricsText === "string"
        ? lyricsText.split("\n").map((l: string) => l.trim()).filter(Boolean)
        : [];

    if (inputLines.length === 0) {
      return res.status(400).json({ error: "Missing lyric text or lines array." });
    }

    console.log(`🎬 Initiating fast single-pass global macro alignment for ${inputLines.length} lines...`);

    const pcmData = decodeWavBase64(cleanAudioBase64);
    const approxDuration = typeof audioDuration === "number" && audioDuration > 0
      ? audioDuration
      : (pcmData?.duration || 180);
    const vocalSegments = Array.isArray(analysis?.vocalSegments) ? analysis.vocalSegments : [];

    const lineResponseSchema = {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          lineIndex: { type: Type.NUMBER, description: "1-based line index" },
          text: { type: Type.STRING, description: "Verbatim lyric line text" },
          startTime: { type: Type.NUMBER, description: "Absolute start time in seconds (float)" },
          endTime: { type: Type.NUMBER, description: "Absolute end time in seconds (float)" }
        },
        required: ["lineIndex", "text", "startTime", "endTime"]
      }
    };

    const systemInstruction = `You are a professional audio-to-text macro alignment system.
Map the provided list of verbatim lyric lines to their true start and end timestamps.
Do not guess timestamps during instrumental intros, guitar solos, or non-verbal humming tracks. 
If a line begins after an instrumental intro, its startTime must reflect the exact millisecond the first actual word is articulated.
Return strictly chronological, non-overlapping timestamps for all ${inputLines.length} lines.`;

    const candidateModels = [
      "gemini-3.7-flash",
      "gemini-3.1-flash-lite",
      "gemini-flash-latest",
      "gemini-2.5-flash"
    ];

    let parsedItems: any[] | null = null;
    let alignmentSource: "gemini_ai" | "vocal_energy" = "gemini_ai";

    const ai = getGeminiClient();

    for (const modelName of candidateModels) {
      let succeeded = false;
      // Same reasoning as the word-alignment endpoint above: one attempt per candidate
      // instead of two, to cut down total request count/time when models are busy.
      for (let attempt = 1; attempt <= 1; attempt++) {
        try {
          const response = await ai.models.generateContent({
            model: modelName,
            contents: [
              {
                inlineData: {
                  mimeType: mimeType.includes("wav") ? "audio/wav" : mimeType.includes("mp3") || mimeType.includes("mpeg") ? "audio/mp3" : mimeType,
                  data: cleanAudioBase64
                }
              },
              {
                text: `Align these lines verbatim:\n\n${inputLines.map((l, idx) => `[${idx + 1}] ${l}`).join('\n')}`
              }
            ],
            config: {
              systemInstruction,
              temperature: 0.0,
              responseMimeType: "application/json",
              responseSchema: lineResponseSchema
            }
          });

          if (response && response.text) {
            const rawData = JSON.parse(response.text.trim());
            if (Array.isArray(rawData) && rawData.length > 0) {
              parsedItems = rawData;
              succeeded = true;
              break;
            }
          }
        } catch (modelErr: any) {
          const is503 = modelErr?.status === "UNAVAILABLE" || modelErr?.code === 503 || String(modelErr?.message || "").includes("503");
          if (is503 && attempt === 1) {
            console.log(`[Global Align] Model ${modelName} is temporarily busy (503), retrying with backoff...`);
            await new Promise((resolve) => setTimeout(resolve, 1000));
            continue;
          }
          console.log(`[Global Align] Model ${modelName} unavailable, cascading to next model...`);
          break;
        }
      }
      if (succeeded) break;
    }

    // Process and normalize output items
    let finalCues: any[] = [];
    if (parsedItems && parsedItems.length > 0) {
      finalCues = inputLines.map((lineText, idx) => {
        const item = parsedItems?.find((p: any) => p.lineIndex === idx + 1) || parsedItems?.[idx];
        const s = typeof item?.startTime === "number" ? Math.max(0, item.startTime) : (idx * 3.0);
        const e = typeof item?.endTime === "number" ? Math.min(approxDuration, Math.max(s + 0.1, item.endTime)) : (s + 2.5);
        return {
          id: `cue-${idx + 1}-${Date.now()}-${idx}`,
          index: idx + 1,
          lineIndex: idx + 1,
          text: lineText,
          startTime: +s.toFixed(3),
          endTime: +e.toFixed(3),
        };
      });
      alignmentSource = "gemini_ai";
    } else {
      console.warn("Gemini global alignment unavailable, using vocal energy acoustic segments.");
      const step = approxDuration / inputLines.length;
      finalCues = inputLines.map((lineText, idx) => {
        const targetTime = idx * step;
        const nearestSeg = vocalSegments.find((s: any) => Math.abs(s.startTime - targetTime) < step * 0.75);
        const s = nearestSeg ? nearestSeg.startTime : targetTime;
        const e = nearestSeg ? Math.min(approxDuration, nearestSeg.endTime + 0.25) : Math.min(approxDuration, s + step * 0.85);
        return {
          id: `cue-${idx + 1}-${Date.now()}-${idx}`,
          index: idx + 1,
          lineIndex: idx + 1,
          text: lineText,
          startTime: +s.toFixed(3),
          endTime: +Math.max(s + 0.1, e).toFixed(3),
        };
      });
      alignmentSource = "vocal_energy";
    }

    console.log(`✅ Success! Compiled ${finalCues.length} line containers via ${alignmentSource}.`);
    return res.json({
      success: true,
      items: finalCues,
      lineCount: finalCues.length,
      mode: mode || "line",
      source: alignmentSource
    });

  } catch (error: any) {
    console.error("Global alignment error:", error);
    return res.status(500).json({
      error: "Failed to compile line containers.",
      message: error?.message || error
    });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`LyricSRT Studio server running on http://localhost:${PORT}`);
  });
}

startServer();
