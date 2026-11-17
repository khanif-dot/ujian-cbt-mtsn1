import {
  ALL_CLASSES,
  type AdminTabKey,
  type ExamResult,
  type ExamSchedule,
  type Participant,
  type Question,
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

const SAMPLE_STUDENT_NAMES = [
  'Aditya Pratama Putra',
  'Aisyah Nurul Hidayah',
  'Bagas Satria Wibowo',
  'Citra Dewi Kartika',
  'Dimas Arya Saputra',
  'Eka Putri Ramadhani',
  'Fajar Nugroho Santoso',
  'Gita Permata Sari',
  'Hendra Wijaya Kusuma',
  'Intan Ayu Lestari',
  'Jihan Khairunnisa',
  'Kevin Mahendra',
  'Laila Fitriani',
  'Muhammad Rizky Fadillah',
  'Nadia Salsabila',
  'Oky Setiawan',
  'Putri Amelia Azzahra',
  'Qoriatul Hasanah',
  'Rafi Akbar Maulana',
  'Siti Zahra Khairani',
  'Taufik Hidayatullah',
  'Ulfa Rahma Yanti',
  'Vino Bastian Permana',
  'Wulan Dari Puspita',
  'Yusuf Ibrahim Hakim',
  'Zahra Aulia Rahman',
  'Naufal Daffa Alfarizi',
];

export const SEED_PARTICIPANTS: Participant[] = [
  ...ALL_CLASSES.map((cls, index) => ({
    id: `ptc-${cls.toLowerCase()}-001`,
    participantNumber: `2026-${cls}-001`,
    token: `TKN${cls}1`,
    fullName: SAMPLE_STUDENT_NAMES[index % SAMPLE_STUDENT_NAMES.length],
    className: cls,
    isActive: true,
    createdAt: `2026-11-10T08:${String(index % 59).padStart(2, '0')}:00.000Z`,
  })),
  {
    id: 'ptc-7a-002',
    participantNumber: '2026-7A-002',
    token: 'TKN7A2',
    fullName: 'Bima Sakti Pradana',
    className: '7A',
    isActive: true,
    createdAt: '2026-11-10T09:00:00.000Z',
  },
  {
    id: 'ptc-8a-002',
    participantNumber: '2026-8A-002',
    token: 'TKN8A2',
    fullName: 'Clarissa Melati Putri',
    className: '8A',
    isActive: true,
    createdAt: '2026-11-10T09:05:00.000Z',
  },
  {
    id: 'ptc-9a-002',
    participantNumber: '2026-9A-002',
    token: 'TKN9A2',
    fullName: 'Farhan Syahputra',
    className: '9A',
    isActive: true,
    createdAt: '2026-11-10T09:10:00.000Z',
  },
];

const CLASSES_7 = ALL_CLASSES.filter((c) => c.startsWith('7'));
const CLASSES_8 = ALL_CLASSES.filter((c) => c.startsWith('8'));
const CLASSES_9 = ALL_CLASSES.filter((c) => c.startsWith('9'));

export const SEED_SCHEDULES: ExamSchedule[] = [
  {
    id: 'exam-pas-matematika-2026',
    title: 'Penilaian Akhir Semester — Matematika',
    subject: 'Matematika',
    kkm: 75,
    durationMinutes: 60,
    targetClasses: ALL_CLASSES,
    isActive: true,
    randomizeQuestions: false,
    maxTabSwitches: 3,
    createdAt: '2026-11-12T06:00:00.000Z',
  },
  {
    id: 'exam-pas-ipa-2026',
    title: 'Penilaian Akhir Semester — Ilmu Pengetahuan Alam',
    subject: 'Ilmu Pengetahuan Alam',
    kkm: 78,
    durationMinutes: 60,
    targetClasses: ALL_CLASSES,
    isActive: true,
    randomizeQuestions: false,
    maxTabSwitches: 3,
    createdAt: '2026-11-12T06:15:00.000Z',
  },
  {
    id: 'exam-pas-bindo-2026',
    title: 'Penilaian Akhir Semester — Bahasa Indonesia',
    subject: 'Bahasa Indonesia',
    kkm: 75,
    durationMinutes: 45,
    targetClasses: ALL_CLASSES,
    isActive: true,
    randomizeQuestions: false,
    maxTabSwitches: 3,
    createdAt: '2026-11-12T06:30:00.000Z',
  },
];

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

export const SEED_QUESTIONS: Question[] = [
  // Matematika Kelas 7
  {
    id: 'q-mat-7-01',
    subject: 'Matematika',
    targetClasses: CLASSES_7,
    questionText:
      'Hasil dari operasi bilangan bulat $(-4) - 9 + 15$ adalah...',
    options: [
      { key: 'A', text: '$-2$' },
      { key: 'B', text: '$2$' },
      { key: 'C', text: '$10$' },
      { key: 'D', text: '$28$' },
    ],
    correctAnswer: 'B',
    points: 25,
    orderIndex: 1,
  },
  {
    id: 'q-mat-7-02',
    subject: 'Matematika',
    targetClasses: CLASSES_7,
    questionText:
      'Sebuah proyek perpustakaan diselesaikan dalam 24 hari oleh 15 pekerja. Jika dipercepat menjadi 18 hari, maka jumlah pekerja yang dibutuhkan adalah...',
    options: [
      { key: 'A', text: '18 pekerja' },
      { key: 'B', text: '20 pekerja' },
      { key: 'C', text: '22 pekerja' },
      { key: 'D', text: '24 pekerja' },
    ],
    correctAnswer: 'B',
    points: 25,
    orderIndex: 2,
  },
  {
    id: 'q-mat-7-03',
    subject: 'Matematika',
    targetClasses: CLASSES_7,
    questionText:
      'Nilai $x$ yang memenuhi persamaan linear $\\frac{2x + 4}{3} = 6$ adalah...',
    options: [
      { key: 'A', text: '$x = 5$' },
      { key: 'B', text: '$x = 7$' },
      { key: 'C', text: '$x = 9$' },
      { key: 'D', text: '$x = 11$' },
    ],
    correctAnswer: 'B',
    points: 25,
    orderIndex: 3,
  },
  {
    id: 'q-mat-7-04',
    subject: 'Matematika',
    targetClasses: CLASSES_7,
    questionText:
      'Jika luas sebuah persegi adalah $144\\text{ cm}^2$, maka keliling persegi tersebut adalah...',
    options: [
      { key: 'A', text: '$24\\text{ cm}$' },
      { key: 'B', text: '$36\\text{ cm}$' },
      { key: 'C', text: '$48\\text{ cm}$' },
      { key: 'D', text: '$72\\text{ cm}$' },
    ],
    correctAnswer: 'C',
    points: 25,
    orderIndex: 4,
  },

  // Matematika Kelas 8
  {
    id: 'q-mat-8-01',
    subject: 'Matematika',
    targetClasses: CLASSES_8,
    questionText:
      'Diketahui barisan aritmetika $5, 9, 13, 17, \\dots$ Nilai suku ke-12 ($U_{12}$) adalah...',
    options: [
      { key: 'A', text: '$45$' },
      { key: 'B', text: '$49$' },
      { key: 'C', text: '$53$' },
      { key: 'D', text: '$57$' },
    ],
    correctAnswer: 'B',
    points: 50,
    orderIndex: 1,
  },
  {
    id: 'q-mat-8-02',
    subject: 'Matematika',
    targetClasses: CLASSES_8,
    questionText:
      'Berdasarkan teorema Pythagoras $c = \\sqrt{a^2 + b^2}$, sebuah tangga sepanjang $5\\text{ m}$ bersandar dengan jarak alas $3\\text{ m}$ dari dinding. Tinggi ujung tangga dari lantai adalah...',
    options: [
      { key: 'A', text: '$3{,}5\\text{ m}$' },
      { key: 'B', text: '$4\\text{ m}$' },
      { key: 'C', text: '$4{,}5\\text{ m}$' },
      { key: 'D', text: '$6\\text{ m}$' },
    ],
    correctAnswer: 'B',
    points: 50,
    orderIndex: 2,
  },

  // Matematika Kelas 9
  {
    id: 'q-mat-9-01',
    subject: 'Matematika',
    targetClasses: CLASSES_9,
    questionText:
      'Diketahui persamaan kuadrat $x^2 - 7x + 12 = 0$. Jika $x_1$ dan $x_2$ adalah akar-akarnya, nilai dari $x_1 + x_2$ adalah...',
    options: [
      { key: 'A', text: '$-12$' },
      { key: 'B', text: '$-7$' },
      { key: 'C', text: '$7$' },
      { key: 'D', text: '$12$' },
    ],
    correctAnswer: 'C',
    points: 50,
    orderIndex: 1,
  },
  {
    id: 'q-mat-9-02',
    subject: 'Matematika',
    targetClasses: CLASSES_9,
    questionText:
      'Volume tabung dengan rumus $V = \\pi r^2 t$ untuk jari-jari $r = 7\\text{ cm}$, tinggi $t = 10\\text{ cm}$, dan $\\pi = \\frac{22}{7}$ adalah...',
    options: [
      { key: 'A', text: '$440\\text{ cm}^3$' },
      { key: 'B', text: '$1.540\\text{ cm}^3$' },
      { key: 'C', text: '$1.760\\text{ cm}^3$' },
      { key: 'D', text: '$3.080\\text{ cm}^3$' },
    ],
    correctAnswer: 'B',
    points: 50,
    orderIndex: 2,
  },

  // Ilmu Pengetahuan Alam (7A - 9I)
  {
    id: 'q-ipa-01',
    subject: 'Ilmu Pengetahuan Alam',
    targetClasses: ALL_CLASSES,
    questionText:
      'Organel sel tumbuhan yang berfungsi sebagai tempat berlangsungnya proses fotosintesis dengan bantuan energi cahaya matahari adalah...',
    options: [
      { key: 'A', text: 'Mitokondria' },
      { key: 'B', text: 'Ribosom' },
      { key: 'C', text: 'Kloroplas' },
      { key: 'D', text: 'Lisosom' },
    ],
    correctAnswer: 'C',
    points: 34,
    orderIndex: 1,
  },
  {
    id: 'q-ipa-02',
    subject: 'Ilmu Pengetahuan Alam',
    targetClasses: ALL_CLASSES,
    questionText:
      'Menurut Hukum II Newton ($F = m \\times a$), sebuah benda bermassa $4\\text{ kg}$ yang ditarik gaya mendatar $24\\text{ N}$ akan mengalami percepatan sebesar...',
    options: [
      { key: 'A', text: '$4\\text{ m/s}^2$' },
      { key: 'B', text: '$6\\text{ m/s}^2$' },
      { key: 'C', text: '$8\\text{ m/s}^2$' },
      { key: 'D', text: '$96\\text{ m/s}^2$' },
    ],
    correctAnswer: 'B',
    points: 33,
    orderIndex: 2,
  },
  {
    id: 'q-ipa-03',
    subject: 'Ilmu Pengetahuan Alam',
    targetClasses: ALL_CLASSES,
    questionText:
      'Pada rangkaian listrik tertutup berlaku hukum Ohm $V = I \\times R$. Jika arus $I = 2\\text{ A}$ mengalir melalui hambatan $R = 15\\,\\Omega$, besar tegangannya adalah...',
    options: [
      { key: 'A', text: '$7{,}5\\text{ Volt}$' },
      { key: 'B', text: '$17\\text{ Volt}$' },
      { key: 'C', text: '$30\\text{ Volt}$' },
      { key: 'D', text: '$60\\text{ Volt}$' },
    ],
    correctAnswer: 'C',
    points: 33,
    orderIndex: 3,
  },

  // Bahasa Indonesia (7A - 9I)
  {
    id: 'q-bindo-01',
    subject: 'Bahasa Indonesia',
    targetClasses: ALL_CLASSES,
    questionText:
      'Manakah kalimat berikut yang menggunakan ejaan baku dan tanda baca sesuai kaidah EYD V dengan tepat?',
    options: [
      { key: 'A', text: 'Para siswa-siswa kelas 7A sedang mengikuti ujian berbasis komputer.' },
      { key: 'B', text: 'Walaupun hujan deras, tetapi peserta ujian tetap datang tepat waktu.' },
      { key: 'C', text: 'Ibu Kepala Sekolah menghadiri rapat koordinasi panitia di aula.' },
      { key: 'D', text: 'Di ruang ujian, peserta dilarang membawa telpon genggam.' },
    ],
    correctAnswer: 'C',
    points: 50,
    orderIndex: 1,
  },
  {
    id: 'q-bindo-02',
    subject: 'Bahasa Indonesia',
    targetClasses: ALL_CLASSES,
    questionText:
      'Paragraf yang kalimat utamanya berada di awal paragraf dan diikuti oleh kalimat-kalimat penjelas disebut paragraf...',
    options: [
      { key: 'A', text: 'Induktif' },
      { key: 'B', text: 'Campuran' },
      { key: 'C', text: 'Deduktif' },
      { key: 'D', text: 'Ineratif' },
    ],
    correctAnswer: 'C',
    points: 50,
    orderIndex: 2,
  },
];

export const SEED_EXAM_RESULTS: ExamResult[] = [
  {
    id: 'res-2026-7A-002-mat',
    participantId: 'ptc-7a-002',
    participantNumber: '2026-7A-002',
    studentName: 'Bima Sakti Pradana',
    className: '7A',
    examId: 'exam-pas-matematika-2026',
    examTitle: 'Penilaian Akhir Semester — Matematika',
    subject: 'Matematika',
    answers: {
      'q-mat-7-01': 'B',
      'q-mat-7-02': 'B',
      'q-mat-7-03': 'B',
      'q-mat-7-04': 'C',
    },
    flaggedQuestions: [],
    correctCount: 4,
    totalQuestions: 4,
    score: 100,
    tabSwitchCount: 0,
    status: 'submitted',
    startedAt: '2026-11-15T07:30:00.000Z',
    submittedAt: '2026-11-15T08:05:12.000Z',
    syncStatus: 'synced',
  },
  {
    id: 'res-2026-8A-002-ipa',
    participantId: 'ptc-8a-002',
    participantNumber: '2026-8A-002',
    studentName: 'Clarissa Melati Putri',
    className: '8A',
    examId: 'exam-pas-ipa-2026',
    examTitle: 'Penilaian Akhir Semester — Ilmu Pengetahuan Alam',
    subject: 'Ilmu Pengetahuan Alam',
    answers: {
      'q-ipa-01': 'C',
      'q-ipa-02': 'B',
      'q-ipa-03': 'A',
    },
    flaggedQuestions: [],
    correctCount: 2,
    totalQuestions: 3,
    score: 67,
    tabSwitchCount: 0,
    status: 'submitted',
    startedAt: '2026-11-15T07:32:00.000Z',
    submittedAt: '2026-11-15T08:11:44.000Z',
    syncStatus: 'synced',
  },
  {
    id: 'res-2026-9A-002-mat',
    participantId: 'ptc-9a-002',
    participantNumber: '2026-9A-002',
    studentName: 'Farhan Syahputra',
    className: '9A',
    examId: 'exam-pas-matematika-2026',
    examTitle: 'Penilaian Akhir Semester — Matematika',
    subject: 'Matematika',
    answers: {
      'q-mat-9-01': 'C',
    },
    flaggedQuestions: ['q-mat-9-01'],
    correctCount: 0,
    totalQuestions: 2,
    score: 0,
    tabSwitchCount: 1,
    status: 'in_progress',
    startedAt: '2026-11-15T08:45:00.000Z',
    submittedAt: null,
    syncStatus: 'synced',
  },
];
