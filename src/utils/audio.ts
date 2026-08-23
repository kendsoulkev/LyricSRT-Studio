/**
 * Audio processing utilities for waveform rendering, audio conversion, and demo audio generation.
 */

// Downsample and convert AudioBuffer or File to a 16kHz mono WAV base64 string for lightweight AI transmission
export async function prepareAudioForAi(fileOrBlob: Blob): Promise<{ base64: string; mimeType: string; duration: number }> {
  const arrayBuffer = await fileOrBlob.arrayBuffer();
  const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  
  try {
    const decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    const duration = decoded.duration;

    // Resample to 16kHz mono to keep upload fast and ultra-lightweight (< 5MB)
    const targetSampleRate = 16000;
    const offlineCtx = new OfflineAudioContext(1, Math.ceil(duration * targetSampleRate), targetSampleRate);
    
    const source = offlineCtx.createBufferSource();
    source.buffer = decoded;
    source.connect(offlineCtx.destination);
    source.start(0);

    const renderedBuffer = await offlineCtx.startRendering();
    const wavBlob = audioBufferToWavBlob(renderedBuffer);
    const base64 = await blobToBase64(wavBlob);

    return {
      base64,
      mimeType: 'audio/wav',
      duration,
    };
  } finally {
    audioCtx.close();
  }
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
  // sample format (raw)
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
    console.warn("Could not extract waveform peaks:", err);
    // Fallback pseudo peaks
    return Array.from({ length: targetPeaks }, () => Math.random() * 0.5 + 0.2);
  } finally {
    audioCtx.close();
  }
}

/**
 * Generates a pleasant synthetic demo musical/vocal backing track with lyrics timing
 * so the user can immediately test without uploading a file!
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
    
    // Play 3 chord notes (Root, 3rd, 5th)
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
