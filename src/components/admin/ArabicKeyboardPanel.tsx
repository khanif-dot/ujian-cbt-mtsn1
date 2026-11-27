import React, { useState } from 'react';
import { CornerDownLeft, Delete, Languages, Space } from 'lucide-react';

export type TextDirectionMode = 'auto' | 'rtl' | 'ltr';

interface ArabicKeyboardPanelProps {
  activeFieldLabel: string;
  directionMode: TextDirectionMode;
  onDirectionChange: (mode: TextDirectionMode) => void;
  onInsertText: (text: string) => void;
  onBackspace: () => void;
  onClose: () => void;
}

type KeyboardTab = 'letters' | 'symbols' | 'phrases';

const ARABIC_LETTER_ROWS: string[][] = [
  ['ا', 'أ', 'إ', 'آ', 'ب', 'ت', 'ث', 'ج', 'ح', 'خ', 'د', 'ذ'],
  ['ر', 'ز', 'س', 'ش', 'ص', 'ض', 'ط', 'ظ', 'ع', 'غ', 'ف', 'ق'],
  ['ك', 'ل', 'م', 'ن', 'ه', 'ة', 'و', 'ؤ', 'ي', 'ى', 'ئ', 'ء', 'لا'],
];

const ARABIC_HARAKAT: Array<{ char: string; display: string; label: string }> = [
  { char: '\u064E', display: 'ـَ', label: 'Fathah' },
  { char: '\u0650', display: 'ـِ', label: 'Kasrah' },
  { char: '\u064F', display: 'ـُ', label: 'Dhammah' },
  { char: '\u064B', display: 'ـً', label: 'Fathatain' },
  { char: '\u064D', display: 'ـٍ', label: 'Kasratain' },
  { char: '\u064C', display: 'ـٌ', label: 'Dhammatain' },
  { char: '\u0652', display: 'ـْ', label: 'Sukun' },
  { char: '\u0651', display: 'ـّ', label: 'Tasydid' },
  { char: '\u0670', display: 'ـٰ', label: 'Alif Khanjariyah' },
  { char: '\u0653', display: 'ـٓ', label: 'Maddah' },
  { char: '\u0640', display: 'ـ', label: 'Tatweel (Pemanjang)' },
];

const ARABIC_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];

const ARABIC_PUNCTUATION: Array<{ char: string; label: string }> = [
  { char: '،', label: 'Koma Arab' },
  { char: '؛', label: 'Titik Koma Arab' },
  { char: '؟', label: 'Tanya Arab' },
  { char: '«', label: 'Kutip Buka' },
  { char: '»', label: 'Kutip Tutup' },
  { char: '(', label: 'Kurung Buka' },
  { char: ')', label: 'Kurung Tutup' },
  { char: '۝', label: 'Akhir Ayat' },
  { char: '۞', label: 'Rub El Hizb' },
  { char: 'ﷺ', label: 'Shalawat Ringkas' },
  { char: 'ﷻ', label: 'Jalla Jalaluhu' },
];

const ARABIC_QUICK_PHRASES: Array<{ text: string; hint: string }> = [
  { text: 'بِسْمِ اللَّهِ الرَّحْمٰنِ الرَّحِيْمِ', hint: 'Basmalah' },
  { text: 'السَّلَامُ عَلَيْكُمْ وَرَحْمَةُ اللَّهِ وَبَرَكَاتُهُ', hint: 'Salam' },
  { text: 'الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِيْنَ', hint: 'Hamdalah' },
  { text: 'صَلَّى اللَّهُ عَلَيْهِ وَسَلَّمَ', hint: 'SAW' },
  { text: 'سُبْحَانَهُ وَتَعَالَى', hint: 'SWT' },
  { text: 'رَضِيَ اللَّهُ عَنْهُ', hint: 'RA' },
  { text: 'عَلَيْهِ السَّلَامُ', hint: 'AS' },
  { text: 'إِنْ شَاءَ اللَّهُ', hint: 'InsyaAllah' },
];

