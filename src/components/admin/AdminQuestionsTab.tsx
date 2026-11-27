import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  BookOpenCheck,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Cloud,
  FileSpreadsheet,
  FileText,
  Grid3X3,
  ImagePlus,
  Languages,
  Link2,
  ListChecks,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Shuffle,
  Sigma,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { containsArabicScript, MathText } from '@/src/components/MathText';
import { QuestionImage } from '@/src/components/QuestionImage';
import {
  ArabicKeyboardPanel,
  type TextDirectionMode,
} from '@/src/components/admin/ArabicKeyboardPanel';
import { QuestionCoverageMatrix } from '@/src/components/admin/QuestionCoverageMatrix';
import {
  ALL_CLASSES,
  type ExamResult,
  type ExamSchedule,
  type MatchingPair,
  type OptionKey,
  type Participant,
  type Question,
  type QuestionOption,
  type QuestionType,
  type StaffRoleType,
} from '@/src/types/cbt';
import {
  compressDataUrlImage,
  compressQuestionImage,
  downloadQuestionsTemplate,
  downloadQuestionsWordTemplate,
  parseQuestionsDocx,
  parseQuestionsExcel,
} from '@/src/lib/importers';
import {
  buildMatchingQuestionData,
  getEffectiveQuestionType,
  QUESTION_TYPE_LABELS,
  reconstructMatchingPairs,
  TRUE_FALSE_DEFAULT_OPTIONS,
} from '@/src/lib/questionUtils';
import {
  syncAdminQuestionsFromCloud,
  type AdminCloudSyncResult,
} from '@/src/lib/dataStore';
import {
  hasSupabaseServiceRoleKey,
  isLiveSupabaseConfigured,
  normalizeQuestionImageUrl,
  uploadQuestionImageToStorage,
} from '@/src/lib/supabase';
import { usePersistedState } from '@/src/lib/usePersistedState';

interface CloudWriteResult {
  synced: boolean;
  error?: string;
}

interface AdminQuestionsTabProps {
  schedules: ExamSchedule[];
  questions: Question[];
  participants?: Participant[];
  results?: ExamResult[];
  staffRoleType?: StaffRoleType;
  allowedSubjects?: string[];
  onSaveSchedule: (schedule: ExamSchedule) => Promise<CloudWriteResult | void>;
  onDeleteSchedule: (id: string) => Promise<CloudWriteResult | void>;
  onDeleteAllSchedules: (allowedSubjects?: string[]) => Promise<void>;
  onUpsertQuestions: (items: Question[]) => Promise<CloudWriteResult | void>;
  onDeleteQuestion: (id: string) => Promise<CloudWriteResult | void>;
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

function createDefaultMatchingPairs(): MatchingPair[] {
  return [
    { id: 'L1', leftText: '', rightText: '' },
    { id: 'L2', leftText: '', rightText: '' },
    { id: 'L3', leftText: '', rightText: '' },
  ];
}

interface QuestionFormState {
  id: string | null;
  orderIndex: number;
  subject: string;
  questionType: QuestionType;
  targetClasses: string[];
  questionText: string;
  questionImageUrl: string;
  options: Record<OptionKey, { text: string; imageUrl: string }>;
  matchingPairs: MatchingPair[];
  correctAnswer: string;
  points: number;
}

function createEmptyQuestionForm(defaultSubject: string, nextOrderIndex: number): QuestionFormState {
  return {
    id: null,
    orderIndex: nextOrderIndex,
    subject: defaultSubject,
    questionType: 'multiple_choice',
    targetClasses: [...CLASSES_7],
    questionText: '',
    questionImageUrl: '',
    options: {
      A: { text: '', imageUrl: '' },
      B: { text: '', imageUrl: '' },
      C: { text: '', imageUrl: '' },
      D: { text: '', imageUrl: '' },
    },
    matchingPairs: createDefaultMatchingPairs(),
    correctAnswer: 'A',
    points: 20,
  };
}

function questionToFormState(q: Question): QuestionFormState {
  const qType = getEffectiveQuestionType(q);
  const optMap: Record<OptionKey, { text: string; imageUrl: string }> = {
    A: { text: '', imageUrl: '' },
    B: { text: '', imageUrl: '' },
    C: { text: '', imageUrl: '' },
    D: { text: '', imageUrl: '' },
  };
  for (const opt of Array.isArray(q.options) ? q.options : []) {
    if (opt.key in optMap) {
      optMap[opt.key] = {
        text: opt.text || '',
        imageUrl: opt.imageUrl || '',
      };
    }
  }
  const reconstructedPairs = qType === 'matching' ? reconstructMatchingPairs(q) : [];
  const matchingPairs =
    reconstructedPairs.length >= 2
      ? reconstructedPairs.map((p, idx) => ({
          id: p.id || `L${idx + 1}`,
          leftText: p.leftText || '',
          leftImageUrl: p.leftImageUrl || '',
          rightText: p.rightText || '',
          rightImageUrl: p.rightImageUrl || '',
        }))
      : createDefaultMatchingPairs();

  const normalizedCorrect =
    qType === 'true_false'
      ? q.correctAnswer === 'B'
        ? 'B'
        : 'A'
      : qType === 'multiple_choice'
        ? (['A', 'B', 'C', 'D'].includes(q.correctAnswer) ? q.correctAnswer : 'A')
        : q.correctAnswer;

  return {
    id: q.id,
    orderIndex: q.orderIndex || 1,
    subject: q.subject,
    questionType: qType,
    targetClasses: [...q.targetClasses],
    questionText: q.questionText,
    questionImageUrl: q.questionImageUrl || '',
    options: optMap,
    matchingPairs,
    correctAnswer: normalizedCorrect,
    points: q.points || 10,
  };
}

interface ScheduleInlineNumberInputProps {
  value: number;
  min: number;
  max: number;
  fallback: number;
  className?: string;
  onCommit: (nextValue: number) => void;
}

const ScheduleInlineNumberInput: React.FC<ScheduleInlineNumberInputProps> = ({
  value,
  min,
  max,
  fallback,
  className,
  onCommit,
}) => {
  const [draft, setDraft] = useState(String(value));

  React.useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const parsed = Number(draft);
    const clamped = Number.isFinite(parsed)
      ? Math.max(min, Math.min(max, Math.round(parsed)))
      : fallback;
    setDraft(String(clamped));
    if (clamped !== value) {
      onCommit(clamped);
    }
  };

  return (
    <input
      type="number"
      min={min}
      max={max}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          (e.currentTarget as HTMLInputElement).blur();
        } else if (e.key === 'Escape') {
          setDraft(String(value));
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
      className={className}
    />
  );
};

