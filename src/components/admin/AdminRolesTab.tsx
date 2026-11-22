import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Cloud,
  Eye,
  EyeOff,
  KeyRound,
  Pencil,
  Plus,
  Shield,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserCog,
  X,
} from 'lucide-react';
import {
  ALL_ADMIN_TABS,
  GURU_MAPEL_DEFAULT_TABS,
  PROKTOR_DEFAULT_TABS,
} from '@/src/lib/seedData';
import type {
  AdminTabKey,
  ExamSchedule,
  Question,
  StaffAccount,
  StaffRoleType,
} from '@/src/types/cbt';
import { isPasswordHashed } from '@/src/lib/dataStore';
import { isLiveSupabaseConfigured } from '@/src/lib/supabase';
import { usePersistedState } from '@/src/lib/usePersistedState';

interface StaffSyncResult {
  synced: boolean;
  error?: string;
}

interface AdminRolesTabProps {
  staffAccounts: StaffAccount[];
  currentStaffId: string;
  schedules: ExamSchedule[];
  questions: Question[];
  onUpsertStaff: (account: StaffAccount) => Promise<StaffSyncResult | void>;
  onDeleteStaff: (id: string) => Promise<StaffSyncResult | void>;
}

const MENU_OPTIONS: { key: AdminTabKey; label: string; desc: string }[] = [
  { key: 'dashboard', label: 'Dashboard Ujian', desc: 'Pantau peserta aktif & pelanggaran' },
  { key: 'reset', label: 'Reset & Buka Kunci', desc: 'Buka kunci peserta & reset ujian' },
  { key: 'recap', label: 'Rekap Nilai', desc: 'Lihat & unduh nilai hasil ujian' },
  { key: 'participants', label: 'Peserta & Token', desc: 'Kelola daftar peserta & token login' },
  { key: 'questions', label: 'Bank Soal & Mapel', desc: 'Kelola mapel, KKM, & butir soal' },
  { key: 'cards', label: 'Cetak Kartu Ujian', desc: 'Cetak kartu peserta format PDF' },
  { key: 'branding', label: 'Profil Lembaga', desc: 'Identitas sekolah, logo, & sandi utama' },
  { key: 'roles', label: 'Manajemen Role & Akses', desc: 'Kelola ID, sandi, & hak akses panitia' },
  { key: 'database', label: 'Database & SQL', desc: 'Kredensial API, panduan SQL/RLS, & sinkronisasi data' },
];

const ROLE_TYPE_OPTIONS: {
  value: StaffRoleType;
  label: string;
  defaultLabel: string;
  defaultTabs: AdminTabKey[];
  defaultRestrictSubject: boolean;
  hint: string;
}[] = [
  {
    value: 'admin',
    label: 'Administrator Penuh',
    defaultLabel: 'Administrator',
    defaultTabs: ALL_ADMIN_TABS,
    defaultRestrictSubject: false,
    hint: 'Akses penuh ke seluruh menu sistem CBT.',
  },
  {
    value: 'proktor',
    label: 'Proktor (Teknisi)',
    defaultLabel: 'Proktor (Teknisi)',
    defaultTabs: PROKTOR_DEFAULT_TABS,
    defaultRestrictSubject: false,
    hint: 'Akses Dashboard Ujian, Reset & Buka Kunci, Rekap Nilai, Peserta & Token, Bank Soal & Mapel, dan Cetak Kartu Ujian.',
  },
  {
    value: 'guru_mapel',
    label: 'Guru Mapel',
    defaultLabel: 'Guru Mapel',
    defaultTabs: GURU_MAPEL_DEFAULT_TABS,
    defaultRestrictSubject: true,
    hint: 'Akses Rekap Nilai dan Bank Soal & Mapel (tambah & edit khusus mata pelajaran masing-masing).',
  },
  {
    value: 'custom',
    label: 'Role Kustom',
    defaultLabel: 'Panitia Ujian',
    defaultTabs: ['dashboard', 'recap'],
    defaultRestrictSubject: false,
    hint: 'Atur hak akses tiap menu dan pembatasan mapel secara bebas.',
  },
];

