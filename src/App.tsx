import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Lock, User, X } from 'lucide-react';
import {
  authenticateStaff,
  autoFinalizeExpiredExams,
  checkLiveSessionStatusFromCloud,
  checkStudentExamLock,
  clearActiveSessionLocal,
  clearAllDashboardExamLogs,
  clearAllParticipants,
  clearAllQuestions,
  clearAllSchedules,
  deleteExamResultLocalById,
  deleteExamSchedule,
  deleteParticipant,
  deleteQuestion,
  deleteQuestionsBatch,
  deleteStaffAccount,
  ensureInitialized,
  flushPendingSyncQueue,
  forceDeleteExamResultForReset,
  forceFinishExamResults,
  getAdminQuestions,
  getExamResults,
  getExamSchedules,
  getHiddenDashboardLogs,
  getParticipants,
  getSavedActiveSession,
  getSchoolProfile,
  getServerNowMs,
  getStaffAccounts,
  getStudentQuestionsForClass,
  hideDashboardExamLogs,
  resetBulkExamResults,
  saveActiveSessionLocal,
  saveSchoolProfile,
  setActiveStaffCredentials,
  subscribeDataChanges,
  submitFinalExam,
  syncFromSupabase,
  syncServerClock,
  syncStudentResultsFromCloud,
  upsertExamProgress,
  upsertExamSchedule,
  upsertParticipants,
  upsertQuestions,
  upsertStaffAccount,
  verifyStudentCanStartExam,
} from '@/src/lib/dataStore';
import { prepareMatchingForStudentSession } from '@/src/lib/questionUtils';
import { SEED_SCHOOL_PROFILE } from '@/src/lib/seedData';
import { getSupabaseClient, getSupabaseConfig, isLiveSupabaseConfigured } from '@/src/lib/supabase';
import type {
  ActiveExamSession,
  ExamResult,
  ExamSchedule,
  Participant,
  Question,
  SchoolProfile,
  StaffAccount,
} from '@/src/types/cbt';
import { ExamCompletedView } from '@/src/components/ExamCompletedView';
import { ExamRoom } from '@/src/components/ExamRoom';
import { StudentLoginPage } from '@/src/components/StudentLoginPage';
import { AdminConsole } from '@/src/components/admin/AdminConsole';

type AppRoute = 'student-login' | 'exam-room' | 'exam-completed' | 'admin';

const ADMIN_SESSION_DRAFT_PREFIXES = [
  'cbt_draft_q_',
  'cbt_draft_ptc_',
  'cbt_draft_role_',
  'cbt_draft_branding_',
  'cbt_draft_db_',
  'cbt_db_active_subtab_',
];

function clearAdminDraftSessionStorage(): void {
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key && ADMIN_SESSION_DRAFT_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((k) => sessionStorage.removeItem(k));
  } catch {
    // Ignore sessionStorage restrictions
  }
}

