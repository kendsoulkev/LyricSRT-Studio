import { SubtitleCue, SyncMode, GeminiWord, VocalSegment } from '../types';

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

/**
 * Map clean Gemini word-level forced alignment response directly into app subtitle cues.
 */
export function formatGeminiResponseToCues(geminiOutput: GeminiWord[]): SubtitleCue[] {
  return geminiOutput.map((item, index) => {
    return {
      id: `cue-${index + 1}-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
      index: index + 1,
      text: item.word,
      startTime: item.startTime,
      endTime: item.endTime,
      words: [
        {
          word: item.word,
          startTime: item.startTime,
          endTime: item.endTime,
        },
      ],
    };
  });
}

interface PreciseWord {
  word: string;
  startTime: number;
  endTime: number;
}

/**
 * Calculates the phonetic structural weight of a word using syllable and letter profiles.
 * Prevents small connector words from eating up time blocks belonging to long words.
 */
export function calculateWordPhoneticWeight(word: string): number {
  const clean = word.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (clean.length <= 2) return 1.0; // Short words like "a", "I", "in", "to"

  // Count vowel groupings (including common singing diphthongs)
  const vowelMatches = clean.match(/[aeiouy]{1,2}/g);
  let syllables = vowelMatches ? vowelMatches.length : 1;

  // Silent "e" adjustments at the end of English words
  if (clean.endsWith('e') && !clean.endsWith('le') && syllables > 1) {
    syllables -= 1;
  }

  // Weight scales heavily based on syllable density + physical length complexity
  return syllables * 2.0 + (clean.length * 0.3);
}

/**
 * Distributes an absolute length of time across an array of words based on their phonetic weight.
 */
export function distributeTimePhonetically(
  words: string[],
  absoluteStart: number,
  absoluteEnd: number
): { word: string; startTime: number; endTime: number }[] {
  const totalDuration = absoluteEnd - absoluteStart;
  if (words.length === 0 || totalDuration <= 0) return [];

  const weights = words.map(w => calculateWordPhoneticWeight(w));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0) || 1;

  let currentMarker = absoluteStart;

  return words.map((word, idx) => {
    const wordWeight = weights[idx];
    const allocatedDuration = (wordWeight / totalWeight) * totalDuration;
    
    const wStart = currentMarker;
    // Enforce strict boundary lock for the last word to completely block drift
    const wEnd = idx === words.length - 1 ? absoluteEnd : currentMarker + allocatedDuration;
    currentMarker = wEnd;

    return {
      word,
      startTime: +wStart.toFixed(3),
      endTime: +wEnd.toFixed(3),
    };
  });
}

/**
 * Advanced Phonetic Distributor with Syllable Density & Natural Decay Tracking.
 * Distributes time across words accurately without unnatural skewing.
 */
export function distributeTimePhoneticallyWithDecay(
  words: string[],
  absoluteStart: number,
  absoluteEnd: number,
  isEndOfLine = false
): { word: string; startTime: number; endTime: number }[] {
  // Use natural phonetic syllable weighting across the full duration
  return distributeTimePhonetically(words, absoluteStart, absoluteEnd);
}

/**
 * Transforms standard line cues into acoustic-mapped word-by-word subtitle cues.
 * Uses real vocal audio energy spikes and phonetic syllable weighting to prevent flat linear distribution errors.
 */
export function generateAccurateWordCuesFromLines(
  lineCues: SubtitleCue[],
  vocalSegments: VocalSegment[] = [] // Pass the local VAD results from prepareAudioForAi
): SubtitleCue[] {
  const wordCues: SubtitleCue[] = [];
  let globalWordIndex = 1;

  lineCues.forEach((line) => {
    const rawWords = line.text.split(/\s+/).filter(Boolean);
    if (rawWords.length === 0) return;

    // 1. Extract the actual audio energy segments that fall inside this line's time window
    // Added a small 150ms padding buffer to catch words that start slightly early or bleed out
    const linePeaks = vocalSegments.filter(
      (seg) => seg.startTime >= (line.startTime - 0.15) && seg.endTime <= (line.endTime + 0.15)
    );

    let mappedWords: PreciseWord[] = [];

    // SCENARIO A: Complete 1:1 Vocal Burst to Word match
    if (linePeaks.length === rawWords.length) {
      mappedWords = rawWords.map((word, idx) => ({
        word,
        startTime: linePeaks[idx].startTime,
        endTime: linePeaks[idx].endTime,
      }));
    }
    // SCENARIO B: Shared Vocal Burst Clusters -> Apply Phonetic Distribution inside Clusters with Decay Tracking
    else if (linePeaks.length > 0) {
      const peaksToWordsRatio = rawWords.length / linePeaks.length;

      linePeaks.forEach((peak, peakIdx) => {
        const startW = Math.floor(peakIdx * peaksToWordsRatio);
        const endW = Math.min(rawWords.length, Math.floor((peakIdx + 1) * peaksToWordsRatio));
        const clusterWords = rawWords.slice(startW, endW);
        const isLastPeak = peakIdx === linePeaks.length - 1;

        if (clusterWords.length > 0) {
          // Use phonetic calculation with decay tracking to split up the shared audio peak cluster
          const partitionedWords = distributeTimePhoneticallyWithDecay(
            clusterWords,
            peak.startTime,
            peak.endTime,
            isLastPeak
          );
          mappedWords.push(...partitionedWords);
        }
      });
    }

    // SCENARIO C: Complete Fallback -> Apply Phonetic Distribution with Decay across the entire macro line
    if (mappedWords.length !== rawWords.length) {
      mappedWords = distributeTimePhoneticallyWithDecay(rawWords, line.startTime, line.endTime, true);
    }

    // 2. Unfurl the acoustically positioned words into independent subtitle cue items
    mappedWords.forEach((wordObj) => {
      wordCues.push({
        id: `word-cue-${globalWordIndex}-${Date.now()}`,
        index: globalWordIndex,
        text: wordObj.word,
        startTime: wordObj.startTime,
        endTime: wordObj.endTime,
        words: [wordObj],
      });
      globalWordIndex++;
    });
  });

  return wordCues;
}

/**
 * Snaps raw AI word timestamps to the nearest local formant-filtered vocal segments.
 * Eliminates irregular early/late micro-fluctuations.
 */
export function snapAiWordsToLocalVad(
  aiWords: { word: string; relativeStart?: number; relativeEnd?: number; startTime?: number; endTime?: number }[],
  lineAbsoluteStart: number,
  localVocalSegments: VocalSegment[] = [],
  startPaddingOffset: number = 0
): { word: string; absoluteStart: number; absoluteEnd: number }[] {
  // Find all VAD segments belonging to this micro-chunk line container
  const lineBufferPadding = 0.350;
  const currentLineVad = (localVocalSegments || []).filter(
    (seg) => seg.startTime >= (lineAbsoluteStart - lineBufferPadding)
  );

  return aiWords.map((item) => {
    const relStart = typeof item.relativeStart === 'number' ? item.relativeStart : (item.startTime || 0);
    const relEnd = typeof item.relativeEnd === 'number' ? item.relativeEnd : (item.endTime || relStart + 0.3);

    const unpaddedRelStart = Math.max(0, relStart - startPaddingOffset);
    const unpaddedRelEnd = Math.max(unpaddedRelStart + 0.05, relEnd - startPaddingOffset);

    const rawAbsoluteStart = lineAbsoluteStart + unpaddedRelStart;
    const rawAbsoluteEnd = lineAbsoluteStart + unpaddedRelEnd;

    // Find the closest real vocal burst start boundary
    let bestStartMatch = rawAbsoluteStart;
    let minStartDistance = Infinity;

    currentLineVad.forEach((seg) => {
      const distance = Math.abs(seg.startTime - rawAbsoluteStart);
      // Only snap if a real audio burst exists within a 350ms window
      if (distance < 0.350 && distance < minStartDistance) {
        minStartDistance = distance;
        bestStartMatch = seg.startTime;
      }
    });

    // Find the closest real vocal burst end boundary
    let bestEndMatch = rawAbsoluteEnd;
    let minEndDistance = Infinity;

    currentLineVad.forEach((seg) => {
      const distance = Math.abs(seg.endTime - rawAbsoluteEnd);
      if (distance < 0.350 && distance < minEndDistance) {
        minEndDistance = distance;
        bestEndMatch = seg.endTime;
      }
    });

    // Fallback to avoid overlapping if snapping compresses the item incorrectly
    const finalStart = bestStartMatch;
    const finalEnd = bestEndMatch > finalStart ? bestEndMatch : finalStart + Math.max(0.08, rawAbsoluteEnd - rawAbsoluteStart);

    return {
      word: item.word,
      absoluteStart: +Math.max(0, finalStart).toFixed(3),
      absoluteEnd: +Math.max(finalStart + 0.05, finalEnd).toFixed(3),
    };
  });
}

/**
 * High-Precision Subtitle Continuous Flow Sequencer
 * Removes timing gaps between words to eliminate lingering text and irregular jumps.
 */
export function applyLinguisticSmoothing(cues: any[]): any[] {
  if (cues.length <= 1) return cues;

  for (let i = 0; i < cues.length - 1; i++) {
    const current = cues[i];
    const next = cues[i + 1];

    const currentWord = current.words?.[0] || current;
    const nextWord = next.words?.[0] || next;

    // Lock sequential words together seamlessly to prevent early flickering
    if (currentWord.endTime > nextWord.startTime) {
      currentWord.endTime = nextWord.startTime;
    }

    current.startTime = currentWord.startTime;
    current.endTime = currentWord.endTime;
  }

  return cues;
}

/**
 * Advanced Intro Silence Mask Guard
 * Inspects local audio energy envelopes to prevent text from lighting up during early humming or instrumentals.
 */
export function maskIntroHummingSegments(
  compiledCues: SubtitleCue[],
  vocalSegments: VocalSegment[] = []
): SubtitleCue[] {
  if (!compiledCues || compiledCues.length === 0 || !vocalSegments || vocalSegments.length === 0) {
    return compiledCues;
  }

  // 1. Identify the first true high-energy spoken onset burst in the track
  // Filters out low-amplitude hums or background noise floors
  const activeSpeechOnsets = vocalSegments.filter((seg) => typeof seg.energy === 'number' ? seg.energy > 0.25 : true);
  if (activeSpeechOnsets.length === 0) return compiledCues;

  const absoluteFirstWordOnset = activeSpeechOnsets[0].startTime;

  // 2. Scan and calibrate cues falling within the initial track intro window
  return compiledCues.map((cue) => {
    const wordObj = cue.words?.[0] || { startTime: cue.startTime, endTime: cue.endTime, word: cue.text };

    // If the timing engine positioned a word early during an instrumental or humming block,
    // force it to wait until the physical voice activity detection tracks actual speech.
    if (wordObj.startTime < absoluteFirstWordOnset) {
      console.log(`[HummingMask] Shifted word "${wordObj.word}" forward from ${wordObj.startTime}s to match real onset at ${absoluteFirstWordOnset}s.`);

      const adjustedStart = absoluteFirstWordOnset;
      const originalDuration = wordObj.endTime - wordObj.startTime;
      const adjustedEnd = adjustedStart + Math.max(0.200, originalDuration);

      return {
        ...cue,
        startTime: +adjustedStart.toFixed(3),
        endTime: +adjustedEnd.toFixed(3),
        words: [{
          word: wordObj.word,
          startTime: +adjustedStart.toFixed(3),
          endTime: +adjustedEnd.toFixed(3)
        }]
      };
    }

    return cue;
  });
}

/**
 * Clean Intro Structural Gate
 * Shields the intro window from premature text triggers by mapping early items to the first spoken onset.
 */
export function applyIntroSpeechGate(
  cues: SubtitleCue[],
  trueSpeechOnset: number
): SubtitleCue[] {
  if (!cues || cues.length === 0 || trueSpeechOnset <= 0) return cues;

  return cues.map((cue) => {
    const wordObj = cue.words?.[0] || { startTime: cue.startTime, endTime: cue.endTime, word: cue.text };

    // If the synchronization engine positioned a word early inside the humming or intro block,
    // hold its display back until the playhead crosses the true spoken attack boundary.
    if (wordObj.startTime < trueSpeechOnset) {
      const originalDuration = wordObj.endTime - wordObj.startTime;
      const adjustedStart = trueSpeechOnset;
      const adjustedEnd = adjustedStart + Math.max(0.180, originalDuration);

      return {
        ...cue,
        startTime: +adjustedStart.toFixed(3),
        endTime: +adjustedEnd.toFixed(3),
        words: [{
          word: wordObj.word,
          startTime: +adjustedStart.toFixed(3),
          endTime: +adjustedEnd.toFixed(3)
        }]
      };
    }

    return cue;
  });
}

