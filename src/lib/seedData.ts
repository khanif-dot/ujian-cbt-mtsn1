import {
  type AdminTabKey,
  type SchoolProfile,
  type StaffAccount,
} from '@/src/types/cbt';

const DEFAULT_EMBLEM_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="16 12 88 99" fill="none">
  <path d="M60 16L98 33V60C98 83.5 81.8 101.6 60 107C38.2 101.6 22 83.5 22 60V33L60 16Z" fill="#047857" stroke="#A7F3D0" stroke-width="3"/>
  <path d="M40 50C40 46.6863 42.6863 44 46 44H57V77H46C42.6863 77 40 74.3137 40 71V50Z" fill="#ECFDF5"/>
  <path d="M80 50C80 46.6863 77.3137 44 74 44H63V77H74C77.3137 77 80 74.3137 80 71V50Z" fill="#D1FAE5"/>
  <circle cx="60" cy="34" r="5" fill="#FDE68A"/>
</svg>`;

export const DEFAULT_LOGO_DATA_URL = `data:image/svg+xml;utf8,${encodeURIComponent(DEFAULT_EMBLEM_SVG)}`;

export const SEED_SCHOOL_PROFILE: SchoolProfile = {
  id: 'default',
  schoolName: 'SMP Negeri 1 Nusantara',
  address: 'Jl. Ki Hajar Dewantara No. 45, Kota Pendidikan',
  academicYear: '2026/2027',
  principalName: 'Dr. H. Ahmad Fauzi, M.Pd.',
  committeeChairName: 'Siti Rahmawati, S.Pd., M.Si.',
  examTitle: 'Penilaian Akhir Semester (PAS) Ganjil',
  logoDataUrl: DEFAULT_LOGO_DATA_URL,
  adminPassword: 'admin123',
  updatedAt: '2026-11-15T07:00:00.000Z',
};

export const ALL_ADMIN_TABS: AdminTabKey[] = [
  'dashboard',
  'reset',
  'recap',
  'branding',
  'participants',
  'questions',
  'cards',
  'roles',
  'database',
];

export const PROKTOR_DEFAULT_TABS: AdminTabKey[] = [
  'dashboard',
  'reset',
  'recap',
  'participants',
  'questions',
  'cards',
];

export const GURU_MAPEL_DEFAULT_TABS: AdminTabKey[] = ['recap', 'questions'];

export const SEED_STAFF_ACCOUNTS: StaffAccount[] = [
  {
    id: 'staff-admin-main',
    userId: 'admin',
    name: 'Administrator Utama',
    password: SEED_SCHOOL_PROFILE.adminPassword,
    roleType: 'admin',
    roleLabel: 'Administrator',
    allowedTabs: ALL_ADMIN_TABS,
    assignedSubjects: [],
    restrictToAssignedSubjects: false,
    isActive: true,
    createdAt: '2026-11-10T07:00:00.000Z',
  },
  {
    id: 'staff-proktor-1',
    userId: 'proktor1',
    name: 'Proktor Lab Komputer 1',
    password: 'proktor123',
    roleType: 'proktor',
    roleLabel: 'Proktor (Teknisi)',
    allowedTabs: PROKTOR_DEFAULT_TABS,
    assignedSubjects: [],
    restrictToAssignedSubjects: false,
    isActive: true,
    createdAt: '2026-11-10T07:05:00.000Z',
  },
  {
    id: 'staff-guru-matematika',
    userId: 'guru-mtk',
    name: 'Guru Matematika',
    password: 'guru123',
    roleType: 'guru_mapel',
    roleLabel: 'Guru Mapel',
    allowedTabs: GURU_MAPEL_DEFAULT_TABS,
    assignedSubjects: ['Matematika'],
    restrictToAssignedSubjects: true,
    isActive: true,
    createdAt: '2026-11-10T07:10:00.000Z',
  },
];

