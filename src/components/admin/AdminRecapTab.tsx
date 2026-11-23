import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Clock,
  FileDown,
  FileSpreadsheet,
  FileText,
  RefreshCw,
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
  type StaffRoleType,
} from '@/src/types/cbt';
import {
  PDF_RECAP_MAX_ROWS,
  exportAttendancePdf,
  exportAttendanceWord,
  exportBeritaAcaraPdf,
  exportBeritaAcaraWord,
  exportExamResultsExcel,
  exportExamResultsPdf,
} from '@/src/lib/importers';

interface AdminRecapTabProps {
  profile: SchoolProfile;
  participants: Participant[];
  schedules: ExamSchedule[];
  questions: Question[];
  results: ExamResult[];
  staffRoleType?: StaffRoleType;
  staffName?: string;
  allowedSubjects?: string[];
  onForceSync?: () => Promise<void>;
  isSyncing?: boolean;
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

const RECAP_RECALC_INTERVAL_MS = 25_000;

export const AdminRecapTab: React.FC<AdminRecapTabProps> = ({
  profile,
  participants,
  schedules,
  questions,
  results,
  staffRoleType,
  staffName,
  allowedSubjects,
  onForceSync,
  isSyncing = false,
  onDeleteResults,
}) => {
  const canManageExamDocuments = staffRoleType === 'admin' || staffRoleType === 'proktor';
  const isRestrictedBySubject = Boolean(allowedSubjects && allowedSubjects.length > 0);
  const normalizedAllowed = useMemo(
    () => (allowedSubjects || []).map((s) => s.trim().toLowerCase()),
    [allowedSubjects]
  );
  const normalizedAllowedSet = useMemo(
    () => new Set(normalizedAllowed),
    [normalizedAllowed]
  );

  // Throttle recalculation of the heavy participant x schedule recap matrix to at most once every 25s
  // during live background syncs, while allowing immediate recalculation on manual refresh or delete.
  const [recapSnapshot, setRecapSnapshot] = useState({
    participants,
    schedules,
    questions,
    results,
  });
  const latestDataRef = useRef({ participants, schedules, questions, results });
  latestDataRef.current = { participants, schedules, questions, results };
  const lastRecapCalcMsRef = useRef<number>(Date.now());
  const recapTimerRef = useRef<number | null>(null);

  const flushRecapNow = useCallback(() => {
    if (recapTimerRef.current) {
      window.clearTimeout(recapTimerRef.current);
      recapTimerRef.current = null;
    }
    lastRecapCalcMsRef.current = Date.now();
    setRecapSnapshot(latestDataRef.current);
  }, []);

  useEffect(() => {
    const elapsed = Date.now() - lastRecapCalcMsRef.current;
    if (elapsed >= RECAP_RECALC_INTERVAL_MS) {
      flushRecapNow();
      return;
    }
    if (!recapTimerRef.current) {
      const waitMs = Math.max(250, RECAP_RECALC_INTERVAL_MS - elapsed);
      recapTimerRef.current = window.setTimeout(() => {
        flushRecapNow();
      }, waitMs);
    }
  }, [participants, schedules, questions, results, flushRecapNow]);

  useEffect(() => {
    return () => {
      if (recapTimerRef.current) {
        window.clearTimeout(recapTimerRef.current);
      }
    };
  }, []);

  const [subjectFilter, setSubjectFilter] = useState<string>('ALL');
  const [classFilter, setClassFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<RecapStatusFilter>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [showDeleteMenu, setShowDeleteMenu] = useState(false);
  const [deleteScope, setDeleteScope] = useState<RecapDeleteScope | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [pdfWarning, setPdfWarning] = useState('');
  const [listPage, setListPage] = useState(1);
  const [showAllRows, setShowAllRows] = useState(false);

  const [docModalTab, setDocModalTab] = useState<'attendance' | 'minutes' | null>(null);
  const [docSubject, setDocSubject] = useState<string>('ALL');
  const [docClass, setDocClass] = useState<string>('ALL');
  const [docRoom, setDocRoom] = useState('');
  const [docSession, setDocSession] = useState('');
  const [docDate, setDocDate] = useState('');
  const [docTimeRange, setDocTimeRange] = useState('');
  const [docSupervisor1, setDocSupervisor1] = useState('');
  const [docSupervisor2, setDocSupervisor2] = useState('');
  const [docNotes, setDocNotes] = useState('');
  const [docSplitByClass, setDocSplitByClass] = useState(true);
  const [docSignatureStyle, setDocSignatureStyle] = useState<'zigzag' | 'single'>('zigzag');
  const [isExportingDoc, setIsExportingDoc] = useState(false);
  const [docModalError, setDocModalError] = useState('');

  const scheduleById = useMemo(
    () => new Map(recapSnapshot.schedules.map((s) => [s.id, s])),
    [recapSnapshot.schedules]
  );

  const scopedSchedules = useMemo(() => {
    if (!isRestrictedBySubject) return recapSnapshot.schedules;
    return recapSnapshot.schedules.filter((s) =>
      normalizedAllowedSet.has(s.subject.trim().toLowerCase())
    );
  }, [recapSnapshot.schedules, isRestrictedBySubject, normalizedAllowedSet]);

  const scopedResults = useMemo(() => {
    if (!isRestrictedBySubject) return recapSnapshot.results;
    return recapSnapshot.results.filter((r) => {
      const resolvedSubj = (
        scheduleById.get(r.examId)?.subject ||
        r.subject ||
        ''
      )
        .trim()
        .toLowerCase();
      return normalizedAllowedSet.has(resolvedSubj);
    });
  }, [recapSnapshot.results, isRestrictedBySubject, normalizedAllowedSet, scheduleById]);

  const subjects = useMemo(() => {
    if (isRestrictedBySubject && allowedSubjects) {
      return [...allowedSubjects].sort();
    }
    const set = new Set<string>(scopedSchedules.map((s) => s.subject));
    scopedResults.forEach((r) => {
      const subj = scheduleById.get(r.examId)?.subject || r.subject;
      if (subj) set.add(subj);
    });
    return Array.from(set).sort();
  }, [scopedSchedules, scopedResults, isRestrictedBySubject, allowedSubjects, scheduleById]);

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
    recapSnapshot.questions.forEach((q) => {
      const subjKey = q.subject.trim().toLowerCase();
      (q.targetClasses || []).forEach((cls) => {
        const key = `${subjKey}::${cls}`;
        map.set(key, (map.get(key) || 0) + 1);
      });
    });
    return map;
  }, [recapSnapshot.questions]);

