import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  BookOpen,
  Check,
  CheckCircle2,
  Cloud,
  Copy,
  Database,
  Download,
  Eye,
  EyeOff,
  FileCode2,
  HardDrive,
  KeyRound,
  ListChecks,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Upload,
  Wifi,
  WifiOff,
  XCircle,
} from 'lucide-react';
import {
  DEFAULT_SUPABASE_ANON_KEY,
  DEFAULT_SUPABASE_URL,
  SUPABASE_SCHEMA_SQL,
  clearRuntimeServiceRoleKey,
  decodeJwtPayload,
  extractProjectRef,
  getSupabaseConfig,
  getSupabaseConfigSource,
  isLiveSupabaseConfigured,
  resetSupabaseConfig,
  saveSupabaseConfig,
  validateServiceRoleKey,
} from '@/src/lib/supabase';
import {
  type SyncOperationReport,
  type SyncTableStats,
  exportLocalBackupSnapshot,
  flushPendingQueueDetailed,
  getSyncDiagnostics,
  pullAllFromSupabaseDetailed,
  pushAllToSupabase,
  resetDemoDatabase,
  restoreLocalBackupSnapshot,
  runTwoWaySync,
  testSupabaseConnection,
} from '@/src/lib/dataStore';
import { clearPersistedValue, usePersistedState } from '@/src/lib/usePersistedState';

interface AdminDatabaseTabProps {
  onDatabaseChanged: () => Promise<void>;
}

type DatabaseSubTab = 'credentials' | 'guide' | 'sync' | 'sql';

const GUIDE_CHECKLIST_KEY = 'cbt_supabase_setup_checklist_v1';

interface GuideStep {
  id: string;
  stepNumber: number;
  title: string;
  subtitle: string;
  estimatedTime: string;
  instructions: string[];
  note?: string;
  actionType?: 'goto-credentials' | 'copy-sql' | 'goto-sync' | 'copy-env';
  actionLabel?: string;
}

const SETUP_GUIDE_STEPS: GuideStep[] = [
  {
    id: 'step_project',
    stepNumber: 1,
    title: 'Buat Project Supabase Baru',
    subtitle: 'Menyiapkan instance PostgreSQL cloud & endpoint API',
    estimatedTime: '2 menit',
    instructions: [
      'Buka dashboard https://supabase.com/dashboard dan login dengan akun GitHub atau Google sekolah/panitia.',
      'Klik tombol "New Project", pilih Organization yang aktif, lalu isi Name (misalnya: nusantara-cbt-2026).',
      'Buat Database Password yang kuat dan simpan di pengelola kata sandi (password ini dipakai jika akses PostgreSQL langsung).',
      'Pilih Region terdekat, disarankan "Southeast Asia (Singapore / ap-southeast-1)" agar latensi siswa saat ujian serentak minimal.',
      'Klik "Create new project" dan tunggu ±1–2 menit hingga status project berubah menjadi Active.',
    ],
    note: 'Satu project Free Tier Supabase sudah mendukung ratusan ribu request REST/RPC dan Realtime WebSocket untuk ujian sekolah.',
  },
  {
    id: 'step_keys',
    stepNumber: 2,
    title: 'Salin & Masukkan Parameter Kredensial API',
    subtitle: 'Menghubungkan aplikasi CBT dengan Project URL & API Key',
    estimatedTime: '1 menit',
    instructions: [
      'Di dashboard Supabase project Anda, buka menu kiri "Project Settings" (ikon gerigi) → pilih "Data API" atau "API Keys".',
      'Salin nilai "Project URL" (format: https://xxxxxxxxxxxx.supabase.co) dan tempel ke kolom Supabase Project URL pada tab Parameter Kredensial API.',
      'Salin nilai "anon / public key" (JWT dimulai dengan eyJ... atau sb_publishable_...) dan tempel ke kolom Anon / Public Key.',
      '(Opsional untuk Admin) Jika ingin Admin dapat menarik ulang Bank Soal terproteksi RLS dari cloud ke browser baru, salin juga "service_role key". Jangan bagikan key ini ke siswa.',
      'Klik tombol "Simpan & Hubungkan" untuk menyimpan konfigurasi API secara lokal pada sesi browser ini.',
    ],
    note: 'Aplikasi otomatis mengekstrak Project Ref ID serta mendekode token JWT untuk memverifikasi peran (anon/service_role) dan masa berlaku key.',
    actionType: 'goto-credentials',
    actionLabel: 'Buka Parameter Kredensial API',
  },
  {
    id: 'step_sql',
    stepNumber: 3,
    title: 'Eksekusi Skrip SQL Skema Tabel & Keamanan RLS',
    subtitle: 'Membuat 6 tabel utama (termasuk staff_accounts), indeks performa, dan fungsi RPC anti-Inspect Element',
    estimatedTime: '1 menit',
    instructions: [
      'Klik tombol "Salin Skrip SQL" di bawah ini atau buka tab "Skema SQL & RLS".',
      'Di dashboard Supabase, buka menu kiri "SQL Editor" → klik "+ New query".',
      'Tempel (Paste) seluruh skrip SQL ke editor, lalu klik tombol "Run" (atau tekan Ctrl+Enter / Cmd+Enter).',
      'Pastikan hasil eksekusi menampilkan status "Success. No rows returned" tanpa pesan error merah.',
      'Skrip ini otomatis membuat tabel school_profile, staff_accounts, participants, exam_schedules, questions, dan exam_results, sekaligus memblokir SELECT langsung tabel questions dari role anon agar kunci jawaban aman dari Inspect Element.',
    ],
    note: 'Aman dijalankan ulang (idempoten): semua CREATE TABLE menggunakan IF NOT EXISTS dan policy menggunakan DROP POLICY IF EXISTS.',
    actionType: 'copy-sql',
    actionLabel: 'Salin Skrip SQL Sekarang',
  },
  {
    id: 'step_realtime',
    stepNumber: 4,
    title: 'Aktifkan Realtime Replication untuk Monitoring Live',
    subtitle: 'Pembaruan otomatis progres, skor, & sinkronisasi role/akses antar perangkat',
    estimatedTime: '1 menit',
    instructions: [
      'Di dashboard Supabase, buka menu kiri "Database" → pilih "Publications" (atau "Replication").',
      'Klik publication bernama "supabase_realtime".',
      'Aktifkan toggle (ON) untuk tabel "exam_results" agar dashboard pengawas menerima event INSERT/UPDATE seketika saat siswa menjawab atau berpindah tab.',
      '(Disarankan) Aktifkan juga toggle untuk "exam_schedules", "participants", "school_profile", dan "staff_accounts" agar perubahan role, sandi, dan jadwal langsung tersinkron ke semua perangkat.',
      'Pastikan opsi "Aktifkan Realtime WebSocket" pada Parameter Kredensial API dalam kondisi aktif.',
    ],
  },
  {
    id: 'step_sync',
    stepNumber: 5,
    title: 'Uji Koneksi & Push Data Awal ke Cloud',
    subtitle: 'Verifikasi tabel aktif dan unggah data master 27 kelas ke PostgreSQL',
    estimatedTime: '1 menit',
    instructions: [
      'Buka tab "Parameter Kredensial API" lalu klik tombol "Tes Koneksi" dan pastikan status berwarna hijau: "Terhubung langsung ke PostgreSQL Supabase & tabel aktif."',
      'Selanjutnya buka tab "Operasi Sinkronisasi Data" dan klik "Cek Status Cloud & Lokal" untuk melihat perbandingan jumlah baris per tabel.',
      'Jika database cloud masih kosong (0 baris), klik "Push Semua Data Lokal → Cloud" untuk mengunggah profil sekolah, data peserta 27 kelas, jadwal mapel, dan bank soal ke Supabase.',
      'Uji login menggunakan salah satu nomor peserta siswa di halaman depan untuk memastikan soal termuat via RPC aman.',
    ],
    actionType: 'goto-sync',
    actionLabel: 'Buka Operasi Sinkronisasi Data',
  },
  {
    id: 'step_prod',
    stepNumber: 6,
    title: 'Tanamkan Kredensial Permanen untuk Perangkat Siswa',
    subtitle: 'Agar seluruh HP/laptop siswa otomatis tersambung tanpa pengaturan manual',
    estimatedTime: '2 menit',
    instructions: [
      'Pengaturan pada browser Admin hanya tersimpan di browser Admin (localStorage). Agar perangkat siswa otomatis terhubung saat membuka URL ujian, tanamkan kredensial pada level build/hosting.',
      'Salin snippet Environment Variables (.env) dari tab Parameter Kredensial API (VITE_SUPABASE_URL dan VITE_SUPABASE_ANON_KEY).',
      'Tempelkan ke pengaturan Environment Variables platform hosting Anda (Vercel / Netlify / Cloud Run / Docker) atau file .env sebelum menjalankan "npm run build".',
      'Alternatif tanpa .env: perbarui konstanta DEFAULT_SUPABASE_URL dan DEFAULT_SUPABASE_ANON_KEY di file src/lib/supabase.ts lalu build ulang aplikasi.',
    ],
    note: 'Jangan pernah menanamkan Service Role Key di variabel VITE_* atau kode client produksi agar tidak terekspos ke publik.',
    actionType: 'copy-env',
    actionLabel: 'Salin Template .env',
  },
];

