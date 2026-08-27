export type SyncMode = 'line' | 'word';

export interface WordTiming {
  word: string;
  startTime: number; // in seconds
  endTime: number; // in seconds
  isVerbalSpeech?: boolean;
  acousticScore?: number; // 0 - 100 acoustic WAV correlation score
  candidateAi?: { startTime: number; endTime: number; score: number };
  candidateAcoustic?: { startTime: number; endTime: number; score: number };
  selectedSource?: 'ai' | 'acoustic' | 'arbitrated';
}

export interface GeminiWord {
  word: string;
  startTime: number;
  endTime: number;
  isVerbalSpeech?: boolean;
}

export interface VocalSegment {
  startTime: number;
  endTime: number;
  peakTime?: number;
  energy?: number;
}

export interface FirstLineAnchor {
  startTime: number;
  endTime: number;
  text: string;
  words?: WordTiming[];
  isManual?: boolean;
}

export interface SubtitleCue {
  id: string;
  index: number; // 1-based
  text: string;
  startTime: number; // in seconds
  endTime: number; // in seconds
  words?: WordTiming[];
  lineAcousticScore?: number;
  isAnchored?: boolean;
}

export interface AudioTrackInfo {
  name: string;
  duration: number; // in seconds
  url: string;
  blob?: Blob;
  peaks?: number[];
  sampleRate?: number;
}

export type SyncState = 'idle' | 'aligning' | 'synced' | 'tapping' | 'error';

export interface AlignmentProgress {
  step: string;
  percent: number;
  message?: string;
}

export type ExportFormat = 'srt' | 'vtt' | 'lrc' | 'ass' | 'json';
