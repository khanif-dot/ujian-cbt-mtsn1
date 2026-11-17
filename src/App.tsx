import React, { useCallback, useEffect, useState } from 'react';
import { Lock, User, X } from 'lucide-react';
import {
  authenticateStaff,
  autoFinalizeExpiredExams,
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
  forceFinishExamResults,
  getAdminQuestions,
  getExamResults,
  getExamSchedules,
  getHiddenDashboardLogs,
  getParticipants,
  getSavedActiveSession,
  getSchoolProfile,
  getStaffAccounts,
  getStudentQuestionsForClass,
  hideDashboardExamLogs,
  resetBulkExamResults,
  saveActiveSessionLocal,
  saveSchoolProfile,
  subscribeDataChanges,
  submitFinalExam,
  upsertExamProgress,
  upsertExamSchedule,
  upsertParticipants,
  upsertQuestions,
  upsertStaffAccount,
} from '@/src/lib/dataStore';
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
 * Mengacak urutan soal secara unik per peserta & jadwal ujian menggunakan seed Nomor Peserta.
 * Ketika `randomizeQuestions` aktif, tiap peserta mengerjakan soal berbeda pada nomor yang sama.
 */
function shuffleQuestionsForParticipant<T extends { id: string }>(
  items: T[],
  participantSeed: string
): T[] {
  if (items.length < 2) return [...items];

  const seed = hashString32(participantSeed);
  const rand = createSeededRandom(seed);
  // Warm up PRNG state for stronger dispersion on sequential participant numbers
  rand();
  rand();

  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  // Ensure the shuffled order does not accidentally collapse back to canonical order
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
  const [isSyncing, setIsSyncing] = useState(false);

  const [showAdminModal, setShowAdminModal] = useState(false);
  const [adminIdInput, setAdminIdInput] = useState('');
  const [adminPinInput, setAdminPinInput] = useState('');
  const [adminPinError, setAdminPinError] = useState('');
  const [isAuthenticatingAdmin, setIsAuthenticatingAdmin] = useState(false);

  const loadAllData = useCallback(async () => {
    await ensureInitialized();
    const [prof, staff, parts, scheds, quests, res, hiddenLogs] = await Promise.all([
      getSchoolProfile(),
      getStaffAccounts(),
      getParticipants(),
      getExamSchedules(),
      getAdminQuestions(),
      getExamResults(),
      getHiddenDashboardLogs(),
    ]);
    setProfile(prof);
    setStaffAccounts(staff);
    setCurrentStaff((prev) => {
      if (!prev) return null;
      return staff.find((s) => s.id === prev.id) || prev;
    });
    setParticipants(parts);
    setSchedules(scheds);
    setQuestions(quests);
    setResults(res);
    setHiddenDashboardLogs(hiddenLogs);
  }, []);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      await loadAllData();
      const autoFinalizedCount = await autoFinalizeExpiredExams();
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
              (r.examId === savedSession.schedule.id ||
                r.subject.toLowerCase() === savedSession.schedule.subject.toLowerCase()))
        );
        if (!existingRecord || existingRecord.status === 'flagged') {
          clearActiveSessionLocal();
        } else if (existingRecord.status === 'submitted') {
          clearActiveSessionLocal();
          if (mounted) {
            setCompletedResult(existingRecord);
            setRoute('exam-completed');
          }
        } else if (Date.now() >= new Date(savedSession.endsAt).getTime()) {
          const finalized = await submitFinalExam(savedSession);
          if (mounted) {
            await loadAllData();
            setCompletedResult(finalized);
            setRoute('exam-completed');
          }
        } else {
          setActiveSession(savedSession);
          setRoute('exam-room');
          void upsertExamProgress(savedSession);
        }
      }
      if (mounted) setIsReady(true);
    })();

    const unsubscribe = subscribeDataChanges(() => {
      void loadAllData();
    });

    const intervalMs = Math.max(3, getSupabaseConfig().autoSyncIntervalSec || 8) * 1000;
    const syncInterval = window.setInterval(() => {
      void flushPendingSyncQueue();
    }, intervalMs);

    const expiryInterval = window.setInterval(() => {
      void autoFinalizeExpiredExams();
    }, 5000);

    const onOnline = () => {
      void flushPendingSyncQueue();
      void autoFinalizeExpiredExams();
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

  useEffect(() => {
    if (route !== 'exam-room' || !activeSession) return;
    const matching = results.find(
      (r) =>
        r.id === activeSession.resultId ||
        (r.participantNumber.trim().toUpperCase() ===
          activeSession.participant.participantNumber.trim().toUpperCase() &&
          (r.examId === activeSession.schedule.id ||
            r.subject.trim().toLowerCase() === activeSession.schedule.subject.trim().toLowerCase()))
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

  useEffect(() => {
    const cfg = getSupabaseConfig();
    if (!isLiveSupabaseConfigured() || cfg.enableRealtime === false) return;
    const supabase = getSupabaseClient();
    const channel = supabase
      .channel('exam_results_realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'exam_results' },
        () => {
          void loadAllData();
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [loadAllData]);

  const handleStartExam = async (participant: Participant, schedule: ExamSchedule) => {
    const lockCheck = await checkStudentExamLock(participant.participantNumber, schedule);
    if (lockCheck.locked) {
      if (lockCheck.reason === 'submitted') {
        throw new Error(
          `Anda telah menyelesaikan ujian mata pelajaran ${schedule.subject} dan tidak dapat mengulanginya.`
        );
      }
      if (lockCheck.reason === 'flagged') {
        throw new Error(
          `Akses ujian ${schedule.subject} terkunci karena pelanggaran. Hubungi admin untuk Reset Ujian.`
        );
      }
      throw new Error(
        `Peserta sudah masuk / memulai ujian pada mata pelajaran ${schedule.subject}. Hubungi admin untuk Reset Ujian.`
      );
    }

    const safeQuestions = await getStudentQuestionsForClass(
      participant.className,
      schedule.subject
    );
    if (safeQuestions.length === 0) {
      throw new Error(
        `Belum ada butir soal mata pelajaran ${schedule.subject} untuk kelas ${participant.className}. Hubungi panitia ujian.`
      );
    }

    const sessionQuestions = schedule.randomizeQuestions
      ? shuffleQuestionsForParticipant(
          safeQuestions,
          `${participant.participantNumber.trim().toUpperCase()}::${schedule.id}`
        )
      : safeQuestions;

    const now = new Date();
    const endsAt = new Date(now.getTime() + schedule.durationMinutes * 60 * 1000);
    const session: ActiveExamSession = {
      resultId: `res-${participant.participantNumber}-${schedule.id}`,
      participant,
      schedule,
      questions: sessionQuestions,
      answers: {},
      flaggedQuestions: [],
      currentIndex: 0,
      tabSwitchCount: 0,
      startedAt: now.toISOString(),
      endsAt: endsAt.toISOString(),
    };

    saveActiveSessionLocal(session);
    await upsertExamProgress(session);
    await loadAllData();
    setActiveSession(session);
    setRoute('exam-room');
  };

  const handleExamCompleted = (result: ExamResult) => {
    setActiveSession(null);
    setCompletedResult(result);
    setRoute('exam-completed');
    void loadAllData();
  };

  const handleForceSync = async () => {
    setIsSyncing(true);
    try {
      await flushPendingSyncQueue();
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
        setCurrentStaff(auth.staff);
        setShowAdminModal(false);
        setAdminIdInput('');
        setAdminPinInput('');
        setAdminPinError('');
        setRoute('admin');
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
          onExamLocked={() => {
            clearActiveSessionLocal();
            setActiveSession(null);
            setRoute('student-login');
            void loadAllData();
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
            await loadAllData();
          }}
          onUpsertParticipants={async (items) => {
            await upsertParticipants(items);
            await loadAllData();
          }}
          onDeleteParticipant={async (id) => {
            await deleteParticipant(id);
            await loadAllData();
          }}
          onDeleteAllParticipants={async () => {
            await clearAllParticipants();
            await loadAllData();
          }}
          onSaveSchedule={async (schedule) => {
            await upsertExamSchedule(schedule);
            await loadAllData();
          }}
          onDeleteSchedule={async (id) => {
            await deleteExamSchedule(id);
            await loadAllData();
          }}
          onDeleteAllSchedules={async (allowedSubjects) => {
            await clearAllSchedules(allowedSubjects);
            await loadAllData();
          }}
          onUpsertQuestions={async (items) => {
            await upsertQuestions(items);
            await loadAllData();
          }}
          onDeleteQuestion={async (id) => {
            await deleteQuestion(id);
            await loadAllData();
          }}
          onDeleteQuestionsBatch={async (ids) => {
            await deleteQuestionsBatch(ids);
            await loadAllData();
          }}
          onDeleteAllQuestions={async (allowedSubjects) => {
            await clearAllQuestions(allowedSubjects);
            await loadAllData();
          }}
          onForceFinishExamResults={async (resultIds) => {
            const res = await forceFinishExamResults(resultIds);
            await loadAllData();
            return res.finishedCount;
          }}
          onHideDashboardLogs={async (items) => {
            await hideDashboardExamLogs(items);
            await loadAllData();
          }}
          onClearDashboardLogs={async () => {
            await clearAllDashboardExamLogs();
            await loadAllData();
          }}
          onResetExamResults={async (resultIds) => {
            await resetBulkExamResults(resultIds);
            await loadAllData();
          }}
          onUpsertStaff={async (account) => {
            await upsertStaffAccount(account);
            await loadAllData();
          }}
          onDeleteStaff={async (id) => {
            await deleteStaffAccount(id);
            await loadAllData();
          }}
          onRefreshAll={loadAllData}
          onExitAdmin={() => {
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
