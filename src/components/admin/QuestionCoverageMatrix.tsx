import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Cloud,
  FileSpreadsheet,
  Filter,
  Grid3X3,
  Plus,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import {
  fetchQuestionCoverageFromCloud,
  type CloudQuestionCoveragePayload,
} from '@/src/lib/dataStore';
import { isLiveSupabaseConfigured } from '@/src/lib/supabase';
import {
  ALL_CLASSES,
  type ExamSchedule,
  type Participant,
  type Question,
} from '@/src/types/cbt';

interface QuestionCoverageMatrixProps {
  schedules: ExamSchedule[];
  questions: Question[];
  participants?: Participant[];
  onSelectSubjectClass?: (subject: string, className: string, hasQuestions: boolean) => void;
  onOpenCreateSchedule?: () => void;
}

type GradeFilter = 'ALL' | '7' | '8' | '9';
type CompletionFilter = 'ALL' | 'incomplete' | 'complete';

interface SubjectRowData {
  normKey: string;
  subject: string;
  schedule?: ExamSchedule;
  totalUniqueQuestions: number;
  countsByClass: Record<string, number>;
  scheduledClasses: Set<string>;
}

interface ClassGroup {
  key: '7' | '8' | '9' | 'other';
  label: string;
  classes: string[];
}

