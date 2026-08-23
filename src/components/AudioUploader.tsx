import React, { useRef } from 'react';
import { UploadCloud, Music, Sparkles, Check, AlertCircle, FileAudio } from 'lucide-react';
import { AudioTrackInfo } from '../types';
import { formatDisplayTime } from '../utils/srt';

interface AudioUploaderProps {
  audioInfo: AudioTrackInfo | null;
  onAudioSelected: (file: File) => void;
  onLoadDemoSong: () => void;
  isLoadingDemo: boolean;
}

export const AudioUploader: React.FC<AudioUploaderProps> = ({
  audioInfo,
  onAudioSelected,
  onLoadDemoSong,
  isLoadingDemo,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      onAudioSelected(file);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      onAudioSelected(e.dataTransfer.files[0]);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  return (
    <div id="audio-uploader-card" className="rounded-2xl bg-zinc-900/60 border border-zinc-800 p-4 transition-all">
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,.wav,.mp3,.ogg,.m4a,.flac"
        onChange={handleFileChange}
        className="hidden"
        id="audio-file-input"
      />

      {!audioInfo ? (
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onClick={() => fileInputRef.current?.click()}
          className="border-2 border-dashed border-zinc-700 hover:border-cyan-500/70 bg-zinc-950/40 hover:bg-cyan-950/10 rounded-xl p-5 text-center cursor-pointer transition-all flex flex-col items-center justify-center gap-2.5 group"
        >
          <div className="w-12 h-12 rounded-full bg-zinc-800 group-hover:bg-cyan-500/20 text-zinc-400 group-hover:text-cyan-400 flex items-center justify-center transition-colors">
            <UploadCloud className="w-6 h-6" />
          </div>
          <div>
            <p className="text-sm font-semibold text-zinc-200 group-hover:text-cyan-300 transition-colors">
              Drop your WAV or audio file here, or browse
            </p>
            <p className="text-xs text-zinc-500 mt-0.5">
              Supports .wav, .mp3, .ogg, .m4a, .flac (any sample rate)
            </p>
          </div>

          <div className="flex items-center gap-2 mt-1">
            <span className="text-[11px] text-zinc-400">or try without a file:</span>
            <button
              id="btn-load-demo-inline"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onLoadDemoSong();
              }}
              disabled={isLoadingDemo}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-cyan-400 border border-zinc-700 transition-colors"
            >
              <Sparkles className="w-3 h-3" />
              {isLoadingDemo ? 'Generating demo audio...' : 'Generate Demo Song'}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 bg-zinc-950/50 rounded-xl p-3.5 border border-zinc-800/80">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 flex items-center justify-center shrink-0">
              <FileAudio className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium text-zinc-200 truncate max-w-[220px] md:max-w-xs" title={audioInfo.name}>
                  {audioInfo.name}
                </p>
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-400 border border-emerald-800">
                  <Check className="w-2.5 h-2.5" /> Ready
                </span>
              </div>
              <p className="text-xs text-zinc-400 mt-0.5">
                Duration: <span className="font-mono text-zinc-300 font-semibold">{formatDisplayTime(audioInfo.duration)}</span> ({audioInfo.duration.toFixed(1)}s)
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 self-end sm:self-center">
            <button
              id="btn-replace-audio"
              onClick={() => fileInputRef.current?.click()}
              className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white border border-zinc-700 font-medium transition-colors"
            >
              Replace WAV
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
