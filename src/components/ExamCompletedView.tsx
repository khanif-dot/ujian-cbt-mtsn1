import React from 'react';
import { CheckCircle2, Cloud, CloudOff, Home } from 'lucide-react';
import type { ExamResult, SchoolProfile } from '@/src/types/cbt';

interface ExamCompletedViewProps {
  profile: SchoolProfile;
  result: ExamResult;
  onReturnLogin: () => void;
}

export const ExamCompletedView: React.FC<ExamCompletedViewProps> = ({
  profile,
  result,
  onReturnLogin,
}) => {
  const answeredCount = Object.keys(result.answers || {}).length;
  const unansweredCount = Math.max(0, result.totalQuestions - answeredCount);

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#022c22] via-[#065f46] to-[#10b981] flex items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl border border-emerald-900/10 overflow-hidden">
        <div className="bg-[#064e3b] px-6 py-7 text-white text-center space-y-2.5">
          {profile.logoDataUrl && (
            <img
              src={profile.logoDataUrl}
              alt={`Logo ${profile.schoolName}`}
              referrerPolicy="no-referrer"
              className="w-20 h-20 mx-auto object-contain"
            />
          )}
          <div className="inline-flex items-center justify-center gap-1.5 text-emerald-200 text-xs font-semibold">
            <CheckCircle2 className="w-4 h-4" />
            <span>
              {result.status === 'flagged'
                ? 'Ujian Dikumpulkan (Tercatat Pelanggaran Tab)'
                : 'Ujian Berhasil Dikumpulkan'}
            </span>
          </div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-balance">
            {result.status === 'flagged'
              ? 'Sesi Ujian Anda Telah Dihentikan & Disimpan'
              : 'Selamat, Anda Telah Menyelesaikan Ujian!'}
          </h1>
          <p className="text-sm text-emerald-100/90">
            {profile.examTitle} · {result.subject || result.examTitle}
          </p>
        </div>

        <div className="p-6 sm:p-8 space-y-6">
          <p className="text-sm text-slate-600 text-center leading-relaxed">
            Terima kasih telah mengikuti ujian dengan tertib dan jujur di{' '}
            <strong className="text-slate-900">{profile.schoolName}</strong>. Jawaban Anda telah
            disimpan ke sistem sekolah.
          </p>

          {/* Ringkasan Jumlah Soal Dijawab & Tidak Dijawab (Tanpa Menampilkan Nilai Akhir) */}
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4 text-center">
              <div className="text-xs font-medium text-emerald-800">Total Soal Dijawab</div>
              <div className="font-mono text-3xl font-bold text-[#064e3b] tabular-nums mt-1">
                {answeredCount}
              </div>
              <div className="text-xs text-emerald-700/80 mt-0.5 font-mono tabular-nums">
                dari {result.totalQuestions} soal
              </div>
            </div>

            <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 text-center">
              <div className="text-xs font-medium text-slate-600">Tidak Dijawab</div>
              <div className="font-mono text-3xl font-bold text-slate-900 tabular-nums mt-1">
                {unansweredCount}
              </div>
              <div className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
                dari {result.totalQuestions} soal
              </div>
            </div>
          </div>

          <dl className="divide-y divide-slate-100 text-sm">
            <div className="py-2.5 flex items-center justify-between gap-4">
              <dt className="text-slate-500">Nama Peserta</dt>
              <dd className="font-semibold text-slate-900 text-right">{result.studentName}</dd>
            </div>
            <div className="py-2.5 flex items-center justify-between gap-4">
              <dt className="text-slate-500">Nomor Peserta</dt>
              <dd className="font-mono font-bold text-slate-900">{result.participantNumber}</dd>
            </div>
            <div className="py-2.5 flex items-center justify-between gap-4">
              <dt className="text-slate-500">Kelas</dt>
              <dd className="font-mono font-semibold text-slate-900">{result.className}</dd>
            </div>
            <div className="py-2.5 flex items-center justify-between gap-4">
              <dt className="text-slate-500">Mata Pelajaran</dt>
              <dd className="font-medium text-slate-800 text-right">
                {result.subject || result.examTitle}
              </dd>
            </div>
            <div className="py-2.5 flex items-center justify-between gap-4">
              <dt className="text-slate-500">Status Penyimpanan</dt>
              <dd className="inline-flex items-center gap-1.5 font-medium text-slate-800">
                {result.syncStatus === 'synced' ? (
                  <>
                    <Cloud className="w-4 h-4 text-emerald-700" />
                    <span className="text-emerald-800">Tersinkron ke Cloud</span>
                  </>
                ) : (
                  <>
                    <CloudOff className="w-4 h-4 text-amber-600" />
                    <span className="text-amber-800">Tersimpan Lokal (Antrean Sync)</span>
                  </>
                )}
              </dd>
            </div>
          </dl>

          <button
            type="button"
            onClick={onReturnLogin}
            className="w-full py-3.5 px-5 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white font-semibold text-sm flex items-center justify-center gap-2 transition-colors cursor-pointer"
          >
            <Home className="w-4 h-4" />
            <span>Kembali ke Halaman Login</span>
          </button>
        </div>
      </div>
    </div>
  );
};