export const QuestionCoverageMatrix: React.FC<QuestionCoverageMatrixProps> = ({
  schedules,
  questions,
  participants = [],
  onSelectSubjectClass,
  onOpenCreateSchedule,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [gradeFilter, setGradeFilter] = useState<GradeFilter>('ALL');
  const [completionFilter, setCompletionFilter] = useState<CompletionFilter>('ALL');
  const [onlyClassesWithParticipants, setOnlyClassesWithParticipants] = useState(false);

  const [cloudData, setCloudData] = useState<CloudQuestionCoveragePayload | null>(null);
  const [isLoadingCloud, setIsLoadingCloud] = useState<boolean>(() => isLiveSupabaseConfigured());
  const participantsRef = useRef<Participant[]>(participants);
  participantsRef.current = participants;

  const loadFromSupabase = useCallback(async () => {
    setIsLoadingCloud(true);
    try {
      const existingClasses =
        participantsRef.current.length > 0
          ? Array.from(
              new Set(
                participantsRef.current
                  .map((p) => (p.className || '').trim().toUpperCase())
                  .filter(Boolean)
              )
            )
          : undefined;
      const payload = await fetchQuestionCoverageFromCloud(existingClasses);
      setCloudData(payload);
    } finally {
      setIsLoadingCloud(false);
    }
  }, []);

  // Load mapping from Supabase once on mount (manual refresh button handles subsequent reloads)
  useEffect(() => {
    void loadFromSupabase();
  }, [loadFromSupabase]);

  const effectiveSchedules = cloudData ? cloudData.schedules : schedules;
  const effectiveQuestions = useMemo(
    () =>
      cloudData
        ? cloudData.questions
        : questions.map((q) => ({
            id: q.id,
            subject: q.subject,
            targetClasses: q.targetClasses || [],
          })),
    [cloudData, questions]
  );

  const participantClassSet = useMemo(() => {
    if (cloudData) {
      return new Set(cloudData.participantClasses.map((c) => c.trim().toUpperCase()));
    }
    const set = new Set<string>();
    for (const p of participants) {
      const cls = (p.className || '').trim().toUpperCase();
      if (cls) set.add(cls);
    }
    return set;
  }, [cloudData, participants]);

  // Combine standard 27 classes (7A-9I) plus any custom classes found in Supabase data
  const allClassColumns = useMemo(() => {
    const known = new Set<string>(ALL_CLASSES);
    const extras: string[] = [];
    const registerExtra = (raw: string) => {
      const cls = (raw || '').trim().toUpperCase();
      if (cls && !known.has(cls)) {
        known.add(cls);
        extras.push(cls);
      }
    };
    participantClassSet.forEach(registerExtra);
    effectiveSchedules.forEach((s) => s.targetClasses.forEach(registerExtra));
    effectiveQuestions.forEach((q) => q.targetClasses.forEach(registerExtra));
    extras.sort((a, b) => a.localeCompare(b, 'id'));
    return [...ALL_CLASSES, ...extras];
  }, [participantClassSet, effectiveSchedules, effectiveQuestions]);

  const displayedClasses = useMemo(() => {
    return allClassColumns.filter((cls) => {
      if (gradeFilter !== 'ALL' && !cls.startsWith(gradeFilter)) {
        return false;
      }
      if (
        onlyClassesWithParticipants &&
        participantClassSet.size > 0 &&
        !participantClassSet.has(cls.toUpperCase())
      ) {
        return false;
      }
      return true;
    });
  }, [allClassColumns, gradeFilter, onlyClassesWithParticipants, participantClassSet]);

  const classGroups = useMemo<ClassGroup[]>(() => {
    const g7 = displayedClasses.filter((c) => c.startsWith('7'));
    const g8 = displayedClasses.filter((c) => c.startsWith('8'));
    const g9 = displayedClasses.filter((c) => c.startsWith('9'));
    const other = displayedClasses.filter(
      (c) => !c.startsWith('7') && !c.startsWith('8') && !c.startsWith('9')
    );

    const groups: ClassGroup[] = [];
    if (g7.length > 0) groups.push({ key: '7', label: 'Kelas VII', classes: g7 });
    if (g8.length > 0) groups.push({ key: '8', label: 'Kelas VIII', classes: g8 });
    if (g9.length > 0) groups.push({ key: '9', label: 'Kelas IX', classes: g9 });
    if (other.length > 0) groups.push({ key: 'other', label: 'Lainnya', classes: other });
    return groups;
  }, [displayedClasses]);

  const subjectRows = useMemo<SubjectRowData[]>(() => {
    const map = new Map<
      string,
      {
        subject: string;
        schedule?: ExamSchedule;
        questionsList: Array<{ id: string; subject: string; targetClasses: string[] }>;
      }
    >();

    for (const sched of effectiveSchedules) {
      const clean = sched.subject.trim();
      if (!clean) continue;
      const key = clean.toLowerCase();
      const existing = map.get(key);
      if (!existing) {
        map.set(key, { subject: clean, schedule: sched, questionsList: [] });
      } else if (!existing.schedule) {
        existing.schedule = sched;
        existing.subject = clean;
      }
    }

    for (const q of effectiveQuestions) {
      const clean = q.subject.trim();
      if (!clean) continue;
      const key = clean.toLowerCase();
      const existing = map.get(key);
      if (!existing) {
        map.set(key, { subject: clean, questionsList: [q] });
      } else {
        existing.questionsList.push(q);
      }
    }

    const rows: SubjectRowData[] = [];
    map.forEach((entry, normKey) => {
      const countsByClass: Record<string, number> = {};
      for (const q of entry.questionsList) {
        const uniqueTargets = new Set(
          q.targetClasses.map((c) => c.trim().toUpperCase()).filter(Boolean)
        );
        uniqueTargets.forEach((cls) => {
          countsByClass[cls] = (countsByClass[cls] || 0) + 1;
        });
      }

      const scheduledClasses = new Set<string>(
        (entry.schedule?.targetClasses || []).map((c) => c.trim().toUpperCase())
      );

      rows.push({
        normKey,
        subject: entry.subject,
        schedule: entry.schedule,
        totalUniqueQuestions: entry.questionsList.length,
        countsByClass,
        scheduledClasses,
      });
    });

    return rows.sort((a, b) => a.subject.localeCompare(b.subject, 'id'));
  }, [effectiveSchedules, effectiveQuestions]);

  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return subjectRows.filter((row) => {
      if (q && !row.subject.toLowerCase().includes(q)) {
        return false;
      }
      if (completionFilter !== 'ALL' && displayedClasses.length > 0) {
        const covered = displayedClasses.filter((cls) => (row.countsByClass[cls] || 0) > 0).length;
        const isComplete = covered === displayedClasses.length;
        if (completionFilter === 'complete' && !isComplete) return false;
        if (completionFilter === 'incomplete' && isComplete) return false;
      }
      return true;
    });
  }, [subjectRows, searchQuery, completionFilter, displayedClasses]);

  const summaryStats = useMemo(() => {
    const totalSubjects = subjectRows.length;
    const totalQuestions = effectiveQuestions.length;
    const classCount = displayedClasses.length;
    const totalSlots = totalSubjects * classCount;
    let filledSlots = 0;
    let incompleteSubjects = 0;

    for (const row of subjectRows) {
      let rowFilled = 0;
      for (const cls of displayedClasses) {
        if ((row.countsByClass[cls] || 0) > 0) {
          rowFilled++;
        }
      }
      filledSlots += rowFilled;
      if (classCount > 0 && rowFilled < classCount) {
        incompleteSubjects++;
      }
    }

    const percentage = totalSlots > 0 ? Math.round((filledSlots / totalSlots) * 100) : 0;

    return {
      totalSubjects,
      totalQuestions,
      filledSlots,
      totalSlots,
      percentage,
      incompleteSubjects,
    };
  }, [subjectRows, effectiveQuestions.length, displayedClasses]);

  const classFooterCoverage = useMemo(() => {
    const map: Record<string, number> = {};
    for (const cls of displayedClasses) {
      let readySubjects = 0;
      for (const row of filteredRows) {
        if ((row.countsByClass[cls] || 0) > 0) {
          readySubjects++;
        }
      }
      map[cls] = readySubjects;
    }
    return map;
  }, [displayedClasses, filteredRows]);

  const handleExportMatrixExcel = () => {
    if (filteredRows.length === 0 || displayedClasses.length === 0) return;

    const header = [
      'No',
      'Mata Pelajaran',
      'Status Jadwal',
      'Total Butir Soal',
      ...displayedClasses,
      'Kelas Terisi',
      'Total Kelas',
      'Persentase (%)',
    ];

    const dataRows = filteredRows.map((row, idx) => {
      let covered = 0;
      const classCells = displayedClasses.map((cls) => {
        const count = row.countsByClass[cls] || 0;
        if (count > 0) {
          covered++;
          return `✓ (${count})`;
        }
        return '✗ (0)';
      });
      const pct =
        displayedClasses.length > 0
          ? Math.round((covered / displayedClasses.length) * 100)
          : 0;
      const schedStatus = row.schedule
        ? row.schedule.isActive
          ? 'Aktif'
          : 'Nonaktif'
        : 'Belum Ada Jadwal';

      return [
        idx + 1,
        row.subject,
        schedStatus,
        row.totalUniqueQuestions,
        ...classCells,
        covered,
        displayedClasses.length,
        `${pct}%`,
      ];
    });

    const footerRow = [
      '',
      'Jumlah Mapel Tersedia per Kelas',
      '',
      '',
      ...displayedClasses.map((cls) => `${classFooterCoverage[cls] || 0}/${filteredRows.length}`),
      summaryStats.filledSlots,
      summaryStats.totalSlots,
      `${summaryStats.percentage}%`,
    ];

    const worksheet = XLSX.utils.aoa_to_sheet([header, ...dataRows, footerRow]);
    worksheet['!cols'] = [
      { wch: 5 },
      { wch: 28 },
      { wch: 16 },
      { wch: 15 },
      ...displayedClasses.map(() => ({ wch: 8 })),
      { wch: 12 },
      { wch: 12 },
      { wch: 14 },
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Pemetaan Soal');
    const dateStamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(workbook, `Pemetaan_Kelengkapan_Soal_${dateStamp}.xlsx`);
  };

  const formattedFetchedTime = useMemo(() => {
    if (!cloudData?.fetchedAt) return '';
    try {
      return new Date(cloudData.fetchedAt).toLocaleTimeString('id-ID', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return '';
    }
  }, [cloudData?.fetchedAt]);

  return (
    <div className="space-y-5">
      {/* Cloud Sync Error / Local Fallback Notice */}
      {cloudData?.error && (
        <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-950 text-xs sm:text-sm flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
            <span>
              <strong>Gagal memuat langsung dari Supabase:</strong> {cloudData.error} Menampilkan cache lokal sementara.
            </span>
          </div>
          <button
            type="button"
            onClick={() => void loadFromSupabase()}
            disabled={isLoadingCloud}
            className="px-3 py-1 rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-900 text-xs font-semibold cursor-pointer shrink-0"
          >
            Coba Lagi
          </button>
        </div>
      )}

      {/* KPI Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="text-xs font-medium text-slate-500">Total Mata Pelajaran</div>
          <div className="mt-1 font-display text-2xl font-bold text-slate-900 tabular-nums">
            {summaryStats.totalSubjects}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {cloudData?.source === 'supabase'
              ? 'Terdaftar di database Supabase'
              : 'Terdaftar di jadwal & bank soal'}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="text-xs font-medium text-slate-500">Total Butir Soal</div>
          <div className="mt-1 font-display text-2xl font-bold text-slate-900 tabular-nums">
            {summaryStats.totalQuestions}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {cloudData?.source === 'supabase'
              ? 'Tersimpan di server Supabase'
              : 'Seluruh butir soal tersimpan'}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="text-xs font-medium text-slate-500">Kelengkapan Slot Kelas</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-display text-2xl font-bold text-emerald-700 tabular-nums">
              {summaryStats.percentage}%
            </span>
            <span className="text-xs font-mono text-slate-500 tabular-nums">
              ({summaryStats.filledSlots}/{summaryStats.totalSlots})
            </span>
          </div>
          <div className="mt-2 h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-600 rounded-full transition-all"
              style={{ width: `${summaryStats.percentage}%` }}
            />
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="text-xs font-medium text-slate-500">Mapel Belum Lengkap</div>
          <div
            className={`mt-1 font-display text-2xl font-bold tabular-nums ${
              summaryStats.incompleteSubjects > 0 ? 'text-rose-600' : 'text-emerald-700'
            }`}
          >
            {summaryStats.incompleteSubjects}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {summaryStats.incompleteSubjects > 0
              ? `Dari ${displayedClasses.length} kelas yang dipantau`
              : 'Semua mapel sudah mencakup seluruh kelas'}
          </div>
        </div>
      </div>

      {/* Filter & Export Controls */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="p-4 border-b border-slate-200 space-y-3 bg-slate-50/60">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <Grid3X3 className="w-4 h-4 text-emerald-700 shrink-0 mt-1" />
              <div>
                <h2 className="font-display font-bold text-slate-900 text-sm sm:text-base">
                  Matriks Pemetaan Kelengkapan Soal per Mapel &amp; Kelas
                </h2>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
                  <span>
                    Pantau ketersediaan berkas soal ujian seluruh kelas langsung dari database Supabase agar seragam di semua role.
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1 font-medium text-emerald-800">
                    <Cloud className="w-3.5 h-3.5" />
                    <span>
                      {isLoadingCloud
                        ? 'Menyinkronkan dari Supabase...'
                        : cloudData?.source === 'supabase'
                          ? `Supabase Cloud (${formattedFetchedTime})`
                          : 'Cache Lokal'}
                    </span>
                  </span>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                disabled={isLoadingCloud}
                onClick={() => void loadFromSupabase()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-emerald-700 bg-emerald-50 hover:bg-emerald-100 text-emerald-900 text-xs font-semibold cursor-pointer disabled:opacity-50 whitespace-nowrap"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isLoadingCloud ? 'animate-spin' : ''}`} />
                <span>{isLoadingCloud ? 'Memuat...' : 'Muat Ulang dari Supabase'}</span>
              </button>

              <button
                type="button"
                disabled={filteredRows.length === 0 || displayedClasses.length === 0}
                onClick={handleExportMatrixExcel}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold cursor-pointer disabled:opacity-40 whitespace-nowrap"
              >
                <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-700" />
                <span>Unduh Matriks (.xlsx)</span>
              </button>
            </div>
          </div>

          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pt-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-full sm:w-64">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Cari mata pelajaran..."
                  className="w-full pl-9 pr-3 py-1.5 rounded-xl border border-slate-300 bg-white text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
                />
              </div>

              {/* Grade Level Filter */}
              <div className="inline-flex items-center p-1 rounded-xl bg-slate-200/70 gap-0.5">
                {(
                  [
                    { key: 'ALL', label: 'Semua Tingkat' },
                    { key: '7', label: 'Kelas VII' },
                    { key: '8', label: 'Kelas VIII' },
                    { key: '9', label: 'Kelas IX' },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setGradeFilter(item.key)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap ${
                      gradeFilter === item.key
                        ? 'bg-white text-slate-900 shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              {/* Completion Filter */}
              <div className="inline-flex items-center gap-1.5">
                <Filter className="w-3.5 h-3.5 text-slate-400 hidden sm:block" />
                <select
                  value={completionFilter}
                  onChange={(e) => setCompletionFilter(e.target.value as CompletionFilter)}
                  className="px-2.5 py-1.5 rounded-xl border border-slate-300 bg-white text-xs font-semibold text-slate-700"
                >
                  <option value="ALL">Semua Status Kelengkapan</option>
                  <option value="incomplete">Belum Lengkap Saja</option>
                  <option value="complete">Sudah Lengkap Saja</option>
                </select>
              </div>
            </div>

            {participantClassSet.size > 0 && (
              <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={onlyClassesWithParticipants}
                  onChange={(e) => setOnlyClassesWithParticipants(e.target.checked)}
                  className="w-4 h-4 accent-[#064e3b]"
                />
                <span>
                  Hanya kelas ada peserta ({participantClassSet.size})
                </span>
              </label>
            )}
          </div>

          {/* Clear Visual Legend */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 pt-1 text-xs text-slate-600 border-t border-slate-200/70">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-emerald-100 text-emerald-700 border border-emerald-300">
                <Check className="w-3.5 h-3.5 stroke-[2.75]" />
              </span>
              <span>Soal Sudah Terupload (angka = jumlah butir)</span>
            </span>
            <span className="inline-flex items-center gap-1.5 font-medium">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-rose-100 text-rose-600 border border-rose-300">
                <X className="w-3.5 h-3.5 stroke-[2.5]" />
              </span>
              <span>Belum Ada Soal Terupload</span>
            </span>
          </div>
        </div>

        {/* Matrix Table */}
        {isLoadingCloud && !cloudData ? (
          <div className="py-12 px-6 text-center space-y-2">
            <RefreshCw className="w-5 h-5 text-emerald-700 animate-spin mx-auto" />
            <div className="text-sm font-medium text-slate-700">
              Mengambil pemetaan soal terbaru dari database Supabase...
            </div>
          </div>
        ) : subjectRows.length === 0 ? (
          <div className="py-12 px-6 text-center space-y-3">
            <div className="text-sm font-semibold text-slate-800">
              Belum ada mata pelajaran atau soal yang terdaftar di Supabase.
            </div>
            <p className="text-xs text-slate-500 max-w-md mx-auto">
              Tambahkan jadwal mata pelajaran atau impor file soal Excel/Word terlebih dahulu untuk memantau pemetaan kelengkapan berkas soal per kelas.
            </p>
            {onOpenCreateSchedule && (
              <button
                type="button"
                onClick={onOpenCreateSchedule}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white text-xs font-semibold cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>Tambah Mapel &amp; KKM</span>
              </button>
            )}
          </div>
        ) : filteredRows.length === 0 || displayedClasses.length === 0 ? (
          <div className="py-10 px-4 text-center text-sm text-slate-500">
            Tidak ada mata pelajaran atau kelas yang cocok dengan filter saat ini.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                {/* Row 1: Grade level grouping */}
                <tr className="bg-slate-100 border-b border-slate-200 text-[11px] font-bold text-slate-700">
                  <th
                    rowSpan={2}
                    className="sticky left-0 z-20 bg-slate-100 py-2.5 px-4 border-r border-slate-200 min-w-[210px] max-w-[260px] align-middle"
                  >
                    Mata Pelajaran
                  </th>
                  {classGroups.map((group, gIdx) => (
                    <th
                      key={group.key}
                      colSpan={group.classes.length}
                      className={`py-1.5 px-2 text-center bg-slate-100 ${
                        gIdx > 0 ? 'border-l-2 border-slate-300' : ''
                      }`}
                    >
                      {group.label} ({group.classes.length} Kelas)
                    </th>
                  ))}
                  <th
                    rowSpan={2}
                    className="sticky right-0 z-20 bg-slate-100 py-2.5 px-3.5 border-l border-slate-200 text-center min-w-[116px] align-middle"
                  >
                    Kelengkapan
                  </th>
                </tr>

                {/* Row 2: Specific class codes */}
                <tr className="bg-slate-50 border-b border-slate-200 text-xs font-mono font-bold text-slate-700">
                  {classGroups.flatMap((group, gIdx) =>
                    group.classes.map((cls, cIdx) => (
                      <th
                        key={cls}
                        className={`py-2 px-1 text-center min-w-[46px] ${
                          gIdx > 0 && cIdx === 0
                            ? 'border-l-2 border-slate-300'
                            : 'border-l border-slate-200/70'
                        }`}
                      >
                        {cls}
                      </th>
                    ))
                  )}
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-200 text-sm">
                {filteredRows.map((row) => {
                  const coveredCount = displayedClasses.filter(
                    (cls) => (row.countsByClass[cls] || 0) > 0
                  ).length;
                  const totalCols = displayedClasses.length;
                  const pct = totalCols > 0 ? Math.round((coveredCount / totalCols) * 100) : 0;
                  const isFullyCovered = totalCols > 0 && coveredCount === totalCols;

                  return (
                    <tr key={row.normKey} className="group hover:bg-slate-50/80">
                      {/* Sticky Left Subject Column */}
                      <td className="sticky left-0 z-10 bg-white group-hover:bg-slate-50 py-2.5 px-4 border-r border-slate-200 align-middle min-w-[210px] max-w-[260px]">
                        <div
                          className="font-semibold text-slate-900 text-sm truncate"
                          title={row.subject}
                        >
                          {row.subject}
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-500">
                          <span className="font-mono tabular-nums font-medium text-slate-700">
                            {row.totalUniqueQuestions} butir
                          </span>
                          <span aria-hidden="true">·</span>
                          <span
                            className={
                              row.schedule
                                ? row.schedule.isActive
                                  ? 'text-emerald-700 font-medium'
                                  : 'text-slate-500'
                                : 'text-amber-700 font-medium'
                            }
                          >
                            {row.schedule
                              ? row.schedule.isActive
                                ? 'Jadwal Aktif'
                                : 'Jadwal Nonaktif'
                              : 'Belum ada jadwal'}
                          </span>
                        </div>
                      </td>

                      {/* Class Matrix Cells */}
                      {classGroups.flatMap((group, gIdx) =>
                        group.classes.map((cls, cIdx) => {
                          const count = row.countsByClass[cls] || 0;
                          const hasQuestions = count > 0;
                          const isScheduled = row.scheduledClasses.has(cls.toUpperCase());

                          const tooltip = hasQuestions
                            ? `${row.subject} · Kelas ${cls}: ${count} butir soal terupload di Supabase. Klik untuk melihat soal.`
                            : `${row.subject} · Kelas ${cls}: Belum ada soal terupload${
                                isScheduled ? ' (padahal kelas ini ditargetkan pada jadwal aktif!)' : ''
                              }. Klik untuk buat soal.`;

                          return (
                            <td
                              key={`${row.normKey}-${cls}`}
                              className={`p-1 text-center align-middle ${
                                gIdx > 0 && cIdx === 0
                                  ? 'border-l-2 border-slate-300'
                                  : 'border-l border-slate-100'
                              }`}
                            >
                              <button
                                type="button"
                                onClick={() =>
                                  onSelectSubjectClass?.(row.subject, cls, hasQuestions)
                                }
                                title={tooltip}
                                aria-label={tooltip}
                                className={`w-full h-11 rounded-lg border flex flex-col items-center justify-center transition-colors cursor-pointer ${
                                  hasQuestions
                                    ? 'bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100 hover:border-emerald-300'
                                    : 'bg-rose-50/70 border-rose-200/80 text-rose-500 hover:bg-rose-100 hover:border-rose-300'
                                }`}
                              >
                                {hasQuestions ? (
                                  <>
                                    <Check className="w-4 h-4 stroke-[2.75] text-emerald-600 shrink-0" />
                                    <span className="text-[10px] font-mono font-bold tabular-nums leading-none text-emerald-800 mt-0.5">
                                      {count}
                                    </span>
                                  </>
                                ) : (
                                  <X className="w-4 h-4 stroke-[2.5] text-rose-500 shrink-0" />
                                )}
                              </button>
                            </td>
                          );
                        })
                      )}

                      {/* Sticky Right Completion Summary Column */}
                      <td className="sticky right-0 z-10 bg-white group-hover:bg-slate-50 py-2.5 px-3.5 border-l border-slate-200 align-middle">
                        <div className="flex items-center justify-between gap-2 text-xs font-mono tabular-nums">
                          <span
                            className={`font-bold ${
                              isFullyCovered
                                ? 'text-emerald-700'
                                : coveredCount === 0
                                  ? 'text-rose-600'
                                  : 'text-slate-800'
                            }`}
                          >
                            {coveredCount}/{totalCols}
                          </span>
                          <span className="text-[11px] text-slate-500">{pct}%</span>
                        </div>
                        <div className="mt-1.5 h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${
                              isFullyCovered
                                ? 'bg-emerald-600'
                                : coveredCount === 0
                                  ? 'bg-rose-500'
                                  : 'bg-amber-500'
                            }`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>

              {/* Footer Summary per Class */}
              <tfoot>
                <tr className="bg-slate-50 border-t-2 border-slate-200 text-xs font-semibold text-slate-700">
                  <td className="sticky left-0 z-10 bg-slate-50 py-2.5 px-4 border-r border-slate-200">
                    Kesiapan per Kelas
                    <span className="block text-[11px] font-normal text-slate-500">
                      Mapel terisi / {filteredRows.length} mapel
                    </span>
                  </td>
                  {classGroups.flatMap((group, gIdx) =>
                    group.classes.map((cls, cIdx) => {
                      const ready = classFooterCoverage[cls] || 0;
                      const total = filteredRows.length;
                      const allReady = total > 0 && ready === total;
                      return (
                        <td
                          key={`foot-${cls}`}
                          className={`py-2 px-1 text-center font-mono text-[11px] tabular-nums ${
                            gIdx > 0 && cIdx === 0
                              ? 'border-l-2 border-slate-300'
                              : 'border-l border-slate-200/70'
                          } ${
                            allReady
                              ? 'text-emerald-700 font-bold bg-emerald-50/40'
                              : ready === 0
                                ? 'text-rose-600 font-semibold'
                                : 'text-slate-700'
                          }`}
                          title={`Kelas ${cls}: ${ready} dari ${total} mata pelajaran sudah memiliki soal`}
                        >
                          {ready}/{total}
                        </td>
                      );
                    })
                  )}
                  <td className="sticky right-0 z-10 bg-slate-50 py-2.5 px-3.5 border-l border-slate-200 text-center font-mono text-xs font-bold text-slate-800 tabular-nums">
                    {summaryStats.percentage}%
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