  // Build complete participant-based recap entries:
  // Every scheduled exam x target participants is paired with existing ExamResult,
  // or marked as `not_attended` (score 0) if the student never logged in / started.
  // Orphaned results (from deleted schedules/participants) are also preserved.
  const sortedScopedSchedules = useMemo(
    () =>
      [...scopedSchedules].sort((a, b) =>
        a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0
      ),
    [scopedSchedules]
  );

  const sortedParticipants = useMemo(
    () =>
      [...recapSnapshot.participants].sort((a, b) =>
        a.className !== b.className
          ? a.className < b.className
            ? -1
            : 1
          : a.participantNumber < b.participantNumber
            ? -1
            : a.participantNumber > b.participantNumber
              ? 1
              : 0
      ),
    [recapSnapshot.participants]
  );

  const allRecapEntries = useMemo<RecapEntry[]>(() => {
    const scheduleIdSet = new Set(sortedScopedSchedules.map((s) => s.id));
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

    for (const sched of sortedScopedSchedules) {
      const targetClassSet = new Set(sched.targetClasses || []);
      const normSubj = sched.subject.trim().toLowerCase();

      for (const p of sortedParticipants) {
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
    let hasOrphaned = false;
    for (const r of scopedResults) {
      if (consumedResultIds.has(r.id)) continue;
      hasOrphaned = true;
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

    if (hasOrphaned) {
      entries.sort((a, b) =>
        a.subject !== b.subject
          ? a.subject < b.subject
            ? -1
            : 1
          : a.className !== b.className
            ? a.className < b.className
              ? -1
              : 1
            : a.participantNumber < b.participantNumber
              ? -1
              : a.participantNumber > b.participantNumber
                ? 1
                : 0
      );
    }

    return entries;
  }, [sortedScopedSchedules, scopedResults, sortedParticipants, questionCountMap]);

  const filteredEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const normFilter = effectiveSubjectFilter.trim().toLowerCase();
    return allRecapEntries.filter((entry) => {
      if (effectiveSubjectFilter !== 'ALL') {
        const resolvedSubj = (
          scheduleById.get(entry.examId)?.subject ||
          entry.subject ||
          ''
        )
          .trim()
          .toLowerCase();
        if (resolvedSubj !== normFilter) {
          return false;
        }
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
  }, [allRecapEntries, effectiveSubjectFilter, classFilter, statusFilter, searchQuery, scheduleById]);

  const kkmLookup = useMemo(() => {
    const byExamId = new Map<string, number>();
    const bySubject = new Map<string, number>();
    for (const s of recapSnapshot.schedules) {
      byExamId.set(s.id, s.kkm);
      const key = (s.subject || '').trim().toLowerCase();
      if (key && !bySubject.has(key)) {
        bySubject.set(key, s.kkm);
      }
    }
    return { byExamId, bySubject };
  }, [recapSnapshot.schedules]);

  const getKkm = useCallback(
    (examId: string, subject: string): number => {
      if (examId) {
        const byId = kkmLookup.byExamId.get(examId);
        if (typeof byId === 'number') return byId;
      }
      return kkmLookup.bySubject.get((subject || '').trim().toLowerCase()) ?? 75;
    },
    [kkmLookup]
  );

  useEffect(() => {
    setListPage(1);
    setPdfWarning('');
  }, [effectiveSubjectFilter, classFilter, statusFilter, searchQuery]);

  const PAGE_SIZE = 50;
  const MAX_SHOW_ALL = 300;
  const totalPages = Math.max(1, Math.ceil(filteredEntries.length / PAGE_SIZE));
  const safeListPage = Math.min(listPage, totalPages);
  const displayedEntries = useMemo(() => {
    if (showAllRows) {
      return filteredEntries.length <= MAX_SHOW_ALL
        ? filteredEntries
        : filteredEntries.slice(0, MAX_SHOW_ALL);
    }
    if (filteredEntries.length <= PAGE_SIZE) {
      return filteredEntries;
    }
    const start = (safeListPage - 1) * PAGE_SIZE;
    return filteredEntries.slice(start, start + PAGE_SIZE);
  }, [filteredEntries, showAllRows, safeListPage]);

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

    const passed = completedEntries.filter((e) => e.score >= getKkm(e.examId, e.subject)).length;

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
  }, [filteredEntries, getKkm]);

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

  const activeSelectedSet = useMemo(
    () => new Set(activeSelectedIds),
    [activeSelectedIds]
  );

  const selectedRecords = useMemo(
    () => deletableAllResults.filter((r) => activeSelectedSet.has(r.id)),
    [deletableAllResults, activeSelectedSet]
  );

  const allVisibleSelected =
    deletableFilteredResults.length > 0 &&
    deletableFilteredResults.every((r) => activeSelectedSet.has(r.id));

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
      flushRecapNow();

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

  const handleManualRefresh = async () => {
    if (onForceSync) {
      await onForceSync();
    }
    flushRecapNow();
  };

  const handleExportPdf = async () => {
    setPdfWarning('');
    const pdfRes = await exportExamResultsPdf(
      filteredEntries,
      recapSnapshot.schedules,
      profile,
      {
        subject: effectiveSubjectFilter,
        className: classFilter,
        statusLabel: STATUS_FILTER_LABELS[statusFilter],
      }
    );
    if (!pdfRes.ok) {
      setPdfWarning(
        `Ekspor PDF dibatasi maksimal ${PDF_RECAP_MAX_ROWS.toLocaleString('id-ID')} baris agar browser tidak hang (saat ini ${pdfRes.rowCount.toLocaleString('id-ID')} baris). Gunakan tombol "Unduh Excel (.xlsx)" atau saring data per Mata Pelajaran / per Kelas terlebih dahulu.`
      );
    }
  };

  const docTargetParticipants = useMemo(() => {
    const activeParticipants = participants.filter((p) => p.isActive !== false);
    let subjectTargetClassSet: Set<string> | null = null;
    if (docSubject && docSubject !== 'ALL') {
      const normSubj = docSubject.trim().toLowerCase();
      const matchingSchedules = schedules.filter(
        (s) => s.subject.trim().toLowerCase() === normSubj
      );
      if (matchingSchedules.length > 0) {
        subjectTargetClassSet = new Set<string>();
        matchingSchedules.forEach((s) =>
          (s.targetClasses || []).forEach((cls) => subjectTargetClassSet!.add(cls))
        );
      }
    }

    return activeParticipants.filter((p) => {
      if (docClass !== 'ALL' && p.className !== docClass) return false;
      if (subjectTargetClassSet && !subjectTargetClassSet.has(p.className)) return false;
      return true;
    });
  }, [participants, schedules, docSubject, docClass]);

  const docClassCount = useMemo(() => {
    const set = new Set<string>();
    docTargetParticipants.forEach((p) => p.className && set.add(p.className));
    return set.size;
  }, [docTargetParticipants]);

  const openDocumentModal = (initialTab: 'attendance' | 'minutes') => {
    setDocModalError('');
    setDocSubject(effectiveSubjectFilter !== 'ALL' ? effectiveSubjectFilter : subjects[0] || 'ALL');
    setDocClass(classFilter);
    if (!docSupervisor2 && staffRoleType === 'proktor' && staffName) {
      setDocSupervisor2(staffName);
    }
    setDocModalTab(initialTab);
  };

  const buildCurrentDocMeta = () => ({
    subject: docSubject,
    className: docClass,
    roomName: docRoom,
    sessionLabel: docSession,
    examDate: docDate,
    timeRange: docTimeRange,
    supervisor1: docSupervisor1,
    supervisor2: docSupervisor2,
    notes: docNotes,
    splitByClass: docSplitByClass,
    signatureStyle: docSignatureStyle,
  });

  const handleDownloadAttendance = async (format: 'pdf' | 'word') => {
    setDocModalError('');
    if (docTargetParticipants.length === 0) {
      setDocModalError(
        'Tidak ada peserta aktif yang sesuai dengan pilihan mata pelajaran & kelas saat ini.'
      );
      return;
    }
    setIsExportingDoc(true);
    try {
      const meta = buildCurrentDocMeta();
      if (format === 'pdf') {
        await exportAttendancePdf(docTargetParticipants, profile, meta);
      } else {
        await exportAttendanceWord(docTargetParticipants, profile, meta);
      }
      setFeedback(
        `Daftar Hadir (${format === 'pdf' ? 'PDF' : 'Word .docx'}) untuk ${docTargetParticipants.length} peserta berhasil diunduh.`
      );
    } catch (err) {
      setDocModalError(
        err instanceof Error ? err.message : 'Gagal membuat dokumen Daftar Hadir.'
      );
    } finally {
      setIsExportingDoc(false);
    }
  };

  const handleDownloadBeritaAcara = async (format: 'pdf' | 'word') => {
    setDocModalError('');
    setIsExportingDoc(true);
    try {
      const meta = buildCurrentDocMeta();
      if (format === 'pdf') {
        await exportBeritaAcaraPdf(docTargetParticipants.length, profile, meta);
      } else {
        await exportBeritaAcaraWord(docTargetParticipants.length, profile, meta);
      }
      setFeedback(
        `Berita Acara Pelaksanaan Ujian (${format === 'pdf' ? 'PDF' : 'Word .docx'}) berhasil diunduh.`
      );
    } catch (err) {
      setDocModalError(
        err instanceof Error ? err.message : 'Gagal membuat dokumen Berita Acara.'
      );
    } finally {
      setIsExportingDoc(false);
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
            disabled={isSyncing}
            onClick={() => void handleManualRefresh()}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-sm font-semibold transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap"
          >
            <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
            <span>Segarkan Rekap</span>
          </button>

          <button
            type="button"
            disabled={filteredEntries.length === 0}
            onClick={() =>
              exportExamResultsExcel(
                filteredEntries,
                recapSnapshot.schedules,
                profile.schoolName
              )
            }
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-sm font-semibold transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap"
          >
            <FileSpreadsheet className="w-4 h-4 text-emerald-700" />
            <span>Unduh Excel (.xlsx)</span>
          </button>

          <button
            type="button"
            disabled={filteredEntries.length === 0}
            onClick={() => void handleExportPdf()}
            className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-white text-sm font-semibold transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap ${
              filteredEntries.length > PDF_RECAP_MAX_ROWS
                ? 'bg-amber-600 hover:bg-amber-700'
                : 'bg-[#064e3b] hover:bg-[#043927]'
            }`}
          >
            <FileDown className="w-4 h-4" />
            <span>Unduh PDF</span>
          </button>

          {canManageExamDocuments && (
            <>
              <button
                type="button"
                onClick={() => openDocumentModal('attendance')}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-emerald-700/30 bg-emerald-50 hover:bg-emerald-100 text-emerald-950 text-sm font-semibold transition-colors cursor-pointer whitespace-nowrap"
              >
                <ClipboardCheck className="w-4 h-4 text-emerald-800" />
                <span>Daftar Hadir</span>
              </button>

              <button
                type="button"
                onClick={() => openDocumentModal('minutes')}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-sky-700/30 bg-sky-50 hover:bg-sky-100 text-sky-950 text-sm font-semibold transition-colors cursor-pointer whitespace-nowrap"
              >
                <FileText className="w-4 h-4 text-sky-800" />
                <span>Berita Acara</span>
              </button>
            </>
          )}
        </div>
      </div>

      {(filteredEntries.length > PDF_RECAP_MAX_ROWS || pdfWarning) && (
        <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-950 text-sm flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <div className="font-semibold">
                Data rekap melebihi batas aman PDF ({filteredEntries.length.toLocaleString('id-ID')} dari maks. {PDF_RECAP_MAX_ROWS.toLocaleString('id-ID')} baris)
              </div>
              <div className="text-xs text-amber-900">
                {pdfWarning ||
                  'Untuk jumlah baris besar agar ekspor cepat dan dokumen rapi, silakan gunakan tombol Unduh Excel (.xlsx) atau filter per Mata Pelajaran / Kelas sebelum mengunduh PDF.'}
              </div>
            </div>
          </div>
          {pdfWarning && (
            <button
              type="button"
              onClick={() => setPdfWarning('')}
              className="p-1 rounded-lg hover:bg-amber-100 text-amber-800 cursor-pointer shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      )}

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
                displayedEntries.map((entry) => {
                  const kkm = getKkm(entry.examId, entry.subject);
                  const isAbsent = entry.attendanceStatus === 'not_attended';
                  const isInProgress = entry.attendanceStatus === 'in_progress';
                  const passed = !isAbsent && !isInProgress && entry.score >= kkm;
                  const isChecked = entry.hasResult && activeSelectedSet.has(entry.id);

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

        {filteredEntries.length > PAGE_SIZE && (
          <div className="px-4 py-3 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
            <div>
              {showAllRows ? (
                <span>
                  {filteredEntries.length > MAX_SHOW_ALL
                    ? `Menampilkan ${MAX_SHOW_ALL} dari ${filteredEntries.length} baris (gunakan filter/Excel untuk ekspor penuh).`
                    : `Menampilkan seluruh ${filteredEntries.length} baris rekap sekaligus.`}
                </span>
              ) : (
                <span>
                  Menampilkan baris {(safeListPage - 1) * PAGE_SIZE + 1}–
                  {Math.min(safeListPage * PAGE_SIZE, filteredEntries.length)} dari{' '}
                  {filteredEntries.length} data (Halaman {safeListPage} dari {totalPages})
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
                  : `Tampilkan Maks ${Math.min(filteredEntries.length, MAX_SHOW_ALL)} (${filteredEntries.length})`}
              </button>
            </div>
          </div>
        )}
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

      {/* Pre-Exam Documents Modal: Daftar Hadir / Presensi & Berita Acara (Admin & Proktor only) */}
      {canManageExamDocuments && docModalTab && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
          <div className="w-full max-w-2xl bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden my-auto">
            <div className="bg-[#064e3b] px-5 py-4 text-white flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="font-display font-bold text-base truncate">
                  Cetak / Unduh Dokumen Pelaksanaan Ujian
                </h2>
                <p className="text-xs text-emerald-100/85 mt-0.5">
                  Disiapkan dan dicetak sebelum ujian dilaksanakan agar ditandatangani selama ujian berlangsung.
                </p>
              </div>
              <button
                type="button"
                disabled={isExportingDoc}
                onClick={() => setDocModalTab(null)}
                className="p-1.5 rounded-lg hover:bg-white/10 text-emerald-100 cursor-pointer shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Sub-Tab Switcher */}
            <div className="px-5 pt-4 border-b border-slate-200 flex items-center gap-2 bg-slate-50">
              <button
                type="button"
                onClick={() => {
                  setDocModalError('');
                  setDocModalTab('attendance');
                }}
                className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-t-xl text-xs sm:text-sm font-semibold border border-b-0 transition-colors cursor-pointer ${
                  docModalTab === 'attendance'
                    ? 'bg-white text-emerald-950 border-slate-200 -mb-px'
                    : 'bg-transparent text-slate-600 border-transparent hover:text-slate-900'
                }`}
              >
                <ClipboardCheck className="w-4 h-4 text-emerald-700" />
                <span>Daftar Hadir / Presensi</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setDocModalError('');
                  setDocModalTab('minutes');
                }}
                className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-t-xl text-xs sm:text-sm font-semibold border border-b-0 transition-colors cursor-pointer ${
                  docModalTab === 'minutes'
                    ? 'bg-white text-sky-950 border-slate-200 -mb-px'
                    : 'bg-transparent text-slate-600 border-transparent hover:text-slate-900'
                }`}
              >
                <FileText className="w-4 h-4 text-sky-700" />
                <span>Berita Acara Ujian</span>
              </button>
            </div>

            <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto">
              {/* Shared Exam Metadata Form */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Mata Pelajaran
                  </label>
                  <select
                    value={docSubject}
                    onChange={(e) => setDocSubject(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-white text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-700"
                  >
                    <option value="ALL">Kosongkan / Semua Mata Pelajaran</option>
                    {subjects.map((subj) => (
                      <option key={subj} value={subj}>
                        {subj}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Kelas / Tingkat Peserta
                  </label>
                  <select
                    value={docClass}
                    onChange={(e) => setDocClass(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-white text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-700"
                  >
                    <option value="ALL">Semua Kelas (7A–9I)</option>
                    {ALL_CLASSES.map((cls) => (
                      <option key={cls} value={cls}>
                        Kelas {cls}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Hari &amp; Tanggal Ujian <span className="font-normal text-slate-400">(opsional)</span>
                  </label>
                  <input
                    type="date"
                    value={docDate}
                    onChange={(e) => setDocDate(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-700"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Waktu / Pukul <span className="font-normal text-slate-400">(opsional)</span>
                  </label>
                  <input
                    type="text"
                    value={docTimeRange}
                    onChange={(e) => setDocTimeRange(e.target.value)}
                    placeholder="Contoh: 07.30 – 09.00 WIB"
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-700"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Ruang Ujian <span className="font-normal text-slate-400">(opsional)</span>
                  </label>
                  <input
                    type="text"
                    value={docRoom}
                    onChange={(e) => setDocRoom(e.target.value)}
                    placeholder="Contoh: Ruang 01 / Lab Komputer 1"
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-700"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Sesi Ujian <span className="font-normal text-slate-400">(opsional)</span>
                  </label>
                  <input
                    type="text"
                    value={docSession}
                    onChange={(e) => setDocSession(e.target.value)}
                    placeholder="Contoh: Sesi 1"
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-700"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Pengawas Ruang 1 <span className="font-normal text-slate-400">(kosong = garis TTD)</span>
                  </label>
                  <input
                    type="text"
                    value={docSupervisor1}
                    onChange={(e) => setDocSupervisor1(e.target.value)}
                    placeholder="Nama Pengawas 1 (opsional)"
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-700"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Pengawas Ruang 2 / Proktor <span className="font-normal text-slate-400">(opsional)</span>
                  </label>
                  <input
                    type="text"
                    value={docSupervisor2}
                    onChange={(e) => setDocSupervisor2(e.target.value)}
                    placeholder="Nama Pengawas 2 / Proktor"
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-700"
                  />
                </div>
              </div>

              {docModalTab === 'attendance' ? (
                <div className="p-3.5 rounded-xl bg-emerald-50/70 border border-emerald-200 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-emerald-950">
                      Peserta Aktif Tercakup:{' '}
                      <strong className="font-mono text-emerald-800">
                        {docTargetParticipants.length} siswa
                      </strong>
                      {docClass === 'ALL' && docClassCount > 1
                        ? ` (${docClassCount} kelas)`
                        : ''}
                    </span>
                    <span className="text-emerald-900/80">
                      Kolom tanda tangan dikosongkan untuk diisi siswa saat ujian.
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        Format Kolom Tanda Tangan
                      </label>
                      <select
                        value={docSignatureStyle}
                        onChange={(e) =>
                          setDocSignatureStyle(e.target.value as 'zigzag' | 'single')
                        }
                        className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-white text-xs sm:text-sm text-slate-800"
                      >
                        <option value="zigzag">Zigzag Kiri–Kanan (1. ... / 2. ...)</option>
                        <option value="single">Rata Kiri Berurutan</option>
                      </select>
                    </div>

                    {docClass === 'ALL' && docClassCount > 1 && (
                      <label className="flex items-center gap-2.5 px-3 py-2 rounded-xl border border-emerald-200 bg-white text-xs font-medium text-slate-800 cursor-pointer self-end">
                        <input
                          type="checkbox"
                          checked={docSplitByClass}
                          onChange={(e) => setDocSplitByClass(e.target.checked)}
                          className="w-4 h-4 accent-[#064e3b]"
                        />
                        <span>Pisahkan halaman baru per Kelas</span>
                      </label>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="p-3 rounded-xl bg-sky-50 border border-sky-200 text-xs text-sky-950 leading-relaxed">
                    <strong>Format Pra-Pelaksanaan Ujian:</strong> Berita Acara otomatis memuat identitas lembaga, jumlah peserta terdaftar (
                    <strong className="font-mono">{docTargetParticipants.length} orang</strong>), kolom isian kosong untuk jumlah hadir/tidak hadir &amp; nomor peserta yang tidak hadir, kotak catatan pengawas, serta kolom tanda tangan Pengawas, Proktor, dan Mengetahui Ketua Panitia Ujian.
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Catatan Tambahan Pra-Cetak <span className="font-normal text-slate-400">(opsional — kosongkan untuk baris tulis tangan)</span>
                    </label>
                    <textarea
                      rows={3}
                      value={docNotes}
                      onChange={(e) => setDocNotes(e.target.value)}
                      placeholder="Kosongkan agar tercetak kotak garis tulis tangan untuk pengawas saat ujian berlangsung..."
                      className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-700"
                    />
                  </div>
                </div>
              )}

              {docModalError && (
                <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-900 text-xs font-medium">
                  {docModalError}
                </div>
              )}

              <div className="pt-2 border-t border-slate-200 flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-2.5">
                <button
                  type="button"
                  disabled={isExportingDoc}
                  onClick={() => setDocModalTab(null)}
                  className="px-4 py-2.5 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-50 text-xs sm:text-sm font-semibold cursor-pointer"
                >
                  Tutup
                </button>

                {docModalTab === 'attendance' ? (
                  <>
                    <button
                      type="button"
                      disabled={isExportingDoc || docTargetParticipants.length === 0}
                      onClick={() => void handleDownloadAttendance('word')}
                      className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-sky-700 bg-sky-50 hover:bg-sky-100 text-sky-950 text-xs sm:text-sm font-semibold cursor-pointer disabled:opacity-50"
                    >
                      <FileText className="w-4 h-4 text-sky-700" />
                      <span>{isExportingDoc ? 'Menyiapkan...' : 'Unduh Word (.docx)'}</span>
                    </button>
                    <button
                      type="button"
                      disabled={isExportingDoc || docTargetParticipants.length === 0}
                      onClick={() => void handleDownloadAttendance('pdf')}
                      className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white text-xs sm:text-sm font-semibold cursor-pointer disabled:opacity-50"
                    >
                      <FileDown className="w-4 h-4" />
                      <span>{isExportingDoc ? 'Menyiapkan...' : 'Unduh PDF'}</span>
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={isExportingDoc}
                      onClick={() => void handleDownloadBeritaAcara('word')}
                      className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-sky-700 bg-sky-50 hover:bg-sky-100 text-sky-950 text-xs sm:text-sm font-semibold cursor-pointer disabled:opacity-50"
                    >
                      <FileText className="w-4 h-4 text-sky-700" />
                      <span>{isExportingDoc ? 'Menyiapkan...' : 'Unduh Word (.docx)'}</span>
                    </button>
                    <button
                      type="button"
                      disabled={isExportingDoc}
                      onClick={() => void handleDownloadBeritaAcara('pdf')}
                      className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white text-xs sm:text-sm font-semibold cursor-pointer disabled:opacity-50"
                    >
                      <FileDown className="w-4 h-4" />
                      <span>{isExportingDoc ? 'Menyiapkan...' : 'Unduh PDF'}</span>
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
