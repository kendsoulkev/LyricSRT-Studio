import React, { useState } from 'react';
import { SubtitleCue, SyncMode } from '../types';
import { formatSrtTimestamp, formatDisplayTime } from '../utils/srt';
import { Play, Clock, ArrowRight, Plus, Minus, MoveRight, Layers, Sliders, CheckCircle2, ChevronDown, ChevronUp } from 'lucide-react';

interface SubtitleTableEditorProps {
  cues: SubtitleCue[];
  activeCueIndex: number;
  syncMode: SyncMode;
  currentTime: number;
  onUpdateCue: (index: number, updated: Partial<SubtitleCue>) => void;
  onPlayCue: (cue: SubtitleCue) => void;
  onSetCueToCurrentTime: (index: number, type: 'start' | 'end') => void;
  onShiftAllTimestamps: (offsetSeconds: number) => void;
  onSnapToAcousticPeaks?: () => void;
  onRemoveOverlaps?: () => void;
}

export const SubtitleTableEditor: React.FC<SubtitleTableEditorProps> = ({
  cues,
  activeCueIndex,
  syncMode,
  currentTime,
  onUpdateCue,
  onPlayCue,
  onSetCueToCurrentTime,
  onShiftAllTimestamps,
  onSnapToAcousticPeaks,
  onRemoveOverlaps,
}) => {
  const [shiftValue, setShiftValue] = useState<string>('0.5');
  const [expandedWordCueIndex, setExpandedWordCueIndex] = useState<number | null>(null);

  const handleApplyShift = (multiplier: 1 | -1) => {
    const val = parseFloat(shiftValue);
    if (!isNaN(val) && val > 0) {
      onShiftAllTimestamps(val * multiplier);
    }
  };

  const handleNudge = (index: number, field: 'startTime' | 'endTime', delta: number) => {
    const cue = cues[index];
    if (!cue) return;
    const newVal = Math.max(0, +(cue[field] + delta).toFixed(3));
    onUpdateCue(index, { [field]: newVal });
  };

  if (cues.length === 0) {
    return (
      <div className="rounded-2xl bg-zinc-900/60 border border-zinc-800 p-8 text-center flex flex-col items-center justify-center gap-3">
        <div className="w-12 h-12 rounded-2xl bg-zinc-800 text-zinc-500 flex items-center justify-center">
          <Layers className="w-6 h-6" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-zinc-300">No Subtitle Timestamps Generated Yet</h3>
          <p className="text-xs text-zinc-500 max-w-sm mt-1">
            Click &quot;AI Auto-Align&quot; or &quot;Vibe Tap-to-Sync&quot; on the lyrics panel to generate exact timestamps for every line.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div id="subtitle-table-card" className="flex flex-col rounded-2xl bg-zinc-900/70 border border-zinc-800 overflow-hidden">
      
      {/* Header & Global Shift Bar */}
      <div className="p-4 border-b border-zinc-800/80 bg-zinc-950/40 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-cyan-400" />
          <h3 className="text-sm font-bold text-zinc-100">Subtitle Cues Timeline Editor</h3>
          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-cyan-950 border border-cyan-800 text-cyan-400">
            {cues.length} Total Cues
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Quick Vocal Energy Snap Button */}
          {onSnapToAcousticPeaks && (
            <button
              id="btn-snap-vocal-energy"
              onClick={onSnapToAcousticPeaks}
              className="px-2.5 py-1 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-cyan-500/40 text-zinc-300 hover:text-cyan-300 text-xs font-medium flex items-center gap-1 transition-all"
              title="Snap start/end boundaries to closest vocal audio bursts"
            >
              <span>🧲 Snap to Onsets</span>
            </button>
          )}

          {/* Clean Overlaps Button */}
          {onRemoveOverlaps && (
            <button
              id="btn-remove-overlaps"
              onClick={onRemoveOverlaps}
              className="px-2.5 py-1 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-emerald-500/40 text-zinc-300 hover:text-emerald-300 text-xs font-medium flex items-center gap-1 transition-all"
              title="Ensure no subtitle cue overlaps the subsequent line"
            >
              <span>✨ Fix Overlaps</span>
            </button>
          )}

          {/* Global Time Shift Tool */}
          <div className="flex items-center gap-1.5 text-xs bg-zinc-900 px-2.5 py-1 rounded-xl border border-zinc-800">
            <span className="text-zinc-400 font-medium">Shift:</span>
            <button
              onClick={() => handleApplyShift(-1)}
              className="px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-mono font-bold"
              title="Shift all cues earlier"
            >
              -{shiftValue}s
            </button>
            <input
              type="number"
              value={shiftValue}
              step="0.1"
              min="0.1"
              onChange={(e) => setShiftValue(e.target.value)}
              className="w-12 text-center bg-zinc-950 border border-zinc-700 rounded px-1 text-zinc-200 font-mono text-xs"
            />
            <button
              onClick={() => handleApplyShift(1)}
              className="px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-mono font-bold"
              title="Shift all cues later"
            >
              +{shiftValue}s
            </button>
          </div>
        </div>
      </div>

      {/* Table List of Cues */}
      <div className="max-h-[380px] overflow-y-auto divide-y divide-zinc-800/50">
        {cues.map((cue, index) => {
          const isActive = index === activeCueIndex;
          const duration = +(cue.endTime - cue.startTime).toFixed(2);
          const hasWords = syncMode === 'word' && Array.isArray(cue.words) && cue.words.length > 0;
          const isExpanded = expandedWordCueIndex === index;

          return (
            <div
              key={cue.id || index}
              id={`cue-row-${cue.index}`}
              className={`p-3 transition-colors ${
                isActive
                  ? 'bg-cyan-950/30 border-l-4 border-cyan-400'
                  : index % 2 === 0
                  ? 'bg-zinc-950/20 hover:bg-zinc-800/40'
                  : 'bg-transparent hover:bg-zinc-800/40'
              }`}
            >
              <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
                
                {/* Left: Cue index & Text */}
                <div className="flex items-start gap-3 flex-1 min-w-0">
                  <span className={`px-2 py-0.5 rounded text-xs font-mono font-bold shrink-0 mt-0.5 ${
                    isActive ? 'bg-cyan-500 text-zinc-950' : 'bg-zinc-800 text-zinc-400'
                  }`}>
                    #{cue.index}
                  </span>

                  <div className="flex-1 min-w-0">
                    <input
                      type="text"
                      value={cue.text}
                      onChange={(e) => onUpdateCue(index, { text: e.target.value })}
                      className="w-full bg-transparent text-xs sm:text-sm font-medium text-zinc-200 focus:bg-zinc-900 focus:px-2 focus:py-1 rounded border border-transparent focus:border-zinc-700 outline-none transition-all"
                    />
                    <div className="flex items-center gap-2 mt-0.5 text-[11px] text-zinc-500 font-mono">
                      <span>Duration: {duration}s</span>
                      {hasWords && (
                        <button
                          onClick={() => setExpandedWordCueIndex(isExpanded ? null : index)}
                          className="flex items-center gap-0.5 text-cyan-400 hover:text-cyan-300"
                        >
                          <span>{cue.words?.length} words</span>
                          {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Right: Timestamps & Controls */}
                <div className="flex flex-wrap items-center gap-2 w-full md:w-auto justify-end">
                  
                  {/* Start Timestamp Control */}
                  <div className="flex items-center gap-1 bg-zinc-950 px-2 py-1 rounded-lg border border-zinc-800 text-xs">
                    <span className="text-[10px] uppercase font-bold text-zinc-500">In</span>
                    <input
                      type="number"
                      step="0.05"
                      min="0"
                      value={cue.startTime}
                      onChange={(e) => onUpdateCue(index, { startTime: parseFloat(e.target.value) || 0 })}
                      className="w-16 bg-transparent text-center font-mono text-cyan-300 font-medium focus:outline-none"
                    />
                    <div className="flex flex-col">
                      <button
                        onClick={() => handleNudge(index, 'startTime', 0.1)}
                        className="text-[9px] text-zinc-400 hover:text-white px-0.5"
                      >
                        ▲
                      </button>
                      <button
                        onClick={() => handleNudge(index, 'startTime', -0.1)}
                        className="text-[9px] text-zinc-400 hover:text-white px-0.5"
                      >
                        ▼
                      </button>
                    </div>
                    <button
                      onClick={() => onSetCueToCurrentTime(index, 'start')}
                      title="Set In-point to current audio playhead"
                      className="text-[10px] px-1 py-0.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded"
                    >
                      Now
                    </button>
                  </div>

                  <ArrowRight className="w-3.5 h-3.5 text-zinc-600 hidden sm:block" />

                  {/* End Timestamp Control */}
                  <div className="flex items-center gap-1 bg-zinc-950 px-2 py-1 rounded-lg border border-zinc-800 text-xs">
                    <span className="text-[10px] uppercase font-bold text-zinc-500">Out</span>
                    <input
                      type="number"
                      step="0.05"
                      min="0"
                      value={cue.endTime}
                      onChange={(e) => onUpdateCue(index, { endTime: parseFloat(e.target.value) || 0 })}
                      className="w-16 bg-transparent text-center font-mono text-emerald-300 font-medium focus:outline-none"
                    />
                    <div className="flex flex-col">
                      <button
                        onClick={() => handleNudge(index, 'endTime', 0.1)}
                        className="text-[9px] text-zinc-400 hover:text-white px-0.5"
                      >
                        ▲
                      </button>
                      <button
                        onClick={() => handleNudge(index, 'endTime', -0.1)}
                        className="text-[9px] text-zinc-400 hover:text-white px-0.5"
                      >
                        ▼
                      </button>
                    </div>
                    <button
                      onClick={() => onSetCueToCurrentTime(index, 'end')}
                      title="Set Out-point to current audio playhead"
                      className="text-[10px] px-1 py-0.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded"
                    >
                      Now
                    </button>
                  </div>

                  {/* Play preview snippet button */}
                  <button
                    id={`btn-play-cue-${cue.index}`}
                    onClick={() => onPlayCue(cue)}
                    className="p-1.5 rounded-lg bg-zinc-800 hover:bg-cyan-500 hover:text-zinc-950 text-zinc-300 transition-colors"
                    title="Play this line snippet"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                  </button>

                </div>

              </div>

              {/* Expandable Word Timings Section (When in Word Mode) */}
              {isExpanded && hasWords && (
                <div className="mt-3 pt-2.5 border-t border-zinc-800/80 pl-8 pr-2">
                  <p className="text-[11px] font-semibold text-zinc-400 mb-1.5">Word Timestamps:</p>
                  <div className="flex flex-wrap gap-2">
                    {cue.words!.map((w, wIdx) => {
                      const isWordActive = currentTime >= w.startTime && currentTime <= w.endTime;
                      return (
                        <div
                          key={wIdx}
                          className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-mono border ${
                            isWordActive
                              ? 'bg-cyan-950 text-cyan-300 border-cyan-700'
                              : 'bg-zinc-900 text-zinc-300 border-zinc-800'
                          }`}
                        >
                          <span className="font-semibold font-sans">{w.word}</span>
                          <span className="text-[10px] text-zinc-500">{w.startTime.toFixed(2)}s</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

            </div>
          );
        })}
      </div>

      {/* Footer info badge */}
      <div className="p-2.5 bg-zinc-950 border-t border-zinc-800 text-xs text-zinc-400 flex items-center justify-between">
        <span>SRT Line Count Guarantee: <strong className="text-cyan-400">{cues.length}</strong> cues</span>
        <span className="font-mono text-[11px]">Format: 00:00:00,000</span>
      </div>

    </div>
  );
};
