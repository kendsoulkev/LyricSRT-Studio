import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Header } from './components/Header';
import { AudioUploader } from './components/AudioUploader';
import { LyricsInputPanel } from './components/LyricsInputPanel';
import { WaveformTimeline } from './components/WaveformTimeline';
import { AudioPlayerControls } from './components/AudioPlayerControls';
import { SubtitleTableEditor } from './components/SubtitleTableEditor';
import { SrtPreviewExport } from './components/SrtPreviewExport';
import { TapSyncModal } from './components/TapSyncModal';
import { AudioTrackInfo, SubtitleCue, SyncMode } from './types';
import { SAMPLE_LYRICS_PRESETS } from './data/sampleLyrics';
import { prepareAudioForAi, extractWaveformPeaks, generateDemoSong } from './utils/audio';
import { AlertCircle, CheckCircle2, Music2, Sparkles, HelpCircle } from 'lucide-react';

export default function App() {
  // 22-Line default lyric text matching the user's prompt
  const [lyricsText, setLyricsText] = useState<string>(SAMPLE_LYRICS_PRESETS[0].text);
  const [syncMode, setSyncMode] = useState<SyncMode>('line');
  const [cleanEmptyLines, setCleanEmptyLines] = useState<boolean>(true);

  // Audio State
  const [audioInfo, setAudioInfo] = useState<AudioTrackInfo | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [playbackRate, setPlaybackRate] = useState<number>(1.0);
  const [volume, setVolume] = useState<number>(0.85);
  const [isMuted, setIsMuted] = useState<boolean>(false);

  // Subtitle / Cue State
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [isAligning, setIsAligning] = useState<boolean>(false);
  const [isTapSyncOpen, setIsTapSyncOpen] = useState<boolean>(false);
  const [isLoadingDemo, setIsLoadingDemo] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successToast, setSuccessToast] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Parse lines based on cleanEmptyLines setting
  const parsedLines = useMemo(() => {
    const raw = lyricsText.split('\n');
    if (cleanEmptyLines) {
      return raw.map((l) => l.trim()).filter((l) => l.length > 0);
    }
    return raw;
  }, [lyricsText, cleanEmptyLines]);

  const lineCount = parsedLines.length;

  // Identify active cue from currentTime
  const activeCueIndex = useMemo(() => {
    if (cues.length === 0) return -1;
    return cues.findIndex(
      (c) => currentTime >= c.startTime && currentTime <= c.endTime
    );
  }, [cues, currentTime]);

  // Sync HTMLAudioElement state
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
    };

    const handleEnded = () => {
      setIsPlaying(false);
    };

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('ended', handleEnded);

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('ended', handleEnded);
    };
  }, [audioInfo]);

  // Audio Controls
  const handleTogglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      audio.play().then(() => {
        setIsPlaying(true);
      }).catch((err) => {
        console.warn("Playback error:", err);
      });
    }
  }, [isPlaying]);

  const handleSeek = useCallback((time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const clamped = Math.max(0, Math.min(audioInfo?.duration || 1000, time));
    audio.currentTime = clamped;
    setCurrentTime(clamped);
  }, [audioInfo]);

  const handleJump = useCallback((seconds: number) => {
    handleSeek(currentTime + seconds);
  }, [currentTime, handleSeek]);

  const handleChangePlaybackRate = useCallback((rate: number) => {
    setPlaybackRate(rate);
    if (audioRef.current) {
      audioRef.current.playbackRate = rate;
    }
  }, []);

  const handleChangeVolume = useCallback((vol: number) => {
    setVolume(vol);
    setIsMuted(vol === 0);
    if (audioRef.current) {
      audioRef.current.volume = vol;
    }
  }, []);

  const handleToggleMute = useCallback(() => {
    if (audioRef.current) {
      const newMute = !isMuted;
      setIsMuted(newMute);
      audioRef.current.muted = newMute;
    }
  }, [isMuted]);

  // Handle Audio File Selection
  const handleAudioSelected = async (file: File) => {
    try {
      setErrorMessage(null);
      const url = URL.createObjectURL(file);
      const peaks = await extractWaveformPeaks(file);
      
      // Determine audio duration
      const tempAudio = new Audio(url);
      tempAudio.onloadedmetadata = () => {
        setAudioInfo({
          name: file.name,
          duration: tempAudio.duration,
          url,
          blob: file,
          peaks,
        });
        setCurrentTime(0);
        setIsPlaying(false);
        setSuccessToast(`Loaded audio file: ${file.name} (${tempAudio.duration.toFixed(1)}s)`);
        setTimeout(() => setSuccessToast(null), 3000);
      };
    } catch (err: any) {
      console.error("Error loading audio:", err);
      setErrorMessage("Could not parse audio file. Please ensure it is a valid WAV/MP3/OGG file.");
    }
  };

  // Generate synthetic Demo Song in real-time
  const handleLoadDemoSong = async () => {
    try {
      setIsLoadingDemo(true);
      setErrorMessage(null);
      
      const lines = parsedLines.length > 0 ? parsedLines : SAMPLE_LYRICS_PRESETS[0].text.split('\n').filter(Boolean);
      const result = await generateDemoSong(lines);
      const peaks = await extractWaveformPeaks(result.blob);

      setAudioInfo({
        name: `Midnight Echoes Demo (${lines.length} Lines).wav`,
        duration: result.duration,
        url: result.url,
        blob: result.blob,
        peaks,
      });

      setCurrentTime(0);
      setIsPlaying(false);
      setSuccessToast(`Generated 22-line demo song (${result.duration.toFixed(1)}s). Ready to sync!`);
      setTimeout(() => setSuccessToast(null), 4000);
    } catch (err: any) {
      console.error("Demo song generation error:", err);
      setErrorMessage("Could not synthesize demo audio: " + err.message);
    } finally {
      setIsLoadingDemo(false);
    }
  };

  // AI Auto-Alignment
  const handleAutoAlign = async () => {
    if (!audioInfo?.blob) {
      setErrorMessage("Please upload a WAV audio file or load the demo track first.");
      return;
    }

    if (parsedLines.length === 0) {
      setErrorMessage("Please enter at least one line of lyric text.");
      return;
    }

    try {
      setIsAligning(true);
      setErrorMessage(null);

      // Downsample to 16kHz mono WAV base64 for fast transfer
      const prep = await prepareAudioForAi(audioInfo.blob);

      const response = await fetch("/api/align-lyrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioBase64: prep.base64,
          mimeType: prep.mimeType,
          lyricsText,
          lines: parsedLines,
          mode: syncMode,
          audioDuration: audioInfo.duration,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || "Failed to align audio and lyrics.");
      }

      setCues(data.items);
      setSuccessToast(`Successfully aligned all ${data.items.length} lines with Gemini AI!`);
      setTimeout(() => setSuccessToast(null), 4000);
    } catch (err: any) {
      console.error("Auto align error:", err);
      setErrorMessage(err.message || "An error occurred during AI alignment. You can also use Vibe Tap-to-Sync!");
      
      // Fallback: create evenly distributed cues so the user is never blocked
      const fallbackCues: SubtitleCue[] = parsedLines.map((line, i) => {
        const step = audioInfo.duration / Math.max(parsedLines.length, 1);
        const start = i * step;
        const end = (i + 1) * step;
        return {
          id: `fallback-${i + 1}`,
          index: i + 1,
          text: line,
          startTime: +start.toFixed(3),
          endTime: +end.toFixed(3),
        };
      });
      setCues(fallbackCues);
    } finally {
      setIsAligning(false);
    }
  };

  // Update specific cue in table
  const handleUpdateCue = (index: number, updated: Partial<SubtitleCue>) => {
    setCues((prev) => {
      const next = [...prev];
      if (next[index]) {
        next[index] = { ...next[index], ...updated };
      }
      return next;
    });
  };

  // Play specific cue preview snippet
  const handlePlayCue = (cue: SubtitleCue) => {
    handleSeek(cue.startTime);
    if (!isPlaying && audioRef.current) {
      audioRef.current.play().then(() => setIsPlaying(true));
    }
  };

  // Set cue in/out point to current playhead
  const handleSetCueToCurrentTime = (index: number, type: 'start' | 'end') => {
    handleUpdateCue(index, {
      [type === 'start' ? 'startTime' : 'endTime']: +currentTime.toFixed(3),
    });
  };

  // Batch shift all timestamps
  const handleShiftAllTimestamps = (offsetSeconds: number) => {
    setCues((prev) =>
      prev.map((c) => ({
        ...c,
        startTime: Math.max(0, +(c.startTime + offsetSeconds).toFixed(3)),
        endTime: Math.max(0, +(c.endTime + offsetSeconds).toFixed(3)),
        words: c.words?.map((w) => ({
          ...w,
          startTime: Math.max(0, +(w.startTime + offsetSeconds).toFixed(3)),
          endTime: Math.max(0, +(w.endTime + offsetSeconds).toFixed(3)),
        })),
      }))
    );
    setSuccessToast(`Shifted all ${cues.length} cues by ${offsetSeconds > 0 ? '+' : ''}${offsetSeconds}s`);
    setTimeout(() => setSuccessToast(null), 2500);
  };

  // Reset workspace
  const handleReset = () => {
    if (window.confirm("Reset all lyrics, audio, and subtitle timestamps?")) {
      setCues([]);
      setAudioInfo(null);
      setCurrentTime(0);
      setIsPlaying(false);
      setLyricsText(SAMPLE_LYRICS_PRESETS[0].text);
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
      }
    }
  };

  // Global Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept if user is typing in textarea or input
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        handleTogglePlay();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        handleJump(-5);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        handleJump(5);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleTogglePlay, handleJump]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col selection:bg-cyan-500 selection:text-zinc-950 font-sans">
      
      {/* Hidden Native Audio Element */}
      {audioInfo?.url && (
        <audio
          ref={audioRef}
          src={audioInfo.url}
          preload="auto"
          className="hidden"
        />
      )}

      {/* Global Header */}
      <Header
        lineCount={lineCount}
        cueCount={cues.length}
        syncMode={syncMode}
        onSyncModeChange={setSyncMode}
        audioLoaded={!!audioInfo}
        audioDuration={audioInfo?.duration || 0}
        isAligning={isAligning}
        onReset={handleReset}
        onLoadDemo={handleLoadDemoSong}
      />

      {/* Toast Notifications */}
      {successToast && (
        <div className="fixed top-16 right-4 z-40 bg-emerald-950 border border-emerald-800 text-emerald-300 text-xs px-4 py-2.5 rounded-xl shadow-xl flex items-center gap-2 animate-in fade-in slide-in-from-top-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          <span>{successToast}</span>
        </div>
      )}

      {errorMessage && (
        <div className="fixed top-16 right-4 z-40 bg-rose-950 border border-rose-800 text-rose-300 text-xs px-4 py-2.5 rounded-xl shadow-xl flex items-center gap-2 animate-in fade-in slide-in-from-top-2">
          <AlertCircle className="w-4 h-4 text-rose-400" />
          <span>{errorMessage}</span>
          <button onClick={() => setErrorMessage(null)} className="ml-2 text-rose-400 font-bold">×</button>
        </div>
      )}

      {/* Main Workspace Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 space-y-6">
        
        {/* Top Section: Audio Uploader */}
        <AudioUploader
          audioInfo={audioInfo}
          onAudioSelected={handleAudioSelected}
          onLoadDemoSong={handleLoadDemoSong}
          isLoadingDemo={isLoadingDemo}
        />

        {/* Middle Section: 2-Column Responsive Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* Left Column: Lyrics Editor & Sync Triggers (5 cols) */}
          <div className="lg:col-span-5 flex flex-col space-y-4">
            <LyricsInputPanel
              lyricsText={lyricsText}
              onLyricsChange={setLyricsText}
              syncMode={syncMode}
              onSyncModeChange={setSyncMode}
              onAutoAlign={handleAutoAlign}
              onStartTapSync={() => setIsTapSyncOpen(true)}
              isAligning={isAligning}
              audioLoaded={!!audioInfo}
              cleanEmptyLines={cleanEmptyLines}
              onToggleCleanEmptyLines={() => setCleanEmptyLines(!cleanEmptyLines)}
            />

            {/* Quick How It Works card */}
            <div className="p-4 rounded-2xl bg-zinc-900/40 border border-zinc-800/60 text-xs text-zinc-400 space-y-2">
              <div className="flex items-center gap-1.5 font-semibold text-zinc-200">
                <HelpCircle className="w-3.5 h-3.5 text-cyan-400" />
                <span>Exact Line Count Guarantee</span>
              </div>
              <p className="leading-relaxed">
                If your text has <strong>{lineCount} lines</strong>, your SRT subtitle file will contain exactly <strong>{lineCount} synchronized subtitle cues</strong>.
              </p>
              <ul className="list-disc list-inside space-y-1 text-zinc-500 text-[11px]">
                <li><strong className="text-zinc-300">Line-by-Line:</strong> 1 SRT cue per line.</li>
                <li><strong className="text-zinc-300">Word-by-Word:</strong> Timestamps for every word.</li>
                <li><strong className="text-zinc-300">Vibe Tap:</strong> Tap Spacebar on beat to set cues manually.</li>
              </ul>
            </div>
          </div>

          {/* Right Column: Waveform, Player, Subtitle Editor & Live Preview (7 cols) */}
          <div className="lg:col-span-7 flex flex-col space-y-6">
            
            {/* Waveform Canvas */}
            <WaveformTimeline
              peaks={audioInfo?.peaks || []}
              currentTime={currentTime}
              duration={audioInfo?.duration || 0}
              cues={cues}
              activeCueIndex={activeCueIndex}
              onSeek={handleSeek}
              onSelectCue={(idx) => handleSeek(cues[idx]?.startTime || 0)}
            />

            {/* Audio Transport Player Controls */}
            <AudioPlayerControls
              isPlaying={isPlaying}
              onTogglePlay={handleTogglePlay}
              onJumpBack={() => handleJump(-5)}
              onJumpForward={() => handleJump(5)}
              currentTime={currentTime}
              duration={audioInfo?.duration || 0}
              playbackRate={playbackRate}
              onChangePlaybackRate={handleChangePlaybackRate}
              volume={volume}
              onChangeVolume={handleChangeVolume}
              isMuted={isMuted}
              onToggleMute={handleToggleMute}
              onSeek={handleSeek}
            />

            {/* Live Subtitle Stage & SRT Exporter */}
            <SrtPreviewExport
              cues={cues}
              syncMode={syncMode}
              currentTime={currentTime}
              activeCueIndex={activeCueIndex}
              expectedLineCount={lineCount}
              audioName={audioInfo?.name}
            />

            {/* Detailed Subtitle Table & Fine Tuner */}
            <SubtitleTableEditor
              cues={cues}
              activeCueIndex={activeCueIndex}
              syncMode={syncMode}
              currentTime={currentTime}
              onUpdateCue={handleUpdateCue}
              onPlayCue={handlePlayCue}
              onSetCueToCurrentTime={handleSetCueToCurrentTime}
              onShiftAllTimestamps={handleShiftAllTimestamps}
            />

          </div>

        </div>

      </main>

      {/* Vibe Tap-to-Sync Fullscreen Modal */}
      <TapSyncModal
        isOpen={isTapSyncOpen}
        onClose={() => setIsTapSyncOpen(false)}
        lines={parsedLines}
        currentTime={currentTime}
        duration={audioInfo?.duration || 0}
        isPlaying={isPlaying}
        syncMode={syncMode}
        onTogglePlay={handleTogglePlay}
        onSeek={handleSeek}
        onFinishTapSync={(newCues) => {
          setCues(newCues);
          setSuccessToast(`Saved ${newCues.length} tap-synced subtitle cues!`);
          setTimeout(() => setSuccessToast(null), 3000);
        }}
      />

      {/* Footer */}
      <footer className="border-t border-zinc-800/80 bg-zinc-950 py-4 px-6 text-center text-xs text-zinc-500">
        <p>LyricSRT Studio • Subtitle &amp; Lyrics Synchronization • Export SRT, VTT, and LRC with precision timestamps</p>
      </footer>

    </div>
  );
}
