import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, Database, Download, Lock, User, X } from 'lucide-react';
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
  normalizeParticipantNumber,
  resetBulkExamResults,
  saveActiveSessionLocal,
  saveLocalResultProgressSnapshot,
  saveSchoolProfile,
  setActiveStaffCredentials,
  subscribeDataChanges,
  submitFinalExam,
  syncFromSupabase,
  syncServerClock,
  type SyncTableScope,
  upsertExamProgress,
  upsertExamSchedule,
  upsertParticipants,
  upsertQuestions,
  upsertStaffAccount,
  verifyStudentCanStartExam,
} from '@/src/lib/dataStore';
import { prepareMatchingForStudentSession } from '@/src/lib/questionUtils';
import { SEED_SCHOOL_PROFILE } from '@/src/lib/seedData';
import {
  getSupabaseClient,
  getSupabaseConfig,
  isLiveSupabaseConfigured,
} from '@/src/lib/supabase';
import type {
  ActiveExamSession,
  ExamResult,
  ExamSchedule,
  Participant,
  Question,
  SchoolProfile,
  StaffAccount,
} from '@/src/types/cbt';
import { StudentLoginPage } from '@/src/components/StudentLoginPage';

const loadExamRoomModule = () => import('@/src/components/ExamRoom');
const ExamRoom = lazy(() =>
  loadExamRoomModule().then((m) => ({ default: m.ExamRoom }))
);
const ExamCompletedView = lazy(() =>
  import('@/src/components/ExamCompletedView').then((m) => ({
    default: m.ExamCompletedView,
  }))
);
const AdminConsole = lazy(() =>
  import('@/src/components/admin/AdminConsole').then((m) => ({
    default: m.AdminConsole,
  }))
);

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
  const [adminSqlUpdateRequired, setAdminSqlUpdateRequired] = useState(false);
  const [copiedRecoveryField, setCopiedRecoveryField] = useState<'schema' | 'reset' | null>(null);
  const [isAuthenticatingAdmin, setIsAuthenticatingAdmin] = useState(false);

  const routeRef = useRef(route);
  routeRef.current = route;
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;
  const completedResultRef = useRef(completedResult);
  completedResultRef.current = completedResult;
  const staffRevokedRef = useRef(false);
  const initialProgressSyncTimerRef = useRef<number | null>(null);

  const clearInitialProgressSyncTimer = useCallback(() => {
    if (initialProgressSyncTimerRef.current !== null) {
      window.clearTimeout(initialProgressSyncTimerRef.current);
      initialProgressSyncTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearInitialProgressSyncTimer();
    };
  }, [clearInitialProgressSyncTimer]);

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
      setProfile((prev) => {
        if (
          prev.updatedAt === prof.updatedAt &&
          prev.schoolName === prof.schoolName &&
          prev.address === prof.address &&
          prev.academicYear === prof.academicYear &&
          prev.principalName === prof.principalName &&
          prev.committeeChairName === prof.committeeChairName &&
          prev.examTitle === prof.examTitle &&
          prev.adminPassword === prof.adminPassword &&
          prev.logoDataUrl.length === prof.logoDataUrl.length &&
          (prev.kemenagLogoDataUrl?.length || 0) === (prof.kemenagLogoDataUrl?.length || 0) &&
          prev.logoDataUrl === prof.logoDataUrl &&
          (prev.kemenagLogoDataUrl || '') === (prof.kemenagLogoDataUrl || '')
        ) {
          return prev;
        }
        return prof;
      });
    };

    const fetchTopic = async (t: string): Promise<void> => {
      if (t === 'results' || t === 'sync_flushed') {
        const res = await getExamResults();
        // Selama di ruang ujian, hindari re-render App setiap 3.5 detik untuk progres in_progress rutin
        // kecuali status ujian aktif berubah menjadi submitted/flagged.
        if (routeRef.current === 'exam-room' && activeSessionRef.current && t === 'results') {
          const curSess = activeSessionRef.current;
          const matching = res.find(
            (r) =>
              r.id === curSess.resultId ||
              (r.participantNumber.trim().toUpperCase() ===
                curSess.participant.participantNumber.trim().toUpperCase() &&
                r.examId === curSess.schedule.id)
          );
          if (
            !matching ||
            (matching.status === 'in_progress' && matching.submittedAt === null)
          ) {
            return;
          }
        }
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
        // syncFromSupabase sudah menarik hasil milik savedInitial.participant.participantNumber secara otomatis
        await syncFromSupabase({
          force: false,
          currentParticipantNumber: savedInitial?.participant.participantNumber,
          currentParticipantToken: savedInitial?.participant.token,
        });
      }
      await loadAllData('supabase_pull_student');
      if (isLiveSupabaseConfigured()) {
        // Segera kirim ulang antrean hasil ujian lokal yang mungkin tertunda saat submit sebelumnya
        window.setTimeout(() => {
          void flushPendingSyncQueue();
        }, 600 + Math.floor(Math.random() * 2200));
      }
      const autoFinalizedCount = await autoFinalizeExpiredExams({
        currentParticipantNumber: savedInitial?.participant.participantNumber,
        isAdmin: false,
      });
      if (autoFinalizedCount > 0 && mounted) {
        await loadAllData('results');
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
          void upsertExamProgress(savedSession, { includeQuestionIds: true }).then((res) => {
            if (!mounted || !res?.startedAt) return;
            const serverStartMs = Date.parse(res.startedAt);
            const localStartMs = Date.parse(savedSession.startedAt);
            if (
              Number.isFinite(serverStartMs) &&
              (!Number.isFinite(localStartMs) || Math.abs(serverStartMs - localStartMs) >= 2000)
            ) {
              const durationMs = Math.max(1, savedSession.schedule.durationMinutes) * 60 * 1000;
              setActiveSession((prev) =>
                prev && prev.resultId === savedSession.resultId
                  ? {
                      ...prev,
                      startedAt: res.startedAt,
                      endsAt: new Date(serverStartMs + durationMs).toISOString(),
                    }
                  : prev
              );
            }
          });
        }
      }
      if (mounted) setIsReady(true);
    })();

    const unsubscribe = subscribeDataChanges((topic) => {
      void loadAllData(topic);
    });

    // Tanpa polling berkala saat dashboard admin/proktor atau halaman login terbuka
    // agar 804 siswa + 1 proktor tidak membebani database dengan kueri berulang.
    // Pembaruan data dilakukan via event Realtime tertarget per tabel, tombol Sinkronisasi manual,
    // atau pengiriman antrean lokal saat koneksi pulih.
    let onlineJitterTimer: number | null = null;
    const onOnline = () => {
      if (onlineJitterTimer !== null) {
        window.clearTimeout(onlineJitterTimer);
      }
      // Sebarkan koneksi ulang 3 - 45 detik agar ratusan perangkat setelah gangguan Wi-Fi tidak membanjiri server serentak
      const reconnectJitterMs =
        routeRef.current === 'admin'
          ? 800 + Math.floor(Math.random() * 1500)
          : 3_000 + Math.floor(Math.random() * 42_000);
      onlineJitterTimer = window.setTimeout(() => {
        onlineJitterTimer = null;
        void (async () => {
          const isAdminRoute = routeRef.current === 'admin';
          await syncServerClock(isAdminRoute);
          await flushPendingSyncQueue();
          // Jangan memicu full-table reload atau force sync saat koneksi pulih (online).
          // Khusus portal Admin/Proktor, tarik delta exam_results saja (menghormati throttle cooldown).
          if (isAdminRoute) {
            await syncFromSupabase({
              force: false,
              isAdmin: true,
              resultsOnly: true,
            });
          }
        })();
      }, reconnectJitterMs);
    };
    window.addEventListener('online', onOnline);

    let hiddenSinceMs: number | null = null;
    const onVisibilitySyncClock = () => {
      if (document.hidden) {
        hiddenSinceMs = Date.now();
      } else {
        const wasHiddenLong = hiddenSinceMs !== null && Date.now() - hiddenSinceMs > 15_000;
        hiddenSinceMs = null;
        if (wasHiddenLong && isLiveSupabaseConfigured()) {
          void syncServerClock(true);
        }
      }
    };
    document.addEventListener('visibilitychange', onVisibilitySyncClock);

    return () => {
      mounted = false;
      unsubscribe();
      if (onlineJitterTimer !== null) {
        window.clearTimeout(onlineJitterTimer);
      }
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibilitySyncClock);
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

  // Perbarui completedResult secara real-time saat antrean sync berhasil masuk ke cloud
  useEffect(() => {
    if (route !== 'exam-completed' || !completedResult) return;
    const updated = results.find(
      (r) =>
        r.id === completedResult.id ||
        (r.participantNumber.trim().toUpperCase() ===
          completedResult.participantNumber.trim().toUpperCase() &&
          r.examId === completedResult.examId)
    );
    if (
      updated &&
      (updated.syncStatus !== completedResult.syncStatus ||
        updated.score !== completedResult.score ||
        updated.status !== completedResult.status)
    ) {
      setCompletedResult(updated);
    }
  }, [route, completedResult, results]);

  // Polling cloud status selama berada di ExamRoom untuk mendeteksi Reset Ujian / Paksa Selesai seketika
  const activeSessionId = activeSession?.resultId ?? null;
  useEffect(() => {
    if (route !== 'exam-room' || !activeSessionId || !isLiveSupabaseConfigured()) return;
    let active = true;
    const checkCloud = async () => {
      const currentSess = activeSessionRef.current;
      if (
        document.hidden ||
        !currentSess ||
        (typeof navigator !== 'undefined' && navigator.onLine === false)
      ) {
        return;
      }
      const checkedResultId = currentSess.resultId;
      const res = await checkLiveSessionStatusFromCloud(
        currentSess.participant.participantNumber,
        currentSess.schedule.id,
        {
          activeAnswers: currentSess.answers,
          activeTabSwitchCount: currentSess.tabSwitchCount,
          maxTabSwitches: currentSess.schedule.maxTabSwitches,
          token: currentSess.participant.token,
        }
      );
      if (!active || activeSessionRef.current?.resultId !== checkedResultId) return;
      if (res.status === 'unsynced_local') {
        // Baris awal belum terkonfirmasi masuk ke server (misal gagal saat puncak mulai ujian).
        // Jangan hapus jawaban lokal — langsung coba kirim ulang ke server!
        void upsertExamProgress(currentSess, { includeQuestionIds: true });
        return;
      }
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
          currentSess.participant.participantNumber,
          currentSess.schedule.id
        );
        clearActiveSessionLocal();
        if (document.fullscreenElement && document.exitFullscreen) {
          void document.exitFullscreen().catch(() => {});
        }
        setActiveSession(null);
        setSessionNotice(
          `Sesi ujian ${currentSess.schedule.subject} untuk peserta ${currentSess.participant.participantNumber} telah di-reset oleh Panitia / Proktor.`
        );
        setRoute('student-login');
        void loadAllData('results');
      }
    };

    const pollMs = 90_000 + Math.floor(Math.random() * 45_000);
    const timer = window.setInterval(() => {
      void checkCloud();
    }, pollMs);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [route, activeSessionId, loadAllData]);

  // Multi-table Supabase Realtime sync (diaktifkan khusus pada Portal Admin/Proktor agar 800+ siswa tidak terkena badai broadcast N^2)
  const isAdminRoute = route === 'admin';
  useEffect(() => {
    const cfg = getSupabaseConfig();
    if (!isAdminRoute || !isLiveSupabaseConfigured() || cfg.enableRealtime === false) return;
    const supabase = getSupabaseClient();
    const ADMIN_REALTIME_THROTTLE_MS = 25_000;
    let throttleTimer: number | null = null;
    let lastPullAt = 0;
    const pendingTables = new Set<SyncTableScope>();

    const flushPull = () => {
      if (throttleTimer) {
        window.clearTimeout(throttleTimer);
        throttleTimer = null;
      }
      if (pendingTables.size === 0) return;
      lastPullAt = Date.now();
      const tablesToSync = Array.from(pendingTables);
      pendingTables.clear();
      // Tarik HANYA tabel konfigurasi yang benar-benar berubah (tanpa full-table reload atau menarik ulang exam_results).
      void syncFromSupabase({
        force: false,
        isAdmin: true,
        tables: tablesToSync,
      });
    };

    const triggerPull = (tableScope: SyncTableScope) => {
      pendingTables.add(tableScope);
      if (throttleTimer) return;
      const elapsed = Date.now() - lastPullAt;
      const delayMs =
        elapsed >= ADMIN_REALTIME_THROTTLE_MS
          ? 1500
          : Math.max(1500, ADMIN_REALTIME_THROTTLE_MS - elapsed);
      throttleTimer = window.setTimeout(flushPull, delayMs);
    };

    const schema = cfg.schema || 'public';
    // exam_results sengaja tidak disubscribe lewat Realtime untuk mencegah badai WAL/broadcast
    // saat 800+ siswa serentak; Dashboard Admin menerima pembaruan hasil via tombol Sinkronisasi manual / delta-sync.
    const channel = supabase
      .channel('cbt_admin_realtime')
      .on('postgres_changes', { event: '*', schema, table: 'exam_schedules' }, () =>
        triggerPull('schedules')
      )
      .on('postgres_changes', { event: '*', schema, table: 'participants' }, () =>
        triggerPull('participants')
      )
      .on('postgres_changes', { event: '*', schema, table: 'school_profile' }, () =>
        triggerPull('profile')
      )
      .on('postgres_changes', { event: '*', schema, table: 'staff_accounts' }, () =>
        triggerPull('staff_accounts')
      )
      .subscribe();

    return () => {
      if (throttleTimer) window.clearTimeout(throttleTimer);
      pendingTables.clear();
      void supabase.removeChannel(channel);
    };
  }, [isAdminRoute]);

  const handleStartExam = async (participant: Participant, schedule: ExamSchedule) => {
    setSessionNotice('');
    // Unduh chunk ruang ujian (ExamRoom + KaTeX) secara paralel selagi preflight server berjalan
    void loadExamRoomModule();
    const preflight = await verifyStudentCanStartExam(
      participant.participantNumber,
      schedule.id,
      { token: participant.token }
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
      freshSchedule,
      freshParticipant.token
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
          freshSchedule.subject,
          {
            participantNumber: freshParticipant.participantNumber,
            token: freshParticipant.token,
          }
        );
        if (safeQuestions.length === 0) {
          throw new Error(
            `Belum ada butir soal mata pelajaran ${freshSchedule.subject} untuk kelas ${freshParticipant.className}. Hubungi panitia ujian.`
          );
        }

        await syncServerClock(false);
        const rawStartedMs = new Date(lockCheck.result.startedAt).getTime();
        const startedMs = Number.isFinite(rawStartedMs) ? rawStartedMs : getServerNowMs();

        const normalizedPNumber = normalizeParticipantNumber(freshParticipant.participantNumber);
        const normalizedParticipant: Participant = {
          ...freshParticipant,
          participantNumber: normalizedPNumber,
        };
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
            `${normalizedPNumber}::${freshSchedule.id}::${startedMs}`
          );
        }

        const sessionQuestions = prepareMatchingForStudentSession(
          orderedQuestions,
          `${normalizedPNumber}::${freshSchedule.id}::${startedMs}`
        );
        const endsAt = new Date(startedMs + freshSchedule.durationMinutes * 60 * 1000);

        const resumedSession: ActiveExamSession = {
          resultId:
            lockCheck.result.id ||
            `res-${normalizedPNumber}-${freshSchedule.id}`,
          participant: normalizedParticipant,
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
        await saveLocalResultProgressSnapshot(resumedSession);
        setActiveSession(resumedSession);
        setRoute('exam-room');
        // Sebarkan penulisan awal ke cloud 4-24 detik di latar belakang agar 600-800 siswa tidak menulis serentak pada detik ke-0
        clearInitialProgressSyncTimer();
        const staggerMs = 4_000 + Math.floor(Math.random() * 20_000);
        const expectedResultId = resumedSession.resultId;
        initialProgressSyncTimerRef.current = window.setTimeout(() => {
          initialProgressSyncTimerRef.current = null;
          if (
            routeRef.current !== 'exam-room' ||
            activeSessionRef.current?.resultId !== expectedResultId
          ) {
            return;
          }
          void upsertExamProgress(activeSessionRef.current, { includeQuestionIds: true }).then(
            (res) => {
              if (!res?.startedAt) return;
              const serverStartMs = Date.parse(res.startedAt);
              const cur = activeSessionRef.current;
              if (!cur || cur.resultId !== expectedResultId || !Number.isFinite(serverStartMs)) {
                return;
              }
              const localStartMs = Date.parse(cur.startedAt);
              if (!Number.isFinite(localStartMs) || Math.abs(serverStartMs - localStartMs) >= 2000) {
                const durationMs = Math.max(1, cur.schedule.durationMinutes) * 60 * 1000;
                setActiveSession((prev) =>
                  prev && prev.resultId === expectedResultId
                    ? {
                        ...prev,
                        startedAt: res.startedAt,
                        endsAt: new Date(serverStartMs + durationMs).toISOString(),
                      }
                    : prev
                );
              }
            }
          );
        }, staggerMs);
        return;
      }
      throw new Error(
        `Peserta sudah masuk / memulai ujian pada mata pelajaran ${freshSchedule.subject}. Hubungi admin untuk Reset Ujian.`
      );
    }

    const safeQuestions = await getStudentQuestionsForClass(
      freshParticipant.className,
      freshSchedule.subject,
      {
        participantNumber: freshParticipant.participantNumber,
        token: freshParticipant.token,
      }
    );
    if (safeQuestions.length === 0) {
      throw new Error(
        `Belum ada butir soal mata pelajaran ${freshSchedule.subject} untuk kelas ${freshParticipant.className}. Hubungi panitia ujian.`
      );
    }

    await syncServerClock(false);
    const serverNowMs = getServerNowMs();
    const normalizedPNumber = normalizeParticipantNumber(freshParticipant.participantNumber);
    const normalizedParticipant: Participant = {
      ...freshParticipant,
      participantNumber: normalizedPNumber,
    };

    const orderedQuestions = freshSchedule.randomizeQuestions
      ? shuffleQuestionsForParticipant(
          safeQuestions,
          `${normalizedPNumber}::${freshSchedule.id}::${serverNowMs}`
        )
      : safeQuestions;

    const sessionQuestions = prepareMatchingForStudentSession(
      orderedQuestions,
      `${normalizedPNumber}::${freshSchedule.id}::${serverNowMs}`
    );

    const endsAt = new Date(serverNowMs + freshSchedule.durationMinutes * 60 * 1000);
    const session: ActiveExamSession = {
      resultId: `res-${normalizedPNumber}-${freshSchedule.id}`,
      participant: normalizedParticipant,
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
    await saveLocalResultProgressSnapshot(session);
    setActiveSession(session);
    setRoute('exam-room');
    // Sebarkan penulisan awal in_progress ke cloud 1,5-10 detik agar 800-1.000 siswa tidak membuat badai WRITE pada detik ke-0
    // namun tetap memperkecil jendela sesi ganda lintas perangkat secara signifikan
    clearInitialProgressSyncTimer();
    const staggerMs = 1_500 + Math.floor(Math.random() * 8_500);
    const expectedResultId = session.resultId;
    initialProgressSyncTimerRef.current = window.setTimeout(() => {
      initialProgressSyncTimerRef.current = null;
      if (
        routeRef.current !== 'exam-room' ||
        activeSessionRef.current?.resultId !== expectedResultId
      ) {
        return;
      }
      void upsertExamProgress(activeSessionRef.current, { includeQuestionIds: true }).then(
        (res) => {
          if (!res?.startedAt) return;
          const serverStartMs = Date.parse(res.startedAt);
          const cur = activeSessionRef.current;
          if (!cur || cur.resultId !== expectedResultId || !Number.isFinite(serverStartMs)) {
            return;
          }
          const localStartMs = Date.parse(cur.startedAt);
          if (!Number.isFinite(localStartMs) || Math.abs(serverStartMs - localStartMs) >= 2000) {
            const durationMs = Math.max(1, cur.schedule.durationMinutes) * 60 * 1000;
            setActiveSession((prev) =>
              prev && prev.resultId === expectedResultId
                ? {
                    ...prev,
                    startedAt: res.startedAt,
                    endsAt: new Date(serverStartMs + durationMs).toISOString(),
                  }
                : prev
            );
          }
        }
      );
    }, staggerMs);
  };

  const handleExamCompleted = useCallback(
    (result: ExamResult) => {
      clearInitialProgressSyncTimer();
      setActiveSession(null);
      setCompletedResult(result);
      setRoute('exam-completed');
      void loadAllData('results');
    },
    [clearInitialProgressSyncTimer, loadAllData]
  );

  const handleExamLocked = useCallback(
    (lockedResult?: ExamResult) => {
      clearInitialProgressSyncTimer();
      clearActiveSessionLocal();
      setActiveSession(null);
      if (lockedResult) {
        setSessionNotice(
          `Ujian ${lockedResult.subject} terkunci otomatis karena melewati batas pelanggaran tab. Jawaban terakhir Anda telah disimpan & dinilai.`
        );
      }
      setRoute('student-login');
      void loadAllData('results');
    },
    [clearInitialProgressSyncTimer, loadAllData]
  );

  const handleForceSync = async () => {
    setIsSyncing(true);
    try {
      const isAdmin = routeRef.current === 'admin';
      await flushPendingSyncQueue();
      await syncFromSupabase({ force: true, isAdmin, deltaPreferred: isAdmin });
      if (isAdmin) {
        await autoFinalizeExpiredExams({ isAdmin: true });
      }
      await loadAllData();
    } finally {
      setIsSyncing(false);
    }
  };

  const ADMIN_RESET_PASSWORD_SQL = `-- Ganti SANDI_BARU_ANDA dengan sandi admin yang diinginkan, lalu klik Run:
UPDATE public.staff_accounts
SET password_hash = 'sha256$' || encode(pg_catalog.sha256(convert_to('SANDI_BARU_ANDA', 'UTF8')), 'hex'),
    is_active = TRUE
WHERE LOWER(TRIM(user_id)) = 'admin';

UPDATE public.school_profile
SET admin_password = 'sha256$' || encode(pg_catalog.sha256(convert_to('SANDI_BARU_ANDA', 'UTF8')), 'hex'),
    updated_at = NOW()
WHERE id = 'default';`;

  const copyRecoverySqlText = async (field: 'schema' | 'reset', text: string) => {
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (!copied) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        copied = document.execCommand('copy');
        ta.remove();
      } catch {
        copied = false;
      }
    }
    if (copied) {
      setCopiedRecoveryField(field);
      window.setTimeout(() => {
        setCopiedRecoveryField((prev) => (prev === field ? null : prev));
      }, 2500);
    }
  };

  const handleDownloadRecoverySql = async () => {
    const { SUPABASE_SCHEMA_SQL } = await import('@/src/lib/supabaseSchemaSql');
    const blob = new Blob([SUPABASE_SCHEMA_SQL], { type: 'text/sql;charset=utf-8' });
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = 'nusantara-cbt-supabase-schema-rls.sql';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(downloadUrl);
  };

  const handleAdminSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdminPinError('');
    setAdminSqlUpdateRequired(false);
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
        setAdminSqlUpdateRequired(false);
        setSessionNotice('');
        setRoute('admin');
        void loadAllData();
        if (isLiveSupabaseConfigured()) {
          void syncFromSupabase({ force: true, isAdmin: true }).then(() => loadAllData());
        }
      } else {
        setAdminPinError(auth.message || 'ID atau Sandi Panitia tidak sesuai.');
        setAdminSqlUpdateRequired(Boolean(auth.sqlUpdateRequired));
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
            setAdminSqlUpdateRequired(false);
            setShowAdminModal(true);
          }}
        />
      )}

      {route === 'exam-room' && activeSession && (
        <Suspense
          fallback={
            <div className="min-h-screen bg-slate-100 flex items-center justify-center text-slate-700 text-sm font-medium">
              Memuat ruang ujian...
            </div>
          }
        >
          <ExamRoom
            profile={profile}
            initialSession={activeSession}
            onExamCompleted={handleExamCompleted}
            onExamLocked={handleExamLocked}
          />
        </Suspense>
      )}

      {route === 'exam-completed' && completedResult && (
        <Suspense
          fallback={
            <div className="min-h-screen bg-slate-100 flex items-center justify-center text-slate-700 text-sm font-medium">
              Memuat ringkasan hasil ujian...
            </div>
          }
        >
          <ExamCompletedView
            profile={profile}
            result={completedResult}
            onReturnLogin={() => {
              setCompletedResult(null);
              setRoute('student-login');
            }}
          />
        </Suspense>
      )}

      {route === 'admin' && currentStaff && (
        <Suspense
          fallback={
            <div className="min-h-screen bg-slate-100 flex items-center justify-center text-slate-700 text-sm font-medium">
              Memuat Portal Admin &amp; Panitia...
            </div>
          }
        >
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
          onSaveProfile={async (updated, options) => {
            const syncRes = await saveSchoolProfile(updated, options);
            await Promise.all([loadAllData('profile'), loadAllData('staff_accounts')]);
            return syncRes;
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
          onUpsertStaff={async (account, options) => {
            const syncRes = await upsertStaffAccount(account, options);
            if (account.userId.trim().toLowerCase() === 'admin' && options?.updatePassword) {
              await Promise.all([loadAllData('staff_accounts'), loadAllData('profile')]);
            } else {
              await loadAllData('staff_accounts');
            }
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
        </Suspense>
      )}

      {/* Admin & Committee Role Login Modal */}
      {showAdminModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md max-h-[90vh] bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden flex flex-col">
            <div className="bg-[#064e3b] px-5 py-4 text-white flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2 font-display font-bold text-base">
                <Lock className="w-4 h-4 text-emerald-200" />
                <span>Masuk Portal Admin &amp; Panitia</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowAdminModal(false);
                  setAdminSqlUpdateRequired(false);
                }}
                className="p-1 rounded-lg hover:bg-white/10 text-emerald-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form
              onSubmit={(e) => void handleAdminSubmit(e)}
              className="p-5 space-y-4 overflow-y-auto"
            >
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
                      setAdminSqlUpdateRequired(false);
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
                <div className="text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg p-2.5 leading-relaxed">
                  {adminPinError}
                </div>
              )}

              {adminSqlUpdateRequired && (
                <div className="rounded-xl bg-amber-50 border border-amber-300 p-3.5 space-y-2.5 text-amber-950">
                  <div className="flex items-center gap-2 text-xs font-bold">
                    <Database className="w-4 h-4 text-amber-700 shrink-0" />
                    <span>Perbarui Skrip SQL Supabase Terlebih Dahulu</span>
                  </div>
                  <ol className="list-decimal pl-4 text-[11px] leading-relaxed space-y-1 text-amber-900">
                    <li>Klik <strong>Salin Skrip SQL Terbaru</strong> atau <strong>Unduh .sql</strong> di bawah ini.</li>
                    <li>Buka <strong>Supabase Dashboard → SQL Editor → + New query</strong>.</li>
                    <li>Tempel seluruh skrip SQL lalu klik <strong>Run</strong>, kemudian coba login kembali.</li>
                  </ol>
                  <div className="flex flex-wrap items-center gap-2 pt-0.5">
                    <button
                      type="button"
                      onClick={() =>
                        void import('@/src/lib/supabaseSchemaSql').then(({ SUPABASE_SCHEMA_SQL }) =>
                          copyRecoverySqlText('schema', SUPABASE_SCHEMA_SQL)
                        )
                      }
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold cursor-pointer"
                    >
                      {copiedRecoveryField === 'schema' ? (
                        <Check className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                      <span>
                        {copiedRecoveryField === 'schema' ? 'Skrip SQL Tersalin' : 'Salin Skrip SQL Terbaru'}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDownloadRecoverySql()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-400 bg-white hover:bg-amber-100 text-amber-950 text-xs font-semibold cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Unduh .sql</span>
                    </button>
                  </div>

                  <details className="pt-1 border-t border-amber-200/80 text-[11px]">
                    <summary className="cursor-pointer font-semibold text-amber-900 hover:text-amber-950">
                      Lupa sandi asli di balik hash database? (Reset via SQL Editor)
                    </summary>
                    <div className="mt-2 space-y-1.5">
                      <pre className="p-2.5 rounded-lg bg-slate-950 text-emerald-100 font-mono text-[10px] overflow-x-auto leading-relaxed">
                        {ADMIN_RESET_PASSWORD_SQL}
                      </pre>
                      <button
                        type="button"
                        onClick={() => void copyRecoverySqlText('reset', ADMIN_RESET_PASSWORD_SQL)}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-[11px] font-semibold cursor-pointer"
                      >
                        {copiedRecoveryField === 'reset' ? (
                          <Check className="w-3 h-3 text-emerald-700" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                        <span>
                          {copiedRecoveryField === 'reset' ? 'SQL Reset Tersalin' : 'Salin SQL Reset Sandi'}
                        </span>
                      </button>
                    </div>
                  </details>
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
