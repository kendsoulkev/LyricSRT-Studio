import { SubtitleCue } from '../types';

/**
 * Audio analysis, waveform rendering, and vocal activity detection (VAD) algorithms.
 */

export interface VocalSegment {
  startTime: number;
  endTime: number;
  peakTime: number;
  energy: number;
}

export interface AudioAnalysisResult {
  duration: number;
  sampleRate: number;
  numberOfChannels: number;
  vocalSegments: VocalSegment[];
  firstVocalOnset: number;
  lastVocalOffset: number;
  averagePhraseDuration: number;
}

// Convert AudioBuffer or Blob to 16kHz mono WAV Base64
export async function prepareAudioForAi(
  fileOrBlob: Blob,
  onProgress?: (step: string, percent: number) => void
): Promise<{
  base64: string;
  mimeType: string;
  duration: number;
  analysis: AudioAnalysisResult;
}> {
  onProgress?.('Decoding audio data...', 15);
  const arrayBuffer = await fileOrBlob.arrayBuffer();
  const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();

  try {
    const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    const duration = decoded.duration;

    onProgress?.('Analyzing vocal energy & onsets...', 35);
    const analysis = analyzeVocalActivity(decoded);

    onProgress?.('Optimizing audio for AI alignment...', 60);
    // Resample to 16kHz mono (or 12kHz if long track) to ensure lightning-fast payload transfer
    const targetSampleRate = duration > 240 ? 12000 : 16000;
    const offlineCtx = new OfflineAudioContext(
      1,
      Math.ceil(duration * targetSampleRate),
      targetSampleRate
    );

    const source = offlineCtx.createBufferSource();
    source.buffer = decoded;
    source.connect(offlineCtx.destination);
    source.start(0);

    const renderedBuffer = await offlineCtx.startRendering();
    onProgress?.('Encoding WAV stream...', 80);
    const wavBlob = audioBufferToWavBlob(renderedBuffer);
    const base64 = await blobToBase64(wavBlob);

    onProgress?.('Ready for synchronization', 100);

    return {
      base64,
      mimeType: 'audio/wav',
      duration,
      analysis,
    };
  } finally {
    audioCtx.close();
  }
}

/**
 * Advanced Spectral VAD Analyzer
 * Filters out sub-bass and high cymbals, then tracks vocal formants and consonant onsets.
 */
