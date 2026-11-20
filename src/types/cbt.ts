export const GRADE_LEVELS = ['7', '8', '9'] as const;
export const CLASS_SECTIONS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'] as const;

export const ALL_CLASSES: string[] = GRADE_LEVELS.flatMap((grade) =>
  CLASS_SECTIONS.map((section) => `${grade}${section}`)
);

export type OptionKey = 'A' | 'B' | 'C' | 'D';

export interface QuestionOption {
  key: OptionKey;
  text: string;
  imageUrl?: string;
}

export interface Question {
  id: string;
  subject: string;
  targetClasses: string[];
  questionText: string;
  questionImageUrl?: string;
  options: QuestionOption[];
  correctAnswer: OptionKey;
  points: number;
  orderIndex: number;
}

/**
 * Sanitized student question payload — strictly omits `correctAnswer`
 * so answer keys cannot be inspected via DevTools / Inspect Element.
 */
export interface StudentQuestion {
  id: string;
  subject: string;
  targetClasses: string[];
  questionText: string;
  questionImageUrl?: string;
  options: QuestionOption[];
  points: number;
  orderIndex: number;
}

export interface SchoolProfile {
  id: string;
  schoolName: string;
  address: string;
  academicYear: string;
  principalName: string;
  committeeChairName: string;
  examTitle: string;
  logoDataUrl: string;
  adminPassword: string;
  updatedAt: string;
}

export interface Participant {
  id: string;
  participantNumber: string;
  token: string;
  fullName: string;
  className: string;
  isActive: boolean;
  createdAt: string;
}

export interface ExamSchedule {
  id: string;
  title: string;
  subject: string;
  kkm: number;
  durationMinutes: number;
  targetClasses: string[];
  isActive: boolean;
  randomizeQuestions?: boolean;
  maxTabSwitches: number;
  createdAt: string;
}

export type AdminTabKey =
  | 'dashboard'
  | 'reset'
  | 'recap'
  | 'branding'
  | 'participants'
  | 'questions'
  | 'cards'
  | 'roles'
  | 'database';

export type StaffRoleType = 'admin' | 'proktor' | 'guru_mapel' | 'custom';

export interface StaffAccount {
  id: string;
  userId: string;
  name: string;
  password: string;
  roleType: StaffRoleType;
  roleLabel: string;
  allowedTabs: AdminTabKey[];
  assignedSubjects: string[];
  restrictToAssignedSubjects: boolean;
  isActive: boolean;
  createdAt: string;
}

export type ExamResultStatus = 'in_progress' | 'submitted' | 'flagged';
export type SyncStatus = 'synced' | 'pending';

export interface ExamResult {
  id: string;
  participantId: string;
  participantNumber: string;
  studentName: string;
  className: string;
  examId: string;
  examTitle: string;
  subject: string;
  answers: Record<string, OptionKey>;
  flaggedQuestions: string[];
  questionIds?: string[];
  correctCount: number;
  totalQuestions: number;
  score: number;
  tabSwitchCount: number;
  status: ExamResultStatus;
  startedAt: string;
  submittedAt: string | null;
  syncStatus: SyncStatus;
}

export interface ActiveExamSession {
  resultId: string;
  participant: Participant;
  schedule: ExamSchedule;
  questions: StudentQuestion[];
  answers: Record<string, OptionKey>;
  flaggedQuestions: string[];
  currentIndex: number;
  tabSwitchCount: number;
  startedAt: string;
  endsAt: string;
}

export type RecapAttendanceStatus =
  | 'completed'
  | 'flagged'
  | 'in_progress'
  | 'not_attended';

export interface RecapEntry {
  id: string;
  hasResult: boolean;
  resultId?: string;
  participantNumber: string;
  studentName: string;
  className: string;
  examId: string;
  examTitle: string;
  subject: string;
  correctCount: number;
  totalQuestions: number;
  score: number;
  tabSwitchCount: number;
  attendanceStatus: RecapAttendanceStatus;
  submittedAt: string | null;
  startedAt: string | null;
  rawResult?: ExamResult;
}
