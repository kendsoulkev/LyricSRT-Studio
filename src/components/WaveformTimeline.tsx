import React, { useRef, useEffect, useState, useCallback } from 'react';
import { SubtitleCue } from '../types';
import { formatDisplayTime } from '../utils/srt';
import { ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';

interface WaveformTimelineProps {
  peaks: number[];
  currentTime: number;
  duration: number;
  cues: SubtitleCue[];
  activeCueIndex: number;
  onSeek: (time: number) => void;
  onSelectCue: (index: number) => void;
  onUpdateCueTimes?: (index: number, startTime: number, endTime: number) => void;
}

export const WaveformTimeline: React.FC<WaveformTimelineProps> = ({
  peaks,
  currentTime,
  duration,
  cues,
  activeCueIndex,
  onSeek,
  onSelectCue,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(1);
  const [isHovering, setIsHovering] = useState(false);
  const [hoverTime, setHoverTime] = useState<number | null>(null);

  // Redraw waveform whenever peaks, currentTime, duration, zoom, or cues change
  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    // Clear
    ctx.clearRect(0, 0, width, height);

    // Background
    ctx.fillStyle = '#09090b';
    ctx.fillRect(0, 0, width, height);

    // Draw grid & time markers
    ctx.strokeStyle = '#27272a';
    ctx.lineWidth = 1;
    const timeStep = duration > 120 ? 10 : duration > 60 ? 5 : 2;
    ctx.font = '10px monospace';
    ctx.fillStyle = '#71717a';

    for (let t = 0; t <= duration; t += timeStep) {
      const x = (t / (duration || 1)) * width;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();

      ctx.fillText(`${t}s`, x + 3, 12);
    }

    // Draw Subtitle Cue Blocks
    if (cues && cues.length > 0 && duration > 0) {
      cues.forEach((cue, idx) => {
        const startX = (cue.startTime / duration) * width;
        const endX = (cue.endTime / duration) * width;
        const blockWidth = Math.max(endX - startX, 2);
        const isActive = idx === activeCueIndex;

        // Fill region
        ctx.fillStyle = isActive
          ? 'rgba(6, 182, 212, 0.28)'
          : idx % 2 === 0
          ? 'rgba(39, 39, 42, 0.45)'
          : 'rgba(24, 24, 27, 0.45)';
        ctx.fillRect(startX, 16, blockWidth, height - 16);

        // Border & top accent
        ctx.strokeStyle = isActive ? '#06b6d4' : '#3f3f46';
        ctx.lineWidth = isActive ? 2 : 1;
        ctx.strokeRect(startX, 16, blockWidth, height - 16);

        // Cue number pill in top left of block
        ctx.fillStyle = isActive ? '#06b6d4' : '#a1a1aa';
        ctx.font = 'bold 9px sans-serif';
        ctx.fillText(`#${cue.index}`, startX + 3, 27);

        // Truncated text preview
        if (blockWidth > 40) {
          ctx.fillStyle = isActive ? '#ffffff' : '#71717a';
          ctx.font = '9px sans-serif';
          const maxChars = Math.floor(blockWidth / 6);
          const snippet = cue.text.length > maxChars ? cue.text.slice(0, maxChars) + '..' : cue.text;
          ctx.fillText(snippet, startX + 3, height - 6);
        }
      });
    }

    // Draw Audio Amplitude Waveform Bars
    const data = peaks.length > 0 ? peaks : Array.from({ length: 150 }, () => 0.15);
    const barWidth = width / data.length;
    const centerY = height / 2 + 8;
    const maxBarHeight = (height - 30) / 2;

    data.forEach((val, i) => {
      const x = i * barWidth;
      const progressRatio = i / data.length;
      const barTime = progressRatio * duration;
      const isPast = barTime <= currentTime;

      const barHeight = Math.max(val * maxBarHeight, 2);

      ctx.fillStyle = isPast ? '#22d3ee' : '#52525b';

      // Rounded vertical bar
      ctx.beginPath();
      ctx.roundRect(x + 0.5, centerY - barHeight, Math.max(barWidth - 1, 1), barHeight * 2, 1);
      ctx.fill();
    });

    // Draw Current Playhead Line
    if (duration > 0) {
      const playheadX = (currentTime / duration) * width;
      
      // Glow
      ctx.shadowColor = '#06b6d4';
      ctx.shadowBlur = 8;
      
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, height);
      ctx.stroke();

      // Playhead handle triangle at top
      ctx.fillStyle = '#22d3ee';
      ctx.beginPath();
      ctx.moveTo(playheadX - 5, 0);
      ctx.lineTo(playheadX + 5, 0);
      ctx.lineTo(playheadX, 8);
      ctx.closePath();
      ctx.fill();

      ctx.shadowBlur = 0;
    }

    // Draw Hover Time Line
    if (isHovering && hoverTime !== null && duration > 0) {
      const hoverX = (hoverTime / duration) * width;
      ctx.strokeStyle = 'rgba(244, 244, 245, 0.4)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hoverX, 0);
      ctx.lineTo(hoverX, height);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [peaks, currentTime, duration, cues, activeCueIndex, isHovering, hoverTime]);

  // Handle ResizeObserver
  useEffect(() => {
    const handleResize = () => {
      if (containerRef.current && canvasRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        canvasRef.current.width = rect.width * (window.devicePixelRatio || 1);
        canvasRef.current.height = 100 * (window.devicePixelRatio || 1);
        drawWaveform();
      }
    };

    handleResize();
    const observer = new ResizeObserver(handleResize);
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    return () => observer.disconnect();
  }, [drawWaveform]);

  useEffect(() => {
    drawWaveform();
  }, [drawWaveform]);

  // Interaction handlers
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || duration <= 0) return;

    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, clickX / rect.width));
    const targetTime = ratio * duration;

    onSeek(targetTime);

    // If click fell inside a cue, highlight it
    const foundIdx = cues.findIndex(
      (c) => targetTime >= c.startTime && targetTime <= c.endTime
    );
    if (foundIdx !== -1) {
      onSelectCue(foundIdx);
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || duration <= 0) return;

    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, clickX / rect.width));
    setHoverTime(ratio * duration);
  };

  return (
    <div id="waveform-timeline-card" className="rounded-2xl bg-zinc-900/80 border border-zinc-800 p-3.5 space-y-2">
      
      {/* Header controls for waveform */}
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-zinc-300">Audio Timeline &amp; Subtitle Cues</span>
          {hoverTime !== null && isHovering && (
            <span className="text-[11px] font-mono text-cyan-400">
              Hover: {formatDisplayTime(hoverTime)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-zinc-400">
          <span className="text-[11px]">Click anywhere to seek</span>
        </div>
      </div>

      {/* Waveform Canvas */}
      <div
        ref={containerRef}
        className="relative w-full h-[100px] rounded-xl overflow-hidden cursor-crosshair border border-zinc-800"
        onMouseEnter={() => setIsHovering(true)}
        onMouseLeave={() => {
          setIsHovering(false);
          setHoverTime(null);
        }}
      >
        <canvas
          ref={canvasRef}
          onClick={handleCanvasClick}
          onMouseMove={handleMouseMove}
          className="w-full h-full block"
        />
      </div>

      {/* Legend & Cue Markers */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-400 pt-0.5">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded bg-cyan-500 inline-block"></span>
            <span>Active Cue Line</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded bg-zinc-700 inline-block"></span>
            <span>Synced Subtitle Span</span>
          </span>
        </div>

        <div className="flex items-center gap-2 font-mono text-zinc-300">
          <span>{formatDisplayTime(currentTime)}</span>
          <span className="text-zinc-600">/</span>
          <span>{formatDisplayTime(duration)}</span>
        </div>
      </div>

    </div>
  );
};
