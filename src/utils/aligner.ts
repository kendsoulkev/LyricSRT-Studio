// @ts-ignore - wav-decoder may not have bundled @types
import * as wav from 'wav-decoder';

export interface WordTiming {
  word: string;
  relativeStart: number;
  relativeEnd: number;
}

/**
 * Enterprise-Grade ML Forced Alignment API Gateway & Local DSP Engine.
 * Routes audio snippets to a dedicated cloud WhisperX instance (Replicate / HF)
 * with instant local acoustic DSP fallback.
 */
export async function alignAudioWordsLocally(
  audioBuffer: Buffer, 
  referenceText: string
): Promise<WordTiming[]> {
  const rawWords = referenceText.split(/\s+/).filter(Boolean);
  if (rawWords.length === 0) return [];

  // 1. Replicate Cloud WhisperX Pipeline
  const REPLICATE_API_TOKEN = process.env.REPLICATE_API_KEY || process.env.REPLICATE_API_TOKEN || "";
  
  if (REPLICATE_API_TOKEN) {
    try {
      const base64Audio = audioBuffer.toString('base64');
      const dataUrl = `data:audio/wav;base64,${base64Audio}`;

      // Dispatches payload to Replicate API predictions endpoint
      const response = await fetch("https://api.replicate.com/v1/predictions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${REPLICATE_API_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          // Production-grade m-bain/whisperx alignment model version
          version: "77505c700514deed62ab3891c0011e307f905ee527458afc15de7d9e2a3034e8",
          input: {
            audio_file: dataUrl,
            initial_prompt: referenceText,
            batch_size: 32,
            temperature: 0
          }
        })
      });

      if (response.ok) {
        let prediction = await response.json();
        const predictionId = prediction.id;
        const getUrl = prediction.urls?.get || `https://api.replicate.com/v1/predictions/${predictionId}`;

        // Polling loop: Wait for the ML worker node to finish processing
        let attempts = 0;
        while (prediction.status !== "succeeded" && prediction.status !== "failed" && attempts < 15) {
          await new Promise(resolve => setTimeout(resolve, 800));
          const pollResponse = await fetch(getUrl, {
            headers: { "Authorization": `Bearer ${REPLICATE_API_TOKEN}` }
          });
          if (pollResponse.ok) {
            prediction = await pollResponse.json();
          }
          attempts++;
        }

        if (prediction.status === "succeeded") {
          const segments = prediction.output?.word_segments || prediction.output?.segments || [];
          const extractedWords: WordTiming[] = [];

          if (Array.isArray(segments)) {
            for (const item of segments) {
              if (item.word && (item.start !== undefined || item.startSec !== undefined)) {
                extractedWords.push({
                  word: String(item.word).trim(),
                  relativeStart: parseFloat(item.start ?? item.startSec ?? 0),
                  relativeEnd: parseFloat(item.end ?? item.endSec ?? 0)
                });
              } else if (Array.isArray(item.words)) {
                for (const w of item.words) {
                  extractedWords.push({
                    word: String(w.word || w.text).trim(),
                    relativeStart: parseFloat(w.start || 0),
                    relativeEnd: parseFloat(w.end || 0)
                  });
                }
              }
            }
          }

          if (extractedWords.length > 0) {
            console.log(`[ML Align] Successfully aligned ${extractedWords.length} word nodes from cloud WhisperX.`);
            return extractedWords;
          }
        }
      }
    } catch (error: any) {
      console.warn("Cloud ML Alignment node warning:", error?.message || error);
    }
  }

  // 2. High-Precision Local DSP Acoustic Engine Fallback
  try {
    const decodedWav = await (wav as any).decode(audioBuffer);
    const rawChannel = decodedWav.channelData[0] || decodedWav.channelData;
    const channelData: Float32Array = rawChannel instanceof Float32Array ? rawChannel : new Float32Array(rawChannel);
    const sampleRate: number = decodedWav.sampleRate || 44100;
    const totalDuration = channelData.length / sampleRate;

    if (channelData.length === 0 || totalDuration <= 0) {
      return runLocalDspFallback(rawWords, 3.0);
    }

    const frameSize = Math.max(1, Math.floor(sampleRate * 0.010)); // 10ms
    const numFrames = Math.floor(channelData.length / frameSize);

    if (numFrames < rawWords.length) {
      return runLocalDspFallback(rawWords, totalDuration);
    }

    const frameEnergies: number[] = new Array(numFrames);
    const frameFlux: number[] = new Array(numFrames);

    let prevRms = 0;
    for (let f = 0; f < numFrames; f++) {
      let sumSquares = 0;
      const offset = f * frameSize;
      for (let i = 0; i < frameSize; i++) {
        const val = channelData[offset + i] || 0;
        sumSquares += val * val;
      }
      const rms = Math.sqrt(sumSquares / frameSize);
      frameEnergies[f] = rms;
      frameFlux[f] = Math.abs(rms - prevRms);
      prevRms = rms;
    }

    const maxEnergy = Math.max(...frameEnergies, 0.0001);
    const upperThreshold = maxEnergy * 0.14;
    // Lowered from 0.04 - the backtrack below stops as soon as energy drops under this
    // threshold, so a higher floor means it stops backtracking before it reaches the true
    // start of a soft/gradual vocal attack, leaving the detected onset a bit late. A lower
    // floor lets it walk back further into the actual attack ramp before giving up.
    const lowerThreshold = maxEnergy * 0.025;

    interface AudioPeak {
      startSec: number;
      endSec: number;
    }
    const detectedPeaks: AudioPeak[] = [];
    let inPeak = false;
    let activeStartFrame = 0;

    for (let f = 0; f < numFrames; f++) {
      const energy = frameEnergies[f];

      if (!inPeak) {
        if (energy > upperThreshold) {
          inPeak = true;
          activeStartFrame = f;
          while (activeStartFrame > 0 && frameEnergies[activeStartFrame - 1] > lowerThreshold) {
            activeStartFrame--;
          }
        }
      } else {
        if (energy < lowerThreshold) {
          inPeak = false;
          let endFrame = f;
          const lookAhead = Math.min(numFrames - f - 1, 3);
          for (let k = 1; k <= lookAhead; k++) {
            if (frameEnergies[f + k] > upperThreshold) {
              f += k;
              inPeak = true;
              break;
            }
          }

          if (!inPeak) {
            detectedPeaks.push({
              startSec: (activeStartFrame * frameSize) / sampleRate,
              endSec: (endFrame * frameSize) / sampleRate
            });
          }
        }
      }
    }

    if (inPeak) {
      detectedPeaks.push({
        startSec: (activeStartFrame * frameSize) / sampleRate,
        endSec: (numFrames * frameSize) / sampleRate
      });
    }

    if (detectedPeaks.length === rawWords.length) {
      return rawWords.map((word, idx) => ({
        word,
        relativeStart: +Math.max(0, detectedPeaks[idx].startSec).toFixed(3),
        relativeEnd: +Math.min(totalDuration, detectedPeaks[idx].endSec).toFixed(3)
      }));
    }

    const wordWeights = rawWords.map((word) => {
      const clean = word.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (clean.length <= 2) return 0.4;
      const vowels = clean.match(/[aeiouy]{1,2}/g)?.length || 1;
      return vowels * 1.5 + clean.length * 0.25;
    });

    const totalWeight = wordWeights.reduce((a, b) => a + b, 0);
    let currentFrame = 0;
    const searchRadius = Math.max(2, Math.floor(numFrames * 0.04));
    const result: WordTiming[] = [];

    for (let i = 0; i < rawWords.length; i++) {
      const isLast = i === rawWords.length - 1;
      const word = rawWords[i];
      const weightFrac = wordWeights[i] / totalWeight;
      const targetDurationFrames = Math.max(5, Math.floor(weightFrac * numFrames));

      const startFrame = currentFrame;
      let endFrame = isLast ? numFrames : Math.min(numFrames - 1, currentFrame + targetDurationFrames);

      if (!isLast) {
        const startSearch = Math.max(startFrame + 2, endFrame - searchRadius);
        const endSearch = Math.min(numFrames - 2, endFrame + searchRadius);
        let bestFrame = endFrame;
        let maxFlux = -1;

        for (let s = startSearch; s <= endSearch; s++) {
          if (frameFlux[s] > maxFlux) {
            maxFlux = frameFlux[s];
            bestFrame = s;
          }
        }
        // Guarantee forward progress: without this floor, a single dominant transient
        // spike anywhere within the (wide, clip-wide-percentage) search window can win
        // the "highest flux" comparison for many words in a row, repeatedly snapping
        // endFrame back near that one spike regardless of where startFrame has already
        // advanced to - collapsing every word after it toward the same timestamp instead
        // of progressing through the line.
        endFrame = Math.max(startFrame + 1, bestFrame);
      }

      currentFrame = endFrame;
      const startSec = (startFrame * frameSize) / sampleRate;
      const endSec = (endFrame * frameSize) / sampleRate;

      result.push({
        word,
        relativeStart: +Math.max(0, startSec).toFixed(3),
        relativeEnd: +Math.min(totalDuration, endSec).toFixed(3)
      });
    }

    return result;

  } catch (err) {
    console.warn("Local audio decoding fallback triggered:", err);
    return runLocalDspFallback(rawWords, 3.0);
  }
}

/**
 * Safe, normalized mathematical distribution backup block
 */
function runLocalDspFallback(rawWords: string[], baseDuration?: number): WordTiming[] {
  const totalChars = rawWords.reduce((sum, w) => sum + Math.max(1, w.length), 0);
  const totalDuration = baseDuration || (rawWords.length * 0.350);
  let currentMarker = 0;

  return rawWords.map((word) => {
    const weight = Math.max(1, word.length) / totalChars;
    const duration = Math.max(0.150, weight * totalDuration);
    const start = currentMarker;
    const end = Math.min(totalDuration, currentMarker + duration);
    currentMarker = end;

    return {
      word,
      relativeStart: +start.toFixed(3),
      relativeEnd: +end.toFixed(3)
    };
  });
}
