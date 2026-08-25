import { GeminiWord, SubtitleCue } from '../types';
import { formatGeminiResponseToCues } from './srt';
import { prepareAudioForAi } from './audio';

export interface GeminiApiConfig {
  apiKey?: string;
  modelName?: string; // e.g., "gemini-3.7-flash", "gemini-flash-latest", "gemini-3.1-flash-lite"
}

/**
 * Sends optimized WAV audio and reference text to Gemini for Forced Alignment.
 * Supports mode 'micro-chunk' (3-6s single line), 'word' (full audio word tokens), and 'line' (full lyric lines).
 */
export async function fetchPreciseWordAlignment(
  audioBase64: string,
  referenceLyrics: string,
  mode: 'line' | 'word' | 'micro-chunk' = 'word',
  config?: GeminiApiConfig
): Promise<any> {
  const model = config?.modelName || 'gemini-3.7-flash';
  const isMicroChunkMode = mode === 'micro-chunk';
  const isWordMode = mode === 'word';

  // If a specific client-side API key is provided directly in config
  if (config?.apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.apiKey}`;

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
3. VERBATIM MATCHING: Use only the exact words provided in the text input.`
      : `You are an advanced Audio-to-Lyric Line Aligner. Your sole job is to take the provided .wav audio file and the exact list of lyric lines provided by the user, and find the start and end timestamps for each full line.

OUTPUT FORMAT REQUIREMENTS:
You must output a single, valid JSON array containing objects structured exactly like this example:
[
  { "lineIndex": 1, "text": "The exact text of line 1", "startTime": 2.100, "endTime": 6.400 }
]`;

    const chunkResponseSchema = {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          word: { type: 'STRING' },
          relativeStart: { type: 'NUMBER' },
          relativeEnd: { type: 'NUMBER' },
        },
        required: ['word', 'relativeStart', 'relativeEnd'],
      },
    };

    const wordResponseSchema = {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          word: { type: 'STRING' },
          startTime: { type: 'NUMBER' },
          endTime: { type: 'NUMBER' },
        },
        required: ['word', 'startTime', 'endTime'],
      },
    };

    const lineResponseSchema = {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          lineIndex: { type: 'NUMBER' },
          text: { type: 'STRING' },
          startTime: { type: 'NUMBER' },
          endTime: { type: 'NUMBER' },
        },
        required: ['lineIndex', 'text', 'startTime', 'endTime'],
      },
    };

    const promptText = isMicroChunkMode
      ? `Here is the single lyric line to align to this short audio clip with millisecond precision:\n\n${referenceLyrics}`
      : isWordMode
      ? `Here is the exact reference text to align word-for-word with the provided audio wave file:\n\n${referenceLyrics}`
      : `Here is the exact reference lyrics to align line-by-line with the provided audio wave file:\n\n${referenceLyrics}`;

    const requestBody = {
      contents: [
        {
          parts: [
            {
              inlineData: {
                mimeType: 'audio/wav',
                data: audioBase64,
              },
            },
            {
              text: promptText,
            },
          ],
        },
      ],
      systemInstruction: {
        parts: [
          {
            text: systemInstruction,
          },
        ],
      },
      generationConfig: {
        temperature: 0.0,
        responseMimeType: 'application/json',
        responseSchema: isMicroChunkMode
          ? chunkResponseSchema
          : isWordMode
          ? wordResponseSchema
          : lineResponseSchema,
      },
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${errorText}`);
    }

    const result = await response.json();
    const rawTextOutput = result.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!rawTextOutput) {
      throw new Error('Failed to retrieve structured text mapping from Gemini response.');
    }

    return JSON.parse(rawTextOutput.trim());
  }

  // Use full-stack backend proxy to keep API keys secure
  const response = await fetch('/api/precise-word-alignment', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      audioBase64,
      referenceLyrics,
      mode,
      modelName: model,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Server forced alignment error (${response.status}): ${errorText}`);
  }

  const result = await response.json();
  if (Array.isArray(result)) {
    return result;
  }
  if (!result.success || (!Array.isArray(result.words) && !Array.isArray(result.items) && !Array.isArray(result.data))) {
    throw new Error(result.error || 'Failed to retrieve alignment from server.');
  }

  return result.words || result.items || result.data;
}

/**
 * Orchestrator workflow function:
 * Prepares audio locally, queries Gemini for forced word alignment, and formats into SubtitleCue items.
 */
export async function handleStartWordSynchronization(
  audioFile: Blob,
  userLyrics: string,
  mode: 'line' | 'word' = 'word',
  config?: GeminiApiConfig,
  onProgress?: (status: string, percent: number) => void
): Promise<SubtitleCue[]> {
  // 1. Prepare and optimize audio channel/sample rates locally
  const optimizedAudio = await prepareAudioForAi(audioFile, (step, percent) => {
    if (onProgress) onProgress(step, percent);
  });

  // 2. Query Gemini directly for forced word or line alignments
  if (onProgress) onProgress(`Sending audio to Gemini for precise ${mode} forced alignment...`, 60);
  const aiData = await fetchPreciseWordAlignment(
    optimizedAudio.base64,
    userLyrics,
    mode,
    config
  );

  // 3. Convert clean model response array to full subtitle structures
  if (onProgress) onProgress('Formatting timestamps into subtitle cues...', 90);
  let accurateSubtitleCues: SubtitleCue[];
  if (mode === 'word') {
    accurateSubtitleCues = formatGeminiResponseToCues(aiData);
  } else {
    accurateSubtitleCues = aiData.map((line: any, index: number) => ({
      id: `cue-${line.lineIndex || index + 1}-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      index: line.lineIndex || index + 1,
      text: line.text,
      startTime: line.startTime,
      endTime: line.endTime,
      words: [],
    }));
  }

  if (onProgress) onProgress('Synchronization complete!', 100);
  return accurateSubtitleCues;
}
