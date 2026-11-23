import React, { useState } from 'react';
import { AlertTriangle, Check, ImagePlus, KeyRound, RotateCcw, Save } from 'lucide-react';
import { compressLogoImage } from '@/src/lib/importers';
import { DEFAULT_LOGO_DATA_URL, KEMENAG_LOGO_DATA_URL } from '@/src/lib/seedData';
import type { SchoolProfile } from '@/src/types/cbt';
import { verifyStaffPassword } from '@/src/lib/dataStore';
import {
  clearPersistedValue,
  readPersistedValue,
  writePersistedValue,
} from '@/src/lib/usePersistedState';

interface AdminBrandingTabProps {
  profile: SchoolProfile;
  onSaveProfile: (
    updated: SchoolProfile,
    options?: { updateAdminPassword?: boolean }
  ) => Promise<{ synced: boolean; error?: string } | void>;
}

export const AdminBrandingTab: React.FC<AdminBrandingTabProps> = ({
  profile,
  onSaveProfile,
}) => {
  const hasDraftForCurrentProfile = React.useMemo(() => {
    const draft = readPersistedValue<{ baseUpdatedAt: string; data: SchoolProfile } | null>(
      'cbt_draft_branding_v1',
      null
    );
    return Boolean(draft && draft.baseUpdatedAt === profile.updatedAt);
  }, [profile.updatedAt]);

  const [form, setForm] = useState<SchoolProfile>(() => {
    const draft = readPersistedValue<{ baseUpdatedAt: string; data: SchoolProfile } | null>(
      'cbt_draft_branding_v1',
      null
    );
    if (draft && draft.baseUpdatedAt === profile.updatedAt) {
      return {
        ...draft.data,
        kemenagLogoDataUrl: draft.data.kemenagLogoDataUrl || KEMENAG_LOGO_DATA_URL,
      };
    }
    return {
      ...profile,
      kemenagLogoDataUrl: profile.kemenagLogoDataUrl || KEMENAG_LOGO_DATA_URL,
    };
  });
  const lastSyncedProfileSigRef = React.useRef(
    `${profile.updatedAt}|${profile.logoDataUrl}|${profile.kemenagLogoDataUrl || ''}`
  );
  const isDirtyRef = React.useRef(hasDraftForCurrentProfile);
  const [isSaving, setIsSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState<{ ok: boolean; msg: string } | null>(null);
  const [uploadError, setUploadError] = useState('');
  const [kemenagUploadError, setKemenagUploadError] = useState('');

  React.useEffect(() => {
    const nextSig = `${profile.updatedAt}|${profile.logoDataUrl}|${profile.kemenagLogoDataUrl || ''}`;
    if (nextSig !== lastSyncedProfileSigRef.current) {
      lastSyncedProfileSigRef.current = nextSig;
      if (!isDirtyRef.current) {
        setForm({
          ...profile,
          kemenagLogoDataUrl: profile.kemenagLogoDataUrl || KEMENAG_LOGO_DATA_URL,
        });
      }
    }
  }, [profile]);

  React.useEffect(() => {
    const isSameAsProp =
      form.schoolName === profile.schoolName &&
      form.address === profile.address &&
      form.academicYear === profile.academicYear &&
      form.principalName === profile.principalName &&
      form.committeeChairName === profile.committeeChairName &&
      form.examTitle === profile.examTitle &&
      form.logoDataUrl === profile.logoDataUrl &&
      (form.kemenagLogoDataUrl || KEMENAG_LOGO_DATA_URL) ===
        (profile.kemenagLogoDataUrl || KEMENAG_LOGO_DATA_URL);
    isDirtyRef.current = !isSameAsProp;
    if (isSameAsProp) {
      clearPersistedValue('cbt_draft_branding_v1');
      return;
    }
    writePersistedValue('cbt_draft_branding_v1', {
      baseUpdatedAt: profile.updatedAt,
      data: form,
    });
  }, [form, profile]);

  // Admin Password Change State
  const [currentPwd, setCurrentPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [isSavingPwd, setIsSavingPwd] = useState(false);
  const [pwdFeedback, setPwdFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError('');
    try {
      const compressed = await compressLogoImage(file, 240);
      setForm((prev) => ({ ...prev, logoDataUrl: compressed }));
    } catch (err) {
      setUploadError(
        err instanceof Error ? err.message : 'Gagal memproses gambar logo.'
      );
    } finally {
      e.target.value = '';
    }
  };

  const handleKemenagLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setKemenagUploadError('');
    try {
      const compressed = await compressLogoImage(file, 240);
      setForm((prev) => ({ ...prev, kemenagLogoDataUrl: compressed }));
    } catch (err) {
      setKemenagUploadError(
        err instanceof Error ? err.message : 'Gagal memproses gambar logo Kementerian Agama.'
      );
    } finally {
      e.target.value = '';
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setSavedNotice(null);
    try {
      const syncRes = await onSaveProfile(form, { updateAdminPassword: false });
      isDirtyRef.current = false;
      clearPersistedValue('cbt_draft_branding_v1');
      if (syncRes?.error) {
        setSavedNotice({
          ok: false,
          msg: `Profil sekolah disimpan lokal, namun gagal sinkron ke Cloud (${syncRes.error}).`,
        });
      } else if (syncRes?.synced) {
        setSavedNotice({
          ok: true,
          msg: 'Profil sekolah & logo berhasil disimpan dan tersinkron ke semua perangkat.',
        });
      } else {
        setSavedNotice({
          ok: true,
          msg: 'Profil sekolah & logo berhasil disimpan dan langsung diperbarui ke seluruh tampilan.',
        });
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwdFeedback(null);
    setIsSavingPwd(true);
    try {
      const validCurrent = await verifyStaffPassword('admin', currentPwd);
      if (!validCurrent) {
        setPwdFeedback({ type: 'err', msg: 'Sandi admin saat ini tidak sesuai.' });
        return;
      }
      if (newPwd.trim().length < 4) {
        setPwdFeedback({ type: 'err', msg: 'Sandi baru minimal terdiri dari 4 karakter.' });
        return;
      }
      if (newPwd !== confirmPwd) {
        setPwdFeedback({ type: 'err', msg: 'Konfirmasi sandi baru tidak cocok.' });
        return;
      }

      const syncRes = await onSaveProfile(
        { ...profile, adminPassword: newPwd.trim() },
        { updateAdminPassword: true }
      );
      if (syncRes?.error) {
        setPwdFeedback({
          type: 'err',
          msg: `Sandi tersimpan di perangkat ini, namun GAGAL sinkron ke Supabase Cloud (${syncRes.error}). Pastikan koneksi aktif dan skema SQL terbaru telah dijalankan.`,
        });
        return;
      }
      setCurrentPwd('');
      setNewPwd('');
      setConfirmPwd('');
      setPwdFeedback({
        type: 'ok',
        msg: syncRes?.synced
          ? 'Sandi admin berhasil diperbarui dan tersinkron ke Database Cloud (aktif di semua perangkat).'
          : 'Sandi admin berhasil diperbarui di perangkat ini.',
      });
    } finally {
      setIsSavingPwd(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="font-display text-2xl font-bold text-slate-900 tracking-tight">
          Profil Lembaga &amp; Pengaturan Sandi
        </h1>
        <p className="text-sm text-slate-600 mt-0.5">
          Identitas lembaga, logo Kementerian Agama (Kop Kiri) &amp; logo sekolah/madrasah (Kop Kanan &amp; Header), serta pengaturan ubah sandi administrator.
        </p>
      </div>

      {/* School Profile Form */}
      <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-slate-200 p-6 space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 pb-6 border-b border-slate-100">
          {/* Logo Kementerian Agama (Kop Kiri) */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4 flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="w-24 h-24 rounded-xl bg-white border border-slate-200 p-2 flex items-center justify-center shrink-0">
              <img
                src={form.kemenagLogoDataUrl || KEMENAG_LOGO_DATA_URL}
                alt="Pratinjau Logo Kementerian Agama"
                referrerPolicy="no-referrer"
                className="w-full h-full object-contain"
              />
            </div>

            <div className="space-y-2 flex-1 min-w-0">
              <div className="font-semibold text-slate-900 text-sm">
                Logo Kementerian Agama <span className="text-emerald-800 font-medium">(Kop Kiri)</span>
              </div>
              <p className="text-xs text-slate-500 leading-relaxed">
                Digunakan sebagai sumber logo KOP bagian kiri pada seluruh administrasi (Kartu Peserta, Rekap Nilai, Daftar Hadir, dan Berita Acara). Kompresi otomatis maks. 240×240 px.
              </p>
              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border border-emerald-200 text-xs font-semibold cursor-pointer transition-colors">
                  <ImagePlus className="w-3.5 h-3.5" />
                  <span>Unggah Logo Kemenag</span>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleKemenagLogoUpload}
                    className="sr-only"
                  />
                </label>

                <button
                  type="button"
                  onClick={() =>
                    setForm((prev) => ({ ...prev, kemenagLogoDataUrl: KEMENAG_LOGO_DATA_URL }))
                  }
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 text-xs font-semibold cursor-pointer transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Default</span>
                </button>
              </div>
              {kemenagUploadError && (
                <p className="text-xs text-red-700 font-medium">{kemenagUploadError}</p>
              )}
            </div>
          </div>

          {/* Logo Sekolah / Madrasah (Kop Kanan & Header) */}
          <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-4 flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="w-24 h-24 rounded-xl bg-white border border-slate-200 p-2 flex items-center justify-center shrink-0">
              <img
                src={form.logoDataUrl || DEFAULT_LOGO_DATA_URL}
                alt="Pratinjau Logo Sekolah"
                referrerPolicy="no-referrer"
                className="w-full h-full object-contain"
              />
            </div>

            <div className="space-y-2 flex-1 min-w-0">
              <div className="font-semibold text-slate-900 text-sm">
                Logo Sekolah / Madrasah <span className="text-emerald-800 font-medium">(Kop Kanan &amp; Header)</span>
              </div>
              <p className="text-xs text-slate-500 leading-relaxed">
                Digunakan untuk logo KOP bagian kanan administrasi, header aplikasi, dan halaman login. Mendukung PNG, JPG, atau WebP (kompresi otomatis maks. 240×240 px).
              </p>
              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-50 hover:bg-emerald-100 text-emerald-900 border border-emerald-200 text-xs font-semibold cursor-pointer transition-colors">
                  <ImagePlus className="w-3.5 h-3.5" />
                  <span>Unggah Logo Sekolah</span>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleLogoUpload}
                    className="sr-only"
                  />
                </label>

                <button
                  type="button"
                  onClick={() => setForm((prev) => ({ ...prev, logoDataUrl: DEFAULT_LOGO_DATA_URL }))}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 text-xs font-semibold cursor-pointer transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Default</span>
                </button>
              </div>
              {uploadError && <p className="text-xs text-red-700 font-medium">{uploadError}</p>}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <label className="block text-sm font-semibold text-slate-800 mb-1.5">
              Nama Sekolah / Madrasah
            </label>
            <input
              type="text"
              required
              value={form.schoolName}
              onChange={(e) => setForm({ ...form, schoolName: e.target.value })}
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
            />
          </div>

          <div className="sm:col-span-2">
            <label className="block text-sm font-semibold text-slate-800 mb-1.5">
              Alamat Lembaga
            </label>
            <input
              type="text"
              required
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-800 mb-1.5">
              Judul Ujian (Header, Ruang Ujian &amp; Kartu)
            </label>
            <input
              type="text"
              required
              value={form.examTitle}
              onChange={(e) => setForm({ ...form, examTitle: e.target.value })}
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-800 mb-1.5">
              Tahun Ajaran
            </label>
            <input
              type="text"
              required
              value={form.academicYear}
              onChange={(e) => setForm({ ...form, academicYear: e.target.value })}
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-emerald-700"
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-800 mb-1.5">
              Nama Kepala Sekolah / Madrasah
            </label>
            <input
              type="text"
              required
              value={form.principalName}
              onChange={(e) => setForm({ ...form, principalName: e.target.value })}
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-800 mb-1.5">
              Nama Ketua Panitia Ujian (Tanda Tangan Administrasi &amp; Kartu)
            </label>
            <input
              type="text"
              required
              value={form.committeeChairName}
              onChange={(e) => setForm({ ...form, committeeChairName: e.target.value })}
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
            />
          </div>
        </div>

        {savedNotice && (
          <div
            className={`p-3.5 rounded-xl border text-sm flex items-center gap-2 ${
              savedNotice.ok
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-amber-50 border-amber-300 text-amber-950'
            }`}
          >
            {savedNotice.ok ? (
              <Check className="w-4 h-4 text-emerald-700 shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
            )}
            <span>{savedNotice.msg}</span>
          </div>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={isSaving}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white text-sm font-semibold transition-colors cursor-pointer disabled:opacity-60"
          >
            <Save className="w-4 h-4" />
            <span>{isSaving ? 'Menyimpan...' : 'Simpan Profil Lembaga'}</span>
          </button>
        </div>
      </form>

      {/* Pengaturan Khusus Ubah Sandi Admin */}
      <form
        onSubmit={handlePasswordChange}
        className="bg-white rounded-2xl border border-slate-200 p-6 space-y-5"
      >
        <div className="flex items-center gap-2.5 pb-3 border-b border-slate-100">
          <KeyRound className="w-4 h-4 text-emerald-700" />
          <div>
            <h2 className="font-display font-bold text-slate-900 text-base">
              Pengaturan Ubah Sandi Admin
            </h2>
            <p className="text-xs text-slate-500">
              Ubah PIN / sandi masuk Portal Admin &amp; Panitia secara aman.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Sandi Admin Saat Ini
            </label>
            <input
              type="password"
              required
              value={currentPwd}
              onChange={(e) => setCurrentPwd(e.target.value)}
              placeholder="Masukkan sandi lama"
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Sandi Admin Baru
            </label>
            <input
              type="password"
              required
              value={newPwd}
              onChange={(e) => setNewPwd(e.target.value)}
              placeholder="Minimal 4 karakter"
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Konfirmasi Sandi Baru
            </label>
            <input
              type="password"
              required
              value={confirmPwd}
              onChange={(e) => setConfirmPwd(e.target.value)}
              placeholder="Ulangi sandi baru"
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
            />
          </div>
        </div>

        {pwdFeedback && (
          <div
            className={`p-3.5 rounded-xl text-sm border ${
              pwdFeedback.type === 'ok'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-red-50 border-red-200 text-red-800'
            }`}
          >
            {pwdFeedback.msg}
          </div>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={isSavingPwd}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-sm font-semibold transition-colors cursor-pointer disabled:opacity-60"
          >
            <KeyRound className="w-4 h-4" />
            <span>{isSavingPwd ? 'Menyimpan...' : 'Simpan Sandi Baru'}</span>
          </button>
        </div>
      </form>
    </div>
  );
};