export const AdminDatabaseTab: React.FC<AdminDatabaseTabProps> = ({
  onDatabaseChanged,
}) => {
  const initialConfig = getSupabaseConfig();

  const [subTab, setSubTab] = usePersistedState<DatabaseSubTab>(
    'cbt_db_active_subtab_v1',
    'credentials'
  );

  // API Credential Parameters state (drafts survive refresh)
  const [url, setUrl] = usePersistedState('cbt_draft_db_url_v1', () => initialConfig.url);
  const [anonKey, setAnonKey] = usePersistedState(
    'cbt_draft_db_anon_v1',
    () => initialConfig.anonKey
  );
  // Service Role Key is strictly kept in memory (never written to localStorage)
  const [serviceRoleKey, setServiceRoleKey] = useState(
    () => initialConfig.serviceRoleKey || ''
  );
  const [schema, setSchema] = usePersistedState(
    'cbt_draft_db_schema_v1',
    () => initialConfig.schema || 'public'
  );
  const [autoSyncIntervalSec, setAutoSyncIntervalSec] = usePersistedState<number>(
    'cbt_draft_db_interval_v1',
    () => initialConfig.autoSyncIntervalSec || 25
  );
  const [enableRealtime, setEnableRealtime] = usePersistedState<boolean>(
    'cbt_draft_db_realtime_v1',
    () => initialConfig.enableRealtime ?? true
  );

  const [showAnonKey, setShowAnonKey] = useState(false);
  const [showServiceKey, setShowServiceKey] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [statusOk, setStatusOk] = useState<boolean | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Step-by-step guide checklist state
  const [completedSteps, setCompletedSteps] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(GUIDE_CHECKLIST_KEY);
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });

  // Sync operations state
  const [diagnostics, setDiagnostics] = useState<{
    tables: SyncTableStats[];
    pendingResultsCount: number;
    lastSyncAt: string | null;
  } | null>(null);
  const [isLoadingDiag, setIsLoadingDiag] = useState(false);
  const [activeSyncOp, setActiveSyncOp] = useState<string | null>(null);
  const [syncLogs, setSyncLogs] = useState<SyncOperationReport[]>([]);
  const [confirmResetSeed, setConfirmResetSeed] = useState(false);
  const [backupFeedback, setBackupFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const restoreInputRef = useRef<HTMLInputElement | null>(null);

  const liveConfigured = isLiveSupabaseConfigured();
  const configSource = getSupabaseConfigSource();

  const projectRef = useMemo(() => extractProjectRef(url), [url]);
  const anonJwtInfo = useMemo(() => decodeJwtPayload(anonKey), [anonKey]);
  const serviceValidation = useMemo(
    () => validateServiceRoleKey(serviceRoleKey, url),
    [serviceRoleKey, url]
  );

  const derivedEndpoints = useMemo(() => {
    const cleanUrl = url.trim().replace(/\/+$/, '');
    const wssBase = cleanUrl.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
    return {
      rest: cleanUrl ? `${cleanUrl}/rest/v1` : '-',
      rpc: cleanUrl ? `${cleanUrl}/rest/v1/rpc` : '-',
      realtime: wssBase ? `${wssBase}/realtime/v1` : '-',
    };
  }, [url]);

  const envSnippet = useMemo(
    () =>
      `VITE_SUPABASE_URL="${url.trim()}"\nVITE_SUPABASE_ANON_KEY="${anonKey.trim()}"`,
    [url, anonKey]
  );

  const refreshDiagnostics = useCallback(async () => {
    setIsLoadingDiag(true);
    try {
      const diag = await getSyncDiagnostics();
      setDiagnostics(diag);
    } finally {
      setIsLoadingDiag(false);
    }
  }, []);

  useEffect(() => {
    void refreshDiagnostics();
  }, [refreshDiagnostics]);

  useEffect(() => {
    try {
      localStorage.setItem(GUIDE_CHECKLIST_KEY, JSON.stringify(completedSteps));
    } catch {
      // Ignore storage error
    }
  }, [completedSteps]);

  const copyText = async (fieldId: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedField(fieldId);
    window.setTimeout(() => {
      setCopiedField((prev) => (prev === fieldId ? null : prev));
    }, 2200);
  };

  const clearDbDrafts = () => {
    clearPersistedValue('cbt_draft_db_url_v1');
    clearPersistedValue('cbt_draft_db_anon_v1');
    clearPersistedValue('cbt_draft_db_service_v1');
    clearPersistedValue('cbt_draft_db_schema_v1');
    clearPersistedValue('cbt_draft_db_interval_v1');
    clearPersistedValue('cbt_draft_db_realtime_v1');
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!serviceRoleKey.trim()) {
      clearRuntimeServiceRoleKey();
    }
    saveSupabaseConfig(url, anonKey, {
      serviceRoleKey,
      schema,
      autoSyncIntervalSec,
      enableRealtime,
    });
    clearDbDrafts();
    setIsTesting(true);
    const res = await testSupabaseConnection();
    setStatusMsg(res.message);
    setStatusOk(res.ok);
    if (res.ok) {
      await pullAllFromSupabaseDetailed();
    }
    setIsTesting(false);
    await refreshDiagnostics();
    await onDatabaseChanged();
  };

  const handleResetDefault = async () => {
    clearRuntimeServiceRoleKey();
    resetSupabaseConfig();
    clearDbDrafts();
    setUrl(DEFAULT_SUPABASE_URL);
    setAnonKey(DEFAULT_SUPABASE_ANON_KEY);
    setServiceRoleKey('');
    setSchema('public');
    setAutoSyncIntervalSec(25);
    setEnableRealtime(true);
    setStatusMsg('Kredensial dikembalikan ke konfigurasi default tertanam dalam kode.');
    setStatusOk(null);
    await refreshDiagnostics();
    await onDatabaseChanged();
  };

  const handleTest = async () => {
    if (!serviceRoleKey.trim()) {
      clearRuntimeServiceRoleKey();
    }
    saveSupabaseConfig(url, anonKey, {
      serviceRoleKey,
      schema,
      autoSyncIntervalSec,
      enableRealtime,
    });
    setIsTesting(true);
    const res = await testSupabaseConnection();
    setStatusMsg(res.message);
    setStatusOk(res.ok);
    if (res.ok && serviceRoleKey.trim()) {
      await pullAllFromSupabaseDetailed();
    }
    setIsTesting(false);
    await refreshDiagnostics();
    await onDatabaseChanged();
  };

  const appendSyncLog = (report: SyncOperationReport) => {
    setSyncLogs((prev) => [report, ...prev].slice(0, 12));
  };

  const handleRunSyncOp = async (
    opKey: 'two-way' | 'push' | 'pull' | 'flush'
  ) => {
    setActiveSyncOp(opKey);
    setBackupFeedback(null);
    try {
      let report: SyncOperationReport;
      if (opKey === 'two-way') {
        report = await runTwoWaySync();
      } else if (opKey === 'push') {
        report = await pushAllToSupabase();
      } else if (opKey === 'pull') {
        report = await pullAllFromSupabaseDetailed();
      } else {
        report = await flushPendingQueueDetailed();
      }
      appendSyncLog(report);
      await refreshDiagnostics();
      await onDatabaseChanged();
    } finally {
      setActiveSyncOp(null);
    }
  };

  const handleExportJsonBackup = async () => {
    const snapshot = await exportLocalBackupSnapshot();
    const json = JSON.stringify(snapshot, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = `nusantara-cbt-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(downloadUrl);
    setBackupFeedback({
      ok: true,
      text: `Backup JSON berhasil diunduh (${snapshot.participants.length} peserta, ${snapshot.questions.length} soal, ${snapshot.results.length} hasil).`,
    });
  };

  const handleRestoreJsonBackup = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const res = await restoreLocalBackupSnapshot(parsed);
      setBackupFeedback({ ok: res.ok, text: res.message });
      if (res.ok) {
        await refreshDiagnostics();
        await onDatabaseChanged();
      }
    } catch {
      setBackupFeedback({
        ok: false,
        text: 'Gagal membaca file JSON. Pastikan file berasal dari ekspor backup Nusantara CBT.',
      });
    }
  };

  const handleResetSeed = async () => {
    await resetDemoDatabase();
    setConfirmResetSeed(false);
    setBackupFeedback({
      ok: true,
      text: 'Cache lokal IndexedDB telah dikosongkan dan direset ke kondisi bersih.',
    });
    await refreshDiagnostics();
    await onDatabaseChanged();
  };

  const handleDownloadSqlFile = () => {
    const blob = new Blob([SUPABASE_SCHEMA_SQL], { type: 'text/sql;charset=utf-8' });
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = 'nusantara-cbt-supabase-schema-rls.sql';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(downloadUrl);
  };

  const toggleGuideStep = (id: string) => {
    setCompletedSteps((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const guideProgressCount = SETUP_GUIDE_STEPS.filter((s) => completedSteps[s.id]).length;

  const sourceLabel =
    configSource === 'runtime'
      ? 'Runtime Browser (Admin Override)'
      : configSource === 'env'
      ? 'Environment (.env)'
      : 'Default Tertanam (Kode)';

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Page Header & Live Status Strip */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 tracking-tight">
            Database, Kredensial API &amp; SQL
          </h1>
          <p className="text-sm text-slate-600 mt-0.5">
            Kelola parameter kredensial API Supabase, ikuti panduan konfigurasi step-by-step, dan jalankan sinkronisasi data cloud–lokal.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-semibold ${
              liveConfigured
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-amber-50 border-amber-200 text-amber-900'
            }`}
          >
            {liveConfigured ? (
              <Wifi className="w-3.5 h-3.5 text-emerald-700" />
            ) : (
              <WifiOff className="w-3.5 h-3.5 text-amber-700" />
            )}
            <span>{liveConfigured ? 'Supabase Cloud Aktif' : 'Mode Local-First'}</span>
          </span>

          {diagnostics && diagnostics.pendingResultsCount > 0 && (
            <button
              type="button"
              onClick={() => setSubTab('sync')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-900 text-xs font-semibold cursor-pointer"
            >
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>{diagnostics.pendingResultsCount} Antrean Pending</span>
            </button>
          )}
        </div>
      </div>

      {/* Sub-navigation Tabs */}
      <div className="bg-white rounded-2xl border border-slate-200 p-1.5 grid grid-cols-2 lg:grid-cols-4 gap-1.5">
        {(
          [
            {
              key: 'credentials',
              label: 'Parameter Kredensial API',
              icon: KeyRound,
            },
            {
              key: 'guide',
              label: `Panduan Step-by-Step (${guideProgressCount}/${SETUP_GUIDE_STEPS.length})`,
              icon: ListChecks,
            },
            {
              key: 'sync',
              label: 'Operasi Sinkronisasi Data',
              icon: ArrowLeftRight,
            },
            {
              key: 'sql',
              label: 'Skema SQL & RLS',
              icon: FileCode2,
            },
          ] as const
        ).map((tab) => {
          const Icon = tab.icon;
          const active = subTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setSubTab(tab.key)}
              className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-colors cursor-pointer ${
                active
                  ? 'bg-[#064e3b] text-white shadow-xs'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span className="truncate">{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* ===================================================================== */}
      {/* TAB 1: PARAMETER KREDENSIAL API                                       */}
      {/* ===================================================================== */}
      {subTab === 'credentials' && (
        <div className="space-y-6">
          {/* Quick Parameter Overview Strip */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Sumber Konfigurasi Aktif
              </div>
              <div className="text-sm font-bold text-slate-900 mt-1">{sourceLabel}</div>
              <div className="text-xs text-slate-500 mt-0.5">
                Prioritas: Runtime Browser → .env → Default Kode
              </div>
            </div>

            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Project Reference ID
              </div>
              <div className="font-mono text-sm font-bold text-emerald-900 mt-1 truncate">
                {projectRef || 'Belum terdeteksi'}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                Diekstrak otomatis dari Project URL
              </div>
            </div>

            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Validasi Token Anon Key
              </div>
              <div className="text-sm font-bold mt-1 flex items-center gap-1.5">
                {anonJwtInfo.valid ? (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
                    <span className="text-emerald-900">
                      Valid ({anonJwtInfo.role || 'JWT'})
                    </span>
                  </>
                ) : (
                  <>
                    <XCircle className="w-4 h-4 text-rose-600 shrink-0" />
                    <span className="text-rose-700">Format token tidak valid</span>
                  </>
                )}
              </div>
              <div className="text-xs text-slate-500 mt-0.5 truncate">
                {anonJwtInfo.ref
                  ? `Ref token: ${anonJwtInfo.ref}${
                      projectRef && anonJwtInfo.ref !== projectRef ? ' (tidak cocok URL!)' : ''
                    }`
                  : 'Masukkan anon public key Supabase'}
              </div>
            </div>
          </div>

          {/* Main Credentials Form */}
          <form
            onSubmit={handleSaveConfig}
            className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 space-y-5"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2 font-display font-bold text-slate-900">
                <Database className="w-4 h-4 text-emerald-700" />
                <span>Parameter Kredensial API Supabase</span>
              </div>
              <span
                className={`text-xs font-semibold ${
                  liveConfigured ? 'text-emerald-700' : 'text-amber-700'
                }`}
              >
                {liveConfigured
                  ? 'Terhubung ke Project Supabase Live'
                  : 'Mode Local-First (Konfigurasi Default Tertanam)'}
              </span>
            </div>

            <div className="space-y-4">
              {/* Project URL */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-semibold text-slate-700">
                    1. Supabase Project URL (<code className="font-mono">VITE_SUPABASE_URL</code>)
                  </label>
                  <button
                    type="button"
                    onClick={() => void copyText('url', url)}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-800 hover:text-emerald-950 cursor-pointer"
                  >
                    {copiedField === 'url' ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    <span>{copiedField === 'url' ? 'Tersalin' : 'Salin URL'}</span>
                  </button>
                </div>
                <input
                  type="url"
                  required
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://xxxxxxxxxxxx.supabase.co"
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 font-mono text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
                />
                <p className="text-[11px] text-slate-500 mt-1">
                  Diambil dari Supabase Dashboard → Project Settings → Data API → Project URL.
                </p>
              </div>

              {/* Anon Public Key */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-semibold text-slate-700">
                    2. Supabase Anon / Public Key (<code className="font-mono">VITE_SUPABASE_ANON_KEY</code>)
                  </label>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setShowAnonKey((v) => !v)}
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
                    >
                      {showAnonKey ? (
                        <EyeOff className="w-3.5 h-3.5" />
                      ) : (
                        <Eye className="w-3.5 h-3.5" />
                      )}
                      <span>{showAnonKey ? 'Sembunyikan' : 'Tampilkan'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void copyText('anon', anonKey)}
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-800 hover:text-emerald-950 cursor-pointer"
                    >
                      {copiedField === 'anon' ? (
                        <Check className="w-3.5 h-3.5" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                      <span>{copiedField === 'anon' ? 'Tersalin' : 'Salin Key'}</span>
                    </button>
                  </div>
                </div>
                {showAnonKey ? (
                  <textarea
                    required
                    rows={3}
                    value={anonKey}
                    onChange={(e) => setAnonKey(e.target.value)}
                    placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                    className="w-full px-3.5 py-2 rounded-xl border border-slate-300 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-emerald-700"
                  />
                ) : (
                  <input
                    type="password"
                    required
                    value={anonKey}
                    onChange={(e) => setAnonKey(e.target.value)}
                    placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                    className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 font-mono text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
                  />
                )}
                <div className="flex flex-wrap items-center justify-between gap-2 mt-1 text-[11px] text-slate-500">
                  <span>
                    Aman untuk client siswa karena dilindungi kebijakan RLS &amp; fungsi RPC SECURITY DEFINER.
                  </span>
                  {anonJwtInfo.expIso && (
                    <span className="font-mono">
                      Exp: {new Date(anonJwtInfo.expIso).toLocaleDateString('id-ID')}
                      {anonJwtInfo.expired ? ' (Kedaluwarsa!)' : ''}
                    </span>
                  )}
                </div>
              </div>

              {/* Service Role Key (Optional for Admin Full Sync) */}
              <div className="p-4 rounded-xl bg-amber-50/70 border border-amber-200 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs font-bold text-amber-950 flex items-center gap-1.5">
                    <ShieldAlert className="w-4 h-4 text-amber-700" />
                    <span>3. Service Role / Admin Secret Key (Opsional — Hanya Browser Admin)</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => setShowServiceKey((v) => !v)}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-900 hover:text-amber-950 cursor-pointer"
                  >
                    {showServiceKey ? (
                      <EyeOff className="w-3.5 h-3.5" />
                    ) : (
                      <Eye className="w-3.5 h-3.5" />
                    )}
                    <span>{showServiceKey ? 'Sembunyikan' : 'Tampilkan'}</span>
                  </button>
                </div>

                <input
                  type={showServiceKey ? 'text' : 'password'}
                  value={serviceRoleKey}
                  onChange={(e) => setServiceRoleKey(e.target.value)}
                  placeholder="Kosongkan jika tidak diperlukan (opsional: eyJ... role service_role)"
                  className="w-full px-3.5 py-2 rounded-xl border border-amber-300 bg-white font-mono text-xs focus:outline-none focus:ring-2 focus:ring-amber-600"
                />

                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-amber-900/90">
                  <span>
                    Disimpan <strong>hanya di memori sesi browser Admin (tidak ditulis ke localStorage)</strong> untuk mengecek jumlah baris &amp; menarik ulang Bank Soal (tabel{' '}
                    <code className="font-mono">questions</code>) yang diblokir dari role <code className="font-mono">anon</code>. Jangan masukkan key ini ke file <code className="font-mono">.env</code> client siswa.
                  </span>
                  {serviceValidation.hasKey && (
                    <span
                      className={`font-mono font-semibold ${
                        serviceValidation.valid ? 'text-emerald-800' : 'text-rose-700'
                      }`}
                    >
                      {serviceValidation.valid
                        ? `Valid (${serviceValidation.role || 'service_role'})`
                        : serviceValidation.role
                        ? `Salah role: ${serviceValidation.role}`
                        : 'Format Service Key tidak valid'}
                    </span>
                  )}
                </div>
                {serviceValidation.hasKey && !serviceValidation.valid && serviceValidation.reason && (
                  <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-900 font-medium">
                    {serviceValidation.reason}
                  </div>
                )}
                {serviceValidation.valid && serviceValidation.isSecretFormat && (
                  <div className="p-2.5 rounded-lg bg-amber-100/80 border border-amber-300 text-[11px] text-amber-950">
                    Catatan: Supabase Cloud sering memblokir key format <code className="font-mono">sb_secret_...</code> jika dipanggil langsung dari browser. Jika muncul error izin, gunakan Legacy <code className="font-mono">service_role</code> JWT (diawali <code className="font-mono">eyJ...</code>) dari tab <strong>Legacy anon, service_role API keys</strong> di Supabase.
                  </div>
                )}
              </div>

              {/* Technical API & Sync Parameters */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    4. Skema Database PostgreSQL
                  </label>
                  <input
                    type="text"
                    value={schema}
                    onChange={(e) => setSchema(e.target.value)}
                    placeholder="public"
                    className="w-full px-3.5 py-2 rounded-xl border border-slate-300 font-mono text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    5. Interval Auto-Sync Antrean (Detik)
                  </label>
                  <input
                    type="number"
                    min={5}
                    max={120}
                    value={autoSyncIntervalSec}
                    onChange={(e) => setAutoSyncIntervalSec(Math.max(5, Number(e.target.value) || 25))}
                    className="w-full px-3.5 py-2 rounded-xl border border-slate-300 font-mono text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
                  />
                </div>

                <div className="flex flex-col justify-end">
                  <label className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl border border-slate-300 bg-slate-50 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={enableRealtime}
                      onChange={(e) => setEnableRealtime(e.target.checked)}
                      className="w-4 h-4 accent-[#064e3b]"
                    />
                    <span className="text-xs font-semibold text-slate-800">
                      Realtime WebSocket Live
                    </span>
                  </label>
                </div>
              </div>
            </div>

            {statusMsg && (
              <div
                className={`p-3.5 rounded-xl border text-sm ${
                  statusOk === true
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                    : statusOk === false
                    ? 'bg-rose-50 border-rose-200 text-rose-900'
                    : 'bg-slate-50 border-slate-200 text-slate-800'
                }`}
              >
                {statusMsg}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={handleResetDefault}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-50 text-xs font-semibold cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset ke Default Kode</span>
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={isTesting}
                  onClick={handleTest}
                  className="px-4 py-2 rounded-xl border border-emerald-700 text-emerald-900 hover:bg-emerald-50 text-xs sm:text-sm font-semibold cursor-pointer disabled:opacity-60"
                >
                  {isTesting ? 'Menguji...' : 'Tes Koneksi'}
                </button>
                <button
                  type="submit"
                  disabled={isTesting}
                  className="px-5 py-2 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white text-xs sm:text-sm font-semibold cursor-pointer disabled:opacity-60"
                >
                  Simpan &amp; Hubungkan
                </button>
              </div>
            </div>
          </form>

          {/* Derived API Endpoints & .env Production Snippet */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
              <div className="font-display font-bold text-sm text-slate-900 flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-emerald-700" />
                <span>Endpoint API Turunan Otomatis</span>
              </div>
              <div className="space-y-2.5 text-xs">
                {[
                  { id: 'ep_rest', label: 'PostgREST API v1', val: derivedEndpoints.rest },
                  { id: 'ep_rpc', label: 'RPC Security Definer', val: derivedEndpoints.rpc },
                  { id: 'ep_ws', label: 'Realtime WebSocket', val: derivedEndpoints.realtime },
                ].map((ep) => (
                  <div
                    key={ep.id}
                    className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold text-slate-500">{ep.label}</div>
                      <div className="font-mono text-xs text-slate-900 truncate">{ep.val}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void copyText(ep.id, ep.val)}
                      className="p-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 text-slate-600 cursor-pointer shrink-0"
                      title="Salin endpoint"
                    >
                      {copiedField === ep.id ? (
                        <Check className="w-3.5 h-3.5 text-emerald-700" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3 flex flex-col justify-between">
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-display font-bold text-sm text-slate-900">
                    Template Environment Variables (<code className="font-mono text-xs">.env</code>)
                  </div>
                  <button
                    type="button"
                    onClick={() => void copyText('env', envSnippet)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold cursor-pointer"
                  >
                    {copiedField === 'env' ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    <span>{copiedField === 'env' ? 'Tersalin' : 'Salin .env'}</span>
                  </button>
                </div>
                <p className="text-xs text-slate-600">
                  Tempelkan variabel berikut pada pengaturan environment hosting produksi agar seluruh browser siswa langsung terhubung otomatis tanpa mengisi form ini.
                </p>
                <pre className="p-3.5 rounded-xl bg-slate-950 text-emerald-100 font-mono text-[11px] overflow-x-auto leading-relaxed">
                  {envSnippet}
                </pre>
              </div>
              <div className="text-[11px] text-slate-500">
                Catatan: File default fallback kode berada di{' '}
                <code className="font-mono bg-slate-100 px-1 py-0.5 rounded">src/lib/supabase.ts</code>.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 2: PETUNJUK TAHAPAN KONFIGURASI STEP-BY-STEP                      */}
      {/* ===================================================================== */}
      {subTab === 'guide' && (
        <div className="space-y-5">
          {/* Progress Summary Card */}
          <div className="bg-white rounded-2xl border border-slate-200 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2 font-display font-bold text-slate-900">
                <BookOpen className="w-4 h-4 text-emerald-700" />
                <span>Panduan Konfigurasi Cloud Supabase Step-by-Step</span>
              </div>
              <p className="text-xs text-slate-600">
                Ikuti 6 tahapan berurutan berikut untuk mengaktifkan database PostgreSQL, keamanan RLS anti-Inspect Element, dan sinkronisasi live multi-perangkat.
              </p>
            </div>

            <div className="shrink-0 flex items-center gap-3">
              <div className="text-right">
                <div className="font-mono text-lg font-bold text-emerald-800 tabular-nums">
                  {guideProgressCount}/{SETUP_GUIDE_STEPS.length}
                </div>
                <div className="text-[11px] text-slate-500">Tahap Selesai</div>
              </div>
              <div className="w-24 h-2.5 rounded-full bg-slate-100 overflow-hidden border border-slate-200">
                <div
                  className="h-full bg-[#064e3b] transition-all duration-300"
                  style={{
                    width: `${Math.round((guideProgressCount / SETUP_GUIDE_STEPS.length) * 100)}%`,
                  }}
                />
              </div>
            </div>
          </div>

          {/* 6 Detailed Step Cards */}
          <div className="space-y-4">
            {SETUP_GUIDE_STEPS.map((step) => {
              const checked = Boolean(completedSteps[step.id]);
              return (
                <div
                  key={step.id}
                  className={`bg-white rounded-2xl border transition-colors p-5 space-y-3 ${
                    checked ? 'border-emerald-300 bg-emerald-50/20' : 'border-slate-200'
                  }`}
                >
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <button
                        type="button"
                        onClick={() => toggleGuideStep(step.id)}
                        className={`mt-0.5 w-8 h-8 rounded-xl font-mono text-sm font-bold flex items-center justify-center shrink-0 border transition-colors cursor-pointer ${
                          checked
                            ? 'bg-[#064e3b] border-[#064e3b] text-white'
                            : 'bg-slate-50 border-slate-300 text-slate-700 hover:border-emerald-600'
                        }`}
                        title={checked ? 'Tandai belum selesai' : 'Tandai tahap selesai'}
                      >
                        {checked ? <Check className="w-4 h-4" /> : step.stepNumber}
                      </button>

                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-display font-bold text-base text-slate-900">
                            Tahap {step.stepNumber}: {step.title}
                          </h3>
                          <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 font-mono text-[11px] font-semibold">
                            ~{step.estimatedTime}
                          </span>
                        </div>
                        <p className="text-xs text-slate-600 mt-0.5">{step.subtitle}</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {step.actionType === 'goto-credentials' && (
                        <button
                          type="button"
                          onClick={() => setSubTab('credentials')}
                          className="px-3 py-1.5 rounded-xl bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-900 text-xs font-semibold cursor-pointer"
                        >
                          {step.actionLabel}
                        </button>
                      )}
                      {step.actionType === 'copy-sql' && (
                        <button
                          type="button"
                          onClick={() => void copyText('guide_sql', SUPABASE_SCHEMA_SQL)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold cursor-pointer"
                        >
                          {copiedField === 'guide_sql' ? (
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                          <span>
                            {copiedField === 'guide_sql' ? 'SQL Tersalin' : step.actionLabel}
                          </span>
                        </button>
                      )}
                      {step.actionType === 'goto-sync' && (
                        <button
                          type="button"
                          onClick={() => setSubTab('sync')}
                          className="px-3 py-1.5 rounded-xl bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-900 text-xs font-semibold cursor-pointer"
                        >
                          {step.actionLabel}
                        </button>
                      )}
                      {step.actionType === 'copy-env' && (
                        <button
                          type="button"
                          onClick={() => void copyText('guide_env', envSnippet)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold cursor-pointer"
                        >
                          {copiedField === 'guide_env' ? (
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                          <span>
                            {copiedField === 'guide_env' ? '.env Tersalin' : step.actionLabel}
                          </span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => toggleGuideStep(step.id)}
                        className={`px-3 py-1.5 rounded-xl border text-xs font-semibold cursor-pointer ${
                          checked
                            ? 'bg-emerald-100 border-emerald-300 text-emerald-900'
                            : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        {checked ? 'Selesai' : 'Tandai Selesai'}
                      </button>
                    </div>
                  </div>

                  <ol className="space-y-1.5 pl-11 list-decimal text-xs sm:text-sm text-slate-700 leading-relaxed">
                    {step.instructions.map((line, idx) => (
                      <li key={idx}>{line}</li>
                    ))}
                  </ol>

                  {step.note && (
                    <div className="ml-11 p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-600">
                      <strong className="text-slate-800">Catatan:</strong> {step.note}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Quick Troubleshooting Reference */}
          <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
            <h3 className="font-display font-bold text-sm text-slate-900">
              Panduan Pemecahan Masalah Umum (Troubleshooting)
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
                <div className="font-mono font-bold text-rose-800">
                  Error: permission denied for table ...
                </div>
                <p className="text-slate-600 leading-relaxed">
                  Pastikan perintah <code className="font-mono">GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role</code>, hak akses per tabel sesuai role (<code className="font-mono">REVOKE/GRANT</code>),{' '}
                  <code className="font-mono">GRANT EXECUTE</code> fungsi RPC aman, dan{' '}
                  <code className="font-mono">CREATE POLICY</code> pada Skrip SQL terbaru sudah dieksekusi seluruhnya di Supabase SQL Editor. Pastikan juga Service Role Key berisi token <code className="font-mono">service_role</code> (bukan <code className="font-mono">anon</code>).
                </p>
              </div>
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
                <div className="font-mono font-bold text-rose-800">
                  Error: relation &quot;public.school_profile&quot; does not exist
                </div>
                <p className="text-slate-600 leading-relaxed">
                  Tabel belum dibuat di schema <code className="font-mono">public</code>. Salin seluruh Skrip SQL di tab Skema SQL &amp; RLS dan klik Run di SQL Editor Supabase.
                </p>
              </div>
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
                <div className="font-mono font-bold text-amber-800">
                  Jumlah Bank Soal Cloud menampilkan &quot;Diproteksi RLS&quot;
                </div>
                <p className="text-slate-600 leading-relaxed">
                  Ini normal dan merupakan fitur keamanan agar kunci jawaban tidak bisa dibaca oleh siswa lewat Inspect Element. Jika Admin ingin memeriksa/menarik tabel <code className="font-mono">questions</code> dari cloud, masukkan Service Role Key sementara di Parameter Kredensial API.
                </p>
              </div>
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
                <div className="font-mono font-bold text-amber-800">
                  Data di HP siswa belum berubah setelah Admin edit jadwal
                </div>
                <p className="text-slate-600 leading-relaxed">
                  Jalankan <strong>Push Lokal → Cloud</strong> di tab Operasi Sinkronisasi Data, lalu pastikan perangkat siswa memakai URL &amp; Anon Key yang sama (tertanam di <code className="font-mono">.env</code> / <code className="font-mono">src/lib/supabase.ts</code>).
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 3: OPERASI SINKRONISASI DATA                                      */}
      {/* ===================================================================== */}
      {subTab === 'sync' && (
        <div className="space-y-6">
          {/* Inventory Comparison Table: Local IndexedDB vs Cloud Supabase */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 font-display font-bold text-slate-900">
                  <HardDrive className="w-4 h-4 text-emerald-700" />
                  <span>Inventaris Penyimpanan Lokal (IndexedDB) vs Cloud (Supabase)</span>
                </div>
                <p className="text-xs text-slate-600 mt-0.5">
                  Sinkronisasi terakhir:{' '}
                  <span className="font-mono font-semibold text-slate-800">
                    {diagnostics?.lastSyncAt
                      ? new Date(diagnostics.lastSyncAt).toLocaleString('id-ID')
                      : 'Belum pernah pada sesi ini'}
                  </span>
                </p>
              </div>

              <button
                type="button"
                disabled={isLoadingDiag}
                onClick={() => void refreshDiagnostics()}
                className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold cursor-pointer disabled:opacity-60 self-start sm:self-auto"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isLoadingDiag ? 'animate-spin' : ''}`} />
                <span>{isLoadingDiag ? 'Memeriksa...' : 'Cek Status Cloud & Lokal'}</span>
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                    <th className="py-3 px-4">Tabel / Entitas</th>
                    <th className="py-3 px-4 text-right">Data Lokal</th>
                    <th className="py-3 px-4 text-right">Data Cloud</th>
                    <th className="py-3 px-4">Status / Keterangan</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {(diagnostics?.tables || []).map((row) => {
                    const diff =
                      row.cloudCount !== null ? row.localCount - row.cloudCount : null;
                    return (
                      <tr key={row.table} className="hover:bg-slate-50/70">
                        <td className="py-3 px-4">
                          <div className="font-semibold text-slate-900">{row.label}</div>
                          <div className="font-mono text-[11px] text-slate-500">
                            {schema.trim() || 'public'}.{row.table}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-bold text-slate-900 tabular-nums">
                          {row.localCount}
                        </td>
                        <td className="py-3 px-4 text-right font-mono font-bold tabular-nums">
                          {row.cloudCount !== null ? (
                            <span className="text-emerald-800">{row.cloudCount}</span>
                          ) : (
                            <span className="text-slate-400">-</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-xs">
                          {row.note ? (
                            <span className="text-amber-800 font-medium">{row.note}</span>
                          ) : !liveConfigured ? (
                            <span className="text-slate-500">Mode lokal aktif</span>
                          ) : diff === 0 ? (
                            <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              Jumlah seimbang
                            </span>
                          ) : diff !== null ? (
                            <span className="text-amber-800 font-semibold">
                              Selisih {Math.abs(diff)} baris ({diff > 0 ? 'lebih banyak di lokal' : 'lebih banyak di cloud'})
                            </span>
                          ) : (
                            <span className="text-slate-500">Siap diperiksa</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* 4 Cloud Sync Operations */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-white rounded-2xl border border-slate-200 p-5 flex flex-col justify-between gap-4">
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 font-display font-bold text-slate-900 text-sm">
                  <ArrowLeftRight className="w-4 h-4 text-emerald-700" />
                  <span>1. Sinkronisasi Dua Arah (Two-Way Sync)</span>
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Mengunggah antrean hasil ujian lokal yang masih <code className="font-mono">pending</code> terlebih dahulu agar jawaban siswa aman, lalu menarik pembaruan data terbaru dari cloud ke cache lokal.
                </p>
              </div>
              <button
                type="button"
                disabled={!liveConfigured || activeSyncOp !== null}
                onClick={() => void handleRunSyncOp('two-way')}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white text-xs sm:text-sm font-semibold cursor-pointer disabled:opacity-50"
              >
                <RefreshCw
                  className={`w-4 h-4 ${activeSyncOp === 'two-way' ? 'animate-spin' : ''}`}
                />
                <span>
                  {activeSyncOp === 'two-way'
                    ? 'Menjalankan Sinkronisasi 2-Arah...'
                    : 'Jalankan Sinkronisasi Dua Arah'}
                </span>
              </button>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 p-5 flex flex-col justify-between gap-4">
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 font-display font-bold text-slate-900 text-sm">
                  <ArrowUpFromLine className="w-4 h-4 text-sky-700" />
                  <span>2. Push Semua Data Lokal → Cloud</span>
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Mengunggah seluruh profil lembaga, peserta &amp; token, jadwal mapel, bank soal (via RPC batch aman), dan hasil ujian dari IndexedDB lokal ke PostgreSQL Supabase.
                </p>
              </div>
              <button
                type="button"
                disabled={!liveConfigured || activeSyncOp !== null}
                onClick={() => void handleRunSyncOp('push')}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-sky-700 bg-sky-50 hover:bg-sky-100 text-sky-950 text-xs sm:text-sm font-semibold cursor-pointer disabled:opacity-50"
              >
                <Cloud className="w-4 h-4" />
                <span>
                  {activeSyncOp === 'push'
                    ? 'Mengunggah Data ke Cloud...'
                    : 'Push Lokal → Cloud'}
                </span>
              </button>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 p-5 flex flex-col justify-between gap-4">
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 font-display font-bold text-slate-900 text-sm">
                  <ArrowDownToLine className="w-4 h-4 text-emerald-700" />
                  <span>3. Pull Data Cloud → Lokal</span>
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Menarik profil sekolah, jadwal, peserta, dan hasil ujian terbaru dari Supabase ke cache lokal browser ini (menarik Bank Soal juga jika Service Role Key diisi).
                </p>
              </div>
              <button
                type="button"
                disabled={!liveConfigured || activeSyncOp !== null}
                onClick={() => void handleRunSyncOp('pull')}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-emerald-700 bg-emerald-50 hover:bg-emerald-100 text-emerald-950 text-xs sm:text-sm font-semibold cursor-pointer disabled:opacity-50"
              >
                <ArrowDownToLine className="w-4 h-4" />
                <span>
                  {activeSyncOp === 'pull'
                    ? 'Menarik Data dari Cloud...'
                    : 'Pull Cloud → Lokal'}
                </span>
              </button>
            </div>

            <div className="bg-white rounded-2xl border border-slate-200 p-5 flex flex-col justify-between gap-4">
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 font-display font-bold text-slate-900 text-sm">
                  <Upload className="w-4 h-4 text-amber-700" />
                  <span>
                    4. Flush Antrean Pending ({diagnostics?.pendingResultsCount || 0})
                  </span>
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Mengirim ulang rekaman hasil ujian siswa yang sebelumnya tersimpan offline/lokal dengan status <code className="font-mono">pending</code> ke tabel <code className="font-mono">exam_results</code>.
                </p>
              </div>
              <button
                type="button"
                disabled={!liveConfigured || activeSyncOp !== null}
                onClick={() => void handleRunSyncOp('flush')}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-amber-400 bg-amber-50 hover:bg-amber-100 text-amber-950 text-xs sm:text-sm font-semibold cursor-pointer disabled:opacity-50"
              >
                <Upload className="w-4 h-4" />
                <span>
                  {activeSyncOp === 'flush'
                    ? 'Mengirim Antrean...'
                    : 'Flush Antrean Pending ke Cloud'}
                </span>
              </button>
            </div>
          </div>

          {/* Local Backup, Restore & Seed Reset */}
          <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h3 className="font-display font-bold text-sm text-slate-900">
                  Cadangan Snapshot Lokal (JSON) &amp; Kosongkan Cache Lokal
                </h3>
                <p className="text-xs text-slate-600 mt-0.5">
                  Unduh seluruh data CBT lokal sebagai file cadangan JSON untuk arsip atau pemulihan cepat di perangkat lain.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleExportJsonBackup()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-xs font-semibold cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5 text-emerald-700" />
                  <span>Ekspor Backup JSON</span>
                </button>

                <button
                  type="button"
                  onClick={() => restoreInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-xs font-semibold cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5 text-sky-700" />
                  <span>Pulihkan Backup JSON</span>
                </button>
                <input
                  ref={restoreInputRef}
                  type="file"
                  accept="application/json,.json"
                  onChange={(e) => void handleRestoreJsonBackup(e)}
                  className="hidden"
                />

                {!confirmResetSeed ? (
                  <button
                    type="button"
                    onClick={() => setConfirmResetSeed(true)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-800 text-xs font-semibold cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Kosongkan Cache Lokal</span>
                  </button>
                ) : (
                  <div className="inline-flex items-center gap-1.5 bg-rose-50 border border-rose-300 rounded-xl px-2.5 py-1.5">
                    <span className="text-[11px] font-semibold text-rose-900">
                      Yakin kosongkan cache lokal?
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleResetSeed()}
                      className="px-2.5 py-1 rounded-lg bg-rose-700 hover:bg-rose-800 text-white text-[11px] font-semibold cursor-pointer"
                    >
                      Ya, Kosongkan
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmResetSeed(false)}
                      className="px-2 py-1 rounded-lg border border-slate-300 bg-white text-slate-700 text-[11px] font-semibold cursor-pointer"
                    >
                      Batal
                    </button>
                  </div>
                )}
              </div>
            </div>

            {backupFeedback && (
              <div
                className={`p-3 rounded-xl border text-xs font-medium ${
                  backupFeedback.ok
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                    : 'bg-rose-50 border-rose-200 text-rose-900'
                }`}
              >
                {backupFeedback.text}
              </div>
            )}
          </div>

          {/* Session Sync Execution Log */}
          {syncLogs.length > 0 && (
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50/70 font-display font-bold text-sm text-slate-900">
                Riwayat Operasi Sinkronisasi Sesi Ini ({syncLogs.length})
              </div>
              <div className="divide-y divide-slate-100">
                {syncLogs.map((log, idx) => (
                  <div key={`${log.timestamp}-${idx}`} className="p-4 space-y-1.5 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        {log.ok ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
                        ) : (
                          <XCircle className="w-4 h-4 text-rose-600 shrink-0" />
                        )}
                        <span className="font-bold text-slate-900">{log.action}</span>
                      </div>
                      <span className="font-mono text-[11px] text-slate-500">
                        {new Date(log.timestamp).toLocaleTimeString('id-ID')}
                      </span>
                    </div>
                    <p className="text-slate-700 pl-6">{log.summary}</p>
                    {Object.keys(log.details).length > 0 && (
                      <div className="pl-6 flex flex-wrap gap-1.5">
                        {Object.entries(log.details).map(([k, v]) => (
                          <span
                            key={k}
                            className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 font-mono text-[11px]"
                          >
                            {k}: {v}
                          </span>
                        ))}
                      </div>
                    )}
                    {log.errors.length > 0 && (
                      <div className="pl-6 space-y-2">
                        <ul className="pl-4 list-disc text-rose-700 space-y-0.5">
                          {log.errors.map((err, eIdx) => (
                            <li key={eIdx} className="font-mono text-[11px]">
                              {err}
                            </li>
                          ))}
                        </ul>
                        {log.errors.some((e) => e.toLowerCase().includes('permission denied')) && (
                          <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs text-amber-950 font-medium">
                              Terdeteksi error izin PostgreSQL (<code className="font-mono">permission denied</code>). Jalankan Skrip SQL terbaru (termasuk <code className="font-mono">GRANT</code>) di Supabase SQL Editor:
                            </span>
                            <div className="flex items-center gap-2 shrink-0">
                              <button
                                type="button"
                                onClick={() => void copyText('log_sql', SUPABASE_SCHEMA_SQL)}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-[11px] font-semibold cursor-pointer"
                              >
                                {copiedField === 'log_sql' ? (
                                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                                ) : (
                                  <Copy className="w-3.5 h-3.5" />
                                )}
                                <span>{copiedField === 'log_sql' ? 'SQL Tersalin' : 'Salin Skrip SQL'}</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => setSubTab('sql')}
                                className="px-2.5 py-1.5 rounded-lg border border-amber-300 bg-white hover:bg-amber-100 text-amber-950 text-[11px] font-semibold cursor-pointer"
                              >
                                Buka Tab Skema SQL &amp; RLS
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===================================================================== */}
      {/* TAB 4: SKEMA SQL & KEBIJAKAN RLS                                      */}
      {/* ===================================================================== */}
      {subTab === 'sql' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="text-xs font-bold text-slate-900">6 Tabel Relasional Inti</div>
              <p className="text-[11px] text-slate-600 mt-1 font-mono leading-relaxed">
                school_profile, participants, exam_schedules, questions, exam_results, staff_accounts
              </p>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="text-xs font-bold text-slate-900">Proteksi Kunci Jawaban RLS</div>
              <p className="text-[11px] text-slate-600 mt-1 leading-relaxed">
                Akses <code className="font-mono">SELECT</code> langsung pada tabel{' '}
                <code className="font-mono">questions</code> diblokir dari role <code className="font-mono">anon</code> agar <code className="font-mono">correct_answer</code> tidak muncul di Inspect Element.
              </p>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="text-xs font-bold text-slate-900">18 Fungsi RPC SECURITY DEFINER</div>
              <p className="text-[11px] text-slate-600 mt-1 font-mono leading-relaxed">
                get_server_time, get_student_questions, get_questions_sync_meta, get_question_coverage_summary, upsert_exam_progress, submit_exam_and_score, force_finish_exam_results, auto_finalize_expired_results, verify_participant_login, verify_staff_login, staff_list_accounts, staff_upsert_account, staff_delete_account, staff_upsert_school_profile, staff_delete_exam_results, staff_upsert_exam_results_batch, upsert_questions_batch, delete_question_by_id
              </p>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="p-5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2 font-display font-bold text-slate-900">
                  <ShieldCheck className="w-4 h-4 text-emerald-700" />
                  <span>Skrip SQL Skema Tabel &amp; Kebijakan Row Level Security (RLS)</span>
                </div>
                <p className="text-xs text-slate-600">
                  Jalankan skrip SQL ini di Supabase SQL Editor untuk mengaktifkan seluruh tabel, fungsi RPC penilaian server-side, dan proteksi anti-Inspect Element.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={handleDownloadSqlFile}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-xs font-semibold cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Unduh .sql</span>
                </button>
                <button
                  type="button"
                  onClick={() => void copyText('sql', SUPABASE_SCHEMA_SQL)}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold cursor-pointer"
                >
                  {copiedField === 'sql' ? (
                    <Check className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                  <span>{copiedField === 'sql' ? 'SQL Tersalin' : 'Salin Skrip SQL'}</span>
                </button>
              </div>
            </div>

            <pre className="p-5 bg-slate-950 text-emerald-100 font-mono text-xs overflow-x-auto max-h-[32rem] leading-relaxed">
              {SUPABASE_SCHEMA_SQL}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};
