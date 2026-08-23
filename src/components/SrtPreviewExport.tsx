import React, { useState, useMemo } from 'react';
import { SubtitleCue, SyncMode, ExportFormat } from '../types';
import { generateSrt, generateVtt, generateLrc, triggerDownload, formatDisplayTime } from '../utils/srt';
import { Download, Copy, Check, FileText, MonitorPlay, Code2, Sparkles, CheckCircle2 } from 'lucide-react';

interface SrtPreviewExportProps {
  cues: SubtitleCue[];
  syncMode: SyncMode;
  currentTime: number;
  activeCueIndex: number;
  expectedLineCount: number;
  audioName?: string;
}

export const SrtPreviewExport: React.FC<SrtPreviewExportProps> = ({
  cues,
  syncMode,
  currentTime,
  activeCueIndex,
  expectedLineCount,
  audioName = 'lyrics',
}) => {
  const [activeTab, setActiveTab] = useState<'stage' | 'code'>('stage');
  const [exportFormat, setExportFormat] = useState<ExportFormat>('srt');
  const [copied, setCopied] = useState(false);

  // Generate code string based on format
  const outputContent = useMemo(() => {
    if (cues.length === 0) return '';
    switch (exportFormat) {
      case 'srt':
        return generateSrt(cues, syncMode);
      case 'vtt':
        return generateVtt(cues, syncMode);
      case 'lrc':
        return generateLrc(cues, audioName);
      case 'json':
        return JSON.stringify(cues, null, 2);
      default:
        return generateSrt(cues, syncMode);
    }
  }, [cues, syncMode, exportFormat, audioName]);

  const activeCue = cues[activeCueIndex];
  const isLineCountMatched = cues.length > 0 && cues.length === expectedLineCount;

  const handleCopy = async () => {
    if (!outputContent) return;
    await navigator.clipboard.writeText(outputContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    if (!outputContent) return;
    const baseName = audioName.replace(/\.[^/.]+$/, '').trim() || 'lyrics';
    let filename = `${baseName}.${exportFormat}`;
    let mime = 'text/plain';

    if (exportFormat === 'srt') {
      mime = 'application/x-subrip';
    } else if (exportFormat === 'vtt') {
      mime = 'text/vtt';
    } else if (exportFormat === 'json') {
      mime = 'application/json';
    }

    triggerDownload(filename, outputContent, mime);
  };

  return (
    <div id="srt-preview-export-card" className="flex flex-col rounded-2xl bg-zinc-900/80 border border-zinc-800 p-4 sm:p-5 gap-4">
      
      {/* Top Header & Tab Controls */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pb-3 border-b border-zinc-800/80">
        
        <div className="flex items-center gap-2">
          <div className="flex items-center p-0.5 rounded-xl bg-zinc-950 border border-zinc-800 text-xs">
            <button
              id="tab-btn-stage"
              onClick={() => setActiveTab('stage')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition-colors ${
                activeTab === 'stage'
                  ? 'bg-cyan-500 text-zinc-950 font-bold'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <MonitorPlay className="w-3.5 h-3.5" />
              <span>Live Stage Preview</span>
            </button>

            <button
              id="tab-btn-code"
              onClick={() => setActiveTab('code')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition-colors ${
                activeTab === 'code'
                  ? 'bg-cyan-500 text-zinc-950 font-bold'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Code2 className="w-3.5 h-3.5" />
              <span>SRT Code Output</span>
            </button>
          </div>

          {/* Verification Badge */}
          {cues.length > 0 && (
            <div className={`hidden md:flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full border ${
              isLineCountMatched
                ? 'bg-emerald-950/80 border-emerald-800 text-emerald-300'
                : 'bg-cyan-950/80 border-cyan-800 text-cyan-300'
            }`}>
              <CheckCircle2 className="w-3 h-3" />
              <span>{cues.length} Cues Verified</span>
            </div>
          )}
        </div>

        {/* Format Selector & Export Buttons */}
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto justify-end">
          
          <select
            value={exportFormat}
            onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
            className="bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 font-mono font-medium focus:outline-none focus:border-cyan-500"
          >
            <option value="srt">SubRip (.SRT)</option>
            <option value="vtt">WebVTT (.VTT)</option>
            <option value="lrc">Karaoke (.LRC)</option>
            <option value="json">JSON Timestamps</option>
          </select>

          <button
            id="btn-copy-srt"
            onClick={handleCopy}
            disabled={cues.length === 0}
            className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Copy to clipboard"
          >
            {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
          </button>

          <button
            id="btn-download-srt"
            onClick={handleDownload}
            disabled={cues.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-zinc-950 font-bold text-xs shadow-md shadow-cyan-500/20 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Download .{exportFormat.toUpperCase()}</span>
          </button>

        </div>

      </div>

      {/* Main Tab Area */}
      {activeTab === 'stage' ? (
        /* Visualizer & Animated Subtitle Stage */
        <div className="relative min-h-[220px] rounded-2xl bg-zinc-950 border border-zinc-800/80 p-6 flex flex-col items-center justify-center text-center overflow-hidden">
          
          {/* Subtle glowing animated backdrop */}
          <div className="absolute inset-0 bg-gradient-to-t from-cyan-950/20 via-transparent to-transparent pointer-events-none" />
          <div className="absolute top-3 left-3 flex items-center gap-1.5 text-[10px] uppercase font-mono tracking-wider text-zinc-600">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse"></span>
            <span>Live Subtitle Render</span>
          </div>

          {activeCue ? (
            <div className="space-y-4 max-w-xl z-10 animate-in fade-in duration-150">
              <span className="text-[11px] font-mono font-bold px-2 py-0.5 rounded-md bg-cyan-950 text-cyan-400 border border-cyan-800">
                Cue #{activeCue.index} • {formatDisplayTime(activeCue.startTime)} - {formatDisplayTime(activeCue.endTime)}
              </span>

              {/* Word by word karaoke highlight or Line highlight */}
              {syncMode === 'word' && activeCue.words && activeCue.words.length > 0 ? (
                <div className="text-xl sm:text-2xl font-bold flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
                  {activeCue.words.map((w, wIdx) => {
                    const isWordActive = currentTime >= w.startTime && currentTime <= w.endTime;
                    const isWordPast = currentTime > w.endTime;
                    return (
                      <span
                        key={wIdx}
                        className={`transition-all duration-100 ${
                          isWordActive
                            ? 'text-cyan-400 scale-110 drop-shadow-[0_0_12px_rgba(6,182,212,0.8)]'
                            : isWordPast
                            ? 'text-zinc-200'
                            : 'text-zinc-500'
                        }`}
                      >
                        {w.word}
                      </span>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xl sm:text-2xl font-bold text-white tracking-wide drop-shadow-md leading-relaxed">
                  &ldquo;{activeCue.text}&rdquo;
                </p>
              )}
            </div>
          ) : (
            <div className="text-zinc-500 text-xs sm:text-sm z-10 flex flex-col items-center gap-2">
              <FileText className="w-8 h-8 text-zinc-700 stroke-1" />
              <p>Play audio or scrub to preview synchronized subtitles</p>
              {cues.length > 0 && (
                <span className="text-[11px] text-zinc-600 font-mono">
                  Next cue starts at {formatDisplayTime(cues[0]?.startTime || 0)}
                </span>
              )}
            </div>
          )}

        </div>
      ) : (
        /* Raw SRT / Subtitle Code Viewer */
        <div className="relative rounded-2xl bg-zinc-950 border border-zinc-800 overflow-hidden">
          <div className="p-2.5 bg-zinc-900/60 border-b border-zinc-800 flex items-center justify-between text-xs text-zinc-400">
            <span className="font-mono">{audioName || 'lyrics'}.{exportFormat}</span>
            <span className="font-mono">{cues.length} blocks generated</span>
          </div>

          <pre className="p-4 text-xs font-mono text-cyan-300 overflow-x-auto max-h-[260px] leading-relaxed select-all">
            {outputContent || '// No subtitles generated yet.'}
          </pre>
        </div>
      )}

    </div>
  );
};
