/**
 * Google Cloud Speech-to-Text V2 / V1 Integration with Phrase Biasing
 * 
 * Provides word-level timestamps with phonetic phrase adaptation
 * using Google Cloud Speech Recognizer with word_timestamps.
 */

import { SpeechClient } from '@google-cloud/speech';

export interface SpeechWordTimestamp {
  word: string;
  startTime: number;
  endTime: number;
}

let speechClientInstance: SpeechClient | null = null;

export function getSpeechClient(): SpeechClient | null {
  try {
    if (speechClientInstance) return speechClientInstance;
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_CLOUD_PROJECT || process.env.SPEECH_API_KEY) {
      speechClientInstance = new SpeechClient();
      return speechClientInstance;
    }
  } catch (err) {
    console.log('Google Cloud Speech-to-Text client not initialized with default credentials:', err);
  }
  return null;
}

/**
 * Recognize speech with word timestamps and lyric vocabulary biasing
 */
export async function recognizeAudioWithWordTimestamps(
  audioBase64: string,
  sampleRateHertz: number = 16000,
  lyricPhrases?: string[]
): Promise<SpeechWordTimestamp[] | null> {
  const client = getSpeechClient();
  if (!client) return null;

  try {
    const audio = {
      content: audioBase64,
    };

    const speechContexts: any[] = [];
    if (lyricPhrases && lyricPhrases.length > 0) {
      speechContexts.push({
        phrases: lyricPhrases.slice(0, 100),
        boost: 15.0, // Prioritize user-provided lyrics vocabulary
      });
    }

    const config = {
      encoding: 'LINEAR16' as const,
      sampleRateHertz,
      languageCode: 'en-US',
      enableWordTimeOffsets: true,
      enableAutomaticPunctuation: true,
      model: 'default',
      speechContexts: speechContexts.length > 0 ? speechContexts : undefined,
    };

    const request = {
      audio,
      config,
    };

    const [response] = await client.recognize(request);
    const words: SpeechWordTimestamp[] = [];

    if (response.results) {
      for (const result of response.results) {
        const alt = result.alternatives?.[0];
        if (alt && alt.words) {
          for (const w of alt.words) {
            const startSec = w.startTime
              ? (Number(w.startTime.seconds || 0) + (w.startTime.nanos || 0) / 1e9)
              : 0;
            const endSec = w.endTime
              ? (Number(w.endTime.seconds || 0) + (w.endTime.nanos || 0) / 1e9)
              : startSec + 0.3;

            words.push({
              word: (w.word || '').trim(),
              startTime: +startSec.toFixed(3),
              endTime: +endSec.toFixed(3),
            });
          }
        }
      }
    }

    return words.length > 0 ? words : null;
  } catch (err) {
    console.warn('Google Cloud Speech recognition attempt encountered error:', err);
    return null;
  }
}
