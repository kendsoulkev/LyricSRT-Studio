import express from "express";
import path from "path";
import { GoogleGenAI, Type } from "@google/genai";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";

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
    } = req.body;

    if (!audioBase64) {
      return res.status(400).json({ error: "Missing audio data." });
    }

    if (!lyricsText && (!lines || lines.length === 0)) {
      return res.status(400).json({ error: "Missing lyric text or lines." });
    }

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
    const approxDuration = typeof audioDuration === "number" && audioDuration > 0 ? audioDuration : 180;
    const vocalSegments = Array.isArray(analysis?.vocalSegments) ? analysis.vocalSegments : [];
    const firstOnset = analysis?.firstVocalOnset ? `${analysis.firstVocalOnset.toFixed(2)}s` : "0.5s";
    const lastOffset = analysis?.lastVocalOffset ? `${analysis.lastVocalOffset.toFixed(2)}s` : `${approxDuration.toFixed(1)}s`;

    let alignedItems: any[] = [];
    let alignmentSource: "gemini_ai" | "vocal_energy" = "gemini_ai";
    let warningNote: string | undefined;

    try {
      const ai = getGeminiClient();

      const systemInstruction = `You are an elite, millisecond-precision audio engineer and professional lyric-to-audio subtitle synchronizer (SRT/LRC specialist).
Your mission is to listen to the attached audio recording and accurately pin-point the EXACT millisecond timestamps when each given lyric line is sung or spoken.

PRECISION GUIDELINES:
1. STRICT SEQUENCE & COUNT: You MUST return EXACTLY ${inputLines.length} subtitle items in the exact 1-to-1 order of the input lines. Do not combine, skip, invent, or rephrase words.
2. ACCURATE ONSET & RELEASE:
   - 'startTime': The exact second the vocalist begins voicing the very first phoneme/consonant of the line.
   - 'endTime': The exact second the vocalist releases the final syllable/vowel sound of the line.
3. SILENCE & INSTRUMENTAL HANDLING: If there is an instrumental intro (e.g. before ~${firstOnset}), guitar solo, or musical interlude between verses/choruses, the timestamps MUST pause and accurately reflect the silence. Do NOT stretch lines across long musical breaks.
4. Vocal energy in this track is actively detected between ~${firstOnset} and ~${lastOffset}.
5. MONOTONIC CHRONOLOGY: All timestamps must be strictly sequential (0.000 <= startTime < endTime <= ${approxDuration.toFixed(2)}s).
${isWordMode ? "6. WORD-BY-WORD PRECISION: For each line, output the 'words' array with precise start and end times for every single word." : ""}
`;

      const userPrompt = `Here is the audio file (~${approxDuration.toFixed(2)}s duration) and the exact ${inputLines.length} lines of text to synchronize:

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

      const candidateModels = ["gemini-3.7-flash", "gemini-flash-latest", "gemini-3.1-flash-lite"];
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
          console.warn(`Model ${modelName} attempt failed:`, modelErr?.message || modelErr);
          lastAiError = modelErr;
        }
      }

      if (response && response.text) {
        const responseText = response.text || "[]";
        alignedItems = JSON.parse(responseText);
        alignmentSource = "gemini_ai";
      } else {
        throw lastAiError || new Error("All Gemini models temporarily unavailable.");
      }
    } catch (aiErr: any) {
      console.warn("Gemini alignment encountered an issue, applying vocal energy alignment:", aiErr?.message || aiErr);
      alignmentSource = "vocal_energy";
      warningNote = "AI cloud sync fell back to acoustic vocal onset detection for instant alignment.";
    }

    // Post-process to guarantee EXACT line matching, chronological sanity, and acoustic boundary snapping
    const firstOnsetSec = analysis?.firstVocalOnset || 1.0;
    const lastOffsetSec = analysis?.lastVocalOffset || Math.max(2, approxDuration - 1.0);
    const usableSpan = Math.max(1, lastOffsetSec - firstOnsetSec);
    const avgStep = usableSpan / inputLines.length;

    let previousEnd = 0;

    const finalItems = inputLines.map((originalText, i) => {
      const match = alignedItems[i] || alignedItems.find((item: any) => item.index === i + 1);

      let rawStart: number;
      let rawEnd: number;

      if (match && typeof match.startTime === "number" && typeof match.endTime === "number") {
        rawStart = Math.max(0, match.startTime);
        rawEnd = Math.min(approxDuration, match.endTime);
      } else {
        // Vocal energy onset mapping fallback
        const targetTime = firstOnsetSec + i * avgStep;
        const nearestSeg = vocalSegments.find(
          (s: any) => Math.abs(s.startTime - targetTime) < avgStep * 0.75
        );
        rawStart = nearestSeg ? nearestSeg.startTime : targetTime;
        rawEnd = nearestSeg ? Math.min(approxDuration, nearestSeg.endTime + 0.25) : Math.min(approxDuration, rawStart + avgStep * 0.85);
      }

      // Micro-snap start and end to physical vocal onsets if within 0.4s
      let start = rawStart;
      let end = rawEnd;

      if (vocalSegments.length > 0) {
        const closestStartSeg = vocalSegments.find((s: any) => Math.abs(s.startTime - rawStart) < 0.35);
        if (closestStartSeg) {
          start = closestStartSeg.startTime;
        }

        const closestEndSeg = vocalSegments.find((s: any) => Math.abs(s.endTime - rawEnd) < 0.35);
        if (closestEndSeg) {
          end = closestEndSeg.endTime;
        }
      }

      // Guarantee minimum duration and avoid overlap with previous cue if too tight
      if (start < previousEnd && previousEnd > 0) {
        start = Math.max(start, previousEnd + 0.05);
      }
      if (end <= start) {
        end = Math.min(approxDuration, start + 1.8);
      }

      previousEnd = end;

      const words = isWordMode && Array.isArray(match?.words) && match.words.length > 0
        ? match.words.map((w: any) => ({
            word: String(w.word || ""),
            startTime: +(Number(w.startTime) || start).toFixed(3),
            endTime: +(Number(w.endTime) || end).toFixed(3),
          }))
        : originalText.split(/\s+/).filter(Boolean).map((word, wIdx, arr) => {
            const span = (end - start) / Math.max(arr.length, 1);
            return {
              word,
              startTime: +(start + wIdx * span).toFixed(3),
              endTime: +(start + (wIdx + 1) * span).toFixed(3),
            };
          });

      return {
        id: `cue-${i + 1}-${Date.now()}-${i}`,
        index: i + 1,
        text: originalText,
        startTime: +start.toFixed(3),
        endTime: +end.toFixed(3),
        words: isWordMode ? words : undefined,
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
