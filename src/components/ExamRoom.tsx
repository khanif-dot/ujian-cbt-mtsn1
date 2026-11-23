import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Flag,
  LayoutGrid,
  Maximize2,
  RotateCcw,
  Send,
  ShieldAlert,
  X,
} from 'lucide-react';
import { MathText } from '@/src/components/MathText';
import {
  clearActiveSessionLocal,
  flushExamProgressKeepalive,
  getServerNowMs,
  lockoutExamSession,
  saveActiveSessionLocal,
  saveLocalResultProgressSnapshot,
  subscribeDataChanges,
  submitFinalExam,
  upsertExamProgress,
} from '@/src/lib/dataStore';
import {
  getEffectiveQuestionType,
  isQuestionAnswered,
  parseMatchingMap,
  QUESTION_TYPE_LABELS,
  TRUE_FALSE_DEFAULT_OPTIONS,
} from '@/src/lib/questionUtils';
import type { ActiveExamSession, ExamResult, OptionKey, SchoolProfile } from '@/src/types/cbt';

interface ExamRoomProps {
  profile: SchoolProfile;
  initialSession: ActiveExamSession;
  onExamCompleted: (result: ExamResult) => void;
  onExamLocked: (result?: ExamResult) => void;
}

function formatRemainingTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function computeAuthoritativeEndsAtMs(sess: ActiveExamSession): number {
  const startedMs = new Date(sess.startedAt).getTime();
  const maxAllowedMs = startedMs + Math.max(1, sess.schedule.durationMinutes) * 60 * 1000;
  const endsMs = new Date(sess.endsAt).getTime();
  if (!Number.isFinite(startedMs)) return endsMs;
  if (!Number.isFinite(endsMs)) return maxAllowedMs;
  return Math.min(endsMs, maxAllowedMs);
}

