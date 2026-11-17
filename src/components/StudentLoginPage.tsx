import React, { useMemo, useState } from 'react';
import {
  AlertOctagon,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  GraduationCap,
  KeyRound,
  Lock,
  Maximize2,
  ShieldCheck,
  Ticket,
  UserCheck,
} from 'lucide-react';
import type { ExamResult, ExamSchedule, Participant, SchoolProfile } from '@/src/types/cbt';
import { checkStudentExamLock, validateParticipantAndToken } from '@/src/lib/dataStore';
import { clearPersistedValue, usePersistedState } from '@/src/lib/usePersistedState';

interface StudentLoginPageProps {
  profile: SchoolProfile;
  schedules: ExamSchedule[];
  results: ExamResult[];
  onStartExam: (participant: Participant, schedule: ExamSchedule) => Promise<void>;
  onOpenAdmin: () => void;
}

export const StudentLoginPage: React.FC<StudentLoginPageProps> = ({
  profile,
  schedules,
  results,
  onStartExam,
  onOpenAdmin,
}) => {
  const [participantNumber, setParticipantNumber] = usePersistedState(
    'cbt_draft_student_num_v1',
    ''
  );
  const [tokenInput, setTokenInput] = usePersistedState('cbt_draft_student_token_v1', '');
  const [selectedScheduleId, setSelectedScheduleId] = usePersistedState(
    'cbt_draft_student_sched_v1',
    ''
  );

  const [verifiedParticipant, setVerifiedParticipant] = useState<Participant | null>(null);
  const [validationSource, setValidationSource] = useState<'supabase' | 'local-cache' | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [isChecking, setIsChecking] = useState(false);
  const [isStarting, setIsStarting] = useState(false);

  const availableSubjects = useMemo(() => {
    const active = schedules.filter((s) => s.isActive);
    if (!verifiedParticipant) return active;
    return active.filter((s) => s.targetClasses.includes(verifiedParticipant.className));
  }, [schedules, verifiedParticipant]);

  const activeSelectedSchedule = useMemo(() => {
    if (selectedScheduleId) {
      const found = availableSubjects.find((s) => s.id === selectedScheduleId);
      if (found) return found;
    }
    return availableSubjects[0] || null;
  }, [availableSubjects, selectedScheduleId]);

  const getExistingResultForSchedule = (
    participant: Participant | null,
    schedule: ExamSchedule | null
  ): ExamResult | null => {
    if (!participant || !schedule) return null;
    const normNum = participant.participantNumber.trim().toUpperCase();
    const normSubj = schedule.subject.trim().toLowerCase();
    return (
      results.find(
        (r) =>
          r.participantNumber.trim().toUpperCase() === normNum &&
          (r.examId === schedule.id || r.subject.trim().toLowerCase() === normSubj)
      ) || null
    );
  };

  const selectedSubjectExistingResult = useMemo(
    () => getExistingResultForSchedule(verifiedParticipant, activeSelectedSchedule),
    [verifiedParticipant, activeSelectedSchedule, results]
  );

  const handleVerifyCredentials = async (rawNum?: string, rawToken?: string) => {
    const code = (rawNum ?? participantNumber).trim().toUpperCase();
    const tkn = (rawToken ?? tokenInput).trim().toUpperCase();

    if (!code) {
      setErrorMsg('Masukkan Nomor Peserta sesuai kartu ujian Anda.');
      return;
    }
    if (!tkn) {
      setErrorMsg('Masukkan Kode Token Ujian yang diberikan oleh panitia / pengawas.');
      return;
    }

    setErrorMsg('');
    setIsChecking(true);
    try {
      const res = await validateParticipantAndToken(code, tkn);
      if (res.status === 'not_found' || !res.participant) {
        setVerifiedParticipant(null);
        setErrorMsg(
          `Nomor Peserta "${code}" tidak ditemukan atau tidak aktif. Periksa kembali kartu ujian Anda.`
        );
        return;
      }

      if (res.status === 'wrong_token') {
        setVerifiedParticipant(null);
        setErrorMsg(
          `Token tidak sesuai untuk Nomor Peserta "${code}". Periksa kembali token Anda.`
        );
        return;
      }

      const eligible = schedules.filter(
        (s) => s.isActive && s.targetClasses.includes(res.participant!.className)
      );

      if (eligible.length === 0) {
        setVerifiedParticipant(res.participant);
        setErrorMsg(
          `Tidak ada jadwal mata pelajaran aktif untuk kelas ${res.participant.className} saat ini.`
        );
        return;
      }

      setVerifiedParticipant(res.participant);
      setValidationSource(res.source);
      if (!selectedScheduleId || !eligible.some((s) => s.id === selectedScheduleId)) {
        setSelectedScheduleId(eligible[0].id);
      }
    } finally {
      setIsChecking(false);
    }
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (verifiedParticipant && activeSelectedSchedule) {
      if (selectedSubjectExistingResult) {
        return;
      }
      setIsStarting(true);
      setErrorMsg('');
      try {
        const lockCheck = await checkStudentExamLock(
          verifiedParticipant.participantNumber,
          activeSelectedSchedule
        );
        if (lockCheck.locked) {
          if (lockCheck.reason === 'submitted') {
            setErrorMsg(
              `Anda sudah menyelesaikan ujian mata pelajaran ${activeSelectedSchedule.subject}. Peserta tidak dapat mengulang ujian yang sudah selesai.`
            );
          } else if (lockCheck.reason === 'flagged') {
            setErrorMsg(
              `Akses ujian ${activeSelectedSchedule.subject} terkunci karena pelanggaran perpindahan tab. Hubungi panitia/admin untuk Reset Ujian.`
            );
          } else {
            setErrorMsg(
              `Peserta terdeteksi sudah masuk / memulai ujian pada mata pelajaran ${activeSelectedSchedule.subject}. Hubungi panitia/admin untuk Reset Ujian.`
            );
          }
          return;
        }

        try {
          if (document.documentElement.requestFullscreen) {
            await document.documentElement.requestFullscreen();
          }
        } catch {
          // Handled inside ExamRoom if blocked
        }
        await onStartExam(verifiedParticipant, activeSelectedSchedule);
        clearPersistedValue('cbt_draft_student_num_v1');
        clearPersistedValue('cbt_draft_student_token_v1');
        clearPersistedValue('cbt_draft_student_sched_v1');
      } catch (err) {
        setErrorMsg(
          err instanceof Error ? err.message : 'Gagal memulai sesi ujian. Silakan coba lagi.'
        );
      } finally {
        setIsStarting(false);
      }
      return;
    }
    await handleVerifyCredentials();
  };

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-gradient-to-br from-[#e0f2fe] via-[#bae6fd] to-[#dbeafe] flex flex-col justify-between">
      {/* Modern Light-Blue Motif, Mesh Glow & Subtle Architectural Texture */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        {/* Subtle Dot/Grid Texture */}
        <div
          className="absolute inset-0 opacity-45"
          style={{
            backgroundImage:
              'radial-gradient(rgba(3, 105, 161, 0.18) 1px, transparent 1px)',
            backgroundSize: '24px 24px',
          }}
        />

        {/* Soft Mesh Light Blobs */}
        <div
          className="absolute -top-32 -right-24 w-[520px] h-[520px] rounded-full blur-3xl opacity-60"
          style={{
            background:
              'radial-gradient(circle, rgba(56, 189, 248, 0.45) 0%, rgba(186, 230, 253, 0) 70%)',
          }}
        />
        <div
          className="absolute top-1/3 -left-32 w-[460px] h-[460px] rounded-full blur-3xl opacity-55"
          style={{
            background:
              'radial-gradient(circle, rgba(96, 165, 250, 0.35) 0%, rgba(219, 234, 254, 0) 70%)',
          }}
        />

        {/* Geometric Concentric Motif */}
        <svg
          className="absolute -top-28 -left-24 w-[760px] h-[760px] text-sky-700/10"
          viewBox="0 0 800 800"
          fill="none"
        >
          <circle cx="400" cy="400" r="360" stroke="currentColor" strokeWidth="1.5" strokeDasharray="8 8" />
          <circle cx="400" cy="400" r="290" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="400" cy="400" r="220" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 6" />
          <circle cx="400" cy="400" r="150" stroke="currentColor" strokeWidth="1.2" />
        </svg>

        {/* Diagonal Modern Ribbon Accents */}
        <svg
          className="absolute top-16 right-0 w-[420px] h-[420px] text-sky-600/10"
          viewBox="0 0 400 400"
          fill="none"
        >
          <path d="M40 360L360 40" stroke="currentColor" strokeWidth="1.5" />
          <path d="M100 360L360 100" stroke="currentColor" strokeWidth="1.5" />
          <path d="M160 360L360 160" stroke="currentColor" strokeWidth="1.5" />
          <path d="M220 360L360 220" stroke="currentColor" strokeWidth="1.5" />
        </svg>

        {/* Layered Modern Bottom Waves */}
        <svg
          className="absolute bottom-0 left-0 w-full h-[36vh] min-h-[220px]"
          viewBox="0 0 1440 320"
          preserveAspectRatio="none"
        >
          <path
            fill="rgba(56, 189, 248, 0.22)"
            d="M0,192L60,181.3C120,171,240,149,360,165.3C480,181,600,235,720,234.7C840,235,960,181,1080,154.7C1200,128,1320,128,1380,128L1440,128L1440,320L1380,320C1320,320,1200,320,1080,320C960,320,840,320,720,320C600,320,480,320,360,320C240,320,120,320,60,320L0,320Z"
          />
          <path
            fill="rgba(14, 165, 233, 0.18)"
            d="M0,256L80,245.3C160,235,320,213,480,218.7C640,224,800,256,960,250.7C1120,245,1280,203,1360,181.3L1440,160L1440,320L1360,320C1280,320,1120,320,960,320C800,320,640,320,480,320C320,320,160,320,80,320L0,320Z"
          />
        </svg>
      </div>

      {/* Top Subtle Utility Bar */}
      <header className="relative z-10 w-full max-w-6xl mx-auto px-6 py-5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5 text-sky-950 text-sm">
          <ShieldCheck className="w-4 h-4 text-sky-700 shrink-0" />
          <span className="font-semibold tracking-tight whitespace-nowrap">
            Sistem Ujian Berbasis Komputer
          </span>
        </div>
        <button
          type="button"
          onClick={onOpenAdmin}
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-white/80 hover:bg-white text-sky-950 text-xs font-semibold backdrop-blur-sm border border-sky-200/90 shadow-xs transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Lock className="w-3.5 h-3.5 text-sky-700" />
          <span>Portal Admin &amp; Panitia</span>
        </button>
      </header>

      {/* Main Centered Student Login Card */}
      <main className="relative z-10 flex-1 flex items-center justify-center px-4 py-6 sm:px-6">
        <div className="w-full max-w-[480px]">
          {/* Dynamic School Branding Above Card */}
          <div className="flex flex-col items-center text-center mb-5">
            {profile.logoDataUrl ? (
              <img
                src={profile.logoDataUrl}
                alt={`Logo ${profile.schoolName}`}
                referrerPolicy="no-referrer"
                className="w-28 h-28 sm:w-32 sm:h-32 object-contain mb-3 drop-shadow-sm"
              />
            ) : (
              <GraduationCap className="w-16 h-16 text-sky-800 mb-3" />
            )}
            <h1 className="font-display text-2xl sm:text-[26px] font-bold text-slate-900 tracking-tight text-balance">
              {profile.schoolName}
            </h1>
            <p className="mt-1 text-sm text-sky-950/80 font-medium">
              {profile.examTitle}
              <span aria-hidden="true" className="mx-2 text-sky-700/60">·</span>
              Tahun Ajaran {profile.academicYear}
            </p>
          </div>

          {/* Crisp High-Contrast Login Card */}
          <div className="bg-white/95 backdrop-blur-md rounded-2xl shadow-xl shadow-sky-950/10 border border-sky-200/80 overflow-hidden">
            <div className="bg-[#0369a1] px-6 py-4 text-white text-center">
              <div className="inline-flex items-center justify-center gap-2">
                <KeyRound className="w-5 h-5 text-sky-200 shrink-0" />
                <h2 className="font-display text-base font-semibold tracking-tight">
                  Login Peserta Ujian
                </h2>
              </div>
              <p className="text-xs text-sky-100/90 mt-0.5">
                Masukkan Nomor Peserta, Kode Token, dan pilih Mata Pelajaran
              </p>
            </div>

            <form onSubmit={handleFormSubmit} className="p-6 space-y-4">
              {/* Nomor Peserta */}
              <div>
                <label
                  htmlFor="participant-number"
                  className="block text-sm font-semibold text-slate-800 mb-1.5 text-center"
                >
                  Nomor Peserta
                </label>
                <input
                  id="participant-number"
                  type="text"
                  autoComplete="off"
                  autoFocus
                  value={participantNumber}
                  onChange={(e) => {
                    setParticipantNumber(e.target.value.toUpperCase());
                    if (verifiedParticipant) setVerifiedParticipant(null);
                    if (errorMsg) setErrorMsg('');
                  }}
                  placeholder="Contoh: 2026-7A-001"
                  className="w-full px-4 py-2.5 rounded-xl border border-slate-300 bg-slate-50/60 text-slate-900 font-mono text-sm sm:text-base font-semibold tracking-wider text-center placeholder:font-sans placeholder:font-normal placeholder:tracking-normal placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-600 focus:border-sky-600 focus:bg-white transition-all"
                />
              </div>

              {/* Token Input */}
              <div>
                <label
                  htmlFor="participant-token"
                  className="block text-sm font-semibold text-slate-800 mb-1.5 text-center"
                >
                  Token Ujian
                </label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Ticket className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      id="participant-token"
                      type="text"
                      autoComplete="off"
                      value={tokenInput}
                      onChange={(e) => {
                        setTokenInput(e.target.value.toUpperCase());
                        if (verifiedParticipant) setVerifiedParticipant(null);
                        if (errorMsg) setErrorMsg('');
                      }}
                      placeholder="Masukkan Token (mis. TKN7A1)"
                      className="w-full pl-10 pr-10 py-2.5 rounded-xl border border-slate-300 bg-slate-50/60 text-slate-900 font-mono text-sm sm:text-base font-bold tracking-widest text-center placeholder:font-sans placeholder:font-normal placeholder:tracking-normal placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-600 focus:border-sky-600 focus:bg-white transition-all"
                    />
                  </div>

                  {!verifiedParticipant && (
                    <button
                      type="button"
                      onClick={() => void handleVerifyCredentials()}
                      disabled={isChecking || !participantNumber.trim() || !tokenInput.trim()}
                      className="px-4 py-2.5 rounded-xl bg-sky-50 hover:bg-sky-100 text-sky-900 font-semibold text-sm border border-sky-200 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {isChecking ? 'Cek...' : 'Validasi'}
                    </button>
                  )}
                </div>
              </div>

              {/* Pilihan Mata Pelajaran */}
              <div>
                <label
                  htmlFor="subject-select"
                  className="block text-sm font-semibold text-slate-800 mb-1.5 text-center"
                >
                  Mata Pelajaran yang Diujikan
                </label>
                <div className="relative">
                  <BookOpen className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <select
                    id="subject-select"
                    value={activeSelectedSchedule?.id || ''}
                    onChange={(e) => setSelectedScheduleId(e.target.value)}
                    disabled={availableSubjects.length === 0}
                    className="w-full pl-10 pr-10 py-2.5 rounded-xl border border-slate-300 bg-white text-slate-900 text-sm font-semibold text-center [text-align-last:center] focus:outline-none focus:ring-2 focus:ring-sky-600 focus:border-sky-600"
                  >
                    {availableSubjects.length === 0 ? (
                      <option value="">Tidak ada mata pelajaran aktif</option>
                    ) : (
                      availableSubjects.map((sched) => {
                        const existing = getExistingResultForSchedule(verifiedParticipant, sched);
                        const suffix =
                          existing?.status === 'submitted'
                            ? ' — Sudah Selesai'
                            : existing?.status === 'flagged'
                              ? ' — Terkunci Pelanggaran'
                              : existing?.status === 'in_progress'
                                ? ' — Sudah Masuk Ujian'
                                : '';
                        return (
                          <option key={sched.id} value={sched.id}>
                            {sched.subject} ({sched.durationMinutes} Menit){suffix}
                          </option>
                        );
                      })
                    )}
                  </select>
                </div>
              </div>

              {errorMsg && (
                <div
                  role="alert"
                  className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-red-800 text-sm leading-relaxed"
                >
                  {errorMsg}
                </div>
              )}

              {verifiedParticipant && activeSelectedSchedule && (
                <div className="rounded-xl bg-emerald-50/80 border border-emerald-200 p-4 space-y-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2 text-emerald-900 font-semibold text-sm">
                      <UserCheck className="w-4 h-4 text-emerald-700 shrink-0" />
                      <span>Peserta &amp; Token Terverifikasi</span>
                    </div>
                    <span className="text-xs text-emerald-700 font-medium">
                      {validationSource === 'supabase' ? 'Supabase Live' : 'Cache Lokal'}
                    </span>
                  </div>

                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm pt-1.5 border-t border-emerald-200/70">
                    <div>
                      <dt className="text-xs text-slate-500">Nama Lengkap</dt>
                      <dd className="font-semibold text-slate-900 truncate">
                        {verifiedParticipant.fullName}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-slate-500">Kelas</dt>
                      <dd className="font-mono font-bold text-emerald-900">
                        {verifiedParticipant.className}
                      </dd>
                    </div>
                    <div className="col-span-2">
                      <dt className="text-xs text-slate-500">Mata Pelajaran Terpilih</dt>
                      <dd className="font-semibold text-slate-900">
                        {activeSelectedSchedule.subject} ·{' '}
                        <span className="font-mono tabular-nums">
                          {activeSelectedSchedule.durationMinutes} Menit
                        </span>
                      </dd>
                    </div>
                  </dl>
                </div>
              )}

              {verifiedParticipant && activeSelectedSchedule && selectedSubjectExistingResult && (
                <div
                  role="alert"
                  className="rounded-xl bg-amber-50 border border-amber-300 p-4 flex items-start gap-3 text-amber-950"
                >
                  <AlertOctagon className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
                  <div className="text-xs sm:text-sm space-y-1 leading-relaxed">
                    <div className="font-bold">
                      {selectedSubjectExistingResult.status === 'submitted'
                        ? 'Ujian Mata Pelajaran Ini Sudah Diselesaikan'
                        : selectedSubjectExistingResult.status === 'flagged'
                          ? 'Akses Ujian Terkunci (Pelanggaran Terdeteksi)'
                          : 'Peserta Sudah Masuk / Memulai Ujian Ini'}
                    </div>
                    <p className="text-amber-900">
                      {selectedSubjectExistingResult.status === 'submitted'
                        ? `Anda telah mengumpulkan ujian mata pelajaran ${activeSelectedSchedule.subject}. Setiap peserta hanya dapat mengikuti ujian satu kali pada mata pelajaran yang sama.`
                        : selectedSubjectExistingResult.status === 'flagged'
                          ? `Sesi ujian ${activeSelectedSchedule.subject} terkunci karena melewati batas perpindahan tab. Hubungi panitia/admin untuk membuka kunci melalui menu Reset Ujian.`
                          : `Nomor peserta ${verifiedParticipant.participantNumber} terdeteksi sudah masuk ujian pada mata pelajaran ${activeSelectedSchedule.subject}. Anda tidak dapat memulai ujian lagi kecuali dibuka kunci oleh panitia/admin di menu Reset Ujian.`}
                    </p>
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={
                  isChecking ||
                  isStarting ||
                  Boolean(verifiedParticipant && activeSelectedSchedule && selectedSubjectExistingResult)
                }
                className="w-full py-3.5 px-5 rounded-xl bg-[#0369a1] hover:bg-[#075985] text-white font-semibold text-sm sm:text-base flex items-center justify-center gap-2.5 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed transition-all cursor-pointer"
              >
                {verifiedParticipant && activeSelectedSchedule ? (
                  selectedSubjectExistingResult ? (
                    <>
                      <Lock className="w-4 h-4" />
                      <span>
                        {selectedSubjectExistingResult.status === 'submitted'
                          ? 'Ujian Sudah Selesai'
                          : 'Ujian Terkunci — Hubungi Admin'}
                      </span>
                    </>
                  ) : (
                    <>
                      <Maximize2 className="w-4 h-4" />
                      <span>{isStarting ? 'Menyiapkan Ruang Ujian...' : 'Mulai Ujian Sekarang'}</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )
                ) : (
                  <>
                    <CheckCircle2 className="w-4 h-4" />
                    <span>{isChecking ? 'Memvalidasi...' : 'Validasi Nomor & Token'}</span>
                  </>
                )}
              </button>
            </form>
          </div>
        </div>
      </main>

      <footer className="relative z-10 py-4 px-6 text-center text-xs text-sky-950/75 font-medium">
        {profile.schoolName}
        <span aria-hidden="true" className="mx-2">·</span>
        {profile.address}
      </footer>
    </div>
  );
};