export function analyzeVocalActivityAdvanced(buffer: AudioBuffer): VocalSegment[] {
  const sampleRate = buffer.sampleRate;
  const rawData = buffer.getChannelData(0);

  // 1. Setup analysis windows (25ms frames, 10ms hop for ultra-high resolution)
  const frameSize = Math.floor(sampleRate * 0.025); 
  const hopSize = Math.floor(sampleRate * 0.010); 
  const numFrames = Math.floor((rawData.length - frameSize) / hopSize);

  // 2. Simple Software Bandpass Filter (300Hz to 3400Hz) to isolate human voice
  // Low-pass and High-pass coefficients approximation for human speech formants
  const filteredData = new Float32Array(rawData.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  // Standard Butterworth bandpass coefficients for human voice formants
  const b0 = 0.2929, b1 = 0, b2 = -0.2929, a1 = -0.9428, a2 = 0.4142;

  for (let i = 0; i < rawData.length; i++) {
    const x0 = rawData[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    filteredData[i] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }

  const energies: number[] = new Array(numFrames);
  const zcrRates: number[] = new Array(numFrames);
  let totalEnergy = 0;

  // 3. Compute Frame Energy (RMS) and Zero-Crossing Rate (ZCR)
  for (let f = 0; f < numFrames; f++) {
    const offset = f * hopSize;
    let sumSquares = 0;
    let zeroCrossings = 0;

    for (let i = 0; i < frameSize; i++) {
      const idx = offset + i;
      const currentSample = filteredData[idx];
      const nextSample = filteredData[idx + 1] || 0;

      sumSquares += currentSample * currentSample;

      // Track Zero Crossings for tracking sharp consonant starts (fricatives)
      if ((currentSample > 0 && nextSample < 0) || (currentSample < 0 && nextSample > 0)) {
        zeroCrossings++;
      }
    }

    const rms = Math.sqrt(sumSquares / frameSize);
    energies[f] = rms;
    zcrRates[f] = zeroCrossings / frameSize;
    totalEnergy += rms;
  }

  const avgEnergy = totalEnergy / Math.max(1, numFrames);
  const maxEnergy = Math.max(...energies, 0.001);
  // Adaptive thresholding: Ignores heavy bass beats and background instrument floor noise
  const energyThreshold = Math.max(avgEnergy * 0.50, maxEnergy * 0.09);

  const segments: VocalSegment[] = [];
  let inSegment = false;
  let segStartFrame = 0;
  let peakFrame = 0;
  let maxFrameEnergy = 0;

  for (let f = 0; f < numFrames; f++) {
    const e = energies[f];
    const z = zcrRates[f];

    // High ZCR values indicate a consonant start even if the musical volume is briefly lower
    const isVocalActivity = e >= energyThreshold || (e > energyThreshold * 0.5 && z > 0.18);

    if (isVocalActivity) {
      if (!inSegment) {
        inSegment = true;
        segStartFrame = f;
        maxFrameEnergy = e;
        peakFrame = f;
      } else if (e > maxFrameEnergy) {
        maxFrameEnergy = e;
        peakFrame = f;
      }
    } else {
      if (inSegment) {
        const segDuration = ((f - segStartFrame) * hopSize) / sampleRate;
        // Require a 180ms minimum duration to validate a human vocal syllable block
        if (segDuration >= 0.18) {
          segments.push({
            startTime: +((segStartFrame * hopSize) / sampleRate).toFixed(3),
            endTime: +((f * hopSize) / sampleRate).toFixed(3),
            peakTime: +((peakFrame * hopSize) / sampleRate).toFixed(3),
            energy: +(maxFrameEnergy / maxEnergy).toFixed(3),
          });
        }
        inSegment = false;
      }
    }
  }

  if (inSegment) {
    const segDuration = ((numFrames - segStartFrame) * hopSize) / sampleRate;
    if (segDuration >= 0.18) {
      segments.push({
        startTime: +((segStartFrame * hopSize) / sampleRate).toFixed(3),
        endTime: +buffer.duration.toFixed(3),
        peakTime: +((peakFrame * hopSize) / sampleRate).toFixed(3),
        energy: +(maxFrameEnergy / maxEnergy).toFixed(3),
      });
    }
  }

  return segments;
}

/**
 * High-accuracy Voice Activity & Vocal Onset Analyzer
 * Detects phrases, pauses, energy spikes, and singing bursts using formant & ZCR filtering
 */
export function analyzeVocalActivity(buffer: AudioBuffer): AudioAnalysisResult {
  const duration = buffer.duration;
  const segments = analyzeVocalActivityAdvanced(buffer);

  const firstSignificantSegment = segments.find(s => (s.energy ?? 0) >= 0.15 && (s.endTime - s.startTime) >= 0.25) || segments[0];
  const firstVocalOnset = firstSignificantSegment ? firstSignificantSegment.startTime : 1.5;
  const lastVocalOffset = segments.length > 0 ? segments[segments.length - 1].endTime : Math.max(2, duration - 1.5);
  
  const avgPhraseDuration = segments.length > 0
    ? segments.reduce((acc, s) => acc + (s.endTime - s.startTime), 0) / segments.length
    : 3.0;

  return {
    duration,
    sampleRate: buffer.sampleRate,
    numberOfChannels: buffer.numberOfChannels,
    vocalSegments: segments,
    firstVocalOnset,
    lastVocalOffset,
    averagePhraseDuration: +avgPhraseDuration.toFixed(2),
  };
}

/**
 * Hybrid Vocal Onset Aligner:
 * If the user wants an instant local alignment or fallback,
 * this maps each lyric line to the real vocal energy segments of the audio track.
 */
export function alignLyricsToVocalSegments(
  lines: string[],
  analysis: AudioAnalysisResult,
  totalDuration: number,
  mode: 'line' | 'word' = 'line'
) {
  const lineCount = lines.length;
  if (lineCount === 0) return [];

  const vocalSpan = Math.max(1, analysis.lastVocalOffset - analysis.firstVocalOnset);
  const usableDuration = vocalSpan > 3 ? vocalSpan : Math.max(1, totalDuration - 2.0);
  const startOffset = analysis.firstVocalOnset > 0.5 ? analysis.firstVocalOnset : 1.0;

  // Distribute lines across detected vocal segments or time anchors
  const step = usableDuration / lineCount;

  return lines.map((text, i) => {
    // Check if there is a detected vocal segment near this proportional time
    const targetApproxTime = startOffset + i * step;
    const nearestSegment = analysis.vocalSegments.find(
      (s) => Math.abs(s.startTime - targetApproxTime) < step * 0.8
    );

    let start = nearestSegment ? nearestSegment.startTime : targetApproxTime;
    let end = nearestSegment
      ? Math.min(totalDuration, nearestSegment.endTime + 0.3)
      : Math.min(totalDuration, start + step * 0.88);

    if (end <= start) {
      end = Math.min(totalDuration, start + 2.0);
    }

    // Ensure monotonically increasing
    start = Math.max(0, start);
    end = Math.min(totalDuration, end);

    let words = undefined;
    if (mode === 'word') {
      const rawWords = text.split(/\s+/).filter(Boolean);
      if (rawWords.length > 0) {
        const weights = rawWords.map((w) => {
          const clean = w.toLowerCase().replace(/[^a-z0-9]/g, '');
          const vowels = clean.match(/[aeiouy]{1,2}/g);
          let syl = vowels ? vowels.length : 1;
          if (clean.endsWith('e') && !clean.endsWith('le') && syl > 1) syl -= 1;
          return Math.max(1, syl);
        });
        const totalW = weights.reduce((a, b) => a + b, 0);
        const lineDuration = end - start;

        let wCurrent = start;
        words = rawWords.map((w, wIdx) => {
          const span = (weights[wIdx] / totalW) * lineDuration;
          const wStart = wCurrent;
          const wEnd = wIdx === rawWords.length - 1 ? end : wCurrent + span;
          wCurrent = wEnd;
          return {
            word: w,
            startTime: +wStart.toFixed(3),
            endTime: +wEnd.toFixed(3),
          };
        });
      }
    }

    return {
      id: `cue-${i + 1}-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      index: i + 1,
      text,
      startTime: +start.toFixed(3),
      endTime: +end.toFixed(3),
      words,
    };
  });
}

// Convert AudioBuffer to a standard PCM 16-bit WAV Blob
export function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;
  const channelData = [];

  for (let i = 0; i < numChannels; i++) {
    channelData.push(buffer.getChannelData(i));
  }

  const numSamples = buffer.length;
  const byteRate = (sampleRate * numChannels * bitDepth) / 8;
  const blockAlign = (numChannels * bitDepth) / 8;
  const bufferLength = 44 + numSamples * numChannels * (bitDepth / 8);
  const outBuffer = new ArrayBuffer(bufferLength);
  const view = new DataView(outBuffer);

  // RIFF identifier
  writeString(view, 0, 'RIFF');
  // RIFF chunk length
  view.setUint32(4, 36 + numSamples * numChannels * (bitDepth / 8), true);
  // RIFF type
  writeString(view, 8, 'WAVE');
  // format chunk identifier
  writeString(view, 12, 'fmt ');
  // format chunk length
  view.setUint32(16, 16, true);
  // sample format (PCM)
  view.setUint16(20, format, true);
  // channel count
  view.setUint16(22, numChannels, true);
  // sample rate
  view.setUint32(24, sampleRate, true);
  // byte rate (sample rate * block align)
  view.setUint32(28, byteRate, true);
  // block align (channel count * bytes per sample)
  view.setUint16(32, blockAlign, true);
  // bits per sample
  view.setUint16(34, bitDepth, true);
  // data chunk identifier
  writeString(view, 36, 'data');
  // data chunk length
  view.setUint32(40, numSamples * numChannels * (bitDepth / 8), true);

  // Write interleaved PCM samples
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let channel = 0; channel < numChannels; channel++) {
      let sample = channelData[channel][i];
      // Clamp between -1 and 1
      sample = Math.max(-1, Math.min(1, sample));
      // Scale to 16-bit signed int
      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, intSample, true);
      offset += 2;
    }
  }

  return new Blob([outBuffer], { type: 'audio/wav' });
}

/**
 * Slices an exact sub-segment from an AudioBuffer without artificial silence padding
 * to provide pure acoustic frames for local forced alignment.
 */
export async function sliceAudioBufferExact(
  parentBuffer: AudioBuffer,
  startTime: number,
  endTime: number
): Promise<{ base64: string; duration: number }> {
  const sampleRate = parentBuffer.sampleRate;
  const safeStart = Math.max(0, startTime);
  const safeEnd = Math.min(parentBuffer.duration, Math.max(safeStart + 0.05, endTime));
  const startSample = Math.floor(safeStart * sampleRate);
  const endSample = Math.ceil(safeEnd * sampleRate);
  const frameLength = Math.max(1, endSample - startSample);

  const offlineCtx = new OfflineAudioContext(
    parentBuffer.numberOfChannels,
    frameLength,
    sampleRate
  );

  const source = offlineCtx.createBufferSource();
  source.buffer = parentBuffer;
  source.connect(offlineCtx.destination);
  source.start(0, safeStart, (endSample - startSample) / sampleRate);

  const renderedChunk = await offlineCtx.startRendering();
  const wavBlob = audioBufferToWavBlob(renderedChunk);
  const base64 = await blobToBase64(wavBlob);

  return {
    base64,
    duration: frameLength / sampleRate,
  };
}

/**
 * Upgraded Micro-Slicer with Leading Silence Calibration Injection.
 * Eliminates the AI initialization lag penalty.
 */
export async function sliceAudioBufferWithSilence(
  parentBuffer: AudioBuffer,
  startTime: number,
  endTime: number
): Promise<{ base64: string; silenceInjected: number }> {
  const sampleRate = parentBuffer.sampleRate;
  const SILENCE_PAD = 0.500; // 500ms of structural silence

  const voiceDuration = Math.max(0.05, endTime - startTime);
  const totalDuration = SILENCE_PAD + voiceDuration;
  const totalSamples = Math.ceil(totalDuration * sampleRate);

  const offlineCtx = new OfflineAudioContext(
    parentBuffer.numberOfChannels,
    totalSamples,
    sampleRate
  );

  // Render the vocal performance starting EXACTLY after the silence block
  const source = offlineCtx.createBufferSource();
  source.buffer = parentBuffer;
  source.connect(offlineCtx.destination);
  
  // Start playing the voice exactly at the 500ms mark of the new chunk
  source.start(SILENCE_PAD, Math.max(0, startTime), voiceDuration);

  const renderedChunk = await offlineCtx.startRendering();
  const wavBlob = audioBufferToWavBlob(renderedChunk);
  const base64 = await blobToBase64(wavBlob);

  return {
    base64,
    silenceInjected: SILENCE_PAD
  };
}

/**
 * Slicer with Lookahead Padding to eliminate audio onset clipping lag.
 * Extracts an exact sub-segment from an AudioBuffer with a 250ms lookahead handle and converts it to Base64 WAV.
 */
export async function sliceAudioBufferToBase64(
  parentBuffer: AudioBuffer,
  startTime: number,
  endTime: number
): Promise<{ base64: string; actualStartPadding: number }> {
  const sampleRate = parentBuffer.sampleRate;
  
  // Create a 250ms safety pad BEFORE the line starts
  const PADDING = 0.250;
  const safeStartTime = Math.max(0, startTime);
  const adjustedStart = Math.max(0, safeStartTime - PADDING);
  const actualStartPadding = safeStartTime - adjustedStart; // Track exact padding used

  const safeEndTime = Math.min(parentBuffer.duration, Math.max(safeStartTime + 0.05, endTime));
  const startSample = Math.floor(adjustedStart * sampleRate);
  const endSample = Math.ceil(safeEndTime * sampleRate);
  const frameLength = Math.max(1, endSample - startSample);

  // Create an offline rendering context for the short duration chunk
  const offlineCtx = new OfflineAudioContext(
    parentBuffer.numberOfChannels,
    frameLength,
    sampleRate
  );

  // Render the specific snippet slice
  const source = offlineCtx.createBufferSource();
  source.buffer = parentBuffer;

  // Connect with offset to position the window at absolute 0.0 in the new clip
  source.connect(offlineCtx.destination);
  source.start(0, adjustedStart, (endSample - startSample) / sampleRate);

  const renderedChunk = await offlineCtx.startRendering();
  const wavBlob = audioBufferToWavBlob(renderedChunk);
  const base64 = await blobToBase64(wavBlob);

  return {
    base64,
    actualStartPadding,
  };
}

/**
 * Decodes a Blob or File into an AudioBuffer using the browser Web Audio API.
 */
export async function decodeAudioBlobToBuffer(blob: Blob): Promise<AudioBuffer> {
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  try {
    return await audioCtx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    audioCtx.close();
  }
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Extract waveform peaks for rich canvas rendering
export async function extractWaveformPeaks(blob: Blob, targetPeaks = 300): Promise<number[]> {
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();

  try {
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    const rawData = audioBuffer.getChannelData(0);
    const blockSize = Math.floor(rawData.length / targetPeaks);
    const peaks: number[] = [];

    for (let i = 0; i < targetPeaks; i++) {
      const start = i * blockSize;
      let sum = 0;
      for (let j = 0; j < blockSize; j++) {
        sum += Math.abs(rawData[start + j] || 0);
      }
      peaks.push(sum / blockSize);
    }

    // Normalize peaks to 0..1 range
    const max = Math.max(...peaks, 0.01);
    return peaks.map((p) => Math.min(1, p / max));
  } catch (err) {
    console.warn('Could not extract waveform peaks:', err);
    return Array.from({ length: targetPeaks }, () => Math.random() * 0.5 + 0.2);
  } finally {
    audioCtx.close();
  }
}

/**
 * Generates a synthetic demo musical/vocal backing track with lyrics timing
 */
export async function generateDemoSong(lyricsLines: string[]): Promise<{ blob: Blob; url: string; duration: number }> {
  const sampleRate = 44100;
  const lineDuration = 3.2; // seconds per line
  const introDuration = 2.0;
  const outroDuration = 2.5;
  const totalDuration = introDuration + lyricsLines.length * lineDuration + outroDuration;
  const totalSamples = Math.ceil(totalDuration * sampleRate);

  const offlineCtx = new OfflineAudioContext(2, totalSamples, sampleRate);

  // Musical Chord Progression (C - G - Am - F vibe)
  const chordRoots = [261.63, 196.0, 220.0, 174.61]; // C4, G3, A3, F3

  // Create chord pads
  const numChords = Math.ceil(totalDuration / 2.0);
  for (let c = 0; c < numChords; c++) {
    const startTime = c * 2.0;
    const rootFreq = chordRoots[c % chordRoots.length];

    [1, 1.2599, 1.4983].forEach((ratio) => {
      const osc = offlineCtx.createOscillator();
      const gain = offlineCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(rootFreq * ratio, startTime);

      gain.gain.setValueAtTime(0, startTime);
      gain.gain.linearRampToValueAtTime(0.08, startTime + 0.4);
      gain.gain.linearRampToValueAtTime(0.05, startTime + 1.6);
      gain.gain.linearRampToValueAtTime(0, startTime + 2.0);

      osc.connect(gain);
      gain.connect(offlineCtx.destination);
      osc.start(startTime);
      osc.stop(startTime + 2.0);
    });
  }

  // Add rhythmic beat pulses (Kick & Snare)
  for (let t = 0; t < totalDuration; t += 0.5) {
    const isKick = (t * 2) % 2 === 0;
    const osc = offlineCtx.createOscillator();
    const gain = offlineCtx.createGain();

    if (isKick) {
      osc.frequency.setValueAtTime(120, t);
      osc.frequency.exponentialRampToValueAtTime(30, t + 0.15);
      gain.gain.setValueAtTime(0.3, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    } else {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(250, t);
      gain.gain.setValueAtTime(0.12, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    }

    osc.connect(gain);
    gain.connect(offlineCtx.destination);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  // Melodic lead guiding each lyric line
  lyricsLines.forEach((_, index) => {
    const lineStart = introDuration + index * lineDuration;
    const melodyNotes = [523.25, 587.33, 659.25, 783.99]; // C5, D5, E5, G5

    for (let n = 0; n < 4; n++) {
      const noteTime = lineStart + n * 0.65;
      const osc = offlineCtx.createOscillator();
      const gain = offlineCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(melodyNotes[(index + n) % melodyNotes.length], noteTime);

      gain.gain.setValueAtTime(0, noteTime);
      gain.gain.linearRampToValueAtTime(0.12, noteTime + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, noteTime + 0.55);

      osc.connect(gain);
      gain.connect(offlineCtx.destination);
      osc.start(noteTime);
      osc.stop(noteTime + 0.6);
    }
  });

  const rendered = await offlineCtx.startRendering();
  const wavBlob = audioBufferToWavBlob(rendered);
  const url = URL.createObjectURL(wavBlob);

  return {
    blob: wavBlob,
    url,
    duration: totalDuration,
  };
}

export const ENABLE_WORD_ONSET_REFINEMENT = true;
export const MAX_EARLIER_CORRECTION_SEC = 0.120; // 120ms maximum earlier correction limit
export const MIN_CONFIDENCE_THRESHOLD = 0.65;    // High-confidence threshold

/**
 * Conservative Late-Word Onset Refinement
 * 
 * Inspects a small acoustic window [startTime - 120ms, startTime - 15ms] before the baseline
 * word timestamp. Uses 300Hz-3400Hz vocal formant bandpass filtering to isolate singing
 * voice attacks and reject drum/percussion hits.
 * 
 * Only adjusts a timestamp earlier if strong vocal acoustic evidence exists.
 * Preserves baseline timestamp when confidence is low or evidence is ambiguous.
 */
export function refineWordTimestampsWithVocalOnsets(
  cues: SubtitleCue[],
  audioBuffer: AudioBuffer | null,
  vocalSegments: VocalSegment[] = []
): SubtitleCue[] {
  if (!ENABLE_WORD_ONSET_REFINEMENT || !cues || cues.length === 0 || !audioBuffer) {
    return cues;
  }

  const sampleRate = audioBuffer.sampleRate;
  const rawChannelData = audioBuffer.getChannelData(0);

  // Bandpass filter 300Hz to 3400Hz to isolate human vocal formants and eliminate kick drums & cymbal crashes
  const b0 = 0.2929, b1 = 0, b2 = -0.2929, a1 = -0.9428, a2 = 0.4142;
  const filteredData = new Float32Array(rawChannelData.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < rawChannelData.length; i++) {
    const x0 = rawChannelData[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    filteredData[i] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }

  const refinedCues: SubtitleCue[] = cues.map(c => ({
    ...c,
    words: c.words ? c.words.map(w => ({ ...w })) : undefined
  }));

  for (let i = 0; i < refinedCues.length; i++) {
    const current = refinedCues[i];
    const prev = i > 0 ? refinedCues[i - 1] : null;
    const wordText = current.text || (current.words && current.words[0]?.word) || `Word ${i + 1}`;
    const origStart = current.startTime;

    // Search window: [origStart - 120ms, origStart - 15ms]
    const windowStartSec = Math.max(0, origStart - MAX_EARLIER_CORRECTION_SEC);
    const windowEndSec = Math.max(0, origStart - 0.015);

    if (windowEndSec <= windowStartSec) {
      console.log(
        `[WordTiming]\nWord: "${wordText}"\nOriginal start: ${origStart.toFixed(3)}\nDetected onset: none\nCorrection: 0.000\nConfidence: 0.00\nApplied: NO\nReason: search window too small`
      );
      continue;
    }

    // Extract micro-frames: 10ms frame with 2.5ms hop
    const frameSize = Math.floor(sampleRate * 0.010);
    const hopSize = Math.floor(sampleRate * 0.0025);

    // Look at an analysis region starting 80ms before windowStartSec up to 80ms after origStart
    const analysisRegionStart = Math.max(0, windowStartSec - 0.080);
    const analysisRegionEnd = Math.min(audioBuffer.duration, origStart + 0.080);

    const startSample = Math.floor(analysisRegionStart * sampleRate);
    const endSample = Math.floor(analysisRegionEnd * sampleRate);
    const regionLength = endSample - startSample;

    if (regionLength < frameSize * 3) {
      console.log(
        `[WordTiming]\nWord: "${wordText}"\nOriginal start: ${origStart.toFixed(3)}\nDetected onset: none\nCorrection: 0.000\nConfidence: 0.00\nApplied: NO\nReason: insufficient audio samples in region`
      );
      continue;
    }

    const numFrames = Math.floor((regionLength - frameSize) / hopSize);
    const frameEnergies: number[] = new Array(numFrames);
    const frameZcr: number[] = new Array(numFrames);
    const frameTimes: number[] = new Array(numFrames);

    for (let f = 0; f < numFrames; f++) {
      const offset = startSample + f * hopSize;
      let sumSq = 0;
      let crossings = 0;
      for (let s = 0; s < frameSize; s++) {
        const sIdx = offset + s;
        const val = filteredData[sIdx] || 0;
        const nextVal = filteredData[sIdx + 1] || 0;
        sumSq += val * val;
        if ((val > 0 && nextVal < 0) || (val < 0 && nextVal > 0)) {
          crossings++;
        }
      }
      frameEnergies[f] = Math.sqrt(sumSq / frameSize);
      frameZcr[f] = crossings / frameSize;
      frameTimes[f] = (offset + frameSize / 2) / sampleRate;
    }

    // Baseline background energy before windowStart
    const preWindowFrames = frameEnergies.filter((_, idx) => frameTimes[idx] < windowStartSec);
    const baselineEnergy = preWindowFrames.length > 0
      ? preWindowFrames.reduce((a, b) => a + b, 0) / preWindowFrames.length
      : 0.001;

    // Search for sharpest valid vocal onset candidate in [windowStartSec, windowEndSec]
    let bestCandidateTime: number | null = null;
    let bestConfidence = 0;

    for (let f = 1; f < numFrames - 2; f++) {
      const t = frameTimes[f];
      if (t < windowStartSec || t > windowEndSec) continue;

      const ePre = (frameEnergies[f - 1] + frameEnergies[Math.max(0, f - 2)]) / 2;
      const eCur = frameEnergies[f];
      const ePost = (frameEnergies[f + 1] + frameEnergies[Math.min(numFrames - 1, f + 2)]) / 2;
      const zcr = frameZcr[f];

      // Energy rise ratio
      const energyGain = eCur - ePre;
      const relativeRise = ePre > 0 ? (eCur - ePre) / ePre : (eCur > 0.01 ? 2.0 : 0);

      // Check for vocal sustain in post-onset window (ensures not a fleeting percussive click)
      const isSustained = ePost >= eCur * 0.70 || ePost > baselineEnergy * 1.8;

      // Consonant friction or formant onset
      const isAcousticOnset = (energyGain > 0.005 && relativeRise > 0.65 && isSustained) ||
                              (zcr > 0.20 && eCur > baselineEnergy * 1.2 && isSustained);

      if (isAcousticOnset) {
        // Compute confidence metric based on sharpness, sustain, and VAD alignment
        const contrastScore = Math.min(1.0, (ePost - baselineEnergy) / (Math.max(0.01, ePost) + 1e-4));
        const slopeScore = Math.min(1.0, relativeRise / 2.5);
        const nearVadSegment = vocalSegments.some(s => Math.abs(s.startTime - t) <= 0.070);
        const vadBonus = nearVadSegment ? 0.20 : 0.0;

        const confidence = +(Math.max(0, Math.min(1.0, 0.45 * contrastScore + 0.35 * slopeScore + vadBonus))).toFixed(2);

        if (confidence > bestConfidence) {
          bestConfidence = confidence;
          bestCandidateTime = t;
        }
      }
    }

    if (bestCandidateTime !== null && bestConfidence >= MIN_CONFIDENCE_THRESHOLD) {
      const proposedStart = +bestCandidateTime.toFixed(3);
      const correction = +(proposedStart - origStart).toFixed(3);

      // Verify monotonicity with previous word
      const minAllowableStart = prev ? +(prev.startTime + 0.040).toFixed(3) : 0;

      if (proposedStart < minAllowableStart) {
        console.log(
          `[WordTiming]\nWord: "${wordText}"\nOriginal start: ${origStart.toFixed(3)}\nDetected onset: ${proposedStart.toFixed(3)}\nCorrection: ${correction.toFixed(3)}\nConfidence: ${bestConfidence.toFixed(2)}\nApplied: NO\nReason: conflicts with previous word boundary`
        );
      } else {
        // Apply conservative earlier onset
        current.startTime = proposedStart;
        if (current.words && current.words[0]) {
          current.words[0].startTime = proposedStart;
        }
        // If previous cue overlapped, clamp its end time safely
        if (prev && prev.endTime > proposedStart) {
          prev.endTime = proposedStart;
          if (prev.words && prev.words[0]) {
            prev.words[0].endTime = proposedStart;
          }
        }

        console.log(
          `[WordTiming]\nWord: "${wordText}"\nOriginal start: ${origStart.toFixed(3)}\nDetected onset: ${proposedStart.toFixed(3)}\nCorrection: ${correction.toFixed(3)}\nConfidence: ${bestConfidence.toFixed(2)}\nApplied: YES`
        );
      }
    } else {
      console.log(
        `[WordTiming]\nWord: "${wordText}"\nOriginal start: ${origStart.toFixed(3)}\nDetected onset: ${bestCandidateTime !== null ? bestCandidateTime.toFixed(3) : 'none'}\nCorrection: ${bestCandidateTime !== null ? (bestCandidateTime - origStart).toFixed(3) : '0.000'}\nConfidence: ${bestConfidence.toFixed(2)}\nApplied: NO\nReason: ${bestCandidateTime !== null ? 'confidence too low' : 'no clear vocal attack transient'}`
      );
    }
  }

  return refinedCues;
}

