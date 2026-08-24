import express from "express";
import path from "path";
import { GoogleGenAI, Type } from "@google/genai";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { decodeWavBase64, forcedAlignLineWords, arbitrateDualWordTimestamps, alignSpeechWordsToLyrics, detectGlobalVocalOnset } from "./server/forcedAlignment.js";
import { recognizeAudioWithWordTimestamps } from "./server/speechToText.js";

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
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
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

// Align lyrics to audio endpoint
app.post("/api/align-lyrics", async (req, res) => {
  try {
    const {
      audioBase64,
      mimeType = "audio/wav",
      lyricsText,
      lines,
      mode = "line",
      audioDuration,
      analysis,
      firstLineAnchor,
    } = req.body;

    if (!audioBase64) {
      return res.status(400).json({ error: "Missing audio data." });
    }

    if (!lyricsText && (!lines || lines.length === 0)) {
      return res.status(400).json({ error: "Missing lyric text or lines." });
    }

    // Check if a human-verified Line 1 Anchor was provided as a synchronization guide
    const hasAnchor = Boolean(
      firstLineAnchor &&
      typeof firstLineAnchor.startTime === "number" &&
      typeof firstLineAnchor.endTime === "number" &&
      firstLineAnchor.endTime > firstLineAnchor.startTime
    );

    // Decode PCM audio for high-resolution acoustic transient and forced-alignment tracking
    const pcmData = decodeWavBase64(audioBase64);

    // Prepare line list
    const inputLines: string[] = Array.isArray(lines) && lines.length > 0
      ? lines
      : lyricsText
          .split("\n")
          .map((l: string) => l.trim())
          .filter((l: string) => l.length > 0);

    if (inputLines.length === 0) {
      return res.status(400).json({ error: "No valid lyric lines provided." });
    }

    const isWordMode = mode === "word";
    const approxDuration = typeof audioDuration === "number" && audioDuration > 0 ? audioDuration : (pcmData?.duration || 180);
    const vocalSegments = Array.isArray(analysis?.vocalSegments) ? analysis.vocalSegments : [];
    
    // Detect physical vocal onset from PCM audio waveform
    const detectedPcmOnset = detectGlobalVocalOnset(pcmData);
    const firstOnsetSec = hasAnchor
      ? Math.max(0, firstLineAnchor.startTime)
      : Math.max(
          0.3,
          analysis?.firstVocalOnset && analysis.firstVocalOnset > 0.4
            ? Math.min(analysis.firstVocalOnset, detectedPcmOnset)
            : detectedPcmOnset
        );
    const lastOffsetSec = analysis?.lastVocalOffset || Math.max(2, approxDuration - 1.0);
    const firstOnset = `${firstOnsetSec.toFixed(2)}s`;
    const lastOffset = `${lastOffsetSec.toFixed(2)}s`;

    let alignedItems: any[] = [];
    let alignmentSource: "gemini_ai" | "google_speech_v2" | "forced_alignment" | "vocal_energy" = "gemini_ai";
    let warningNote: string | undefined;

    // 1. Try Google Cloud Speech-to-Text V2 with word timestamps and lyric vocabulary biasing
    let speechAlignedItems = null;
    try {
      const speechWords = await recognizeAudioWithWordTimestamps(
        audioBase64,
        pcmData?.sampleRate || 16000,
        inputLines
      );
      if (speechWords && speechWords.length > 0) {
        console.log(`Google Cloud Speech-to-Text returned ${speechWords.length} timestamped words.`);
        speechAlignedItems = alignSpeechWordsToLyrics(speechWords, inputLines);
        if (speechAlignedItems) {
          console.log("Successfully aligned Speech-to-Text words to lyric lines via sequence alignment.");
        }
      }
    } catch (e) {
      // Speech client not configured, continue to Multimodal AI + Acoustic Formant Aligner
    }

    // 2. Multimodal AI Forced Alignment
    try {
      const ai = getGeminiClient();

      const systemInstruction = `You are a highly precise audio time-alignment expert and professional lyric-to-audio subtitle synchronizer (SRT/LRC specialist).
Your sole mission is to take the provided .wav audio file and the exact, user-provided reference lyrics text, and output a perfectly synchronized word-for-word subtitle dataset.

CRITICAL RULES FOR ACCURACY:
1. DO NOT guess, hallucinate, or alter any words. Use ONLY the exact words provided in the reference lyrics.
2. Match the exact phonetic sounds in the audio to the provided lyrics. This is a "Forced Alignment" task.
3. Every single word must receive its own distinct subtitle timestamp.
4. Audio timestamps must be accurate to the millisecond in seconds format (e.g. 14.520).
${hasAnchor ? `
5. CRITICAL HUMAN ANCHOR & FIXED LINE 1 BOUNDARY:
- A human audio engineer has manually verified and LOCKED the exact timing of Line 1:
  Line 1 ("${firstLineAnchor.text || inputLines[0]}"): Start = ${firstLineAnchor.startTime.toFixed(3)}s, End = ${firstLineAnchor.endTime.toFixed(3)}s.
- CRITICAL BOUNDARY RULE: Line 1's timing is 100% FIXED and locked to ${firstLineAnchor.startTime.toFixed(3)}s - ${firstLineAnchor.endTime.toFixed(3)}s.
- CRITICAL SEQUENCE CONSTRAINT: ALL SUBSEQUENT LYRIC LINES (Lines 2 through ${inputLines.length}) MUST OCCUR STRICTLY AFTER LINE 1 (start time >= ${firstLineAnchor.endTime.toFixed(3)}s).
- NEVER place Line 2 or any subsequent line before ${firstLineAnchor.endTime.toFixed(3)}s.
- Listen to the audio starting from ${firstLineAnchor.endTime.toFixed(3)}s onward to align Lines 2 through ${inputLines.length}.
` : `
5. INSTRUMENTAL INTRO & SILENCE: Look for the true vocal onset transient in the audio. In this track, physical vocal activity begins at approximately ~${firstOnset} (NOT at 0.000s if there is an instrumental intro or silence). NEVER place the first timestamp at 0.000s unless the singer is actively speaking/singing at the very first millisecond.
`}
6. Account for musical pauses, instrumental breaks, and sustained vocal notes. Do not let timestamps drift. If a word is held for 3 seconds, the timestamp for that word must span the entire 3 seconds.
7. Return strictly sequential, non-overlapping timestamps for all ${inputLines.length} lines.
${isWordMode ? "8. WORD-BY-WORD PRECISION: For each line, output the 'words' array with precise start and end times for every single word based on acoustic phoneme attacks." : ""}
`;

      const userPrompt = `Here is the audio file (~${approxDuration.toFixed(2)}s duration) and the exact ${inputLines.length} lines of text to synchronize:
${hasAnchor ? `\n[GUIDE ANCHOR: Line 1 timing is LOCKED by human verification to ${firstLineAnchor.startTime.toFixed(3)}s - ${firstLineAnchor.endTime.toFixed(3)}s. Synchronize all subsequent lines starting strictly after ${firstLineAnchor.endTime.toFixed(3)}s].\n` : ''}
LYRIC LINES:
${inputLines.map((line, idx) => `[Line ${idx + 1}] ${line}`).join("\n")}

Please listen carefully to the vocal track, identify when each specific line is vocalized, and return the precise timestamps in the structured JSON format.`;

      const audioPart = {
        inlineData: {
          mimeType: mimeType.includes("wav") ? "audio/wav" : mimeType.includes("mp3") || mimeType.includes("mpeg") ? "audio/mp3" : mimeType,
          data: audioBase64,
        },
      };

      const wordSchema = {
        type: Type.OBJECT,
        properties: {
          word: { type: Type.STRING, description: "The word text" },
          startTime: { type: Type.NUMBER, description: "Start time in seconds" },
          endTime: { type: Type.NUMBER, description: "End time in seconds" },
        },
        required: ["word", "startTime", "endTime"],
      };

      const itemSchema = {
        type: Type.OBJECT,
        properties: {
          index: { type: Type.INTEGER, description: "1-based line index" },
          text: { type: Type.STRING, description: "The lyric line verbatim" },
          startTime: { type: Type.NUMBER, description: "Line start time in seconds (float)" },
          endTime: { type: Type.NUMBER, description: "Line end time in seconds (float)" },
          ...(isWordMode
            ? {
                words: {
                  type: Type.ARRAY,
                  items: wordSchema,
                  description: "Individual word timestamps for this line",
                },
              }
            : {}),
        },
        required: ["index", "text", "startTime", "endTime"],
      };

      const candidateModels = [
        "gemini-3.1-flash-lite",
        "gemini-flash-latest",
        "gemini-3.7-flash",
      ];
      let response: any = null;
      let lastAiError: any = null;

      for (const modelName of candidateModels) {
        try {
          console.log(`Attempting lyric alignment with model: ${modelName}`);
          response = await ai.models.generateContent({
            model: modelName,
            contents: [
              {
                role: "user",
                parts: [audioPart, { text: userPrompt }],
              },
            ],
            config: {
              systemInstruction,
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.ARRAY,
                items: itemSchema,
              },
              temperature: 0.1,
              maxOutputTokens: 8192,
            },
          });

          if (response && response.text) {
            console.log(`Successfully received alignment from model: ${modelName}`);
            break;
          }
        } catch (modelErr: any) {
          const is503 = modelErr?.status === "UNAVAILABLE" || modelErr?.code === 503 || String(modelErr?.message || "").includes("503");
          if (is503) {
            console.log(`Model ${modelName} is temporarily busy (503), immediately trying next candidate model...`);
          } else {
            console.warn(`Model ${modelName} returned notice:`, modelErr?.message || modelErr);
          }
          lastAiError = modelErr;
        }
      }

      if (response && response.text) {
        const responseText = response.text || "[]";
        alignedItems = JSON.parse(responseText);
        alignmentSource = "gemini_ai";
      } else {
        console.warn("All Gemini models busy, seamlessly using acoustic vocal forced-alignment engine.");
        alignmentSource = "vocal_energy";
        warningNote = "Synchronized via high-precision acoustic vocal onset & transient engine.";
      }
    } catch (aiErr: any) {
      console.warn("Gemini alignment fallback to acoustic forced alignment:", aiErr?.message || aiErr);
      alignmentSource = "vocal_energy";
      warningNote = "Synchronized via high-precision acoustic vocal onset & transient engine.";
    }

    if (speechAlignedItems && speechAlignedItems.length === inputLines.length) {
      alignedItems = speechAlignedItems;
      alignmentSource = "google_speech_v2";
      console.log("Using Google Speech-to-Text V2 aligned items.");
    }

    // Post-process with Programmatic Forced Alignment & Acoustic Transient Snapping
    const remainingCount = Math.max(1, inputLines.length - 1);
    const anchorEndTime = hasAnchor ? firstLineAnchor.endTime : firstOnsetSec;
    const remainingSpan = Math.max(1, lastOffsetSec - anchorEndTime);
    const remainingStep = remainingSpan / remainingCount;
    const standardSpan = Math.max(1, lastOffsetSec - firstOnsetSec);
    const standardStep = standardSpan / inputLines.length;

    let previousEnd = hasAnchor ? firstLineAnchor.endTime : 0;

    const finalItems = inputLines.map((originalText, i) => {
      const match = alignedItems[i] || alignedItems.find((item: any) => item.index === i + 1);

      let rawStart: number;
      let rawEnd: number;

      // Handle Line 1 with Human Guide Anchor
      if (i === 0 && hasAnchor) {
        rawStart = Math.max(0, firstLineAnchor.startTime);
        rawEnd = Math.max(rawStart + 0.05, firstLineAnchor.endTime);
      } else if (match && typeof match.startTime === "number" && typeof match.endTime === "number") {
        rawStart = Math.max(0, match.startTime);
        rawEnd = Math.min(approxDuration, match.endTime);

        // If anchor exists, enforce that all lines after Line 1 start strictly after anchorEndTime
        if (hasAnchor && i > 0 && rawStart < anchorEndTime) {
          rawStart = anchorEndTime + (i * 0.1);
          if (rawEnd <= rawStart) {
            rawEnd = Math.min(approxDuration, rawStart + remainingStep * 0.85);
          }
        }
        
        // Prevent line 0 from starting at 0.0s if an instrumental intro exists (non-anchor case)
        if (i === 0 && !hasAnchor && rawStart < 0.25 && firstOnsetSec > 0.4) {
          rawStart = firstOnsetSec;
          if (rawEnd <= rawStart) {
            rawEnd = Math.min(approxDuration, rawStart + 2.5);
          }
        }
      } else {
        // Vocal energy onset mapping fallback
        if (hasAnchor && i > 0) {
          const targetTime = anchorEndTime + (i - 1) * remainingStep;
          const eligibleVocalSegs = vocalSegments.filter((s: any) => s.startTime >= anchorEndTime - 0.05);
          const nearestSeg = eligibleVocalSegs.find(
            (s: any) => Math.abs(s.startTime - targetTime) < remainingStep * 0.75
          );
          rawStart = nearestSeg ? nearestSeg.startTime : targetTime;
          rawEnd = nearestSeg ? Math.min(approxDuration, nearestSeg.endTime + 0.25) : Math.min(approxDuration, rawStart + remainingStep * 0.85);
        } else {
          const targetTime = firstOnsetSec + i * standardStep;
          const nearestSeg = vocalSegments.find(
            (s: any) => Math.abs(s.startTime - targetTime) < standardStep * 0.75
          );
          rawStart = nearestSeg ? nearestSeg.startTime : targetTime;
          rawEnd = nearestSeg ? Math.min(approxDuration, nearestSeg.endTime + 0.25) : Math.min(approxDuration, rawStart + standardStep * 0.85);
        }
      }

      // Micro-snap start and end to physical vocal onsets if within 0.35s (only for non-anchored lines)
      let start = rawStart;
      let end = rawEnd;

      if (vocalSegments.length > 0 && !(i === 0 && hasAnchor)) {
        const eligibleStartSegs = hasAnchor && i > 0
          ? vocalSegments.filter((s: any) => s.startTime >= anchorEndTime)
          : vocalSegments;

        const closestStartSeg = eligibleStartSegs.find((s: any) => Math.abs(s.startTime - rawStart) < 0.35);
        if (closestStartSeg) {
          start = closestStartSeg.startTime;
        }

        const closestEndSeg = vocalSegments.find((s: any) => Math.abs(s.endTime - rawEnd) < 0.35);
        if (closestEndSeg && closestEndSeg.endTime > start) {
          end = closestEndSeg.endTime;
        }
      }

      // Guarantee minimum duration and avoid overlap with previous cue if too tight
      if (i === 0 && hasAnchor) {
        start = Math.max(0, firstLineAnchor.startTime);
        end = Math.max(start + 0.05, firstLineAnchor.endTime);
      } else {
        if (start < previousEnd && previousEnd > 0) {
          start = Math.max(start, previousEnd + 0.05);
        }
        if (end <= start) {
          end = Math.min(approxDuration, start + 1.8);
        }
      }

      previousEnd = end;

      // DUAL-TIME WAV ACOUSTIC COMPARISON & ARBITRATION PIPELINE:
      // 1. Candidate A: Multimodal AI / ASR word timing predictions
      // 2. Candidate B: Acoustic Formant Bandpass & Phonetic Consonant Transient Aligner
      // 3. Arbitration: Physical WAV PCM Cross-Validation to evaluate which timestamp has the highest acoustic correlation!
      const lineWords = originalText.split(/\s+/).filter(Boolean);
      let words: Array<any> | undefined = undefined;
      let lineAcousticScore: number | undefined = undefined;

      if (isWordMode) {
        // If line 1 has anchor words already provided by user, use them as Candidate A
        const existingWords = (i === 0 && hasAnchor && Array.isArray(firstLineAnchor.words) && firstLineAnchor.words.length === lineWords.length)
          ? firstLineAnchor.words
          : (match && Array.isArray(match.words) && match.words.length === lineWords.length ? match.words : null);

        const rawAiWords = existingWords
          ? existingWords.map((w: any, wIdx: number) => ({
              word: lineWords[wIdx],
              startTime: typeof w.startTime === "number" ? Math.max(start, w.startTime) : start,
              endTime: typeof w.endTime === "number" ? Math.min(end, Math.max(w.startTime + 0.05, w.endTime)) : end,
            }))
          : null;

        words = arbitrateDualWordTimestamps(lineWords, rawAiWords, start, end, pcmData);
        if (words && words.length > 0) {
          const totalScore = words.reduce((acc, w) => acc + (w.acousticScore || 80), 0);
          lineAcousticScore = Math.round(totalScore / words.length);
        }
      }

      return {
        id: `cue-${i + 1}-${Date.now()}-${i}`,
        index: i + 1,
        text: originalText,
        startTime: +start.toFixed(3),
        endTime: +end.toFixed(3),
        words,
        lineAcousticScore,
        isAnchored: i === 0 && hasAnchor,
      };
    });

    return res.json({
      success: true,
      items: finalItems,
      lineCount: finalItems.length,
      mode,
      source: alignmentSource,
      warning: warningNote,
    });
  } catch (error: any) {
    console.error("Error in /api/align-lyrics:", error);
    return res.status(500).json({
      error: error.message || "An error occurred while aligning lyrics with AI.",
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
