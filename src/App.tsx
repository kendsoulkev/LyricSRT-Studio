import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Header } from './components/Header';
import { AudioUploader } from './components/AudioUploader';
import { LyricsInputPanel } from './components/LyricsInputPanel';
import { WaveformTimeline } from './components/WaveformTimeline';
import { AudioPlayerControls } from './components/AudioPlayerControls';
import { SubtitleTableEditor } from './components/SubtitleTableEditor';
import { SrtPreviewExport } from './components/SrtPreviewExport';
import { TapSyncModal } from './components/TapSyncModal';
import { AlignmentProgressModal } from './components/AlignmentProgressModal';
import { AudioTrackInfo, SubtitleCue, SyncMode, FirstLineAnchor } from './types';
import { SAMPLE_LYRICS_PRESETS } from './data/sampleLyrics';
import { prepareAudioForAi, extractWaveformPeaks, generateDemoSong, alignLyricsToVocalSegments, AudioAnalysisResult } from './utils/audio';
import { AlertCircle, CheckCircle2, Music2, Sparkles, HelpCircle } from 'lucide-react';

export default function App() {
  // 22-Line default lyric text matching the user's prompt
  const [lyricsText, setLyricsText] = useState<string>(SAMPLE_LYRICS_PRESETS[0].text);
  const [syncMode, setSyncMode] = useState<SyncMode>('line');
  const [cleanEmptyLines, setCleanEmptyLines] = useState<boolean>(true);

  // Audio State
  const [audioInfo, setAudioInfo] = useState<AudioTrackInfo | null>(null);
  const [lastAnalysis, setLastAnalysis] = useState<AudioAnalysisResult | null>(null);
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

  // Guided Alignment & First-Line Anchor State
  const [initialAlignmentDone, setInitialAlignmentDone] = useState<boolean>(false);
  const [firstLineManuallySet, setFirstLineManuallySet] = useState<boolean>(false);
  const [firstLineAnchor, setFirstLineAnchor] = useState<FirstLineAnchor | null>(null);
  const [activeModalAnchor, setActiveModalAnchor] = useState<FirstLineAnchor | null>(null);

  // Progress Modal State
  const [isProgressModalOpen, setIsProgressModalOpen] = useState<boolean>(false);
  const [progressStep, setProgressStep] = useState<number>(1);
  const [progressText, setProgressText] = useState<string>('Initializing audio engine...');
  const [progressPercent, setProgressPercent] = useState<number>(10);
  const [alignmentError, setAlignmentError] = useState<string | null>(null);

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

  // Instant Vocal Energy Alignment (Client-side / Fallback)
  const handleInstantVocalSync = () => {
    if (!audioInfo?.duration) return;
    if (parsedLines.length === 0) return;

    const analysis = lastAnalysis || {
      duration: audioInfo.duration,
      sampleRate: 44100,
      numberOfChannels: 2,
      vocalSegments: [],
      firstVocalOnset: 1.5,
      lastVocalOffset: Math.max(2, audioInfo.duration - 1.5),
      averagePhraseDuration: 3.2,
    };

    const syncedCues = alignLyricsToVocalSegments(parsedLines, analysis, audioInfo.duration, syncMode);
    setCues(syncedCues);
    setInitialAlignmentDone(true);
    setIsProgressModalOpen(false);
    setSuccessToast(`Applied instant vocal sync across ${syncedCues.length} lines!`);
    setTimeout(() => setSuccessToast(null), 3000);
  };

  // Standard AI Auto-Alignment
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
      setAlignmentError(null);
      setErrorMessage(null);
      setActiveModalAnchor(null);
      setIsProgressModalOpen(true);
      setProgressStep(1);
      setProgressText("Reading & decoding WAV audio buffer...");
      setProgressPercent(15);

      // Downsample to 16kHz mono WAV base64 for fast transfer & run vocal activity analysis
      const prep = await prepareAudioForAi(audioInfo.blob, (status, pct) => {
        setProgressText(status);
        setProgressPercent(pct);
        if (pct >= 35) setProgressStep(2);
      });

      setLastAnalysis(prep.analysis);
      setProgressStep(3);
      setProgressText(`Connecting to AI synchronizer (${parsedLines.length} lines)...`);
      setProgressPercent(70);

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
          analysis: prep.analysis,
        }),
      });

      setProgressStep(4);
      setProgressText("Validating timestamp boundaries & verbatim lines...");
      setProgressPercent(95);

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || "Failed to align audio and lyrics.");
      }

      setCues(data.items);
      setInitialAlignmentDone(true);
      setFirstLineManuallySet(false);
      setFirstLineAnchor(null);
      setProgressPercent(100);

      setTimeout(() => {
        setIsProgressModalOpen(false);
        if (data.source === 'vocal_energy' || data.warning) {
          setSuccessToast(`Aligned ${data.items.length} lines using acoustic vocal onset detection!`);
        } else {
          setSuccessToast(`Successfully aligned all ${data.items.length} lines with Gemini AI!`);
        }
        setTimeout(() => setSuccessToast(null), 4000);
      }, 500);
    } catch (err: any) {
      console.error("Auto align error:", err);
      setAlignmentError(err.message || "An error occurred during AI alignment.");
      
      // Fallback: create vocal segment distributed cues so the user is never blocked
      if (audioInfo?.duration) {
        const fallbackAnalysis = lastAnalysis || {
          duration: audioInfo.duration,
          sampleRate: 44100,
          numberOfChannels: 2,
          vocalSegments: [],
          firstVocalOnset: 1.5,
          lastVocalOffset: Math.max(2, audioInfo.duration - 1.5),
          averagePhraseDuration: 3.2,
        };
        const fallbackCues = alignLyricsToVocalSegments(parsedLines, fallbackAnalysis, audioInfo.duration, syncMode);
        setCues(fallbackCues);
        setInitialAlignmentDone(true);
      }
    } finally {
      setIsAligning(false);
    }
  };

  // Guided AI Auto-Alignment with Manual First-Line Anchor
  const handleAutoAlignWithAnchor = async () => {
    if (!audioInfo?.blob) {
      setErrorMessage("Please upload a WAV audio file or load the demo track first.");
      return;
    }

    if (parsedLines.length < 2) {
      setErrorMessage("Please enter at least 2 lines of lyric text to use Line 1 guided alignment.");
      return;
    }

    if (cues.length === 0) {
      setErrorMessage("Please perform initial AI alignment first before using Line 1 as a guide.");
      return;
    }

    const anchorToUse: FirstLineAnchor = firstLineAnchor || {
      startTime: cues[0].startTime,
      endTime: cues[0].endTime,
      text: cues[0].text,
      words: cues[0].words,
      isManual: true,
    };

    try {
      setIsAligning(true);
      setAlignmentError(null);
      setErrorMessage(null);
      setActiveModalAnchor(anchorToUse);
      setIsProgressModalOpen(true);
      setProgressStep(1);
      setProgressText(`Preparing audio with Line 1 anchor fixed at [${anchorToUse.startTime.toFixed(2)}s → ${anchorToUse.endTime.toFixed(2)}s]...`);
      setProgressPercent(15);

      const prep = await prepareAudioForAi(audioInfo.blob, (status, pct) => {
        setProgressText(status);
        setProgressPercent(pct);
        if (pct >= 35) setProgressStep(2);
      });

      setLastAnalysis(prep.analysis);
      setProgressStep(3);
      setProgressText(`AI analyzing audio after ${anchorToUse.endTime.toFixed(2)}s for lines 2–${parsedLines.length}...`);
      setProgressPercent(70);

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
          analysis: prep.analysis,
          firstLineAnchor: anchorToUse,
        }),
      });

      setProgressStep(4);
      setProgressText("Enforcing Line 1 lock & sequencing remaining cues...");
      setProgressPercent(95);

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || "Failed to align remaining lyrics with Line 1 guide.");
      }

      setCues(data.items);
      setInitialAlignmentDone(true);
      setFirstLineManuallySet(true);
      setFirstLineAnchor(anchorToUse);
      setProgressPercent(100);

      setTimeout(() => {
        setIsProgressModalOpen(false);
        setSuccessToast(`Successfully re-aligned lines 2–${data.items.length} guided by Line 1 [${anchorToUse.startTime.toFixed(2)}s - ${anchorToUse.endTime.toFixed(2)}s]!`);
        setTimeout(() => setSuccessToast(null), 4500);
      }, 500);
    } catch (err: any) {
      console.error("Auto align with anchor error:", err);
      setAlignmentError(err.message || "An error occurred during guided AI alignment.");
    } finally {
      setIsAligning(false);
    }
  };

  // Lock or toggle Line 1 Anchor manually
  const handleToggleLockLine1Anchor = () => {
    if (cues.length === 0) return;
    const line1 = cues[0];
    const newAnchor: FirstLineAnchor = {
      startTime: line1.startTime,
      endTime: line1.endTime,
      text: line1.text,
      words: line1.words,
      isManual: true,
    };
    setFirstLineManuallySet(true);
    setFirstLineAnchor(newAnchor);
    setSuccessToast(`Locked Line 1 as Anchor Guide (${line1.startTime.toFixed(2)}s - ${line1.endTime.toFixed(2)}s)`);
    setTimeout(() => setSuccessToast(null), 3000);
  };

  // Update specific cue in table
  const handleUpdateCue = (index: number, updated: Partial<SubtitleCue>) => {
    setCues((prev) => {
      const next = [...prev];
      if (next[index]) {
        next[index] = { ...next[index], ...updated };
        // If line 1 was updated by user, mark it as manual anchor
        if (index === 0) {
          setFirstLineManuallySet(true);
          setFirstLineAnchor({
            startTime: next[0].startTime,
            endTime: next[0].endTime,
            text: next[0].text,
            words: next[0].words,
            isManual: true,
          });
        }
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
    const newTime = +currentTime.toFixed(3);
    handleUpdateCue(index, {
      [type === 'start' ? 'startTime' : 'endTime']: newTime,
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

  // Acoustic snapping to detected vocal segments
  const handleSnapToAcousticPeaks = () => {
    if (!audioInfo?.analysis?.vocalSegments || audioInfo.analysis.vocalSegments.length === 0) {
      setErrorMessage("No acoustic vocal segments detected in the audio file yet.");
      return;
    }

    const segments = audioInfo.analysis.vocalSegments;
    setCues((prev) =>
      prev.map((c) => {
        let start = c.startTime;
        let end = c.endTime;

        const closestStart = segments.find((s) => Math.abs(s.startTime - c.startTime) < 0.45);
        if (closestStart) start = closestStart.startTime;

        const closestEnd = segments.find((s) => Math.abs(s.endTime - c.endTime) < 0.45);
        if (closestEnd) end = closestEnd.endTime;

        if (end <= start) end = +(start + 1.8).toFixed(3);

        return {
          ...c,
          startTime: +start.toFixed(3),
          endTime: +end.toFixed(3),
        };
      })
    );
    setSuccessToast("Snapped subtitle boundaries to acoustic vocal onsets!");
    setTimeout(() => setSuccessToast(null), 2500);
  };

  // Clean sequential overlaps
  const handleRemoveOverlaps = () => {
    setCues((prev) => {
      let lastEnd = 0;
      return prev.map((c) => {
        let start = Math.max(c.startTime, lastEnd > 0 ? lastEnd + 0.05 : 0);
        let end = Math.max(c.endTime, start + 0.5);
        lastEnd = end;
        return {
          ...c,
          startTime: +start.toFixed(3),
          endTime: +end.toFixed(3),
        };
      });
    });
    setSuccessToast("Fixed and formatted all subtitle overlaps!");
    setTimeout(() => setSuccessToast(null), 2500);
  };

  // Programmatic Forced Alignment for Word Boundaries
  const handleForcedAlignWords = async () => {
    if (!audioInfo?.blob) {
      setErrorMessage("Please upload an audio file or load the demo track first.");
      return;
    }
    if (cues.length === 0) {
      setErrorMessage("Please align lines first before forced-aligning words.");
      return;
    }

    try {
      setSuccessToast("Calculating acoustic waveform forced alignment...");
      const prep = await prepareAudioForAi(audioInfo.blob);
      const res = await fetch("/api/forced-align-words", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioBase64: prep.base64,
          linesWithTiming: cues,
        }),
      });

      const data = await res.json();
      if (res.ok && data.success && Array.isArray(data.items)) {
        setCues(data.items);
        setSuccessToast(`Acoustically force-aligned words across ${data.items.length} cues!`);
        setTimeout(() => setSuccessToast(null), 3000);
      } else {
        throw new Error(data.error || "Forced alignment failed");
      }
    } catch (err: any) {
      console.error("Forced alignment error:", err);
      setErrorMessage("Forced alignment error: " + err.message);
    }
  };

  // Reset workspace
  const handleReset = () => {
    setCues([]);
    setAudioInfo(null);
    setCurrentTime(0);
    setIsPlaying(false);
    setInitialAlignmentDone(false);
    setFirstLineManuallySet(false);
    setFirstLineAnchor(null);
    setActiveModalAnchor(null);
    setLyricsText(SAMPLE_LYRICS_PRESETS[0].text);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
    }
    setSuccessToast("Workspace reset to initial state");
    setTimeout(() => setSuccessToast(null), 2500);
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
              onInstantAcousticSync={handleInstantVocalSync}
              onStartTapSync={() => setIsTapSyncOpen(true)}
              isAligning={isAligning}
              audioLoaded={!!audioInfo}
              cleanEmptyLines={cleanEmptyLines}
              onToggleCleanEmptyLines={() => setCleanEmptyLines(!cleanEmptyLines)}
              initialAlignmentDone={initialAlignmentDone}
              firstLineManuallySet={firstLineManuallySet}
              firstLineAnchor={firstLineAnchor}
              onAutoAlignWithAnchor={handleAutoAlignWithAnchor}
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
              initialAlignmentDone={initialAlignmentDone}
              firstLineManuallySet={firstLineManuallySet}
              firstLineAnchor={firstLineAnchor}
              isAligning={isAligning}
              onUpdateCue={handleUpdateCue}
              onPlayCue={handlePlayCue}
              onSetCueToCurrentTime={handleSetCueToCurrentTime}
              onShiftAllTimestamps={handleShiftAllTimestamps}
              onSnapToAcousticPeaks={handleSnapToAcousticPeaks}
              onRemoveOverlaps={handleRemoveOverlaps}
              onForcedAlignWords={handleForcedAlignWords}
              onAutoAlignWithAnchor={handleAutoAlignWithAnchor}
              onToggleLockLine1Anchor={handleToggleLockLine1Anchor}
            />

          </div>

        </div>

      </main>

      {/* AI Alignment Progress & Diagnostic Modal */}
      <AlignmentProgressModal
        isOpen={isProgressModalOpen}
        step={progressStep}
        statusText={progressText}
        percent={progressPercent}
        lineCount={lineCount}
        audioDuration={audioInfo?.duration || 0}
        error={alignmentError}
        anchorInfo={activeModalAnchor}
        onClose={() => setIsProgressModalOpen(false)}
        onUseFallbackVocalSync={handleInstantVocalSync}
      />

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
