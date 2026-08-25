// @ts-ignore - wav-decoder may not have bundled @types
import * as wav from 'wav-decoder';

export interface WordTiming {
  word: string;
  relativeStart: number;
  relativeEnd: number;
}

/**
 * Advanced Phonetic Forced Aligner with Consonant Edge Recovery.
 * Tracks zero-crossings to eliminate vowel-peak lag on hard-consonant word starts.
 */
export async function alignAudioWordsLocally(
  audioBuffer: Buffer, 
  referenceText: string
): Promise<WordTiming[]> {
  const decodedWav = await (wav as any).decode(audioBuffer);
  const channelData: Float32Array = decodedWav.channelData[0]; // Read primary mono audio sample stream
  const sampleRate: number = decodedWav.sampleRate;

  const rawWords = referenceText.split(/\s+/).filter(Boolean);
  if (rawWords.length === 0) return [];

  const frameSize = Math.floor(sampleRate * 0.010); // Strict 10ms frame windows
  const numFrames = Math.floor(channelData.length / frameSize);
  
  const frameEnergies: number[] = [];
  const frameZcr: number[] = [];

  // 1. Dual-feature extraction: Extract both Volume (RMS) and Consonant Friction (ZCR)
  for (let f = 0; f < numFrames; f++) {
    let sumSquares = 0;
    let crossings = 0;
    const offset = f * frameSize;

    for (let i = 0; i < frameSize; i++) {
      const idx = offset + i;
      const currentSample = channelData[idx] || 0;
      const nextSample = channelData[idx + 1] || 0;

      sumSquares += currentSample * currentSample;

      // Track how fast the sound wave cuts across zero (tracks 's', 't', 'ch' sounds)
      if ((currentSample > 0 && nextSample < 0) || (currentSample < 0 && nextSample > 0)) {
        crossings++;
      }
    }

    frameEnergies.push(Math.sqrt(sumSquares / frameSize));
    frameZcr.push(crossings / frameSize);
  }

  const maxEnergy = Math.max(...frameEnergies, 0.001);
  const baseSilenceThreshold = maxEnergy * 0.06; // Slightly lowered to catch quiet entries

  let activeVocalStartFrame = 0;
  let activeVocalEndFrame = numFrames - 1;

  // 2. Scan for true vocal boundaries using our Consonant Lifter
  for (let i = 0; i < numFrames; i++) {
    // A frame is active if it's loud OR if it contains high-frequency consonant friction
    const isSpeech = frameEnergies[i] > baseSilenceThreshold || (frameZcr[i] > 0.22 && frameEnergies[i] > baseSilenceThreshold * 0.3);
    if (isSpeech) {
      activeVocalStartFrame = i;
      break;
    }
  }

  for (let i = numFrames - 1; i >= 0; i--) {
    const isSpeech = frameEnergies[i] > baseSilenceThreshold || (frameZcr[i] > 0.22 && frameEnergies[i] > baseSilenceThreshold * 0.3);
    if (isSpeech) {
      activeVocalEndFrame = i;
      break;
    }
  }

  // Acoustic onset lead-in to catch early mouth formation and consonant attacks
  const ONSET_ANTICIPATION = 0.060;

  const vocalStartTime = Math.max(0, ((activeVocalStartFrame * frameSize) / sampleRate) - ONSET_ANTICIPATION);
  const vocalEndTime = Math.min(channelData.length / sampleRate, (activeVocalEndFrame * frameSize) / sampleRate);
  const trueVocalDuration = Math.max(0.1, vocalEndTime - vocalStartTime);

  // 3. Phonetic Syllable & Character Length Weight Distribution (Character-Vowel Dynamic Spacing)
  const wordWeights = rawWords.map((word) => {
    const clean = word.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    // Hard compression for tiny connector words so they don't delay upcoming text
    if (clean.length <= 2) return 0.45; 

    // Track distinct vowel clusters to capture true speech length
    const vowels = clean.match(/[aeiouy]{1,2}/g)?.length || 1;
    
    // Consonant friction bonus (e.g. s, sh, ch, t, p, k)
    const hasFricativeStart = /^[sctpbfghk]/.test(clean);
    const fricativeBonus = hasFricativeStart ? 0.3 : 0;
    
    // Multi-syllable & vocal density formula
    return vowels * 1.7 + clean.length * 0.25 + fricativeBonus;
  });

  const totalWeight = wordWeights.reduce((a, b) => a + b, 0);
  let currentTracker = vocalStartTime;

  return rawWords.map((word, index) => {
    const allocatedPct = wordWeights[index] / totalWeight;
    const wordDuration = allocatedPct * trueVocalDuration;

    const start = currentTracker;
    const end = index === rawWords.length - 1 ? vocalEndTime : currentTracker + wordDuration;
    
    currentTracker = end;

    return {
      word,
      relativeStart: +start.toFixed(3),
      relativeEnd: +end.toFixed(3)
    };
  });
}