interface RoleFormState {
  id: string | null;
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

function createEmptyForm(): RoleFormState {
  return {
    id: null,
    userId: '',
    name: '',
    password: '',
    roleType: 'proktor',
    roleLabel: 'Proktor (Teknisi)',
    allowedTabs: [...PROKTOR_DEFAULT_TABS],
    assignedSubjects: [],
    restrictToAssignedSubjects: false,
    isActive: true,
    createdAt: new Date().toISOString(),
  };
}

export const AdminRolesTab: React.FC<AdminRolesTabProps> = ({
  staffAccounts,
  currentStaffId,
  schedules,
  questions,
  onUpsertStaff,
  onDeleteStaff,
}) => {
  const [modalOpen, setModalOpen] = usePersistedState('cbt_draft_role_modal_open_v1', false);
  const [form, setForm] = usePersistedState<RoleFormState>(
    'cbt_draft_role_form_v1',
    createEmptyForm
  );
  const [showPassword, setShowPassword] = useState(false);
  const [customSubjectInput, setCustomSubjectInput] = useState('');
  const [formError, setFormError] = useState('');
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const liveCloud = isLiveSupabaseConfigured();

  const allSubjects = useMemo(() => {
    const set = new Set<string>();
    schedules.forEach((s) => s.subject && set.add(s.subject));
    questions.forEach((q) => q.subject && set.add(q.subject));
    staffAccounts.forEach((acc) =>
      acc.assignedSubjects.forEach((subj) => subj && set.add(subj))
    );
    form.assignedSubjects.forEach((subj) => subj && set.add(subj));
    return Array.from(set).sort();
  }, [schedules, questions, staffAccounts, form.assignedSubjects]);

  const allowedTabSet = useMemo(() => new Set(form.allowedTabs), [form.allowedTabs]);
  const assignedSubjectSet = useMemo(() => new Set(form.assignedSubjects), [form.assignedSubjects]);

  const openCreateModal = (presetRole: StaffRoleType = 'proktor') => {
    const template =
      ROLE_TYPE_OPTIONS.find((r) => r.value === presetRole) || ROLE_TYPE_OPTIONS[1];
    setForm({
      id: null,
      userId: '',
      name: '',
      password: '',
      roleType: template.value,
      roleLabel: template.defaultLabel,
      allowedTabs: [...template.defaultTabs],
      assignedSubjects: [],
      restrictToAssignedSubjects: template.defaultRestrictSubject,
      isActive: true,
      createdAt: new Date().toISOString(),
    });
    setShowPassword(false);
    setCustomSubjectInput('');
    setFormError('');
    setModalOpen(true);
  };

  const openEditModal = (acc: StaffAccount) => {
    setForm({
      id: acc.id,
      userId: acc.userId,
      name: acc.name,
      password: '',
      roleType: acc.roleType,
      roleLabel: acc.roleLabel,
      allowedTabs: [...acc.allowedTabs],
      assignedSubjects: [...acc.assignedSubjects],
      restrictToAssignedSubjects: acc.restrictToAssignedSubjects,
      isActive: acc.isActive,
      createdAt: acc.createdAt,
    });
    setShowPassword(false);
    setCustomSubjectInput('');
    setFormError('');
    setModalOpen(true);
  };

  const handleRoleTypeChange = (nextType: StaffRoleType) => {
    const template = ROLE_TYPE_OPTIONS.find((r) => r.value === nextType);
    if (!template) return;
    setForm((prev) => ({
      ...prev,
      roleType: nextType,
      roleLabel: template.defaultLabel,
      allowedTabs: [...template.defaultTabs],
      restrictToAssignedSubjects: template.defaultRestrictSubject,
    }));
  };

  const toggleTabPermission = (key: AdminTabKey) => {
    if (form.userId.trim().toLowerCase() === 'admin' && key === 'roles') {
      return; // Safeguard: main admin must keep access to Roles tab
    }
    setForm((prev) => {
      const exists = prev.allowedTabs.includes(key);
      return {
        ...prev,
        allowedTabs: exists
          ? prev.allowedTabs.filter((t) => t !== key)
          : [...prev.allowedTabs, key],
      };
    });
  };

  const toggleSubject = (subject: string) => {
    setForm((prev) => {
      const exists = prev.assignedSubjects.includes(subject);
      return {
        ...prev,
        assignedSubjects: exists
          ? prev.assignedSubjects.filter((s) => s !== subject)
          : [...prev.assignedSubjects, subject],
      };
    });
  };

  const handleAddCustomSubject = () => {
    const trimmed = customSubjectInput.trim();
    if (!trimmed) return;
    if (!form.assignedSubjects.some((s) => s.toLowerCase() === trimmed.toLowerCase())) {
      setForm((prev) => ({
        ...prev,
        assignedSubjects: [...prev.assignedSubjects, trimmed],
      }));
    }
    setCustomSubjectInput('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    const cleanId = form.userId.trim();
    const cleanName = form.name.trim();
    const cleanPwd = form.password.trim();
    const cleanLabel = form.roleLabel.trim() || 'Panitia';
    const existingAcc = form.id
      ? staffAccounts.find((acc) => acc.id === form.id)
      : undefined;

    if (!cleanId) {
      setFormError('ID Login wajib diisi (contoh: proktor2 atau guru-ipa).');
      return;
    }
    if (/\s/.test(cleanId)) {
      setFormError('ID Login tidak boleh mengandung spasi.');
      return;
    }
    if (!cleanName) {
      setFormError('Nama lengkap pengguna wajib diisi.');
      return;
    }
    if (!existingAcc && cleanPwd.length < 4) {
      setFormError('Sandi login minimal 4 karakter.');
      return;
    }
    if (existingAcc && cleanPwd.length > 0 && cleanPwd.length < 4) {
      setFormError('Sandi login baru minimal 4 karakter (atau kosongkan jika tidak diubah).');
      return;
    }
    if (form.allowedTabs.length === 0) {
      setFormError('Pilih minimal satu menu yang dapat diakses oleh role ini.');
      return;
    }
    if (form.restrictToAssignedSubjects && form.assignedSubjects.length === 0) {
      setFormError(
        'Pilih minimal satu Mata Pelajaran untuk role yang dibatasi per mapel (seperti Guru Mapel).'
      );
      return;
    }

    const duplicate = staffAccounts.find(
      (acc) => acc.userId.toLowerCase() === cleanId.toLowerCase() && acc.id !== form.id
    );
    if (duplicate) {
      setFormError(`ID "${cleanId}" sudah digunakan oleh akun lain.`);
      return;
    }

    const resolvedPassword = cleanPwd || existingAcc?.password || '';
    if (!resolvedPassword) {
      setFormError('Sandi login wajib diisi minimal 4 karakter.');
      return;
    }

    const isPrimaryAdmin = cleanId.toLowerCase() === 'admin';
    const generatedStaffId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? `staff-${crypto.randomUUID()}`
        : `staff-${cleanId.toLowerCase().replace(/[^a-z0-9-_]/g, '')}-${Date.now()}`;

    const payload: StaffAccount = {
      id: form.id || generatedStaffId,
      userId: cleanId,
      name: cleanName,
      password: resolvedPassword,
      roleType: form.roleType,
      roleLabel: cleanLabel,
      allowedTabs: isPrimaryAdmin
        ? Array.from(new Set<AdminTabKey>([...form.allowedTabs, 'roles']))
        : form.allowedTabs,
      assignedSubjects: form.restrictToAssignedSubjects ? form.assignedSubjects : [],
      restrictToAssignedSubjects: isPrimaryAdmin ? false : form.restrictToAssignedSubjects,
      isActive: isPrimaryAdmin ? true : form.isActive,
      createdAt: form.createdAt || new Date().toISOString(),
    };

    const syncRes = await onUpsertStaff(payload);
    setModalOpen(false);
    const actionLabel = form.id
      ? `Role & akses untuk "${payload.name}" (ID: ${payload.userId}) berhasil diperbarui`
      : `Role baru "${payload.name}" (ID: ${payload.userId}) berhasil ditambahkan`;

    if (syncRes && syncRes.error) {
      setFeedback({
        ok: false,
        text: `${actionLabel} di perangkat ini, namun GAGAL sinkron ke Supabase Cloud (${syncRes.error}). Pastikan Skrip SQL terbaru (tabel staff_accounts) sudah dijalankan di menu Database & SQL.`,
      });
    } else if (syncRes?.synced) {
      setFeedback({
        ok: true,
        text: `${actionLabel} & tersinkron ke Database Cloud (aktif di semua perangkat).`,
      });
    } else {
      setFeedback({
        ok: true,
        text: `${actionLabel} di cache lokal perangkat ini.`,
      });
    }
  };

  const roleBadgeClass = (roleType: StaffRoleType): string => {
    switch (roleType) {
      case 'admin':
        return 'bg-emerald-100 text-emerald-900 border-emerald-300';
      case 'proktor':
        return 'bg-sky-50 text-sky-900 border-sky-200';
      case 'guru_mapel':
        return 'bg-amber-50 text-amber-900 border-amber-200';
      default:
        return 'bg-slate-100 text-slate-800 border-slate-300';
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="font-display text-2xl font-bold text-slate-900 tracking-tight">
              Manajemen Role &amp; Hak Akses Panitia
            </h1>
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-semibold ${
                liveCloud
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-amber-50 border-amber-200 text-amber-800'
              }`}
            >
              <Cloud className="w-3.5 h-3.5" />
              <span>
                {liveCloud
                  ? 'Sinkron Otomatis ke Cloud (Semua Perangkat)'
                  : 'Mode Lokal (Belum Terhubung Cloud)'}
              </span>
            </span>
          </div>
          <p className="text-sm text-slate-600 mt-0.5">
            Tambahkan akun role Admin, Proktor (Teknisi), Guru Mapel, atau role kustom dengan ID, nama, sandi, dan pengaturan akses menu masing-masing.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => openCreateModal('proktor')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-xs sm:text-sm font-semibold cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-4 h-4 text-sky-700" />
            <span>Tambah Proktor</span>
          </button>

          <button
            type="button"
            onClick={() => openCreateModal('guru_mapel')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-xs sm:text-sm font-semibold cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-4 h-4 text-amber-700" />
            <span>Tambah Guru Mapel</span>
          </button>

          <button
            type="button"
            onClick={() => openCreateModal('custom')}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white text-xs sm:text-sm font-semibold cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            <span>Tambah Role Baru</span>
          </button>
        </div>
      </div>

      {feedback && (
        <div
          className={`p-3.5 rounded-xl border text-sm flex items-center justify-between gap-3 ${
            feedback.ok
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-amber-50 border-amber-300 text-amber-950'
          }`}
        >
          <div className="flex items-center gap-2">
            {feedback.ok ? (
              <Check className="w-4 h-4 text-emerald-700 shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
            )}
            <span>{feedback.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="p-1 rounded-lg hover:bg-black/5 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Role Summary Guide */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-1">
          <div className="flex items-center gap-2 text-xs font-bold text-emerald-800 uppercase tracking-wider">
            <ShieldCheck className="w-4 h-4" />
            <span>Administrator</span>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed">
            Memiliki akses penuh ke seluruh 9 menu termasuk Profil Lembaga, Manajemen Role, dan Database.
          </p>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-1">
          <div className="flex items-center gap-2 text-xs font-bold text-sky-800 uppercase tracking-wider">
            <UserCog className="w-4 h-4" />
            <span>Proktor (Teknisi)</span>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed">
            Mengakses Dashboard Ujian, Reset &amp; Buka Kunci, Rekap Nilai, Peserta &amp; Token, Bank Soal &amp; Mapel, dan Cetak Kartu Ujian.
          </p>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-1">
          <div className="flex items-center gap-2 text-xs font-bold text-amber-800 uppercase tracking-wider">
            <UserCheck className="w-4 h-4" />
            <span>Guru Mapel</span>
          </div>
          <p className="text-xs text-slate-600 leading-relaxed">
            Mengakses Rekap Nilai serta menambah/mengedit Bank Soal &amp; Mapel khusus mata pelajaran masing-masing.
          </p>
        </div>
      </div>

      {/* Staff Accounts Table */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50/70 flex items-center justify-between">
          <div className="flex items-center gap-2 font-display font-bold text-slate-900 text-sm">
            <Shield className="w-4 h-4 text-emerald-700" />
            <span>Daftar Akun Role Admin &amp; Panitia ({staffAccounts.length} Akun)</span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                <th className="py-3 px-4">ID Login</th>
                <th className="py-3 px-4">Nama &amp; Role</th>
                <th className="py-3 px-4">Sandi</th>
                <th className="py-3 px-4">Hak Akses Menu &amp; Mapel</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {staffAccounts.map((acc) => {
                const isMainAdmin = acc.userId.toLowerCase() === 'admin';
                const isSelf = acc.id === currentStaffId;
                const hashed = isPasswordHashed(acc.password);

                return (
                  <tr key={acc.id} className="hover:bg-slate-50/70 align-top">
                    <td className="py-3 px-4 font-mono font-bold text-slate-900 whitespace-nowrap">
                      {acc.userId}
                    </td>

                    <td className="py-3 px-4">
                      <div className="font-semibold text-slate-900">{acc.name}</div>
                      <span
                        className={`inline-block mt-1 px-2 py-0.5 rounded-md text-[11px] font-semibold border ${roleBadgeClass(
                          acc.roleType
                        )}`}
                      >
                        {acc.roleLabel}
                      </span>
                    </td>

                    <td className="py-3 px-4 whitespace-nowrap">
                      <div
                        className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border ${
                          hashed
                            ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                            : 'bg-slate-100 border-slate-200 text-slate-700'
                        }`}
                      >
                        <KeyRound className="w-3.5 h-3.5 shrink-0" />
                        <span className="font-semibold">
                          {hashed ? 'Tersandi (SHA-256)' : '••••••••'}
                        </span>
                      </div>
                    </td>

                    <td className="py-3 px-4 space-y-1.5">
                      <div className="flex flex-wrap gap-1">
                        {acc.allowedTabs.map((tabKey) => {
                          const menuMeta = MENU_OPTIONS.find((m) => m.key === tabKey);
                          return (
                            <span
                              key={tabKey}
                              className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 text-[11px] font-medium"
                            >
                              {menuMeta?.label || tabKey}
                            </span>
                          );
                        })}
                      </div>
                      {acc.restrictToAssignedSubjects && (
                        <div className="text-xs text-amber-800 font-medium">
                          Khusus Mapel:{' '}
                          <span className="font-semibold">
                            {acc.assignedSubjects.length > 0
                              ? acc.assignedSubjects.join(', ')
                              : 'Belum dipilih'}
                          </span>
                        </div>
                      )}
                    </td>

                    <td className="py-3 px-4 whitespace-nowrap">
                      <button
                        type="button"
                        disabled={isMainAdmin || isSelf}
                        onClick={() =>
                          void (async () => {
                            const nextActive = !acc.isActive;
                            const syncRes = await onUpsertStaff({ ...acc, isActive: nextActive });
                            if (syncRes?.error) {
                              setFeedback({
                                ok: false,
                                text: `Status "${acc.userId}" diubah secara lokal, namun gagal sinkron ke Cloud (${syncRes.error}).`,
                              });
                            } else if (syncRes?.synced) {
                              setFeedback({
                                ok: true,
                                text: `Status akun "${acc.userId}" (${nextActive ? 'Aktif' : 'Nonaktif'}) tersinkron ke semua perangkat.`,
                              });
                            }
                          })()
                        }
                        className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors ${
                          acc.isActive
                            ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                            : 'bg-slate-100 border-slate-200 text-slate-500'
                        } ${isMainAdmin || isSelf ? 'cursor-default opacity-80' : 'cursor-pointer hover:opacity-80'}`}
                      >
                        {acc.isActive ? 'Aktif' : 'Nonaktif'}
                      </button>
                    </td>

                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => openEditModal(acc)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-emerald-50 hover:border-emerald-300 text-slate-700 hover:text-emerald-900 text-xs font-semibold cursor-pointer"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                          <span>Edit</span>
                        </button>

                        <button
                          type="button"
                          disabled={isMainAdmin || isSelf}
                          onClick={() =>
                            void (async () => {
                              const syncRes = await onDeleteStaff(acc.id);
                              if (syncRes?.error) {
                                setFeedback({
                                  ok: false,
                                  text: `Akun "${acc.userId}" dihapus secara lokal, namun gagal terhapus di Cloud (${syncRes.error}).`,
                                });
                              } else if (syncRes?.synced) {
                                setFeedback({
                                  ok: true,
                                  text: `Akun "${acc.userId}" berhasil dihapus dari lokal dan Database Cloud.`,
                                });
                              }
                            })()
                          }
                          title={
                            isMainAdmin
                              ? 'Akun admin utama tidak dapat dihapus'
                              : isSelf
                                ? 'Akun yang sedang login tidak dapat dihapus'
                                : 'Hapus akun role'
                          }
                          className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create / Edit Role Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5">
          <div className="w-full max-w-2xl max-h-[92vh] bg-white rounded-2xl border border-slate-200 shadow-2xl flex flex-col overflow-hidden">
            <div className="px-5 py-4 bg-[#064e3b] text-white flex items-center justify-between gap-3 shrink-0">
              <div className="flex items-center gap-2.5">
                <KeyRound className="w-5 h-5 text-emerald-200" />
                <div>
                  <h3 className="font-display font-bold text-base">
                    {form.id ? `Edit Role & Akses — ${form.userId}` : 'Tambah Role & Akses Baru'}
                  </h3>
                  <p className="text-xs text-emerald-100/85">
                    Atur ID login, nama, sandi, hak akses menu, dan pembatasan mata pelajaran.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="p-1.5 rounded-lg text-emerald-100 hover:bg-white/10 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-5 sm:p-6 space-y-5 overflow-y-auto flex-1">
              {formError && (
                <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-800 text-xs sm:text-sm font-medium">
                  {formError}
                </div>
              )}

              {/* ID, Name, Password */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    ID Login (Tanpa Spasi)
                  </label>
                  <input
                    type="text"
                    required
                    disabled={form.id !== null && form.userId.toLowerCase() === 'admin'}
                    value={form.userId}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, userId: e.target.value.replace(/\s+/g, '') }))
                    }
                    placeholder="Contoh: proktor2"
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 font-mono text-sm font-bold disabled:bg-slate-100"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Nama Lengkap
                  </label>
                  <input
                    type="text"
                    required
                    value={form.name}
                    onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                    placeholder="Nama panitia / guru"
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {form.id ? 'Sandi / PIN Baru (Opsional)' : 'Sandi / PIN Login'}
                  </label>
                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      required={!form.id}
                      value={form.password}
                      onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
                      placeholder={
                        form.id
                          ? 'Kosongkan jika tidak mengubah sandi'
                          : 'Minimal 4 karakter'
                      }
                      className="w-full pl-3 pr-9 py-2 rounded-xl border border-slate-300 font-mono text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 cursor-pointer"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>

              {/* Role Template Selector */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Template Role
                  </label>
                  <select
                    value={form.roleType}
                    disabled={form.userId.toLowerCase() === 'admin'}
                    onChange={(e) => handleRoleTypeChange(e.target.value as StaffRoleType)}
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-white text-sm font-semibold disabled:bg-slate-100"
                  >
                    {ROLE_TYPE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Nama Label Role (Tampilan)
                  </label>
                  <input
                    type="text"
                    required
                    value={form.roleLabel}
                    onChange={(e) => setForm((prev) => ({ ...prev, roleLabel: e.target.value }))}
                    placeholder="Contoh: Proktor Lab 2"
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm"
                  />
                </div>
              </div>

              {/* Menu Access Checkboxes */}
              <div className="space-y-2.5 p-4 rounded-xl bg-slate-50 border border-slate-200">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-bold text-slate-800">
                    Pengaturan Akses Menu ({form.allowedTabs.length} menu dipilih)
                  </span>
                  {form.userId.toLowerCase() !== 'admin' && (
                    <div className="flex flex-wrap gap-1.5 text-[11px]">
                      <button
                        type="button"
                        onClick={() =>
                          setForm((prev) => ({ ...prev, allowedTabs: [...PROKTOR_DEFAULT_TABS] }))
                        }
                        className="px-2 py-1 rounded-lg bg-white border border-slate-200 hover:bg-sky-50 text-slate-700 font-semibold cursor-pointer"
                      >
                        Preset Proktor
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setForm((prev) => ({ ...prev, allowedTabs: [...GURU_MAPEL_DEFAULT_TABS] }))
                        }
                        className="px-2 py-1 rounded-lg bg-white border border-slate-200 hover:bg-amber-50 text-slate-700 font-semibold cursor-pointer"
                      >
                        Preset Guru Mapel
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setForm((prev) => ({ ...prev, allowedTabs: [...ALL_ADMIN_TABS] }))
                        }
                        className="px-2 py-1 rounded-lg bg-white border border-slate-200 hover:bg-emerald-50 text-slate-700 font-semibold cursor-pointer"
                      >
                        Pilih Semua
                      </button>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {MENU_OPTIONS.map((item) => {
                    const checked = allowedTabSet.has(item.key);
                    const locked = form.userId.toLowerCase() === 'admin' && item.key === 'roles';
                    return (
                      <label
                        key={item.key}
                        className={`flex items-start gap-2.5 p-2.5 rounded-xl border transition-colors ${
                          checked
                            ? 'bg-white border-emerald-500 shadow-2xs'
                            : 'bg-slate-100/60 border-slate-200 text-slate-500'
                        } ${locked ? 'cursor-not-allowed opacity-80' : 'cursor-pointer'}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={locked}
                          onChange={() => toggleTabPermission(item.key)}
                          className="mt-0.5 w-4 h-4 accent-[#064e3b]"
                        />
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-slate-900">{item.label}</div>
                          <div className="text-[11px] text-slate-500 leading-snug">{item.desc}</div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* Subject Restriction (Guru Mapel) */}
              {form.userId.toLowerCase() !== 'admin' && (
                <div className="space-y-3 p-4 rounded-xl bg-amber-50/50 border border-amber-200">
                  <label className="flex items-center gap-2.5 text-xs font-bold text-slate-900 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.restrictToAssignedSubjects}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          restrictToAssignedSubjects: e.target.checked,
                        }))
                      }
                      className="w-4 h-4 accent-[#064e3b]"
                    />
                    <span>
                      Batasi akses Rekap Nilai &amp; Bank Soal hanya untuk Mata Pelajaran tertentu (Khusus Guru Mapel)
                    </span>
                  </label>

                  {form.restrictToAssignedSubjects && (
                    <div className="space-y-2.5 pt-1">
                      <div className="flex flex-wrap gap-2">
                        {allSubjects.map((subj) => {
                          const selected = assignedSubjectSet.has(subj);
                          return (
                            <button
                              key={subj}
                              type="button"
                              onClick={() => toggleSubject(subj)}
                              className={`px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors cursor-pointer ${
                                selected
                                  ? 'bg-[#064e3b] border-[#064e3b] text-white'
                                  : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
                              }`}
                            >
                              {subj}
                            </button>
                          );
                        })}
                      </div>

                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={customSubjectInput}
                          onChange={(e) => setCustomSubjectInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleAddCustomSubject();
                            }
                          }}
                          placeholder="Tambah nama mapel baru jika belum ada di daftar..."
                          className="flex-1 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs"
                        />
                        <button
                          type="button"
                          onClick={handleAddCustomSubject}
                          className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-900 text-white text-xs font-semibold cursor-pointer"
                        >
                          + Mapel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="flex justify-end gap-2.5 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-semibold cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white text-sm font-semibold cursor-pointer"
                >
                  {form.id ? 'Simpan Perubahan Role' : 'Simpan Role Baru'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
