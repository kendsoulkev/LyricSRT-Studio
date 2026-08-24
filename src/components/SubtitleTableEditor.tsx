import React, { useState } from 'react';
import { SubtitleCue, SyncMode, WordTiming, FirstLineAnchor } from '../types';
import { formatSrtTimestamp, formatDisplayTime } from '../utils/srt';
import { Play, ArrowRight, Layers, ChevronDown, ChevronUp, Activity, GitCompare, Check, Zap, Anchor, Sparkles, Lock } from 'lucide-react';

interface SubtitleTableEditorProps {
  cues: SubtitleCue[];
  activeCueIndex: number;
  syncMode: SyncMode;
  currentTime: number;
  initialAlignmentDone?: boolean;
  firstLineManuallySet?: boolean;
  firstLineAnchor?: FirstLineAnchor | null;
  isAligning?: boolean;
  onUpdateCue: (index: number, updated: Partial<SubtitleCue>) => void;
  onPlayCue: (cue: SubtitleCue) => void;
  onSetCueToCurrentTime: (index: number, type: 'start' | 'end') => void;
  onShiftAllTimestamps: (offsetSeconds: number) => void;
  onSnapToAcousticPeaks?: () => void;
  onRemoveOverlaps?: () => void;
  onForcedAlignWords?: () => void;
  onAutoAlignWithAnchor?: () => void;
  onToggleLockLine1Anchor?: () => void;
}

