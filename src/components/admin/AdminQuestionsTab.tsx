import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Clock,
  FileSpreadsheet,
  FileText,
  ImagePlus,
  Link2,
  Pencil,
  Plus,
  Search,
  Shuffle,
  Sigma,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { MathText } from '@/src/components/MathText';
import {
  ALL_CLASSES,
  type ExamSchedule,
  type OptionKey,
  type Question,
  type QuestionOption,
} from '@/src/types/cbt';
import {
  compressQuestionImage,
  downloadQuestionsTemplate,
  downloadQuestionsWordTemplate,
  parseQuestionsDocx,
  parseQuestionsExcel,
} from '@/src/lib/importers';
import { usePersistedState } from '@/src/lib/usePersistedState';

interface AdminQuestionsTabProps {
  schedules: ExamSchedule[];
  questions: Question[];
  allowedSubjects?: string[];
  onSaveSchedule: (schedule: ExamSchedule) => Promise<void>;
  onDeleteSchedule: (id: string) => Promise<void>;
  onDeleteAllSchedules: (allowedSubjects?: string[]) => Promise<void>;
  onUpsertQuestions: (items: Question[]) => Promise<void>;
  onDeleteQuestion: (id: string) => Promise<void>;
  onDeleteQuestionsBatch: (ids: string[]) => Promise<void>;
  onDeleteAllQuestions: (allowedSubjects?: string[]) => Promise<void>;
}

type QuestionsBulkDeleteKind =
  | 'questions_filtered'
  | 'questions_all'
  | 'schedules_all'
  | 'both_all';

const CLASSES_7 = ALL_CLASSES.filter((c) => c.startsWith('7'));
const CLASSES_8 = ALL_CLASSES.filter((c) => c.startsWith('8'));
const CLASSES_9 = ALL_CLASSES.filter((c) => c.startsWith('9'));

const GRADE_GROUPS = [
  { label: 'Kelas VII', classes: CLASSES_7 },
  { label: 'Kelas VIII', classes: CLASSES_8 },
  { label: 'Kelas IX', classes: CLASSES_9 },
] as const;

const OPTION_KEYS: OptionKey[] = ['A', 'B', 'C', 'D'];

function formatTargetClassesSummary(classes: string[]): string {
  if (classes.length === 0) return 'Belum ada kelas dipilih';
  if (classes.length === ALL_CLASSES.length) return 'Semua Kelas (7A–9I)';
  if (classes.length === 1) {
    const cls = classes[0];
    const roman = cls.startsWith('7') ? 'VII' : cls.startsWith('8') ? 'VIII' : 'IX';
    return `${cls} (${roman} ${cls.slice(1)} saja)`;
  }
  if (classes.length <= 5) return classes.join(', ');
  return `${classes.slice(0, 4).join(', ')} +${classes.length - 4} lainnya`;
}

interface ClassTargetSelectorProps {
  selectedClasses: string[];
  onChange: (classes: string[]) => void;
  compact?: boolean;
}

