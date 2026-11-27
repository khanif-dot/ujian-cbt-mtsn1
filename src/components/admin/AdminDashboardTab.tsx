import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Lock,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  Trash2,
  Unlock,
  Users,
  X,
} from 'lucide-react';
import { autoFinalizeExpiredExams, getServerNowMs } from '@/src/lib/dataStore';
import { countAnsweredEntries } from '@/src/lib/questionUtils';
import {
  ALL_CLASSES,
  type ExamResult,
  type ExamSchedule,
  type Participant,
} from '@/src/types/cbt';

type MonitoringStatusFilter = 'ALL' | 'in_progress' | 'violation' | 'completed';

type DeleteLogScope =
  | { kind: 'single'; target: ExamResult }
  | { kind: 'selected'; targets: ExamResult[] }
  | { kind: 'filtered'; targets: ExamResult[] }
  | { kind: 'all'; totalCount: number };

type FinishExamScope =
  | { kind: 'single'; target: ExamResult }
  | { kind: 'selected'; targets: ExamResult[] }
  | { kind: 'filtered'; targets: ExamResult[] }
  | { kind: 'all'; targets: ExamResult[] };

interface AdminDashboardTabProps {
  participants: Participant[];
  schedules: ExamSchedule[];
  results: ExamResult[];
  hiddenDashboardLogs: Record<string, string>;
  allowedSubjects?: string[];
  onForceSync: () => Promise<void>;
  isSyncing: boolean;
  onForceFinishResults: (resultIds: string[]) => Promise<number>;
  onHideDashboardLogs: (items: Array<{ id: string; startedAt: string }>) => Promise<void>;
  onClearDashboardLogs: () => Promise<void>;
  onNavigateToReset?: () => void;
}

