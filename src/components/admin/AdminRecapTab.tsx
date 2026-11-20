import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock,
  FileDown,
  FileSpreadsheet,
  Search,
  ShieldAlert,
  Trash2,
  UserX,
  X,
} from 'lucide-react';
import {
  ALL_CLASSES,
  type ExamResult,
  type ExamSchedule,
  type Participant,
  type Question,
  type RecapEntry,
  type SchoolProfile,
} from '@/src/types/cbt';
import { exportExamResultsExcel, exportExamResultsPdf } from '@/src/lib/importers';

interface AdminRecapTabProps {
  profile: SchoolProfile;
  participants: Participant[];
  schedules: ExamSchedule[];
  questions: Question[];
  results: ExamResult[];
  allowedSubjects?: string[];
  onDeleteResults: (resultIds: string[]) => Promise<void>;
}

type RecapStatusFilter = 'ALL' | 'attended' | 'not_attended' | 'in_progress';

type RecapDeleteScope =
  | { kind: 'single'; target: ExamResult }
  | { kind: 'selected'; targets: ExamResult[] }
  | { kind: 'filtered'; targets: ExamResult[] }
  | { kind: 'all'; targets: ExamResult[] };

const STATUS_FILTER_LABELS: Record<RecapStatusFilter, string> = {
  ALL: 'Semua Peserta',
  attended: 'Sudah Selesai Ujian',
  not_attended: 'Tidak Ikut Ujian',
  in_progress: 'Sedang Ujian',
};

