import { SubtitleCue, SyncMode } from '../types';

/**
 * Formats seconds into SRT timestamp: HH:MM:SS,mmm
 * Example: 75.321 -> "00:01:15,321"
 */
export function formatSrtTimestamp(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) seconds = 0;
  
  const totalMs = Math.round(seconds * 1000);
  const hrs = Math.floor(totalMs / 3600000);
  const mins = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;

  const pad = (n: number, z = 2) => String(n).padStart(z, '0');
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${pad(ms, 3)}`;
}

/**
 * Formats seconds into WebVTT timestamp: HH:MM:SS.mmm
 */
export function formatVttTimestamp(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) seconds = 0;
  
  const totalMs = Math.round(seconds * 1000);
  const hrs = Math.floor(totalMs / 3600000);
  const mins = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;

  const pad = (n: number, z = 2) => String(n).padStart(z, '0');
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)}.${pad(ms, 3)}`;
}

/**
 * Formats seconds into LRC timestamp: [mm:ss.xx]
 */
export function formatLrcTimestamp(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) seconds = 0;
  
  const totalMs = Math.round(seconds * 1000);
  const mins = Math.floor(totalMs / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const hundredths = Math.floor((totalMs % 1000) / 10);

  const pad = (n: number, z = 2) => String(n).padStart(z, '0');
  return `[${pad(mins)}:${pad(secs)}.${pad(hundredths)}]`;
}

/**
 * Formats seconds into MM:SS.S for display in UI
 */
export function formatDisplayTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) seconds = 0;
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(2);
  return `${mins}:${secs.padStart(5, '0')}`;
}

/**
 * Generates valid SubRip (.srt) file content.
 * Supports line-by-line mode (1 cue per line) or word-by-word mode.
 */
export function generateSrt(cues: SubtitleCue[], mode: SyncMode = 'line'): string {
  if (!cues || cues.length === 0) return '';

  if (mode === 'word') {
    // If word-by-word mode, we can generate a cue for every individual word with its own timestamp
    let wordIndex = 1;
    const blocks: string[] = [];

    cues.forEach((cue) => {
      if (cue.words && cue.words.length > 0) {
        cue.words.forEach((w) => {
          blocks.push(
            `${wordIndex}\n${formatSrtTimestamp(w.startTime)} --> ${formatSrtTimestamp(w.endTime)}\n${w.word}`
          );
          wordIndex++;
        });
      } else {
        blocks.push(
          `${wordIndex}\n${formatSrtTimestamp(cue.startTime)} --> ${formatSrtTimestamp(cue.endTime)}\n${cue.text}`
        );
        wordIndex++;
      }
    });

    return blocks.join('\n\n');
  }

  // Line-by-line mode: exactly 1 block per line
  return cues
    .map((cue, idx) => {
      const index = idx + 1;
      const timeStr = `${formatSrtTimestamp(cue.startTime)} --> ${formatSrtTimestamp(cue.endTime)}`;
      return `${index}\n${timeStr}\n${cue.text}`;
    })
    .join('\n\n');
}

/**
 * Generates WebVTT (.vtt) file content
 */
export function generateVtt(cues: SubtitleCue[], mode: SyncMode = 'line'): string {
  if (!cues || cues.length === 0) return 'WEBVTT\n\n';

  let body = '';
  if (mode === 'word') {
    let wordIndex = 1;
    const blocks: string[] = [];
    cues.forEach((cue) => {
      if (cue.words && cue.words.length > 0) {
        cue.words.forEach((w) => {
          blocks.push(
            `${wordIndex}\n${formatVttTimestamp(w.startTime)} --> ${formatVttTimestamp(w.endTime)}\n${w.word}`
          );
          wordIndex++;
        });
      } else {
        blocks.push(
          `${wordIndex}\n${formatVttTimestamp(cue.startTime)} --> ${formatVttTimestamp(cue.endTime)}\n${cue.text}`
        );
        wordIndex++;
      }
    });
    body = blocks.join('\n\n');
  } else {
    body = cues
      .map((cue, idx) => {
        const index = idx + 1;
        const timeStr = `${formatVttTimestamp(cue.startTime)} --> ${formatVttTimestamp(cue.endTime)}`;
        return `${index}\n${timeStr}\n${cue.text}`;
      })
      .join('\n\n');
  }

  return `WEBVTT\n\n${body}`;
}

/**
 * Generates LRC format for Karaoke / lyric players
 */
export function generateLrc(cues: SubtitleCue[], title = 'Lyrics'): string {
  const header = `[ti:${title}]\n[re:LyricSRT Studio]\n[ve:1.0]\n\n`;
  const lines = cues.map((cue) => {
    if (cue.words && cue.words.length > 0) {
      // Enhanced LRC with word timestamps
      const wordPart = cue.words
        .map((w) => `${formatLrcTimestamp(w.startTime)}${w.word}`)
        .join(' ');
      return wordPart;
    }
    return `${formatLrcTimestamp(cue.startTime)}${cue.text}`;
  });

  return header + lines.join('\n');
}

/**
 * Trigger browser file download
 */
export function triggerDownload(filename: string, content: string, mimeType = 'text/plain') {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
