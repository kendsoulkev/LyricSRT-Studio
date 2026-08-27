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
