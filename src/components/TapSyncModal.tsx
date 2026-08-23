import React, { useState, useEffect, useRef, useCallback } from 'react';
import { SubtitleCue, SyncMode } from '../types';
import { Play, Pause, Flame, Check, X, RotateCcw, Sparkles } from 'lucide-react';
import { formatDisplayTime } from '../utils/srt';

interface TapSyncModalProps {
  isOpen: boolean;
  onClose: () => void;
  lines: string[];
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  syncMode: SyncMode;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
  onFinishTapSync: (cues: SubtitleCue[]) => void;
}

export const TapSyncModal: React.FC<TapSyncModalProps> = ({
  isOpen,
  onClose,
  lines,
  currentTime,
  duration,
  isPlaying,
  syncMode,
  onTogglePlay,
  onSeek,
  onFinishTapSync,
}) => {
  const [currentLineIndex, setCurrentLineIndex] = useState(0);
  const [recordedTimestamps, setRecordedTimestamps] = useState<{ index: number; text: string; startTime: number; endTime: number }[]>([]);
  const lastRecordedStartRef = useRef<number | null>(null);

  // Reset state when opened
  useEffect(() => {
    if (isOpen) {
      setCurrentLineIndex(0);
      setRecordedTimestamps([]);
      lastRecordedStartRef.current = null;
      onSeek(0);
    }
  }, [isOpen]);

  const handleRecordTap = useCallback(() => {
    if (currentLineIndex >= lines.length) return;

    const tapTime = currentTime;
    const currentLineText = lines[currentLineIndex];

    // If there was a previous line recorded without end time, finalize its end time to this tap
    const updated = [...recordedTimestamps];
    if (updated.length > 0) {
      const prev = updated[updated.length - 1];
      if (prev.endTime <= prev.startTime) {
        prev.endTime = Math.max(prev.startTime + 0.5, tapTime);
      }
    }

    // Default estimate for this line's end time
    const estimatedEnd = Math.min(duration, tapTime + 3.0);

    updated.push({
      index: currentLineIndex + 1,
      text: currentLineText,
      startTime: tapTime,
      endTime: estimatedEnd,
    });

    setRecordedTimestamps(updated);
    setCurrentLineIndex((prev) => prev + 1);
  }, [currentLineIndex, lines, currentTime, duration, recordedTimestamps]);

  // Keyboard shortcut: Spacebar to tap next line or play
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault();
        if (!isPlaying) {
          onTogglePlay();
        } else {
          handleRecordTap();
        }
      } else if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isPlaying, onTogglePlay, handleRecordTap, onClose]);

  const handleFinish = () => {
    // Convert recorded timestamps into SubtitleCue items
    const cues: SubtitleCue[] = lines.map((text, idx) => {
      const rec = recordedTimestamps[idx];
      const start = rec ? rec.startTime : (duration / lines.length) * idx;
      let end = rec ? rec.endTime : (duration / lines.length) * (idx + 1);
      if (end <= start) end = start + 2.5;

      const words = text.split(/\s+/).filter(Boolean).map((word, wIdx, arr) => {
        const span = (end - start) / Math.max(arr.length, 1);
        return {
          word,
          startTime: +(start + wIdx * span).toFixed(3),
          endTime: +(start + (wIdx + 1) * span).toFixed(3),
        };
      });

      return {
        id: `tap-cue-${idx + 1}-${Date.now()}`,
        index: idx + 1,
        text,
        startTime: +start.toFixed(3),
        endTime: +end.toFixed(3),
        words: syncMode === 'word' ? words : undefined,
      };
    });

    onFinishTapSync(cues);
    onClose();
  };

  const handleRestart = () => {
    setCurrentLineIndex(0);
    setRecordedTimestamps([]);
    lastRecordedStartRef.current = null;
    onSeek(0);
  };

  if (!isOpen) return null;

  const currentLine = lines[currentLineIndex] || 'All lines finished! Click &quot;Save &amp; Apply SRT&quot; below.';
  const nextLine = lines[currentLineIndex + 1];
  const progressPct = lines.length > 0 ? (currentLineIndex / lines.length) * 100 : 0;

  return (
    <div className="fixed inset-0 z-50 bg-zinc-950/90 backdrop-blur-md flex items-center justify-center p-4">
      <div
        id="tap-sync-modal"
        className="w-full max-w-2xl bg-zinc-900 border border-zinc-800 rounded-3xl p-6 sm:p-8 shadow-2xl flex flex-col gap-6 relative animate-in fade-in zoom-in-95 duration-150"
      >
        {/* Top Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 flex items-center justify-center">
              <Flame className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-zinc-100">Vibe Tap-to-Sync</h2>
              <p className="text-xs text-zinc-400">
                Play audio &amp; tap <kbd className="px-1.5 py-0.5 bg-zinc-800 rounded font-mono text-zinc-300 font-bold">Space</kbd> on every line&apos;s vocal cue
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 rounded-xl text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Progress bar & Counter */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-zinc-300">
              Line {Math.min(currentLineIndex + 1, lines.length)} of {lines.length}
            </span>
            <span className="font-mono text-cyan-400 font-semibold">
              {formatDisplayTime(currentTime)} / {formatDisplayTime(duration)}
            </span>
          </div>
          <div className="w-full h-2 bg-zinc-950 rounded-full overflow-hidden border border-zinc-800">
            <div
              className="h-full bg-gradient-to-r from-cyan-500 to-emerald-400 transition-all duration-150"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>

        {/* Current & Upcoming Lyrics Display */}
        <div className="flex flex-col items-center justify-center text-center min-h-[160px] p-6 rounded-2xl bg-zinc-950 border border-zinc-800/80 gap-3">
          {currentLineIndex < lines.length ? (
            <>
              <span className="text-xs uppercase font-bold tracking-widest text-emerald-400 font-mono">
                Now Singing (Line {currentLineIndex + 1})
              </span>
              <p className="text-xl sm:text-2xl font-bold text-white max-w-xl leading-relaxed transition-all">
                &ldquo;{currentLine}&rdquo;
              </p>
              {nextLine && (
                <div className="pt-2 border-t border-zinc-900 w-full">
                  <span className="text-[11px] text-zinc-500">Up next: </span>
                  <span className="text-xs text-zinc-400 italic">&ldquo;{nextLine}&rdquo;</span>
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-col items-center gap-2 py-4">
              <div className="w-12 h-12 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
                <Check className="w-6 h-6" />
              </div>
              <h3 className="text-lg font-bold text-zinc-100">All {lines.length} lines timed!</h3>
              <p className="text-xs text-zinc-400">Ready to save into your SRT file.</p>
            </div>
          )}
        </div>

        {/* Action Controls */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
          
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <button
              onClick={onTogglePlay}
              className="flex-1 sm:flex-none px-4 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold flex items-center justify-center gap-2 transition-colors"
            >
              {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 fill-current" />}
              <span>{isPlaying ? 'Pause' : 'Play Song'}</span>
            </button>

            <button
              onClick={handleRestart}
              className="p-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
              title="Restart from beginning"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
          </div>

          {/* Primary Big Tap Button */}
          {currentLineIndex < lines.length ? (
            <button
              id="btn-modal-tap-now"
              onClick={handleRecordTap}
              disabled={!isPlaying}
              className={`w-full sm:w-auto px-8 py-3.5 rounded-2xl font-bold text-sm sm:text-base flex items-center justify-center gap-2 transition-all shadow-xl ${
                isPlaying
                  ? 'bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-white shadow-emerald-500/30 scale-105 active:scale-95'
                  : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
              }`}
            >
              <Flame className="w-5 h-5" />
              <span>TAP ON BEAT (Spacebar)</span>
            </button>
          ) : (
            <button
              id="btn-modal-save-tap"
              onClick={handleFinish}
              className="w-full sm:w-auto px-8 py-3.5 rounded-2xl font-bold text-sm bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white shadow-xl shadow-cyan-500/20 active:scale-95 transition-all flex items-center justify-center gap-2"
            >
              <Sparkles className="w-4 h-4" />
              <span>Save &amp; Apply SRT Timestamps</span>
            </button>
          )}

        </div>

      </div>
    </div>
  );
};
