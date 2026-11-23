import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Cloud, CloudOff, Home, RefreshCw } from 'lucide-react';
import { flushPendingSyncQueue } from '@/src/lib/dataStore';
import { countAnsweredEntries } from '@/src/lib/questionUtils';
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
  const answeredCount = countAnsweredEntries(result.answers);
  const unansweredCount = Math.max(0, result.totalQuestions - answeredCount);
  const isPendingSync = result.syncStatus !== 'synced';

  const [isRetryingSync, setIsRetryingSync] = useState(false);
  const [retryFeedback, setRetryFeedback] = useState('');
  const [autoRetryCount, setAutoRetryCount] = useState(0);
  const [confirmExitWhilePending, setConfirmExitWhilePending] = useState(false);

  // Otomatis mencoba ulang sinkronisasi dengan backoff bertahap + jitter acak (5s → 9s → 14s)
  // agar ratusan siswa yang masuk antrean tidak membanjiri server secara bersamaan.
  useEffect(() => {
    if (!isPendingSync) {
      setConfirmExitWhilePending(false);
      setRetryFeedback('');
      setAutoRetryCount(0);
      return;
    }

    let active = true;
    let timerId: number | null = null;
    let attempt = 0;

    const scheduleNext = () => {
      if (!active) return;
      const baseMs = attempt === 0 ? 3500 : attempt === 1 ? 6500 : attempt === 2 ? 10_000 : 14_000;
      const jitterMs = Math.floor(Math.random() * 3500);
      timerId = window.setTimeout(() => {
        timerId = null;
        if (!active) return;
        if (document.hidden) {
          scheduleNext();
          return;
        }
        attempt += 1;
        setAutoRetryCount(attempt);
        void flushPendingSyncQueue()
          .catch(() => 0)
          .finally(() => {
            if (active) scheduleNext();
          });
      }, baseMs + jitterMs);
    };

    scheduleNext();

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      active = false;
      if (timerId !== null) window.clearTimeout(timerId);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [isPendingSync]);

  const handleManualRetry = async () => {
    if (isRetryingSync) return;
    setIsRetryingSync(true);
    setRetryFeedback('');
    try {
      const syncedCount = await flushPendingSyncQueue();
      if (syncedCount > 0) {
        setRetryFeedback('Jawaban berhasil dikirim dan dinilai oleh server.');
      } else {
        setRetryFeedback(
          'Server masih sibuk atau koneksi belum stabil. Sistem akan mencoba otomatis lagi.'
        );
      }
    } catch {
      setRetryFeedback('Gagal terhubung ke server. Periksa koneksi Wi-Fi / internet Anda.');
    } finally {
      setIsRetryingSync(false);
    }
  };

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
          {isPendingSync && (
            <div className="rounded-xl bg-amber-50 border border-amber-300 p-4 space-y-3">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
                <div className="text-xs sm:text-sm text-amber-950 space-y-1">
                  <div className="font-bold">
                    Jangan tutup halaman ini dulu — jawaban sedang antre dikirim ke server!
                  </div>
                  <p className="text-amber-900/90 leading-relaxed">
                    Jawaban Anda sudah aman tersimpan di perangkat ini. Tunggu beberapa detik hingga
                    status berubah menjadi <strong>Tersinkron ke Cloud</strong>, atau tekan tombol
                    kirim ulang di bawah.
                  </p>
                  {autoRetryCount > 0 && (
                    <p className="text-[11px] font-medium text-amber-800">
                      Sinkronisasi otomatis sedang berjalan (percobaan ke-{autoRetryCount})...
                    </p>
                  )}
                </div>
              </div>

              {retryFeedback && (
                <div className="text-xs font-medium text-amber-900 bg-white/80 border border-amber-200 rounded-lg px-3 py-2">
                  {retryFeedback}
                </div>
              )}

              <button
                type="button"
                disabled={isRetryingSync}
                onClick={() => void handleManualRetry()}
                className="w-full py-2.5 px-4 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-semibold text-xs sm:text-sm flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-60"
              >
                <RefreshCw className={`w-4 h-4 ${isRetryingSync ? 'animate-spin' : ''}`} />
                <span>
                  {isRetryingSync ? 'Mengirim Ulang ke Server...' : 'Kirim Ulang ke Server Sekarang'}
                </span>
              </button>
            </div>
          )}

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

          {confirmExitWhilePending && isPendingSync ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-3.5 space-y-2.5">
              <p className="text-xs text-rose-900 font-medium leading-relaxed">
                Jawaban masih dalam antrean sinkronisasi ke server. Yakin ingin keluar sekarang?
                (Jawaban tetap tersimpan di perangkat ini dan akan dikirim ulang saat halaman
                dibuka kembali.)
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmExitWhilePending(false)}
                  className="flex-1 py-2.5 px-3 rounded-lg border border-slate-300 bg-white text-slate-700 text-xs font-semibold cursor-pointer"
                >
                  Tunggu Sync
                </button>
                <button
                  type="button"
                  onClick={onReturnLogin}
                  className="flex-1 py-2.5 px-3 rounded-lg bg-rose-700 hover:bg-rose-800 text-white text-xs font-semibold cursor-pointer"
                >
                  Tetap Kembali
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                if (isPendingSync) {
                  setConfirmExitWhilePending(true);
                  return;
                }
                onReturnLogin();
              }}
              className="w-full py-3.5 px-5 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white font-semibold text-sm flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <Home className="w-4 h-4" />
              <span>Kembali ke Halaman Login</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