export const ExamRoom: React.FC<ExamRoomProps> = ({
  profile,
  initialSession,
  onExamCompleted,
  onExamLocked,
}) => {
  const [session, setSession] = useState<ActiveExamSession>(initialSession);
  const [remainingSeconds, setRemainingSeconds] = useState<number>(() => {
    const endMs = computeAuthoritativeEndsAtMs(initialSession);
    return Math.max(0, Math.floor((endMs - getServerNowMs()) / 1000));
  });
  const [syncIndicator, setSyncIndicator] = useState<'synced' | 'syncing' | 'offline'>('synced');
  const [showNavDrawer, setShowNavDrawer] = useState(false);
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitProgressText, setSubmitProgressText] = useState('');
  const [isExpiryQueueing, setIsExpiryQueueing] = useState(false);
  const [expiryQueueSecondsLeft, setExpiryQueueSecondsLeft] = useState(0);
  const [submitErrorMsg, setSubmitErrorMsg] = useState('');
  const [isFinalizingLockout, setIsFinalizingLockout] = useState(false);
  const [lockedResult, setLockedResult] = useState<ExamResult | undefined>(undefined);
  const [cheatWarningOpen, setCheatWarningOpen] = useState(false);
  const [violationReason, setViolationReason] = useState<'tab_switch' | 'screenshot'>('tab_switch');
  const [isScreenBlurred, setIsScreenBlurred] = useState(false);
  const [isViolationLocked, setIsViolationLocked] = useState<boolean>(
    () => initialSession.tabSwitchCount >= initialSession.schedule.maxTabSwitches
  );
  const [isFullscreen, setIsFullscreen] = useState<boolean>(() =>
    Boolean(typeof document !== 'undefined' && document.fullscreenElement)
  );

  const sessionRef = useRef(session);
  sessionRef.current = session;
  const submittingRef = useRef(false);
  const lastViolationTsRef = useRef(0);
  const lastViewportResizeTsRef = useRef(0);
  const isUnloadingRef = useRef(false);
  const unloadResetTimerRef = useRef<number | null>(null);
  const blurTimerRef = useRef<number | null>(null);
  const progressTimerRef = useRef<number | null>(null);
  const firstDirtyProgressTsRef = useRef<number | null>(null);
  const navSaveTimerRef = useRef<number | null>(null);
  const expiryPendingRef = useRef(false);
  const expiryJitterTimerRef = useRef<number | null>(null);
  const expiryCountdownIntervalRef = useRef<number | null>(null);
  const lockedRef = useRef(isViolationLocked);
  lockedRef.current = isViolationLocked;
  const lockoutPromiseRef = useRef<Promise<ExamResult> | null>(null);

  const [activeMatchingLeftId, setActiveMatchingLeftId] = useState<string | null>(null);

  const currentQuestion = session.questions[session.currentIndex];
  const currentQuestionType = useMemo(
    () => (currentQuestion ? getEffectiveQuestionType(currentQuestion) : 'multiple_choice'),
    [currentQuestion]
  );
  const answeredCount = useMemo(
    () =>
      session.questions.filter((q) => isQuestionAnswered(q, session.answers[q.id])).length,
    [session.questions, session.answers]
  );
  const flaggedQuestionSet = useMemo(
    () => new Set(session.flaggedQuestions),
    [session.flaggedQuestions]
  );
  const visibleOptions = useMemo(() => {
    if (!currentQuestion) return [];
    if (currentQuestionType === 'true_false') {
      return Array.isArray(currentQuestion.options) && currentQuestion.options.length >= 2
        ? currentQuestion.options.slice(0, 2)
        : TRUE_FALSE_DEFAULT_OPTIONS;
    }
    const filtered = currentQuestion.options.filter(
      (opt) => (opt.text && opt.text.trim() !== '') || Boolean(opt.imageUrl)
    );
    return filtered.length >= 2 ? filtered : currentQuestion.options;
  }, [currentQuestion, currentQuestionType]);

  const currentMatchingMap = useMemo(() => {
    if (!currentQuestion || currentQuestionType !== 'matching') return {};
    return parseMatchingMap(session.answers[currentQuestion.id]);
  }, [currentQuestion, currentQuestionType, session.answers]);

  useEffect(() => {
    if (!currentQuestion || getEffectiveQuestionType(currentQuestion) !== 'matching') {
      setActiveMatchingLeftId(null);
      return;
    }
    const leftItems = currentQuestion.matchingData?.leftItems || [];
    const existingMap = parseMatchingMap(sessionRef.current.answers[currentQuestion.id]);
    const firstUnpaired = leftItems.find((item) => !existingMap[item.id]);
    setActiveMatchingLeftId(firstUnpaired?.id || leftItems[0]?.id || null);
  }, [currentQuestion?.id]);

  const clearPendingProgressTimer = useCallback(() => {
    if (progressTimerRef.current !== null) {
      window.clearTimeout(progressTimerRef.current);
      progressTimerRef.current = null;
    }
    firstDirtyProgressTsRef.current = null;
  }, []);

  const clearPendingNavSaveTimer = useCallback(() => {
    if (navSaveTimerRef.current !== null) {
      window.clearTimeout(navSaveTimerRef.current);
      navSaveTimerRef.current = null;
    }
  }, []);

  const triggerLockoutFinalize = useCallback(
    (lockedSession: ActiveExamSession) => {
      if (expiryJitterTimerRef.current !== null) {
        window.clearTimeout(expiryJitterTimerRef.current);
        expiryJitterTimerRef.current = null;
      }
      clearPendingProgressTimer();
      clearPendingNavSaveTimer();
      if (lockoutPromiseRef.current) return lockoutPromiseRef.current;
      setIsFinalizingLockout(true);
      const p = lockoutExamSession(lockedSession)
        .then((res) => {
          setLockedResult(res);
          return res;
        })
        .finally(() => {
          setIsFinalizingLockout(false);
        });
      lockoutPromiseRef.current = p;
      return p;
    },
    [clearPendingNavSaveTimer, clearPendingProgressTimer]
  );

  const handleFinalizeExam = useCallback(async () => {
    if (submittingRef.current || lockedRef.current) return;
    if (expiryJitterTimerRef.current !== null) {
      window.clearTimeout(expiryJitterTimerRef.current);
      expiryJitterTimerRef.current = null;
    }
    clearPendingProgressTimer();
    clearPendingNavSaveTimer();
    submittingRef.current = true;
    setIsSubmitting(true);
    setSubmitErrorMsg('');
    setSubmitProgressText('Menyimpan jawaban lokal...');
    try {
      // Ambil salinan snapshot jawaban terbaru langsung dari memori (sessionRef.current)
      // dan simpan lokal segera sebelum mengirim ke server.
      const currentMemSession = sessionRef.current;
      const latestSessionSnapshot: ActiveExamSession = {
        ...currentMemSession,
        answers: { ...currentMemSession.answers },
        flaggedQuestions: [...currentMemSession.flaggedQuestions],
      };
      saveActiveSessionLocal(latestSessionSnapshot);

      const result = await submitFinalExam(latestSessionSnapshot, {
        skipInitialJitter: expiryPendingRef.current,
        onProgress: (msg) => setSubmitProgressText(msg),
      });
      // Jangan biarkan exitFullscreen() yang menggantung di WebView/Exam Browser menahan perpindahan ke layar selesai
      if (document.fullscreenElement && document.exitFullscreen) {
        try {
          await Promise.race([
            document.exitFullscreen().catch(() => {}),
            new Promise((r) => window.setTimeout(r, 400)),
          ]);
        } catch {
          // Ignore fullscreen exit rejection
        }
      }
      onExamCompleted(result);
    } catch (err) {
      submittingRef.current = false;
      expiryPendingRef.current = false;
      setIsExpiryQueueing(false);
      setSubmitProgressText('');
      setSubmitErrorMsg(
        err instanceof Error
          ? err.message
          : 'Gagal mengumpulkan ujian. Silakan tekan tombol kirim ulang.'
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [clearPendingNavSaveTimer, clearPendingProgressTimer, onExamCompleted]);

  const handleFinalizeExamRef = useRef(handleFinalizeExam);
  handleFinalizeExamRef.current = handleFinalizeExam;

  // Countdown timer synced to monotonic server clock & clamped to startedAt + durationMinutes.
  // Sengaja hanya bergantung pada isViolationLocked agar timer antrean auto-submit tidak pernah terbatalkan oleh re-render induk.
  useEffect(() => {
    if (isViolationLocked) return;

    const checkAndTick = () => {
      if (lockedRef.current) return true;
      const endMs = computeAuthoritativeEndsAtMs(sessionRef.current);
      const left = Math.max(0, Math.floor((endMs - getServerNowMs()) / 1000));
      setRemainingSeconds(left);
      if (left <= 0) {
        if (!submittingRef.current && !expiryPendingRef.current) {
          // Batalkan timer/debounce autosave & nav-save tertunda seketika agar tidak berbenturan
          // dengan proses flush akhir, lalu amankan snapshot memori terbaru ke penyimpanan lokal
          // (active_session, backup localStorage sinkron, DAN exam_results lokal).
          clearPendingProgressTimer();
          clearPendingNavSaveTimer();
          const finalSnapshot: ActiveExamSession = {
            ...sessionRef.current,
            answers: { ...sessionRef.current.answers },
            flaggedQuestions: [...sessionRef.current.flaggedQuestions],
          };
          saveActiveSessionLocal(finalSnapshot);
          void saveLocalResultProgressSnapshot(finalSnapshot).catch(() => {});

          expiryPendingRef.current = true;
          setIsExpiryQueueing(true);
          setShowSubmitModal(false);
          // Sebarkan expiryJitter 2 - 30 detik agar 800-1.000 siswa merata sambil tetap selesai
          // jauh sebelum EXPIRY_GRACE_MS (75s) & ADMIN_EXPIRY_GRACE_MS (300s) meski dengan retry submit.
          const jitterMs = 2_000 + Math.floor(Math.random() * 28_000);
          const scheduledAtMs = Date.now() + jitterMs;
          setExpiryQueueSecondsLeft(Math.max(1, Math.ceil(jitterMs / 1000)));
          if (expiryCountdownIntervalRef.current !== null) {
            window.clearInterval(expiryCountdownIntervalRef.current);
          }
          expiryCountdownIntervalRef.current = window.setInterval(() => {
            const secs = Math.max(0, Math.ceil((scheduledAtMs - Date.now()) / 1000));
            setExpiryQueueSecondsLeft(secs);
            if (secs <= 0 && expiryCountdownIntervalRef.current !== null) {
              window.clearInterval(expiryCountdownIntervalRef.current);
              expiryCountdownIntervalRef.current = null;
            }
          }, 500);
          expiryJitterTimerRef.current = window.setTimeout(() => {
            expiryJitterTimerRef.current = null;
            if (expiryCountdownIntervalRef.current !== null) {
              window.clearInterval(expiryCountdownIntervalRef.current);
              expiryCountdownIntervalRef.current = null;
            }
            setExpiryQueueSecondsLeft(0);
            void handleFinalizeExamRef.current();
          }, jitterMs);
        }
        return true;
      }
      return false;
    };

    if (checkAndTick()) {
      return () => {
        if (expiryJitterTimerRef.current !== null) {
          window.clearTimeout(expiryJitterTimerRef.current);
          expiryJitterTimerRef.current = null;
          expiryPendingRef.current = false;
        }
        if (expiryCountdownIntervalRef.current !== null) {
          window.clearInterval(expiryCountdownIntervalRef.current);
          expiryCountdownIntervalRef.current = null;
        }
      };
    }

    const timer = window.setInterval(() => {
      if (checkAndTick()) {
        window.clearInterval(timer);
      }
    }, 1000);
    return () => {
      window.clearInterval(timer);
      if (expiryJitterTimerRef.current !== null) {
        window.clearTimeout(expiryJitterTimerRef.current);
        expiryJitterTimerRef.current = null;
        expiryPendingRef.current = false;
      }
      if (expiryCountdownIntervalRef.current !== null) {
        window.clearInterval(expiryCountdownIntervalRef.current);
        expiryCountdownIntervalRef.current = null;
      }
    };
  }, [isViolationLocked, clearPendingProgressTimer, clearPendingNavSaveTimer]);

  // Protect active exam from accidental browser refresh & clean up timers
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      isUnloadingRef.current = true;
      if (blurTimerRef.current) {
        window.clearTimeout(blurTimerRef.current);
        blurTimerRef.current = null;
      }
      if (unloadResetTimerRef.current) {
        window.clearTimeout(unloadResetTimerRef.current);
      }
      unloadResetTimerRef.current = window.setTimeout(() => {
        isUnloadingRef.current = false;
        unloadResetTimerRef.current = null;
      }, 2000);

      if (!lockedRef.current) {
        if (!submittingRef.current) {
          flushExamProgressKeepalive(sessionRef.current);
        }
        // Tetap tahan penutupan tab mendadak baik saat mengerjakan maupun saat proses kirim akhir berlangsung
        e.preventDefault();
        e.returnValue = '';
      }
    };

    const handlePageHide = () => {
      isUnloadingRef.current = true;
      if (blurTimerRef.current) {
        window.clearTimeout(blurTimerRef.current);
        blurTimerRef.current = null;
      }
      if (!submittingRef.current && !lockedRef.current) {
        flushExamProgressKeepalive(sessionRef.current);
      }
    };

    const handleOffline = () => {
      setSyncIndicator('offline');
    };

    const unsubscribeSync = subscribeDataChanges((topic) => {
      if (topic === 'sync_flushed' && progressTimerRef.current === null && !submittingRef.current) {
        setSyncIndicator('synced');
      }
    });

    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('offline', handleOffline);
    return () => {
      if (unloadResetTimerRef.current) {
        window.clearTimeout(unloadResetTimerRef.current);
      }
      if (navSaveTimerRef.current) {
        window.clearTimeout(navSaveTimerRef.current);
      }
      unsubscribeSync();
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Anti-Cheating: Page Visibility API + Instant Focus-Loss Obscure + Window Blur + Screenshot & Shortcut Block
  useEffect(() => {
    const recordViolation = (reason: 'tab_switch' | 'screenshot' = 'tab_switch') => {
      if (isUnloadingRef.current || submittingRef.current || lockedRef.current) return;
      const now = Date.now();
      if (now - lastViolationTsRef.current < 1500) return;
      lastViolationTsRef.current = now;

      setSession((prev) => {
        const nextCount = prev.tabSwitchCount + 1;
        const updated: ActiveExamSession = {
          ...prev,
          tabSwitchCount: nextCount,
        };
        if (nextCount >= prev.schedule.maxTabSwitches) {
          lockedRef.current = true;
          setIsViolationLocked(true);
          setCheatWarningOpen(false);
          setIsScreenBlurred(false);
          void triggerLockoutFinalize(updated);
        } else {
          saveActiveSessionLocal(updated);
          clearPendingProgressTimer();
          void upsertExamProgress(updated, { includeQuestionIds: false });
          setViolationReason(reason);
          setCheatWarningOpen(true);
        }
        return updated;
      });
    };

    const isScreenshotShortcut = (e: KeyboardEvent): boolean => {
      const key = e.key.toLowerCase();
      const code = e.code;
      // PrintScreen (Windows / Linux / ChromeOS)
      if (key === 'printscreen' || code === 'PrintScreen') {
        return true;
      }
      // Win + Shift + S (Windows Snipping Tool)
      if (e.metaKey && e.shiftKey && (key === 's' || code === 'KeyS')) {
        return true;
      }
      // Cmd + Shift + 3 / 4 / 5 (macOS Screenshot & Screen Recording; Shift produces #, $, %)
      if (
        e.metaKey &&
        e.shiftKey &&
        (['3', '4', '5', '#', '$', '%'].includes(e.key) ||
          ['Digit3', 'Digit4', 'Digit5'].includes(code))
      ) {
        return true;
      }
      return false;
    };

    const handleScreenshotAttempt = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (isUnloadingRef.current || submittingRef.current || lockedRef.current) return;
      setIsScreenBlurred(true);
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText('').catch(() => {});
      }
      recordViolation('screenshot');
    };

    const onVisibilityChange = () => {
      if (document.hidden && !isUnloadingRef.current) {
        if (!submittingRef.current) {
          setIsScreenBlurred(true);
        }
        // Jika ada jawaban baru yang masih menunggu debounce 10-14 detik saat tab disembunyikan/berpindah aplikasi,
        // segera kirim via keepalive agar tetap tersimpan meskipun browser mobile menghentikan proses tab.
        if (!submittingRef.current && !lockedRef.current && progressTimerRef.current !== null) {
          flushExamProgressKeepalive(sessionRef.current);
        }
        window.setTimeout(() => {
          if (document.hidden && !isUnloadingRef.current) {
            recordViolation('tab_switch');
          }
        }, 150);
      } else if (!document.hidden && document.hasFocus()) {
        setIsScreenBlurred(false);
      }
    };

    const onViewportResize = () => {
      lastViewportResizeTsRef.current = Date.now();
    };

    const onBlur = () => {
      if (isUnloadingRef.current) return;
      // Pengaburan instan (0ms) saat jendela kehilangan fokus (mis. overlay Snipping Tool / menu sistem)
      if (!submittingRef.current) {
        setIsScreenBlurred(true);
      }
      if (blurTimerRef.current) {
        window.clearTimeout(blurTimerRef.current);
      }
      blurTimerRef.current = window.setTimeout(() => {
        blurTimerRef.current = null;
        const recentMobileResize = Date.now() - lastViewportResizeTsRef.current < 600;
        if (
          !isUnloadingRef.current &&
          !document.hasFocus() &&
          (!recentMobileResize || document.hidden)
        ) {
          recordViolation('tab_switch');
        }
      }, 1200);
    };

    const onFocus = () => {
      if (blurTimerRef.current) {
        window.clearTimeout(blurTimerRef.current);
        blurTimerRef.current = null;
      }
      setIsScreenBlurred(false);
    };

    const onFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isScreenshotShortcut(e)) {
        handleScreenshotAttempt(e);
        return;
      }
      const key = e.key.toLowerCase();
      if (
        e.key === 'F12' ||
        ((e.ctrlKey || e.metaKey) && ['c', 'x', 'u', 's', 'p'].includes(key)) ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && ['i', 'j', 'c'].includes(key))
      ) {
        e.preventDefault();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (isScreenshotShortcut(e)) {
        handleScreenshotAttempt(e);
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    window.visualViewport?.addEventListener('resize', onViewportResize);

    return () => {
      clearPendingProgressTimer();
      if (blurTimerRef.current) {
        window.clearTimeout(blurTimerRef.current);
      }
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      window.visualViewport?.removeEventListener('resize', onViewportResize);
    };
  }, [clearPendingProgressTimer, triggerLockoutFinalize]);

  // Autosave lokal berlangsung instan (0ms), sedangkan sync cloud diberi debounce 10-14 detik
  // (maksimal tunggu 25 detik) untuk memangkas ~70% beban tulis database saat 800-1.000+ siswa aktif serentak.
  const persistProgress = useCallback(
    (updated: ActiveExamSession) => {
      if (expiryPendingRef.current || submittingRef.current || lockedRef.current) return;
      setSyncIndicator('syncing');
      const now = Date.now();
      if (firstDirtyProgressTsRef.current === null) {
        firstDirtyProgressTsRef.current = now;
      }
      if (progressTimerRef.current !== null) {
        window.clearTimeout(progressTimerRef.current);
        progressTimerRef.current = null;
      }

      const elapsedDirty = now - firstDirtyProgressTsRef.current;
      const baseDelayMs = 10_000 + Math.floor(Math.random() * 4000);
      const delayMs = elapsedDirty >= 25_000 ? 800 : Math.min(baseDelayMs, 26_000 - elapsedDirty);

      progressTimerRef.current = window.setTimeout(() => {
        progressTimerRef.current = null;
        firstDirtyProgressTsRef.current = null;
        if (expiryPendingRef.current || submittingRef.current || lockedRef.current) return;
        void (async () => {
          try {
            const res = await upsertExamProgress(sessionRef.current || updated, {
              includeQuestionIds: false,
            });
            setSyncIndicator(res.syncStatus === 'synced' ? 'synced' : 'offline');
          } catch {
            setSyncIndicator('offline');
          }
        })();
      }, delayMs);
    },
    []
  );

  const handleSelectOption = (questionId: string, key: OptionKey) => {
    if (expiryPendingRef.current || submittingRef.current || lockedRef.current) return;
    // Perbarui sessionRef & backup lokal secara SINKRON sebelum setSession agar klik detik terakhir
    // tidak pernah tertinggal akibat batching render React 19 jika timer habis di frame yang sama.
    const prev = sessionRef.current;
    const updated: ActiveExamSession = {
      ...prev,
      answers: {
        ...prev.answers,
        [questionId]: key,
      },
    };
    sessionRef.current = updated;
    saveActiveSessionLocal(updated);
    void persistProgress(updated);
    setSession(updated);
  };

  const commitMatchingMap = (questionId: string, nextMap: Record<string, string>) => {
    if (expiryPendingRef.current || submittingRef.current || lockedRef.current) return;
    const prev = sessionRef.current;
    const nextAnswers = { ...prev.answers };
    if (Object.keys(nextMap).length === 0) {
      delete nextAnswers[questionId];
    } else {
      nextAnswers[questionId] = JSON.stringify(nextMap);
    }
    const updated: ActiveExamSession = {
      ...prev,
      answers: nextAnswers,
    };
    sessionRef.current = updated;
    saveActiveSessionLocal(updated);
    void persistProgress(updated);
    setSession(updated);
  };

  const handlePairMatchingRight = (rightId: string) => {
    if (!currentQuestion || !currentQuestion.matchingData) return;
    const leftItems = currentQuestion.matchingData.leftItems;
    if (leftItems.length === 0) return;

    const targetLeftId =
      activeMatchingLeftId && leftItems.some((l) => l.id === activeMatchingLeftId)
        ? activeMatchingLeftId
        : leftItems.find((l) => !currentMatchingMap[l.id])?.id || leftItems[0].id;

    const nextMap: Record<string, string> = { ...currentMatchingMap };
    const wasSamePair = nextMap[targetLeftId] === rightId;

    // Ensure 1-to-1 assignment: remove any existing pairing to this rightId
    for (const [lId, rId] of Object.entries(nextMap)) {
      if (rId === rightId) {
        delete nextMap[lId];
      }
    }

    if (!wasSamePair) {
      nextMap[targetLeftId] = rightId;
      // Advance active left slot to next unpaired item if any
      const curIdx = leftItems.findIndex((l) => l.id === targetLeftId);
      let nextUnpaired: string | null = null;
      for (let offset = 1; offset <= leftItems.length; offset++) {
        const candidate = leftItems[(curIdx + offset) % leftItems.length];
        if (!nextMap[candidate.id]) {
          nextUnpaired = candidate.id;
          break;
        }
      }
      if (nextUnpaired) {
        setActiveMatchingLeftId(nextUnpaired);
      }
    }

    commitMatchingMap(currentQuestion.id, nextMap);
  };

  const handleUnpairMatchingLeft = (leftId: string) => {
    if (!currentQuestion) return;
    const nextMap = { ...currentMatchingMap };
    delete nextMap[leftId];
    commitMatchingMap(currentQuestion.id, nextMap);
    setActiveMatchingLeftId(leftId);
  };

  const handleResetMatching = () => {
    if (!currentQuestion) return;
    commitMatchingMap(currentQuestion.id, {});
    const firstLeft = currentQuestion.matchingData?.leftItems[0]?.id || null;
    setActiveMatchingLeftId(firstLeft);
  };

  const handleToggleFlag = (questionId: string) => {
    if (expiryPendingRef.current || submittingRef.current || lockedRef.current) return;
    const prev = sessionRef.current;
    const exists = prev.flaggedQuestions.includes(questionId);
    const updated: ActiveExamSession = {
      ...prev,
      flaggedQuestions: exists
        ? prev.flaggedQuestions.filter((id) => id !== questionId)
        : [...prev.flaggedQuestions, questionId],
    };
    sessionRef.current = updated;
    saveActiveSessionLocal(updated);
    void persistProgress(updated);
    setSession(updated);
  };

  const handleJumpQuestion = (index: number) => {
    const prev = sessionRef.current;
    if (index < 0 || index >= prev.questions.length || index === prev.currentIndex) {
      setShowNavDrawer(false);
      return;
    }
    const updated: ActiveExamSession = {
      ...prev,
      currentIndex: index,
    };
    sessionRef.current = updated;
    setSession(updated);
    if (navSaveTimerRef.current !== null) {
      window.clearTimeout(navSaveTimerRef.current);
    }
    navSaveTimerRef.current = window.setTimeout(() => {
      navSaveTimerRef.current = null;
      if (!submittingRef.current && !lockedRef.current) {
        saveActiveSessionLocal(sessionRef.current);
      }
    }, 400);
    setShowNavDrawer(false);
  };

  const handleEnterFullscreen = async () => {
    try {
      if (document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      // Ignore if environment denies fullscreen
    }
  };

  if (!currentQuestion) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="max-w-md w-full bg-white rounded-2xl border border-slate-200 p-6 text-center space-y-4">
          <p className="text-slate-700 font-medium">
            Belum ada soal mata pelajaran {session.schedule.subject} untuk kelas{' '}
            {session.participant.className}.
          </p>
          <button
            type="button"
            onClick={() => {
              clearActiveSessionLocal();
              if (document.fullscreenElement && document.exitFullscreen) {
                void document.exitFullscreen().catch(() => {});
              }
              onExamLocked();
            }}
            className="px-4 py-2.5 rounded-xl bg-emerald-800 text-white text-sm font-semibold cursor-pointer"
          >
            Kembali
          </button>
        </div>
      </div>
    );
  }

  const selectedAnswer = session.answers[currentQuestion.id];
  const isFlagged = flaggedQuestionSet.has(currentQuestion.id);
  const isTimeCritical = remainingSeconds <= 300;
  const isContentObscured = cheatWarningOpen || isViolationLocked || isScreenBlurred;

  return (
    <div
      className="min-h-screen bg-slate-100 flex flex-col select-none"
      onContextMenu={(e) => e.preventDefault()}
      onCopy={(e) => e.preventDefault()}
      onCut={(e) => e.preventDefault()}
    >
      {/* Top Exam Bar */}
      <header className="sticky top-0 z-30 bg-[#064e3b] text-white border-b border-emerald-900/50 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="min-w-0">
              <div className="font-display font-bold text-sm sm:text-base truncate">
                {session.participant.fullName}
              </div>
              <div className="text-xs text-emerald-100/85 truncate">
                Kelas {session.participant.className} ·{' '}
                <span className="font-mono">{session.participant.participantNumber}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2.5 sm:gap-3 shrink-0">
            <div
              className={`px-3 py-1.5 rounded-lg flex items-center gap-2 font-mono text-sm sm:text-base font-bold tabular-nums ${
                isTimeCritical
                  ? 'bg-red-600 text-white'
                  : 'bg-emerald-950/60 text-emerald-50 border border-emerald-700/60'
              }`}
            >
              <Clock className="w-4 h-4 shrink-0" />
              <span>{formatRemainingTime(remainingSeconds)}</span>
            </div>

            {!isFullscreen && (
              <button
                type="button"
                onClick={handleEnterFullscreen}
                title="Aktifkan Layar Penuh"
                className="hidden sm:inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 text-xs font-semibold border border-amber-300/30 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Maximize2 className="w-3.5 h-3.5" />
                <span>Layar Penuh</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setShowNavDrawer(true)}
              className="lg:hidden inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/15 hover:bg-white/25 text-white text-xs font-semibold transition-colors cursor-pointer"
            >
              <LayoutGrid className="w-4 h-4" />
              <span className="tabular-nums">
                {answeredCount}/{session.questions.length}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setShowSubmitModal(true)}
              className="inline-flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 rounded-lg bg-white text-emerald-950 hover:bg-emerald-50 text-xs sm:text-sm font-bold transition-colors cursor-pointer whitespace-nowrap"
            >
              <Send className="w-3.5 h-3.5" />
              <span className="sm:hidden">Selesai</span>
              <span className="hidden sm:inline">Akhiri Ujian</span>
            </button>
          </div>
        </div>
      </header>

      {/* Center Top Header Above Question: School Logo, Exam Name, Subject Name */}
      <div className="bg-white border-b border-slate-200 px-4 py-3.5">
        <div className="max-w-4xl mx-auto flex flex-col items-center justify-center text-center gap-1.5">
          <div className="flex items-center justify-center gap-3">
            {profile.logoDataUrl && (
              <img
                src={profile.logoDataUrl}
                alt={`Logo ${profile.schoolName}`}
                referrerPolicy="no-referrer"
                className="w-14 h-14 object-contain shrink-0"
              />
            )}
            <div className="text-left">
              <div className="font-display font-bold text-slate-900 text-sm sm:text-base leading-tight">
                {profile.examTitle}
              </div>
              <div className="text-xs sm:text-sm font-semibold text-emerald-800">
                Mata Pelajaran: {session.schedule.subject}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content Split: Question Stage + Question Palette (instantly obscured on focus loss / cheat modals) */}
      <main
        className={`flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-5 sm:py-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start ${
          isContentObscured ? 'transition-none blur-xl pointer-events-none select-none opacity-0' : ''
        }`}
      >
        {/* Question Canvas */}
        <section className="lg:col-span-8 bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="px-5 sm:px-7 py-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3 bg-slate-50/70">
            <div className="flex flex-wrap items-center gap-2 sm:gap-3 text-sm">
              <span className="font-display font-bold text-slate-900">
                Soal Nomor <span className="font-mono tabular-nums">{session.currentIndex + 1}</span>
              </span>
              <span
                className={`px-2 py-0.5 rounded-md text-xs font-semibold border ${
                  currentQuestionType === 'matching'
                    ? 'bg-amber-50 border-amber-200 text-amber-800'
                    : currentQuestionType === 'true_false'
                      ? 'bg-sky-50 border-sky-200 text-sky-800'
                      : 'bg-slate-100 border-slate-200 text-slate-700'
                }`}
              >
                {QUESTION_TYPE_LABELS[currentQuestionType]}
              </span>
              <span className="text-slate-300" aria-hidden="true">/</span>
              <span className="text-slate-600 font-medium">{currentQuestion.subject}</span>
            </div>
            <div className="text-xs text-slate-500 font-medium">
              {syncIndicator === 'syncing'
                ? 'Menyimpan...'
                : syncIndicator === 'synced'
                  ? 'Tersimpan di Cloud & Lokal'
                  : 'Tersimpan Lokal (Antrean Sync)'}
            </div>
          </div>

          <div className="p-5 sm:p-8 space-y-6">
            {currentQuestion.questionImageUrl && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 flex justify-center">
                <img
                  src={currentQuestion.questionImageUrl}
                  alt={`Ilustrasi Soal ${session.currentIndex + 1}`}
                  referrerPolicy="no-referrer"
                  className="max-h-72 w-auto object-contain rounded-lg"
                />
              </div>
            )}

            <div className="text-slate-900 text-base sm:text-lg leading-relaxed font-normal select-none">
              <MathText text={currentQuestion.questionText} />
            </div>

            {currentQuestionType === 'matching' && currentQuestion.matchingData ? (
              (() => {
                const { leftItems, rightItems } = currentQuestion.matchingData;
                const rightById = new Map(
                  rightItems.map((r, rIdx) => [
                    r.id,
                    { item: r, letter: String.fromCharCode(65 + rIdx) },
                  ])
                );
                const leftIndexByRightId = new Map<string, number>();
                leftItems.forEach((l, lIdx) => {
                  const assignedRight = currentMatchingMap[l.id];
                  if (assignedRight) {
                    leftIndexByRightId.set(assignedRight, lIdx + 1);
                  }
                });
                const pairedCount = leftItems.filter((l) => Boolean(currentMatchingMap[l.id])).length;

                return (
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2 p-3 rounded-xl bg-amber-50/80 border border-amber-200 text-xs text-amber-950">
                      <div className="flex items-center gap-2">
                        <ArrowLeftRight className="w-4 h-4 text-amber-700 shrink-0" />
                        <span>
                          Klik pernyataan di <strong>kolom kiri</strong>, lalu klik pasangan jawaban yang sesuai di <strong>kolom kanan</strong>. ({' '}
                          <strong className="font-mono tabular-nums">
                            {pairedCount}/{leftItems.length}
                          </strong>{' '}
                          terjodohkan )
                        </span>
                      </div>
                      {pairedCount > 0 && (
                        <button
                          type="button"
                          onClick={handleResetMatching}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white border border-amber-300 hover:bg-amber-100 text-amber-900 font-semibold cursor-pointer"
                        >
                          <RotateCcw className="w-3 h-3" />
                          <span>Reset Pasangan</span>
                        </button>
                      )}
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
                      {/* Left Column: Prompts */}
                      <div className="space-y-2.5">
                        <div className="text-xs font-bold uppercase tracking-wide text-slate-500 px-1">
                          Kolom Soal / Pernyataan ({leftItems.length})
                        </div>
                        {leftItems.map((left, idx) => {
                          const assignedRightId = currentMatchingMap[left.id];
                          const matchedRight = assignedRightId
                            ? rightById.get(assignedRightId)
                            : undefined;
                          const isActive = activeMatchingLeftId === left.id;

                          return (
                            <div
                              key={left.id}
                              role="button"
                              tabIndex={0}
                              onClick={() => setActiveMatchingLeftId(left.id)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  setActiveMatchingLeftId(left.id);
                                }
                              }}
                              className={`w-full text-left p-3.5 rounded-xl border transition-all cursor-pointer space-y-2.5 ${
                                isActive
                                  ? 'bg-emerald-50/90 border-[#064e3b] ring-2 ring-[#064e3b]/30 shadow-xs'
                                  : matchedRight
                                    ? 'bg-emerald-50/40 border-emerald-300 hover:border-emerald-500'
                                    : 'bg-white border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                              }`}
                            >
                              <div className="flex items-start gap-3">
                                <span
                                  className={`w-7 h-7 rounded-lg flex items-center justify-center font-mono font-bold text-xs shrink-0 ${
                                    isActive
                                      ? 'bg-[#064e3b] text-white'
                                      : matchedRight
                                        ? 'bg-emerald-700 text-white'
                                        : 'bg-slate-100 text-slate-700'
                                  }`}
                                >
                                  {idx + 1}
                                </span>
                                <div className="min-w-0 flex-1 space-y-1.5 pt-0.5 text-sm text-slate-900">
                                  {left.text && (
                                    <div className="break-words">
                                      <MathText text={left.text} />
                                    </div>
                                  )}
                                  {left.imageUrl && (
                                    <img
                                      src={left.imageUrl}
                                      alt={`Soal Pasangan ${idx + 1}`}
                                      referrerPolicy="no-referrer"
                                      className="max-h-32 w-auto object-contain rounded-lg border border-slate-200 bg-white p-1"
                                    />
                                  )}
                                </div>
                              </div>

                              {matchedRight ? (
                                <div className="flex items-center justify-between gap-2 pl-10 pr-2 py-1.5 rounded-lg bg-white border border-emerald-200 text-xs">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span className="font-mono font-bold px-1.5 py-0.5 rounded bg-emerald-700 text-white shrink-0">
                                      ↔ {matchedRight.letter}
                                    </span>
                                    <span className="text-emerald-950 font-medium truncate">
                                      {matchedRight.item.text ? (
                                        <MathText text={matchedRight.item.text} />
                                      ) : (
                                        `Gambar ${matchedRight.letter}`
                                      )}
                                    </span>
                                  </div>
                                  <button
                                    type="button"
                                    title="Lepas pasangan"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleUnpairMatchingLeft(left.id);
                                    }}
                                    className="p-1 rounded hover:bg-rose-50 text-slate-400 hover:text-rose-600 cursor-pointer shrink-0"
                                  >
                                    <X className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              ) : (
                                <div className="pl-10 text-[11px] font-medium text-slate-500">
                                  {isActive
                                    ? 'Aktif dipilih — klik jawaban di kolom kanan →'
                                    : 'Klik kartu ini lalu pilih pasangan di kanan'}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      {/* Right Column: Shuffled Answers */}
                      <div className="space-y-2.5">
                        <div className="text-xs font-bold uppercase tracking-wide text-emerald-800 px-1">
                          Pilihan Pasangan Jawaban (Teracak)
                        </div>
                        {rightItems.map((right, rIdx) => {
                          const letter = String.fromCharCode(65 + rIdx);
                          const pairedLeftNumber = leftIndexByRightId.get(right.id);
                          const isAssigned = pairedLeftNumber !== undefined;
                          const isAssignedToActive =
                            activeMatchingLeftId !== null &&
                            currentMatchingMap[activeMatchingLeftId] === right.id;

                          return (
                            <button
                              key={right.id}
                              type="button"
                              onClick={() => handlePairMatchingRight(right.id)}
                              className={`w-full text-left p-3.5 rounded-xl border transition-all flex items-start gap-3 cursor-pointer ${
                                isAssignedToActive
                                  ? 'bg-emerald-100/80 border-[#064e3b] ring-1 ring-[#064e3b] text-emerald-950'
                                  : isAssigned
                                    ? 'bg-emerald-50/70 border-emerald-300 text-emerald-950 hover:border-emerald-500'
                                    : activeMatchingLeftId
                                      ? 'bg-white border-slate-200 hover:border-[#064e3b] hover:bg-emerald-50/30 text-slate-800'
                                      : 'bg-white border-slate-200 hover:border-slate-300 text-slate-800'
                              }`}
                            >
                              <span
                                className={`w-7 h-7 rounded-lg flex items-center justify-center font-mono font-bold text-xs shrink-0 ${
                                  isAssigned
                                    ? 'bg-[#064e3b] text-white'
                                    : 'bg-slate-100 text-slate-700'
                                }`}
                              >
                                {letter}
                              </span>
                              <div className="min-w-0 flex-1 space-y-1.5 pt-0.5 text-sm">
                                {right.text && (
                                  <div className="break-words">
                                    <MathText text={right.text} />
                                  </div>
                                )}
                                {right.imageUrl && (
                                  <img
                                    src={right.imageUrl}
                                    alt={`Pilihan Jawaban ${letter}`}
                                    referrerPolicy="no-referrer"
                                    className="max-h-32 w-auto object-contain rounded-lg border border-slate-200 bg-white p-1"
                                  />
                                )}
                              </div>
                              {isAssigned && (
                                <span className="px-2 py-0.5 rounded-md bg-white border border-emerald-300 text-emerald-900 font-mono font-bold text-[11px] shrink-0">
                                  ↔ No. {pairedLeftNumber}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })()
            ) : currentQuestionType === 'true_false' ? (
              <div
                className="grid grid-cols-1 sm:grid-cols-2 gap-3"
                role="radiogroup"
                aria-label="Pilihan Benar atau Salah"
              >
                {visibleOptions.map((opt) => {
                  const isSelected = selectedAnswer === opt.key;
                  const labelText = opt.text || (opt.key === 'A' ? 'Benar' : 'Salah');
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      onClick={() => handleSelectOption(currentQuestion.id, opt.key)}
                      className={`w-full text-left p-4 rounded-xl border transition-all flex items-center justify-between gap-3 cursor-pointer min-h-[60px] ${
                        isSelected
                          ? 'bg-emerald-50 border-emerald-700 ring-1 ring-emerald-700 text-emerald-950'
                          : 'bg-white border-slate-200 hover:border-slate-300 hover:bg-slate-50 text-slate-800'
                      }`}
                    >
                      <div className="flex items-center gap-3.5">
                        <span
                          className={`w-9 h-9 rounded-lg flex items-center justify-center font-mono font-bold text-sm shrink-0 transition-colors ${
                            isSelected
                              ? 'bg-[#064e3b] text-white'
                              : 'bg-slate-100 text-slate-700'
                          }`}
                        >
                          {opt.key === 'A' ? 'B' : 'S'}
                        </span>
                        <span className="font-display font-bold text-base">{labelText}</span>
                      </div>
                      {isSelected && <Check className="w-5 h-5 text-[#064e3b] shrink-0" />}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="space-y-3" role="radiogroup" aria-label="Pilihan Jawaban">
                {visibleOptions.map((opt) => {
                  const isSelected = selectedAnswer === opt.key;
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      onClick={() => handleSelectOption(currentQuestion.id, opt.key)}
                      className={`w-full text-left p-4 rounded-xl border transition-all flex items-start gap-4 cursor-pointer min-h-[52px] ${
                        isSelected
                          ? 'bg-emerald-50 border-emerald-700 ring-1 ring-emerald-700 text-emerald-950'
                          : 'bg-white border-slate-200 hover:border-slate-300 hover:bg-slate-50 text-slate-800'
                      }`}
                    >
                      <span
                        className={`w-8 h-8 rounded-lg flex items-center justify-center font-mono font-bold text-sm shrink-0 transition-colors ${
                          isSelected
                            ? 'bg-[#064e3b] text-white'
                            : 'bg-slate-100 text-slate-700'
                        }`}
                      >
                        {opt.key}
                      </span>
                      <div className="pt-0.5 text-sm sm:text-base leading-relaxed flex-1 space-y-2">
                        {opt.text && (
                          <div>
                            <MathText text={opt.text} />
                          </div>
                        )}
                        {opt.imageUrl && (
                          <img
                            src={opt.imageUrl}
                            alt={`Gambar Opsi ${opt.key}`}
                            referrerPolicy="no-referrer"
                            className="max-h-40 w-auto object-contain rounded-lg border border-slate-200 bg-white p-1"
                          />
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Bottom Question Navigation Footer */}
          <div className="px-5 sm:px-7 py-4 bg-slate-50 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              disabled={session.currentIndex === 0}
              onClick={() => handleJumpQuestion(session.currentIndex - 1)}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 disabled:opacity-40 text-sm font-semibold transition-colors cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4" />
              <span>Sebelumnya</span>
            </button>

            <button
              type="button"
              onClick={() => handleToggleFlag(currentQuestion.id)}
              className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-semibold transition-colors cursor-pointer ${
                isFlagged
                  ? 'bg-amber-100 border-amber-400 text-amber-900'
                  : 'bg-white border-slate-300 text-slate-700 hover:bg-amber-50'
              }`}
            >
              <Flag className="w-4 h-4" />
              <span>{isFlagged ? 'Ditandai Ragu' : 'Ragu-ragu'}</span>
            </button>

            {session.currentIndex < session.questions.length - 1 ? (
              <button
                type="button"
                onClick={() => handleJumpQuestion(session.currentIndex + 1)}
                className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white text-sm font-semibold transition-colors cursor-pointer"
              >
                <span>Selanjutnya</span>
                <ChevronRight className="w-4 h-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setShowSubmitModal(true)}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-semibold transition-colors cursor-pointer"
              >
                <Send className="w-4 h-4" />
                <span>Akhiri Ujian</span>
              </button>
            )}
          </div>
        </section>

        {/* Desktop Sidebar Question Palette */}
        <aside className="hidden lg:block lg:col-span-4 bg-white rounded-2xl border border-slate-200 shadow-xs p-5 space-y-5 sticky top-24">
          <div className="flex items-center justify-between">
            <h2 className="font-display font-bold text-slate-900 text-base">
              Navigasi Soal
            </h2>
            <span className="text-xs font-mono font-semibold text-slate-600 tabular-nums">
              {answeredCount} / {session.questions.length} Terjawab
            </span>
          </div>

          <div className="grid grid-cols-5 gap-2">
            {session.questions.map((q, idx) => {
              const isCurrent = idx === session.currentIndex;
              const isAnswered = isQuestionAnswered(q, session.answers[q.id]);
              const qFlagged = flaggedQuestionSet.has(q.id);

              let cellStyle = 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100';
              if (qFlagged) {
                cellStyle = 'bg-amber-100 border-amber-400 text-amber-900';
              } else if (isAnswered) {
                cellStyle = 'bg-emerald-700 border-emerald-800 text-white';
              }

              return (
                <button
                  key={q.id}
                  type="button"
                  onClick={() => handleJumpQuestion(idx)}
                  className={`h-11 rounded-xl border font-mono text-sm font-bold tabular-nums transition-all cursor-pointer flex items-center justify-center relative ${cellStyle} ${
                    isCurrent ? 'ring-2 ring-offset-2 ring-[#064e3b]' : ''
                  }`}
                >
                  {idx + 1}
                </button>
              );
            })}
          </div>

          <div className="pt-3 border-t border-slate-100 space-y-2 text-xs text-slate-600">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <span className="w-3.5 h-3.5 rounded bg-emerald-700 inline-block" />
                Sudah dijawab
              </span>
              <span className="font-mono font-semibold tabular-nums">{answeredCount}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <span className="w-3.5 h-3.5 rounded bg-amber-300 border border-amber-500 inline-block" />
                Ditandai ragu-ragu
              </span>
              <span className="font-mono font-semibold tabular-nums">
                {session.flaggedQuestions.length}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <span className="w-3.5 h-3.5 rounded bg-slate-100 border border-slate-300 inline-block" />
                Belum dijawab
              </span>
              <span className="font-mono font-semibold tabular-nums">
                {session.questions.length - answeredCount}
              </span>
            </div>
          </div>

          <div className="pt-3 border-t border-slate-100 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-600 font-medium">Pengawas Tab / Fokus</span>
              <span
                className={`font-mono font-bold tabular-nums ${
                  session.tabSwitchCount > 0 ? 'text-amber-700' : 'text-emerald-700'
                }`}
              >
                {session.tabSwitchCount} / {session.schedule.maxTabSwitches} Peringatan
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowSubmitModal(true)}
              className="w-full py-3 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white font-semibold text-sm flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <Send className="w-4 h-4" />
              <span>Akhiri Ujian</span>
            </button>
          </div>
        </aside>
      </main>

      {/* Mobile Navigation Drawer */}
      {showNavDrawer && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-4 lg:hidden">
          <div className="w-full max-w-md bg-white rounded-2xl p-5 space-y-4 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="font-display font-bold text-slate-900">
                Daftar Soal ({answeredCount}/{session.questions.length})
              </h3>
              <button
                type="button"
                onClick={() => setShowNavDrawer(false)}
                className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="grid grid-cols-5 gap-2 max-h-72 overflow-y-auto py-1">
              {session.questions.map((q, idx) => {
                const isCurrent = idx === session.currentIndex;
                const isAnswered = isQuestionAnswered(q, session.answers[q.id]);
                const qFlagged = flaggedQuestionSet.has(q.id);
                let cellStyle = 'bg-slate-50 border-slate-200 text-slate-700';
                if (qFlagged) cellStyle = 'bg-amber-100 border-amber-400 text-amber-900';
                else if (isAnswered) cellStyle = 'bg-emerald-700 border-emerald-800 text-white';

                return (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => handleJumpQuestion(idx)}
                    className={`h-11 rounded-xl border font-mono text-sm font-bold tabular-nums cursor-pointer ${cellStyle} ${
                      isCurrent ? 'ring-2 ring-[#064e3b]' : ''
                    }`}
                  >
                    {idx + 1}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => {
                setShowNavDrawer(false);
                setShowSubmitModal(true);
              }}
              className="w-full py-3 rounded-xl bg-[#064e3b] text-white font-semibold text-sm flex items-center justify-center gap-2 cursor-pointer"
            >
              <Send className="w-4 h-4" />
              <span>Akhiri Ujian</span>
            </button>
          </div>
        </div>
      )}

      {/* Instant Focus-Loss Privacy Shield Overlay (0ms anti-screenshot / system overlay guard) */}
      {isScreenBlurred && !cheatWarningOpen && !isViolationLocked && (
        <div
          onClick={() => setIsScreenBlurred(false)}
          className="fixed inset-0 z-40 bg-slate-950/95 backdrop-blur-md flex items-center justify-center p-6 select-none"
        >
          <div className="max-w-sm w-full bg-slate-900/95 border border-slate-700/80 rounded-2xl p-6 text-center space-y-3 shadow-2xl">
            <div className="w-12 h-12 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center mx-auto">
              <ShieldAlert className="w-6 h-6" />
            </div>
            <h3 className="font-display font-bold text-white text-base">
              Layar Soal Disembunyikan
            </h3>
            <p className="text-xs sm:text-sm text-slate-300 leading-relaxed">
              Jendela ujian sedang tidak aktif atau tertutup overlay sistem. Kembali ke jendela
              ujian untuk melanjutkan pengerjaan.
            </p>
          </div>
        </div>
      )}

      {/* Anti-Cheat Tab Switch / Screenshot Warning Modal */}
      {cheatWarningOpen && !isViolationLocked && (
        <div className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-2xl border border-red-200 p-6 space-y-4 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="w-11 h-11 rounded-xl bg-red-100 text-red-700 flex items-center justify-center shrink-0">
                <ShieldAlert className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-display font-bold text-slate-900 text-lg">
                  {violationReason === 'screenshot'
                    ? 'Upaya Tangkapan Layar Terdeteksi'
                    : 'Perpindahan Tab / Layar Terdeteksi'}
                </h3>
                <p className="text-sm text-slate-600 mt-1 leading-relaxed">
                  {violationReason === 'screenshot'
                    ? 'Penggunaan tombol PrintScreen atau pintasan tangkapan layar dilarang dan dicatat otomatis oleh sistem pengawas.'
                    : 'Aktivitas keluar dari jendela ujian dicatat otomatis oleh sistem pengawas.'}{' '}
                  Pelanggaran tercatat:{' '}
                  <span className="font-mono font-bold text-red-700">
                    {session.tabSwitchCount} / {session.schedule.maxTabSwitches} kali
                  </span>
                  . Jika mencapai batas maksimal, ujian akan terkunci otomatis.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setCheatWarningOpen(false);
                setIsScreenBlurred(false);
                void handleEnterFullscreen();
              }}
              className="w-full py-3 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white font-semibold text-sm cursor-pointer"
            >
              Kembali ke Ujian &amp; Kunci Layar Penuh
            </button>
          </div>
        </div>
      )}

      {/* Violation Lockout Modal */}
      {isViolationLocked && (
        <div className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-2xl border border-red-300 p-6 space-y-4 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="w-12 h-12 rounded-xl bg-red-100 text-red-700 flex items-center justify-center shrink-0">
                <ShieldAlert className="w-7 h-7" />
              </div>
              <div>
                <h3 className="font-display font-bold text-red-900 text-lg">
                  Akses Ujian Terkunci
                </h3>
                <p className="text-sm text-slate-600 mt-1 leading-relaxed">
                  Anda telah mencapai batas maksimal pelanggaran perpindahan tab/layar atau tangkapan layar (
                  <span className="font-mono font-bold text-red-700">
                    {session.tabSwitchCount}/{session.schedule.maxTabSwitches}
                  </span>
                  ). Sesi ujian mata pelajaran <strong>{session.schedule.subject}</strong> telah
                  dikunci dan dilaporkan ke panitia. Hubungi pengawas/admin untuk membuka kunci
                  melalui menu Reset Ujian.
                </p>
              </div>
            </div>
            <button
              type="button"
              disabled={isFinalizingLockout}
              onClick={async () => {
                const res = lockoutPromiseRef.current
                  ? await lockoutPromiseRef.current.catch(() => lockedResult)
                  : lockedResult;
                clearActiveSessionLocal();
                if (document.fullscreenElement && document.exitFullscreen) {
                  void document.exitFullscreen().catch(() => {});
                }
                onExamLocked(res);
              }}
              className="w-full py-3 rounded-xl bg-red-700 hover:bg-red-800 text-white font-semibold text-sm cursor-pointer disabled:opacity-60"
            >
              {isFinalizingLockout ? 'Menyimpan Jawaban Terakhir...' : 'Kembali ke Halaman Login'}
            </button>
          </div>
        </div>
      )}

      {/* Expiry Auto-Submit Queue Modal */}
      {isExpiryQueueing && !isViolationLocked && (
        <div className="fixed inset-0 z-50 bg-slate-950/75 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-2xl border border-emerald-200 p-6 space-y-4 shadow-2xl text-center">
            <div className="w-12 h-12 rounded-xl bg-emerald-100 text-emerald-800 flex items-center justify-center mx-auto">
              <Clock className="w-6 h-6" />
            </div>
            <div className="space-y-1.5">
              <h3 className="font-display font-bold text-slate-900 text-lg">
                Waktu Ujian Telah Habis
              </h3>
              <p className="text-sm text-slate-600 leading-relaxed">
                Jawaban Anda sudah dikunci dan sedang masuk antrean pengiriman otomatis ke server
                sekolah agar tidak terjadi antrean padat. Mohon jangan menutup halaman ini.
              </p>
            </div>
            <button
              type="button"
              disabled={isSubmitting || expiryQueueSecondsLeft > 0}
              onClick={() => void handleFinalizeExam()}
              className="w-full py-3 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white font-semibold text-sm cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isSubmitting
                ? submitProgressText || 'Mengirim Jawaban ke Server...'
                : expiryQueueSecondsLeft > 0
                  ? `Mengantre Pengiriman Otomatis (${expiryQueueSecondsLeft} detik)...`
                  : 'Kirim Jawaban Sekarang'}
            </button>
          </div>
        </div>
      )}

      {/* Final Submit Confirmation Modal */}
      {(showSubmitModal || submitErrorMsg) && !isExpiryQueueing && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 p-6 space-y-5 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="w-11 h-11 rounded-xl bg-emerald-100 text-emerald-800 flex items-center justify-center shrink-0">
                {answeredCount < session.questions.length ? (
                  <AlertTriangle className="w-6 h-6 text-amber-600" />
                ) : (
                  <Check className="w-6 h-6" />
                )}
              </div>
              <div>
                <h3 className="font-display font-bold text-slate-900 text-lg">
                  Konfirmasi Akhiri Ujian
                </h3>
                <p className="text-sm text-slate-600 mt-1 leading-relaxed">
                  Anda telah menjawab{' '}
                  <span className="font-mono font-bold text-slate-900">
                    {answeredCount} dari {session.questions.length}
                  </span>{' '}
                  soal. Jawaban ujian akan dikirim otomatis ke database cloud.
                </p>
              </div>
            </div>

            {isSubmitting && submitProgressText && (
              <div className="text-xs font-medium text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-600 animate-pulse shrink-0" />
                <span>{submitProgressText}</span>
              </div>
            )}

            {submitErrorMsg && (
              <div className="text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
                {submitErrorMsg}
              </div>
            )}

            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => {
                  setSubmitErrorMsg('');
                  setShowSubmitModal(false);
                }}
                className="flex-1 py-3 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-50 font-semibold text-sm cursor-pointer disabled:opacity-50"
              >
                Periksa Lagi
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => void handleFinalizeExam()}
                className="flex-1 py-3 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white font-semibold text-sm cursor-pointer disabled:opacity-60"
              >
                {isSubmitting ? 'Mengirim Jawaban...' : 'Ya, Akhiri & Kirim'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
