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

export const KEMENAG_HEADER_TITLE = 'KEMENTRIAN AGAMA REPUBLIK INDONESIA';

const KEMENAG_EMBLEM_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240" fill="none">
  <!-- Outer Pentagon Shield -->
  <path d="M120 12L218 52L194 176L120 226L46 176L22 52L120 12Z" fill="#006837" stroke="#FACC15" stroke-width="6" stroke-linejoin="round"/>
  <path d="M120 22L208 58L186 170L120 215L54 170L32 58L120 22Z" fill="#047857" stroke="#FDE047" stroke-width="2.5" stroke-linejoin="round"/>
  <!-- Top Radiant Star -->
  <g stroke="#FDE047" stroke-width="2" stroke-linecap="round" opacity="0.85">
    <line x1="120" y1="30" x2="120" y2="39"/>
    <line x1="100" y1="36" x2="106" y2="43"/>
    <line x1="140" y1="36" x2="134" y2="43"/>
    <line x1="90" y1="50" x2="99" y2="52"/>
    <line x1="150" y1="50" x2="141" y2="52"/>
  </g>
  <polygon points="120,38 125.5,50 138.5,51.5 129,60.5 131.5,73.5 120,67 108.5,73.5 111,60.5 101.5,51.5 114.5,50" fill="#FACC15" stroke="#FEF08A" stroke-width="1.2" stroke-linejoin="round"/>
  <!-- Padi (Left Rice Stalk) -->
  <path d="M68 164C50 140 46 108 58 76" stroke="#FACC15" stroke-width="3.5" stroke-linecap="round"/>
  <g fill="#FDE047">
    <ellipse cx="52" cy="84" rx="5" ry="2.6" transform="rotate(-35 52 84)"/>
    <ellipse cx="63" cy="88" rx="5" ry="2.6" transform="rotate(25 63 88)"/>
    <ellipse cx="48" cy="100" rx="5.2" ry="2.7" transform="rotate(-35 48 100)"/>
    <ellipse cx="60" cy="104" rx="5.2" ry="2.7" transform="rotate(25 60 104)"/>
    <ellipse cx="47" cy="117" rx="5.4" ry="2.8" transform="rotate(-30 47 117)"/>
    <ellipse cx="60" cy="120" rx="5.4" ry="2.8" transform="rotate(25 60 120)"/>
    <ellipse cx="50" cy="134" rx="5.4" ry="2.8" transform="rotate(-25 50 134)"/>
    <ellipse cx="63" cy="136" rx="5.4" ry="2.8" transform="rotate(25 63 136)"/>
    <ellipse cx="56" cy="150" rx="5.2" ry="2.7" transform="rotate(-20 56 150)"/>
    <ellipse cx="68" cy="151" rx="5.2" ry="2.7" transform="rotate(20 68 151)"/>
  </g>
  <!-- Kapas (Right Cotton Stalk) -->
  <path d="M172 164C190 140 194 108 182 76" stroke="#86EFAC" stroke-width="3.5" stroke-linecap="round"/>
  <g>
    <circle cx="182" cy="84" r="6" fill="#FFFFFF" stroke="#15803D" stroke-width="1.5"/>
    <circle cx="187" cy="102" r="6.5" fill="#FFFFFF" stroke="#15803D" stroke-width="1.5"/>
    <circle cx="188" cy="121" r="6.5" fill="#FFFFFF" stroke="#15803D" stroke-width="1.5"/>
    <circle cx="184" cy="140" r="6.5" fill="#FFFFFF" stroke="#15803D" stroke-width="1.5"/>
    <circle cx="176" cy="156" r="6" fill="#FFFFFF" stroke="#15803D" stroke-width="1.5"/>
  </g>
  <!-- Stylized Globe & Open Holy Book -->
  <circle cx="120" cy="108" r="26" fill="#0284C7" stroke="#BAE6FD" stroke-width="2"/>
  <ellipse cx="120" cy="108" rx="12" ry="26" fill="none" stroke="#E0F2FE" stroke-width="1.5"/>
  <line x1="94" y1="108" x2="146" y2="108" stroke="#E0F2FE" stroke-width="1.5"/>
  <path d="M98 96C106 99 134 99 142 96" stroke="#E0F2FE" stroke-width="1.3" fill="none"/>
  <path d="M98 120C106 117 134 117 142 120" stroke="#E0F2FE" stroke-width="1.3" fill="none"/>
  <!-- Open Book -->
  <path d="M78 122C94 115 110 118 120 126C130 118 146 115 162 122V156C146 149 130 152 120 159C110 152 94 149 78 156V122Z" fill="#FFFFFF" stroke="#064E3B" stroke-width="2.8" stroke-linejoin="round"/>
  <line x1="120" y1="126" x2="120" y2="159" stroke="#064E3B" stroke-width="2.4"/>
  <path d="M86 131C96 127 107 129 114 134M86 139C96 135 107 137 114 142M86 147C96 143 107 145 114 150" stroke="#94A3B8" stroke-width="1.8" stroke-linecap="round"/>
  <path d="M154 131C144 127 133 129 126 134M154 139C144 135 133 137 126 142M154 147C144 143 133 145 126 150" stroke="#94A3B8" stroke-width="1.8" stroke-linecap="round"/>
  <!-- Bottom Ribbon: IKHLAS BERAMAL -->
  <path d="M64 168H176L169 187H71L64 168Z" fill="#FEFCE8" stroke="#FACC15" stroke-width="2.4" stroke-linejoin="round"/>
  <text x="120" y="181" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="11.5" font-weight="bold" fill="#064E3B" letter-spacing="0.4">IKHLAS BERAMAL</text>
</svg>`;

export const KEMENAG_LOGO_DATA_URL = `data:image/svg+xml;utf8,${encodeURIComponent(KEMENAG_EMBLEM_SVG)}`;

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