export const ArabicKeyboardPanel: React.FC<ArabicKeyboardPanelProps> = ({
  activeFieldLabel,
  directionMode,
  onDirectionChange,
  onInsertText,
  onBackspace,
  onClose,
}) => {
  const [tab, setTab] = useState<KeyboardTab>('letters');

  const preventFocusLoss = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50/55 p-3 space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5 font-bold text-emerald-950">
            <Languages className="w-3.5 h-3.5 text-emerald-700" />
            <span>Papan Ketik Huruf Arab &amp; Harakat</span>
          </span>
          <span className="px-2 py-0.5 rounded-md bg-white border border-emerald-200 text-[11px] font-semibold text-emerald-800">
            Target: {activeFieldLabel}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <div className="inline-flex items-center rounded-lg border border-emerald-200 bg-white p-0.5 text-[11px] font-semibold">
            {(
              [
                { value: 'auto', label: 'Auto' },
                { value: 'rtl', label: 'RTL (Arab)' },
                { value: 'ltr', label: 'LTR (Latin)' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.value}
                type="button"
                onMouseDown={preventFocusLoss}
                onClick={() => onDirectionChange(opt.value)}
                className={`px-2 py-0.5 rounded-md cursor-pointer transition-colors ${
                  directionMode === opt.value
                    ? 'bg-[#064e3b] text-white'
                    : 'text-slate-600 hover:text-emerald-900'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={onClose}
            className="px-2 py-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-[11px] font-semibold text-slate-600 cursor-pointer"
          >
            Tutup
          </button>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex items-center gap-1 rounded-lg bg-white/90 border border-emerald-200/80 p-0.5 text-[11px] font-semibold">
          <button
            type="button"
            onMouseDown={preventFocusLoss}
            onClick={() => setTab('letters')}
            className={`px-2.5 py-1 rounded-md cursor-pointer ${
              tab === 'letters'
                ? 'bg-emerald-700 text-white'
                : 'text-slate-600 hover:text-emerald-900'
            }`}
          >
            Hijaiyah &amp; Harakat
          </button>
          <button
            type="button"
            onMouseDown={preventFocusLoss}
            onClick={() => setTab('symbols')}
            className={`px-2.5 py-1 rounded-md cursor-pointer ${
              tab === 'symbols'
                ? 'bg-emerald-700 text-white'
                : 'text-slate-600 hover:text-emerald-900'
            }`}
          >
            Angka &amp; Tanda Baca
          </button>
          <button
            type="button"
            onMouseDown={preventFocusLoss}
            onClick={() => setTab('phrases')}
            className={`px-2.5 py-1 rounded-md cursor-pointer ${
              tab === 'phrases'
                ? 'bg-emerald-700 text-white'
                : 'text-slate-600 hover:text-emerald-900'
            }`}
          >
            Frasa Cepat
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onMouseDown={preventFocusLoss}
            onClick={() => onInsertText(' ')}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-[11px] font-semibold cursor-pointer"
          >
            <Space className="w-3 h-3" />
            <span>Spasi</span>
          </button>
          <button
            type="button"
            onMouseDown={preventFocusLoss}
            onClick={() => onInsertText('\n')}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-emerald-200 bg-white hover:bg-emerald-50 text-emerald-900 text-[11px] font-semibold cursor-pointer"
          >
            <CornerDownLeft className="w-3 h-3" />
            <span>Baris Baru</span>
          </button>
          <button
            type="button"
            onMouseDown={preventFocusLoss}
            onClick={onBackspace}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-rose-200 bg-white hover:bg-rose-50 text-rose-700 text-[11px] font-semibold cursor-pointer"
          >
            <Delete className="w-3 h-3" />
            <span>Hapus</span>
          </button>
        </div>
      </div>

      {tab === 'letters' && (
        <div className="space-y-2">
          {/* Harakat / Syakal */}
          <div className="space-y-1">
            <div className="text-[10px] font-bold uppercase tracking-wide text-emerald-900/75">
              Harakat / Syakal (klik setelah huruf Arab)
            </div>
            <div className="flex flex-wrap gap-1" dir="rtl">
              {ARABIC_HARAKAT.map((h) => (
                <button
                  key={h.label}
                  type="button"
                  title={h.label}
                  onMouseDown={preventFocusLoss}
                  onClick={() => onInsertText(h.char)}
                  className="min-w-[36px] px-2 py-1 rounded-lg border border-amber-200 bg-amber-50/90 hover:bg-amber-100 text-amber-950 font-arabic text-base font-semibold leading-none cursor-pointer transition-colors"
                >
                  {h.display}
                </button>
              ))}
            </div>
          </div>

          {/* Huruf Hijaiyah */}
          <div className="space-y-1">
            <div className="text-[10px] font-bold uppercase tracking-wide text-emerald-900/75">
              Huruf Hijaiyah
            </div>
            <div className="space-y-1" dir="rtl">
              {ARABIC_LETTER_ROWS.map((row, rowIdx) => (
                <div key={rowIdx} className="flex flex-wrap gap-1">
                  {row.map((ch) => (
                    <button
                      key={ch}
                      type="button"
                      onMouseDown={preventFocusLoss}
                      onClick={() => onInsertText(ch)}
                      className="min-w-[34px] h-9 px-2 rounded-lg border border-slate-200 bg-white hover:bg-emerald-100 hover:border-emerald-400 text-slate-900 font-arabic text-lg font-medium leading-none flex items-center justify-center cursor-pointer transition-colors"
                    >
                      {ch}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === 'symbols' && (
        <div className="space-y-2">
          <div className="space-y-1">
            <div className="text-[10px] font-bold uppercase tracking-wide text-emerald-900/75">
              Angka Arab (0–9)
            </div>
            <div className="flex flex-wrap gap-1.5" dir="rtl">
              {ARABIC_DIGITS.map((digit, idx) => (
                <button
                  key={digit}
                  type="button"
                  title={`Angka ${idx}`}
                  onMouseDown={preventFocusLoss}
                  onClick={() => onInsertText(digit)}
                  className="min-w-[36px] h-9 px-2 rounded-lg border border-slate-200 bg-white hover:bg-emerald-100 hover:border-emerald-400 text-slate-900 font-arabic text-lg font-semibold leading-none flex items-center justify-center cursor-pointer"
                >
                  {digit}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <div className="text-[10px] font-bold uppercase tracking-wide text-emerald-900/75">
              Tanda Baca &amp; Simbol Arab
            </div>
            <div className="flex flex-wrap gap-1.5" dir="rtl">
              {ARABIC_PUNCTUATION.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  title={item.label}
                  onMouseDown={preventFocusLoss}
                  onClick={() => onInsertText(item.char)}
                  className="min-w-[36px] h-9 px-2.5 rounded-lg border border-slate-200 bg-white hover:bg-emerald-100 hover:border-emerald-400 text-slate-900 font-arabic text-base font-medium leading-none flex items-center justify-center cursor-pointer"
                >
                  {item.char}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === 'phrases' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {ARABIC_QUICK_PHRASES.map((phrase) => (
            <button
              key={phrase.hint}
              type="button"
              onMouseDown={preventFocusLoss}
              onClick={() => onInsertText(phrase.text)}
              className="px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-emerald-100 hover:border-emerald-400 text-right flex items-center justify-between gap-2 cursor-pointer transition-colors"
            >
              <span className="text-[10px] font-semibold text-slate-500 shrink-0">
                {phrase.hint}
              </span>
              <span dir="rtl" lang="ar" className="font-arabic text-base text-slate-900 leading-relaxed">
                {phrase.text}
              </span>
            </button>
          ))}
        </div>
      )}

      <p className="text-[11px] text-emerald-900/75 leading-snug">
        Klik kolom <strong>Teks Pertanyaan</strong>, <strong>Opsi A–D</strong>, atau{' '}
        <strong>Menjodohkan</strong> terlebih dahulu lalu klik huruf/harakat untuk menyisipkan di posisi kursor. Tekan <strong>Enter</strong> untuk membuat baris baru.
      </p>
    </div>
  );
};
