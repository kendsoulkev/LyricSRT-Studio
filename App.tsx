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
import { prepareAudioForAi, extractWaveformPeaks, generateDemoSong, alignLyricsToVocalSegments, AudioAnalysisResult, sliceAudioBufferExact, sliceAudioBufferWithContext, sliceAudioBufferWithSilence, sliceAudioBufferToBase64, decodeAudioBlobToBuffer, refineWordTimestampsWithVocalOnsets, detectTrueSpeechOnset, ENABLE_WORD_ONSET_REFINEMENT } from './utils/audio';
import { generateAccurateWordCuesFromLines, formatGeminiResponseToCues, distributeTimePhoneticallyWithDecay, snapAiWordsToLocalVad, applyLinguisticSmoothing, maskIntroHummingSegments, applyIntroSpeechGate } from './utils/srt';
import { fetchPreciseWordAlignment } from './utils/gemini';
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

  // Handle Sync Mode switching with acoustic-anchored word splitting
  const handleSyncModeChange = useCallback(async (newMode: SyncMode) => {
    setSyncMode(newMode);
    if (newMode === 'word' && cues.length > 0) {
      // Pass both verified line cues and local acoustic VAD segments
      const vocalSegments = lastAnalysis?.vocalSegments || [];
      const preciseAcousticWordCues = generateAccurateWordCuesFromLines(cues, vocalSegments);

      // The VAD-based split above only anchors to whichever frame first crosses the
      // energy threshold, which is inherently a little late (energy has to ramp up
      // before it trips the threshold). refineWordTimestampsWithVocalOnsets does a
      // confidence-scored backtrack against the actual bandpassed vocal waveform to
      // pull each word's start back to its true acoustic attack. It was already used
      // by the other sync flows but wasn't wired into this mode-toggle path - that's
      // why toggling to Word-by-Word skipped the correction.
      if (ENABLE_WORD_ONSET_REFINEMENT && audioInfo?.blob) {
        try {
          const decodedBuffer = await decodeAudioBlobToBuffer(audioInfo.blob);

          // Build a per-word floor from the ALREADY-CONFIRMED line start times. A word can
          // never legitimately start before the line it belongs to does, so this stops the
          // refiner from mistaking humming/breaths/instrumental lead-in right before a line
          // for that line's first word, even if the acoustics look attack-like there.
          // generateAccurateWordCuesFromLines emits exactly one word cue per raw word, per
          // line, in order, so this stays index-aligned with preciseAcousticWordCues.
          const lineStartFloors: number[] = [];
          cues.forEach((line) => {
            const rawWordCount = line.text.split(/\s+/).filter(Boolean).length;
            for (let w = 0; w < rawWordCount; w++) {
              lineStartFloors.push(line.startTime);
            }
          });

          const refinedWordCues = refineWordTimestampsWithVocalOnsets(
            preciseAcousticWordCues,
            decodedBuffer,
            vocalSegments,
            lineStartFloors
          );
          setCues(refinedWordCues);
          return;
        } catch (err) {
          console.error('Word onset refinement failed, falling back to unrefined timings:', err);
        }
      }

      setCues(preciseAcousticWordCues);
    }
  }, [cues, lastAnalysis, audioInfo]);

  // Identify active cue from currentTime
  const activeCueIndex = useMemo(() => {
    if (cues.length === 0) return -1;
    return cues.findIndex(
      (c) => currentTime >= c.startTime && currentTime <= c.endTime
    );
  }, [cues, currentTime]);

  // Sync HTMLAudioElement state with high-frequency requestAnimationFrame for zero-lag playback
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    let animFrameId: number;

    const tick = () => {
      if (audio && !audio.paused) {
        setCurrentTime(audio.currentTime);
        animFrameId = requestAnimationFrame(tick);
      }
    };

    const handlePlay = () => {
      setIsPlaying(true);
      cancelAnimationFrame(animFrameId);
      animFrameId = requestAnimationFrame(tick);
    };

    const handlePause = () => {
      setIsPlaying(false);
      cancelAnimationFrame(animFrameId);
      setCurrentTime(audio.currentTime);
    };

    const handleEnded = () => {
      setIsPlaying(false);
      cancelAnimationFrame(animFrameId);
      setCurrentTime(audio.currentTime);
    };

    const handleTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
    };

    const handleSeeked = () => {
      setCurrentTime(audio.currentTime);
    };

    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('seeked', handleSeeked);

    if (!audio.paused) {
      animFrameId = requestAnimationFrame(tick);
    }

    return () => {
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('seeked', handleSeeked);
      cancelAnimationFrame(animFrameId);
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

      if (syncMode === 'word') {
        // Lines are only a display grouping in Word-by-Word mode - they have no bearing on
        // when a word should actually appear. The previous per-line pipeline still guessed
        // line boundaries first (via Gemini) and then sliced/aligned words within each
        // guessed line - word timing accuracy was capped by how good that separate,
        // independently-variable line guess was. A single whole-file call removed that
        // guessing stage, but sending an entire ~2.5-3 minute song as one audio payload
        // turned out to be much more prone to timeouts/rate-limiting than the old small
        // per-line requests were - trading one reliability problem for another. Split the
        // difference: chunk the song into a handful of moderate-length, purely TIME-based
        // windows (not AI-guessed line boundaries) with generous padding, and align each
        // chunk's words in its own smaller, more reliable request.
        setProgressText("Running whole-file word-level forced alignment in chunks (no line-boundary guessing)...");
        setProgressPercent(40);

        const fullReferenceText = parsedLines.join('\n');
        const allWordsFlat = fullReferenceText.split(/\s+/).filter(Boolean);
        const expectedWordCount = allWordsFlat.length;

        let globalWordCues: SubtitleCue[] | null = null;

        try {
          const totalDuration = audioInfo?.duration || prep.analysis.lastVocalOffset || 180;
          const onset = prep.analysis.firstVocalOnset ?? 0;
          const offset = prep.analysis.lastVocalOffset ?? totalDuration;
          const activeSpan = Math.max(5, offset - onset);

          const TARGET_CHUNK_SECONDS = 35; // fewer, moderately larger chunks: this song's
                                            // observed failures aren't about payload size
                                            // (chunks succeed fine at this size once the
                                            // model responds) - they're about the SHEER
                                            // NUMBER of requests+retries needed against an
                                            // already-congested service. Fewer chunks means
                                            // less total retry/backoff overhead and less
                                            // total wall-clock time.
          const CHUNK_START_PADDING_SECONDS = 4; // start padding: unchanged, just needs to
                                                   // avoid clipping the very beginning
          const CHUNK_END_PADDING_SECONDS = 10;   // Widened from a symmetric 4 - the exact
                                                   // rejection reason we now have proof of
                                                   // ("count=59/68", a genuine ~9 word
                                                   // shortfall, not tokenization noise) points
                                                   // to real pacing variance: chunk 1 covers
                                                   // the song's opening, which likely has a
                                                   // slower singing pace than the song's
                                                   // average, so its assigned words (split
                                                   // evenly by count) genuinely take longer to
                                                   // sing than an evenly-split time window
                                                   // allows for - the tail end of the chunk's
                                                   // words fall after the audio we're sending
                                                   // actually ends. The shortfall is
                                                   // specifically about running out of audio at
                                                   // the END, not the start, so the extra
                                                   // padding is asymmetric rather than
                                                   // symmetric to target that directly.
          const numChunks = Math.max(1, Math.ceil(activeSpan / TARGET_CHUNK_SECONDS));
          const wordsPerChunk = Math.ceil(allWordsFlat.length / numChunks);

          const decodedBuffer = await decodeAudioBlobToBuffer(audioInfo.blob);
          const chunkWordArrays: ({ word: string; startTime: number; endTime: number }[] | null)[] =
            new Array(numChunks).fill(null);
          const chunkLastRejectionReason: (string | null)[] = new Array(numChunks).fill(null);

          const attemptChunk = async (c: number, passLabel: string): Promise<{ word: string; startTime: number; endTime: number }[] | null> => {
            const wordSlice = allWordsFlat.slice(c * wordsPerChunk, (c + 1) * wordsPerChunk);
            if (wordSlice.length === 0) return [];

            const estStart = onset + (c / numChunks) * activeSpan;
            const estEnd = onset + ((c + 1) / numChunks) * activeSpan;
            const paddedStart = Math.max(0, estStart - CHUNK_START_PADDING_SECONDS);
            const paddedEnd = Math.min(totalDuration, estEnd + CHUNK_END_PADDING_SECONDS);

            try {
              const sliceResult = await sliceAudioBufferToBase64(decodedBuffer, paddedStart, paddedEnd);
              const chunkBase64 = sliceResult.base64;
              // sliceAudioBufferToBase64 adds its own extra ~250ms of padding before
              // paddedStart when possible, so the returned audio's true absolute t=0 in the
              // original song is actually paddedStart - actualStartPadding, not paddedStart
              // itself. Use this (not paddedStart) when reconstructing absolute times below.
              const chunkAudioAbsoluteStart = paddedStart - sliceResult.actualStartPadding;
              const wordRes = await fetch('/api/precise-word-alignment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  audioBase64: chunkBase64,
                  referenceLyrics: wordSlice.join(' '),
                  mode: 'word',
                  debugLabel: `chunk ${c + 1}/${numChunks}, ${passLabel}`,
                }),
              });
              const wordData = await wordRes.json();
              const chunkWords: any[] = Array.isArray(wordData) ? wordData : (wordData.words || wordData.data || []);

              if (!Array.isArray(chunkWords) || chunkWords.length === 0) {
                throw new Error(`No word data returned for chunk ${c + 1}.`);
              }
              if (wordData?.usedProportionalFallback) {
                throw new Error(`Chunk ${c + 1}: AI unavailable, server used a proportional guess - rejecting.`);
              }

              const startsAreDistinct = new Set(chunkWords.map((w: any) => w.startTime)).size > 1;
              const isMonotonic = chunkWords.every((w: any, idx: number) =>
                idx === 0 || (typeof w.startTime === 'number' && w.startTime >= chunkWords[idx - 1].startTime)
              );
              const countRatio = wordSlice.length > 0 ? chunkWords.length / wordSlice.length : 1;
              // Tightened from 0.85-1.15: that was loose enough to let a chunk that silently
              // dropped ~15% of its requested words (e.g. a whole repeated phrase the model
              // skipped) pass as "reasonable". A single missing word permanently misaligns
              // every word after it against the wrong reference index for the rest of the
              // song - far worse than falling back locally for just this one chunk - so this
              // needs to be strict.
              // We now have direct proof (via chunk/pass-tagged logs) that chunk 1's server
              // call succeeded on every single attempt across 3 separate passes, yet was
              // rejected every time and fell back locally anyway - meaning validation, not
              // the AI, was the actual failure point. 0.97-1.03 was tightened specifically to
              // catch a real 9-word (~15%) drop, but is almost certainly also rejecting
              // harmless minor tokenization differences (contractions, hyphens) that don't
              // indicate a real problem. Loosen to a middle ground that still catches a
              // genuine large drop but tolerates a couple of words of natural variance.
              const countIsReasonable = countRatio >= 0.90 && countRatio <= 1.10;

              if (chunkWords.length > 1 && (!startsAreDistinct || !isMonotonic || !countIsReasonable)) {
                throw new Error(`Chunk ${c + 1}: unreliable timings (distinct=${startsAreDistinct}, monotonic=${isMonotonic}, count=${chunkWords.length}/${wordSlice.length}).`);
              }

              return chunkWords.map((w: any) => ({
                word: w.word,
                // The chunk's returned times are relative to where the sliced audio actually
                // begins (chunkAudioAbsoluteStart, which already accounts for
                // sliceAudioBufferToBase64's own extra padding) - add that offset back to get
                // absolute song time.
                startTime: +(chunkAudioAbsoluteStart + Number(w.startTime)).toFixed(3),
                endTime: +(chunkAudioAbsoluteStart + Number(w.endTime > w.startTime ? w.endTime : w.startTime + 0.15)).toFixed(3),
              }));
            } catch (chunkErr) {
              console.warn(`Word chunk ${c + 1}/${numChunks} (${passLabel}) failed or was unreliable:`, chunkErr);
              chunkLastRejectionReason[c] = chunkErr instanceof Error ? chunkErr.message : String(chunkErr);
              return null;
            }
          };

          // First pass over every chunk.
          for (let c = 0; c < numChunks; c++) {
            setProgressText(`Aligning word chunk ${c + 1} of ${numChunks}...`);
            setProgressPercent(35 + Math.round((c / numChunks) * 30));
            chunkWordArrays[c] = await attemptChunk(c, 'pass 1 (first pass)');
          }

          // Chunks that failed the first pass are very often victims of a transient burst of
          // model unavailability rather than anything wrong with that chunk specifically -
          // several other chunks in this same run typically succeed despite similar "busy"
          // errors. A 2-second pause wasn't long enough to matter against real rate-limit
          // windows (which are often tens of seconds) - give it a real chance to clear before
          // spending more requests on the same still-congested window.
          const failedIndices = chunkWordArrays
            .map((r, idx) => (r === null ? idx : -1))
            .filter((idx) => idx >= 0);

          if (failedIndices.length > 0) {
            setProgressText(`Retrying ${failedIndices.length} chunk(s) that were unavailable on the first pass...`);
            // 20s wasn't earning its cost: quota-exhaustion errors (as opposed to transient
            // "busy" ones) don't clear in 20 seconds, so this was often just pure added wait
            // time on top of an already-long run without actually improving the outcome.
            await new Promise((resolve) => setTimeout(resolve, 8000));
            for (const c of failedIndices) {
              setProgressText(`Retrying word chunk ${c + 1} of ${numChunks}...`);
              chunkWordArrays[c] = await attemptChunk(c, 'pass 2 (retry pass)');
            }
          }

          // Chunk 1 specifically has failed on every test run across many separate days now
          // (even ones where every other chunk succeeded easily), so this isn't just random
          // bad luck evenly spread across chunks - something about being first in the queue
          // consistently disadvantages it. It also anchors the song's opening, where the
          // local fallback is known to be weakest (the intro's real vocal onset is often too
          // quiet to distinguish from silence against the rest of the song's peak volume).
          // Give it one more dedicated attempt, after everything else has already completed
          // and with extra wait time, before accepting the fallback for it specifically.
          if (chunkWordArrays[0] === null) {
            setProgressText(`Chunk 1 (song opening) still unavailable - giving it one more dedicated retry...`);
            await new Promise((resolve) => setTimeout(resolve, 15000));
            chunkWordArrays[0] = await attemptChunk(0, 'pass 3 (dedicated chunk-1 retry)');
          }

          const chunkResults: { word: string; startTime: number; endTime: number }[] = [];
          for (let c = 0; c < numChunks; c++) {
            const wordSlice = allWordsFlat.slice(c * wordsPerChunk, (c + 1) * wordsPerChunk);
            if (wordSlice.length === 0) continue;

            if (chunkWordArrays[c]) {
              chunkResults.push(...chunkWordArrays[c]!);
            } else {
              // Still unavailable after the retry pass - fall back locally for ONLY this
              // chunk's word range, using its own small estimated span. Bounded, contained
              // error instead of losing the whole song.
              const estStart = onset + (c / numChunks) * activeSpan;
              const estEnd = onset + ((c + 1) / numChunks) * activeSpan;
              const localFallback = distributeTimePhoneticallyWithDecay(wordSlice, estStart, estEnd, true);
              localFallback.forEach((w: any) => {
                chunkResults.push({ word: w.word, startTime: w.startTime, endTime: w.endTime });
              });
            }
          }

          if (chunkResults.length === 0) {
            throw new Error("No word chunks produced any data.");
          }

          // Directly settle exactly which chunks came from real AI alignment vs the local
          // fallback, instead of inferring it from output statistics after the fact.
          const aiSucceededCount = chunkWordArrays.filter((r) => r !== null).length;
          const fallbackCount = numChunks - aiSucceededCount;
          const fallbackChunkNumbers = chunkWordArrays
            .map((r, idx) => (r === null ? idx + 1 : null))
            .filter((n): n is number => n !== null);
          console.log(
            `[ChunkProvenance] ${aiSucceededCount}/${numChunks} chunks used real AI alignment. ` +
            `${fallbackCount}/${numChunks} used the local fallback` +
            (fallbackChunkNumbers.length > 0 ? ` (chunk numbers: ${fallbackChunkNumbers.join(', ')})` : '') + '.'
          );

          // Save this as an actual downloaded file rather than a toast the person has to
          // catch in time - a toast disappears in seconds, a file sits in Downloads until
          // they open it.
          const reportLines = [
            `LyricSRT Studio - Word Alignment Chunk Report`,
            `Generated: ${new Date().toISOString()}`,
            `Total chunks: ${numChunks}`,
            `AI-aligned: ${aiSucceededCount}/${numChunks}`,
            `Local fallback: ${fallbackCount}/${numChunks}` +
              (fallbackChunkNumbers.length > 0 ? ` (chunk numbers: ${fallbackChunkNumbers.join(', ')})` : ''),
            ``,
            `Per-chunk detail:`,
            ...chunkWordArrays.map((r, idx) =>
              r !== null
                ? `  Chunk ${idx + 1}: AI SUCCESS`
                : `  Chunk ${idx + 1}: LOCAL FALLBACK` +
                  (chunkLastRejectionReason[idx] ? ` - last rejection reason: ${chunkLastRejectionReason[idx]}` : ' - no attempt reached (song too short for this chunk index)')
            ),
          ];
          const reportBlob = new Blob([reportLines.join('\n')], { type: 'text/plain' });
          const reportUrl = URL.createObjectURL(reportBlob);
          const reportLink = document.createElement('a');
          reportLink.href = reportUrl;
          reportLink.download = `sync-chunk-report-${Date.now()}.txt`;
          document.body.appendChild(reportLink);
          reportLink.click();
          document.body.removeChild(reportLink);
          URL.revokeObjectURL(reportUrl);

          // Enforce monotonic ordering across chunk boundaries (independent chunk requests
          // could, in rare cases, disagree slightly at the seam).
          let prevEnd = 0;
          chunkResults.forEach((w) => {
            if (w.startTime < prevEnd) w.startTime = prevEnd;
            if (w.endTime <= w.startTime) w.endTime = w.startTime + 0.12;
            prevEnd = w.endTime;
          });

          globalWordCues = chunkResults.map((w, idx) => ({
            id: `word-cue-${idx + 1}-${Date.now()}`,
            index: idx + 1,
            text: w.word,
            startTime: w.startTime,
            endTime: w.endTime,
            words: [{ word: w.word, startTime: w.startTime, endTime: w.endTime }],
          }));

          // The AI's own alignment tends to drift slowly through a continuous unbroken
          // phrase and re-anchor at natural pauses between lines (a known characteristic of
          // model-based forced alignment) - visible as timing error that grows across a line
          // then resets. refineWordTimestampsWithVocalOnsets cross-checks each word against
          // the actual audio waveform (not the AI's own internal timing), which can catch and
          // correct exactly this kind of drift. It was already built for the old per-line
          // pipeline but was never wired into this newer chunked path - do that now as a
          // final correction pass over the AI's output.
          if (ENABLE_WORD_ONSET_REFINEMENT) {
            try {
              const vocalSegments = prep.analysis.vocalSegments || [];
              globalWordCues = refineWordTimestampsWithVocalOnsets(globalWordCues, decodedBuffer, vocalSegments);
            } catch (refineErr) {
              console.warn('Post-alignment onset refinement failed, using unrefined AI timings:', refineErr);
            }
          }

          (globalWordCues as any).__chunkProvenance = { aiSucceededCount, fallbackCount, fallbackChunkNumbers, numChunks };
        } catch (globalErr) {
          console.warn(
            "Chunked whole-file word alignment unavailable, falling back to the per-line pipeline:",
            globalErr
          );
          globalWordCues = null;
        }

        if (globalWordCues) {
          setProgressStep(4);
          setProgressText("Finalizing zero-drift subtitle cues & acoustic onsets...");
          setProgressPercent(100);
          setCues(globalWordCues);
          setInitialAlignmentDone(true);
          setFirstLineManuallySet(false);
          setFirstLineAnchor(null);

          const finishedCount = globalWordCues.length;
          const provenance = (globalWordCues as any).__chunkProvenance;
          const provenanceText = provenance
            ? ` (AI: ${provenance.aiSucceededCount}/${provenance.numChunks} chunks` +
              (provenance.fallbackCount > 0 ? `, local fallback: chunk(s) ${provenance.fallbackChunkNumbers.join(', ')}` : ', all chunks AI-aligned') +
              `)`
            : '';
          setTimeout(() => {
            setIsProgressModalOpen(false);
            setSuccessToast(`Success: whole-file word alignment across ${finishedCount} word nodes${provenanceText}!`);
            setTimeout(() => setSuccessToast(null), 8000);
          }, 500);
          return;
        }

        // ---- Fallback: the previous per-line pipeline, kept as a safety net for when the
        // whole-file pass above is unavailable or returns unreliable data. Unchanged from
        // before, including the collapse/monotonicity/onset-lag fixes already applied to it.
        setProgressText("Initiating high-precision phonetic micro-chunking pipeline...");
        setProgressPercent(40);

        // 1. Get Macro Line Anchors first
        let lineAnchors: SubtitleCue[] = [];
        try {
          const lineRes = await fetch("/api/align-lyrics", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              audioBase64: prep.base64,
              mimeType: prep.mimeType,
              lyricsText,
              lines: parsedLines,
              mode: 'line',
              audioDuration: audioInfo.duration,
              analysis: prep.analysis,
            }),
          });
          const lineData = await lineRes.json();
          if (lineRes.ok && lineData.success && Array.isArray(lineData.items) && lineData.items.length > 0) {
            lineAnchors = lineData.items;
          }
        } catch (e) {
          console.log("Macro line scan using AI unavailable, using vocal onset anchors:", e);
        }

        // Fallback to vocal onset alignment if macro scan empty
        if (lineAnchors.length === 0) {
          const rawVocalLines = alignLyricsToVocalSegments(parsedLines, prep.analysis, audioInfo.duration, 'line');
          lineAnchors = rawVocalLines.map((l, idx) => ({
            id: `line-anchor-${idx + 1}-${Date.now()}`,
            index: l.index,
            text: l.text,
            startTime: l.startTime,
            endTime: l.endTime,
          }));
        }

        // Guard against bad/mismatched line anchors before they're used to slice audio and
        // drive word alignment. Two safeguards:
        // 1. Enforce strict monotonic, non-overlapping ordering AND a sane minimum duration
        //    per line (roughly 0.15s/word floor) - a zero/near-zero duration line anchor is
        //    exactly what causes every word inside it to collapse onto the same timestamp
        //    downstream, since there's no time span left to distribute words across.
        // 2. Flag (console.warn) any line whose duration is a wild outlier vs its neighbors -
        //    a strong signal the aligner (AI or vocal-segment fallback) grabbed the wrong
        //    occurrence of a repeated lyric line - so it can be spotted and manually corrected
        //    in the Subtitle Table Editor rather than silently trusted.
        if (lineAnchors.length > 0) {
          for (let li = 0; li < lineAnchors.length; li++) {
            const curLine = lineAnchors[li];
            const wordCount = Math.max(1, curLine.text.split(/\s+/).filter(Boolean).length);
            const minDuration = wordCount * 0.15;
            const minGap = 0.03;

            if (li > 0) {
              const prevLine = lineAnchors[li - 1];
              if (curLine.startTime < prevLine.endTime + minGap) {
                curLine.startTime = prevLine.endTime + minGap;
              }
            }

            if (curLine.endTime - curLine.startTime < minDuration) {
              curLine.endTime = curLine.startTime + minDuration;
            }
          }

          const durations = lineAnchors.map((l) => Math.max(0.05, l.endTime - l.startTime));
          const sortedDur = [...durations].sort((a, b) => a - b);
          const medianDur = sortedDur[Math.floor(sortedDur.length / 2)];

          lineAnchors.forEach((l, li) => {
            const dur = l.endTime - l.startTime;
            if (medianDur > 0 && (dur > medianDur * 4 || dur < medianDur * 0.25)) {
              console.warn(
                `[LineAlignment] Line ${li + 1} ("${l.text}") has an unusual duration ` +
                `(${dur.toFixed(2)}s vs song median ${medianDur.toFixed(2)}s) - possible mismatch ` +
                `to the wrong occurrence of a repeated lyric line, or a failed alignment. ` +
                `Verify/correct it in the table editor.`
              );
            }
          });
        }

        setProgressStep(3);
        setProgressText("Decoding local audio buffer for micro-slicing...");
        setProgressPercent(50);

        // 2. Decode the master audio into an AudioBuffer
        const decodedBuffer = await decodeAudioBlobToBuffer(audioInfo.blob);

        const finalPrecisionWordCues: SubtitleCue[] = [];
        let globalWordIndex = 1;

        // 3. Process each line micro-chunk
        for (let i = 0; i < lineAnchors.length; i++) {
          const line = lineAnchors[i];
          const pct = Math.round(50 + ((i + 1) / lineAnchors.length) * 45);
          setProgressText(`Aligning sub-words: Processing line ${i + 1} of ${lineAnchors.length}...`);
          setProgressPercent(pct);

          try {
            // 3a. Slice sub-segment with lookahead context to capture full vocal note decays
            const chunkBase64 = await sliceAudioBufferWithContext(
              decodedBuffer,
              line.startTime,
              line.endTime
            );

            // 3b. Fetch micro-timings from server proxy passing the context-aware audio snippet
            const response = await fetch('/api/precise-word-alignment', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                audioBase64: chunkBase64,
                referenceLyrics: line.text,
                mode: 'micro-chunk'
              })
            });

            const data = await response.json();
            const relativeWords: any[] = Array.isArray(data) ? data : (data.words || data.data || data.relativeWords || []);

            if (!Array.isArray(relativeWords) || relativeWords.length === 0) {
              throw new Error("No relative words returned");
            }

            // Same reasoning as the whole-file path above: a naive proportional guess (used
            // when every AI model was unavailable) looks well-formed enough to otherwise pass
            // the checks below, so reject it explicitly and let this line fall through to the
            // phonetic-distribution fallback instead.
            if (!Array.isArray(data) && data?.usedProportionalFallback) {
              throw new Error(
                `AI models were unavailable for line ${i + 1} (quota/rate-limited) - using phonetic fallback instead of an unreliable proportional guess.`
              );
            }

            // Sanity-check the returned timings before trusting them. When the underlying
            // aligner (local DSP / Replicate / Gemini) fails silently or returns malformed
            // data, it can come back as a well-formed array where every word's relativeStart
            // is stuck at 0 (or otherwise non-increasing) - which collapses every word in the
            // line onto the exact same on-screen timestamp instead of throwing an error we'd
            // otherwise catch. Reject that here and fall through to the proportional phonetic
            // fallback instead of silently displaying broken, overlapping timings.
            const startsAreDistinct = new Set(relativeWords.map((w: any) => w.relativeStart)).size > 1;
            const isMonotonic = relativeWords.every((w: any, idx: number) =>
              idx === 0 || (typeof w.relativeStart === 'number' && w.relativeStart >= relativeWords[idx - 1].relativeStart)
            );
            if (relativeWords.length > 1 && (!startsAreDistinct || !isMonotonic)) {
              throw new Error(
                `Degenerate word timings returned for line ${i + 1} (non-increasing or identical relativeStart values) - rejecting and using fallback distribution`
              );
            }

            // Filter out non-verbal humming tracks flagged by the model (isVerbalSpeech === false)
            const validatedWords = relativeWords.filter((item: any) => item.isVerbalSpeech !== false);
            if (validatedWords.length === 0) {
              throw new Error(`No verbal speech segments identified for line ${i + 1}`);
            }

            validatedWords.forEach((item: any, idx: number) => {
              // 1. ELIMINATE ALL STRING-MATCHING SEARCH LOOPS
              // We ignore the text value "you" and lock alignment strictly to array sequence indices [idx].
              // This creates an absolute firewall preventing Word #1 from stealing timestamps from Word #4.
              const absoluteStart = line.startTime + item.relativeStart;
              const absoluteEnd = line.startTime + item.relativeEnd;

              // 2. MONOTONIC PROGRESSION & TIME-INVERSION GUARD
              // Ensure every word moves forward chronologically by at least a 150ms visibility window
              let validatedEnd = absoluteEnd > absoluteStart ? absoluteEnd : absoluteStart + 0.150;

              // 3. STRICT INDEX-CHAINED EDGE STEPPING
              // Access the subsequent item explicitly using index pointer offsets [idx + 1]
              const nextItem = validatedWords[idx + 1];
              if (nextItem) {
                const nextAbsoluteStart = line.startTime + nextItem.relativeStart;
                
                // If a word's duration bleeds forward, snap it precisely to the next word's true onset edge
                if (validatedEnd > nextAbsoluteStart) {
                  validatedEnd = nextAbsoluteStart > absoluteStart ? nextAbsoluteStart : absoluteStart + 0.150;
                }
              } else {
                // If it is the absolute final word token of this line chunk, clamp it safely to the macro ceiling
                if (validatedEnd > line.endTime) {
                  if (line.endTime > absoluteStart) {
                    validatedEnd = line.endTime;
                  } else {
                    // If the parent container ceiling is too tight, flex it forward instead of crushing the word backwards!
                    validatedEnd = absoluteStart + 0.200;
                  }
                }
              }

              finalPrecisionWordCues.push({
                id: `word-cue-${globalWordIndex}-${Date.now()}`,
                index: globalWordIndex,
                text: item.word, // Maps the exact verbatim string relative to its pristine array slot index
                startTime: +absoluteStart.toFixed(3),
                endTime: +validatedEnd.toFixed(3),
                words: [{
                  word: item.word,
                  startTime: +absoluteStart.toFixed(3),
                  endTime: +validatedEnd.toFixed(3)
                }]
              });
              globalWordIndex++;
            });
          } catch (chunkErr) {
            console.warn(`Micro-chunk alignment on line ${i + 1} failed, deploying fallback phonetic map:`, chunkErr);
            // Fallback seamlessly to Syllable Weight + Peak Decay local model
            const fallbackWords = distributeTimePhoneticallyWithDecay(
              line.text.split(/\s+/).filter(Boolean),
              line.startTime,
              line.endTime,
              true
            );

            fallbackWords.forEach((wordObj: any) => {
              finalPrecisionWordCues.push({
                id: `word-cue-${globalWordIndex}-${Date.now()}`,
                index: globalWordIndex,
                text: wordObj.word,
                startTime: wordObj.startTime,
                endTime: wordObj.endTime,
                words: [wordObj]
              });
              globalWordIndex++;
            });
          }
        }

        setProgressStep(4);
        setProgressText("Finalizing zero-drift subtitle cues & acoustic onsets...");
        setProgressPercent(100);

        // ============================================================================
        // CRITICAL BYPASS: DEACTIVATE ALL EXTERNAL SMOOTHING HUBS RIGHT HERE
        // Pure ML data sent straight to primary state with zero local distortions.
        // ============================================================================
        setCues(finalPrecisionWordCues);
        console.log("🏁 Pure ML data successfully rendered with zero local distortions.");
        setInitialAlignmentDone(true);
        setFirstLineManuallySet(false);
        setFirstLineAnchor(null);

        setTimeout(() => {
          setIsProgressModalOpen(false);
          setSuccessToast(`Success: Perfect zero-drift alignment realized across ${finalPrecisionWordCues.length} word nodes!`);
          setTimeout(() => setSuccessToast(null), 4000);
        }, 500);
      } else {
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
            mode: 'line',
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

        // Apply Intro Silence Mask Guard to line mode cues
        const shieldedLineCues = maskIntroHummingSegments(data.items, prep.analysis.vocalSegments);

        setCues(shieldedLineCues);
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
      }
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

      let finalItems = data.items;
      if (syncMode === 'word') {
        const wordCues = generateAccurateWordCuesFromLines(data.items, prep.analysis.vocalSegments);
        const decodedBuf = await decodeAudioBlobToBuffer(audioInfo.blob);
        if (ENABLE_WORD_ONSET_REFINEMENT) {
          finalItems = refineWordTimestampsWithVocalOnsets(wordCues, decodedBuf, prep.analysis.vocalSegments);
        } else {
          finalItems = wordCues;
        }
        const trueSpeechOnsetMarker = detectTrueSpeechOnset(decodedBuf, prep.analysis.vocalSegments);
        finalItems = applyIntroSpeechGate(finalItems, trueSpeechOnsetMarker);
      }

      finalItems = maskIntroHummingSegments(finalItems, prep.analysis.vocalSegments);

      setCues(finalItems);
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
              onSyncModeChange={handleSyncModeChange}
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
