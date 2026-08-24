import React from 'react';
import { Sparkles, CheckCircle2, Loader2, AlertCircle, Anchor } from 'lucide-react';
import { FirstLineAnchor } from '../types';

interface AlignmentProgressModalProps {
  isOpen: boolean;
  step: number; // 1, 2, 3, 4
  statusText: string;
  percent: number;
  lineCount: number;
  audioDuration: number;
  error?: string | null;
  anchorInfo?: FirstLineAnchor | null;
  onClose?: () => void;
  onUseFallbackVocalSync?: () => void;
}

export const AlignmentProgressModal: React.FC<AlignmentProgressModalProps> = ({
  isOpen,
  step,
  statusText,
  percent,
  lineCount,
  audioDuration,
  error,
  anchorInfo,
  onClose,
  onUseFallbackVocalSync,
}) => {
  if (!isOpen) return null;

  const steps = [
    { num: 1, title: 'WAV Audio Decoding', desc: `Processing track (~${audioDuration.toFixed(1)}s)` },
    { num: 2, title: 'Vocal Activity Detection', desc: 'Analyzing voice energy & phrases' },
    {
      num: 3,
      title: anchorInfo ? 'Guided AI Synchronization' : 'AI Transcript Synchronization',
      desc: anchorInfo
        ? `Aligning lines 2–${lineCount} strictly after ${anchorInfo.endTime.toFixed(2)}s`
        : `Aligning ${lineCount} verbatim lyric lines`,
    },
    { num: 4, title: 'Cue Timing Verification', desc: 'Validating line count & boundary timestamps' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-2xl shadow-cyan-950/40 flex flex-col gap-5 overflow-hidden">
        
        {/* Ambient Top Glow */}
        <div className="absolute -top-24 left-1/2 -translate-x-1/2 w-64 h-32 bg-gradient-to-b from-cyan-500/20 to-transparent blur-3xl pointer-events-none" />

        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shrink-0">
            {error ? (
              <AlertCircle className="w-5 h-5 text-rose-400" />
            ) : anchorInfo ? (
              <Anchor className="w-5 h-5 text-amber-400 animate-pulse" />
            ) : (
              <Sparkles className="w-5 h-5 animate-pulse" />
            )}
          </div>
          <div>
            <h3 className="text-base font-bold text-white">
              {error ? 'Synchronization Status' : anchorInfo ? 'Guided AI Audio Alignment' : 'AI Audio Synchronization'}
            </h3>
            <p className="text-xs text-zinc-400">
              {anchorInfo
                ? `Aligning lines 2–${lineCount} using Line 1 anchor guide`
                : `Matching ${lineCount} lyric lines to WAV audio timing`}
            </p>
          </div>
        </div>

        {/* Anchor Info Banner */}
        {anchorInfo && !error && (
          <div className="p-2.5 rounded-xl bg-amber-950/40 border border-amber-800/60 text-xs flex items-center justify-between gap-2 text-amber-200">
            <div className="flex items-center gap-1.5 min-w-0">
              <Anchor className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              <span className="font-medium truncate">Line 1 Locked:</span>
            </div>
            <span className="font-mono font-bold text-[11px] text-amber-300 shrink-0">
              {anchorInfo.startTime.toFixed(2)}s → {anchorInfo.endTime.toFixed(2)}s
            </span>
          </div>
        )}

        {/* Progress Bar */}
        {!error && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs text-zinc-400 font-mono">
              <span>{statusText}</span>
              <span className="text-cyan-400 font-bold">{Math.round(percent)}%</span>
            </div>
            <div className="h-2 w-full bg-zinc-950 rounded-full overflow-hidden border border-zinc-800/80">
              <div
                className="h-full bg-gradient-to-r from-cyan-500 via-blue-500 to-indigo-500 rounded-full transition-all duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        )}

        {/* Steps List */}
        <div className="space-y-3 py-1">
          {steps.map((s) => {
            const isCompleted = step > s.num;
            const isCurrent = step === s.num;
            return (
              <div
                key={s.num}
                className={`flex items-start gap-3 p-2.5 rounded-xl border transition-all ${
                  isCurrent
                    ? 'bg-cyan-950/30 border-cyan-500/40 text-cyan-200'
                    : isCompleted
                    ? 'bg-zinc-950/40 border-zinc-800/60 text-zinc-300'
                    : 'bg-zinc-950/20 border-zinc-900 text-zinc-600'
                }`}
              >
                <div className="mt-0.5">
                  {isCompleted ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  ) : isCurrent ? (
                    <Loader2 className="w-4 h-4 text-cyan-400 animate-spin" />
                  ) : (
                    <div className="w-4 h-4 rounded-full border border-zinc-700 flex items-center justify-center text-[10px] text-zinc-500">
                      {s.num}
                    </div>
                  )}
                </div>
                <div className="flex-1 text-xs">
                  <div className="font-semibold">{s.title}</div>
                  <div className="text-[11px] text-zinc-500">{s.desc}</div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Error / Fallback Action Area */}
        {error && (
          <div className="p-3.5 rounded-2xl bg-rose-950/40 border border-rose-900/60 text-xs text-rose-300 space-y-3">
            <p className="leading-relaxed">{error}</p>
            {onUseFallbackVocalSync && (
              <button
                onClick={onUseFallbackVocalSync}
                className="w-full py-2 px-3 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-zinc-950 font-bold text-xs shadow-md transition-all"
              >
                Apply Instant Vocal Energy Sync
              </button>
            )}
          </div>
        )}

        {/* Dismiss if in error state */}
        {error && onClose && (
          <button
            onClick={onClose}
            className="w-full py-2 text-xs text-zinc-400 hover:text-white bg-zinc-800 hover:bg-zinc-700 rounded-xl transition-colors"
          >
            Close
          </button>
        )}

      </div>
    </div>
  );
};
