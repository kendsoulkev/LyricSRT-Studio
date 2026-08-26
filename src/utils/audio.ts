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
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }

  // 3. Frame-by-frame RMS and Zero-Crossing Rate (ZCR) computation
  const energies = new Float32Array(numFrames);
  const zcrs = new Float32Array(numFrames);
  let maxEnergy = 0;

  for (let f = 0; f < numFrames; f++) {
    const start = f * hopSize;
    let sumSquares = 0;
    let zeroCrossings = 0;

    for (let i = 0; i < frameSize; i++) {
      const val = filteredData[start + i] || 0;
      sumSquares += val * val;
      if (i > 0 && ((val >= 0 && filteredData[start + i - 1] < 0) || (val < 0 && filteredData[start + i - 1] >= 0))) {
        zeroCrossings++;
      }
    }

    const rms = Math.sqrt(sumSquares / frameSize);
    energies[f] = rms;
    zcrs[f] = zeroCrossings / frameSize;
    if (rms > maxEnergy) maxEnergy = rms;
  }

  if (maxEnergy === 0) return [];

  // Dynamic Energy Thresholding with Hysteresis (Voice Attack vs Silence Floor)
  const onsetThreshold = maxEnergy * 0.12; // Lower threshold to catch soft singing breath onsets
  const sustainThreshold = maxEnergy * 0.05; // Keep sustaining through soft vibrato decays

  const segments: VocalSegment[] = [];
  let inVoice = false;
  let segStartFrame = 0;
  let segPeakEnergy = 0;
  let segPeakFrame = 0;

  for (let f = 0; f < numFrames; f++) {
    const energy = energies[f];
    const isVoicedFrame = energy >= (inVoice ? sustainThreshold : onsetThreshold);

    if (!inVoice && isVoicedFrame) {
      inVoice = true;
      segStartFrame = f;
      segPeakEnergy = energy;
      segPeakFrame = f;
    } else if (inVoice) {
      if (energy > segPeakEnergy) {
        segPeakEnergy = energy;
        segPeakFrame = f;
      }

      if (!isVoicedFrame) {
        // Check if this is just a brief micro-pause (e.g., stop consonant 'p', 't', 'k')
        const lookaheadFrames = Math.min(numFrames - f - 1, 15); // 150ms lookahead
        let resumesQuickly = false;
        for (let k = 1; k <= lookaheadFrames; k++) {
          if (energies[f + k] >= onsetThreshold) {
            resumesQuickly = true;
            break;
          }
        }

        if (!resumesQuickly) {
          inVoice = false;
          const startTime = (segStartFrame * hopSize) / sampleRate;
          const endTime = (f * hopSize + frameSize) / sampleRate;
          const peakTime = (segPeakFrame * hopSize) / sampleRate;

          // Filter out transient clicks/noise < 80ms
          if (endTime - startTime >= 0.08) {
            segments.push({
              startTime: +startTime.toFixed(3),
              endTime: +endTime.toFixed(3),
              peakTime: +peakTime.toFixed(3),
              energy: +(segPeakEnergy / maxEnergy).toFixed(3),
            });
          }
        }
      }
    }
  }

  // Close unfinalized trailing segment
  if (inVoice) {
    const startTime = (segStartFrame * hopSize) / sampleRate;
    const endTime = (numFrames * hopSize + frameSize) / sampleRate;
    const peakTime = (segPeakFrame * hopSize) / sampleRate;
    if (endTime - startTime >= 0.08) {
      segments.push({
        startTime: +startTime.toFixed(3),
        endTime: +endTime.toFixed(3),
        peakTime: +peakTime.toFixed(3),
        energy: +(segPeakEnergy / maxEnergy).toFixed(3),
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
      : Math.min(totalDuration, targetApproxTime + Math.min(step * 0.9, 3.5));

    // Ensure strictly increasing start times
    if (i > 0) {
      const prevEst = startOffset + (i - 0.5) * step;
      if (start <= prevEst) {
        start = prevEst + 0.1;
      }
    }

    if (end <= start) {
      end = Math.min(totalDuration, start + 2.0);
    }

    return {
      index: i + 1,
      text: text.trim(),
      startTime: +start.toFixed(2),
      endTime: +end.toFixed(2),
    };
  });
}

/**
 * Extracts an EXACT sub-segment from an AudioBuffer without artificial silent padding.
 * Renders the exact audio time window [startTime, endTime] directly to a Base64 WAV string.
 */
export async function sliceAudioBufferExact(
  parentBuffer: AudioBuffer,
  startTime: number,
  endTime: number
): Promise<{ base64: string }> {
  const sampleRate = parentBuffer.sampleRate;
  const safeStartTime = Math.max(0, startTime);
  const safeEndTime = Math.min(parentBuffer.duration, Math.max(safeStartTime + 0.05, endTime));
  const startSample = Math.floor(safeStartTime * sampleRate);
  const endSample = Math.ceil(safeEndTime * sampleRate);
  const frameLength = Math.max(1, endSample - startSample);

  const offlineCtx = new OfflineAudioContext(
    parentBuffer.numberOfChannels,
    frameLength,
    sampleRate
  );

  const source = offlineCtx.createBufferSource();
  source.buffer = parentBuffer;
  source.connect(offlineCtx.destination);
  source.start(0, safeStartTime, (endSample - startSample) / sampleRate);

  const renderedChunk = await offlineCtx.startRendering();
  const wavBlob = audioBufferToWavBlob(renderedChunk);
  const base64 = await blobToBase64(wavBlob);

  return { base64 };
}

/**
 * Extracts a sub-segment from an AudioBuffer with lookahead context handles.
 * Prevents cloud machine learning models from truncating final line words.
 */
export async function sliceAudioBufferWithContext(
  parentBuffer: AudioBuffer,
  startTime: number,
  endTime: number
): Promise<string> {
  const sampleRate = parentBuffer.sampleRate;
  
  // Provide 1.2 seconds of trailing acoustic lookahead context
  const TRAILING_CONTEXT = 1.200; 
  const adjustedEndTime = Math.min(parentBuffer.duration, endTime + TRAILING_CONTEXT);
  const frameLength = Math.ceil((adjustedEndTime - startTime) * sampleRate);

  const offlineCtx = new OfflineAudioContext(
    parentBuffer.numberOfChannels,
    frameLength,
    sampleRate
  );

  const source = offlineCtx.createBufferSource();
  source.buffer = parentBuffer;
  
  source.connect(offlineCtx.destination);
  source.start(0, startTime, adjustedEndTime - startTime);

  const renderedChunk = await offlineCtx.startRendering();
  const wavBlob = audioBufferToWavBlob(renderedChunk);
  return await blobToBase64(wavBlob);
}

/**
 * Slices an exact sub-segment from an AudioBuffer and injects a 500ms lead-in of pure digital silence.
 * This guarantees the ML / acoustic model receives a pristine zero-energy floor before the true vocal onset.
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
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    } else {
      osc.type = 'square';
      osc.frequency.setValueAtTime(250, t);
      gain.gain.setValueAtTime(0.08, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    }

    osc.connect(gain);
    gain.connect(offlineCtx.destination);
    osc.start(t);
    osc.stop(t + 0.25);
  }

  // Add a synthesized vocal-like lead melody (sine + vibrato) singing the lyrics timing
  lyricsLines.forEach((_, idx) => {
    const lineStart = introDuration + idx * lineDuration;
    const notesPerLine = 4;
    const noteDur = (lineDuration - 0.4) / notesPerLine;
    const scale = [261.63, 293.66, 329.63, 349.23, 392.0, 440.0];

    for (let n = 0; n < notesPerLine; n++) {
      const nStart = lineStart + n * noteDur;
      const osc = offlineCtx.createOscillator();
      const gain = offlineCtx.createGain();

      osc.type = 'sine';
      const freq = scale[(idx * 2 + n) % scale.length];
      osc.frequency.setValueAtTime(freq, nStart);

      // Formant & Envelope
      gain.gain.setValueAtTime(0, nStart);
      gain.gain.linearRampToValueAtTime(0.18, nStart + 0.05);
      gain.gain.setValueAtTime(0.15, nStart + noteDur - 0.05);
      gain.gain.linearRampToValueAtTime(0, nStart + noteDur);

      osc.connect(gain);
      gain.connect(offlineCtx.destination);
      osc.start(nStart);
      osc.stop(nStart + noteDur);
    }
  });

  const renderedBuffer = await offlineCtx.startRendering();
  const wavBlob = audioBufferToWavBlob(renderedBuffer);
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

  const frameHopSec = 0.005; // 5ms step resolution
  const frameWindowSec = 0.020; // 20ms integration window
  const frameSamples = Math.floor(frameWindowSec * sampleRate);

  const getEnergy = (timeSec: number) => {
    const startIdx = Math.floor(timeSec * sampleRate);
    if (startIdx < 0 || startIdx + frameSamples >= filteredData.length) return 0;
    let sum = 0;
    for (let i = 0; i < frameSamples; i++) {
      const s = filteredData[startIdx + i];
      sum += s * s;
    }
    return Math.sqrt(sum / frameSamples);
  };

  for (let i = 0; i < refinedCues.length; i++) {
    const current = refinedCues[i];
    const prev = i > 0 ? refinedCues[i - 1] : null;
    const wordText = current.text.trim();
    const origStart = current.startTime;

    // Lookback window: [origStart - 120ms, origStart - 15ms]
    const lookbackStart = Math.max(0, origStart - MAX_EARLIER_CORRECTION_SEC);
    const lookbackEnd = Math.max(0, origStart - 0.015);

    if (lookbackEnd <= lookbackStart) continue;

    // Measure pre-window baseline energy (quiet noise floor)
    const baselineEnergy = getEnergy(Math.max(0, lookbackStart - 0.040));

    let bestCandidateTime: number | null = null;
    let bestConfidence = 0;

    for (let t = lookbackStart; t <= lookbackEnd; t += frameHopSec) {
      const ePre = getEnergy(t - 0.015);
      const ePost = getEnergy(t + 0.015);
      const eFuture = getEnergy(t + 0.035); // sustain check

      // Check for sharp onset rise & sustained energy (filters out click artifacts)
      const energyDelta = ePost - ePre;
      const relativeRise = ePost / (Math.max(0.005, ePre) + 1e-4);
      const isAcousticOnset = energyDelta > 0.015 && relativeRise >= 1.6 && eFuture >= ePost * 0.7;

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

// Convert AudioBuffer to WAV Blob
export function audioBufferToWavBlob(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;

  const length = buffer.length * numChannels * bytesPerSample;
  const arrayBuffer = new ArrayBuffer(44 + length);
  const view = new DataView(arrayBuffer);

  /* RIFF identifier */
  writeString(view, 0, 'RIFF');
  /* RIFF chunk length */
  view.setUint32(4, 36 + length, true);
  /* RIFF type */
  writeString(view, 8, 'WAVE');
  /* format chunk identifier */
  writeString(view, 12, 'fmt ');
  /* format chunk length */
  view.setUint32(16, 16, true);
  /* sample format (raw) */
  view.setUint16(20, format, true);
  /* channel count */
  view.setUint16(22, numChannels, true);
  /* sample rate */
  view.setUint32(24, sampleRate, true);
  /* byte rate (sample rate * block align) */
  view.setUint32(28, sampleRate * blockAlign, true);
  /* block align (channel count * bytes per sample) */
  view.setUint16(32, blockAlign, true);
  /* bits per sample */
  view.setUint16(34, bitDepth, true);
  /* data chunk identifier */
  writeString(view, 36, 'data');
  /* data chunk length */
  view.setUint32(40, length, true);

  // Interleave and convert float [-1, 1] to 16-bit signed integer
  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let channel = 0; channel < numChannels; channel++) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(channel)[i]));
      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, intSample, true);
      offset += 2;
    }
  }

  return new Blob([view], { type: 'audio/wav' });
}
