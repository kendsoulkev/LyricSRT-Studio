import React from 'react';
import { Music, FileText, Sparkles, CheckCircle2, SlidersHorizontal, RefreshCw } from 'lucide-react';
import { SyncMode } from '../types';

interface HeaderProps {
  lineCount: number;
  cueCount: number;
  syncMode: SyncMode;
  onSyncModeChange: (mode: SyncMode) => void;
  audioLoaded: boolean;
  audioDuration: number;
  isAligning: boolean;
  onReset: () => void;
  onLoadDemo: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  lineCount,
  cueCount,
  syncMode,
  onSyncModeChange,
  audioLoaded,
  audioDuration,
  isAligning,
  onReset,
  onLoadDemo,
}) => {
  return (
    <header id="app-header" className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-md sticky top-0 z-30 px-4 lg:px-8 py-3.5">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
        
        {/* Brand & Title */}
        <div className="flex items-center gap-3 w-full md:w-auto justify-between md:justify-start">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-cyan-500 to-emerald-400 flex items-center justify-center shadow-lg shadow-cyan-500/20">
              <Music className="w-5 h-5 text-zinc-950 font-bold" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold tracking-tight text-zinc-100">LyricSRT Studio</h1>
                <span className="text-[10px] uppercase font-semibold px-2 py-0.5 rounded-full bg-cyan-950/80 text-cyan-400 border border-cyan-800/60 tracking-wider">
                  Vibe Sync
                </span>
              </div>
              <p className="text-xs text-zinc-400">WAV Audio &amp; Lyrics to Precision SRT Subtitles</p>
            </div>
          </div>

          <button
            id="btn-load-demo-mobile"
            onClick={onLoadDemo}
            className="md:hidden text-xs px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-700 text-zinc-300 hover:text-white flex items-center gap-1.5"
          >
            <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
            Demo
          </button>
        </div>

        {/* Sync Mode Switcher & Metric Badges */}
        <div className="flex flex-wrap items-center gap-3 w-full md:w-auto justify-center md:justify-end">
          
          {/* Audio Duration & Line Match Status */}
          {lineCount > 0 && (
            <div className="hidden sm:flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg bg-zinc-900/90 border border-zinc-800">
              <FileText className="w-3.5 h-3.5 text-zinc-400" />
              <span className="text-zinc-300">
                <strong className="text-cyan-400 font-semibold">{lineCount}</strong> {lineCount === 1 ? 'Line' : 'Lines'}
              </span>
              {cueCount > 0 && (
                <>
                  <span className="text-zinc-600">→</span>
                  <span className="flex items-center gap-1 text-emerald-400 font-medium">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <strong>{cueCount}</strong> SRT Cues
                  </span>
                </>
              )}
            </div>
          )}

          {/* Mode Switcher: Line by Line vs Word by Word */}
          <div className="flex items-center p-0.5 rounded-xl bg-zinc-900 border border-zinc-800 text-xs">
            <button
              id="btn-mode-line"
              onClick={() => onSyncModeChange('line')}
              className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                syncMode === 'line'
                  ? 'bg-gradient-to-r from-cyan-500 to-blue-600 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Line-by-Line
            </button>
            <button
              id="btn-mode-word"
              onClick={() => onSyncModeChange('word')}
              className={`px-3 py-1.5 rounded-lg font-medium transition-all ${
                syncMode === 'word'
                  ? 'bg-gradient-to-r from-emerald-500 to-teal-600 text-white shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Word-by-Word
            </button>
          </div>

          {/* Load Sample Preset & Reset Actions */}
          <button
            id="btn-load-demo-header"
            onClick={onLoadDemo}
            disabled={isAligning}
            className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-xs font-medium text-zinc-200 transition-colors shadow-sm"
          >
            <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
            <span>Load 22-Line Demo</span>
          </button>

          <button
            id="btn-reset-header"
            onClick={onReset}
            title="Reset workspace"
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

      </div>
    </header>
  );
};
