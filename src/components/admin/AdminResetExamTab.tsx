import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Lock,
  RotateCcw,
  Search,
  ShieldAlert,
  Unlock,
  Users,
  X,
} from 'lucide-react';
import {
  ALL_CLASSES,
  type ExamResult,
  type ExamSchedule,
} from '@/src/types/cbt';

interface AdminResetExamTabProps {
  schedules: ExamSchedule[];
  results: ExamResult[];
  onResetExamResults: (resultIds: string[]) => Promise<void>;
}

type ResetFilterMode = 'needs_unlock' | 'violation' | 'in_progress' | 'submitted' | 'ALL';

export const AdminResetExamTab: React.FC<AdminResetExamTabProps> = ({
  schedules,
  results,
  onResetExamResults,
}) => {
  const [filterMode, setFilterMode] = useState<ResetFilterMode>('needs_unlock');
  const [subjectFilter, setSubjectFilter] = useState<string>('ALL');
  const [classFilter, setClassFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirmResetTargets, setConfirmResetTargets] = useState<ExamResult[]>([]);
  const [isResetting, setIsResetting] = useState(false);
  const [feedback, setFeedback] = useState('');

  const subjects = useMemo(() => {
    const set = new Set<string>(schedules.map((s) => s.subject));
    results.forEach((r) => {
      if (r.subject) set.add(r.subject);
    });
    return Array.from(set).sort();
  }, [schedules, results]);

  const counts = useMemo(() => {
    const needsUnlock = results.filter(
      (r) => r.status === 'in_progress' || r.status === 'flagged' || r.tabSwitchCount > 0
    ).length;
    const violation = results.filter(
      (r) => r.status === 'flagged' || r.tabSwitchCount > 0
    ).length;
    const inProgress = results.filter((r) => r.status === 'in_progress').length;
    const submitted = results.filter((r) => r.status === 'submitted').length;
    return {
      needsUnlock,
      violation,
      inProgress,
      submitted,
      all: results.length,
    };
  }, [results]);

  const filteredResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return results.filter((r) => {
      if (filterMode === 'needs_unlock') {
        if (r.status !== 'in_progress' && r.status !== 'flagged' && r.tabSwitchCount === 0) {
          return false;
        }
      } else if (filterMode === 'violation') {
        if (r.status !== 'flagged' && r.tabSwitchCount === 0) return false;
      } else if (filterMode === 'in_progress') {
        if (r.status !== 'in_progress') return false;
      } else if (filterMode === 'submitted') {
        if (r.status !== 'submitted') return false;
      }

      if (subjectFilter !== 'ALL' && r.subject !== subjectFilter) return false;
      if (classFilter !== 'ALL' && r.className !== classFilter) return false;
      if (
        q &&
        !r.studentName.toLowerCase().includes(q) &&
        !r.participantNumber.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [results, filterMode, subjectFilter, classFilter, searchQuery]);

  const allVisibleSelected =
    filteredResults.length > 0 &&
    filteredResults.every((r) => selectedIds.includes(r.id));

  const toggleSelectAllVisible = () => {
    if (allVisibleSelected) {
      const visibleSet = new Set(filteredResults.map((r) => r.id));
      setSelectedIds((prev) => prev.filter((id) => !visibleSet.has(id)));
    } else {
      const merged = new Set([...selectedIds, ...filteredResults.map((r) => r.id)]);
      setSelectedIds(Array.from(merged));
    }
  };

  const toggleSelectOne = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleConfirmReset = async () => {
    if (confirmResetTargets.length === 0) return;
    setIsResetting(true);
    setFeedback('');
    try {
      const ids = confirmResetTargets.map((r) => r.id);
      await onResetExamResults(ids);
      setSelectedIds((prev) => prev.filter((id) => !ids.includes(id)));
      setFeedback(
        confirmResetTargets.length === 1
          ? `Ujian ${confirmResetTargets[0].subject} untuk ${confirmResetTargets[0].studentName} (${confirmResetTargets[0].participantNumber}) berhasil direset dan dibuka kuncinya.`
          : `${confirmResetTargets.length} sesi ujian peserta berhasil direset dan dibuka kuncinya.`
      );
      setConfirmResetTargets([]);
    } finally {
      setIsResetting(false);
    }
  };

  const selectedRecords = useMemo(
    () => results.filter((r) => selectedIds.includes(r.id)),
    [results, selectedIds]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 tracking-tight">
            Reset &amp; Buka Kunci Ujian Peserta
          </h1>
          <p className="text-sm text-slate-600 mt-0.5">
            Buka kunci peserta yang melanggar batas pindah tab, sudah melakukan login mulai ujian, atau perlu mengulang ujian pada mata pelajaran tertentu.
          </p>
        </div>

        {selectedRecords.length > 0 && (
          <button
            type="button"
            onClick={() => setConfirmResetTargets(selectedRecords)}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold transition-colors cursor-pointer whitespace-nowrap self-start sm:self-auto"
          >
            <RotateCcw className="w-4 h-4" />
            <span>Reset Terpilih ({selectedRecords.length})</span>
          </button>
        )}
      </div>

      {feedback && (
        <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-900 text-sm flex items-center gap-2.5">
          <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
          <span>{feedback}</span>
        </div>
      )}

      {/* KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
          <div className="text-xs font-medium text-slate-500">Terdeteksi Pelanggaran / Terkunci</div>
          <div className="font-mono text-3xl font-bold text-red-700 tabular-nums mt-1.5">
            {counts.violation}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Peserta keluar tab / melewati batas pengawas
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
          <div className="text-xs font-medium text-slate-500">Sudah Login / Sedang Ujian</div>
          <div className="font-mono text-3xl font-bold text-amber-700 tabular-nums mt-1.5">
            {counts.inProgress}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Terkunci dari login ulang sampai direset
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
          <div className="text-xs font-medium text-slate-500">Telah Selesai Mengumpulkan</div>
          <div className="font-mono text-3xl font-bold text-emerald-700 tabular-nums mt-1.5">
            {counts.submitted}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Dapat direset jika perlu ujian susulan/ulang
          </div>
        </div>
      </div>

      {/* Main Reset Table */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        {/* Status Filter Bar */}
        <div className="px-4 sm:px-5 pt-4 pb-3 border-b border-slate-100 flex flex-wrap items-center gap-2 bg-slate-50/70">
          {(
            [
              { key: 'needs_unlock', label: 'Perlu Buka Kunci', count: counts.needsUnlock },
              { key: 'violation', label: 'Pelanggaran', count: counts.violation },
              { key: 'in_progress', label: 'Sudah Login / Aktif', count: counts.inProgress },
              { key: 'submitted', label: 'Telah Selesai', count: counts.submitted },
              { key: 'ALL', label: 'Semua Peserta', count: counts.all },
            ] as const
          ).map((tab) => {
            const active = filterMode === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setFilterMode(tab.key)}
                className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold border transition-colors cursor-pointer ${
                  active
                    ? 'bg-[#064e3b] border-[#064e3b] text-white'
                    : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'
                }`}
              >
                <span>{tab.label}</span>
                <span
                  className={`font-mono px-1.5 py-0.5 rounded-md text-[11px] tabular-nums ${
                    active ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  {tab.count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Search & Dropdown Filters */}
        <div className="p-4 sm:p-5 border-b border-slate-200 flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari nomor peserta atau nama..."
              className="w-full pl-10 pr-4 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <select
              value={subjectFilter}
              onChange={(e) => setSubjectFilter(e.target.value)}
              className="px-3 py-2 rounded-xl border border-slate-300 bg-white text-sm font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-700"
            >
              <option value="ALL">Semua Mata Pelajaran</option>
              {subjects.map((subj) => (
                <option key={subj} value={subj}>
                  {subj}
                </option>
              ))}
            </select>

            <select
              value={classFilter}
              onChange={(e) => setClassFilter(e.target.value)}
              className="px-3 py-2 rounded-xl border border-slate-300 bg-white text-sm font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-700"
            >
              <option value="ALL">Semua Kelas (7A–9I)</option>
              {ALL_CLASSES.map((cls) => (
                <option key={cls} value={cls}>
                  Kelas {cls}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                <th className="py-3 px-4 w-10">
                  <input
                    type="checkbox"
                    aria-label="Pilih semua baris"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAllVisible}
                    className="w-4 h-4 accent-[#064e3b] cursor-pointer"
                  />
                </th>
                <th className="py-3 px-4">Nomor Peserta</th>
                <th className="py-3 px-4">Nama Peserta</th>
                <th className="py-3 px-4">Kelas</th>
                <th className="py-3 px-4">Mata Pelajaran</th>
                <th className="py-3 px-4">Status Kunci</th>
                <th className="py-3 px-4 text-right">Pindah Tab</th>
                <th className="py-3 px-4 text-right">Aksi Reset</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {filteredResults.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 px-4 text-center text-slate-500">
                    <div className="flex flex-col items-center gap-2">
                      <Users className="w-6 h-6 text-slate-400" />
                      <span>Tidak ada data peserta yang cocok pada filter ini.</span>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredResults.map((res) => {
                  const isChecked = selectedIds.includes(res.id);
                  const isFlagged = res.status === 'flagged';
                  const hasWarning = res.tabSwitchCount > 0;
                  return (
                    <tr key={res.id} className="hover:bg-slate-50/70 transition-colors">
                      <td className="py-3 px-4">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleSelectOne(res.id)}
                          aria-label={`Pilih ${res.studentName}`}
                          className="w-4 h-4 accent-[#064e3b] cursor-pointer"
                        />
                      </td>
                      <td className="py-3 px-4 font-mono font-semibold text-slate-900 whitespace-nowrap">
                        {res.participantNumber}
                      </td>
                      <td className="py-3 px-4 font-medium text-slate-900">{res.studentName}</td>
                      <td className="py-3 px-4 font-mono font-semibold text-emerald-900">
                        {res.className}
                      </td>
                      <td className="py-3 px-4 text-slate-700">{res.subject || '-'}</td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        {isFlagged ? (
                          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-red-700 bg-red-50 border border-red-200 px-2.5 py-1 rounded-lg">
                            <Lock className="w-3.5 h-3.5" />
                            <span>Terkunci Pelanggaran</span>
                          </span>
                        ) : res.status === 'in_progress' ? (
                          <span
                            className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-lg border ${
                              hasWarning
                                ? 'text-amber-800 bg-amber-50 border-amber-200'
                                : 'text-emerald-800 bg-emerald-50 border-emerald-200'
                            }`}
                          >
                            <Lock className="w-3.5 h-3.5" />
                            <span>
                              {hasWarning ? 'Aktif + Peringatan' : 'Sudah Login / Sedang Ujian'}
                            </span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 bg-slate-100 border border-slate-200 px-2.5 py-1 rounded-lg">
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-700" />
                            <span>Selesai Ujian (Nilai {res.score.toFixed(1)})</span>
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono text-right tabular-nums">
                        {res.tabSwitchCount > 0 ? (
                          <span className="inline-flex items-center gap-1 text-red-700 font-semibold">
                            <ShieldAlert className="w-3.5 h-3.5" />
                            {res.tabSwitchCount}x
                          </span>
                        ) : (
                          <span className="text-slate-500">0x</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => setConfirmResetTargets([res])}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300 text-xs font-semibold transition-colors cursor-pointer"
                        >
                          <Unlock className="w-3.5 h-3.5" />
                          <span>Reset &amp; Buka Kunci</span>
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Confirmation Modal */}
      {confirmResetTargets.length > 0 && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden">
            <div className="px-5 py-4 bg-amber-50 border-b border-amber-200 flex items-center justify-between">
              <div className="flex items-center gap-2 font-display font-bold text-amber-950 text-base">
                <AlertTriangle className="w-5 h-5 text-amber-700" />
                <span>Konfirmasi Reset &amp; Buka Kunci Ujian</span>
              </div>
              <button
                type="button"
                disabled={isResetting}
                onClick={() => setConfirmResetTargets([])}
                className="p-1 rounded-lg text-amber-900/70 hover:bg-amber-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              {confirmResetTargets.length === 1 ? (
                <div className="text-sm text-slate-700 space-y-2 leading-relaxed">
                  <p>
                    Anda akan mereset dan membuka kunci ujian mata pelajaran{' '}
                    <strong className="text-slate-900">{confirmResetTargets[0].subject}</strong> untuk peserta:
                  </p>
                  <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 text-xs space-y-1">
                    <div>
                      Nama: <strong className="text-slate-900">{confirmResetTargets[0].studentName}</strong>
                    </div>
                    <div>
                      Nomor Peserta:{' '}
                      <code className="font-mono font-bold text-slate-900">
                        {confirmResetTargets[0].participantNumber}
                      </code>{' '}
                      · Kelas <strong className="font-mono">{confirmResetTargets[0].className}</strong>
                    </div>
                  </div>
                  <p className="text-xs text-slate-500">
                    Catatan pelanggaran dan status sesi sebelumnya akan dihapus agar peserta dapat login ulang dan memulai ujian kembali.
                  </p>
                </div>
              ) : (
                <div className="text-sm text-slate-700 space-y-2 leading-relaxed">
                  <p>
                    Anda akan mereset dan membuka kunci{' '}
                    <strong className="text-slate-900">{confirmResetTargets.length} sesi ujian peserta</strong> yang dipilih.
                  </p>
                  <p className="text-xs text-slate-500">
                    Seluruh peserta terpilih akan dapat login dan memulai ujian kembali pada mata pelajaran terkait.
                  </p>
                </div>
              )}

              <div className="flex items-center gap-2.5 pt-1">
                <button
                  type="button"
                  disabled={isResetting}
                  onClick={() => setConfirmResetTargets([])}
                  className="flex-1 py-2.5 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-50 text-xs sm:text-sm font-semibold cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="button"
                  disabled={isResetting}
                  onClick={() => void handleConfirmReset()}
                  className="flex-1 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs sm:text-sm font-semibold cursor-pointer disabled:opacity-60"
                >
                  {isResetting ? 'Memproses...' : 'Ya, Reset & Buka Kunci'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
