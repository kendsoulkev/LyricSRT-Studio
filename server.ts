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
    const { audioBase64, referenceLyrics, mode = "word", modelName = "gemini-3.7-flash" } = req.body;
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

    const chunkSystemInstruction = `You are a high-precision phonetic micro-aligner processing a short 3-6 second audio snippet.
Your sole job is to distribute the words of the provided text sequentially across the clip timeline.

CRITICAL RULES FOR ACCURACY:
1. CONTINUOUS TIMELINES: The "relativeStart" of a word must exactly equal the "relativeEnd" of the previous word. Do not leave accidental gaps or structural holes in the middle of a continuous sentence.
2. VERBATIM COUNTS: You must output exactly one JSON object for every individual word in the target line string. Do not alter text or combine separate words into a single element.`;

    const systemInstruction = isMicroChunkMode
      ? chunkSystemInstruction
      : isWordMode
      ? `You are an advanced Audio-to-Lyric Forced Alignment engine running at the INDIVIDUAL WORD level. 
Your goal is to map the user-provided reference text perfectly to the spoken or sung words in the uploaded audio file.

OUTPUT FORMAT REQUIREMENTS:
You must output a single, valid JSON array containing objects structured exactly like this example, with absolute millisecond precision. Do not wrap the JSON output in markdown blocks or include any conversational text:
[
  { "word": "Hello", "startTime": 1.240, "endTime": 1.620 },
  { "word": "world", "startTime": 1.650, "endTime": 2.110 }
]

CRITICAL RULES FOR ACCURACY:
1. STRICT WORD SEPARATION: Output a separate JSON object for EVERY individual word found in the reference text. Do not group words together.
2. TIME BOUNDARIES: Identify exactly when each word starts and stops down to the millisecond.
3. VERBATIM MATCHING: Use only the exact words provided in the text input.
4. SUSTAINED NOTES: If a word is held for several seconds, its endTime must reflect when the vocal sound finishes.`
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
      items: {
        type: Type.OBJECT,
        properties: {
          word: { type: Type.STRING },
          relativeStart: { type: Type.NUMBER, description: "Start time in seconds relative to the start of this short clip (0.0)" },
          relativeEnd: { type: Type.NUMBER, description: "End time in seconds relative to the start of this short clip" }
        },
        required: ["word", "relativeStart", "relativeEnd"]
      }
    };

    const wordResponseSchema = {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          word: { type: Type.STRING },
          startTime: { type: Type.NUMBER },
          endTime: { type: Type.NUMBER },
        },
        required: ["word", "startTime", "endTime"],
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
      "gemini-3.7-flash",
      "gemini-flash-latest",
      "gemini-3.1-flash-lite",
    ])).filter(Boolean);

    let alignedData: any[] = [];
    let lastError: any = null;

    const promptText = isMicroChunkMode
      ? `Here is the single lyric line to align to this short audio clip with millisecond precision:\n\n${referenceLyrics}`
      : isWordMode
      ? `Here is the exact reference text to align word-for-word with the provided audio wave file:\n\n${referenceLyrics}`
      : `Here is the exact reference lyrics to align line-by-line with the provided audio wave file:\n\n${referenceLyrics}`;

    for (const candidate of candidateModels) {
      // Try candidate model
      for (let attempt = 1; attempt <= 2; attempt++) {
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
            break;
          }
        } catch (err: any) {
          lastError = err;
          const isUnavailable = err?.status === "UNAVAILABLE" || err?.code === 503 || String(err?.message || "").includes("503");
          const isRateLimited = err?.status === "RESOURCE_EXHAUSTED" || err?.code === 429 || String(err?.message || "").includes("429");
          
          if (isUnavailable && attempt === 1) {
            console.log(`Model ${candidate} is temporarily busy (503), retrying with backoff...`);
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }

          console.log(`Model ${candidate} not available (${isRateLimited ? 'quota exhausted' : 'busy'}), switching to next candidate...`);
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
      return res.json(alignedData);
    }

    return res.json({
      success: true,
      mode,
      words: isWordMode ? alignedData : undefined,
      items: !isWordMode ? alignedData : undefined,
      data: alignedData,
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
      for (let attempt = 1; attempt <= 2; attempt++) {
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
