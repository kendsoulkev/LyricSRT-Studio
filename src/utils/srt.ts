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
 * Formats seconds into ASS timestamp: H:MM:SS.cc
 */
export function formatAssTimestamp(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) seconds = 0;
  const totalCs = Math.round(seconds * 100);
  const hrs = Math.floor(totalCs / 360000);
  const mins = Math.floor((totalCs % 360000) / 6000);
  const secs = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;

  const pad = (n: number, z = 2) => String(n).padStart(z, '0');
  return `${hrs}:${pad(mins)}:${pad(secs)}.${pad(cs, 2)}`;
}

/**
 * Generates Advanced SubStation Alpha (.ass) format with Karaoke word timing ({\k} tags)
 */
export function generateAss(cues: SubtitleCue[], title = 'Lyrics'): string {
  const header = `[Script Info]
; Script generated by LyricSRT Studio (QuickLRC Engine)
Title: ${title}
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: None

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,10,10,25,1
Style: Karaoke,Arial,32,&H00FFFFFF,&H0000D7FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,2,2,10,10,30,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const dialogueLines = cues.map((cue) => {
    const startStr = formatAssTimestamp(cue.startTime);
    const endStr = formatAssTimestamp(cue.endTime);

    if (cue.words && cue.words.length > 0) {
      // Build Karaoke string with {\k<centiseconds>} per word
      const kText = cue.words
        .map((w) => {
          const durationCs = Math.max(1, Math.round((w.endTime - w.startTime) * 100));
          return `{\\k${durationCs}}${w.word}`;
        })
        .join(' ');

      return `Dialogue: 0,${startStr},${endStr},Karaoke,,0,0,0,,${kText}`;
    }

    return `Dialogue: 0,${startStr},${endStr},Default,,0,0,0,,${cue.text}`;
  });

  return header + dialogueLines.join('\n');
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