export const AdminQuestionsTab: React.FC<AdminQuestionsTabProps> = ({
  schedules,
  questions,
  participants = [],
  results = [],
  staffRoleType,
  allowedSubjects,
  onSaveSchedule,
  onDeleteSchedule,
  onDeleteAllSchedules,
  onUpsertQuestions,
  onDeleteQuestion,
  onDeleteQuestionsBatch,
  onDeleteAllQuestions,
}) => {
  const canViewQuestionMatrix = staffRoleType === 'admin' || staffRoleType === 'proktor';
  const [activeSubView, setActiveSubView] = useState<'manage' | 'matrix'>('manage');
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
  const [typeFilter, setTypeFilter] = usePersistedState<'ALL' | QuestionType>(
    'cbt_draft_q_filter_type_v1',
    'ALL'
  );
  const [searchQuery, setSearchQuery] = usePersistedState('cbt_draft_q_filter_search_v1', '');

  // Word Import Target Settings
  const [importDocxClasses, setImportDocxClasses] = useState<string[]>([...CLASSES_7]);
  const [showDocxClassPicker, setShowDocxClassPicker] = useState(false);
  const [importDocxSubject, setImportDocxSubject] = useState(
    (isRestrictedBySubject ? allowedSubjects?.[0] : visibleSchedules[0]?.subject) || ''
  );

  // Excel Import Optional Class Override
  const [overrideExcelClasses, setOverrideExcelClasses] = useState(false);
  const [importExcelClasses, setImportExcelClasses] = useState<string[]>(['7A']);

  const [feedback, setFeedback] = useState('');
  const [isShuffling, setIsShuffling] = useState(false);
  const [showBulkDeleteMenu, setShowBulkDeleteMenu] = useState(false);
  const [bulkDeleteKind, setBulkDeleteKind] = useState<QuestionsBulkDeleteKind | null>(null);
  const [isDeletingBulk, setIsDeletingBulk] = useState(false);
  const [isSyncingCloud, setIsSyncingCloud] = useState(false);
  const [cloudSyncStatus, setCloudSyncStatus] = useState<AdminCloudSyncResult | null>(null);
  const [listPage, setListPage] = useState(1);
  const [showAllQuestions, setShowAllQuestions] = useState(false);

  const liveSupabase = isLiveSupabaseConfigured();
  const serviceRoleActive = hasSupabaseServiceRoleKey();

  const handleSyncFromDatabase = useCallback(async (silent = false) => {
    setIsSyncingCloud(true);
    try {
      const res = await syncAdminQuestionsFromCloud({ force: !silent });
      setCloudSyncStatus(res);
      if (!silent) {
        if (!res.ok && res.error) {
          setFeedback(`Gagal memuat soal dari database Supabase: ${res.error}`);
        } else if (res.syncedFromCloud) {
          setFeedback(
            `Berhasil memuat seluruh ${res.questionCount} butir soal & ${res.scheduleCount} jadwal mapel langsung dari database Supabase.`
          );
        } else if (liveSupabase && !res.hasServiceRoleKey) {
          setFeedback(
            'Jadwal mapel tersinkron dari database. Isi Service Role Key pada menu Database & SQL agar seluruh soal & kunci jawaban dapat ditarik langsung.'
          );
        }
      }
    } finally {
      setIsSyncingCloud(false);
    }
  }, [liveSupabase]);

  useEffect(() => {
    if (liveSupabase) {
      void handleSyncFromDatabase(true);
    }
  }, [liveSupabase, serviceRoleActive, handleSyncFromDatabase]);

  // Question Create / Edit Modal State (survives refresh so teacher/admin doesn't lose question input)
  const [questionModalOpen, setQuestionModalOpen] = usePersistedState(
    'cbt_draft_q_modal_open_v1',
    false
  );
  const [qForm, setQForm] = usePersistedState<QuestionFormState>(
    'cbt_draft_q_modal_form_v1',
    () =>
      createEmptyQuestionForm(
        availableSubjects[0] || '',
        visibleQuestions.length + 1
      )
  );
  const [formError, setFormError] = useState('');
  const [isSavingQuestion, setIsSavingQuestion] = useState(false);
  const [showArabicKeyboard, setShowArabicKeyboard] = useState(false);
  const [textDirectionMode, setTextDirectionMode] = useState<TextDirectionMode>('auto');
  const [uploadingImageTarget, setUploadingImageTarget] = useState<string | null>(null);
  const [activeEditorTarget, setActiveEditorTarget] = useState<
    | { kind: 'question' }
    | { kind: 'option'; key: OptionKey }
    | { kind: 'match'; index: number; side: 'left' | 'right' }
  >({ kind: 'question' });
  const editorRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  const scheduleById = useMemo(
    () => new Map(schedules.map((s) => [s.id, s])),
    [schedules]
  );

  const activeInProgressSubjectSet = useMemo(() => {
    const set = new Set<string>();
    results.forEach((r) => {
      if (r.status === 'in_progress') {
        const resolvedSubject = scheduleById.get(r.examId)?.subject || r.subject;
        if (resolvedSubject) {
          set.add(resolvedSubject.trim().toLowerCase());
        }
      }
    });
    return set;
  }, [results, scheduleById]);

  const effectiveSubjectFilter = useMemo(() => {
    if (isRestrictedBySubject && availableSubjects.length === 1) {
      return availableSubjects[0];
    }
    const normFilter = subjectFilter.trim().toLowerCase();
    const matched = availableSubjects.find((s) => s.trim().toLowerCase() === normFilter);
    if (subjectFilter !== 'ALL' && !matched) {
      return 'ALL';
    }
    return matched || subjectFilter;
  }, [isRestrictedBySubject, availableSubjects, subjectFilter]);

  const filteredQuestions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const normFilter = effectiveSubjectFilter.trim().toLowerCase();
    return visibleQuestions
      .filter((item) => {
        const itemType = getEffectiveQuestionType(item);
        if (
          effectiveSubjectFilter !== 'ALL' &&
          item.subject.trim().toLowerCase() !== normFilter
        ) {
          return false;
        }
        if (classFilter !== 'ALL' && !item.targetClasses.includes(classFilter)) return false;
        if (typeFilter !== 'ALL' && itemType !== typeFilter) return false;
        if (q) {
          const pairsText =
            itemType === 'matching'
              ? reconstructMatchingPairs(item)
                  .map((p) => `${p.leftText} ${p.rightText}`)
                  .join(' ')
                  .toLowerCase()
              : '';
          if (
            !item.questionText.toLowerCase().includes(q) &&
            !item.subject.toLowerCase().includes(q) &&
            !String(item.orderIndex).includes(q) &&
            !pairsText.includes(q)
          ) {
            return false;
          }
        }
        return true;
      })
      .sort(
        (a, b) =>
          a.subject.localeCompare(b.subject) ||
          a.orderIndex - b.orderIndex ||
          a.id.localeCompare(b.id)
      );
  }, [visibleQuestions, effectiveSubjectFilter, classFilter, typeFilter, searchQuery]);

  useEffect(() => {
    setListPage(1);
  }, [effectiveSubjectFilter, classFilter, typeFilter, searchQuery]);

  const PAGE_SIZE = 100;
  const MAX_SHOW_ALL = 300;
  const totalPages = Math.max(1, Math.ceil(filteredQuestions.length / PAGE_SIZE));
  const safeListPage = Math.min(listPage, totalPages);
  const displayedQuestions = useMemo(() => {
    if (showAllQuestions) {
      return filteredQuestions.slice(0, MAX_SHOW_ALL);
    }
    if (filteredQuestions.length <= PAGE_SIZE) {
      return filteredQuestions;
    }
    const start = (safeListPage - 1) * PAGE_SIZE;
    return filteredQuestions.slice(start, start + PAGE_SIZE);
  }, [filteredQuestions, showAllQuestions, safeListPage]);

  const hasActiveQuestionFilter =
    (!isRestrictedBySubject && effectiveSubjectFilter !== 'ALL') ||
    (isRestrictedBySubject && availableSubjects.length > 1 && effectiveSubjectFilter !== 'ALL') ||
    classFilter !== 'ALL' ||
    typeFilter !== 'ALL' ||
    searchQuery.trim() !== '';

  const openCreateQuestionModal = (presetSubject?: string, presetClasses?: string[]) => {
    setFormError('');
    const defaultSubject =
      presetSubject ??
      (effectiveSubjectFilter !== 'ALL'
        ? effectiveSubjectFilter
        : availableSubjects[0] || '');
    const normDefault = defaultSubject.trim().toLowerCase();
    const maxOrder = visibleQuestions
      .filter((q) => q.subject.trim().toLowerCase() === normDefault)
      .reduce((acc, q) => Math.max(acc, q.orderIndex || 0), 0);
    const baseForm = createEmptyQuestionForm(defaultSubject, maxOrder + 1);
    if (presetClasses && presetClasses.length > 0) {
      baseForm.targetClasses = [...presetClasses];
    }
    setQForm(baseForm);
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

    const writeRes = await onSaveSchedule({
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
    if (writeRes && !writeRes.synced && writeRes.error) {
      setFeedback(
        `Jadwal "${subj}" disimpan di cache lokal, namun gagal sinkron ke Supabase: ${writeRes.error}`
      );
    } else {
      setFeedback(
        `Jadwal mata pelajaran "${subj}" (${formatTargetClassesSummary(newSchedClasses)}) berhasil ditambahkan${writeRes?.synced ? ' & tersimpan ke database' : ''}.`
      );
    }
  };

  const handleSaveScheduleClassesModal = async () => {
    if (!editingScheduleClasses || schedModalClasses.length === 0) return;
    const writeRes = await onSaveSchedule({
      ...editingScheduleClasses,
      targetClasses: schedModalClasses,
    });
    if (writeRes && !writeRes.synced && writeRes.error) {
      setFeedback(
        `Target kelas "${editingScheduleClasses.subject}" diperbarui lokal, namun gagal ke Supabase: ${writeRes.error}`
      );
    } else {
      setFeedback(
        `Target kelas mata pelajaran "${editingScheduleClasses.subject}" diperbarui ke: ${formatTargetClassesSummary(schedModalClasses)}.`
      );
    }
    setEditingScheduleClasses(null);
  };

  const handleUpdateScheduleKkmOrStatus = async (
    sched: ExamSchedule,
    patch: Partial<ExamSchedule>
  ) => {
    const writeRes = await onSaveSchedule({ ...sched, ...patch });
    if (writeRes && !writeRes.synced && writeRes.error) {
      setFeedback(
        `Perubahan jadwal "${sched.subject}" gagal dikirim ke Supabase: ${writeRes.error}`
      );
    } else {
      setFeedback(`Jadwal mata pelajaran "${sched.subject}" diperbarui.`);
    }
  };

  const handleDeleteSingleSchedule = async (sched: ExamSchedule) => {
    const writeRes = await onDeleteSchedule(sched.id);
    if (writeRes && !writeRes.synced && writeRes.error) {
      setFeedback(
        `Jadwal "${sched.subject}" dihapus lokal, namun gagal hapus di Supabase: ${writeRes.error}`
      );
    } else {
      setFeedback(`Jadwal mata pelajaran "${sched.subject}" berhasil dihapus.`);
    }
  };

  const handleDeleteSingleQuestion = async (q: Question) => {
    const writeRes = await onDeleteQuestion(q.id);
    if (writeRes && !writeRes.synced && writeRes.error) {
      setFeedback(
        `Soal Nomor ${q.orderIndex} dihapus lokal, namun gagal menghapus di database Supabase: ${writeRes.error}`
      );
    } else {
      setFeedback(
        `Soal Nomor ${q.orderIndex} (${q.subject}) berhasil dihapus${writeRes?.synced ? ' dari database' : ''}.`
      );
    }
  };

  const handleShuffleQuestionsAndNumbers = async () => {
    const targets = filteredQuestions;
    if (targets.length < 2) {
      setFeedback('Minimal diperlukan 2 soal pada filter aktif untuk mengacak soal dan nomor.');
      return;
    }

    setIsShuffling(true);
    try {
      // Kelompokkan per (mapel + kelompok kelas target) agar misalnya Matematika 7A-7B & 7C-7F diacak terpisah
      const getGroupKey = (q: Question) =>
        `${q.subject.trim().toLowerCase()}::${[...q.targetClasses].sort().join(',')}`;

      const bySubjectGroup = new Map<string, Question[]>();
      for (const q of targets) {
        const key = getGroupKey(q);
        const list = bySubjectGroup.get(key) || [];
        list.push(q);
        bySubjectGroup.set(key, list);
      }

      const updated: Question[] = [];
      bySubjectGroup.forEach((group, groupKey) => {
        const shuffled = [...group];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        const existingNumbers = group
          .map((item) => item.orderIndex)
          .sort((a, b) => a - b);
        const fullGroupCount = visibleQuestions.filter(
          (q) => getGroupKey(q) === groupKey
        ).length;
        const useSequential = existingNumbers.length === fullGroupCount;
        shuffled.forEach((item, idx) => {
          updated.push({
            ...item,
            orderIndex: useSequential ? idx + 1 : existingNumbers[idx],
          });
        });
      });

      const writeRes = await onUpsertQuestions(updated);
      if (writeRes && !writeRes.synced && writeRes.error) {
        setFeedback(
          `Urutan soal diacak lokal, namun gagal sinkron ke database Supabase: ${writeRes.error}`
        );
      } else {
        setFeedback(
          `Urutan & nomor soal untuk ${updated.length} butir soal berhasil diacak (${
            effectiveSubjectFilter === 'ALL' ? 'per kelompok kelas & mapel' : effectiveSubjectFilter
          }).`
        );
      }
    } finally {
      setIsShuffling(false);
    }
  };

  const optimizeImportedQuestionImages = async (items: Question[]): Promise<Question[]> => {
    const processUrl = async (
      rawUrl: string | undefined,
      maxW: number,
      maxH: number,
      prefix: string
    ): Promise<string | undefined> => {
      if (!rawUrl || !rawUrl.startsWith('data:image/')) return rawUrl;
      const compressed = await compressDataUrlImage(rawUrl, maxW, maxH, 0.78);
      return uploadQuestionImageToStorage(compressed, prefix);
    };

    const result: Question[] = [];
    const CHUNK = 5;
    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK);
      const processedChunk = await Promise.all(
        chunk.map(async (q) => {
          const qImg = await processUrl(q.questionImageUrl, 820, 620, 'q');
          const optImgs = await Promise.all(
            (q.options || []).map(async (opt) => {
              if (!opt.imageUrl || !opt.imageUrl.startsWith('data:image/')) return opt;
              const uploaded = await processUrl(opt.imageUrl, 480, 360, 'opt');
              return { ...opt, imageUrl: uploaded };
            })
          );
          let matchingPairs = q.matchingPairs;
          let matchingData = q.matchingData;
          let correctAnswer = q.correctAnswer;
          if (Array.isArray(q.matchingPairs) && q.matchingPairs.length > 0) {
            let pairImagesChanged = false;
            matchingPairs = await Promise.all(
              q.matchingPairs.map(async (pair) => {
                const nextLeftImg = await processUrl(pair.leftImageUrl, 420, 320, 'match-l');
                const nextRightImg = await processUrl(pair.rightImageUrl, 420, 320, 'match-r');
                if (nextLeftImg !== pair.leftImageUrl || nextRightImg !== pair.rightImageUrl) {
                  pairImagesChanged = true;
                  return {
                    ...pair,
                    leftImageUrl: nextLeftImg,
                    rightImageUrl: nextRightImg,
                  };
                }
                return pair;
              })
            );
            if (pairImagesChanged || !matchingData) {
              const built = buildMatchingQuestionData(matchingPairs);
              matchingData = built.matchingData;
              correctAnswer = built.correctAnswer;
            }
          }
          return {
            ...q,
            questionImageUrl: qImg,
            options: optImgs,
            matchingPairs,
            matchingData,
            correctAnswer,
          };
        })
      );
      result.push(...processedChunk);
    }
    return result;
  };

  const handleDownloadExcelTemplate = () => {
    setFeedback('');
    try {
      downloadQuestionsTemplate();
      setFeedback(
        'Template Excel (.xlsx) untuk seluruh jenis soal (Pilihan Ganda, Benar/Salah, Menjodohkan) berhasil diunduh.'
      );
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Gagal mengunduh template Excel soal.');
    }
  };

  const handleDownloadWordTemplate = async () => {
    setFeedback('');
    try {
      await downloadQuestionsWordTemplate();
      setFeedback(
        'Template Word (.docx) untuk seluruh jenis soal (Pilihan Ganda, Benar/Salah, Menjodohkan) berhasil diunduh.'
      );
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Gagal mengunduh template Word (.docx).');
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
        finalQuestions = await optimizeImportedQuestionImages(finalQuestions);
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
      const safeDocxSubject = (
        isRestrictedBySubject && !normalizedAllowed.includes(importDocxSubject.trim().toLowerCase())
          ? availableSubjects[0] || importDocxSubject
          : importDocxSubject || availableSubjects[0] || ''
      ).trim();

      if (!safeDocxSubject) {
        setFeedback('Pilih atau isi nama mata pelajaran terlebih dahulu sebelum mengimpor soal Word (.docx).');
        e.target.value = '';
        return;
      }

      const { questions: parsed, errors } = await parseQuestionsDocx(
        file,
        importDocxClasses.length > 0 ? importDocxClasses : ALL_CLASSES,
        safeDocxSubject
      );

      let finalQuestions = isRestrictedBySubject
        ? parsed.map((q) => ({ ...q, subject: safeDocxSubject }))
        : parsed;

      if (finalQuestions.length > 0) {
        finalQuestions = await optimizeImportedQuestionImages(finalQuestions);
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
    setFormError('');
    setUploadingImageTarget('question');
    try {
      const compressed = await compressQuestionImage(file, 820);
      const uploadedUrl = await uploadQuestionImageToStorage(compressed, 'q');
      setQForm((prev) => ({ ...prev, questionImageUrl: uploadedUrl }));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Gagal memproses gambar soal.');
    } finally {
      setUploadingImageTarget(null);
      e.target.value = '';
    }
  };

  const handleUploadOptionImage = async (
    key: OptionKey,
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFormError('');
    setUploadingImageTarget(`opt-${key}`);
    try {
      const compressed = await compressQuestionImage(file, 480);
      const uploadedUrl = await uploadQuestionImageToStorage(compressed, 'opt');
      setQForm((prev) => ({
        ...prev,
        options: {
          ...prev.options,
          [key]: { ...prev.options[key], imageUrl: uploadedUrl },
        },
      }));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : `Gagal memproses gambar opsi ${key}.`);
    } finally {
      setUploadingImageTarget(null);
      e.target.value = '';
    }
  };

  const activeQuestionType: QuestionType = qForm.questionType || 'multiple_choice';
  const activeMatchingPairs: MatchingPair[] =
    Array.isArray(qForm.matchingPairs) && qForm.matchingPairs.length >= 2
      ? qForm.matchingPairs
      : createDefaultMatchingPairs();

  const handleChangeQuestionType = (nextType: QuestionType) => {
    setFormError('');
    setActiveEditorTarget({ kind: 'question' });
    setQForm((prev) => {
      const safePairs =
        Array.isArray(prev.matchingPairs) && prev.matchingPairs.length >= 2
          ? prev.matchingPairs
          : createDefaultMatchingPairs();

      let nextCorrect = prev.correctAnswer;
      if (nextType === 'true_false') {
        nextCorrect = prev.correctAnswer === 'B' ? 'B' : 'A';
      } else if (nextType === 'multiple_choice') {
        nextCorrect = ['A', 'B', 'C', 'D'].includes(prev.correctAnswer) ? prev.correctAnswer : 'A';
      }

      return {
        ...prev,
        questionType: nextType,
        matchingPairs: safePairs,
        correctAnswer: nextCorrect,
      };
    });
  };

  const handleUploadMatchingImage = async (
    pairIndex: number,
    side: 'left' | 'right',
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFormError('');
    setUploadingImageTarget(`match-${pairIndex}-${side}`);
    try {
      const compressed = await compressQuestionImage(file, 420);
      const uploadedUrl = await uploadQuestionImageToStorage(
        compressed,
        side === 'left' ? 'match-l' : 'match-r'
      );
      setQForm((prev) => {
        const currentPairs =
          Array.isArray(prev.matchingPairs) && prev.matchingPairs.length >= 2
            ? [...prev.matchingPairs]
            : createDefaultMatchingPairs();
        const target = currentPairs[pairIndex];
        if (!target) return prev;
        currentPairs[pairIndex] = {
          ...target,
          ...(side === 'left' ? { leftImageUrl: uploadedUrl } : { rightImageUrl: uploadedUrl }),
        };
        return { ...prev, matchingPairs: currentPairs };
      });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Gagal memproses gambar pasangan.');
    } finally {
      setUploadingImageTarget(null);
      e.target.value = '';
    }
  };

  const normalizeMultilineText = (raw: string): string =>
    raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

  const buildQuestionPayloadFromForm = (): Question | null => {
    const qType = activeQuestionType;
    const cleanQuestionText = normalizeMultilineText(qForm.questionText);
    const cleanQuestionImageUrl = normalizeQuestionImageUrl(qForm.questionImageUrl);

    if (qType !== 'matching' && !cleanQuestionText && !cleanQuestionImageUrl) {
      setFormError('Masukkan teks pertanyaan atau lampirkan gambar soal.');
      return null;
    }
    if (qForm.targetClasses.length === 0) {
      setFormError('Pilih minimal satu target kelas untuk soal ini.');
      return null;
    }

    const targetSubject = (qForm.subject || availableSubjects[0] || '').trim();
    if (!targetSubject) {
      setFormError('Pilih atau isi nama mata pelajaran terlebih dahulu.');
      return null;
    }
    if (
      isRestrictedBySubject &&
      !normalizedAllowed.includes(targetSubject.toLowerCase())
    ) {
      setFormError(`Anda hanya diperbolehkan menyimpan soal pada mapel: ${availableSubjects.join(', ')}.`);
      return null;
    }

    const generatedId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? `q-man-${crypto.randomUUID()}`
        : `q-man-${Date.now()}`;
    const finalId = qForm.id || generatedId;
    const basePoints = Math.max(1, Number(qForm.points) || 10);
    const baseOrder = Math.max(1, Number(qForm.orderIndex) || 1);

    if (qType === 'true_false') {
      const tfCorrect: OptionKey = qForm.correctAnswer === 'B' ? 'B' : 'A';
      return {
        id: finalId,
        subject: targetSubject,
        targetClasses: [...qForm.targetClasses],
        questionType: 'true_false',
        questionText: cleanQuestionText,
        questionImageUrl: cleanQuestionImageUrl || undefined,
        options: TRUE_FALSE_DEFAULT_OPTIONS.map((o) => ({ ...o })),
        correctAnswer: tfCorrect,
        points: basePoints,
        orderIndex: baseOrder,
      };
    }

    if (qType === 'matching') {
      const rawPairs = activeMatchingPairs;
      if (rawPairs.length < 2) {
        setFormError('Soal menjodohkan minimal memuat 2 pasangan soal dan jawaban.');
        return null;
      }
      for (let i = 0; i < rawPairs.length; i++) {
        const pair = rawPairs[i];
        const hasLeft = Boolean(
          normalizeMultilineText(pair.leftText) || normalizeQuestionImageUrl(pair.leftImageUrl)
        );
        const hasRight = Boolean(
          normalizeMultilineText(pair.rightText) || normalizeQuestionImageUrl(pair.rightImageUrl)
        );
        if (!hasLeft || !hasRight) {
          setFormError(
            `Pasangan ke-${i + 1} belum lengkap. Isi teks atau gambar untuk sisi kiri (soal) dan kanan (jawaban).`
          );
          return null;
        }
      }

      const normalizedPairs: MatchingPair[] = rawPairs.map((pair, idx) => ({
        id: pair.id || `L${idx + 1}`,
        leftText: normalizeMultilineText(pair.leftText),
        leftImageUrl: normalizeQuestionImageUrl(pair.leftImageUrl) || undefined,
        rightText: normalizeMultilineText(pair.rightText),
        rightImageUrl: normalizeQuestionImageUrl(pair.rightImageUrl) || undefined,
      }));
      const builtMatching = buildMatchingQuestionData(normalizedPairs);

      return {
        id: finalId,
        subject: targetSubject,
        targetClasses: [...qForm.targetClasses],
        questionType: 'matching',
        questionText:
          cleanQuestionText ||
          'Jodohkan pernyataan di kolom kiri dengan pasangan jawaban yang tepat di kolom kanan.',
        questionImageUrl: cleanQuestionImageUrl || undefined,
        options: [],
        matchingPairs: builtMatching.matchingPairs,
        matchingData: builtMatching.matchingData,
        correctAnswer: builtMatching.correctAnswer,
        points: basePoints,
        orderIndex: baseOrder,
      };
    }

    // Default: multiple_choice
    for (const key of OPTION_KEYS) {
      const opt = qForm.options[key];
      if (!normalizeMultilineText(opt.text) && !normalizeQuestionImageUrl(opt.imageUrl)) {
        setFormError(`Opsi ${key} harus diisi teks atau dilampirkan gambar.`);
        return null;
      }
    }

    const builtOptions: QuestionOption[] = OPTION_KEYS.map((key) => ({
      key,
      text: normalizeMultilineText(qForm.options[key].text),
      imageUrl: normalizeQuestionImageUrl(qForm.options[key].imageUrl) || undefined,
    }));

    const mcCorrect: OptionKey = ['A', 'B', 'C', 'D'].includes(qForm.correctAnswer)
      ? (qForm.correctAnswer as OptionKey)
      : 'A';

    return {
      id: finalId,
      subject: targetSubject,
      targetClasses: [...qForm.targetClasses],
      questionType: 'multiple_choice',
      questionText: cleanQuestionText,
      questionImageUrl: cleanQuestionImageUrl || undefined,
      options: builtOptions,
      correctAnswer: mcCorrect,
      points: basePoints,
      orderIndex: baseOrder,
    };
  };

  const handleSaveQuestionModal = async (goToNext = false) => {
    setFormError('');
    if (uploadingImageTarget) {
      setFormError('Tunggu proses upload gambar selesai terlebih dahulu sebelum menyimpan soal.');
      return;
    }
    const rawPayload = buildQuestionPayloadFromForm();
    if (!rawPayload) return;

    const currentIdx = goToNext && qForm.id
      ? filteredQuestions.findIndex((item) => item.id === qForm.id)
      : -1;
    const capturedNextQuestion =
      currentIdx >= 0 && currentIdx + 1 < filteredQuestions.length
        ? filteredQuestions[currentIdx + 1]
        : null;

    setIsSavingQuestion(true);
    try {
      // Pastikan tidak ada sisa data:image/ Base64 saat mode Supabase live (unggah otomatis ke Storage CDN)
      let payload = rawPayload;
      if (isLiveSupabaseConfigured()) {
        const [optimized] = await optimizeImportedQuestionImages([rawPayload]);
        if (optimized) payload = optimized;
      }

      const writeRes = await onUpsertQuestions([payload]);
      if (writeRes && !writeRes.synced && writeRes.error) {
        setFormError(
          `Soal tersimpan di cache lokal, namun gagal menyimpan ke database Supabase: ${writeRes.error}`
        );
        return;
      }

      setFeedback(
        qForm.id
          ? `Soal Nomor ${payload.orderIndex} (${payload.subject}) berhasil diperbarui${writeRes?.synced ? ' & tersimpan ke database Supabase' : ''}.`
          : `Soal baru Nomor ${payload.orderIndex} (${payload.subject}) berhasil disimpan${writeRes?.synced ? ' ke database Supabase' : ''}.`
      );

      if (goToNext && capturedNextQuestion) {
        setQForm(questionToFormState(capturedNextQuestion));
        return;
      }
      setQuestionModalOpen(false);
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : 'Gagal menyimpan soal atau mengunggah gambar soal.'
      );
    } finally {
      setIsSavingQuestion(false);
    }
  };

  const modalSubjectOptions = useMemo(() => {
    const base = [...availableSubjects];
    const currentSubj = qForm.subject.trim();
    if (
      currentSubj &&
      !isRestrictedBySubject &&
      !base.some((s) => s.trim().toLowerCase() === currentSubj.toLowerCase())
    ) {
      base.push(currentSubj);
      base.sort();
    }
    return base;
  }, [availableSubjects, qForm.subject, isRestrictedBySubject]);

  const getEditorFieldKey = (target: typeof activeEditorTarget): string => {
    if (target.kind === 'question') return 'question';
    if (target.kind === 'option') return `option-${target.key}`;
    return `match-${target.index}-${target.side}`;
  };

  const activeEditorLabel = useMemo(() => {
    if (activeEditorTarget.kind === 'question') return 'Teks Pertanyaan';
    if (activeEditorTarget.kind === 'option') return `Opsi ${activeEditorTarget.key}`;
    return `Pasangan #${activeEditorTarget.index + 1} (${
      activeEditorTarget.side === 'left' ? 'Kiri' : 'Kanan'
    })`;
  }, [activeEditorTarget]);

  const updateActiveEditorValue = (
    transform: (
      currentValue: string,
      selStart: number,
      selEnd: number
    ) => { nextValue: string; nextCaret: number }
  ) => {
    const fieldKey = getEditorFieldKey(activeEditorTarget);
    const el = editorRefs.current[fieldKey];
    let targetCaret = 0;

    setQForm((prev) => {
      const applyOn = (currentVal: string) => {
        const start =
          el && typeof el.selectionStart === 'number' ? el.selectionStart : currentVal.length;
        const end =
          el && typeof el.selectionEnd === 'number' ? el.selectionEnd : start;
        const { nextValue, nextCaret } = transform(currentVal, start, end);
        targetCaret = nextCaret;
        return nextValue;
      };

      if (activeEditorTarget.kind === 'question') {
        return { ...prev, questionText: applyOn(prev.questionText || '') };
      }
      if (activeEditorTarget.kind === 'option') {
        const optKey = activeEditorTarget.key;
        return {
          ...prev,
          options: {
            ...prev.options,
            [optKey]: {
              ...prev.options[optKey],
              text: applyOn(prev.options[optKey]?.text || ''),
            },
          },
        };
      }
      const pairs =
        Array.isArray(prev.matchingPairs) && prev.matchingPairs.length >= 2
          ? [...prev.matchingPairs]
          : createDefaultMatchingPairs();
      const idx = activeEditorTarget.index;
      if (!pairs[idx]) return prev;
      if (activeEditorTarget.side === 'left') {
        pairs[idx] = { ...pairs[idx], leftText: applyOn(pairs[idx].leftText || '') };
      } else {
        pairs[idx] = { ...pairs[idx], rightText: applyOn(pairs[idx].rightText || '') };
      }
      return { ...prev, matchingPairs: pairs };
    });

    if (el) {
      requestAnimationFrame(() => {
        el.focus();
        try {
          el.setSelectionRange(targetCaret, targetCaret);
        } catch {
          // Ignore selection range errors on detached elements
        }
      });
    }
  };

  const insertTextAtActiveCursor = (snippet: string) => {
    updateActiveEditorValue((currentValue, start, end) => {
      const nextValue = currentValue.slice(0, start) + snippet + currentValue.slice(end);
      return { nextValue, nextCaret: start + snippet.length };
    });
  };

  const backspaceAtActiveCursor = () => {
    updateActiveEditorValue((currentValue, start, end) => {
      if (start !== end) {
        return {
          nextValue: currentValue.slice(0, start) + currentValue.slice(end),
          nextCaret: start,
        };
      }
      if (start <= 0) {
        return { nextValue: currentValue, nextCaret: 0 };
      }
      return {
        nextValue: currentValue.slice(0, start - 1) + currentValue.slice(end),
        nextCaret: start - 1,
      };
    });
  };

  const insertLatexSnippet = (snippet: string) => {
    insertTextAtActiveCursor(snippet);
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
            onClick={() => {
              setActiveSubView('manage');
              setShowScheduleForm((v) => !v);
            }}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-sm font-semibold cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            <span>Tambah Mapel &amp; KKM</span>
          </button>

          <button
            type="button"
            onClick={() => openCreateQuestionModal()}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white text-sm font-semibold cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            <span>Buat Soal Baru</span>
          </button>
        </div>
      </div>

      {canViewQuestionMatrix && (
        <div className="inline-flex flex-wrap items-center gap-1 p-1 bg-slate-200/75 rounded-xl">
          <button
            type="button"
            onClick={() => setActiveSubView('manage')}
            className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-colors cursor-pointer whitespace-nowrap ${
              activeSubView === 'manage'
                ? 'bg-white text-slate-900 shadow-2xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <BookOpenCheck className="w-4 h-4 text-emerald-700" />
            <span>Kelola Soal &amp; Mapel</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveSubView('matrix')}
            className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs sm:text-sm font-semibold transition-colors cursor-pointer whitespace-nowrap ${
              activeSubView === 'matrix'
                ? 'bg-white text-slate-900 shadow-2xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Grid3X3 className="w-4 h-4 text-emerald-700" />
            <span>Pemetaan Soal Seluruh Kelas</span>
          </button>
        </div>
      )}

      {activeInProgressSubjectSet.size > 0 && (
        <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-950 text-xs sm:text-sm flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
          <span>
            <strong>Perhatian Sesi Aktif:</strong> Ada peserta yang sedang mengerjakan ujian saat ini. Mengubah durasi, menghapus soal, atau mengacak bank soal dapat memengaruhi peserta yang baru memulai sesi.
          </span>
        </div>
      )}

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

      {liveSupabase && (
        <div
          className={`p-3.5 rounded-xl border text-xs sm:text-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
            cloudSyncStatus && !cloudSyncStatus.ok && cloudSyncStatus.error
              ? 'bg-rose-50 border-rose-200 text-rose-900'
              : serviceRoleActive
                ? 'bg-emerald-50/70 border-emerald-200 text-emerald-950'
                : 'bg-amber-50 border-amber-200 text-amber-950'
          }`}
        >
          <div className="flex items-start gap-2.5 min-w-0">
            <Cloud
              className={`w-4 h-4 shrink-0 mt-0.5 ${
                cloudSyncStatus && !cloudSyncStatus.ok && cloudSyncStatus.error
                  ? 'text-rose-700'
                  : serviceRoleActive
                    ? 'text-emerald-700'
                    : 'text-amber-700'
              }`}
            />
            <div className="min-w-0">
              {cloudSyncStatus && !cloudSyncStatus.ok && cloudSyncStatus.error ? (
                <span>
                  <strong>Gagal Sinkron Database:</strong> {cloudSyncStatus.error}
                </span>
              ) : serviceRoleActive ? (
                <span>
                  <strong>Database Terhubung (Service Role Aktif):</strong>{' '}
                  {isSyncingCloud
                    ? 'Sedang memuat seluruh soal & mata pelajaran dari database Supabase...'
                    : `Menampilkan ${visibleQuestions.length} butir soal & ${visibleSchedules.length} mapel langsung dari database Supabase dan siap diedit langsung.`}
                </span>
              ) : (
                <span>
                  <strong>Mode Cache Lokal:</strong> Service Role Key belum diisi pada sesi browser ini sehingga pembacaan langsung tabel soal terproteksi RLS.{' '}
                  {staffRoleType === 'admin'
                    ? 'Masukkan Service Role Key di menu Database & SQL agar seluruh soal database termuat otomatis.'
                    : 'Minta Administrator mengisi Service Role Key pada sesi ini untuk menarik seluruh soal langsung dari database.'}
                </span>
              )}
            </div>
          </div>

          <button
            type="button"
            disabled={isSyncingCloud}
            onClick={() => void handleSyncFromDatabase(false)}
            className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-xs font-semibold cursor-pointer disabled:opacity-60 whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isSyncingCloud ? 'animate-spin' : ''}`} />
            <span>{isSyncingCloud ? 'Memuat...' : 'Muat Ulang dari Database'}</span>
          </button>
        </div>
      )}

      {canViewQuestionMatrix && activeSubView === 'matrix' ? (
        <QuestionCoverageMatrix
          schedules={schedules}
          questions={questions}
          participants={participants}
          onSelectSubjectClass={(subject, className, hasQuestions) => {
            if (hasQuestions) {
              const normSubj = subject.trim().toLowerCase();
              const hasLocal = visibleQuestions.some(
                (q) =>
                  q.subject.trim().toLowerCase() === normSubj &&
                  q.targetClasses.some((c) => c.trim().toUpperCase() === className.toUpperCase())
              );
              setSubjectFilter(subject);
              setClassFilter(className);
              setSearchQuery('');
              setActiveSubView('manage');
              if (!hasLocal) {
                if (serviceRoleActive) {
                  void handleSyncFromDatabase(false);
                } else {
                  setFeedback(
                    `Soal "${subject}" kelas ${className} sudah tersimpan di database Supabase, namun belum ada di cache lokal perangkat ini. Untuk melihat/mengedit butir soal & kunci jawaban dari cloud, masukkan Service Role Key di menu Database & SQL lalu klik Muat Ulang dari Database.`
                  );
                }
              }
            } else {
              openCreateQuestionModal(subject, [className]);
            }
          }}
          onOpenCreateSchedule={() => {
            setActiveSubView('manage');
            setShowScheduleForm(true);
          }}
        />
      ) : (
        <>
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
                    <ScheduleInlineNumberInput
                      value={sched.kkm}
                      min={0}
                      max={100}
                      fallback={75}
                      onCommit={(nextVal) =>
                        void handleUpdateScheduleKkmOrStatus(sched, { kkm: nextVal })
                      }
                      className="w-16 px-2 py-1 rounded-lg border border-slate-300 font-mono text-xs font-bold text-center focus:outline-none focus:ring-2 focus:ring-emerald-700"
                    />
                  </td>
                  <td className="py-2.5 px-4">
                    <div className="inline-flex items-center gap-1">
                      <ScheduleInlineNumberInput
                        value={sched.durationMinutes}
                        min={5}
                        max={300}
                        fallback={60}
                        onCommit={(nextVal) =>
                          void handleUpdateScheduleKkmOrStatus(sched, {
                            durationMinutes: nextVal,
                          })
                        }
                        className="w-16 px-2 py-1 rounded-lg border border-slate-300 font-mono text-xs text-center focus:outline-none focus:ring-2 focus:ring-emerald-700"
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
                      onClick={() => void handleDeleteSingleSchedule(sched)}
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
            Mendukung semua jenis soal (<strong>Pilihan Ganda</strong>, <strong>Benar / Salah</strong>, dan <strong>Menjodohkan</strong>), rumus LaTeX (<code className="font-mono">$...$</code>), <code className="font-mono">Gambar URL</code>, serta kolom opsional <code className="font-mono">Gambar Opsi A–D</code>. Kolom <code className="font-mono">Target Kelas</code> mendukung format seperti <code className="font-mono">7A</code> atau <code className="font-mono">VII A, VII B</code>.
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
              onClick={handleDownloadExcelTemplate}
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
            Unduh template Word (.docx) yang mencakup semua jenis soal (<strong>Pilihan Ganda</strong>, <strong>Benar / Salah</strong>, dan <strong>Menjodohkan</strong>), rumus LaTeX (<code className="font-mono">$...$</code>), serta gambar tertanam agar terbaca otomatis. Atur target kelas spesifik sebelum mengunggah.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            {availableSubjects.length > 0 ? (
              <select
                value={importDocxSubject || availableSubjects[0]}
                onChange={(e) => setImportDocxSubject(e.target.value)}
                className="px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium"
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
                value={importDocxSubject}
                onChange={(e) => setImportDocxSubject(e.target.value)}
                placeholder="Nama mata pelajaran..."
                className="px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-medium"
              />
            )}
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
              onClick={() => void handleDownloadWordTemplate()}
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

            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as 'ALL' | QuestionType)}
              className="px-3 py-2 rounded-xl border border-slate-300 bg-white text-sm font-medium text-slate-700"
            >
              <option value="ALL">Semua Jenis Soal</option>
              <option value="multiple_choice">Pilihan Ganda</option>
              <option value="true_false">Benar / Salah</option>
              <option value="matching">Menjodohkan</option>
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

            {hasActiveQuestionFilter && (
              <button
                type="button"
                onClick={() => {
                  if (!isRestrictedBySubject || availableSubjects.length > 1) {
                    setSubjectFilter('ALL');
                  }
                  setClassFilter('ALL');
                  setTypeFilter('ALL');
                  setSearchQuery('');
                }}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Tampilkan Semua</span>
              </button>
            )}

            <span className="text-xs font-mono text-slate-500 tabular-nums whitespace-nowrap">
              {filteredQuestions.length === visibleQuestions.length
                ? `${filteredQuestions.length} butir soal`
                : `${filteredQuestions.length} / ${visibleQuestions.length} soal`}
            </span>
          </div>
        </div>

        <div className="divide-y divide-slate-100">
          {filteredQuestions.length === 0 ? (
            <div className="py-10 px-4 text-center text-sm text-slate-500 space-y-2">
              <div>
                {visibleQuestions.length === 0
                  ? isSyncingCloud
                    ? 'Sedang memuat bank soal dari database Supabase...'
                    : 'Belum ada data soal tersimpan atau Service Role Key belum aktif.'
                  : 'Tidak ada soal yang cocok dengan filter mata pelajaran, jenis soal, atau kelas.'}
              </div>
              {hasActiveQuestionFilter && visibleQuestions.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    if (!isRestrictedBySubject || availableSubjects.length > 1) {
                      setSubjectFilter('ALL');
                    }
                    setClassFilter('ALL');
                    setTypeFilter('ALL');
                    setSearchQuery('');
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Reset Filter &amp; Tampilkan Semua ({visibleQuestions.length} soal)</span>
                </button>
              )}
            </div>
          ) : (
            displayedQuestions.map((q) => {
              const qType = getEffectiveQuestionType(q);
              const matchingPairs = qType === 'matching' ? reconstructMatchingPairs(q) : [];
              const displayOptions =
                qType === 'true_false'
                  ? q.options.length >= 2
                    ? q.options.slice(0, 2)
                    : TRUE_FALSE_DEFAULT_OPTIONS
                  : q.options;

              return (
              <div
                key={q.id}
                className="p-4 sm:p-5 flex items-start justify-between gap-4 hover:bg-slate-50/60"
              >
                <div className="space-y-2.5 min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 font-medium">
                    <span className="font-mono font-bold text-slate-800 bg-slate-100 px-2 py-0.5 rounded-md">
                      No. {q.orderIndex}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded-md font-semibold border ${
                        qType === 'matching'
                          ? 'bg-amber-50 border-amber-200 text-amber-800'
                          : qType === 'true_false'
                            ? 'bg-sky-50 border-sky-200 text-sky-800'
                            : 'bg-slate-100 border-slate-200 text-slate-700'
                      }`}
                    >
                      {QUESTION_TYPE_LABELS[qType]}
                      {qType === 'matching' && matchingPairs.length > 0
                        ? ` (${matchingPairs.length} Pasangan)`
                        : ''}
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
                      Kunci:{' '}
                      <strong className="font-mono text-slate-900">
                        {qType === 'matching'
                          ? `${matchingPairs.length} Pasangan (Teracak di Siswa)`
                          : qType === 'true_false'
                            ? q.correctAnswer === 'B'
                              ? 'Salah'
                              : 'Benar'
                            : q.correctAnswer}
                      </strong>
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono">{q.points} poin</span>
                  </div>

                  {q.questionImageUrl && (
                    <QuestionImage
                      src={q.questionImageUrl}
                      alt={`Gambar Soal No. ${q.orderIndex}`}
                      compact
                      className="max-h-32 rounded-lg border border-slate-200 object-contain bg-white p-1"
                    />
                  )}

                  <div className="text-sm font-medium text-slate-900 leading-relaxed">
                    <MathText text={q.questionText} />
                  </div>

                  {/* Option / Pair Previews per Question Type */}
                  {qType === 'matching' ? (
                    <div className="space-y-1.5 pt-1">
                      {matchingPairs.map((pair, idx) => (
                        <div
                          key={pair.id || idx}
                          className="grid grid-cols-1 sm:grid-cols-11 gap-2 items-center rounded-xl border border-amber-200/80 bg-amber-50/40 px-3 py-2 text-xs"
                        >
                          <div className="sm:col-span-5 flex items-start gap-2 min-w-0">
                            <span className="font-mono font-bold px-1.5 py-0.5 rounded bg-white border border-amber-200 text-amber-900 shrink-0">
                              {idx + 1}
                            </span>
                            <div className="min-w-0 flex-1 space-y-1">
                              {pair.leftText && (
                                <div className="text-slate-800 break-words">
                                  <MathText text={pair.leftText} />
                                </div>
                              )}
                              {pair.leftImageUrl && (
                                <QuestionImage
                                  src={pair.leftImageUrl}
                                  alt={`Soal Pasangan ${idx + 1}`}
                                  compact
                                  className="max-h-16 rounded border border-slate-200 bg-white object-contain p-0.5"
                                />
                              )}
                            </div>
                          </div>

                          <div className="hidden sm:flex sm:col-span-1 justify-center text-amber-700">
                            <ArrowLeftRight className="w-3.5 h-3.5" />
                          </div>

                          <div className="sm:col-span-5 flex items-start gap-2 min-w-0">
                            <span className="font-mono font-bold px-1.5 py-0.5 rounded bg-emerald-800 text-white shrink-0">
                              Pasangan
                            </span>
                            <div className="min-w-0 flex-1 space-y-1">
                              {pair.rightText && (
                                <div className="text-emerald-950 font-medium break-words">
                                  <MathText text={pair.rightText} />
                                </div>
                              )}
                              {pair.rightImageUrl && (
                                <QuestionImage
                                  src={pair.rightImageUrl}
                                  alt={`Jawaban Pasangan ${idx + 1}`}
                                  compact
                                  className="max-h-16 rounded border border-emerald-200 bg-white object-contain p-0.5"
                                />
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                      {displayOptions.map((opt) => {
                        const isCorrect = opt.key === q.correctAnswer;
                        const labelBadge =
                          qType === 'true_false'
                            ? opt.key === 'A'
                              ? 'Benar'
                              : 'Salah'
                            : opt.key;
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
                                isCorrect
                                  ? 'bg-[#064e3b] text-white'
                                  : 'bg-white border border-slate-200 text-slate-700'
                              }`}
                            >
                              {labelBadge}
                            </span>
                            {qType !== 'true_false' && (
                              <div className="min-w-0 flex-1 space-y-1.5">
                                {opt.text && (
                                  <div className="break-words">
                                    <MathText text={opt.text} />
                                  </div>
                                )}
                                {opt.imageUrl && (
                                  <QuestionImage
                                    src={opt.imageUrl}
                                    alt={`Gambar Opsi ${opt.key}`}
                                    compact
                                    className="max-h-20 rounded border border-slate-200 bg-white object-contain p-0.5"
                                  />
                                )}
                              </div>
                            )}
                            {qType === 'true_false' && (
                              <span className="pt-0.5 font-medium">
                                {isCorrect ? 'Kunci Jawaban Benar' : 'Pernyataan Salah / Pengecoh'}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
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
                    onClick={() => void handleDeleteSingleQuestion(q)}
                    title="Hapus soal"
                    className="p-2 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
              );
            })
          )}
        </div>

        {filteredQuestions.length > PAGE_SIZE && (
          <div className="px-4 py-3 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
            <div>
              {showAllQuestions ? (
                <span>
                  Menampilkan {displayedQuestions.length} dari {filteredQuestions.length} soal (dibatasi maks.{' '}
                  {MAX_SHOW_ALL} baris agar peramban tetap ringan).
                </span>
              ) : (
                <span>
                  Menampilkan soal {(safeListPage - 1) * PAGE_SIZE + 1}–
                  {Math.min(safeListPage * PAGE_SIZE, filteredQuestions.length)} dari{' '}
                  {filteredQuestions.length} soal (Halaman {safeListPage} dari {totalPages})
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {!showAllQuestions && totalPages > 1 && (
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
                onClick={() => setShowAllQuestions((v) => !v)}
                className="px-3 py-1.5 rounded-lg border border-emerald-700 bg-emerald-50 hover:bg-emerald-100 text-emerald-900 font-semibold cursor-pointer"
              >
                {showAllQuestions
                  ? `Bagi per ${PAGE_SIZE} Soal`
                  : filteredQuestions.length > MAX_SHOW_ALL
                    ? `Tampilkan ${MAX_SHOW_ALL} Teratas`
                    : `Tampilkan Semua (${filteredQuestions.length})`}
              </button>
            </div>
          </div>
        )}
      </div>
        </>
      )}

      {/* Modal: Create / Edit Question (Pilihan Ganda, Benar/Salah, Menjodohkan) */}
      {questionModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5">
          <div className="w-full max-w-3xl max-h-[92vh] bg-white rounded-2xl border border-slate-200 shadow-2xl flex flex-col overflow-hidden">
            <div className="px-5 py-4 bg-[#064e3b] text-white flex items-center justify-between gap-3 shrink-0">
              <div>
                <h3 className="font-display font-bold text-base">
                  {qForm.id
                    ? `Edit Soal Nomor ${qForm.orderIndex} (${QUESTION_TYPE_LABELS[activeQuestionType]})`
                    : 'Buat Soal Baru'}
                </h3>
                <p className="text-xs text-emerald-100/85">
                  Mendukung penulisan huruf Arab &amp; harakat, tekan Enter untuk baris baru, rumus LaTeX ($...$), serta upload gambar CDN.
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

              {/* Selector Jenis Soal */}
              <div className="space-y-2">
                <label className="block text-xs font-semibold text-slate-600">
                  Jenis Soal
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  {(
                    [
                      {
                        type: 'multiple_choice' as QuestionType,
                        title: 'Pilihan Ganda',
                        desc: '4 opsi jawaban (A–D)',
                        icon: ListChecks,
                      },
                      {
                        type: 'true_false' as QuestionType,
                        title: 'Benar / Salah',
                        desc: 'Pernyataan Benar atau Salah',
                        icon: CheckCircle2,
                      },
                      {
                        type: 'matching' as QuestionType,
                        title: 'Menjodohkan',
                        desc: 'Beberapa soal & jawaban teracak',
                        icon: ArrowLeftRight,
                      },
                    ] as const
                  ).map((item) => {
                    const Icon = item.icon;
                    const isSelected = activeQuestionType === item.type;
                    return (
                      <button
                        key={item.type}
                        type="button"
                        onClick={() => handleChangeQuestionType(item.type)}
                        className={`p-3 rounded-xl border text-left transition-all flex items-start gap-2.5 cursor-pointer ${
                          isSelected
                            ? 'bg-emerald-50 border-[#064e3b] ring-1 ring-[#064e3b] text-emerald-950'
                            : 'bg-white border-slate-200 hover:border-slate-300 hover:bg-slate-50 text-slate-700'
                        }`}
                      >
                        <div
                          className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                            isSelected
                              ? 'bg-[#064e3b] text-white'
                              : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          <Icon className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs font-bold leading-tight">{item.title}</div>
                          <div className="text-[11px] text-slate-500 mt-0.5 leading-snug">
                            {item.desc}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div
                className={`grid grid-cols-2 gap-3 ${
                  activeQuestionType === 'multiple_choice' ? 'sm:grid-cols-4' : 'sm:grid-cols-3'
                }`}
              >
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
                  {modalSubjectOptions.length > 0 ? (
                    <select
                      value={qForm.subject || modalSubjectOptions[0]}
                      onChange={(e) => setQForm((prev) => ({ ...prev, subject: e.target.value }))}
                      className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-white text-sm font-medium"
                    >
                      {modalSubjectOptions.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      required
                      value={qForm.subject}
                      onChange={(e) => setQForm((prev) => ({ ...prev, subject: e.target.value }))}
                      placeholder="Mis. Matematika"
                      className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-white text-sm font-medium"
                    />
                  )}
                </div>
                {activeQuestionType === 'multiple_choice' && (
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">
                      Kunci Jawaban
                    </label>
                    <select
                      value={['A', 'B', 'C', 'D'].includes(qForm.correctAnswer) ? qForm.correctAnswer : 'A'}
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
                )}
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

              {/* Teks Pertanyaan / Instruksi + LaTeX + Huruf Arab + Multi-baris */}
              <div className="space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="text-xs font-semibold text-slate-600 flex items-center gap-1.5">
                    <Sigma className="w-3.5 h-3.5 text-emerald-700" />
                    <span>
                      {activeQuestionType === 'matching'
                        ? 'Instruksi Soal Menjodohkan (Enter = Baris Baru, Arab & $LaTeX$)'
                        : activeQuestionType === 'true_false'
                          ? 'Teks Pernyataan Benar/Salah (Enter = Baris Baru, Arab & $LaTeX$)'
                          : 'Teks Pertanyaan (Enter = Baris Baru, Arab & $LaTeX$)'}
                    </span>
                  </label>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setShowArabicKeyboard((v) => !v)}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-semibold cursor-pointer transition-colors ${
                        showArabicKeyboard
                          ? 'bg-[#064e3b] border-[#064e3b] text-white'
                          : 'bg-emerald-50 border-emerald-300 text-emerald-900 hover:bg-emerald-100'
                      }`}
                    >
                      <Languages className="w-3.5 h-3.5" />
                      <span>Huruf Arab (عربي)</span>
                    </button>
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
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => insertLatexSnippet(s.code)}
                        className="px-2 py-1 rounded bg-slate-100 hover:bg-emerald-50 text-slate-700 hover:text-emerald-900 text-xs font-medium cursor-pointer"
                      >
                        + {s.label}
                      </button>
                    ))}
                  </div>
                </div>

                {showArabicKeyboard && (
                  <ArabicKeyboardPanel
                    activeFieldLabel={activeEditorLabel}
                    directionMode={textDirectionMode}
                    onDirectionChange={setTextDirectionMode}
                    onInsertText={insertTextAtActiveCursor}
                    onBackspace={backspaceAtActiveCursor}
                    onClose={() => setShowArabicKeyboard(false)}
                  />
                )}

                <textarea
                  ref={(el) => {
                    editorRefs.current['question'] = el;
                  }}
                  dir={textDirectionMode}
                  rows={activeQuestionType === 'matching' ? 3 : 4}
                  value={qForm.questionText}
                  onFocus={() => setActiveEditorTarget({ kind: 'question' })}
                  onChange={(e) =>
                    setQForm((prev) => ({ ...prev, questionText: e.target.value }))
                  }
                  placeholder={
                    activeQuestionType === 'matching'
                      ? 'Contoh: Jodohkan pernyataan/kata di sebelah kiri dengan pasangan jawaban yang tepat...\nTekan Enter untuk baris baru.'
                      : activeQuestionType === 'true_false'
                        ? 'Contoh: Hasil dari $2^3 + 4$ adalah $12$.\nTekan Enter untuk membuat baris baru atau klik Huruf Arab (عربي).'
                        : 'Contoh: Bacalah ayat berikut dengan cermat:\nبِسْمِ اللَّهِ الرَّحْمٰنِ الرَّحِيْمِ\nTekan Enter untuk membuat baris baru...'
                  }
                  className={`w-full px-3.5 py-2.5 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-700 whitespace-pre-wrap ${
                    textDirectionMode === 'rtl' || containsArabicScript(qForm.questionText)
                      ? 'font-arabic text-base leading-[2]'
                      : 'text-sm leading-relaxed'
                  }`}
                />
                {qForm.questionText.trim() && (
                  <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 text-sm">
                    <div className="text-[11px] font-semibold text-slate-500 mb-1.5">
                      Pratinjau Tampilan Soal (Baris Baru, Huruf Arab &amp; LaTeX):
                    </div>
                    <MathText text={qForm.questionText} className="text-slate-900" />
                  </div>
                )}
              </div>

              {/* Gambar Pertanyaan */}
              <div className="space-y-2">
                <label className="block text-xs font-semibold text-slate-600">
                  Gambar Pertanyaan (Opsional — Upload Langsung ke CDN atau Tempel URL)
                </label>
                <div className="flex flex-col sm:flex-row gap-2">
                  <div className="relative flex-1">
                    <Link2 className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={qForm.questionImageUrl}
                      onChange={(e) => {
                        setFormError('');
                        setQForm((prev) => ({
                          ...prev,
                          questionImageUrl: normalizeQuestionImageUrl(e.target.value),
                        }));
                      }}
                      placeholder="URL gambar soal (https://... atau link Google Drive) atau klik Upload"
                      className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-300 text-xs sm:text-sm"
                    />
                  </div>
                  <label
                    className={`inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-xl border text-xs font-semibold whitespace-nowrap ${
                      uploadingImageTarget === 'question'
                        ? 'bg-emerald-100 text-emerald-900 border-emerald-300 cursor-wait opacity-80'
                        : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border-emerald-200 cursor-pointer'
                    }`}
                  >
                    {uploadingImageTarget === 'question' ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <ImagePlus className="w-4 h-4" />
                    )}
                    <span>
                      {uploadingImageTarget === 'question'
                        ? 'Mengunggah...'
                        : 'Upload Gambar Soal'}
                    </span>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif,image/*"
                      disabled={uploadingImageTarget !== null}
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
                <p className="text-[11px] text-slate-500">
                  File gambar otomatis dikompresi (WebP/JPEG ringan) dan diunggah ke Supabase Storage CDN agar tidak membebani server saat 1.000 peserta mengunduh soal.
                </p>
                {qForm.questionImageUrl && (
                  <div className="p-2 rounded-xl border border-slate-200 bg-slate-50 inline-block">
                    <QuestionImage
                      src={qForm.questionImageUrl}
                      alt="Pratinjau Gambar Soal"
                      lazy={false}
                      className="max-h-40 object-contain rounded-lg"
                    />
                  </div>
                )}
              </div>

              {/* Dynamic Answer Section by QuestionType */}
              {activeQuestionType === 'multiple_choice' && (
                <div className="space-y-3">
                  <div className="text-xs font-semibold text-slate-700">
                    Opsi Jawaban A–D (Mendukung Baris Baru/Enter, Huruf Arab, LaTeX &amp; Upload Gambar)
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {OPTION_KEYS.map((key) => {
                      const optVal = qForm.options[key];
                      const isKey = qForm.correctAnswer === key;
                      const isUploadingOpt = uploadingImageTarget === `opt-${key}`;
                      const showOptPreview =
                        Boolean(optVal.text.trim()) &&
                        (optVal.text.includes('\n') ||
                          optVal.text.includes('$') ||
                          containsArabicScript(optVal.text));
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
                              <label
                                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border text-[11px] font-semibold ${
                                  isUploadingOpt
                                    ? 'bg-emerald-100 border-emerald-300 text-emerald-900 cursor-wait'
                                    : 'bg-white hover:bg-emerald-50 border-slate-200 hover:border-emerald-300 text-slate-700 hover:text-emerald-900 cursor-pointer'
                                }`}
                              >
                                {isUploadingOpt ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <ImagePlus className="w-3.5 h-3.5" />
                                )}
                                <span>
                                  {isUploadingOpt
                                    ? 'Mengunggah...'
                                    : optVal.imageUrl
                                      ? 'Ganti Gambar'
                                      : 'Upload Gambar'}
                                </span>
                                <input
                                  type="file"
                                  accept="image/png,image/jpeg,image/webp,image/gif,image/*"
                                  disabled={uploadingImageTarget !== null}
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

                          <textarea
                            ref={(el) => {
                              editorRefs.current[`option-${key}`] = el;
                            }}
                            dir={textDirectionMode}
                            rows={2}
                            placeholder={`Teks Opsi ${key} (Enter = baris baru, Arab / $LaTeX$)`}
                            value={optVal.text}
                            onFocus={() => setActiveEditorTarget({ kind: 'option', key })}
                            onChange={(e) =>
                              setQForm((prev) => ({
                                ...prev,
                                options: {
                                  ...prev.options,
                                  [key]: { ...prev.options[key], text: e.target.value },
                                },
                              }))
                            }
                            className={`w-full px-3 py-2 rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700 whitespace-pre-wrap ${
                              textDirectionMode === 'rtl' || containsArabicScript(optVal.text)
                                ? 'font-arabic text-base leading-[1.9]'
                                : 'text-sm'
                            }`}
                          />

                          {showOptPreview && (
                            <div className="px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 text-xs text-slate-800">
                              <MathText text={optVal.text} />
                            </div>
                          )}

                          <input
                            type="text"
                            placeholder={`URL gambar opsi ${key} (opsional)`}
                            value={optVal.imageUrl}
                            onChange={(e) =>
                              setQForm((prev) => ({
                                ...prev,
                                options: {
                                  ...prev.options,
                                  [key]: {
                                    ...prev.options[key],
                                    imageUrl: normalizeQuestionImageUrl(e.target.value),
                                  },
                                },
                              }))
                            }
                            className="w-full px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs text-slate-600"
                          />

                          {optVal.imageUrl && (
                            <div className="p-1.5 rounded-lg bg-white border border-slate-200 inline-block">
                              <QuestionImage
                                src={optVal.imageUrl}
                                alt={`Pratinjau Opsi ${key}`}
                                lazy={false}
                                compact
                                className="max-h-24 object-contain rounded"
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {activeQuestionType === 'true_false' && (
                <div className="space-y-3">
                  <div className="text-xs font-semibold text-slate-700">
                    Pilih Kunci Jawaban (Benar atau Salah)
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {TRUE_FALSE_DEFAULT_OPTIONS.map((tfOpt) => {
                      const isKey = (qForm.correctAnswer === 'B' ? 'B' : 'A') === tfOpt.key;
                      return (
                        <button
                          key={tfOpt.key}
                          type="button"
                          onClick={() =>
                            setQForm((prev) => ({
                              ...prev,
                              correctAnswer: tfOpt.key,
                            }))
                          }
                          className={`p-4 rounded-xl border text-left flex items-center justify-between gap-3 transition-all cursor-pointer ${
                            isKey
                              ? 'bg-emerald-50 border-[#064e3b] ring-1 ring-[#064e3b] text-emerald-950'
                              : 'bg-slate-50/70 border-slate-200 hover:bg-slate-100 text-slate-700'
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <span
                              className={`w-8 h-8 rounded-lg font-mono font-bold text-sm flex items-center justify-center ${
                                isKey ? 'bg-[#064e3b] text-white' : 'bg-white border border-slate-200 text-slate-600'
                              }`}
                            >
                              {tfOpt.key === 'A' ? 'B' : 'S'}
                            </span>
                            <div>
                              <div className="font-bold text-sm">{tfOpt.text}</div>
                              <div className="text-[11px] text-slate-500">
                                {isKey ? 'Kunci jawaban terpilih' : 'Klik untuk jadikan kunci'}
                              </div>
                            </div>
                          </div>
                          {isKey && (
                            <CheckCircle2 className="w-5 h-5 text-[#064e3b] shrink-0" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {activeQuestionType === 'matching' && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-xs font-semibold text-slate-800">
                        Daftar Pasangan Soal &amp; Jawaban ({activeMatchingPairs.length} Pasangan)
                      </div>
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        Mendukung baris baru (Enter), huruf Arab, LaTeX, dan gambar per pasangan. Posisi sisi kanan otomatis diacak saat ujian.
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={activeMatchingPairs.length >= 12}
                      onClick={() =>
                        setQForm((prev) => {
                          const current =
                            Array.isArray(prev.matchingPairs) && prev.matchingPairs.length >= 2
                              ? prev.matchingPairs
                              : createDefaultMatchingPairs();
                          if (current.length >= 12) return prev;
                          const nextIndex = current.length + 1;
                          return {
                            ...prev,
                            matchingPairs: [
                              ...current,
                              {
                                id: `L${Date.now().toString(36).slice(-4)}_${nextIndex}`,
                                leftText: '',
                                rightText: '',
                              },
                            ],
                          };
                        })
                      }
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-50 hover:bg-emerald-100 border border-emerald-300 text-emerald-900 text-xs font-semibold cursor-pointer disabled:opacity-40"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Tambah Pasangan</span>
                    </button>
                  </div>

                  <div className="space-y-2.5">
                    {activeMatchingPairs.map((pair, idx) => {
                      const isUploadingLeft = uploadingImageTarget === `match-${idx}-left`;
                      const isUploadingRight = uploadingImageTarget === `match-${idx}-right`;
                      return (
                      <div
                        key={pair.id || idx}
                        className="p-3 rounded-xl border border-slate-200 bg-slate-50/70 space-y-2.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono font-bold text-xs text-slate-700 bg-white px-2 py-0.5 rounded border border-slate-200">
                            Pasangan #{idx + 1}
                          </span>
                          {activeMatchingPairs.length > 2 && (
                            <button
                              type="button"
                              onClick={() =>
                                setQForm((prev) => ({
                                  ...prev,
                                  matchingPairs: activeMatchingPairs.filter((_, i) => i !== idx),
                                }))
                              }
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-rose-200 bg-white hover:bg-rose-50 text-rose-700 text-[11px] font-semibold cursor-pointer"
                            >
                              <Trash2 className="w-3 h-3" />
                              <span>Hapus Baris</span>
                            </button>
                          )}
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-11 gap-2.5 items-start">
                          {/* Left Side (Prompt) */}
                          <div className="sm:col-span-5 space-y-1.5 bg-white p-2.5 rounded-lg border border-slate-200">
                            <div className="flex items-center justify-between gap-1">
                              <span className="text-[11px] font-bold text-slate-600">
                                Sisi Kiri — Soal / Pernyataan {idx + 1}
                              </span>
                              <label
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-semibold ${
                                  isUploadingLeft
                                    ? 'bg-emerald-100 border-emerald-300 text-emerald-900 cursor-wait'
                                    : 'bg-slate-50 hover:bg-emerald-50 border-slate-200 text-slate-600 hover:text-emerald-800 cursor-pointer'
                                }`}
                              >
                                {isUploadingLeft ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                  <ImagePlus className="w-3 h-3" />
                                )}
                                <span>
                                  {isUploadingLeft ? 'Unggah...' : pair.leftImageUrl ? 'Ganti' : 'Gambar'}
                                </span>
                                <input
                                  type="file"
                                  accept="image/png,image/jpeg,image/webp,image/gif,image/*"
                                  disabled={uploadingImageTarget !== null}
                                  onChange={(e) => void handleUploadMatchingImage(idx, 'left', e)}
                                  className="sr-only"
                                />
                              </label>
                            </div>
                            <textarea
                              ref={(el) => {
                                editorRefs.current[`match-${idx}-left`] = el;
                              }}
                              dir={textDirectionMode}
                              rows={2}
                              value={pair.leftText}
                              onFocus={() =>
                                setActiveEditorTarget({ kind: 'match', index: idx, side: 'left' })
                              }
                              onChange={(e) => {
                                const val = e.target.value;
                                setQForm((prev) => {
                                  const nextPairs = [...activeMatchingPairs];
                                  nextPairs[idx] = { ...nextPairs[idx], leftText: val };
                                  return { ...prev, matchingPairs: nextPairs };
                                });
                              }}
                              placeholder={`Soal / pernyataan ${idx + 1} (Enter = baris baru, Arab / $LaTeX$)`}
                              className={`w-full px-2.5 py-1.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-700 whitespace-pre-wrap ${
                                textDirectionMode === 'rtl' || containsArabicScript(pair.leftText)
                                  ? 'font-arabic text-base leading-[1.9]'
                                  : 'text-xs sm:text-sm'
                              }`}
                            />
                            {pair.leftImageUrl && (
                              <div className="flex items-center gap-2 pt-1">
                                <QuestionImage
                                  src={pair.leftImageUrl}
                                  alt={`Gambar Kiri ${idx + 1}`}
                                  lazy={false}
                                  compact
                                  className="max-h-16 rounded border border-slate-200 object-contain"
                                />
                                <button
                                  type="button"
                                  onClick={() => {
                                    setQForm((prev) => {
                                      const nextPairs = [...activeMatchingPairs];
                                      nextPairs[idx] = { ...nextPairs[idx], leftImageUrl: '' };
                                      return { ...prev, matchingPairs: nextPairs };
                                    });
                                  }}
                                  className="text-[11px] text-rose-600 hover:underline cursor-pointer"
                                >
                                  Hapus gambar
                                </button>
                              </div>
                            )}
                          </div>

                          <div className="hidden sm:flex sm:col-span-1 items-center justify-center pt-6 text-emerald-700">
                            <ArrowLeftRight className="w-4 h-4" />
                          </div>

                          {/* Right Side (Matching Answer) */}
                          <div className="sm:col-span-5 space-y-1.5 bg-emerald-50/40 p-2.5 rounded-lg border border-emerald-200">
                            <div className="flex items-center justify-between gap-1">
                              <span className="text-[11px] font-bold text-emerald-900">
                                Sisi Kanan — Pasangan Jawaban {idx + 1}
                              </span>
                              <label
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-semibold ${
                                  isUploadingRight
                                    ? 'bg-emerald-100 border-emerald-300 text-emerald-900 cursor-wait'
                                    : 'bg-white hover:bg-emerald-50 border-emerald-200 text-emerald-800 cursor-pointer'
                                }`}
                              >
                                {isUploadingRight ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                  <ImagePlus className="w-3 h-3" />
                                )}
                                <span>
                                  {isUploadingRight ? 'Unggah...' : pair.rightImageUrl ? 'Ganti' : 'Gambar'}
                                </span>
                                <input
                                  type="file"
                                  accept="image/png,image/jpeg,image/webp,image/gif,image/*"
                                  disabled={uploadingImageTarget !== null}
                                  onChange={(e) => void handleUploadMatchingImage(idx, 'right', e)}
                                  className="sr-only"
                                />
                              </label>
                            </div>
                            <textarea
                              ref={(el) => {
                                editorRefs.current[`match-${idx}-right`] = el;
                              }}
                              dir={textDirectionMode}
                              rows={2}
                              value={pair.rightText}
                              onFocus={() =>
                                setActiveEditorTarget({ kind: 'match', index: idx, side: 'right' })
                              }
                              onChange={(e) => {
                                const val = e.target.value;
                                setQForm((prev) => {
                                  const nextPairs = [...activeMatchingPairs];
                                  nextPairs[idx] = { ...nextPairs[idx], rightText: val };
                                  return { ...prev, matchingPairs: nextPairs };
                                });
                              }}
                              placeholder={`Jawaban pasangan ${idx + 1} (Enter = baris baru, Arab / $LaTeX$)`}
                              className={`w-full px-2.5 py-1.5 rounded-lg border border-emerald-300 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-700 whitespace-pre-wrap ${
                                textDirectionMode === 'rtl' || containsArabicScript(pair.rightText)
                                  ? 'font-arabic text-base leading-[1.9]'
                                  : 'text-xs sm:text-sm'
                              }`}
                            />
                            {pair.rightImageUrl && (
                              <div className="flex items-center gap-2 pt-1">
                                <QuestionImage
                                  src={pair.rightImageUrl}
                                  alt={`Gambar Kanan ${idx + 1}`}
                                  lazy={false}
                                  compact
                                  className="max-h-16 rounded border border-emerald-200 bg-white object-contain"
                                />
                                <button
                                  type="button"
                                  onClick={() => {
                                    setQForm((prev) => {
                                      const nextPairs = [...activeMatchingPairs];
                                      nextPairs[idx] = { ...nextPairs[idx], rightImageUrl: '' };
                                      return { ...prev, matchingPairs: nextPairs };
                                    });
                                  }}
                                  className="text-[11px] text-rose-600 hover:underline cursor-pointer"
                                >
                                  Hapus gambar
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                      );
                    })}
                  </div>
                </div>
              )}
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