function hashString32(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function createSeededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Mengacak urutan soal secara unik per peserta, jadwal ujian, & token percobaan.
 * Ketika `randomizeQuestions` aktif, siswa yang di-reset pun mendapat urutan baru.
 */
function shuffleQuestionsForParticipant<T extends { id: string }>(
  items: T[],
  participantSeed: string
): T[] {
  if (items.length < 2) return [...items];

  const seed = hashString32(participantSeed);
  const rand = createSeededRandom(seed);
  rand();
  rand();

  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  const isSameAsOriginal = copy.every((item, idx) => item.id === items[idx].id);
  if (isSameAsOriginal) {
    const shift = (seed % (copy.length - 1)) + 1;
    return [...copy.slice(shift), ...copy.slice(0, shift)];
  }
  return copy;
}

export default function App() {
  const [route, setRoute] = useState<AppRoute>('student-login');
  const [isReady, setIsReady] = useState(false);

  const [profile, setProfile] = useState<SchoolProfile>(SEED_SCHOOL_PROFILE);
  const [staffAccounts, setStaffAccounts] = useState<StaffAccount[]>([]);
  const [currentStaff, setCurrentStaff] = useState<StaffAccount | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [schedules, setSchedules] = useState<ExamSchedule[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [results, setResults] = useState<ExamResult[]>([]);
  const [hiddenDashboardLogs, setHiddenDashboardLogs] = useState<Record<string, string>>({});

  const [activeSession, setActiveSession] = useState<ActiveExamSession | null>(null);
  const [completedResult, setCompletedResult] = useState<ExamResult | null>(null);
  const [sessionNotice, setSessionNotice] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);

  const [showAdminModal, setShowAdminModal] = useState(false);
  const [adminIdInput, setAdminIdInput] = useState('');
  const [adminPinInput, setAdminPinInput] = useState('');
  const [adminPinError, setAdminPinError] = useState('');
  const [isAuthenticatingAdmin, setIsAuthenticatingAdmin] = useState(false);

  const routeRef = useRef(route);
  routeRef.current = route;
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;
  const staffRevokedRef = useRef(false);

  const loadAllData = useCallback(async (topic?: string) => {
    await ensureInitialized();

    const applyStaff = (staff: StaffAccount[]) => {
      setStaffAccounts((prev) =>
        prev.length === staff.length && JSON.stringify(prev) === JSON.stringify(staff)
          ? prev
          : staff
      );
      setCurrentStaff((prev) => {
        if (!prev) return null;
        const latest = staff.find(
          (s) =>
            s.id === prev.id ||
            s.userId.trim().toLowerCase() === prev.userId.trim().toLowerCase()
        );
        if (!latest || !latest.isActive) {
          staffRevokedRef.current = true;
          setActiveStaffCredentials(null);
          return null;
        }
        return JSON.stringify(prev) === JSON.stringify(latest) ? prev : latest;
      });
    };

    const applyProfile = (prof: SchoolProfile) => {
      setProfile((prev) => (JSON.stringify(prev) === JSON.stringify(prof) ? prev : prof));
    };

    const fetchTopic = async (t: string): Promise<void> => {
      if (t === 'results' || t === 'sync_flushed') {
        const res = await getExamResults();
        setResults((prev) => (prev === res ? prev : res));
      } else if (t === 'schedules' || t === 'schedules_admin_sync') {
        const scheds = await getExamSchedules();
        setSchedules((prev) => (prev === scheds ? prev : scheds));
      } else if (t === 'participants') {
        const parts = await getParticipants();
        setParticipants((prev) => (prev === parts ? prev : parts));
      } else if (t === 'questions' || t === 'questions_admin_sync') {
        const quests = await getAdminQuestions();
        setQuestions((prev) => (prev === quests ? prev : quests));
      } else if (t === 'profile') {
        const prof = await getSchoolProfile();
        applyProfile(prof);
      } else if (t === 'staff_accounts') {
        const staff = await getStaffAccounts();
        applyStaff(staff);
      } else if (t === 'dashboard_logs') {
        const hiddenLogs = await getHiddenDashboardLogs();
        setHiddenDashboardLogs((prev) =>
          JSON.stringify(prev) === JSON.stringify(hiddenLogs) ? prev : hiddenLogs
        );
      }
    };

    if (topic && topic.startsWith('supabase_pull_changed:')) {
      const changedList = topic
        .slice('supabase_pull_changed:'.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (changedList.length > 0) {
        await Promise.all(changedList.map((t) => fetchTopic(t)));
      }
      return;
    }

    if (
      topic === 'results' ||
      topic === 'sync_flushed' ||
      topic === 'schedules' ||
      topic === 'schedules_admin_sync' ||
      topic === 'participants' ||
      topic === 'questions' ||
      topic === 'questions_admin_sync' ||
      topic === 'profile' ||
      topic === 'staff_accounts' ||
      topic === 'dashboard_logs'
    ) {
      await fetchTopic(topic);
      return;
    }
    if (topic === 'supabase_pull_student' || routeRef.current === 'exam-room') {
      const [prof, scheds, res] = await Promise.all([
        getSchoolProfile(),
        getExamSchedules(),
        getExamResults(),
      ]);
      applyProfile(prof);
      setSchedules((prev) => (prev === scheds ? prev : scheds));
      setResults((prev) => (prev === res ? prev : res));
      return;
    }

    const [prof, staff, parts, scheds, quests, res, hiddenLogs] = await Promise.all([
      getSchoolProfile(),
      getStaffAccounts(),
      getParticipants(),
      getExamSchedules(),
      getAdminQuestions(),
      getExamResults(),
      getHiddenDashboardLogs(),
    ]);
    applyProfile(prof);
    applyStaff(staff);
    setParticipants((prev) => (prev === parts ? prev : parts));
    setSchedules((prev) => (prev === scheds ? prev : scheds));
    setQuestions((prev) => (prev === quests ? prev : quests));
    setResults((prev) => (prev === res ? prev : res));
    setHiddenDashboardLogs((prev) =>
      JSON.stringify(prev) === JSON.stringify(hiddenLogs) ? prev : hiddenLogs
    );
  }, []);

  useEffect(() => {
    if (route === 'admin' && !currentStaff) {
      clearAdminDraftSessionStorage();
      setActiveStaffCredentials(null);
      setRoute('student-login');
      if (staffRevokedRef.current) {
        staffRevokedRef.current = false;
        setSessionNotice(
          'Sesi panel panitia dihentikan karena akun staf Anda dinonaktifkan atau dihapus oleh Administrator.'
        );
      }
    }
  }, [route, currentStaff]);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      await ensureInitialized();
      const savedInitial = getSavedActiveSession();
      if (isLiveSupabaseConfigured()) {
        await syncFromSupabase({
          force: false,
          currentParticipantNumber: savedInitial?.participant.participantNumber,
        });
        if (savedInitial?.participant.participantNumber) {
          await syncStudentResultsFromCloud(savedInitial.participant.participantNumber);
        }
      }
      await loadAllData();
      const autoFinalizedCount = await autoFinalizeExpiredExams({
        currentParticipantNumber: savedInitial?.participant.participantNumber,
        isAdmin: false,
      });
      if (autoFinalizedCount > 0 && mounted) {
        await loadAllData();
      }
      const savedSession = getSavedActiveSession();
      if (mounted && savedSession && savedSession.questions.length > 0) {
        const currentResults = await getExamResults();
        const existingRecord = currentResults.find(
          (r) =>
            r.id === savedSession.resultId ||
            (r.participantNumber.toUpperCase() ===
              savedSession.participant.participantNumber.toUpperCase() &&
              r.examId === savedSession.schedule.id)
        );
        if (!existingRecord) {
          clearActiveSessionLocal();
        } else if (existingRecord.status === 'submitted' || existingRecord.status === 'flagged') {
          clearActiveSessionLocal();
          if (mounted) {
            setCompletedResult(existingRecord);
            setRoute('exam-completed');
          }
        } else if (getServerNowMs() >= new Date(savedSession.endsAt).getTime()) {
          const finalized = await submitFinalExam(savedSession);
          if (mounted) {
            await loadAllData();
            setCompletedResult(finalized);
            setRoute('exam-completed');
          }
        } else {
          setActiveSession(savedSession);
          setRoute('exam-room');
          void upsertExamProgress(savedSession, { includeQuestionIds: true });
        }
      }
      if (mounted) setIsReady(true);
    })();

    const unsubscribe = subscribeDataChanges((topic) => {
      void loadAllData(topic);
    });

    const cfgSync = getSupabaseConfig();
    const intervalMs = Math.max(5, cfgSync.autoSyncIntervalSec || 25) * 1000;
    const adminEffectiveIntervalMs = Math.max(25_000, intervalMs);
    let lastStudentSyncAt = Date.now();
    let lastAdminSyncAt = Date.now();
    const syncInterval = window.setInterval(() => {
      if (document.hidden) return;
      const currentRoute = routeRef.current;
      const isAdminRoute = currentRoute === 'admin';
      const now = Date.now();
      if (isAdminRoute) {
        if (now - lastAdminSyncAt < adminEffectiveIntervalMs) return;
        lastAdminSyncAt = now;
      } else {
        if (now - lastStudentSyncAt < Math.max(45_000, intervalMs)) return;
        lastStudentSyncAt = now;
      }
      void (async () => {
        await flushPendingSyncQueue();
        // Selama berada di ExamRoom, status cloud (Reset/Paksa Selesai) sudah dipantau oleh checkLiveSessionStatusFromCloud
        // sehingga tidak perlu mengunduh ulang jadwal/profil setiap siklus.
        if (currentRoute === 'exam-room') {
          return;
        }
        await syncFromSupabase({
          currentParticipantNumber: activeSessionRef.current?.participant.participantNumber,
          isAdmin: isAdminRoute,
          resultsOnly: isAdminRoute,
        });
      })();
    }, intervalMs);

    const expiryInterval = window.setInterval(() => {
      const isAdminRoute = routeRef.current === 'admin';
      if (!isAdminRoute && !activeSessionRef.current) return;
      void autoFinalizeExpiredExams({
        currentParticipantNumber: activeSessionRef.current?.participant.participantNumber,
        isAdmin: isAdminRoute,
      });
    }, 25_000);

    const onOnline = () => {
      void (async () => {
        await flushPendingSyncQueue();
        await syncFromSupabase({
          force: true,
          currentParticipantNumber: activeSessionRef.current?.participant.participantNumber,
          isAdmin: routeRef.current === 'admin',
        });
        await autoFinalizeExpiredExams({
          currentParticipantNumber: activeSessionRef.current?.participant.participantNumber,
          isAdmin: routeRef.current === 'admin',
        });
      })();
    };
    window.addEventListener('online', onOnline);

    return () => {
      mounted = false;
      unsubscribe();
      window.clearInterval(syncInterval);
      window.clearInterval(expiryInterval);
      window.removeEventListener('online', onOnline);
    };
  }, [loadAllData]);

  // Monitor hasil ujian aktif terhadap paksa-selesai ATAU Reset Ujian dari Proktor/Admin
  useEffect(() => {
    if (route !== 'exam-room' || !activeSession) return;
    const matching = results.find(
      (r) =>
        r.id === activeSession.resultId ||
        (r.participantNumber.trim().toUpperCase() ===
          activeSession.participant.participantNumber.trim().toUpperCase() &&
          r.examId === activeSession.schedule.id)
    );
    if (
      matching &&
      (matching.status === 'submitted' ||
        (matching.status === 'flagged' && matching.submittedAt !== null))
    ) {
      clearActiveSessionLocal();
      if (document.fullscreenElement && document.exitFullscreen) {
        void document.exitFullscreen().catch(() => {});
      }
      setActiveSession(null);
      setCompletedResult(matching);
      setRoute('exam-completed');
    }
  }, [route, activeSession, results]);

  // Polling cloud status selama berada di ExamRoom untuk mendeteksi Reset Ujian / Paksa Selesai seketika
  useEffect(() => {
    if (route !== 'exam-room' || !activeSession || !isLiveSupabaseConfigured()) return;
    let active = true;
    const checkCloud = async () => {
      if (document.hidden) return;
      const res = await checkLiveSessionStatusFromCloud(
        activeSession.participant.participantNumber,
        activeSession.schedule.id
      );
      if (!active) return;
      if (res.status === 'finalized' && res.result) {
        clearActiveSessionLocal();
        if (document.fullscreenElement && document.exitFullscreen) {
          void document.exitFullscreen().catch(() => {});
        }
        setActiveSession(null);
        setCompletedResult(res.result);
        setRoute('exam-completed');
      } else if (res.status === 'reset_deleted') {
        await forceDeleteExamResultForReset(
          activeSession.participant.participantNumber,
          activeSession.schedule.id
        );
        clearActiveSessionLocal();
        if (document.fullscreenElement && document.exitFullscreen) {
          void document.exitFullscreen().catch(() => {});
        }
        setActiveSession(null);
        setSessionNotice(
          `Sesi ujian ${activeSession.schedule.subject} untuk peserta ${activeSession.participant.participantNumber} telah di-reset oleh Panitia / Proktor.`
        );
        setRoute('student-login');
        void loadAllData('results');
      }
    };

    const pollMs = 45_000 + Math.floor(Math.random() * 15_000);
    const timer = window.setInterval(() => {
      void checkCloud();
    }, pollMs);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [route, activeSession, loadAllData]);

  // Multi-table Supabase Realtime sync (diaktifkan khusus pada Portal Admin/Proktor agar 800+ siswa tidak terkena badai broadcast N^2)
  const isAdminRoute = route === 'admin';
  useEffect(() => {
    const cfg = getSupabaseConfig();
    if (!isAdminRoute || !isLiveSupabaseConfigured() || cfg.enableRealtime === false) return;
    const supabase = getSupabaseClient();
    const ADMIN_REALTIME_THROTTLE_MS = 25_000;
    let throttleTimer: number | null = null;
    let lastPullAt = 0;
    let needsFullStaticPull = false;

    const flushPull = () => {
      if (throttleTimer) {
        window.clearTimeout(throttleTimer);
        throttleTimer = null;
      }
      lastPullAt = Date.now();
      const pullFull = needsFullStaticPull;
      needsFullStaticPull = false;
      void syncFromSupabase({
        force: pullFull,
        currentParticipantNumber: activeSessionRef.current?.participant.participantNumber,
        isAdmin: true,
        resultsOnly: !pullFull,
      });
    };

    const triggerPull = (resultsOnly: boolean) => {
      if (!resultsOnly) {
        needsFullStaticPull = true;
      }
      if (throttleTimer) return;
      const elapsed = Date.now() - lastPullAt;
      const delayMs =
        elapsed >= ADMIN_REALTIME_THROTTLE_MS
          ? 1500
          : Math.max(1500, ADMIN_REALTIME_THROTTLE_MS - elapsed);
      throttleTimer = window.setTimeout(flushPull, delayMs);
    };

    const schema = cfg.schema || 'public';
    const channel = supabase
      .channel('cbt_admin_realtime')
      .on('postgres_changes', { event: '*', schema, table: 'exam_results' }, (payload) => {
        if (payload.eventType === 'DELETE' && payload.old && 'id' in payload.old) {
          void deleteExamResultLocalById(String((payload.old as { id?: unknown }).id || ''));
          return;
        }
        triggerPull(true);
      })
      .on('postgres_changes', { event: '*', schema, table: 'exam_schedules' }, () =>
        triggerPull(false)
      )
      .on('postgres_changes', { event: '*', schema, table: 'participants' }, () =>
        triggerPull(false)
      )
      .on('postgres_changes', { event: '*', schema, table: 'school_profile' }, () =>
        triggerPull(false)
      )
      .on('postgres_changes', { event: '*', schema, table: 'staff_accounts' }, () =>
        triggerPull(false)
      )
      .subscribe();

    return () => {
      if (throttleTimer) window.clearTimeout(throttleTimer);
      void supabase.removeChannel(channel);
    };
  }, [isAdminRoute]);

  const handleStartExam = async (participant: Participant, schedule: ExamSchedule) => {
    setSessionNotice('');
    const preflight = await verifyStudentCanStartExam(
      participant.participantNumber,
      schedule.id
    );
    if (!preflight.ok || !preflight.participant || !preflight.schedule) {
      throw new Error(
        preflight.message || 'Peserta atau jadwal ujian tidak aktif saat ini.'
      );
    }

    const freshParticipant = preflight.participant;
    const freshSchedule = preflight.schedule;

    const lockCheck = await checkStudentExamLock(
      freshParticipant.participantNumber,
      freshSchedule
    );
    if (lockCheck.locked) {
      if (lockCheck.reason === 'network_error') {
        throw new Error(
          lockCheck.errorMessage ||
            'Gagal terhubung ke server untuk memeriksa status ujian. Silakan coba lagi.'
        );
      }
      if (lockCheck.reason === 'submitted') {
        throw new Error(
          `Anda telah menyelesaikan ujian mata pelajaran ${freshSchedule.subject} dan tidak dapat mengulanginya.`
        );
      }
      if (lockCheck.reason === 'flagged') {
        throw new Error(
          `Akses ujian ${freshSchedule.subject} terkunci karena pelanggaran. Hubungi admin untuk Reset Ujian.`
        );
      }
      if (lockCheck.reason === 'in_progress' && lockCheck.result) {
        const safeQuestions = await getStudentQuestionsForClass(
          freshParticipant.className,
          freshSchedule.subject
        );
        if (safeQuestions.length === 0) {
          throw new Error(
            `Belum ada butir soal mata pelajaran ${freshSchedule.subject} untuk kelas ${freshParticipant.className}. Hubungi panitia ujian.`
          );
        }

        await syncServerClock(false);
        const rawStartedMs = new Date(lockCheck.result.startedAt).getTime();
        const startedMs = Number.isFinite(rawStartedMs) ? rawStartedMs : getServerNowMs();

        let orderedQuestions = safeQuestions;
        if (lockCheck.result.questionIds && lockCheck.result.questionIds.length > 0) {
          const byId = new Map(safeQuestions.map((q) => [q.id, q]));
          const restored: typeof safeQuestions = [];
          const seen = new Set<string>();
          for (const qId of lockCheck.result.questionIds) {
            const matched = byId.get(qId);
            if (matched && !seen.has(qId)) {
              restored.push(matched);
              seen.add(qId);
            }
          }
          for (const q of safeQuestions) {
            if (!seen.has(q.id)) {
              restored.push(q);
            }
          }
          if (restored.length > 0) {
            orderedQuestions = restored;
          }
        } else if (freshSchedule.randomizeQuestions) {
          orderedQuestions = shuffleQuestionsForParticipant(
            safeQuestions,
            `${freshParticipant.participantNumber.trim().toUpperCase()}::${freshSchedule.id}::${startedMs}`
          );
        }

        const sessionQuestions = prepareMatchingForStudentSession(
          orderedQuestions,
          `${freshParticipant.participantNumber.trim().toUpperCase()}::${freshSchedule.id}::${startedMs}`
        );
        const endsAt = new Date(startedMs + freshSchedule.durationMinutes * 60 * 1000);

        const resumedSession: ActiveExamSession = {
          resultId:
            lockCheck.result.id ||
            `res-${freshParticipant.participantNumber}-${freshSchedule.id}`,
          participant: freshParticipant,
          schedule: freshSchedule,
          questions: sessionQuestions,
          answers: { ...(lockCheck.result.answers || {}) },
          flaggedQuestions: [...(lockCheck.result.flaggedQuestions || [])],
          currentIndex: 0,
          tabSwitchCount: lockCheck.result.tabSwitchCount || 0,
          startedAt: lockCheck.result.startedAt || new Date(startedMs).toISOString(),
          endsAt: endsAt.toISOString(),
        };

        saveActiveSessionLocal(resumedSession);
        await upsertExamProgress(resumedSession, { includeQuestionIds: true });
        await loadAllData('results');
        setActiveSession(resumedSession);
        setRoute('exam-room');
        return;
      }
      throw new Error(
        `Peserta sudah masuk / memulai ujian pada mata pelajaran ${freshSchedule.subject}. Hubungi admin untuk Reset Ujian.`
      );
    }

    const safeQuestions = await getStudentQuestionsForClass(
      freshParticipant.className,
      freshSchedule.subject
    );
    if (safeQuestions.length === 0) {
      throw new Error(
        `Belum ada butir soal mata pelajaran ${freshSchedule.subject} untuk kelas ${freshParticipant.className}. Hubungi panitia ujian.`
      );
    }

    await syncServerClock(false);
    const serverNowMs = getServerNowMs();

    const orderedQuestions = freshSchedule.randomizeQuestions
      ? shuffleQuestionsForParticipant(
          safeQuestions,
          `${freshParticipant.participantNumber.trim().toUpperCase()}::${freshSchedule.id}::${serverNowMs}`
        )
      : safeQuestions;

    const sessionQuestions = prepareMatchingForStudentSession(
      orderedQuestions,
      `${freshParticipant.participantNumber.trim().toUpperCase()}::${freshSchedule.id}::${serverNowMs}`
    );

    const endsAt = new Date(serverNowMs + freshSchedule.durationMinutes * 60 * 1000);
    const session: ActiveExamSession = {
      resultId: `res-${freshParticipant.participantNumber}-${freshSchedule.id}`,
      participant: freshParticipant,
      schedule: freshSchedule,
      questions: sessionQuestions,
      answers: {},
      flaggedQuestions: [],
      currentIndex: 0,
      tabSwitchCount: 0,
      startedAt: new Date(serverNowMs).toISOString(),
      endsAt: endsAt.toISOString(),
    };

    saveActiveSessionLocal(session);
    await upsertExamProgress(session, { includeQuestionIds: true });
    await loadAllData('results');
    setActiveSession(session);
    setRoute('exam-room');
  };

  const handleExamCompleted = (result: ExamResult) => {
    setActiveSession(null);
    setCompletedResult(result);
    setRoute('exam-completed');
    void loadAllData('results');
  };

  const handleForceSync = async () => {
    setIsSyncing(true);
    try {
      await flushPendingSyncQueue();
      await syncFromSupabase({ force: true, isAdmin: routeRef.current === 'admin' });
      await loadAllData();
    } finally {
      setIsSyncing(false);
    }
  };

  const handleAdminSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdminPinError('');
    setIsAuthenticatingAdmin(true);
    try {
      const auth = await authenticateStaff(adminIdInput, adminPinInput);
      if (auth.ok && auth.staff) {
        clearAdminDraftSessionStorage();
        setCurrentStaff(auth.staff);
        setShowAdminModal(false);
        setAdminIdInput('');
        setAdminPinInput('');
        setAdminPinError('');
        setSessionNotice('');
        setRoute('admin');
        if (isLiveSupabaseConfigured()) {
          void syncFromSupabase({ force: true, isAdmin: true }).then(() => loadAllData());
        }
      } else {
        setAdminPinError(auth.message || 'ID atau Sandi Panitia tidak sesuai.');
      }
    } finally {
      setIsAuthenticatingAdmin(false);
    }
  };

  if (!isReady) {
    return (
      <div className="min-h-screen bg-[#e0f2fe] flex items-center justify-center text-sky-950 text-sm font-medium">
        Menyiapkan penyimpanan lokal &amp; koneksi sistem ujian...
      </div>
    );
  }

  return (
    <>
      {route === 'student-login' && (
        <StudentLoginPage
          profile={profile}
          schedules={schedules}
          results={results}
          sessionNotice={sessionNotice}
          onDismissNotice={() => setSessionNotice('')}
          onStartExam={handleStartExam}
          onOpenAdmin={() => {
            setAdminPinError('');
            setShowAdminModal(true);
          }}
        />
      )}

      {route === 'exam-room' && activeSession && (
        <ExamRoom
          profile={profile}
          initialSession={activeSession}
          onExamCompleted={handleExamCompleted}
          onExamLocked={(lockedResult) => {
            clearActiveSessionLocal();
            setActiveSession(null);
            if (lockedResult) {
              setSessionNotice(
                `Ujian ${lockedResult.subject} terkunci otomatis karena melewati batas pelanggaran tab. Jawaban terakhir Anda telah disimpan & dinilai.`
              );
            }
            setRoute('student-login');
            void loadAllData('results');
          }}
        />
      )}

      {route === 'exam-completed' && completedResult && (
        <ExamCompletedView
          profile={profile}
          result={completedResult}
          onReturnLogin={() => {
            setCompletedResult(null);
            setRoute('student-login');
          }}
        />
      )}

      {route === 'admin' && currentStaff && (
        <AdminConsole
          profile={profile}
          currentStaff={currentStaff}
          staffAccounts={staffAccounts}
          participants={participants}
          schedules={schedules}
          questions={questions}
          results={results}
          hiddenDashboardLogs={hiddenDashboardLogs}
          isSyncing={isSyncing}
          onForceSync={handleForceSync}
          onSaveProfile={async (updated) => {
            await saveSchoolProfile(updated);
            await Promise.all([loadAllData('profile'), loadAllData('staff_accounts')]);
          }}
          onUpsertParticipants={async (items) => {
            await upsertParticipants(items);
            await loadAllData('participants');
          }}
          onDeleteParticipant={async (id) => {
            await deleteParticipant(id);
            await loadAllData('participants');
          }}
          onDeleteAllParticipants={async () => {
            await clearAllParticipants();
            await loadAllData('participants');
          }}
          onSaveSchedule={async (schedule) => {
            const syncRes = await upsertExamSchedule(schedule);
            await loadAllData('schedules');
            return syncRes;
          }}
          onDeleteSchedule={async (id) => {
            const syncRes = await deleteExamSchedule(id);
            await loadAllData('schedules');
            return syncRes;
          }}
          onDeleteAllSchedules={async (allowedSubjects) => {
            await clearAllSchedules(allowedSubjects);
            await loadAllData('schedules');
          }}
          onUpsertQuestions={async (items) => {
            const syncRes = await upsertQuestions(items);
            await loadAllData('questions');
            return syncRes;
          }}
          onDeleteQuestion={async (id) => {
            const syncRes = await deleteQuestion(id);
            await loadAllData('questions');
            return syncRes;
          }}
          onDeleteQuestionsBatch={async (ids) => {
            await deleteQuestionsBatch(ids);
            await loadAllData('questions');
          }}
          onDeleteAllQuestions={async (allowedSubjects) => {
            await clearAllQuestions(allowedSubjects);
            await loadAllData('questions');
          }}
          onForceFinishExamResults={async (resultIds) => {
            const res = await forceFinishExamResults(resultIds);
            await loadAllData('results');
            return res.finishedCount;
          }}
          onHideDashboardLogs={async (items) => {
            await hideDashboardExamLogs(items);
            await loadAllData('dashboard_logs');
          }}
          onClearDashboardLogs={async () => {
            await clearAllDashboardExamLogs();
            await loadAllData('dashboard_logs');
          }}
          onResetExamResults={async (resultIds) => {
            await resetBulkExamResults(resultIds);
            await loadAllData('results');
          }}
          onUpsertStaff={async (account) => {
            const syncRes = await upsertStaffAccount(account);
            await loadAllData('staff_accounts');
            return syncRes;
          }}
          onDeleteStaff={async (id) => {
            const syncRes = await deleteStaffAccount(id);
            await loadAllData('staff_accounts');
            return syncRes;
          }}
          onRefreshAll={loadAllData}
          onExitAdmin={() => {
            clearAdminDraftSessionStorage();
            setActiveStaffCredentials(null);
            setCurrentStaff(null);
            setRoute('student-login');
          }}
        />
      )}

      {/* Admin & Committee Role Login Modal */}
      {showAdminModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden">
            <div className="bg-[#064e3b] px-5 py-4 text-white flex items-center justify-between">
              <div className="flex items-center gap-2 font-display font-bold text-base">
                <Lock className="w-4 h-4 text-emerald-200" />
                <span>Masuk Portal Admin &amp; Panitia</span>
              </div>
              <button
                type="button"
                onClick={() => setShowAdminModal(false)}
                className="p-1 rounded-lg hover:bg-white/10 text-emerald-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={(e) => void handleAdminSubmit(e)} className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  ID Role / Pengguna (Admin, Proktor, Guru Mapel)
                </label>
                <div className="relative">
                  <User className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    autoFocus
                    autoComplete="username"
                    value={adminIdInput}
                    onChange={(e) => {
                      setAdminIdInput(e.target.value);
                      setAdminPinError('');
                    }}
                    placeholder="Masukkan ID Anda"
                    className="w-full pl-10 pr-3.5 py-2.5 rounded-xl border border-slate-300 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Sandi / PIN Akses
                </label>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={adminPinInput}
                  onChange={(e) => {
                    setAdminPinInput(e.target.value);
                    setAdminPinError('');
                  }}
                  placeholder="Masukkan sandi akses"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
                />
              </div>

              {adminPinError && (
                <div className="text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg p-2.5">
                  {adminPinError}
                </div>
              )}

              <button
                type="submit"
                disabled={isAuthenticatingAdmin}
                className="w-full py-2.5 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white text-sm font-semibold cursor-pointer disabled:opacity-60"
              >
                {isAuthenticatingAdmin ? 'Memverifikasi...' : 'Buka Panel Admin'}
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