export const AdminDashboardTab: React.FC<AdminDashboardTabProps> = ({
  participants,
  schedules,
  results,
  hiddenDashboardLogs,
  allowedSubjects,
  onForceSync,
  isSyncing,
  onForceFinishResults,
  onHideDashboardLogs,
  onClearDashboardLogs,
  onNavigateToReset,
}) => {
  const isRestrictedBySubject = Boolean(allowedSubjects && allowedSubjects.length > 0);
  const normalizedAllowed = useMemo(
    () => (allowedSubjects || []).map((s) => s.trim().toLowerCase()),
    [allowedSubjects]
  );

  const [statusFilter, setStatusFilter] = useState<MonitoringStatusFilter>('in_progress');
  const [classFilter, setClassFilter] = useState<string>('ALL');
  const [subjectFilter, setSubjectFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [showDeleteMenu, setShowDeleteMenu] = useState(false);
  const [deleteScope, setDeleteScope] = useState<DeleteLogScope | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const [showFinishMenu, setShowFinishMenu] = useState(false);
  const [finishScope, setFinishScope] = useState<FinishExamScope | null>(null);
  const [isFinishing, setIsFinishing] = useState(false);

  const [feedback, setFeedback] = useState('');
  const [nowMs, setNowMs] = useState(() => getServerNowMs());
  const [listPage, setListPage] = useState(1);
  const [showAllRows, setShowAllRows] = useState(false);

  useEffect(() => {
    void autoFinalizeExpiredExams({ isAdmin: true });
    const timer = window.setInterval(() => {
      setNowMs(getServerNowMs());
    }, 25_000);
    return () => window.clearInterval(timer);
  }, []);

  const normalizedAllowedSet = useMemo(
    () => new Set(normalizedAllowed),
    [normalizedAllowed]
  );

  const scheduleLookup = useMemo(() => {
    const byId = new Map<string, ExamSchedule>();
    const bySubject = new Map<string, ExamSchedule>();
    for (const s of schedules) {
      byId.set(s.id, s);
      const key = (s.subject || '').trim().toLowerCase();
      if (key && !bySubject.has(key)) {
        bySubject.set(key, s);
      }
    }
    return { byId, bySubject };
  }, [schedules]);

  const scopedSchedules = useMemo(() => {
    if (!isRestrictedBySubject) return schedules;
    return schedules.filter((s) =>
      normalizedAllowedSet.has(s.subject.trim().toLowerCase())
    );
  }, [schedules, isRestrictedBySubject, normalizedAllowedSet]);

  const scopedResults = useMemo(() => {
    if (!isRestrictedBySubject) return results;
    return results.filter((r) => {
      const resolvedSubject = (
        scheduleLookup.byId.get(r.examId)?.subject ||
        r.subject ||
        ''
      )
        .trim()
        .toLowerCase();
      return normalizedAllowedSet.has(resolvedSubject);
    });
  }, [results, isRestrictedBySubject, normalizedAllowedSet, scheduleLookup]);

  const dashboardResults = useMemo(
    () => scopedResults.filter((r) => hiddenDashboardLogs[r.id] !== r.startedAt),
    [scopedResults, hiddenDashboardLogs]
  );

  const subjects = useMemo(() => {
    if (isRestrictedBySubject && allowedSubjects) {
      return [...allowedSubjects].sort();
    }
    const set = new Set<string>(scopedSchedules.map((s) => s.subject));
    dashboardResults.forEach((r) => {
      const subj = scheduleLookup.byId.get(r.examId)?.subject || r.subject;
      if (subj) set.add(subj);
    });
    return Array.from(set).sort();
  }, [scopedSchedules, dashboardResults, isRestrictedBySubject, allowedSubjects, scheduleLookup]);

  const stats = useMemo(() => {
    const inProgress = dashboardResults.filter((r) => r.status === 'in_progress');
    const violationResults = dashboardResults.filter(
      (r) => r.status === 'flagged' || r.tabSwitchCount > 0
    );
    const completedResults = dashboardResults.filter(
      (r) => r.status === 'submitted' || r.status === 'flagged'
    );
    const pendingSync = scopedResults.filter((r) => r.syncStatus === 'pending').length;

    return {
      totalParticipants: participants.length,
      allCount: dashboardResults.length,
      ongoingCount: inProgress.length,
      alertCount: violationResults.length,
      completedCount: completedResults.length,
      pendingSync,
      activeSubjects: scopedSchedules.filter((s) => s.isActive).length,
      totalSchedules: scopedSchedules.length,
    };
  }, [participants.length, dashboardResults, scopedResults, scopedSchedules]);

  const filteredResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const normSubjFilter = subjectFilter.trim().toLowerCase();
    return dashboardResults.filter((r) => {
      if (statusFilter === 'in_progress' && r.status !== 'in_progress') return false;
      if (
        statusFilter === 'violation' &&
        r.status !== 'flagged' &&
        r.tabSwitchCount === 0
      ) {
        return false;
      }
      if (
        statusFilter === 'completed' &&
        r.status !== 'submitted' &&
        r.status !== 'flagged'
      ) {
        return false;
      }

      if (classFilter !== 'ALL' && r.className !== classFilter) return false;
      if (subjectFilter !== 'ALL') {
        const resolvedSubj = (
          scheduleLookup.byId.get(r.examId)?.subject ||
          r.subject ||
          ''
        )
          .trim()
          .toLowerCase();
        if (resolvedSubj !== normSubjFilter) {
          return false;
        }
      }
      if (
        q &&
        !r.studentName.toLowerCase().includes(q) &&
        !r.participantNumber.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [dashboardResults, statusFilter, classFilter, subjectFilter, searchQuery, scheduleLookup]);

  const activeSelectedIds = useMemo(() => {
    const existingIds = new Set(dashboardResults.map((r) => r.id));
    return selectedIds.filter((id) => existingIds.has(id));
  }, [dashboardResults, selectedIds]);

  const activeSelectedSet = useMemo(
    () => new Set(activeSelectedIds),
    [activeSelectedIds]
  );

  const selectedRecords = useMemo(
    () => dashboardResults.filter((r) => activeSelectedSet.has(r.id)),
    [dashboardResults, activeSelectedSet]
  );

  const allInProgressRecords = useMemo(
    () => dashboardResults.filter((r) => r.status === 'in_progress'),
    [dashboardResults]
  );

  const filteredInProgressRecords = useMemo(
    () => filteredResults.filter((r) => r.status === 'in_progress'),
    [filteredResults]
  );

  const selectedInProgressRecords = useMemo(
    () => selectedRecords.filter((r) => r.status === 'in_progress'),
    [selectedRecords]
  );

  const allVisibleSelected =
    filteredResults.length > 0 &&
    filteredResults.every((r) => activeSelectedSet.has(r.id));

  const toggleSelectAllVisible = () => {
    if (allVisibleSelected) {
      const visibleSet = new Set(filteredResults.map((r) => r.id));
      setSelectedIds((prev) => prev.filter((id) => !visibleSet.has(id)));
    } else {
      const merged = new Set([...activeSelectedIds, ...filteredResults.map((r) => r.id)]);
      setSelectedIds(Array.from(merged));
    }
  };

  const toggleSelectOne = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  useEffect(() => {
    setListPage(1);
  }, [statusFilter, classFilter, subjectFilter, searchQuery]);

  const PAGE_SIZE = 50;
  const MAX_SHOW_ALL = 300;
  const totalPages = Math.max(1, Math.ceil(filteredResults.length / PAGE_SIZE));
  const safeListPage = Math.min(listPage, totalPages);
  const displayedResults = useMemo(() => {
    if (showAllRows) {
      return filteredResults.slice(0, MAX_SHOW_ALL);
    }
    if (filteredResults.length <= PAGE_SIZE) {
      return filteredResults;
    }
    const start = (safeListPage - 1) * PAGE_SIZE;
    return filteredResults.slice(start, start + PAGE_SIZE);
  }, [filteredResults, showAllRows, safeListPage]);

  const getRemainingMinutesForResult = (res: ExamResult): number | null => {
    if (res.status !== 'in_progress') return null;
    const sched =
      scheduleLookup.byId.get(res.examId) ||
      (res.subject
        ? scheduleLookup.bySubject.get(res.subject.trim().toLowerCase())
        : undefined);
    if (!sched) return null;
    const startedMs = new Date(res.startedAt).getTime();
    if (!Number.isFinite(startedMs)) return null;
    const expiresMs = startedMs + Math.max(1, sched.durationMinutes) * 60 * 1000;
    return Math.max(0, Math.ceil((expiresMs - nowMs) / 60000));
  };

  const handleConfirmFinish = async () => {
    if (!finishScope) return;
    setIsFinishing(true);
    setFeedback('');
    try {
      const targets =
        finishScope.kind === 'single' ? [finishScope.target] : finishScope.targets;
      const ids = targets.map((r) => r.id);
      const finishedCount = await onForceFinishResults(ids);
      const finishedSet = new Set(ids);
      setSelectedIds((prev) => prev.filter((id) => !finishedSet.has(id)));

      if (finishScope.kind === 'single') {
        const t = finishScope.target;
        setFeedback(
          `Ujian ${t.subject || '-'} untuk ${t.studentName} (${t.participantNumber}) berhasil diakhiri dan dinilai otomatis.`
        );
      } else {
        setFeedback(
          `${finishedCount} sesi peserta yang sedang ujian berhasil diakhiri, dinilai otomatis, dan masuk ke Rekap Nilai.`
        );
      }
      setFinishScope(null);
    } finally {
      setIsFinishing(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteScope) return;
    setIsDeleting(true);
    setFeedback('');
    try {
      if (deleteScope.kind === 'all') {
        const count = deleteScope.totalCount;
        await onClearDashboardLogs();
        setSelectedIds([]);
        setFeedback(
          `Seluruh log pemantauan (${count} data) berhasil dihapus dari Dashboard Ujian. Data Rekap Nilai tetap tersimpan.`
        );
      } else if (deleteScope.kind === 'single') {
        const t = deleteScope.target;
        await onHideDashboardLogs([{ id: t.id, startedAt: t.startedAt }]);
        setSelectedIds((prev) => prev.filter((id) => id !== t.id));
        setFeedback(
          `Log pemantauan ${t.subject || '-'} untuk ${t.studentName} (${t.participantNumber}) dihapus dari Dashboard Ujian. Data Rekap Nilai tetap tersimpan.`
        );
      } else {
        const targets = deleteScope.targets;
        await onHideDashboardLogs(
          targets.map((r) => ({ id: r.id, startedAt: r.startedAt }))
        );
        const removedSet = new Set(targets.map((r) => r.id));
        setSelectedIds((prev) => prev.filter((id) => !removedSet.has(id)));
        setFeedback(
          `${targets.length} log pemantauan dihapus dari Dashboard Ujian. Data Rekap Nilai tetap tersimpan.`
        );
      }
      setDeleteScope(null);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 tracking-tight">
            Dashboard Pemantauan Ujian
          </h1>
          <p className="text-sm text-slate-600 mt-0.5">
            Pantau peserta yang sedang ujian, terdeteksi pelanggaran pindah tab, maupun yang telah selesai ujian secara real-time.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 self-start sm:self-auto">
          {selectedInProgressRecords.length > 0 && (
            <button
              type="button"
              onClick={() =>
                setFinishScope({ kind: 'selected', targets: selectedInProgressRecords })
              }
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white text-sm font-semibold transition-colors cursor-pointer whitespace-nowrap"
            >
              <Send className="w-4 h-4" />
              <span>Akhiri Ujian Terpilih ({selectedInProgressRecords.length})</span>
            </button>
          )}

          {allInProgressRecords.length > 0 && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowFinishMenu((prev) => !prev)}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-emerald-700 bg-emerald-50 hover:bg-emerald-100 text-emerald-950 text-sm font-semibold transition-colors cursor-pointer whitespace-nowrap"
              >
                <Send className="w-4 h-4 text-emerald-800" />
                <span>Akhiri Ujian Masal</span>
                <ChevronDown className="w-3.5 h-3.5" />
              </button>

              {showFinishMenu && (
                <>
                  <div
                    className="fixed inset-0 z-20"
                    onClick={() => setShowFinishMenu(false)}
                  />
                  <div className="absolute right-0 mt-2 w-80 bg-white rounded-xl border border-slate-200 shadow-xl z-30 p-1.5 space-y-1">
                    <button
                      type="button"
                      disabled={filteredInProgressRecords.length === 0}
                      onClick={() => {
                        setShowFinishMenu(false);
                        setFinishScope({
                          kind: 'filtered',
                          targets: filteredInProgressRecords,
                        });
                      }}
                      className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-emerald-50/70 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                    >
                      <div className="text-xs font-bold text-slate-900">
                        Akhiri Ujian Sesuai Filter ({filteredInProgressRecords.length})
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        Selesaikan &amp; nilai peserta &ldquo;Sedang Ujian&rdquo; pada filter mapel/kelas aktif
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setShowFinishMenu(false);
                        setFinishScope({ kind: 'all', targets: allInProgressRecords });
                      }}
                      className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-emerald-50 cursor-pointer border-t border-slate-100"
                    >
                      <div className="text-xs font-bold text-emerald-900">
                        Akhiri Semua Peserta Sedang Ujian ({allInProgressRecords.length})
                      </div>
                      <div className="text-[11px] text-emerald-800/80 mt-0.5">
                        Paksa selesai &amp; hitung nilai seluruh peserta yang masih berstatus sedang ujian
                      </div>
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {selectedRecords.length > 0 && (
            <button
              type="button"
              onClick={() => setDeleteScope({ kind: 'selected', targets: selectedRecords })}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-rose-300 bg-rose-50 hover:bg-rose-100 text-rose-900 text-sm font-semibold transition-colors cursor-pointer whitespace-nowrap"
            >
              <Trash2 className="w-4 h-4" />
              <span>Hapus Log Terpilih ({selectedRecords.length})</span>
            </button>
          )}

          {dashboardResults.length > 0 && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowDeleteMenu((prev) => !prev)}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-rose-300 bg-white hover:bg-rose-50 text-rose-800 text-sm font-semibold transition-colors cursor-pointer whitespace-nowrap"
              >
                <Trash2 className="w-4 h-4" />
                <span>Hapus Riwayat / Log</span>
                <ChevronDown className="w-3.5 h-3.5" />
              </button>

              {showDeleteMenu && (
                <>
                  <div
                    className="fixed inset-0 z-20"
                    onClick={() => setShowDeleteMenu(false)}
                  />
                  <div className="absolute right-0 mt-2 w-72 bg-white rounded-xl border border-slate-200 shadow-xl z-30 p-1.5 space-y-1">
                    <button
                      type="button"
                      disabled={filteredResults.length === 0}
                      onClick={() => {
                        setShowDeleteMenu(false);
                        setDeleteScope({ kind: 'filtered', targets: filteredResults });
                      }}
                      className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                    >
                      <div className="text-xs font-bold text-slate-900">
                        Hapus Log Sesuai Filter ({filteredResults.length})
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        Menghapus log yang tampil di Dashboard saja (Rekap Nilai tetap aman)
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setShowDeleteMenu(false);
                        setDeleteScope({ kind: 'all', totalCount: dashboardResults.length });
                      }}
                      className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-rose-50 cursor-pointer border-t border-slate-100"
                    >
                      <div className="text-xs font-bold text-rose-800">
                        Hapus Semua Log Dashboard ({dashboardResults.length})
                      </div>
                      <div className="text-[11px] text-rose-700/80 mt-0.5">
                        Bersihkan tampilan log pemantauan Dashboard saja; data Rekap Nilai tetap tersimpan
                      </div>
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {onNavigateToReset && (
            <button
              type="button"
              onClick={onNavigateToReset}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-900 text-sm font-semibold transition-colors cursor-pointer whitespace-nowrap"
            >
              <Unlock className="w-4 h-4" />
              <span>Buka Menu Reset Ujian</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => void onForceSync()}
            disabled={isSyncing}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-sm font-semibold transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap"
          >
            <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
            <span>
              Sinkronkan Cloud
              {stats.pendingSync > 0 ? ` (${stats.pendingSync})` : ''}
            </span>
          </button>
        </div>
      </div>

      {feedback && (
        <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-900 text-sm flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
            <span>{feedback}</span>
          </div>
          <button
            type="button"
            onClick={() => setFeedback('')}
            className="p-1 rounded-lg hover:bg-emerald-100 text-emerald-700 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Live Monitoring KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <button
          type="button"
          onClick={() => setStatusFilter('in_progress')}
          className={`text-left bg-white rounded-xl border p-4 sm:p-5 transition-colors cursor-pointer ${
            statusFilter === 'in_progress'
              ? 'border-emerald-700 ring-1 ring-emerald-700'
              : 'border-slate-200 hover:border-slate-300'
          }`}
        >
          <div className="text-xs font-medium text-slate-500">Sedang Ujian Saat Ini</div>
          <div className="font-mono text-3xl font-bold text-emerald-700 tabular-nums mt-1.5">
            {stats.ongoingCount}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Dari {stats.totalParticipants} peserta terdaftar
          </div>
        </button>

        <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
          <div className="text-xs font-medium text-slate-500">Mapel Ujian Aktif</div>
          <div className="font-mono text-3xl font-bold text-slate-900 tabular-nums mt-1.5">
            {stats.activeSubjects}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Dari {stats.totalSchedules} jadwal tersimpan
          </div>
        </div>

        <button
          type="button"
          onClick={() => setStatusFilter('violation')}
          className={`text-left bg-white rounded-xl border p-4 sm:p-5 transition-colors cursor-pointer ${
            statusFilter === 'violation'
              ? 'border-amber-600 ring-1 ring-amber-600'
              : 'border-slate-200 hover:border-slate-300'
          }`}
        >
          <div className="text-xs font-medium text-slate-500">Pelanggaran Pindah Tab</div>
          <div className="font-mono text-3xl font-bold text-amber-700 tabular-nums mt-1.5">
            {stats.alertCount}
          </div>
          <div className="text-xs text-slate-500 mt-1">Terdeteksi keluar layar / terkunci</div>
        </button>

        <button
          type="button"
          onClick={() => setStatusFilter('completed')}
          className={`text-left bg-white rounded-xl border p-4 sm:p-5 transition-colors cursor-pointer ${
            statusFilter === 'completed'
              ? 'border-slate-800 ring-1 ring-slate-800'
              : 'border-slate-200 hover:border-slate-300'
          }`}
        >
          <div className="text-xs font-medium text-slate-500">Telah Selesai Ujian</div>
          <div className="font-mono text-3xl font-bold text-slate-900 tabular-nums mt-1.5">
            {stats.completedCount}
          </div>
          <div className="text-xs text-slate-500 mt-1">Peserta telah mengumpulkan</div>
        </button>
      </div>

      {/* Monitoring Table with Status Filter Tabs */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        {/* Status Filter Menu */}
        <div className="px-4 sm:px-5 pt-4 pb-3 border-b border-slate-100 flex flex-wrap items-center gap-2 bg-slate-50/70">
          {(
            [
              { key: 'in_progress', label: 'Sedang Ujian', count: stats.ongoingCount },
              { key: 'violation', label: 'Pelanggaran', count: stats.alertCount },
              { key: 'completed', label: 'Telah Selesai Ujian', count: stats.completedCount },
              { key: 'ALL', label: 'Semua Status', count: stats.allCount },
            ] as const
          ).map((item) => {
            const active = statusFilter === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setStatusFilter(item.key)}
                className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold border transition-colors cursor-pointer ${
                  active
                    ? 'bg-[#064e3b] border-[#064e3b] text-white'
                    : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'
                }`}
              >
                <span>{item.label}</span>
                <span
                  className={`font-mono px-1.5 py-0.5 rounded-md text-[11px] tabular-nums ${
                    active ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  {item.count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Search & Subject/Class Filter */}
        <div className="p-4 sm:p-5 border-b border-slate-200 flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari nomor peserta atau nama..."
              className="w-full pl-10 pr-4 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <select
              value={subjectFilter}
              onChange={(e) => setSubjectFilter(e.target.value)}
              className="px-3 py-2 rounded-xl border border-slate-300 bg-white text-sm font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-700"
            >
              <option value="ALL">Semua Mata Pelajaran</option>
              {subjects.map((subj) => (
                <option key={subj} value={subj}>
                  {subj}
                </option>
              ))}
            </select>

            <select
              value={classFilter}
              onChange={(e) => setClassFilter(e.target.value)}
              className="px-3 py-2 rounded-xl border border-slate-300 bg-white text-sm font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-700"
            >
              <option value="ALL">Semua Kelas (7A–9I)</option>
              {ALL_CLASSES.map((cls) => (
                <option key={cls} value={cls}>
                  Kelas {cls}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                <th className="py-3 px-4 w-10">
                  <input
                    type="checkbox"
                    aria-label="Pilih semua log yang tampil"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAllVisible}
                    className="w-4 h-4 accent-[#064e3b] cursor-pointer"
                  />
                </th>
                <th className="py-3 px-4">Nomor Peserta</th>
                <th className="py-3 px-4">Nama Peserta</th>
                <th className="py-3 px-4">Kelas</th>
                <th className="py-3 px-4">Mata Pelajaran</th>
                <th className="py-3 px-4 text-right">Progres / Nilai</th>
                <th className="py-3 px-4 text-right">Pindah Tab</th>
                <th className="py-3 px-4">Status &amp; Waktu</th>
                <th className="py-3 px-4 text-right">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {filteredResults.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-12 px-4 text-center text-slate-500">
                    <div className="flex flex-col items-center gap-2">
                      <Users className="w-6 h-6 text-slate-400" />
                      <span>Tidak ada peserta ujian yang cocok dengan filter status, mapel, atau kelas ini.</span>
                    </div>
                  </td>
                </tr>
              ) : (
                displayedResults.map((res) => {
                  const answeredCount =
                    typeof res.answeredCount === 'number'
                      ? res.answeredCount
                      : countAnsweredEntries(res.answers);
                  const pct =
                    res.totalQuestions > 0
                      ? Math.round((answeredCount / res.totalQuestions) * 100)
                      : 0;
                  const isCompleted = res.status === 'submitted';
                  const isFlagged = res.status === 'flagged';
                  const isInProgress = res.status === 'in_progress';
                  const isChecked = activeSelectedSet.has(res.id);
                  const remainingMin = getRemainingMinutesForResult(res);

                  return (
                    <tr key={res.id} className="hover:bg-slate-50/70 transition-colors">
                      <td className="py-3 px-4">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleSelectOne(res.id)}
                          aria-label={`Pilih log ${res.studentName}`}
                          className="w-4 h-4 accent-[#064e3b] cursor-pointer"
                        />
                      </td>
                      <td className="py-3 px-4 font-mono font-semibold text-slate-900 whitespace-nowrap">
                        {res.participantNumber}
                      </td>
                      <td className="py-3 px-4 font-medium text-slate-900">{res.studentName}</td>
                      <td className="py-3 px-4 font-mono font-semibold text-emerald-900">
                        {res.className}
                      </td>
                      <td className="py-3 px-4 text-slate-700">{res.subject || '-'}</td>
                      <td className="py-3 px-4 font-mono text-right tabular-nums text-slate-800">
                        {isCompleted || (isFlagged && res.submittedAt) ? (
                          <span>
                            <strong className="text-slate-900">{res.score.toFixed(1)}</strong>{' '}
                            <span className="text-xs text-slate-500">
                              ({res.correctCount}/{res.totalQuestions})
                            </span>
                          </span>
                        ) : (
                          <span>
                            {answeredCount}/{res.totalQuestions}{' '}
                            <span className="text-xs text-slate-500">({pct}%)</span>
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono text-right tabular-nums">
                        {res.tabSwitchCount > 0 ? (
                          <span
                            className={`inline-flex items-center gap-1 font-semibold ${
                              isFlagged ? 'text-red-700' : 'text-amber-700'
                            }`}
                          >
                            <ShieldAlert className="w-3.5 h-3.5" />
                            {res.tabSwitchCount}x
                          </span>
                        ) : (
                          <span className="text-emerald-700">Aman</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-xs whitespace-nowrap">
                        <div className="inline-flex items-center gap-2">
                          <span className="font-mono text-slate-500">
                            {new Date(res.submittedAt || res.startedAt).toLocaleTimeString('id-ID', {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                          <span aria-hidden="true" className="text-slate-300">
                            ·
                          </span>
                          {isFlagged ? (
                            <span className="inline-flex items-center gap-1 font-semibold text-red-700">
                              <Lock className="w-3.5 h-3.5" />
                              Pelanggaran / Terkunci
                            </span>
                          ) : isCompleted ? (
                            <span className="inline-flex items-center gap-1 font-semibold text-emerald-800">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              Selesai Ujian
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 font-semibold text-emerald-700">
                              <Clock className="w-3.5 h-3.5" />
                              <span>Sedang Ujian</span>
                              {remainingMin !== null && (
                                <span className="font-mono text-[11px] text-slate-500 font-normal">
                                  ({remainingMin > 0 ? `sisa ${remainingMin} mnt` : 'waktu habis'})
                                </span>
                              )}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center justify-end gap-1.5">
                          {isInProgress && (
                            <button
                              type="button"
                              onClick={() => setFinishScope({ kind: 'single', target: res })}
                              title={`Akhiri & nilai ujian ${res.studentName}`}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border border-emerald-300 text-xs font-semibold transition-colors cursor-pointer"
                            >
                              <Send className="w-3.5 h-3.5" />
                              <span>Akhiri Ujian</span>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setDeleteScope({ kind: 'single', target: res })}
                            title={`Hapus log ujian ${res.studentName}`}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-rose-700 hover:bg-rose-50 transition-colors cursor-pointer"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {filteredResults.length > PAGE_SIZE && (
          <div className="px-4 py-3 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
            <div>
              {showAllRows ? (
                <span>
                  Menampilkan {displayedResults.length} dari {filteredResults.length} baris log (dibatasi maks.{' '}
                  {MAX_SHOW_ALL} baris agar halaman tetap responsif).
                </span>
              ) : (
                <span>
                  Menampilkan baris {(safeListPage - 1) * PAGE_SIZE + 1}–
                  {Math.min(safeListPage * PAGE_SIZE, filteredResults.length)} dari{' '}
                  {filteredResults.length} data (Halaman {safeListPage} dari {totalPages})
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {!showAllRows && totalPages > 1 && (
                <>
                  <button
                    type="button"
                    disabled={safeListPage <= 1}
                    onClick={() => setListPage((p) => Math.max(1, p - 1))}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-40 font-semibold cursor-pointer"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    <span>Sebelumnya</span>
                  </button>
                  <button
                    type="button"
                    disabled={safeListPage >= totalPages}
                    onClick={() => setListPage((p) => Math.min(totalPages, p + 1))}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-40 font-semibold cursor-pointer"
                  >
                    <span>Berikutnya</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => setShowAllRows((v) => !v)}
                className="px-3 py-1.5 rounded-lg border border-emerald-700 bg-emerald-50 hover:bg-emerald-100 text-emerald-900 font-semibold cursor-pointer"
              >
                {showAllRows
                  ? `Bagi per ${PAGE_SIZE} Baris`
                  : filteredResults.length > MAX_SHOW_ALL
                    ? `Tampilkan ${MAX_SHOW_ALL} Teratas`
                    : `Tampilkan Semua (${filteredResults.length})`}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Confirmation Modal for Force-Finishing In-Progress Exams */}
      {finishScope && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden">
            <div className="px-5 py-4 bg-emerald-50 border-b border-emerald-200 flex items-center justify-between">
              <div className="flex items-center gap-2 font-display font-bold text-emerald-950 text-base">
                <Send className="w-5 h-5 text-emerald-800" />
                <span>Konfirmasi Akhiri Ujian Peserta</span>
              </div>
              <button
                type="button"
                disabled={isFinishing}
                onClick={() => setFinishScope(null)}
                className="p-1 rounded-lg text-emerald-900/70 hover:bg-emerald-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              {finishScope.kind === 'single' ? (
                <div className="text-sm text-slate-700 space-y-2 leading-relaxed">
                  <p>
                    Anda akan mengakhiri sesi ujian mata pelajaran{' '}
                    <strong className="text-slate-900">{finishScope.target.subject}</strong> untuk peserta:
                  </p>
                  <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 text-xs space-y-1">
                    <div>
                      Nama: <strong className="text-slate-900">{finishScope.target.studentName}</strong>
                    </div>
                    <div>
                      Nomor Peserta:{' '}
                      <code className="font-mono font-bold text-slate-900">
                        {finishScope.target.participantNumber}
                      </code>{' '}
                      · Kelas <strong className="font-mono">{finishScope.target.className}</strong>
                    </div>
                    <div>
                      Progres Tersimpan:{' '}
                      <strong className="font-mono text-emerald-800">
                        {typeof finishScope.target.answeredCount === 'number'
                          ? finishScope.target.answeredCount
                          : countAnsweredEntries(finishScope.target.answers)}{' '}
                        / {finishScope.target.totalQuestions} soal terjawab
                      </strong>
                    </div>
                  </div>
                  <p className="text-xs text-slate-500">
                    Seluruh jawaban tersimpan akan langsung dikoreksi otomatis, status berubah menjadi Selesai Ujian, dan nilai masuk ke Rekap Nilai serta Cloud.
                  </p>
                </div>
              ) : (
                <div className="text-sm text-slate-700 space-y-2 leading-relaxed">
                  <p>
                    Anda akan mengakhiri ujian secara masal untuk{' '}
                    <strong className="text-emerald-900">
                      {finishScope.targets.length} peserta yang sedang ujian
                    </strong>
                    {finishScope.kind === 'filtered'
                      ? ' sesuai filter aktif'
                      : finishScope.kind === 'selected'
                        ? ' yang Anda pilih'
                        : ' di semua mapel dan kelas'}
                    .
                  </p>
                  <p className="text-xs text-slate-500">
                    Sistem akan menghitung nilai otomatis berdasarkan jawaban terakhir tiap peserta dan menyinkronkannya ke Rekap Nilai serta Cloud.
                  </p>
                </div>
              )}

              <div className="flex items-center gap-2.5 pt-1">
                <button
                  type="button"
                  disabled={isFinishing}
                  onClick={() => setFinishScope(null)}
                  className="flex-1 py-2.5 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-50 text-xs sm:text-sm font-semibold cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="button"
                  disabled={isFinishing}
                  onClick={() => void handleConfirmFinish()}
                  className="flex-1 py-2.5 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white text-xs sm:text-sm font-semibold cursor-pointer disabled:opacity-60"
                >
                  {isFinishing ? 'Memproses Nilai...' : 'Ya, Akhiri & Nilai Ujian'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal for Deleting Dashboard History / Logs */}
      {deleteScope && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden">
            <div className="px-5 py-4 bg-rose-50 border-b border-rose-200 flex items-center justify-between">
              <div className="flex items-center gap-2 font-display font-bold text-rose-950 text-base">
                <AlertTriangle className="w-5 h-5 text-rose-700" />
                <span>Konfirmasi Hapus Riwayat / Log Ujian</span>
              </div>
              <button
                type="button"
                disabled={isDeleting}
                onClick={() => setDeleteScope(null)}
                className="p-1 rounded-lg text-rose-900/70 hover:bg-rose-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              {deleteScope.kind === 'all' ? (
                <div className="text-sm text-slate-700 space-y-2 leading-relaxed">
                  <p>
                    Anda akan menghapus{' '}
                    <strong className="text-rose-800">
                      seluruh log pemantauan ({deleteScope.totalCount} data)
                    </strong>{' '}
                    dari tampilan Dashboard Ujian.
                  </p>
                  <p className="text-xs text-slate-500">
                    Data hasil dan nilai peserta pada menu <strong>Rekap Nilai</strong> serta kunci akses ujian tetap tersimpan aman dan tidak ikut terhapus.
                  </p>
                </div>
              ) : deleteScope.kind === 'single' ? (
                <div className="text-sm text-slate-700 space-y-2 leading-relaxed">
                  <p>
                    Anda akan menghapus log pemantauan mata pelajaran{' '}
                    <strong className="text-slate-900">{deleteScope.target.subject}</strong> dari Dashboard Ujian untuk:
                  </p>
                  <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 text-xs space-y-1">
                    <div>
                      Nama: <strong className="text-slate-900">{deleteScope.target.studentName}</strong>
                    </div>
                    <div>
                      Nomor Peserta:{' '}
                      <code className="font-mono font-bold text-slate-900">
                        {deleteScope.target.participantNumber}
                      </code>{' '}
                      · Kelas <strong className="font-mono">{deleteScope.target.className}</strong>
                    </div>
                  </div>
                  <p className="text-xs text-slate-500">
                    Data pada menu <strong>Rekap Nilai</strong> tetap tersimpan. Untuk membuka kunci login peserta atau mereset nilai, gunakan menu <strong>Reset &amp; Buka Kunci</strong> atau hapus dari <strong>Rekap Nilai</strong>.
                  </p>
                </div>
              ) : (
                <div className="text-sm text-slate-700 space-y-2 leading-relaxed">
                  <p>
                    Anda akan menghapus{' '}
                    <strong className="text-rose-800">
                      {deleteScope.targets.length} log pemantauan ujian
                    </strong>{' '}
                    {deleteScope.kind === 'filtered' ? 'sesuai filter aktif' : 'yang dipilih'} dari Dashboard Ujian.
                  </p>
                  <p className="text-xs text-slate-500">
                    Data hasil dan nilai peserta pada menu <strong>Rekap Nilai</strong> tetap tersimpan aman dan tidak ikut terhapus.
                  </p>
                </div>
              )}

              <div className="flex items-center gap-2.5 pt-1">
                <button
                  type="button"
                  disabled={isDeleting}
                  onClick={() => setDeleteScope(null)}
                  className="flex-1 py-2.5 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-50 text-xs sm:text-sm font-semibold cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="button"
                  disabled={isDeleting}
                  onClick={() => void handleConfirmDelete()}
                  className="flex-1 py-2.5 rounded-xl bg-rose-700 hover:bg-rose-800 text-white text-xs sm:text-sm font-semibold cursor-pointer disabled:opacity-60"
                >
                  {isDeleting ? 'Menghapus...' : 'Ya, Hapus Log Dashboard'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
