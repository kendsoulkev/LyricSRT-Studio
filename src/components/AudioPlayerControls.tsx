import React from 'react';
import { Play, Pause, RotateCcw, RotateCw, Volume2, VolumeX, Gauge, Zap } from 'lucide-react';
import { formatDisplayTime } from '../utils/srt';

interface AudioPlayerControlsProps {
  isPlaying: boolean;
  onTogglePlay: () => void;
  onJumpBack: () => void;
  onJumpForward: () => void;
  currentTime: number;
  duration: number;
  playbackRate: number;
  onChangePlaybackRate: (rate: number) => void;
  volume: number;
  onChangeVolume: (volume: number) => void;
  isMuted: boolean;
  onToggleMute: () => void;
  onSeek: (time: number) => void;
}

export const AudioPlayerControls: React.FC<AudioPlayerControlsProps> = ({
  isPlaying,
  onTogglePlay,
  onJumpBack,
  onJumpForward,
  currentTime,
  duration,
  playbackRate,
  onChangePlaybackRate,
  volume,
  onChangeVolume,
  isMuted,
  onToggleMute,
  onSeek,
}) => {
  const playbackRates = [0.5, 0.75, 1.0, 1.25, 1.5];

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onSeek(parseFloat(e.target.value));
  };

  return (
    <div id="audio-player-controls" className="rounded-2xl bg-zinc-900/90 border border-zinc-800 p-4 space-y-3">
      
      {/* Time scrubber slider */}
      <div className="flex items-center gap-3">
        <span className="text-xs font-mono text-cyan-400 font-semibold w-12 text-right">
          {formatDisplayTime(currentTime)}
        </span>
        <input
          type="range"
          min="0"
          max={duration || 100}
          step="0.05"
          value={currentTime}
          onChange={handleSliderChange}
          className="flex-1 h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
        />
        <span className="text-xs font-mono text-zinc-400 w-12">
          {formatDisplayTime(duration)}
        </span>
      </div>

      {/* Control Buttons row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        
        {/* Playback speed selector */}
        <div className="flex items-center gap-1 bg-zinc-950 p-1 rounded-xl border border-zinc-800 text-xs">
          <Gauge className="w-3.5 h-3.5 text-zinc-500 ml-1.5 mr-0.5" />
          {playbackRates.map((rate) => (
            <button
              key={rate}
              onClick={() => onChangePlaybackRate(rate)}
              className={`px-2 py-0.5 rounded-lg font-mono font-medium transition-colors ${
                playbackRate === rate
                  ? 'bg-cyan-500 text-zinc-950 font-bold'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {rate}x
            </button>
          ))}
        </div>

        {/* Primary Transport Controls */}
        <div className="flex items-center gap-2">
          <button
            id="btn-jump-back-5"
            onClick={onJumpBack}
            className="p-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-colors"
            title="Jump back 5s [←]"
          >
            <RotateCcw className="w-4 h-4" />
          </button>

          <button
            id="btn-toggle-play"
            onClick={onTogglePlay}
            className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white flex items-center justify-center shadow-lg shadow-cyan-500/20 active:scale-95 transition-all"
            title={isPlaying ? "Pause [Space]" : "Play [Space]"}
          >
            {isPlaying ? (
              <Pause className="w-6 h-6 fill-current" />
            ) : (
              <Play className="w-6 h-6 fill-current ml-0.5" />
            )}
          </button>

          <button
            id="btn-jump-forward-5"
            onClick={onJumpForward}
            className="p-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-colors"
            title="Jump forward 5s [→]"
          >
            <RotateCw className="w-4 h-4" />
          </button>
        </div>

        {/* Volume controls & Hotkey helper */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <button
              id="btn-toggle-mute"
              onClick={onToggleMute}
              className="text-zinc-400 hover:text-zinc-200"
              title={isMuted ? "Unmute" : "Mute"}
            >
              {isMuted || volume === 0 ? (
                <VolumeX className="w-4 h-4 text-rose-400" />
              ) : (
                <Volume2 className="w-4 h-4" />
              )}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={isMuted ? 0 : volume}
              onChange={(e) => onChangeVolume(parseFloat(e.target.value))}
              className="w-16 sm:w-20 h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
            />
          </div>

          <div className="hidden lg:flex items-center gap-1.5 text-[11px] text-zinc-400 bg-zinc-950/80 px-2.5 py-1 rounded-lg border border-zinc-800">
            <Zap className="w-3 h-3 text-cyan-400" />
            <span><kbd className="px-1 py-0.5 bg-zinc-800 rounded font-mono text-zinc-300">Space</kbd> Play/Pause</span>
          </div>
        </div>

      </div>

    </div>
  );
};