const ClassTargetSelector: React.FC<ClassTargetSelectorProps> = ({
  selectedClasses,
  onChange,
  compact = false,
}) => {
  const toggleClass = (cls: string) => {
    if (selectedClasses.includes(cls)) {
      onChange(selectedClasses.filter((c) => c !== cls));
    } else {
      const next = [...selectedClasses, cls];
      next.sort((a, b) => ALL_CLASSES.indexOf(a) - ALL_CLASSES.indexOf(b));
      onChange(next);
    }
  };

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold text-slate-700">
          Target: <span className="font-mono text-emerald-800">{formatTargetClassesSummary(selectedClasses)}</span>
        </span>
        <div className="flex flex-wrap gap-1.5 text-xs">
          <button
            type="button"
            onClick={() => onChange([...ALL_CLASSES])}
            className="px-2 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium cursor-pointer"
          >
            Semua (27)
          </button>
          <button
            type="button"
            onClick={() => onChange([])}
            className="px-2 py-1 rounded-lg bg-slate-100 hover:bg-red-50 hover:text-red-700 text-slate-700 font-medium cursor-pointer"
          >
            Kosongkan
          </button>
          <button
            type="button"
            onClick={() => onChange([...CLASSES_7])}
            className="px-2 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium cursor-pointer"
          >
            VII (7A–7I)
          </button>
          <button
            type="button"
            onClick={() => onChange([...CLASSES_8])}
            className="px-2 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium cursor-pointer"
          >
            VIII (8A–8I)
          </button>
          <button
            type="button"
            onClick={() => onChange([...CLASSES_9])}
            className="px-2 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium cursor-pointer"
          >
            IX (9A–9I)
          </button>
        </div>
      </div>

      <div className={`space-y-2 ${compact ? 'bg-slate-50 p-2.5 rounded-xl border border-slate-200' : ''}`}>
        {GRADE_GROUPS.map((group) => (
          <div key={group.label} className="flex flex-col sm:flex-row sm:items-center gap-1.5">
            <span className="w-20 shrink-0 text-[11px] font-semibold text-slate-500">
              {group.label}
            </span>
            <div className="grid grid-cols-9 gap-1 flex-1">
              {group.classes.map((cls) => {
                const isSelected = selectedClasses.includes(cls);
                return (
                  <button
                    key={cls}
                    type="button"
                    onClick={() => toggleClass(cls)}
                    className={`py-1.5 rounded-lg font-mono text-xs font-bold border transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-[#064e3b] border-[#064e3b] text-white'
                        : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {cls}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

interface QuestionFormState {
  id: string | null;
  orderIndex: number;
  subject: string;
  targetClasses: string[];
  questionText: string;
  questionImageUrl: string;
  options: Record<OptionKey, { text: string; imageUrl: string }>;
  correctAnswer: OptionKey;
  points: number;
}

function createEmptyQuestionForm(defaultSubject: string, nextOrderIndex: number): QuestionFormState {
  return {
    id: null,
    orderIndex: nextOrderIndex,
    subject: defaultSubject,
    targetClasses: [...CLASSES_7],
    questionText: '',
    questionImageUrl: '',
    options: {
      A: { text: '', imageUrl: '' },
      B: { text: '', imageUrl: '' },
      C: { text: '', imageUrl: '' },
      D: { text: '', imageUrl: '' },
    },
    correctAnswer: 'A',
    points: 20,
  };
}

function questionToFormState(q: Question): QuestionFormState {
  const optMap: Record<OptionKey, { text: string; imageUrl: string }> = {
    A: { text: '', imageUrl: '' },
    B: { text: '', imageUrl: '' },
    C: { text: '', imageUrl: '' },
    D: { text: '', imageUrl: '' },
  };
  for (const opt of q.options) {
    if (opt.key in optMap) {
      optMap[opt.key] = {
        text: opt.text || '',
        imageUrl: opt.imageUrl || '',
      };
    }
  }
  return {
    id: q.id,
    orderIndex: q.orderIndex || 1,
    subject: q.subject,
    targetClasses: [...q.targetClasses],
    questionText: q.questionText,
    questionImageUrl: q.questionImageUrl || '',
    options: optMap,
    correctAnswer: q.correctAnswer,
    points: q.points || 10,
  };
}

export const AdminQuestionsTab: React.FC<AdminQuestionsTabProps> = ({
  schedules,
  questions,
  allowedSubjects,
  onSaveSchedule,
  onDeleteSchedule,
  onDeleteAllSchedules,
  onUpsertQuestions,
  onDeleteQuestion,
  onDeleteQuestionsBatch,
  onDeleteAllQuestions,
}) => {
  const isRestrictedBySubject = Boolean(allowedSubjects && allowedSubjects.length > 0);
  const normalizedAllowed = useMemo(
    () => (allowedSubjects || []).map((s) => s.trim().toLowerCase()),
    [allowedSubjects]
  );

  const visibleSchedules = useMemo(() => {
    if (!isRestrictedBySubject) return schedules;
    return schedules.filter((s) =>
      normalizedAllowed.includes(s.subject.trim().toLowerCase())
    );
  }, [schedules, isRestrictedBySubject, normalizedAllowed]);

  const visibleQuestions = useMemo(() => {
    if (!isRestrictedBySubject) return questions;
    return questions.filter((q) =>
      normalizedAllowed.includes(q.subject.trim().toLowerCase())
    );
  }, [questions, isRestrictedBySubject, normalizedAllowed]);

  const availableSubjects = useMemo(() => {
    if (isRestrictedBySubject && allowedSubjects) {
      return [...allowedSubjects].sort();
    }
    const set = new Set<string>(schedules.map((s) => s.subject));
    questions.forEach((q) => set.add(q.subject));
    return Array.from(set).sort();
  }, [schedules, questions, isRestrictedBySubject, allowedSubjects]);

  // Multi-Subject Schedule Creation State
  const [showScheduleForm, setShowScheduleForm] = usePersistedState(
    'cbt_draft_q_show_sched_v1',
    false
  );
  const [newSchedSubject, setNewSchedSubject] = usePersistedState(
    'cbt_draft_q_sched_subj_v1',
    () => (isRestrictedBySubject && allowedSubjects?.[0] ? allowedSubjects[0] : '')
  );
  const [newSchedTitle, setNewSchedTitle] = usePersistedState('cbt_draft_q_sched_title_v1', '');
  const [newSchedKkm, setNewSchedKkm] = usePersistedState('cbt_draft_q_sched_kkm_v1', 75);
  const [newSchedDuration, setNewSchedDuration] = usePersistedState('cbt_draft_q_sched_dur_v1', 60);
  const [newSchedRandomize, setNewSchedRandomize] = usePersistedState(
    'cbt_draft_q_sched_rand_v1',
    false
  );
  const [newSchedMaxTab] = useState(3);
  const [newSchedClasses, setNewSchedClasses] = usePersistedState<string[]>(
    'cbt_draft_q_sched_classes_v1',
    () => [...ALL_CLASSES]
  );

  // Edit Schedule Target Classes Modal
  const [editingScheduleClasses, setEditingScheduleClasses] = useState<ExamSchedule | null>(null);
  const [schedModalClasses, setSchedModalClasses] = useState<string[]>([]);

  // Filters
  const [subjectFilter, setSubjectFilter] = usePersistedState('cbt_draft_q_filter_subj_v1', 'ALL');
  const [classFilter, setClassFilter] = usePersistedState('cbt_draft_q_filter_class_v1', 'ALL');
  const [searchQuery, setSearchQuery] = usePersistedState('cbt_draft_q_filter_search_v1', '');

  // Word Import Target Settings
  const [importDocxClasses, setImportDocxClasses] = useState<string[]>([...CLASSES_7]);
  const [showDocxClassPicker, setShowDocxClassPicker] = useState(false);
  const [importDocxSubject, setImportDocxSubject] = useState(
    (isRestrictedBySubject ? allowedSubjects?.[0] : visibleSchedules[0]?.subject) || 'Matematika'
  );

  // Excel Import Optional Class Override
  const [overrideExcelClasses, setOverrideExcelClasses] = useState(false);
  const [importExcelClasses, setImportExcelClasses] = useState<string[]>(['7A']);

  const [feedback, setFeedback] = useState('');
  const [isShuffling, setIsShuffling] = useState(false);
  const [showBulkDeleteMenu, setShowBulkDeleteMenu] = useState(false);
  const [bulkDeleteKind, setBulkDeleteKind] = useState<QuestionsBulkDeleteKind | null>(null);
  const [isDeletingBulk, setIsDeletingBulk] = useState(false);

  // Question Create / Edit Modal State (survives refresh so teacher/admin doesn't lose question input)
  const [questionModalOpen, setQuestionModalOpen] = usePersistedState(
    'cbt_draft_q_modal_open_v1',
    false
  );
  const [qForm, setQForm] = usePersistedState<QuestionFormState>(
    'cbt_draft_q_modal_form_v1',
    () =>
      createEmptyQuestionForm(
        availableSubjects[0] || 'Matematika',
        visibleQuestions.length + 1
      )
  );
  const [formError, setFormError] = useState('');
  const [isSavingQuestion, setIsSavingQuestion] = useState(false);

  const effectiveSubjectFilter = useMemo(() => {
    if (isRestrictedBySubject && availableSubjects.length === 1) {
      return availableSubjects[0];
    }
    if (subjectFilter !== 'ALL' && !availableSubjects.includes(subjectFilter)) {
      return 'ALL';
    }
    return subjectFilter;
  }, [isRestrictedBySubject, availableSubjects, subjectFilter]);

  const filteredQuestions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return visibleQuestions
      .filter((item) => {
        if (effectiveSubjectFilter !== 'ALL' && item.subject !== effectiveSubjectFilter) {
          return false;
        }
        if (classFilter !== 'ALL' && !item.targetClasses.includes(classFilter)) return false;
        if (
          q &&
          !item.questionText.toLowerCase().includes(q) &&
          !item.subject.toLowerCase().includes(q) &&
          !String(item.orderIndex).includes(q)
        ) {
          return false;
        }
        return true;
      })
      .sort(
        (a, b) =>
          a.subject.localeCompare(b.subject) ||
          a.orderIndex - b.orderIndex ||
          a.id.localeCompare(b.id)
      );
  }, [visibleQuestions, effectiveSubjectFilter, classFilter, searchQuery]);

  const openCreateQuestionModal = () => {
    setFormError('');
    const defaultSubject =
      effectiveSubjectFilter !== 'ALL'
        ? effectiveSubjectFilter
        : availableSubjects[0] || 'Matematika';
    const subjectCount = visibleQuestions.filter((q) => q.subject === defaultSubject).length;
    setQForm(createEmptyQuestionForm(defaultSubject, subjectCount + 1));
    setQuestionModalOpen(true);
  };

  const openEditQuestionModal = (q: Question) => {
    setFormError('');
    setQForm(questionToFormState(q));
    setQuestionModalOpen(true);
  };

  const handleCreateSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    const subj = (
      isRestrictedBySubject ? newSchedSubject || availableSubjects[0] || '' : newSchedSubject
    ).trim();
    if (!subj || newSchedClasses.length === 0) return;

    if (
      isRestrictedBySubject &&
      !normalizedAllowed.includes(subj.toLowerCase())
    ) {
      setFeedback(`Anda hanya diperbolehkan menambah jadwal untuk mapel: ${availableSubjects.join(', ')}.`);
      return;
    }

    await onSaveSchedule({
      id: `exam-${subj.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${Date.now()}`,
      subject: subj,
      title: newSchedTitle.trim() || `Penilaian Akhir Semester — ${subj}`,
      kkm: Number(newSchedKkm) || 75,
      durationMinutes: Number(newSchedDuration) || 60,
      maxTabSwitches: Number(newSchedMaxTab) || 3,
      targetClasses: newSchedClasses,
      isActive: true,
      randomizeQuestions: newSchedRandomize,
      createdAt: new Date().toISOString(),
    });

    if (!isRestrictedBySubject) {
      setNewSchedSubject('');
    }
    setNewSchedTitle('');
    setNewSchedRandomize(false);
    setShowScheduleForm(false);
    setFeedback(`Jadwal mata pelajaran "${subj}" (${formatTargetClassesSummary(newSchedClasses)}) berhasil ditambahkan.`);
  };

  const handleSaveScheduleClassesModal = async () => {
    if (!editingScheduleClasses || schedModalClasses.length === 0) return;
    await onSaveSchedule({
      ...editingScheduleClasses,
      targetClasses: schedModalClasses,
    });
    setFeedback(
      `Target kelas mata pelajaran "${editingScheduleClasses.subject}" diperbarui ke: ${formatTargetClassesSummary(schedModalClasses)}.`
    );
    setEditingScheduleClasses(null);
  };

  const handleUpdateScheduleKkmOrStatus = async (
    sched: ExamSchedule,
    patch: Partial<ExamSchedule>
  ) => {
    await onSaveSchedule({ ...sched, ...patch });
    setFeedback(`Jadwal mata pelajaran "${sched.subject}" diperbarui.`);
  };

  const handleShuffleQuestionsAndNumbers = async () => {
    const targets = filteredQuestions;
    if (targets.length < 2) {
      setFeedback('Minimal diperlukan 2 soal pada filter aktif untuk mengacak soal dan nomor.');
      return;
    }

    setIsShuffling(true);
    try {
      // Group by subject so each subject gets shuffled independently with sequential numbers 1..N
      const bySubject = new Map<string, Question[]>();
      for (const q of targets) {
        const list = bySubject.get(q.subject) || [];
        list.push(q);
        bySubject.set(q.subject, list);
      }

      const updated: Question[] = [];
      bySubject.forEach((group) => {
        const shuffled = [...group];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        // Also shuffle orderIndex pool if partial filter, or renumber 1..N cleanly
        const existingNumbers = group
          .map((item) => item.orderIndex)
          .sort((a, b) => a - b);
        const useSequential = existingNumbers.length === visibleQuestions.filter((q) => q.subject === group[0].subject).length;
        shuffled.forEach((item, idx) => {
          updated.push({
            ...item,
            orderIndex: useSequential ? idx + 1 : existingNumbers[idx],
          });
        });
      });

      await onUpsertQuestions(updated);
      setFeedback(
        `Urutan & nomor soal untuk ${updated.length} butir soal berhasil diacak (${
          effectiveSubjectFilter === 'ALL' ? 'per mata pelajaran' : effectiveSubjectFilter
        }).`
      );
    } finally {
      setIsShuffling(false);
    }
  };

  const handleImportExcel = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFeedback('');
    try {
      const { questions: parsed, errors } = await parseQuestionsExcel(file);
      let finalQuestions =
        overrideExcelClasses && importExcelClasses.length > 0
          ? parsed.map((q) => ({ ...q, targetClasses: [...importExcelClasses] }))
          : parsed;

      let skippedByRole = 0;
      if (isRestrictedBySubject) {
        const allowedList = finalQuestions.filter((q) =>
          normalizedAllowed.includes(q.subject.trim().toLowerCase())
        );
        skippedByRole = finalQuestions.length - allowedList.length;
        finalQuestions = allowedList;
      }

      if (finalQuestions.length > 0) {
        await onUpsertQuestions(finalQuestions);
      }
      setFeedback(
        `Berhasil mengimpor ${finalQuestions.length} soal dari Excel.${
          skippedByRole > 0
            ? ` (${skippedByRole} soal dilewati karena bukan mata pelajaran Anda)`
            : ''
        }${errors.length > 0 ? ` (${errors.length} baris dilewati)` : ''}`
      );
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Gagal membaca file Excel soal.');
    }
    e.target.value = '';
  };

  const handleImportDocx = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFeedback('');
    try {
      const safeDocxSubject =
        isRestrictedBySubject && !normalizedAllowed.includes(importDocxSubject.trim().toLowerCase())
          ? availableSubjects[0] || importDocxSubject
          : importDocxSubject;

      const { questions: parsed, errors } = await parseQuestionsDocx(
        file,
        importDocxClasses.length > 0 ? importDocxClasses : ALL_CLASSES,
        safeDocxSubject
      );

      const finalQuestions = isRestrictedBySubject
        ? parsed.map((q) => ({ ...q, subject: safeDocxSubject }))
        : parsed;

      if (finalQuestions.length > 0) {
        await onUpsertQuestions(finalQuestions);
      }
      setFeedback(
        `Berhasil mengimpor ${finalQuestions.length} soal dari Word (.docx) untuk mapel ${safeDocxSubject} (${formatTargetClassesSummary(importDocxClasses)}).${
          errors.length > 0 ? ` (${errors.length} soal dilewati)` : ''
        }`
      );
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Gagal membaca dokumen Word.');
    }
    e.target.value = '';
  };

  const handleUploadQuestionImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const compressed = await compressQuestionImage(file, 820);
      setQForm((prev) => ({ ...prev, questionImageUrl: compressed }));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Gagal memproses gambar soal.');
    }
    e.target.value = '';
  };

  const handleUploadOptionImage = async (
    key: OptionKey,
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const compressed = await compressQuestionImage(file, 480);
      setQForm((prev) => ({
        ...prev,
        options: {
          ...prev.options,
          [key]: { ...prev.options[key], imageUrl: compressed },
        },
      }));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : `Gagal memproses gambar opsi ${key}.`);
    }
    e.target.value = '';
  };

  const buildQuestionPayloadFromForm = (): Question | null => {
    if (!qForm.questionText.trim() && !qForm.questionImageUrl.trim()) {
      setFormError('Masukkan teks pertanyaan atau lampirkan gambar soal.');
      return null;
    }
    if (qForm.targetClasses.length === 0) {
      setFormError('Pilih minimal satu target kelas untuk soal ini.');
      return null;
    }
    for (const key of OPTION_KEYS) {
      const opt = qForm.options[key];
      if (!opt.text.trim() && !opt.imageUrl.trim()) {
        setFormError(`Opsi ${key} harus diisi teks atau dilampirkan gambar.`);
        return null;
      }
    }

    const builtOptions: QuestionOption[] = OPTION_KEYS.map((key) => ({
      key,
      text: qForm.options[key].text.trim(),
      imageUrl: qForm.options[key].imageUrl.trim() || undefined,
    }));

    return {
      id: qForm.id || `q-man-${Date.now()}`,
      subject: qForm.subject.trim() || 'Matematika',
      targetClasses: [...qForm.targetClasses],
      questionText: qForm.questionText.trim(),
      questionImageUrl: qForm.questionImageUrl.trim() || undefined,
      options: builtOptions,
      correctAnswer: qForm.correctAnswer,
      points: Number(qForm.points) || 10,
      orderIndex: Math.max(1, Number(qForm.orderIndex) || 1),
    };
  };

  const handleSaveQuestionModal = async (goToNext = false) => {
    setFormError('');
    const payload = buildQuestionPayloadFromForm();
    if (!payload) return;

    setIsSavingQuestion(true);
    try {
      await onUpsertQuestions([payload]);
      setFeedback(
        qForm.id
          ? `Soal Nomor ${payload.orderIndex} (${payload.subject}) berhasil diperbarui.`
          : `Soal baru Nomor ${payload.orderIndex} (${payload.subject}) berhasil disimpan.`
      );

      if (goToNext && qForm.id) {
        const currentIdx = filteredQuestions.findIndex((item) => item.id === qForm.id);
        const nextQuestion =
          currentIdx >= 0 && currentIdx + 1 < filteredQuestions.length
            ? filteredQuestions[currentIdx + 1]
            : null;
        if (nextQuestion) {
          setQForm(questionToFormState(nextQuestion));
          return;
        }
      }
      setQuestionModalOpen(false);
    } finally {
      setIsSavingQuestion(false);
    }
  };

  const insertLatexSnippet = (snippet: string) => {
    setQForm((prev) => ({
      ...prev,
      questionText: prev.questionText ? `${prev.questionText} ${snippet}` : snippet,
    }));
  };

  const currentEditingListIndex = useMemo(() => {
    if (!qForm.id) return -1;
    return filteredQuestions.findIndex((item) => item.id === qForm.id);
  }, [qForm.id, filteredQuestions]);

  const hasNextQuestion =
    currentEditingListIndex >= 0 && currentEditingListIndex + 1 < filteredQuestions.length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 tracking-tight">
            Bank Soal &amp; Jadwal Mata Pelajaran
          </h1>
          <p className="text-sm text-slate-600 mt-0.5">
            Kelola mapel, target kelas spesifik (mis. 7A saja), buat atau edit tiap nomor soal dengan LaTeX serta upload gambar pada pertanyaan dan opsi jawaban.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {(visibleQuestions.length > 0 || visibleSchedules.length > 0) && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowBulkDeleteMenu((v) => !v)}
                className="inline-flex items-center gap-2 px-3.5 py-2.5 rounded-xl border border-rose-300 bg-rose-50 hover:bg-rose-100 text-rose-800 text-sm font-semibold cursor-pointer whitespace-nowrap transition-colors"
              >
                <Trash2 className="w-4 h-4" />
                <span>Hapus Semua Data</span>
                <ChevronDown className="w-3.5 h-3.5" />
              </button>

              {showBulkDeleteMenu && (
                <>
                  <div
                    className="fixed inset-0 z-20"
                    onClick={() => setShowBulkDeleteMenu(false)}
                  />
                  <div className="absolute right-0 mt-2 w-80 bg-white rounded-xl border border-slate-200 shadow-xl z-30 p-1.5 space-y-1">
                    <button
                      type="button"
                      disabled={filteredQuestions.length === 0}
                      onClick={() => {
                        setShowBulkDeleteMenu(false);
                        setBulkDeleteKind('questions_filtered');
                      }}
                      className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                    >
                      <div className="text-xs font-bold text-slate-900">
                        Hapus Soal Sesuai Filter ({filteredQuestions.length} soal)
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        Menghapus butir soal yang tampil pada filter mapel/kelas saat ini
                      </div>
                    </button>

                    <button
                      type="button"
                      disabled={visibleQuestions.length === 0}
                      onClick={() => {
                        setShowBulkDeleteMenu(false);
                        setBulkDeleteKind('questions_all');
                      }}
                      className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-rose-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer border-t border-slate-100"
                    >
                      <div className="text-xs font-bold text-rose-800">
                        Hapus Semua Data Bank Soal ({visibleQuestions.length} soal)
                      </div>
                      <div className="text-[11px] text-rose-700/80 mt-0.5">
                        {isRestrictedBySubject
                          ? 'Bersihkan semua butir soal pada mata pelajaran Anda'
                          : 'Bersihkan seluruh butir soal untuk semua mapel'}
                      </div>
                    </button>

                    <button
                      type="button"
                      disabled={visibleSchedules.length === 0}
                      onClick={() => {
                        setShowBulkDeleteMenu(false);
                        setBulkDeleteKind('schedules_all');
                      }}
                      className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-rose-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer border-t border-slate-100"
                    >
                      <div className="text-xs font-bold text-rose-800">
                        Hapus Semua Data Mapel &amp; Jadwal ({visibleSchedules.length} mapel)
                      </div>
                      <div className="text-[11px] text-rose-700/80 mt-0.5">
                        {isRestrictedBySubject
                          ? 'Bersihkan semua jadwal ujian pada mata pelajaran Anda'
                          : 'Bersihkan seluruh jadwal mata pelajaran & KKM'}
                      </div>
                    </button>

                    <button
                      type="button"
                      disabled={visibleQuestions.length === 0 && visibleSchedules.length === 0}
                      onClick={() => {
                        setShowBulkDeleteMenu(false);
                        setBulkDeleteKind('both_all');
                      }}
                      className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-rose-50 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer border-t border-slate-100"
                    >
                      <div className="text-xs font-bold text-rose-900">
                        Hapus Semua Soal &amp; Mapel Sekaligus
                      </div>
                      <div className="text-[11px] text-rose-700/80 mt-0.5">
                        Menghapus {visibleQuestions.length} butir soal dan {visibleSchedules.length} jadwal mapel
                      </div>
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowScheduleForm((v) => !v)}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-sm font-semibold cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            <span>Tambah Mapel &amp; KKM</span>
          </button>

          <button
            type="button"
            onClick={openCreateQuestionModal}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white text-sm font-semibold cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            <span>Buat Soal (LaTeX / Gambar)</span>
          </button>
        </div>
      </div>

      {feedback && (
        <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-900 text-sm flex items-center justify-between gap-3">
          <span>{feedback}</span>
          <button
            type="button"
            onClick={() => setFeedback('')}
            className="p-1 rounded-lg hover:bg-emerald-100 text-emerald-700 cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Create New Subject Schedule + Specific Class Targets */}
      {showScheduleForm && (
        <form
          onSubmit={handleCreateSchedule}
          className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4"
        >
          <div className="flex items-center justify-between">
            <h2 className="font-display font-bold text-slate-900 text-base">
              Tambah Mata Pelajaran &amp; Jadwal Baru
            </h2>
            <button
              type="button"
              onClick={() => setShowScheduleForm(false)}
              className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
            <div className="sm:col-span-4">
              <label className="block text-xs font-semibold text-slate-600 mb-1">
                Nama Mata Pelajaran
              </label>
              {isRestrictedBySubject ? (
                <select
                  value={newSchedSubject || availableSubjects[0] || ''}
                  onChange={(e) => setNewSchedSubject(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-white text-sm font-medium"
                >
                  {availableSubjects.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  required
                  placeholder="Mis. Bahasa Inggris"
                  value={newSchedSubject}
                  onChange={(e) => setNewSchedSubject(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm"
                />
              )}
            </div>
            <div className="sm:col-span-4">
              <label className="block text-xs font-semibold text-slate-600 mb-1">
                Judul Sesi / Paket Ujian
              </label>
              <input
                type="text"
                placeholder="Otomatis jika dikosongkan"
                value={newSchedTitle}
                onChange={(e) => setNewSchedTitle(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-600 mb-1">
                KKM Mapel
              </label>
              <input
                type="number"
                min={0}
                max={100}
                required
                value={newSchedKkm}
                onChange={(e) => setNewSchedKkm(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl border border-slate-300 font-mono text-sm font-bold"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-600 mb-1">
                Durasi (Menit)
              </label>
              <input
                type="number"
                min={5}
                max={300}
                required
                value={newSchedDuration}
                onChange={(e) => setNewSchedDuration(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl border border-slate-300 font-mono text-sm"
              />
            </div>
          </div>

          <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={newSchedRandomize}
              onChange={(e) => setNewSchedRandomize(e.target.checked)}
              className="w-4 h-4 accent-[#064e3b]"
            />
            <span>
              Acak soal &amp; nomor per peserta (soal berbeda pada nomor yang sama tiap peserta; jika nonaktif semua peserta mengerjakan soal &amp; nomor yang sama)
            </span>
          </label>

          <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200">
            <ClassTargetSelector
              selectedClasses={newSchedClasses}
              onChange={setNewSchedClasses}
            />
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={newSchedClasses.length === 0}
              className="px-5 py-2 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white text-sm font-semibold cursor-pointer disabled:opacity-50"
            >
              Simpan Mata Pelajaran
            </button>
          </div>
        </form>
      )}

      {/* Multi-Subject Schedule Table with Editable KKM, Specific Target Classes, Randomize & Active Switch */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 bg-slate-50/70">
          <div className="flex items-center gap-2 font-display font-bold text-slate-900 text-sm">
            <Clock className="w-4 h-4 text-emerald-700" />
            <span>Daftar Mata Pelajaran &amp; KKM Ujian ({visibleSchedules.length} Mapel)</span>
          </div>
          {visibleSchedules.length > 0 && (
            <button
              type="button"
              onClick={() => setBulkDeleteKind('schedules_all')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-800 text-xs font-semibold cursor-pointer transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Hapus Semua Mapel</span>
            </button>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                <th className="py-2.5 px-4">Mata Pelajaran</th>
                <th className="py-2.5 px-4">KKM</th>
                <th className="py-2.5 px-4">Durasi</th>
                <th className="py-2.5 px-4">Target Kelas (Klik untuk Atur)</th>
                <th className="py-2.5 px-4">Acak Soal &amp; Nomor</th>
                <th className="py-2.5 px-4">Status Ujian</th>
                <th className="py-2.5 px-4 text-right">Hapus</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {visibleSchedules.map((sched) => (
                <tr key={sched.id} className="hover:bg-slate-50/60">
                  <td className="py-2.5 px-4">
                    <div className="font-semibold text-slate-900">{sched.subject}</div>
                    <div className="text-xs text-slate-500">{sched.title}</div>
                  </td>
                  <td className="py-2.5 px-4">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={sched.kkm}
                      onChange={(e) =>
                        void handleUpdateScheduleKkmOrStatus(sched, {
                          kkm: Number(e.target.value) || 0,
                        })
                      }
                      className="w-16 px-2 py-1 rounded-lg border border-slate-300 font-mono text-xs font-bold text-center"
                    />
                  </td>
                  <td className="py-2.5 px-4">
                    <div className="inline-flex items-center gap-1">
                      <input
                        type="number"
                        min={5}
                        max={300}
                        value={sched.durationMinutes}
                        onChange={(e) =>
                          void handleUpdateScheduleKkmOrStatus(sched, {
                            durationMinutes: Number(e.target.value) || 60,
                          })
                        }
                        className="w-16 px-2 py-1 rounded-lg border border-slate-300 font-mono text-xs text-center"
                      />
                      <span className="text-xs text-slate-500">mnt</span>
                    </div>
                  </td>
                  <td className="py-2.5 px-4">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingScheduleClasses(sched);
                        setSchedModalClasses([...sched.targetClasses]);
                      }}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-slate-200 bg-slate-50 hover:bg-emerald-50 hover:border-emerald-300 text-slate-700 hover:text-emerald-900 font-mono text-xs font-semibold cursor-pointer transition-colors"
                    >
                      <Pencil className="w-3 h-3" />
                      <span>{formatTargetClassesSummary(sched.targetClasses)}</span>
                    </button>
                  </td>
                  <td className="py-2.5 px-4">
                    <label className="inline-flex items-center gap-2 text-xs font-semibold cursor-pointer">
                      <input
                        type="checkbox"
                        checked={Boolean(sched.randomizeQuestions)}
                        onChange={(e) =>
                          void handleUpdateScheduleKkmOrStatus(sched, {
                            randomizeQuestions: e.target.checked,
                          })
                        }
                        className="w-4 h-4 accent-[#064e3b]"
                      />
                      <span className={sched.randomizeQuestions ? 'text-emerald-700' : 'text-slate-500'}>
                        {sched.randomizeQuestions ? 'Diacak (Beda Tiap Peserta)' : 'Urut (Sama Tiap Peserta)'}
                      </span>
                    </label>
                  </td>
                  <td className="py-2.5 px-4">
                    <label className="inline-flex items-center gap-2 text-xs font-semibold cursor-pointer">
                      <input
                        type="checkbox"
                        checked={sched.isActive}
                        onChange={(e) =>
                          void handleUpdateScheduleKkmOrStatus(sched, {
                            isActive: e.target.checked,
                          })
                        }
                        className="w-4 h-4 accent-[#064e3b]"
                      />
                      <span className={sched.isActive ? 'text-emerald-700' : 'text-slate-400'}>
                        {sched.isActive ? 'Aktif' : 'Nonaktif'}
                      </span>
                    </label>
                  </td>
                  <td className="py-2.5 px-4 text-right">
                    <button
                      type="button"
                      onClick={() => void onDeleteSchedule(sched.id)}
                      title="Hapus jadwal mata pelajaran"
                      className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Importers: Excel + Word (.docx) with Specific Class Target Settings */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Excel Importer */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
          <div className="flex items-center gap-2 font-display font-bold text-slate-900 text-base">
            <FileSpreadsheet className="w-4 h-4 text-emerald-700" />
            <span>Impor Bank Soal Excel (.xlsx / .csv)</span>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed">
            Mendukung rumus LaTeX (<code className="font-mono">$...$</code>), <code className="font-mono">Gambar URL</code>, serta kolom opsional <code className="font-mono">Gambar Opsi A–D</code>. Kolom <code className="font-mono">Target Kelas</code> mendukung format spesifik seperti <code className="font-mono">7A</code> atau <code className="font-mono">VII A, VII B</code>.
          </p>

          <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={overrideExcelClasses}
              onChange={(e) => setOverrideExcelClasses(e.target.checked)}
              className="w-4 h-4 accent-[#064e3b]"
            />
            <span>Terapkan target kelas spesifik untuk semua soal yang diimpor</span>
          </label>

          {overrideExcelClasses && (
            <ClassTargetSelector
              selectedClasses={importExcelClasses}
              onChange={setImportExcelClasses}
              compact
            />
          )}

          <div className="flex flex-wrap items-center gap-2.5 pt-1">
            <button
              type="button"
              onClick={downloadQuestionsTemplate}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold cursor-pointer"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-700" />
              <span>Unduh Template Excel</span>
            </button>
            <label className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold cursor-pointer">
              <Upload className="w-3.5 h-3.5" />
              <span>Impor File Excel</span>
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleImportExcel}
                className="sr-only"
              />
            </label>
          </div>
        </div>

        {/* Word (.docx) Importer */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
          <div className="flex items-center gap-2 font-display font-bold text-slate-900 text-base">
            <FileText className="w-4 h-4 text-emerald-700" />
            <span>Impor Bank Soal Word (.docx)</span>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed">
            Unduh template Word (.docx) agar struktur nomor soal, LaTeX, opsi A–D, dan Kunci jawaban terbaca otomatis. Atur target kelas spesifik sebelum mengunggah.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={importDocxSubject}
              onChange={(e) => setImportDocxSubject(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium"
            >
              {availableSubjects.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setShowDocxClassPicker((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-700 bg-emerald-50 text-emerald-900 text-xs font-semibold cursor-pointer"
            >
              <CheckSquare className="w-3.5 h-3.5" />
              <span>Target: {formatTargetClassesSummary(importDocxClasses)}</span>
            </button>
          </div>

          {showDocxClassPicker && (
            <ClassTargetSelector
              selectedClasses={importDocxClasses}
              onChange={setImportDocxClasses}
              compact
            />
          )}

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => void downloadQuestionsWordTemplate()}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold cursor-pointer"
            >
              <FileText className="w-3.5 h-3.5 text-emerald-700" />
              <span>Unduh Template Word (.docx)</span>
            </button>
            <label className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white text-xs font-semibold cursor-pointer">
              <Upload className="w-3.5 h-3.5" />
              <span>Impor File Word (.docx)</span>
              <input
                type="file"
                accept=".docx"
                onChange={handleImportDocx}
                className="sr-only"
              />
            </label>
          </div>
        </div>
      </div>

      {/* Question Bank Listing */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari nomor, teks soal, atau mapel..."
              className="w-full pl-10 pr-4 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <select
              value={effectiveSubjectFilter}
              onChange={(e) => setSubjectFilter(e.target.value)}
              disabled={isRestrictedBySubject && availableSubjects.length <= 1}
              className="px-3 py-2 rounded-xl border border-slate-300 bg-white text-sm font-medium text-slate-700 disabled:bg-slate-100"
            >
              {(!isRestrictedBySubject || availableSubjects.length > 1) && (
                <option value="ALL">
                  {isRestrictedBySubject ? 'Semua Mapel Saya' : 'Semua Mata Pelajaran'}
                </option>
              )}
              {availableSubjects.map((subj) => (
                <option key={subj} value={subj}>
                  {subj}
                </option>
              ))}
            </select>

            <select
              value={classFilter}
              onChange={(e) => setClassFilter(e.target.value)}
              className="px-3 py-2 rounded-xl border border-slate-300 bg-white text-sm font-medium text-slate-700"
            >
              <option value="ALL">Semua Target Kelas</option>
              {ALL_CLASSES.map((cls) => (
                <option key={cls} value={cls}>
                  Filter Kelas {cls}
                </option>
              ))}
            </select>

            <button
              type="button"
              disabled={isShuffling || filteredQuestions.length < 2}
              onClick={() => void handleShuffleQuestionsAndNumbers()}
              title="Acak ulang urutan & nomor master pada bank soal"
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-emerald-700 bg-emerald-50 hover:bg-emerald-100 text-emerald-900 text-xs font-semibold transition-colors cursor-pointer disabled:opacity-40 whitespace-nowrap"
            >
              <Shuffle className="w-3.5 h-3.5" />
              <span>{isShuffling ? 'Mengacak...' : 'Acak Urutan Bank Soal'}</span>
            </button>

            {visibleQuestions.length > 0 && (
              <button
                type="button"
                onClick={() => setBulkDeleteKind('questions_all')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-800 text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Hapus Semua Soal</span>
              </button>
            )}

            <span className="text-xs font-mono text-slate-500 tabular-nums whitespace-nowrap">
              {filteredQuestions.length} butir soal
            </span>
          </div>
        </div>

        <div className="divide-y divide-slate-100">
          {filteredQuestions.length === 0 ? (
            <div className="py-10 px-4 text-center text-sm text-slate-500">
              Tidak ada soal yang cocok dengan filter mata pelajaran atau kelas.
            </div>
          ) : (
            filteredQuestions.map((q) => (
              <div
                key={q.id}
                className="p-4 sm:p-5 flex items-start justify-between gap-4 hover:bg-slate-50/60"
              >
                <div className="space-y-2.5 min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 font-medium">
                    <span className="font-mono font-bold text-slate-800 bg-slate-100 px-2 py-0.5 rounded-md">
                      No. {q.orderIndex}
                    </span>
                    <span className="text-emerald-800 font-semibold">{q.subject}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      Kelas:{' '}
                      <span className="font-mono font-semibold text-slate-700">
                        {formatTargetClassesSummary(q.targetClasses)}
                      </span>
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      Kunci: <strong className="font-mono text-slate-900">{q.correctAnswer}</strong>
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono">{q.points} poin</span>
                  </div>

                  {q.questionImageUrl && (
                    <img
                      src={q.questionImageUrl}
                      alt={`Gambar Soal No. ${q.orderIndex}`}
                      referrerPolicy="no-referrer"
                      className="max-h-32 rounded-lg border border-slate-200 object-contain bg-white p-1"
                    />
                  )}

                  <div className="text-sm font-medium text-slate-900 leading-relaxed">
                    <MathText text={q.questionText} />
                  </div>

                  {/* Option Previews including option images */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                    {q.options.map((opt) => {
                      const isCorrect = opt.key === q.correctAnswer;
                      return (
                        <div
                          key={opt.key}
                          className={`rounded-xl border px-3 py-2 text-xs flex items-start gap-2 ${
                            isCorrect
                              ? 'bg-emerald-50/70 border-emerald-300 text-emerald-950'
                              : 'bg-slate-50/70 border-slate-200 text-slate-700'
                          }`}
                        >
                          <span
                            className={`font-mono font-bold px-1.5 py-0.5 rounded shrink-0 ${
                              isCorrect ? 'bg-[#064e3b] text-white' : 'bg-white border border-slate-200 text-slate-700'
                            }`}
                          >
                            {opt.key}
                          </span>
                          <div className="min-w-0 flex-1 space-y-1.5">
                            {opt.text && (
                              <div className="break-words">
                                <MathText text={opt.text} />
                              </div>
                            )}
                            {opt.imageUrl && (
                              <img
                                src={opt.imageUrl}
                                alt={`Gambar Opsi ${opt.key}`}
                                referrerPolicy="no-referrer"
                                className="max-h-20 rounded border border-slate-200 bg-white object-contain p-0.5"
                              />
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => openEditQuestionModal(q)}
                    title={`Edit soal nomor ${q.orderIndex}`}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-emerald-50 hover:border-emerald-300 text-slate-700 hover:text-emerald-900 text-xs font-semibold transition-colors cursor-pointer"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    <span>Edit</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void onDeleteQuestion(q.id)}
                    title="Hapus soal"
                    className="p-2 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Modal: Create / Edit Question (supports Question & Option Image Uploads + Specific Class Targets) */}
      {questionModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5">
          <div className="w-full max-w-3xl max-h-[92vh] bg-white rounded-2xl border border-slate-200 shadow-2xl flex flex-col overflow-hidden">
            <div className="px-5 py-4 bg-[#064e3b] text-white flex items-center justify-between gap-3 shrink-0">
              <div>
                <h3 className="font-display font-bold text-base">
                  {qForm.id
                    ? `Edit Soal Nomor ${qForm.orderIndex}`
                    : 'Buat Soal Baru (LaTeX & Gambar Soal/Opsi)'}
                </h3>
                <p className="text-xs text-emerald-100/85">
                  Atur target kelas spesifik, rumus LaTeX, gambar soal, dan gambar untuk tiap opsi jawaban A–D.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setQuestionModalOpen(false)}
                className="p-1.5 rounded-lg text-emerald-100 hover:bg-white/10 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 sm:p-6 space-y-5 overflow-y-auto flex-1">
              {formError && (
                <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-800 text-xs sm:text-sm">
                  {formError}
                </div>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">
                    Nomor Soal
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={qForm.orderIndex}
                    onChange={(e) =>
                      setQForm((prev) => ({
                        ...prev,
                        orderIndex: Math.max(1, Number(e.target.value) || 1),
                      }))
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 font-mono text-sm font-bold"
                  />
                </div>
                <div className="col-span-2 sm:col-span-1">
                  <label className="block text-xs font-semibold text-slate-600 mb-1">
                    Mata Pelajaran
                  </label>
                  <select
                    value={qForm.subject}
                    onChange={(e) => setQForm((prev) => ({ ...prev, subject: e.target.value }))}
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-white text-sm font-medium"
                  >
                    {availableSubjects.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">
                    Kunci Jawaban
                  </label>
                  <select
                    value={qForm.correctAnswer}
                    onChange={(e) =>
                      setQForm((prev) => ({
                        ...prev,
                        correctAnswer: e.target.value as OptionKey,
                      }))
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-white font-mono text-sm font-bold"
                  >
                    {OPTION_KEYS.map((k) => (
                      <option key={k} value={k}>
                        Opsi {k}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">
                    Bobot Poin
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={qForm.points}
                    onChange={(e) =>
                      setQForm((prev) => ({ ...prev, points: Number(e.target.value) || 1 }))
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 font-mono text-sm"
                  />
                </div>
              </div>

              {/* Target Kelas Spesifik */}
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200">
                <ClassTargetSelector
                  selectedClasses={qForm.targetClasses}
                  onChange={(classes) => setQForm((prev) => ({ ...prev, targetClasses: classes }))}
                />
              </div>

              {/* Teks Pertanyaan + LaTeX */}
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="text-xs font-semibold text-slate-600 flex items-center gap-1.5">
                    <Sigma className="w-3.5 h-3.5 text-emerald-700" />
                    <span>Teks Pertanyaan (Gunakan $...$ untuk rumus LaTeX)</span>
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      { label: 'Pecahan', code: '$\\frac{a}{b}$' },
                      { label: 'Akar', code: '$\\sqrt{x}$' },
                      { label: 'Pangkat', code: '$x^2$' },
                      { label: 'Pi', code: '$\\pi$' },
                      { label: 'Kali', code: '$\\times$' },
                    ].map((s) => (
                      <button
                        key={s.label}
                        type="button"
                        onClick={() => insertLatexSnippet(s.code)}
                        className="px-2 py-1 rounded bg-slate-100 hover:bg-emerald-50 text-slate-700 hover:text-emerald-900 text-xs font-medium cursor-pointer"
                      >
                        + {s.label}
                      </button>
                    ))}
                  </div>
                </div>
                <textarea
                  rows={3}
                  value={qForm.questionText}
                  onChange={(e) =>
                    setQForm((prev) => ({ ...prev, questionText: e.target.value }))
                  }
                  placeholder="Contoh: Hitunglah nilai $x$ jika $\frac{2x+4}{3} = 6$..."
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
                />
                {qForm.questionText.trim() && (
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-sm">
                    <div className="text-[11px] font-semibold text-slate-500 mb-1">
                      Pratinjau Render LaTeX:
                    </div>
                    <MathText text={qForm.questionText} className="text-slate-900" />
                  </div>
                )}
              </div>

              {/* Gambar Pertanyaan */}
              <div className="space-y-2">
                <label className="block text-xs font-semibold text-slate-600">
                  Gambar Pertanyaan (Opsional — Upload Langsung atau Tempel URL)
                </label>
                <div className="flex flex-col sm:flex-row gap-2">
                  <div className="relative flex-1">
                    <Link2 className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={qForm.questionImageUrl}
                      onChange={(e) =>
                        setQForm((prev) => ({ ...prev, questionImageUrl: e.target.value }))
                      }
                      placeholder="URL gambar soal (https://...) atau upload"
                      className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-300 text-xs sm:text-sm"
                    />
                  </div>
                  <label className="inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-xl bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border border-emerald-200 text-xs font-semibold cursor-pointer whitespace-nowrap">
                    <ImagePlus className="w-4 h-4" />
                    <span>Upload Gambar Soal</span>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleUploadQuestionImage}
                      className="sr-only"
                    />
                  </label>
                  {qForm.questionImageUrl && (
                    <button
                      type="button"
                      onClick={() => setQForm((prev) => ({ ...prev, questionImageUrl: '' }))}
                      className="px-3 py-2 rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50 text-xs font-semibold cursor-pointer"
                    >
                      Hapus
                    </button>
                  )}
                </div>
                {qForm.questionImageUrl && (
                  <div className="p-2 rounded-xl border border-slate-200 bg-slate-50 inline-block">
                    <img
                      src={qForm.questionImageUrl}
                      alt="Pratinjau Gambar Soal"
                      referrerPolicy="no-referrer"
                      className="max-h-36 object-contain rounded-lg"
                    />
                  </div>
                )}
              </div>

              {/* Opsi Jawaban A–D dengan Upload Gambar */}
              <div className="space-y-3">
                <div className="text-xs font-semibold text-slate-700">
                  Opsi Jawaban A–D (Mendukung Teks LaTeX &amp; Upload Gambar Per Opsi)
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {OPTION_KEYS.map((key) => {
                    const optVal = qForm.options[key];
                    const isKey = qForm.correctAnswer === key;
                    return (
                      <div
                        key={key}
                        className={`p-3 rounded-xl border space-y-2 ${
                          isKey
                            ? 'bg-emerald-50/50 border-emerald-400'
                            : 'bg-slate-50/60 border-slate-200'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono font-bold text-xs text-slate-800">
                            Opsi {key} {isKey ? '(Kunci)' : ''}
                          </span>
                          <div className="flex items-center gap-1.5">
                            <label className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white hover:bg-emerald-50 border border-slate-200 hover:border-emerald-300 text-slate-700 hover:text-emerald-900 text-[11px] font-semibold cursor-pointer">
                              <ImagePlus className="w-3.5 h-3.5" />
                              <span>{optVal.imageUrl ? 'Ganti Gambar' : 'Upload Gambar'}</span>
                              <input
                                type="file"
                                accept="image/*"
                                onChange={(e) => void handleUploadOptionImage(key, e)}
                                className="sr-only"
                              />
                            </label>
                            {optVal.imageUrl && (
                              <button
                                type="button"
                                onClick={() =>
                                  setQForm((prev) => ({
                                    ...prev,
                                    options: {
                                      ...prev.options,
                                      [key]: { ...prev.options[key], imageUrl: '' },
                                    },
                                  }))
                                }
                                className="px-2 py-1 rounded-lg border border-red-200 bg-white text-red-600 hover:bg-red-50 text-[11px] font-semibold cursor-pointer"
                              >
                                Hapus
                              </button>
                            )}
                          </div>
                        </div>

                        <input
                          type="text"
                          placeholder={`Teks Opsi ${key} (mendukung $LaTeX$)`}
                          value={optVal.text}
                          onChange={(e) =>
                            setQForm((prev) => ({
                              ...prev,
                              options: {
                                ...prev.options,
                                [key]: { ...prev.options[key], text: e.target.value },
                              },
                            }))
                          }
                          className="w-full px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm"
                        />

                        <input
                          type="text"
                          placeholder={`URL gambar opsi ${key} (opsional)`}
                          value={optVal.imageUrl}
                          onChange={(e) =>
                            setQForm((prev) => ({
                              ...prev,
                              options: {
                                ...prev.options,
                                [key]: { ...prev.options[key], imageUrl: e.target.value },
                              },
                            }))
                          }
                          className="w-full px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs text-slate-600"
                        />

                        {optVal.imageUrl && (
                          <div className="p-1.5 rounded-lg bg-white border border-slate-200 inline-block">
                            <img
                              src={optVal.imageUrl}
                              alt={`Pratinjau Opsi ${key}`}
                              referrerPolicy="no-referrer"
                              className="max-h-24 object-contain rounded"
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="px-5 py-4 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center justify-end gap-2.5 shrink-0">
              <button
                type="button"
                disabled={isSavingQuestion}
                onClick={() => setQuestionModalOpen(false)}
                className="px-4 py-2 rounded-xl border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 text-sm font-semibold cursor-pointer"
              >
                Batal
              </button>

              {qForm.id && hasNextQuestion && (
                <button
                  type="button"
                  disabled={isSavingQuestion}
                  onClick={() => void handleSaveQuestionModal(true)}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-emerald-700 text-emerald-900 bg-emerald-50 hover:bg-emerald-100 text-sm font-semibold cursor-pointer disabled:opacity-60"
                >
                  <span>Simpan &amp; Soal Berikutnya</span>
                  <ChevronRight className="w-4 h-4" />
                </button>
              )}

              <button
                type="button"
                disabled={isSavingQuestion}
                onClick={() => void handleSaveQuestionModal(false)}
                className="px-5 py-2 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white text-sm font-semibold cursor-pointer disabled:opacity-60"
              >
                {isSavingQuestion
                  ? 'Menyimpan...'
                  : qForm.id
                    ? 'Simpan Perubahan Soal'
                    : 'Simpan Soal Baru'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Edit Target Classes for an Existing Subject Schedule */}
      {editingScheduleClasses && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-2xl bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden">
            <div className="px-5 py-4 bg-[#064e3b] text-white flex items-center justify-between">
              <div>
                <h3 className="font-display font-bold text-base">
                  Atur Target Kelas — {editingScheduleClasses.subject}
                </h3>
                <p className="text-xs text-emerald-100/85">
                  Pilih kelas spesifik yang diizinkan mengikuti ujian mata pelajaran ini (mis. VII A saja).
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingScheduleClasses(null)}
                className="p-1.5 rounded-lg text-emerald-100 hover:bg-white/10 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <ClassTargetSelector
                selectedClasses={schedModalClasses}
                onChange={setSchedModalClasses}
              />

              <div className="flex justify-end gap-2.5 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setEditingScheduleClasses(null)}
                  className="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-semibold cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="button"
                  disabled={schedModalClasses.length === 0}
                  onClick={() => void handleSaveScheduleClassesModal()}
                  className="px-5 py-2 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white text-sm font-semibold cursor-pointer disabled:opacity-50"
                >
                  Simpan Target Kelas
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal: Bulk Delete Questions / Schedules */}
      {bulkDeleteKind && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden">
            <div className="px-5 py-4 bg-rose-50 border-b border-rose-200 flex items-center justify-between">
              <div className="flex items-center gap-2 font-display font-bold text-rose-950 text-base">
                <AlertTriangle className="w-5 h-5 text-rose-700" />
                <span>Konfirmasi Hapus Data Bank Soal &amp; Mapel</span>
              </div>
              <button
                type="button"
                disabled={isDeletingBulk}
                onClick={() => setBulkDeleteKind(null)}
                className="p-1 rounded-lg text-rose-900/70 hover:bg-rose-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="text-sm text-slate-700 space-y-2 leading-relaxed">
                {bulkDeleteKind === 'questions_filtered' && (
                  <p>
                    Anda akan menghapus{' '}
                    <strong className="text-rose-800">
                      {filteredQuestions.length} butir soal
                    </strong>{' '}
                    yang sedang tampil sesuai filter saat ini.
                  </p>
                )}
                {bulkDeleteKind === 'questions_all' && (
                  <p>
                    Anda akan menghapus{' '}
                    <strong className="text-rose-800">
                      SEMUA DATA BANK SOAL ({visibleQuestions.length} butir soal)
                    </strong>
                    {isRestrictedBySubject
                      ? ' pada mata pelajaran yang ditugaskan kepada Anda'
                      : ' untuk seluruh mata pelajaran'}
                    .
                  </p>
                )}
                {bulkDeleteKind === 'schedules_all' && (
                  <p>
                    Anda akan menghapus{' '}
                    <strong className="text-rose-800">
                      SEMUA DATA MAPEL &amp; JADWAL ({visibleSchedules.length} mapel)
                    </strong>
                    {isRestrictedBySubject
                      ? ' pada mata pelajaran yang ditugaskan kepada Anda'
                      : ''}
                    .
                  </p>
                )}
                {bulkDeleteKind === 'both_all' && (
                  <p>
                    Anda akan menghapus{' '}
                    <strong className="text-rose-800">
                      SEMUA BANK SOAL ({visibleQuestions.length} soal) &amp; SEMUA MAPEL/JADWAL ({visibleSchedules.length} mapel)
                    </strong>{' '}
                    sekaligus.
                  </p>
                )}

                <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl p-3">
                  Data yang dihapus akan terhapus permanen dari penyimpanan lokal IndexedDB maupun Supabase Cloud.
                </p>
              </div>

              <div className="flex items-center gap-2.5 pt-1">
                <button
                  type="button"
                  disabled={isDeletingBulk}
                  onClick={() => setBulkDeleteKind(null)}
                  className="flex-1 py-2.5 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-50 text-xs sm:text-sm font-semibold cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="button"
                  disabled={isDeletingBulk}
                  onClick={async () => {
                    setIsDeletingBulk(true);
                    try {
                      if (bulkDeleteKind === 'questions_filtered') {
                        const ids = filteredQuestions.map((q) => q.id);
                        await onDeleteQuestionsBatch(ids);
                        setFeedback(`${ids.length} butir soal sesuai filter berhasil dihapus.`);
                      } else if (bulkDeleteKind === 'questions_all') {
                        const count = visibleQuestions.length;
                        await onDeleteAllQuestions(
                          isRestrictedBySubject ? allowedSubjects : undefined
                        );
                        setFeedback(`Seluruh ${count} data bank soal berhasil dihapus.`);
                      } else if (bulkDeleteKind === 'schedules_all') {
                        const count = visibleSchedules.length;
                        await onDeleteAllSchedules(
                          isRestrictedBySubject ? allowedSubjects : undefined
                        );
                        setFeedback(`Seluruh ${count} jadwal mata pelajaran berhasil dihapus.`);
                      } else if (bulkDeleteKind === 'both_all') {
                        const qCount = visibleQuestions.length;
                        const sCount = visibleSchedules.length;
                        await onDeleteAllQuestions(
                          isRestrictedBySubject ? allowedSubjects : undefined
                        );
                        await onDeleteAllSchedules(
                          isRestrictedBySubject ? allowedSubjects : undefined
                        );
                        setFeedback(
                          `Seluruh ${qCount} data soal dan ${sCount} jadwal mata pelajaran berhasil dihapus.`
                        );
                      }
                      setBulkDeleteKind(null);
                    } finally {
                      setIsDeletingBulk(false);
                    }
                  }}
                  className="flex-1 py-2.5 rounded-xl bg-rose-700 hover:bg-rose-800 text-white text-xs sm:text-sm font-semibold cursor-pointer disabled:opacity-60"
                >
                  {isDeletingBulk ? 'Menghapus...' : 'Ya, Hapus Permanen'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
