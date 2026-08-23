export type SyncMode = 'line' | 'word';

export interface WordTiming {
  word: string;
  startTime: number; // in seconds
  endTime: number; // in seconds
}

export interface SubtitleCue {
  id: string;
  index: number; // 1-based
  text: string;
  startTime: number; // in seconds
  endTime: number; // in seconds
  words?: WordTiming[];
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

export type ExportFormat = 'srt' | 'vtt' | 'lrc' | 'json';
