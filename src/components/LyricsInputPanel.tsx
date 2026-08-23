import React, { useMemo } from 'react';
import { AlignLeft, Sparkles, Radio, Trash2, ListOrdered, FileText, CheckCircle, Flame } from 'lucide-react';
import { SyncMode } from '../types';
import { SAMPLE_LYRICS_PRESETS, LyricPreset } from '../data/sampleLyrics';

interface LyricsInputPanelProps {
  lyricsText: string;
  onLyricsChange: (text: string) => void;
  syncMode: SyncMode;
  onSyncModeChange: (mode: SyncMode) => void;
  onAutoAlign: () => void;
  onInstantAcousticSync: () => void;
  onStartTapSync: () => void;
  isAligning: boolean;
  audioLoaded: boolean;
  cleanEmptyLines: boolean;
  onToggleCleanEmptyLines: () => void;
}

export const LyricsInputPanel: React.FC<LyricsInputPanelProps> = ({
  lyricsText,
  onLyricsChange,
  syncMode,
  onSyncModeChange,
  onAutoAlign,
  onInstantAcousticSync,
  onStartTapSync,
  isAligning,
  audioLoaded,
  cleanEmptyLines,
  onToggleCleanEmptyLines,
}) => {
  // Compute active lines based on settings
  const parsedLines = useMemo(() => {
    const raw = lyricsText.split('\n');
    if (cleanEmptyLines) {
      return raw.map(l => l.trim()).filter(l => l.length > 0);
    }
    return raw;
  }, [lyricsText, cleanEmptyLines]);

  const lineCount = parsedLines.length;
  const wordCount = useMemo(() => {
    return lyricsText.split(/\s+/).filter(Boolean).length;
  }, [lyricsText]);

  const handleSelectPreset = (preset: LyricPreset) => {
    onLyricsChange(preset.text);
  };

  const handleCleanHeaders = () => {
    // Remove bracket tags like [Verse 1], [Chorus], [00:12.45], (Solo), Verse 1:
    const cleaned = lyricsText
      .split('\n')
      .map(line => {
        return line
          .replace(/^\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]\s*/g, '') // remove LRC timestamps
          .replace(/^\[(?:verse|chorus|bridge|intro|outro|hook|pre-chorus|solo|drop|interlude)[^\]]*\]/gi, '') // remove section headers
          .replace(/^(?:verse|chorus|bridge|intro|outro|hook|pre-chorus):\s*/gi, '')
          .trim();
      })
      .filter(l => l.length > 0)
      .join('\n');

    onLyricsChange(cleaned);
  };

  const handleClear = () => {
    onLyricsChange('');
  };

  return (
    <div id="lyrics-input-card" className="flex flex-col h-full rounded-2xl bg-zinc-900/70 border border-zinc-800 p-4 lg:p-5">
      
      {/* Header with Title & Line Count Badges */}
      <div className="flex items-center justify-between gap-2 pb-3 mb-3 border-b border-zinc-800/80">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-cyan-500/10 text-cyan-400 flex items-center justify-center">
            <AlignLeft className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-zinc-100">Lyric Transcript Input</h2>
            <p className="text-[11px] text-zinc-400">1 line of text = 1 SRT subtitle cue</p>
          </div>
        </div>

        {/* Dynamic Line Counter Badge */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-950 border border-zinc-800 text-xs">
            <span className="text-zinc-400 font-medium">Exact Lines:</span>
            <span className={`font-mono font-bold ${lineCount === 22 ? 'text-emerald-400' : 'text-cyan-400'}`}>
              {lineCount}
            </span>
          </div>
        </div>
      </div>

      {/* Preset Selector & Formatting Controls */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5 text-xs">
        <div className="flex items-center gap-1.5">
          <span className="text-zinc-400">Sample lyrics:</span>
          <div className="flex items-center gap-1">
            {SAMPLE_LYRICS_PRESETS.map((preset) => (
              <button
                key={preset.id}
                id={`btn-preset-${preset.id}`}
                onClick={() => handleSelectPreset(preset)}
                className="px-2 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white border border-zinc-700/80 transition-colors"
                title={`${preset.title} (${preset.lineCount} lines)`}
              >
                {preset.id === 'user-22-lines' ? '✨ 22-Lines Sample' : preset.title.split(' ')[0]}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 cursor-pointer text-zinc-400 hover:text-zinc-200 select-none">
            <input
              type="checkbox"
              id="chk-clean-empty-lines"
              checked={cleanEmptyLines}
              onChange={onToggleCleanEmptyLines}
              className="rounded bg-zinc-950 border-zinc-700 text-cyan-500 focus:ring-cyan-500/20"
            />
            <span>Skip blank lines</span>
          </label>

          {lyricsText.length > 0 && (
            <button
              id="btn-clean-headers"
              onClick={handleCleanHeaders}
              className="px-2 py-0.5 rounded text-[11px] bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-cyan-300 border border-zinc-700/60 transition-colors"
              title="Remove [Verse 1], [Chorus], and timestamps from lyrics"
            >
              ⚡ Clean Headers
            </button>
          )}

          {lyricsText.length > 0 && (
            <button
              id="btn-clear-lyrics"
              onClick={handleClear}
              className="px-2 py-0.5 rounded text-[11px] bg-zinc-800 hover:bg-rose-950/60 text-zinc-400 hover:text-rose-300 border border-zinc-700/60 hover:border-rose-800/60 flex items-center gap-1 transition-colors"
              title="Clear lyric text"
            >
              <Trash2 className="w-3 h-3 text-rose-400" />
              <span>Clear</span>
            </button>
          )}
        </div>
      </div>

      {/* Textarea Editor with Line Numbers */}
      <div className="relative flex-1 min-h-[260px] rounded-xl bg-zinc-950 border border-zinc-800 focus-within:border-cyan-500/80 transition-colors overflow-hidden flex">
        {/* Line Numbers Gutter */}
        <div className="w-10 bg-zinc-900/60 border-r border-zinc-800/80 py-3 select-none text-right pr-2 text-xs font-mono text-zinc-600 flex flex-col gap-0.5 overflow-hidden">
          {parsedLines.map((_, idx) => (
            <div key={idx} className="h-6 leading-6">
              {idx + 1}
            </div>
          ))}
          {parsedLines.length === 0 && <div className="h-6 leading-6">1</div>}
        </div>

        {/* Main Textarea */}
        <textarea
          id="lyrics-textarea"
          value={lyricsText}
          onChange={(e) => onLyricsChange(e.target.value)}
          placeholder={`Paste your lyrics here (1 line per subtitle cue)...\n\nExample:\nWalking through the quiet street tonight\nThe city lights are glowing softly blue\nI hear the echoes fading out of sight\nAnd every shadow whispers back to you`}
          className="flex-1 w-full p-3 bg-transparent text-xs sm:text-sm text-zinc-200 font-mono resize-none focus:outline-none leading-6 placeholder:text-zinc-600"
          spellCheck={false}
        />
      </div>

      {/* Footer Info & Alignment Actions */}
      <div className="mt-3.5 space-y-2.5">
        
        {/* Mode Toggle Description */}
        <div className="p-2.5 rounded-xl bg-zinc-950/60 border border-zinc-800 text-xs flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-zinc-400 font-medium">Timestamp granularity:</span>
            <span className="font-semibold text-zinc-200">
              {syncMode === 'line' ? 'Line-by-Line (Exact 1:1 SRT)' : 'Word-by-Word (Karaoke)'}
            </span>
          </div>
          <span className="text-[11px] text-zinc-500">
            {syncMode === 'line' ? `${lineCount} SRT cues` : `~${wordCount} word cues`}
          </span>
        </div>

        {/* Primary Action Buttons */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          
          {/* AI Auto-Align Button */}
          <button
            id="btn-auto-align-ai"
            onClick={onAutoAlign}
            disabled={isAligning || !audioLoaded || lineCount === 0}
            className={`w-full py-3 px-4 rounded-xl font-semibold text-xs sm:text-sm flex items-center justify-center gap-2 transition-all shadow-lg ${
              isAligning
                ? 'bg-zinc-800 text-zinc-400 cursor-not-allowed'
                : !audioLoaded || lineCount === 0
                ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                : 'bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white shadow-cyan-500/20 active:scale-[0.98]'
            }`}
          >
            <Sparkles className={`w-4 h-4 ${isAligning ? 'animate-spin text-cyan-400' : 'text-cyan-200'}`} />
            <span>
              {isAligning
                ? 'AI Aligning to Audio...'
                : `AI Auto-Align (${lineCount} Lines)`}
            </span>
          </button>

          {/* Vibe Tap-to-Sync Button (Manual Karaoke Mode) */}
          <button
            id="btn-start-tap-sync"
            onClick={onStartTapSync}
            disabled={!audioLoaded || lineCount === 0}
            className={`w-full py-3 px-4 rounded-xl font-semibold text-xs sm:text-sm flex items-center justify-center gap-2 border transition-all ${
              !audioLoaded || lineCount === 0
                ? 'bg-zinc-900 border-zinc-800 text-zinc-600 cursor-not-allowed'
                : 'bg-zinc-900 hover:bg-zinc-800 border-emerald-500/40 text-emerald-300 hover:text-emerald-200 hover:border-emerald-500 active:scale-[0.98]'
            }`}
          >
            <Flame className="w-4 h-4 text-emerald-400" />
            <span>Vibe Tap-to-Sync</span>
          </button>

        </div>

        {/* Secondary Instant Sync Button */}
        {audioLoaded && lineCount > 0 && (
          <button
            id="btn-instant-acoustic-sync"
            onClick={onInstantAcousticSync}
            disabled={isAligning}
            className="w-full py-2 px-3 rounded-xl bg-zinc-900/80 hover:bg-zinc-800 border border-zinc-800 hover:border-cyan-500/50 text-xs font-medium text-zinc-300 hover:text-cyan-300 flex items-center justify-center gap-1.5 transition-all active:scale-[0.99]"
            title="Instant alignment using local audio waveform vocal detection (0s delay)"
          >
            <span>⚡ Instant Acoustic Vocal Sync (No Waiting)</span>
          </button>
        )}

        {!audioLoaded && lineCount > 0 && (
          <p className="text-[11px] text-amber-400/90 text-center">
            Upload a WAV file or click &quot;Generate Demo Song&quot; above to enable alignment.
          </p>
        )}
      </div>

    </div>
  );
};
