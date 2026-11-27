import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, FileDown, Printer, Search } from 'lucide-react';
import { exportExamCardsPdf } from '@/src/lib/importers';
import { KEMENAG_HEADER_TITLE, KEMENAG_LOGO_DATA_URL } from '@/src/lib/seedData';
import { ALL_CLASSES, type Participant, type SchoolProfile } from '@/src/types/cbt';

interface AdminExamCardsTabProps {
  profile: SchoolProfile;
  participants: Participant[];
}

const SHEETS_PER_PREVIEW_CHUNK = 5; // 5 lembar A4 = 50 kartu per halaman pratinjau layar

function chunkIntoPages<T>(items: T[], perPage = 10): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += perPage) {
    pages.push(items.slice(i, i + perPage));
  }
  return pages;
}

export const AdminExamCardsTab: React.FC<AdminExamCardsTabProps> = ({
  profile,
  participants,
}) => {
  const [classFilter, setClassFilter] = useState('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [previewChunkIdx, setPreviewChunkIdx] = useState(0);
  const [showAllPreview, setShowAllPreview] = useState(false);
  const [isPrintingAll, setIsPrintingAll] = useState(false);

  const filteredParticipants = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return participants.filter((p) => {
      if (classFilter !== 'ALL' && p.className !== classFilter) return false;
      if (
        q &&
        !p.fullName.toLowerCase().includes(q) &&
        !p.participantNumber.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [participants, classFilter, searchQuery]);

  // 2 columns x 5 rows = 10 cards per A4 page
  const pages = useMemo(
    () => chunkIntoPages(filteredParticipants, 10),
    [filteredParticipants]
  );

  const totalPreviewChunks = Math.max(1, Math.ceil(pages.length / SHEETS_PER_PREVIEW_CHUNK));
  const safePreviewChunkIdx = Math.min(previewChunkIdx, totalPreviewChunks - 1);

  useEffect(() => {
    setPreviewChunkIdx(0);
    setShowAllPreview(false);
  }, [classFilter, searchQuery]);

  useEffect(() => {
    const onBeforePrint = () => setIsPrintingAll(true);
    const onAfterPrint = () => setIsPrintingAll(false);
    window.addEventListener('beforeprint', onBeforePrint);
    window.addEventListener('afterprint', onAfterPrint);
    return () => {
      window.removeEventListener('beforeprint', onBeforePrint);
      window.removeEventListener('afterprint', onAfterPrint);
    };
  }, []);

  const visiblePages = useMemo(() => {
    if (isPrintingAll || showAllPreview || pages.length <= SHEETS_PER_PREVIEW_CHUNK) {
      return pages.map((cards, idx) => ({ pageIdx: idx, cards }));
    }
    const start = safePreviewChunkIdx * SHEETS_PER_PREVIEW_CHUNK;
    return pages
      .slice(start, start + SHEETS_PER_PREVIEW_CHUNK)
      .map((cards, offset) => ({ pageIdx: start + offset, cards }));
  }, [pages, isPrintingAll, showAllPreview, safePreviewChunkIdx]);

  const handleExportPdf = async () => {
    if (filteredParticipants.length === 0) return;
    setIsExportingPdf(true);
    try {
      await exportExamCardsPdf(filteredParticipants, profile, classFilter);
    } finally {
      setIsExportingPdf(false);
    }
  };

  const handlePrint = () => {
    setIsPrintingAll(true);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        window.print();
      });
    });
  };

  return (
    <div className="space-y-6">
      {/* Controls & Filter Bar — hidden automatically during print */}
      <div className="no-print space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-bold text-slate-900 tracking-tight">
              Cetak Kartu Ujian (PDF &amp; Kertas A4)
            </h1>
            <p className="text-sm text-slate-600 mt-0.5">
              Format grid siap potong 2 kolom × 5 baris (10 kartu per lembar A4) dalam bentuk file PDF dengan Kop Instansi, Nomor Peserta, Token, dan tanda tangan panitia.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={handlePrint}
              disabled={filteredParticipants.length === 0}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-sm font-semibold transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap"
            >
              <Printer className="w-4 h-4" />
              <span>Print Langsung</span>
            </button>

            <button
              type="button"
              onClick={() => void handleExportPdf()}
              disabled={filteredParticipants.length === 0 || isExportingPdf}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#064e3b] hover:bg-[#043927] text-white text-sm font-semibold shadow-xs transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap"
            >
              <FileDown className="w-4 h-4" />
              <span>
                {isExportingPdf
                  ? 'Membuat PDF...'
                  : `Cetak Kartu PDF (${filteredParticipants.length} Kartu)`}
              </span>
            </button>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 p-4 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari nama peserta atau nomor peserta..."
              className="w-full pl-10 pr-4 py-2 rounded-xl border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
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

            <span className="text-xs font-mono text-slate-600 tabular-nums whitespace-nowrap">
              {pages.length} lembar A4 · {filteredParticipants.length} kartu
            </span>
          </div>
        </div>
      </div>

      {/* Print-Ready A4 Pages (2 cols x 5 rows = 10 cards per sheet) */}
      {filteredParticipants.length === 0 ? (
        <div className="no-print bg-white rounded-2xl border border-slate-200 p-10 text-center text-sm text-slate-500">
          Tidak ada peserta yang sesuai dengan filter kelas atau pencarian nama.
        </div>
      ) : (
        <>
          {pages.length > SHEETS_PER_PREVIEW_CHUNK && (
            <div className="no-print bg-white rounded-2xl border border-slate-200 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs text-slate-600 font-medium">
                {showAllPreview
                  ? `Menampilkan seluruh ${pages.length} lembar A4 (${filteredParticipants.length} kartu)`
                  : `Pratinjau lembar A4 ${safePreviewChunkIdx * SHEETS_PER_PREVIEW_CHUNK + 1}–${Math.min(
                      pages.length,
                      (safePreviewChunkIdx + 1) * SHEETS_PER_PREVIEW_CHUNK
                    )} dari ${pages.length} lembar (PDF & Print Langsung tetap mencetak semua kartu)`}
              </span>
              <div className="flex items-center gap-2">
                {!showAllPreview && (
                  <>
                    <button
                      type="button"
                      onClick={() => setPreviewChunkIdx((prev) => Math.max(0, prev - 1))}
                      disabled={safePreviewChunkIdx <= 0}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold cursor-pointer disabled:opacity-40"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                      <span>Sebelumnya</span>
                    </button>
                    <span className="text-xs font-mono text-slate-700 tabular-nums px-1">
                      {safePreviewChunkIdx + 1}/{totalPreviewChunks}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setPreviewChunkIdx((prev) => Math.min(totalPreviewChunks - 1, prev + 1))
                      }
                      disabled={safePreviewChunkIdx >= totalPreviewChunks - 1}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold cursor-pointer disabled:opacity-40"
                    >
                      <span>Berikutnya</span>
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => setShowAllPreview((prev) => !prev)}
                  className="px-2.5 py-1.5 rounded-lg border border-slate-300 bg-slate-50 hover:bg-slate-100 text-slate-700 text-xs font-semibold cursor-pointer"
                >
                  {showAllPreview ? 'Mode Ringan (5 Lembar)' : 'Tampilkan Semua'}
                </button>
              </div>
            </div>
          )}

          <div className="print-only-container space-y-6 print:space-y-0 overflow-x-auto pb-4 print:pb-0">
            {visiblePages.map(({ pageIdx, cards: pageCards }) => (
              <div
                key={pageIdx}
                className="print-a4-page mx-auto bg-white shadow-md border border-slate-300 grid grid-cols-2 grid-rows-5 w-[794px] print:w-full"
              >
              {pageCards.map((student) => (
                <article
                  key={student.id}
                  className="exam-card-cell border border-dashed border-slate-500 px-3 py-2.5 flex flex-col justify-between bg-white h-[212px]"
                >
                  {/* Kop Instansi */}
                  <div>
                    <div className="flex items-center justify-between gap-2 pb-1 border-b border-slate-800">
                      <img
                        src={profile.kemenagLogoDataUrl || KEMENAG_LOGO_DATA_URL}
                        alt="Logo Kementerian Agama"
                        referrerPolicy="no-referrer"
                        className="w-9 h-9 object-contain shrink-0"
                      />
                      <div className="min-w-0 flex-1 text-center">
                        <div className="font-display font-extrabold text-[8px] uppercase tracking-tight text-slate-950 truncate leading-tight">
                          {KEMENAG_HEADER_TITLE}
                        </div>
                        <div className="font-display font-extrabold text-[10px] uppercase tracking-tight text-slate-950 truncate leading-tight">
                          {profile.schoolName}
                        </div>
                        <div className="italic text-[7.5px] text-slate-600 truncate leading-tight">
                          {profile.address}
                        </div>
                      </div>
                      {profile.logoDataUrl ? (
                        <img
                          src={profile.logoDataUrl}
                          alt={`Logo ${profile.schoolName}`}
                          referrerPolicy="no-referrer"
                          className="w-9 h-9 object-contain shrink-0"
                        />
                      ) : (
                        <div className="w-9 h-9 shrink-0" />
                      )}
                    </div>

                    <div className="text-center pt-1">
                      <div className="text-[9.5px] font-extrabold tracking-wider text-slate-950 uppercase leading-tight">
                        KARTU PESERTA
                      </div>
                      <div className="text-[8.5px] font-bold text-[#064e3b] truncate leading-tight">
                        {profile.examTitle} ({profile.academicYear})
                      </div>
                    </div>
                  </div>

                  {/* Data Peserta */}
                  <div className="py-0.5 space-y-0.5 text-[10.5px]">
                    <div className="grid grid-cols-12 items-baseline">
                      <span className="col-span-4 text-slate-600">Nama Peserta</span>
                      <span className="col-span-8 font-bold text-slate-950 truncate">
                        : {student.fullName}
                      </span>
                    </div>
                    <div className="grid grid-cols-12 items-baseline">
                      <span className="col-span-4 text-slate-600">Kelas</span>
                      <span className="col-span-8 font-mono font-bold text-slate-950">
                        : {student.className}
                      </span>
                    </div>
                    <div className="grid grid-cols-12 items-center pt-0.5">
                      <span className="col-span-4 text-slate-700 font-semibold">
                        No. Peserta
                      </span>
                      <span className="col-span-8 font-mono text-[11.5px] font-extrabold tracking-wider text-slate-950 bg-slate-100 border border-slate-300 px-2 py-0.5 rounded text-center block">
                        {student.participantNumber}
                      </span>
                    </div>
                    <div className="grid grid-cols-12 items-center">
                      <span className="col-span-4 text-slate-700 font-semibold">
                        Token Ujian
                      </span>
                      <span className="col-span-8 font-mono text-[11.5px] font-extrabold tracking-widest text-[#064e3b]">
                        : {student.token || '-'}
                      </span>
                    </div>
                  </div>

                  {/* Tanda Tangan Panitia */}
                  <div className="flex items-end justify-between pt-0.5 text-[9.5px] text-slate-700">
                    <div className="text-[8.5px] text-slate-500">
                      Login dengan No. Peserta &amp; Token.
                    </div>
                    <div className="text-right leading-tight shrink-0 pl-2">
                      <div>Ketua Panitia,</div>
                      <div className="h-2.5" />
                      <div className="font-bold text-slate-950 underline decoration-slate-400">
                        {profile.committeeChairName}
                      </div>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ))}
        </div>
        </>
      )}
    </div>
  );
};