export const SubtitleTableEditor: React.FC<SubtitleTableEditorProps> = ({
  cues,
  activeCueIndex,
  syncMode,
  currentTime,
  initialAlignmentDone = false,
  firstLineManuallySet = false,
  firstLineAnchor,
  isAligning = false,
  onUpdateCue,
  onPlayCue,
  onSetCueToCurrentTime,
  onShiftAllTimestamps,
  onSnapToAcousticPeaks,
  onRemoveOverlaps,
  onForcedAlignWords,
  onAutoAlignWithAnchor,
  onToggleLockLine1Anchor,
}) => {
  const [shiftValue, setShiftValue] = useState<string>('0.5');
  const [expandedWordCueIndex, setExpandedWordCueIndex] = useState<number | null>(null);
  const [comparingWordKey, setComparingWordKey] = useState<string | null>(null); // "cueIdx-wordIdx"

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

  const handleWordNudge = (cueIndex: number, wordIndex: number, delta: number) => {
    const cue = cues[cueIndex];
    if (!cue || !cue.words) return;
    const updatedWords = cue.words.map((w, idx) => {
      if (idx === wordIndex) {
        const newStart = Math.max(0, +(w.startTime + delta).toFixed(3));
        const newEnd = Math.max(newStart + 0.05, +(w.endTime + delta).toFixed(3));
        return { ...w, startTime: newStart, endTime: newEnd };
      }
      return w;
    });
    onUpdateCue(cueIndex, { words: updatedWords });
  };

  const handleWordTimeChange = (cueIndex: number, wordIndex: number, field: 'startTime' | 'endTime', value: number) => {
    const cue = cues[cueIndex];
    if (!cue || !cue.words || isNaN(value)) return;
    const updatedWords = [...cue.words];
    const targetWord = { ...updatedWords[wordIndex], [field]: Math.max(0, +value.toFixed(3)) };
    if (targetWord.endTime <= targetWord.startTime) {
      targetWord.endTime = +(targetWord.startTime + 0.1).toFixed(3);
    }
    updatedWords[wordIndex] = targetWord;
    onUpdateCue(cueIndex, { words: updatedWords });
  };

  const handleSelectCandidate = (cueIndex: number, wordIndex: number, source: 'ai' | 'acoustic') => {
    const cue = cues[cueIndex];
    if (!cue || !cue.words) return;
    const w = cue.words[wordIndex];
    const cand = source === 'ai' ? w.candidateAi : w.candidateAcoustic;
    if (!cand) return;

    const updatedWords = [...cue.words];
    updatedWords[wordIndex] = {
      ...w,
      startTime: cand.startTime,
      endTime: cand.endTime,
      acousticScore: cand.score,
      selectedSource: source,
    };
    onUpdateCue(cueIndex, { words: updatedWords });
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

          {/* Forced-Align Words Button */}
          {onForcedAlignWords && (
            <button
              id="btn-forced-align-words"
              onClick={onForcedAlignWords}
              className="px-2.5 py-1 rounded-xl bg-cyan-950/60 hover:bg-cyan-900/60 border border-cyan-800/60 hover:border-cyan-500 text-cyan-300 text-xs font-medium flex items-center gap-1 transition-all"
              title="Acoustically cross-compare and force-align all word boundaries with WAV waveform"
            >
              <Zap className="w-3.5 h-3.5 text-cyan-400" />
              <span>Acoustic Word Arbitration</span>
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

      {/* Line 1 Guide Anchor Banner (Active after initial alignment & manual adjustment) */}
      {initialAlignmentDone && cues.length > 1 && (firstLineManuallySet || cues[0]?.isAnchored || firstLineAnchor) && (
        <div className="p-3.5 bg-gradient-to-r from-amber-950/50 via-zinc-900 to-cyan-950/40 border-b border-amber-500/40 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 animate-in fade-in">
          <div className="flex items-start sm:items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-amber-500/20 border border-amber-500/40 text-amber-400 flex items-center justify-center shrink-0">
              <Anchor className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h4 className="text-xs font-bold text-amber-300">Line 1 Set as Guide Anchor</h4>
                <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-zinc-950 border border-amber-700 text-amber-300 font-bold">
                  {cues[0].startTime.toFixed(2)}s → {cues[0].endTime.toFixed(2)}s
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-200 border border-amber-700/50">
                  Fixed Boundary
                </span>
              </div>
              <p className="text-[11px] text-zinc-400 mt-0.5">
                Line 1 is locked. AI will analyze the WAV track starting from <span className="text-amber-300 font-mono font-bold">{cues[0].endTime.toFixed(2)}s</span> onward to synchronize lines 2 through {cues.length}.
              </p>
            </div>
          </div>

          {onAutoAlignWithAnchor && (
            <button
              id="btn-realign-from-line1-banner"
              onClick={onAutoAlignWithAnchor}
              disabled={isAligning}
              className="shrink-0 w-full sm:w-auto px-4 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-cyan-500 hover:from-amber-400 hover:to-cyan-400 text-zinc-950 font-bold text-xs flex items-center justify-center gap-1.5 shadow-lg shadow-amber-500/10 active:scale-95 transition-all"
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{isAligning ? 'AI Aligning...' : `AI Re-Align Lines 2–${cues.length}`}</span>
            </button>
          )}
        </div>
      )}

      {/* Table List of Cues */}
      <div className="max-h-[420px] overflow-y-auto divide-y divide-zinc-800/50">
        {cues.map((cue, index) => {
          const isActive = index === activeCueIndex;
          const duration = +(cue.endTime - cue.startTime).toFixed(2);
          const hasWords = syncMode === 'word' && Array.isArray(cue.words) && cue.words.length > 0;
          const isExpanded = expandedWordCueIndex === index;
          const isLine1Anchor = index === 0 && (firstLineManuallySet || cue.isAnchored || Boolean(firstLineAnchor));

          return (
            <div
              key={cue.id || index}
              id={`cue-row-${cue.index}`}
              className={`p-3 transition-colors ${
                isLine1Anchor
                  ? isActive
                    ? 'bg-amber-950/40 border-l-4 border-amber-400 ring-1 ring-amber-500/30'
                    : 'bg-amber-950/20 border-l-4 border-amber-500/60 hover:bg-amber-950/30'
                  : isActive
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
                    isLine1Anchor
                      ? 'bg-amber-500 text-zinc-950'
                      : isActive
                      ? 'bg-cyan-500 text-zinc-950'
                      : 'bg-zinc-800 text-zinc-400'
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
                    <div className="flex flex-wrap items-center gap-2 mt-0.5 text-[11px] text-zinc-500 font-mono">
                      <span>Duration: {duration}s</span>

                      {/* Anchor Guide Badge on Line 1 */}
                      {index === 0 && initialAlignmentDone && (
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-sans font-bold border ${
                          isLine1Anchor
                            ? 'bg-amber-950/90 border-amber-500 text-amber-300 shadow-sm shadow-amber-500/20'
                            : 'bg-zinc-900 border-zinc-700 text-zinc-400'
                        }`}>
                          <Anchor className="w-2.5 h-2.5 text-amber-400" />
                          <span>{isLine1Anchor ? 'Manual Anchor Guide' : 'Adjust Line 1 as Anchor'}</span>
                        </span>
                      )}

                      {cue.lineAcousticScore !== undefined && (
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[10px] font-sans font-medium border ${
                          cue.lineAcousticScore >= 85
                            ? 'bg-emerald-950/60 border-emerald-800 text-emerald-300'
                            : cue.lineAcousticScore >= 70
                            ? 'bg-cyan-950/60 border-cyan-800 text-cyan-300'
                            : 'bg-amber-950/60 border-amber-800 text-amber-300'
                        }`}>
                          <Activity className="w-2.5 h-2.5" />
                          <span>{cue.lineAcousticScore}% WAV Fit</span>
                        </span>
                      )}

                      {hasWords && (
                        <button
                          onClick={() => setExpandedWordCueIndex(isExpanded ? null : index)}
                          className="flex items-center gap-0.5 text-cyan-400 hover:text-cyan-300 font-sans font-medium"
                        >
                          <span>{cue.words?.length} word timings</span>
                          {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Right: Timestamps & Controls */}
                <div className="flex flex-wrap items-center gap-2 w-full md:w-auto justify-end">
                  
                  {/* Inline Re-Align button right on Line 1 */}
                  {index === 0 && initialAlignmentDone && cues.length > 1 && onAutoAlignWithAnchor && (
                    <button
                      id="btn-realign-cue1-inline"
                      onClick={onAutoAlignWithAnchor}
                      disabled={isAligning}
                      className="px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/50 hover:border-amber-400 text-amber-300 text-xs font-semibold flex items-center gap-1 transition-all"
                      title="AI Auto-Align lines 2–N strictly after this Line 1 end time"
                    >
                      <Sparkles className="w-3 h-3 text-amber-400" />
                      <span>AI Align Rest</span>
                    </button>
                  )}

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
                <div className="mt-3 pt-3 border-t border-zinc-800/80 pl-2 sm:pl-4 pr-2 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[11px] font-semibold text-cyan-400 flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse"></span>
                      <span>Dual-Time Acoustic WAV Synchronization & Comparison</span>
                    </p>
                    <span className="text-[10px] text-zinc-400 font-mono">
                      WAV Onset Snap & Melisma Vowel Tracking Active
                    </span>
                  </div>

                  {/* Proportional Visual Timeline Bar for the Line */}
                  <div className="w-full h-3.5 rounded-full bg-zinc-950 border border-zinc-800 overflow-hidden flex shadow-inner">
                    {cue.words!.map((w, wIdx) => {
                      const totalSpan = Math.max(0.1, cue.endTime - cue.startTime);
                      const wSpan = Math.max(0.02, w.endTime - w.startTime);
                      const pct = Math.max(2, Math.min(100, (wSpan / totalSpan) * 100));
                      const isWordActive = currentTime >= w.startTime && currentTime <= w.endTime;
                      
                      const colors = [
                        'bg-cyan-600/80 border-cyan-400',
                        'bg-blue-600/80 border-blue-400',
                        'bg-emerald-600/80 border-emerald-400',
                        'bg-violet-600/80 border-violet-400',
                        'bg-amber-600/80 border-amber-400',
                      ];
                      const colorClass = colors[wIdx % colors.length];

                      return (
                        <div
                          key={wIdx}
                          style={{ width: `${pct}%` }}
                          title={`"${w.word}" (${w.startTime.toFixed(2)}s - ${w.endTime.toFixed(2)}s) - ${w.acousticScore || 80}% WAV Match`}
                          className={`h-full border-r border-zinc-950 transition-all ${
                            isWordActive ? 'bg-cyan-300 ring-2 ring-cyan-100 z-10' : colorClass
                          }`}
                        />
                      );
                    })}
                  </div>

                  {/* Individual Word Control Cards with Dual-Time Comparator */}
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
                    {cue.words!.map((w, wIdx) => {
                      const isWordActive = currentTime >= w.startTime && currentTime <= w.endTime;
                      const wordKey = `${index}-${wIdx}`;
                      const isComparing = comparingWordKey === wordKey;
                      const hasDualCandidates = Boolean(w.candidateAi && w.candidateAcoustic);

                      return (
                        <div
                          key={wIdx}
                          className={`flex flex-col p-2.5 rounded-xl border text-xs transition-all ${
                            isWordActive
                              ? 'bg-cyan-950/70 border-cyan-500 ring-1 ring-cyan-500/50'
                              : 'bg-zinc-950/80 border-zinc-800 hover:border-zinc-700'
                          }`}
                        >
                          {/* Top row: Word text, play button, and WAV match badge */}
                          <div className="flex items-center justify-between gap-1 mb-2">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <button
                                onClick={() => onPlayCue({ ...cue, startTime: w.startTime, endTime: w.endTime })}
                                title={`Play "${w.word}"`}
                                className="p-1 rounded-md bg-zinc-900 hover:bg-cyan-500 hover:text-zinc-950 text-cyan-400 border border-zinc-800 transition-colors shrink-0"
                              >
                                <Play className="w-2.5 h-2.5 fill-current" />
                              </button>
                              <span className="font-semibold text-zinc-100 truncate text-[12px]">{w.word}</span>
                            </div>

                            <div className="flex items-center gap-1">
                              {w.acousticScore !== undefined && (
                                <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-bold border ${
                                  w.acousticScore >= 85
                                    ? 'bg-emerald-950/80 border-emerald-800 text-emerald-300'
                                    : w.acousticScore >= 70
                                    ? 'bg-cyan-950/80 border-cyan-800 text-cyan-300'
                                    : 'bg-amber-950/80 border-amber-800 text-amber-300'
                                }`}>
                                  {w.acousticScore}% WAV Fit
                                </span>
                              )}

                              {hasDualCandidates && (
                                <button
                                  onClick={() => setComparingWordKey(isComparing ? null : wordKey)}
                                  title="Compare AI vs Acoustic candidate times against WAV"
                                  className={`p-1 rounded border transition-colors ${
                                    isComparing
                                      ? 'bg-cyan-500 text-zinc-950 border-cyan-400'
                                      : 'bg-zinc-900 hover:bg-zinc-800 text-zinc-400 border-zinc-800'
                                  }`}
                                >
                                  <GitCompare className="w-2.5 h-2.5" />
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Middle row: Time range & nudge buttons */}
                          <div className="flex items-center justify-between gap-1">
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => handleWordNudge(index, wIdx, -0.05)}
                                title="Nudge earlier by 50ms"
                                className="px-1 py-0.5 text-[9px] font-mono bg-zinc-900 hover:bg-zinc-800 text-zinc-300 rounded border border-zinc-800"
                              >
                                -50ms
                              </button>

                              <input
                                type="number"
                                step="0.01"
                                value={w.startTime}
                                onChange={(e) => handleWordTimeChange(index, wIdx, 'startTime', parseFloat(e.target.value))}
                                title="Word Start (seconds)"
                                className="w-12 bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 text-[10px] text-center font-mono text-cyan-300 focus:outline-none focus:border-cyan-500"
                              />

                              <span className="text-[9px] text-zinc-600 font-mono">→</span>

                              <input
                                type="number"
                                step="0.01"
                                value={w.endTime}
                                onChange={(e) => handleWordTimeChange(index, wIdx, 'endTime', parseFloat(e.target.value))}
                                title="Word End (seconds)"
                                className="w-12 bg-zinc-900 border border-zinc-800 rounded px-1 py-0.5 text-[10px] text-center font-mono text-emerald-300 focus:outline-none focus:border-emerald-500"
                              />

                              <button
                                onClick={() => handleWordNudge(index, wIdx, 0.05)}
                                title="Nudge later by 50ms"
                                className="px-1 py-0.5 text-[9px] font-mono bg-zinc-900 hover:bg-zinc-800 text-zinc-300 rounded border border-zinc-800"
                              >
                                +50ms
                              </button>
                            </div>
                          </div>

                          {/* Expandable Dual-Timing Comparison Tray */}
                          {isComparing && hasDualCandidates && (
                            <div className="mt-2 pt-2 border-t border-zinc-800/80 space-y-1.5 bg-zinc-900/60 -mx-1 -mb-1 p-2 rounded-b-lg">
                              <div className="text-[10px] font-bold text-zinc-400 flex items-center justify-between">
                                <span>Dual Timestamp Comparison:</span>
                                <span className="text-[9px] font-normal text-cyan-400 font-mono">
                                  Selected: {w.selectedSource || 'arbitrated'}
                                </span>
                              </div>

                              {/* Candidate A (AI) */}
                              {w.candidateAi && (
                                <div className="flex items-center justify-between p-1.5 rounded bg-zinc-950 border border-zinc-800 text-[10px]">
                                  <div className="flex flex-col min-w-0">
                                    <span className="font-semibold text-zinc-300">Candidate A (AI):</span>
                                    <span className="font-mono text-zinc-400 text-[9px]">
                                      {w.candidateAi.startTime.toFixed(3)}s → {w.candidateAi.endTime.toFixed(3)}s ({w.candidateAi.score}% fit)
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-1 shrink-0">
                                    <button
                                      onClick={() => onPlayCue({ ...cue, startTime: w.candidateAi!.startTime, endTime: w.candidateAi!.endTime })}
                                      className="p-1 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-300"
                                      title="Audition AI timing"
                                    >
                                      <Play className="w-2.5 h-2.5 fill-current" />
                                    </button>
                                    <button
                                      onClick={() => handleSelectCandidate(index, wIdx, 'ai')}
                                      className={`px-1.5 py-0.5 rounded text-[9px] font-medium border ${
                                        w.selectedSource === 'ai'
                                          ? 'bg-cyan-500 text-zinc-950 border-cyan-400 font-bold'
                                          : 'bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border-zinc-700'
                                      }`}
                                    >
                                      Use
                                    </button>
                                  </div>
                                </div>
                              )}

                              {/* Candidate B (Acoustic Waveform) */}
                              {w.candidateAcoustic && (
                                <div className="flex items-center justify-between p-1.5 rounded bg-zinc-950 border border-zinc-800 text-[10px]">
                                  <div className="flex flex-col min-w-0">
                                    <span className="font-semibold text-emerald-400">Candidate B (WAV Acoustic):</span>
                                    <span className="font-mono text-zinc-400 text-[9px]">
                                      {w.candidateAcoustic.startTime.toFixed(3)}s → {w.candidateAcoustic.endTime.toFixed(3)}s ({w.candidateAcoustic.score}% fit)
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-1 shrink-0">
                                    <button
                                      onClick={() => onPlayCue({ ...cue, startTime: w.candidateAcoustic!.startTime, endTime: w.candidateAcoustic!.endTime })}
                                      className="p-1 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-300"
                                      title="Audition Acoustic timing"
                                    >
                                      <Play className="w-2.5 h-2.5 fill-current" />
                                    </button>
                                    <button
                                      onClick={() => handleSelectCandidate(index, wIdx, 'acoustic')}
                                      className={`px-1.5 py-0.5 rounded text-[9px] font-medium border ${
                                        w.selectedSource === 'acoustic'
                                          ? 'bg-emerald-500 text-zinc-950 border-emerald-400 font-bold'
                                          : 'bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border-zinc-700'
                                      }`}
                                    >
                                      Use
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}

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
