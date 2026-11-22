import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Dices,
  FileSpreadsheet,
  Pencil,
  Plus,
  Search,
  Ticket,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { ALL_CLASSES, type Participant } from '@/src/types/cbt';
import {
  downloadParticipantsTemplate,
  generateRandomToken,
  parseParticipantsExcel,
} from '@/src/lib/importers';
import { usePersistedState } from '@/src/lib/usePersistedState';

interface AdminParticipantsTabProps {
  participants: Participant[];
  onUpsertParticipants: (items: Participant[]) => Promise<void>;
  onDeleteParticipant: (id: string) => Promise<void>;
  onDeleteAllParticipants: () => Promise<void>;
}

export const AdminParticipantsTab: React.FC<AdminParticipantsTabProps> = ({
  participants,
  onUpsertParticipants,
  onDeleteParticipant,
  onDeleteAllParticipants,
}) => {
  const [classFilter, setClassFilter] = usePersistedState('cbt_draft_ptc_class_filter_v1', 'ALL');
  const [searchQuery, setSearchQuery] = usePersistedState('cbt_draft_ptc_search_v1', '');

  const [newNumber, setNewNumber] = usePersistedState('cbt_draft_ptc_new_num_v1', '');
  const [newToken, setNewToken] = usePersistedState('cbt_draft_ptc_new_token_v1', () =>
    generateRandomToken(6)
  );
  const [newName, setNewName] = usePersistedState('cbt_draft_ptc_new_name_v1', '');
  const [newClass, setNewClass] = usePersistedState('cbt_draft_ptc_new_class_v1', ALL_CLASSES[0]);

  // Bulk Token Assignment State
  const [bulkScope, setBulkScope] = usePersistedState('cbt_draft_ptc_bulk_scope_v1', 'ALL');
  const [bulkTokenValue, setBulkTokenValue] = usePersistedState('cbt_draft_ptc_bulk_token_v1', '');

  // Inline Per-Student Token Edit State
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingToken, setEditingToken] = useState('');

  // Full Participant Edit Modal State
  const [editModalParticipant, setEditModalParticipant] = useState<Participant | null>(null);
  const [editFormNumber, setEditFormNumber] = useState('');
  const [editFormName, setEditFormName] = useState('');
  const [editFormClass, setEditFormClass] = useState<string>(ALL_CLASSES[0]);
  const [editFormToken, setEditFormToken] = useState('');
  const [editFormActive, setEditFormActive] = useState(true);
  const [editModalError, setEditModalError] = useState('');

  const [importFeedback, setImportFeedback] = useState('');
  const [importError, setImportError] = useState('');
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [isDeletingAll, setIsDeletingAll] = useState(false);
  const [listPage, setListPage] = useState(1);
  const [showAllRows, setShowAllRows] = useState(false);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return participants.filter((p) => {
      if (classFilter !== 'ALL' && p.className !== classFilter) return false;
      if (
        q &&
        !p.fullName.toLowerCase().includes(q) &&
        !p.participantNumber.toLowerCase().includes(q) &&
        !(p.token || '').toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [participants, classFilter, searchQuery]);

  useEffect(() => {
    setListPage(1);
  }, [classFilter, searchQuery]);

  const PAGE_SIZE = 50;
  const MAX_SHOW_ALL = 300;
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safeListPage = Math.min(listPage, totalPages);
  const displayedParticipants = useMemo(() => {
    if (showAllRows) {
      return filtered.length <= MAX_SHOW_ALL
        ? filtered
        : filtered.slice(0, MAX_SHOW_ALL);
    }
    if (filtered.length <= PAGE_SIZE) {
      return filtered;
    }
    const start = (safeListPage - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, showAllRows, safeListPage]);

  const handleAddSingle = async (e: React.FormEvent) => {
    e.preventDefault();
    setImportFeedback('');
    setImportError('');
    const num = newNumber.trim().toUpperCase();
    const name = newName.trim();
    const tkn = (newToken.trim() || generateRandomToken(6)).toUpperCase();
    if (!num || !name) return;

    const existing = participants.find(
      (p) => p.participantNumber.trim().toUpperCase() === num
    );
    if (existing) {
      setImportError(
        `Nomor peserta "${num}" sudah terdaftar atas nama ${existing.fullName} (Kelas ${existing.className}). Gunakan tombol Edit pada baris peserta jika ingin mengubah datanya.`
      );
      return;
    }

    const id =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? `ptc-${crypto.randomUUID()}`
        : `ptc-${num.toLowerCase().replace(/[^a-z0-9-]/g, '')}-${Date.now()}`;

    await onUpsertParticipants([
      {
        id,
        participantNumber: num,
        token: tkn,
        fullName: name,
        className: newClass,
        isActive: true,
        createdAt: new Date().toISOString(),
      },
    ]);
    setNewNumber('');
    setNewName('');
    setNewToken(generateRandomToken(6));
    setImportFeedback(`Peserta "${name}" (${num}) dengan token ${tkn} berhasil ditambahkan.`);
  };

  const openEditParticipantModal = (p: Participant) => {
    setEditModalParticipant(p);
    setEditFormNumber(p.participantNumber);
    setEditFormName(p.fullName);
    setEditFormClass(p.className);
    setEditFormToken(p.token || '');
    setEditFormActive(p.isActive);
    setEditModalError('');
  };

  const handleSaveParticipantModal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editModalParticipant) return;
    setEditModalError('');

    const num = editFormNumber.trim().toUpperCase();
    const name = editFormName.trim();
    const tkn = (editFormToken.trim() || generateRandomToken(6)).toUpperCase();

    if (!num || !name) {
      setEditModalError('Nomor peserta dan nama lengkap wajib diisi.');
      return;
    }

    const duplicate = participants.find(
      (p) =>
        p.id !== editModalParticipant.id &&
        p.participantNumber.trim().toUpperCase() === num
    );
    if (duplicate) {
      setEditModalError(
        `Nomor peserta "${num}" sudah dipakai oleh ${duplicate.fullName} (Kelas ${duplicate.className}).`
      );
      return;
    }

    await onUpsertParticipants([
      {
        ...editModalParticipant,
        participantNumber: num,
        fullName: name,
        className: editFormClass,
        token: tkn,
        isActive: editFormActive,
      },
    ]);
    setEditModalParticipant(null);
    setImportError('');
    setImportFeedback(`Data peserta "${name}" (${num}) berhasil diperbarui.`);
  };

  const handleBulkApplyUniformToken = async (e: React.FormEvent) => {
    e.preventDefault();
    const tkn = bulkTokenValue.trim().toUpperCase();
    if (!tkn) return;

    const targets = participants.filter(
      (p) => bulkScope === 'ALL' || p.className === bulkScope
    );
    if (targets.length === 0) return;

    await onUpsertParticipants(targets.map((p) => ({ ...p, token: tkn })));
    setBulkTokenValue('');
    setImportFeedback(
      `Token "${tkn}" berhasil diterapkan secara masal ke ${targets.length} peserta (${
        bulkScope === 'ALL' ? 'Semua Kelas' : `Kelas ${bulkScope}`
      }).`
    );
  };

  const handleBulkGenerateRandomTokens = async () => {
    const targets = participants.filter(
      (p) => bulkScope === 'ALL' || p.className === bulkScope
    );
    if (targets.length === 0) return;

    await onUpsertParticipants(
      targets.map((p) => ({ ...p, token: generateRandomToken(6) }))
    );
    setImportFeedback(
      `Token unik acak berhasil dibuat untuk ${targets.length} peserta (${
        bulkScope === 'ALL' ? 'Semua Kelas' : `Kelas ${bulkScope}`
      }).`
    );
  };

  const handleSaveInlineToken = async (participant: Participant) => {
    const cleaned = editingToken.trim().toUpperCase();
    if (!cleaned) {
      setEditingId(null);
      return;
    }
    await onUpsertParticipants([{ ...participant, token: cleaned }]);
    setEditingId(null);
    setImportFeedback(
      `Token peserta ${participant.fullName} diperbarui menjadi ${cleaned}.`
    );
  };

  const handleImportExcel = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFeedback('');
    try {
      const { participants: parsed, errors } = await parseParticipantsExcel(file);
      if (parsed.length > 0) {
        await onUpsertParticipants(parsed);
      }
      setImportFeedback(
        `Berhasil mengimpor ${parsed.length} peserta beserta token.${
          errors.length > 0 ? ` (${errors.length} baris dilewati: ${errors[0]})` : ''
        }`
      );
    } catch (err) {
      setImportFeedback(
        err instanceof Error ? err.message : 'Gagal membaca file Excel peserta.'
      );
    }
    e.target.value = '';
  };

  const handleConfirmDeleteAll = async () => {
    if (participants.length === 0) {
      setConfirmDeleteAll(false);
      return;
    }
    const totalDeleted = participants.length;
    setIsDeletingAll(true);
    try {
      await onDeleteAllParticipants();
      setEditingId(null);
      setConfirmDeleteAll(false);
      setImportFeedback(`Seluruh ${totalDeleted} data peserta & token ujian berhasil dihapus.`);
    } finally {
      setIsDeletingAll(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 tracking-tight">
            Manajemen Peserta &amp; Token (Kelas 7A–9I)
          </h1>
          <p className="text-sm text-slate-600 mt-0.5">
            Kelola kredensial Nomor Peserta dan Kode Token secara manual per siswa, input masal, atau impor Excel.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={downloadParticipantsTemplate}
            className="inline-flex items-center gap-2 px-3.5 py-2.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs sm:text-sm font-semibold cursor-pointer whitespace-nowrap"
          >
            <FileSpreadsheet className="w-4 h-4 text-emerald-700" />
            <span>Template Excel</span>
          </button>

          <label className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white text-xs sm:text-sm font-semibold cursor-pointer whitespace-nowrap">
            <Upload className="w-4 h-4" />
            <span>Impor Peserta (.xlsx / .csv)</span>
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={handleImportExcel}
              className="sr-only"
            />
          </label>

          <button
            type="button"
            disabled={participants.length === 0}
            onClick={() => setConfirmDeleteAll(true)}
            className="inline-flex items-center gap-2 px-3.5 py-2.5 rounded-xl border border-red-200 bg-red-50 hover:bg-red-100 text-red-700 text-xs sm:text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            <span>Hapus Semua Data</span>
          </button>
        </div>
      </div>

      {importError && (
        <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-900 text-sm flex items-center justify-between gap-3">
          <span>{importError}</span>
          <button
            type="button"
            onClick={() => setImportError('')}
            className="p-1 rounded-lg hover:bg-rose-100 text-rose-700 cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {importFeedback && (
        <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-900 text-sm flex items-center justify-between gap-3">
          <span>{importFeedback}</span>
          <button
            type="button"
            onClick={() => setImportFeedback('')}
            className="p-1 rounded-lg hover:bg-emerald-100 text-emerald-700 cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Quick Add Single Participant + Manual Token */}
      <form
        onSubmit={handleAddSingle}
        className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 grid grid-cols-1 sm:grid-cols-12 gap-3 items-end"
      >
        <div className="sm:col-span-3">
          <label className="block text-xs font-semibold text-slate-600 mb-1">
            Nomor Peserta
          </label>
          <input
            type="text"
            required
            placeholder="2026-7A-003"
            value={newNumber}
            onChange={(e) => setNewNumber(e.target.value.toUpperCase())}
            className="w-full px-3 py-2 rounded-xl border border-slate-300 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
          />
        </div>
        <div className="sm:col-span-4">
          <label className="block text-xs font-semibold text-slate-600 mb-1">
            Nama Lengkap Peserta
          </label>
          <input
            type="text"
            required
            placeholder="Nama sesuai daftar hadir"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="block text-xs font-semibold text-slate-600 mb-1">
            Token Manual
          </label>
          <div className="flex gap-1">
            <input
              type="text"
              required
              value={newToken}
              onChange={(e) => setNewToken(e.target.value.toUpperCase())}
              className="w-full px-2.5 py-2 rounded-xl border border-slate-300 font-mono text-sm font-bold focus:outline-none focus:ring-2 focus:ring-emerald-700"
            />
            <button
              type="button"
              title="Acak token"
              onClick={() => setNewToken(generateRandomToken(6))}
              className="p-2 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-600 cursor-pointer shrink-0"
            >
              <Dices className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="sm:col-span-1">
          <label className="block text-xs font-semibold text-slate-600 mb-1">Kelas</label>
          <select
            value={newClass}
            onChange={(e) => setNewClass(e.target.value)}
            className="w-full px-2 py-2 rounded-xl border border-slate-300 bg-white text-sm font-mono font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-700"
          >
            {ALL_CLASSES.map((cls) => (
              <option key={cls} value={cls}>
                {cls}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <button
            type="submit"
            className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-semibold cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Tambah</span>
          </button>
        </div>
      </form>

      {/* Input Token Masal */}
      <form
        onSubmit={handleBulkApplyUniformToken}
        className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 space-y-3"
      >
        <div className="flex items-center gap-2 font-display font-bold text-slate-900 text-sm">
          <Ticket className="w-4 h-4 text-emerald-700" />
          <span>Input Token Masal (Per Kelas atau Seluruh Peserta)</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-center">
          <div className="sm:col-span-3">
            <select
              value={bulkScope}
              onChange={(e) => setBulkScope(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-white text-sm font-medium text-slate-700"
            >
              <option value="ALL">Target: Semua Kelas (7A–9I)</option>
              {ALL_CLASSES.map((cls) => (
                <option key={cls} value={cls}>
                  Target: Kelas {cls}
                </option>
              ))}
            </select>
          </div>

          <div className="sm:col-span-4">
            <input
              type="text"
              value={bulkTokenValue}
              onChange={(e) => setBulkTokenValue(e.target.value.toUpperCase())}
              placeholder="Ketik kode token masal (mis. PAS2026)"
              className="w-full px-3.5 py-2 rounded-xl border border-slate-300 font-mono text-sm font-bold focus:outline-none focus:ring-2 focus:ring-emerald-700"
            />
          </div>

          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={!bulkTokenValue.trim()}
              className="w-full px-3.5 py-2 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white text-xs sm:text-sm font-semibold disabled:opacity-50 cursor-pointer whitespace-nowrap"
            >
              Terapkan Masal
            </button>
          </div>

          <div className="sm:col-span-3">
            <button
              type="button"
              onClick={() => void handleBulkGenerateRandomTokens()}
              className="w-full inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl border border-emerald-700 text-emerald-900 hover:bg-emerald-50 text-xs sm:text-sm font-semibold cursor-pointer whitespace-nowrap"
            >
              <Dices className="w-4 h-4" />
              <span>Acak Token Unik Masal</span>
            </button>
          </div>
        </div>
      </form>

      {/* Filter & Participants Table */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari nama, nomor peserta, atau token..."
              className="w-full pl-10 pr-4 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
            />
          </div>

          <div className="flex items-center gap-3">
            <select
              value={classFilter}
              onChange={(e) => setClassFilter(e.target.value)}
              className="px-3 py-2 rounded-xl border border-slate-300 bg-white text-sm font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-700"
            >
              <option value="ALL">Semua 27 Kelas (7A–9I)</option>
              {ALL_CLASSES.map((cls) => (
                <option key={cls} value={cls}>
                  Kelas {cls}
                </option>
              ))}
            </select>
            <span className="text-xs font-mono text-slate-500 tabular-nums whitespace-nowrap">
              {filtered.length} peserta
            </span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                <th className="py-3 px-4">Nomor Peserta</th>
                <th className="py-3 px-4">Token Ujian</th>
                <th className="py-3 px-4">Nama Lengkap</th>
                <th className="py-3 px-4">Kelas</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Aksi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-10 px-4 text-center text-slate-500">
                    Tidak ada peserta ditemukan untuk filter kelas ini.
                  </td>
                </tr>
              ) : (
                displayedParticipants.map((p) => {
                  const isEditing = editingId === p.id;
                  return (
                    <tr key={p.id} className="hover:bg-slate-50/70">
                      <td className="py-2.5 px-4 font-mono font-bold text-slate-900">
                        {p.participantNumber}
                      </td>
                      <td className="py-2.5 px-4">
                        {isEditing ? (
                          <div className="flex items-center gap-1.5">
                            <input
                              type="text"
                              autoFocus
                              value={editingToken}
                              onChange={(e) => setEditingToken(e.target.value.toUpperCase())}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  void handleSaveInlineToken(p);
                                } else if (e.key === 'Escape') {
                                  setEditingId(null);
                                }
                              }}
                              className="w-28 px-2 py-1 rounded-lg border border-emerald-700 font-mono text-xs font-bold focus:outline-none"
                            />
                            <button
                              type="button"
                              onClick={() => void handleSaveInlineToken(p)}
                              className="p-1 rounded bg-emerald-700 text-white cursor-pointer"
                              title="Simpan token"
                            >
                              <Check className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <div className="inline-flex items-center gap-2">
                            <span className="font-mono font-bold text-emerald-900 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded">
                              {p.token || '-'}
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingId(p.id);
                                setEditingToken(p.token || '');
                              }}
                              title="Ubah token siswa ini"
                              className="p-1 rounded text-slate-400 hover:text-emerald-800 hover:bg-emerald-50 cursor-pointer"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 px-4 font-medium text-slate-800">{p.fullName}</td>
                      <td className="py-2.5 px-4 font-mono font-semibold text-emerald-900">
                        {p.className}
                      </td>
                      <td className="py-2.5 px-4 text-xs font-medium">
                        <button
                          type="button"
                          onClick={() =>
                            void onUpsertParticipants([{ ...p, isActive: !p.isActive }])
                          }
                          title="Klik untuk mengaktifkan atau menonaktifkan peserta"
                          className={`px-2.5 py-1 rounded-lg border text-xs font-semibold cursor-pointer transition-colors ${
                            p.isActive
                              ? 'bg-emerald-50 border-emerald-200 text-emerald-800 hover:bg-emerald-100'
                              : 'bg-slate-100 border-slate-200 text-slate-500 hover:bg-slate-200'
                          }`}
                        >
                          {p.isActive ? 'Aktif' : 'Nonaktif'}
                        </button>
                      </td>
                      <td className="py-2.5 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => openEditParticipantModal(p)}
                            title="Edit profil peserta"
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-emerald-50 hover:border-emerald-300 text-slate-700 hover:text-emerald-900 text-xs font-semibold transition-colors cursor-pointer"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                            <span>Edit</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => void onDeleteParticipant(p.id)}
                            title="Hapus peserta"
                            className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {filtered.length > PAGE_SIZE && (
          <div className="px-4 py-3 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
            <div>
              {showAllRows ? (
                <span>
                  {filtered.length > MAX_SHOW_ALL
                    ? `Menampilkan ${MAX_SHOW_ALL} dari ${filtered.length} peserta (gunakan filter/pencarian untuk sisa data).`
                    : `Menampilkan seluruh ${filtered.length} peserta sekaligus.`}
                </span>
              ) : (
                <span>
                  Menampilkan peserta {(safeListPage - 1) * PAGE_SIZE + 1}–
                  {Math.min(safeListPage * PAGE_SIZE, filtered.length)} dari {filtered.length}{' '}
                  peserta (Halaman {safeListPage} dari {totalPages})
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {!showAllRows && totalPages > 1 && (
                <>
                  <button
                    type="button"
                    disabled={safeListPage <= 1}
                    onClick={() => setListPage((p) => Math.max(1, p - 1))}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-40 font-semibold cursor-pointer"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    <span>Sebelumnya</span>
                  </button>
                  <button
                    type="button"
                    disabled={safeListPage >= totalPages}
                    onClick={() => setListPage((p) => Math.min(totalPages, p + 1))}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-40 font-semibold cursor-pointer"
                  >
                    <span>Berikutnya</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => setShowAllRows((v) => !v)}
                className="px-3 py-1.5 rounded-lg border border-emerald-700 bg-emerald-50 hover:bg-emerald-100 text-emerald-900 font-semibold cursor-pointer"
              >
                {showAllRows
                  ? `Bagi per ${PAGE_SIZE} Peserta`
                  : `Tampilkan Maks ${Math.min(filtered.length, MAX_SHOW_ALL)} (${filtered.length})`}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Confirmation Modal for Delete All Participants */}
      {confirmDeleteAll && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden">
            <div className="px-5 py-4 bg-red-50 border-b border-red-200 flex items-center justify-between">
              <div className="flex items-center gap-2 font-display font-bold text-red-950 text-base">
                <AlertTriangle className="w-5 h-5 text-red-600" />
                <span>Hapus Semua Peserta &amp; Token</span>
              </div>
              <button
                type="button"
                disabled={isDeletingAll}
                onClick={() => setConfirmDeleteAll(false)}
                className="p-1 rounded-lg text-red-900/70 hover:bg-red-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="text-sm text-slate-700 space-y-2 leading-relaxed">
                <p>
                  Apakah Anda yakin ingin menghapus seluruh{' '}
                  <strong className="text-slate-900">{participants.length} data peserta</strong> beserta token ujiannya?
                </p>
                <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-xl p-3">
                  Tindakan ini akan menghapus semua daftar peserta dan token yang tersimpan secara permanen dan tidak dapat dibatalkan.
                </p>
              </div>

              <div className="flex items-center gap-2.5 pt-1">
                <button
                  type="button"
                  disabled={isDeletingAll}
                  onClick={() => setConfirmDeleteAll(false)}
                  className="flex-1 py-2.5 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-50 text-xs sm:text-sm font-semibold cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="button"
                  disabled={isDeletingAll}
                  onClick={() => void handleConfirmDeleteAll()}
                  className="flex-1 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs sm:text-sm font-semibold cursor-pointer disabled:opacity-60"
                >
                  {isDeletingAll ? 'Menghapus...' : 'Ya, Hapus Semua'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal Edit Participant */}
      {editModalParticipant && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-2xl overflow-hidden">
            <div className="px-5 py-4 bg-[#064e3b] text-white flex items-center justify-between">
              <div>
                <h3 className="font-display font-bold text-base">Edit Data Peserta</h3>
                <p className="text-xs text-emerald-100/85">
                  Perbarui nama, kelas, token login, atau status keaktifan peserta.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditModalParticipant(null)}
                className="p-1.5 rounded-lg text-emerald-100 hover:bg-white/10 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveParticipantModal} className="p-5 space-y-4">
              {editModalError && (
                <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-medium">
                  {editModalError}
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Nomor Peserta
                </label>
                <input
                  type="text"
                  required
                  value={editFormNumber}
                  onChange={(e) => setEditFormNumber(e.target.value.toUpperCase())}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 font-mono text-sm font-bold focus:outline-none focus:ring-2 focus:ring-emerald-700"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Nama Lengkap
                </label>
                <input
                  type="text"
                  required
                  value={editFormName}
                  onChange={(e) => setEditFormName(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Kelas</label>
                  <select
                    value={editFormClass}
                    onChange={(e) => setEditFormClass(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-white font-mono text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-700"
                  >
                    {ALL_CLASSES.map((cls) => (
                      <option key={cls} value={cls}>
                        {cls}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Token</label>
                  <div className="flex gap-1">
                    <input
                      type="text"
                      required
                      value={editFormToken}
                      onChange={(e) => setEditFormToken(e.target.value.toUpperCase())}
                      className="w-full px-2.5 py-2 rounded-xl border border-slate-300 font-mono text-sm font-bold focus:outline-none focus:ring-2 focus:ring-emerald-700"
                    />
                    <button
                      type="button"
                      title="Acak token"
                      onClick={() => setEditFormToken(generateRandomToken(6))}
                      className="p-2 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-600 cursor-pointer shrink-0"
                    >
                      <Dices className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>

              <label className="flex items-center gap-2.5 text-xs font-semibold text-slate-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={editFormActive}
                  onChange={(e) => setEditFormActive(e.target.checked)}
                  className="w-4 h-4 accent-[#064e3b]"
                />
                <span>Akun peserta aktif (diizinkan login ujian)</span>
              </label>

              <div className="flex justify-end gap-2.5 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setEditModalParticipant(null)}
                  className="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-semibold cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white text-sm font-semibold cursor-pointer"
                >
                  Simpan Perubahan
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