export const AdminRecapTab: React.FC<AdminRecapTabProps> = ({
  profile,
  participants,
  schedules,
  questions,
  results,
  allowedSubjects,
  onDeleteResults,
}) => {
  const isRestrictedBySubject = Boolean(allowedSubjects && allowedSubjects.length > 0);
  const normalizedAllowed = useMemo(
    () => (allowedSubjects || []).map((s) => s.trim().toLowerCase()),
    [allowedSubjects]
  );

  const [subjectFilter, setSubjectFilter] = useState<string>('ALL');
  const [classFilter, setClassFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<RecapStatusFilter>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [showDeleteMenu, setShowDeleteMenu] = useState(false);
  const [deleteScope, setDeleteScope] = useState<RecapDeleteScope | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [feedback, setFeedback] = useState('');

  const scopedSchedules = useMemo(() => {
    if (!isRestrictedBySubject) return schedules;
    return schedules.filter((s) =>
      normalizedAllowed.includes(s.subject.trim().toLowerCase())
    );
  }, [schedules, isRestrictedBySubject, normalizedAllowed]);

  const scopedResults = useMemo(() => {
    if (!isRestrictedBySubject) return results;
    return results.filter((r) =>
      normalizedAllowed.includes((r.subject || '').trim().toLowerCase())
    );
  }, [results, isRestrictedBySubject, normalizedAllowed]);

  const subjects = useMemo(() => {
    if (isRestrictedBySubject && allowedSubjects) {
      return [...allowedSubjects].sort();
    }
    const set = new Set<string>(scopedSchedules.map((s) => s.subject));
    scopedResults.forEach((r) => {
      if (r.subject) set.add(r.subject);
    });
    return Array.from(set).sort();
  }, [scopedSchedules, scopedResults, isRestrictedBySubject, allowedSubjects]);

  const effectiveSubjectFilter = useMemo(() => {
    if (isRestrictedBySubject && subjects.length === 1) {
      return subjects[0];
    }
    const normFilter = subjectFilter.trim().toLowerCase();
    const matched = subjects.find((s) => s.trim().toLowerCase() === normFilter);
    if (subjectFilter !== 'ALL' && !matched) {
      return 'ALL';
    }
    return matched || subjectFilter;
  }, [isRestrictedBySubject, subjects, subjectFilter]);

  const questionCountMap = useMemo(() => {
    const map = new Map<string, number>();
    questions.forEach((q) => {
      const subjKey = q.subject.trim().toLowerCase();
      (q.targetClasses || []).forEach((cls) => {
        const key = `${subjKey}::${cls}`;
        map.set(key, (map.get(key) || 0) + 1);
      });
    });
    return map;
  }, [questions]);

  // Build complete participant-based recap entries:
  // Every scheduled exam x target participants is paired with existing ExamResult,
  // or marked as `not_attended` (score 0) if the student never logged in / started.
  // Orphaned results (from deleted schedules/participants) are also preserved.
  const allRecapEntries = useMemo<RecapEntry[]>(() => {
    const scheduleIdSet = new Set(scopedSchedules.map((s) => s.id));
    const exactResultMap = new Map<string, ExamResult>();
    const fallbackResultMap = new Map<string, ExamResult>();

    for (const r of scopedResults) {
      const normNum = r.participantNumber.trim().toUpperCase();
      exactResultMap.set(`${normNum}::${r.examId}`, r);
      if (!scheduleIdSet.has(r.examId) && r.subject) {
        const fallbackKey = `${normNum}::${r.subject.trim().toLowerCase()}`;
        if (!fallbackResultMap.has(fallbackKey)) {
          fallbackResultMap.set(fallbackKey, r);
        }
      }
    }

    const consumedResultIds = new Set<string>();
    const entries: RecapEntry[] = [];

    for (const sched of scopedSchedules) {
      const targetClassSet = new Set(sched.targetClasses || []);
      const normSubj = sched.subject.trim().toLowerCase();

      for (const p of participants) {
        if (!targetClassSet.has(p.className)) continue;

        const normNum = p.participantNumber.trim().toUpperCase();
        let matched = exactResultMap.get(`${normNum}::${sched.id}`);
        if (!matched) {
          const candidate = fallbackResultMap.get(`${normNum}::${normSubj}`);
          if (candidate && !consumedResultIds.has(candidate.id)) {
            matched = candidate;
          }
        }

        if (matched) {
          consumedResultIds.add(matched.id);
          const attendanceStatus: RecapEntry['attendanceStatus'] =
            matched.status === 'in_progress'
              ? 'in_progress'
              : matched.status === 'flagged'
                ? 'flagged'
                : 'completed';

          entries.push({
            id: matched.id,
            hasResult: true,
            resultId: matched.id,
            participantNumber: matched.participantNumber,
            studentName: matched.studentName || p.fullName,
            className: matched.className || p.className,
            examId: matched.examId,
            examTitle: matched.examTitle || sched.title,
            subject: matched.subject || sched.subject,
            correctCount: matched.correctCount,
            totalQuestions: matched.totalQuestions,
            score: matched.score,
            tabSwitchCount: matched.tabSwitchCount,
            attendanceStatus,
            submittedAt: matched.submittedAt,
            startedAt: matched.startedAt,
            rawResult: matched,
          });
        } else {
          const totalQuestions = questionCountMap.get(`${normSubj}::${p.className}`) || 0;
          entries.push({
            id: `absent::${sched.id}::${normNum}`,
            hasResult: false,
            participantNumber: p.participantNumber,
            studentName: p.fullName,
            className: p.className,
            examId: sched.id,
            examTitle: sched.title,
            subject: sched.subject,
            correctCount: 0,
            totalQuestions,
            score: 0,
            tabSwitchCount: 0,
            attendanceStatus: 'not_attended',
            submittedAt: null,
            startedAt: null,
          });
        }
      }
    }

    // Preserve any existing results whose schedule or participant was later removed
    for (const r of scopedResults) {
      if (consumedResultIds.has(r.id)) continue;
      const attendanceStatus: RecapEntry['attendanceStatus'] =
        r.status === 'in_progress'
          ? 'in_progress'
          : r.status === 'flagged'
            ? 'flagged'
            : 'completed';

      entries.push({
        id: r.id,
        hasResult: true,
        resultId: r.id,
        participantNumber: r.participantNumber,
        studentName: r.studentName,
        className: r.className,
        examId: r.examId,
        examTitle: r.examTitle,
        subject: r.subject,
        correctCount: r.correctCount,
        totalQuestions: r.totalQuestions,
        score: r.score,
        tabSwitchCount: r.tabSwitchCount,
        attendanceStatus,
        submittedAt: r.submittedAt,
        startedAt: r.startedAt,
        rawResult: r,
      });
    }

    entries.sort(
      (a, b) =>
        a.subject.localeCompare(b.subject) ||
        a.className.localeCompare(b.className) ||
        a.participantNumber.localeCompare(b.participantNumber)
    );

    return entries;
  }, [scopedSchedules, scopedResults, participants, questionCountMap]);

  const filteredEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const normFilter = effectiveSubjectFilter.trim().toLowerCase();
    return allRecapEntries.filter((entry) => {
      if (
        effectiveSubjectFilter !== 'ALL' &&
        (entry.subject || '').trim().toLowerCase() !== normFilter
      ) {
        return false;
      }
      if (classFilter !== 'ALL' && entry.className !== classFilter) return false;

      if (
        statusFilter === 'attended' &&
        entry.attendanceStatus !== 'completed' &&
        entry.attendanceStatus !== 'flagged'
      ) {
        return false;
      }
      if (statusFilter === 'not_attended' && entry.attendanceStatus !== 'not_attended') {
        return false;
      }
      if (statusFilter === 'in_progress' && entry.attendanceStatus !== 'in_progress') {
        return false;
      }

      if (
        q &&
        !entry.studentName.toLowerCase().includes(q) &&
        !entry.participantNumber.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [allRecapEntries, effectiveSubjectFilter, classFilter, statusFilter, searchQuery]);

  const getKkm = (subject: string): number => {
    const target = (subject || '').trim().toLowerCase();
    const match = schedules.find(
      (s) => s.subject.trim().toLowerCase() === target
    );
    return match ? match.kkm : 75;
  };

  const summary = useMemo(() => {
    const total = filteredEntries.length;
    const completedEntries = filteredEntries.filter(
      (e) => e.attendanceStatus === 'completed' || e.attendanceStatus === 'flagged'
    );
    const notAttendedCount = filteredEntries.filter(
      (e) => e.attendanceStatus === 'not_attended'
    ).length;
    const inProgressCount = filteredEntries.filter(
      (e) => e.attendanceStatus === 'in_progress'
    ).length;

    const passed = completedEntries.filter((e) => e.score >= getKkm(e.subject)).length;

    // Scored pool includes completed/flagged + absent (score 0), excludes active in_progress
    const scoredEntries = filteredEntries.filter(
      (e) => e.attendanceStatus !== 'in_progress'
    );
    const avg =
      scoredEntries.length > 0
        ? scoredEntries.reduce((acc, e) => acc + e.score, 0) / scoredEntries.length
        : 0;
    const attendedAvg =
      completedEntries.length > 0
        ? completedEntries.reduce((acc, e) => acc + e.score, 0) / completedEntries.length
        : 0;
    const highest =
      completedEntries.length > 0
        ? Math.max(...completedEntries.map((e) => e.score))
        : 0;

    return {
      total,
      completedCount: completedEntries.length,
      notAttendedCount,
      inProgressCount,
      passed,
      avg,
      attendedAvg,
      highest,
    };
  }, [filteredEntries, schedules]);

  const deletableAllResults = useMemo(
    () =>
      allRecapEntries
        .filter((e): e is RecapEntry & { rawResult: ExamResult } => Boolean(e.hasResult && e.rawResult))
        .map((e) => e.rawResult),
    [allRecapEntries]
  );

  const deletableFilteredResults = useMemo(
    () =>
      filteredEntries
        .filter((e): e is RecapEntry & { rawResult: ExamResult } => Boolean(e.hasResult && e.rawResult))
        .map((e) => e.rawResult),
    [filteredEntries]
  );

  const activeSelectedIds = useMemo(() => {
    const allowedSet = new Set(deletableAllResults.map((r) => r.id));
    return selectedIds.filter((id) => allowedSet.has(id));
  }, [deletableAllResults, selectedIds]);

  const selectedRecords = useMemo(() => {
    const selectedSet = new Set(activeSelectedIds);
    return deletableAllResults.filter((r) => selectedSet.has(r.id));
  }, [deletableAllResults, activeSelectedIds]);

  const allVisibleSelected =
    deletableFilteredResults.length > 0 &&
    deletableFilteredResults.every((r) => activeSelectedIds.includes(r.id));

  const toggleSelectAllVisible = () => {
    if (allVisibleSelected) {
      const visibleSet = new Set(deletableFilteredResults.map((r) => r.id));
      setSelectedIds((prev) => prev.filter((id) => !visibleSet.has(id)));
    } else {
      const merged = new Set([
        ...activeSelectedIds,
        ...deletableFilteredResults.map((r) => r.id),
      ]);
      setSelectedIds(Array.from(merged));
    }
  };

  const toggleSelectOne = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleConfirmDelete = async () => {
    if (!deleteScope) return;
    setIsDeleting(true);
    setFeedback('');
    try {
      const targets =
        deleteScope.kind === 'single' ? [deleteScope.target] : deleteScope.targets;
      const ids = targets.map((r) => r.id);
      await onDeleteResults(ids);
      const removedSet = new Set(ids);
      setSelectedIds((prev) => prev.filter((id) => !removedSet.has(id)));

      if (deleteScope.kind === 'single') {
        const t = deleteScope.target;
        setFeedback(
          `Rekap nilai ${t.subject || '-'} untuk ${t.studentName} (${t.participantNumber}) berhasil dihapus.`
        );
      } else if (deleteScope.kind === 'all') {
        setFeedback(
          `Keseluruhan rekap nilai (${ids.length} data) berhasil dihapus dari penyimpanan lokal dan cloud.`
        );
      } else {
        setFeedback(
          `${ids.length} data rekap nilai berhasil dihapus dari penyimpanan lokal dan cloud.`
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
            Rekap Nilai Hasil Ujian
          </h1>
          <p className="text-sm text-slate-600 mt-0.5">
            Rekapitulasi seluruh peserta ujian (termasuk peserta yang belum/tidak mengikuti ujian) beserta perbandingan KKM. Filter, unduh laporan (.xlsx / PDF), atau bersihkan riwayat hasil ujian.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {selectedRecords.length > 0 && (
            <button
              type="button"
              onClick={() => setDeleteScope({ kind: 'selected', targets: selectedRecords })}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-rose-300 bg-rose-50 hover:bg-rose-100 text-rose-900 text-sm font-semibold transition-colors cursor-pointer whitespace-nowrap"
            >
              <Trash2 className="w-4 h-4" />
              <span>Hapus Terpilih ({selectedRecords.length})</span>
            </button>
          )}

          {deletableAllResults.length > 0 && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowDeleteMenu((prev) => !prev)}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-rose-300 bg-white hover:bg-rose-50 text-rose-800 text-sm font-semibold transition-colors cursor-pointer whitespace-nowrap"
              >
                <Trash2 className="w-4 h-4" />
                <span>Hapus Rekap Nilai</span>
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
                      disabled={deletableFilteredResults.length === 0}
                      onClick={() => {
                        setShowDeleteMenu(false);
                        setDeleteScope({
                          kind: 'filtered',
                          targets: deletableFilteredResults,
                        });
                      }}
                      className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                    >
                      <div className="text-xs font-bold text-slate-900">
                        Hapus Rekap Sesuai Filter ({deletableFilteredResults.length})
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        Hanya hasil ujian tersimpan pada filter mapel &amp; kelas saat ini
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setShowDeleteMenu(false);
                        setDeleteScope({ kind: 'all', targets: deletableAllResults });
                      }}
                      className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-rose-50 cursor-pointer border-t border-slate-100"
                    >
                      <div className="text-xs font-bold text-rose-800">
                        Hapus Semua Data Rekap Nilai ({deletableAllResults.length})
                      </div>
                      <div className="text-[11px] text-rose-700/80 mt-0.5">
                        {isRestrictedBySubject
                          ? 'Bersihkan semua hasil ujian pada mata pelajaran Anda'
                          : 'Bersihkan seluruh hasil ujian semua mapel & semua kelas'}
                      </div>
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          <button
            type="button"
            disabled={filteredEntries.length === 0}
            onClick={() =>
              exportExamResultsExcel(filteredEntries, schedules, profile.schoolName)
            }
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-sm font-semibold transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap"
          >
            <FileSpreadsheet className="w-4 h-4 text-emerald-700" />
            <span>Unduh Excel (.xlsx)</span>
          </button>

          <button
            type="button"
            disabled={filteredEntries.length === 0}
            onClick={() =>
              exportExamResultsPdf(filteredEntries, schedules, profile, {
                subject: effectiveSubjectFilter,
                className: classFilter,
                statusLabel: STATUS_FILTER_LABELS[statusFilter],
              })
            }
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white text-sm font-semibold transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap"
          >
            <FileDown className="w-4 h-4" />
            <span>Unduh PDF</span>
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

      {/* Recap Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
          <div className="text-xs font-medium text-slate-500">Total Peserta (Filter)</div>
          <div className="font-mono text-3xl font-bold text-slate-900 tabular-nums mt-1.5">
            {summary.total}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {summary.completedCount} selesai · {summary.notAttendedCount} tidak ikut
            {summary.inProgressCount > 0 ? ` · ${summary.inProgressCount} aktif` : ''}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
          <div className="text-xs font-medium text-slate-500">Tuntas KKM</div>
          <div className="font-mono text-3xl font-bold text-emerald-700 tabular-nums mt-1.5">
            {summary.passed}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {summary.total > 0
              ? `${Math.round((summary.passed / summary.total) * 100)}% dari ${summary.total} peserta`
              : 'Belum ada data'}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
          <div className="text-xs font-medium text-slate-500">Rata-rata Nilai</div>
          <div className="font-mono text-3xl font-bold text-[#064e3b] tabular-nums mt-1.5">
            {summary.avg.toFixed(1)}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {summary.notAttendedCount > 0 && summary.completedCount > 0
              ? `Peserta hadir: ${summary.attendedAvg.toFixed(1)}`
              : 'Skala 0 – 100'}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
          <div className="text-xs font-medium text-slate-500">Nilai Tertinggi</div>
          <div className="font-mono text-3xl font-bold text-slate-900 tabular-nums mt-1.5">
            {summary.highest.toFixed(1)}
          </div>
          <div className="text-xs text-slate-500 mt-1">Pada filter saat ini</div>
        </div>
      </div>

      {/* Filters & Recap Table */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="p-4 sm:p-5 border-b border-slate-200 flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3">
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari nama peserta atau nomor peserta..."
              className="w-full pl-10 pr-4 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <select
              value={effectiveSubjectFilter}
              onChange={(e) => setSubjectFilter(e.target.value)}
              disabled={isRestrictedBySubject && subjects.length <= 1}
              className="px-3 py-2 rounded-xl border border-slate-300 bg-white text-sm font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-700 disabled:bg-slate-100"
            >
              {(!isRestrictedBySubject || subjects.length > 1) && (
                <option value="ALL">
                  {isRestrictedBySubject ? 'Semua Mapel Saya' : 'Semua Mata Pelajaran'}
                </option>
              )}
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

            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as RecapStatusFilter)}
              className="px-3 py-2 rounded-xl border border-slate-300 bg-white text-sm font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-700"
            >
              <option value="ALL">Semua Status Kehadiran</option>
              <option value="attended">Sudah Selesai Ujian</option>
              <option value="not_attended">Tidak Ikut Ujian</option>
              <option value="in_progress">Sedang Ujian</option>
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
                    aria-label="Pilih semua rekap yang tampil"
                    disabled={deletableFilteredResults.length === 0}
                    checked={allVisibleSelected}
                    onChange={toggleSelectAllVisible}
                    className="w-4 h-4 accent-[#064e3b] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  />
                </th>
                <th className="py-3 px-4">Nomor Peserta</th>
                <th className="py-3 px-4">Nama Peserta</th>
                <th className="py-3 px-4">Kelas</th>
                <th className="py-3 px-4">Mata Pelajaran</th>
                <th className="py-3 px-4 text-right">Benar</th>
                <th className="py-3 px-4 text-right">KKM</th>
                <th className="py-3 px-4 text-right">Nilai Akhir</th>
                <th className="py-3 px-4">Ketuntasan / Status</th>
                <th className="py-3 px-4 text-right">Hapus</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {filteredEntries.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-10 px-4 text-center text-slate-500">
                    Belum ada data peserta atau jadwal ujian yang sesuai dengan filter mapel, kelas, dan status saat ini.
                  </td>
                </tr>
              ) : (
                filteredEntries.map((entry) => {
                  const kkm = getKkm(entry.subject);
                  const isAbsent = entry.attendanceStatus === 'not_attended';
                  const isInProgress = entry.attendanceStatus === 'in_progress';
                  const passed = !isAbsent && !isInProgress && entry.score >= kkm;
                  const isChecked = entry.hasResult && activeSelectedIds.includes(entry.id);

                  return (
                    <tr
                      key={entry.id}
                      className={`transition-colors ${
                        isAbsent ? 'bg-slate-50/60 hover:bg-slate-100/70' : 'hover:bg-slate-50/70'
                      }`}
                    >
                      <td className="py-3 px-4">
                        <input
                          type="checkbox"
                          disabled={!entry.hasResult}
                          checked={isChecked}
                          onChange={() => toggleSelectOne(entry.id)}
                          title={
                            entry.hasResult
                              ? `Pilih rekap ${entry.studentName}`
                              : 'Peserta tidak ikut ujian (belum ada record hasil)'
                          }
                          aria-label={`Pilih rekap ${entry.studentName}`}
                          className="w-4 h-4 accent-[#064e3b] cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed"
                        />
                      </td>
                      <td className="py-3 px-4 font-mono font-semibold text-slate-900 whitespace-nowrap">
                        {entry.participantNumber}
                      </td>
                      <td className="py-3 px-4 font-medium text-slate-900">
                        {entry.studentName}
                      </td>
                      <td className="py-3 px-4 font-mono font-semibold text-slate-700">
                        {entry.className}
                      </td>
                      <td className="py-3 px-4 text-slate-700">{entry.subject || '-'}</td>
                      <td className="py-3 px-4 font-mono text-right tabular-nums text-slate-700">
                        {isAbsent && entry.totalQuestions === 0
                          ? '-'
                          : `${entry.correctCount}/${entry.totalQuestions}`}
                      </td>
                      <td className="py-3 px-4 font-mono text-right tabular-nums text-slate-500">
                        {kkm}
                      </td>
                      <td className="py-3 px-4 font-mono text-right font-bold tabular-nums text-slate-900">
                        {isInProgress ? '-' : entry.score.toFixed(1)}
                      </td>
                      <td className="py-3 px-4 text-xs whitespace-nowrap">
                        {isAbsent ? (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-slate-200/80 text-slate-700 font-semibold">
                            <UserX className="w-3.5 h-3.5 text-slate-500" />
                            <span>Tidak Ikut Ujian</span>
                          </span>
                        ) : isInProgress ? (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-sky-50 border border-sky-200 text-sky-800 font-semibold">
                            <Clock className="w-3.5 h-3.5" />
                            <span>Sedang Ujian</span>
                          </span>
                        ) : (
                          <>
                            <span
                              className={`font-semibold ${
                                passed ? 'text-emerald-700' : 'text-red-700'
                              }`}
                            >
                              {passed ? 'Tuntas' : 'Belum Tuntas'}
                            </span>
                            {entry.attendanceStatus === 'flagged' && (
                              <>
                                <span aria-hidden="true" className="mx-1.5 text-slate-300">
                                  ·
                                </span>
                                <span className="inline-flex items-center gap-1 text-amber-700 font-medium">
                                  <ShieldAlert className="w-3 h-3" />
                                  {entry.tabSwitchCount}x Tab
                                </span>
                              </>
                            )}
                          </>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        {entry.hasResult && entry.rawResult ? (
                          <button
                            type="button"
                            onClick={() =>
                              setDeleteScope({ kind: 'single', target: entry.rawResult! })
                            }
                            title={`Hapus rekap nilai ${entry.studentName}`}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-rose-700 hover:bg-rose-50 transition-colors cursor-pointer"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        ) : (
                          <span
                            className="text-xs text-slate-300 select-none px-2"
                            title="Tidak ada data hasil ujian yang tersimpan"
                          >
                            —
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Confirmation Modal for Deleting Recap Results */}
      {deleteScope && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden">
            <div className="px-5 py-4 bg-rose-50 border-b border-rose-200 flex items-center justify-between">
              <div className="flex items-center gap-2 font-display font-bold text-rose-950 text-base">
                <AlertTriangle className="w-5 h-5 text-rose-700" />
                <span>Konfirmasi Hapus Rekap Nilai</span>
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
                      KESELURUHAN rekap nilai ujian ({deleteScope.targets.length} data)
                    </strong>
                    {isRestrictedBySubject
                      ? ' pada mata pelajaran yang ditugaskan kepada Anda'
                      : ' untuk semua mata pelajaran dan semua kelas'}
                    .
                  </p>
                  <p className="text-xs text-slate-500">
                    Pastikan Anda telah mengunduh laporan Excel/PDF terlebih dahulu jika nilai masih dibutuhkan. Data yang dihapus akan terhapus di penyimpanan lokal dan Supabase Cloud.
                  </p>
                </div>
              ) : deleteScope.kind === 'single' ? (
                <div className="text-sm text-slate-700 space-y-2 leading-relaxed">
                  <p>
                    Anda akan menghapus data rekap nilai{' '}
                    <strong className="text-slate-900">{deleteScope.target.subject}</strong> untuk:
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
                      · Kelas <strong className="font-mono">{deleteScope.target.className}</strong>{' '}
                      · Nilai{' '}
                      <strong className="font-mono">{deleteScope.target.score.toFixed(1)}</strong>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-slate-700 space-y-2 leading-relaxed">
                  <p>
                    Anda akan menghapus{' '}
                    <strong className="text-rose-800">
                      {deleteScope.targets.length} data rekap nilai
                    </strong>{' '}
                    {deleteScope.kind === 'filtered' ? 'sesuai filter aktif' : 'yang dipilih'}.
                  </p>
                  <p className="text-xs text-slate-500">
                    Data nilai yang dihapus akan terhapus di penyimpanan lokal dan Supabase Cloud.
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
                  {isDeleting ? 'Menghapus...' : 'Ya, Hapus Permanen'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
