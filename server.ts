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

    const ai = getGeminiClient();

    const isWordMode = mode === "word";
    const approxDuration = typeof audioDuration === "number" && audioDuration > 0 ? audioDuration : 180;

    const systemInstruction = `You are a precision audio engineer and master lyric-to-audio subtitle synchronizer.
Your task is to analyze the provided audio track and align the user's EXACT lyrics to the audio timestamps.

CRITICAL RULES:
1. You MUST output EXACTLY ${inputLines.length} subtitle items corresponding to each of the ${inputLines.length} lines provided in the input, in the exact same order.
2. The subtitle text MUST match the input lines verbatim. Do not omit lines, invent lines, merge lines, or change any words.
3. Determine accurate start time (startTime) and end time (endTime) in seconds (floating point numbers, e.g. 1.25, 4.80) for when each line is sung or spoken in the audio.
4. If the audio has instrumental intros or outros, start timestamps should accurately reflect when vocals start.
5. All timestamps must be in ascending chronological order, within the total audio duration (approx ${approxDuration.toFixed(1)}s).
${isWordMode ? "6. In 'word' mode, additionally provide the 'words' array for each line with the exact timestamp start and end for every word in that line." : ""}
`;

    const userPrompt = `Here are the exact ${inputLines.length} lines of lyrics that must be synced to the audio track:
${inputLines.map((line, idx) => `Line ${idx + 1}: "${line}"`).join("\n")}

Total Audio Duration: ~${approxDuration.toFixed(1)} seconds.
Alignment Mode: ${isWordMode ? "Word-by-Word + Line-by-Line" : "Line-by-Line (1 cue per line)"}.

Please listen to the attached audio file and produce the timestamps for all ${inputLines.length} lines.`;

    const audioPart = {
      inlineData: {
        mimeType: mimeType.includes("wav") ? "audio/wav" : mimeType.includes("mp3") || mimeType.includes("mpeg") ? "audio/mp3" : mimeType,
        data: audioBase64,
      },
    };

    // Schema for structured JSON response
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

    const response = await ai.models.generateContent({
      model: "gemini-3.7-flash",
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
      },
    });

    const responseText = response.text || "[]";
    let alignedItems: any[] = [];
    try {
      alignedItems = JSON.parse(responseText);
    } catch (parseErr) {
      console.error("Failed to parse Gemini response as JSON:", responseText);
      return res.status(500).json({ error: "AI response could not be parsed as valid JSON." });
    }

    // Post-process to guarantee EXACT line matching and line count integrity
    const finalItems = inputLines.map((originalText, i) => {
      const match = alignedItems[i] || alignedItems.find((item: any) => item.index === i + 1);
      
      let start = match && typeof match.startTime === "number" ? Math.max(0, match.startTime) : (approxDuration / inputLines.length) * i;
      let end = match && typeof match.endTime === "number" ? Math.min(approxDuration, match.endTime) : (approxDuration / inputLines.length) * (i + 0.9);

      if (end <= start) {
        end = start + 2.0;
      }

      const words = isWordMode && Array.isArray(match?.words) && match.words.length > 0
        ? match.words.map((w: any) => ({
            word: String(w.word || ""),
            startTime: Number(w.startTime || start),
            endTime: Number(w.endTime || end),
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
        id: `cue-${i + 1}-${Date.now()}`,
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
