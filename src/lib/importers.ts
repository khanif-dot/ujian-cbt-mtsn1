import { Document, Packer, Paragraph, TextRun } from 'docx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import {
  ALL_CLASSES,
  type ExamResult,
  type ExamSchedule,
  type OptionKey,
  type Participant,
  type Question,
  type SchoolProfile,
} from '@/src/types/cbt';

export function generateRandomToken(length = 6): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Parse class specification string such as:
 * - "7A, 7B, 7C"
 * - "7A-7I"
 * - "7A-9I" or "SEMUA"
 */
export function parseTargetClassesInput(raw: string): string[] {
  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/\bVIII\s*([A-I])\b/g, '8$1')
    .replace(/\bVII\s*([A-I])\b/g, '7$1')
    .replace(/\bIX\s*([A-I])\b/g, '9$1')
    .replace(/\bKELAS\s+VIII\b/g, '8')
    .replace(/\bKELAS\s+VII\b/g, '7')
    .replace(/\bKELAS\s+IX\b/g, '9');

  if (!cleaned || cleaned === 'ALL' || cleaned === 'SEMUA') {
    return [...ALL_CLASSES];
  }

  const tokens = cleaned.split(/[,;]+/).map((t) => t.trim()).filter(Boolean);
  const result = new Set<string>();

  for (const token of tokens) {
    const normalizedToken = token.replace(/^KELAS\s+/, '').replace(/\s+/g, '');
    const rangeMatch = normalizedToken.match(/^([789][A-I])-([789][A-I])$/);
    if (rangeMatch) {
      const startIdx = ALL_CLASSES.indexOf(rangeMatch[1]);
      const endIdx = ALL_CLASSES.indexOf(rangeMatch[2]);
      if (startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx) {
        for (let i = startIdx; i <= endIdx; i++) {
          result.add(ALL_CLASSES[i]);
        }
      }
      continue;
    }

    if (normalizedToken === '7' || normalizedToken === 'VII') {
      ALL_CLASSES.filter((c) => c.startsWith('7')).forEach((c) => result.add(c));
      continue;
    }
    if (normalizedToken === '8' || normalizedToken === 'VIII') {
      ALL_CLASSES.filter((c) => c.startsWith('8')).forEach((c) => result.add(c));
      continue;
    }
    if (normalizedToken === '9' || normalizedToken === 'IX') {
      ALL_CLASSES.filter((c) => c.startsWith('9')).forEach((c) => result.add(c));
      continue;
    }

    if (ALL_CLASSES.includes(normalizedToken)) {
      result.add(normalizedToken);
    }
  }

  return Array.from(result);
}

/**
 * Compress uploaded School Logo or Question Image into compact WebP/JPEG/PNG data URL
 */
export async function compressLogoImage(file: File, maxSize = 240): Promise<string> {
  return compressImageFile(file, maxSize, maxSize, 0.84);
}

export async function compressQuestionImage(file: File, maxWidth = 820): Promise<string> {
  return compressImageFile(file, maxWidth, 620, 0.82);
}

async function compressImageFile(
  file: File,
  maxWidth: number,
  maxHeight: number,
  quality: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width, maxHeight / img.height);
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvas context unavailable'));
          return;
        }
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        const compressed = canvas.toDataURL('image/webp', quality);
        resolve(
          compressed.startsWith('data:image/webp')
            ? compressed
            : canvas.toDataURL('image/png')
        );
      };
      img.onerror = () => reject(new Error('Format gambar tidak dapat dibaca.'));
      img.src = String(reader.result);
    };
    reader.onerror = () => reject(new Error('Gagal membaca file gambar.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Import Participants from Excel (.xlsx / .xls / .csv) including Token column
 */
export async function parseParticipantsExcel(file: File): Promise<{
  participants: Participant[];
  errors: string[];
}> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], {
    defval: '',
  });

  const participants: Participant[] = [];
  const errors: string[] = [];
  const nowIso = new Date().toISOString();

  rows.forEach((row, idx) => {
    const normalizedKeys: Record<string, string> = {};
    Object.keys(row).forEach((k) => {
      normalizedKeys[k.trim().toLowerCase()] = String(row[k] ?? '').trim();
    });

    const participantNumber =
      normalizedKeys['nomor peserta'] ||
      normalizedKeys['no peserta'] ||
      normalizedKeys['participant_number'] ||
      normalizedKeys['no_peserta'] ||
      normalizedKeys['username'] ||
      '';

    const fullName =
      normalizedKeys['nama lengkap'] ||
      normalizedKeys['nama'] ||
      normalizedKeys['full_name'] ||
      normalizedKeys['nama peserta'] ||
      '';

    const rawClass = (
      normalizedKeys['kelas'] ||
      normalizedKeys['class'] ||
      normalizedKeys['class_name'] ||
      ''
    ).toUpperCase();

    const rawToken = (
      normalizedKeys['token'] ||
      normalizedKeys['kode token'] ||
      normalizedKeys['token ujian'] ||
      ''
    ).toUpperCase();

    if (!participantNumber || !fullName) {
      errors.push(`Baris ${idx + 2}: Nomor Peserta atau Nama Lengkap kosong.`);
      return;
    }

    if (!ALL_CLASSES.includes(rawClass)) {
      errors.push(`Baris ${idx + 2}: Kelas "${rawClass}" tidak valid (gunakan 7A–9I).`);
      return;
    }

    participants.push({
      id: `ptc-${participantNumber.toLowerCase().replace(/[^a-z0-9-]/g, '')}-${idx}`,
      participantNumber: participantNumber.toUpperCase(),
      token: rawToken || generateRandomToken(6),
      fullName,
      className: rawClass,
      isActive: true,
      createdAt: nowIso,
    });
  });

  return { participants, errors };
}

/**
 * Import Questions from Excel (.xlsx / .xls / .csv) with optional Gambar URL & LaTeX
 */
export async function parseQuestionsExcel(file: File): Promise<{
  questions: Question[];
  errors: string[];
}> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], {
    defval: '',
  });

  const questions: Question[] = [];
  const errors: string[] = [];

  rows.forEach((row, idx) => {
    const map: Record<string, string> = {};
    Object.keys(row).forEach((k) => {
      map[k.trim().toLowerCase()] = String(row[k] ?? '').trim();
    });

    const subject = map['mata pelajaran'] || map['mapel'] || map['subject'] || 'Matematika';
    const rawTarget = map['target kelas'] || map['kelas'] || map['target_classes'] || '7A-9I';
    const targetClasses = parseTargetClassesInput(rawTarget);
    const questionText = map['pertanyaan'] || map['soal'] || map['question'] || '';
    const questionImageUrl =
      map['gambar url'] || map['url gambar'] || map['gambar'] || map['image_url'] || '';
    const optA = map['opsi a'] || map['a'] || map['pilihan a'] || '';
    const optB = map['opsi b'] || map['b'] || map['pilihan b'] || '';
    const optC = map['opsi c'] || map['c'] || map['pilihan c'] || '';
    const optD = map['opsi d'] || map['d'] || map['pilihan d'] || '';
    const imgA = map['gambar opsi a'] || map['gambar a'] || map['opsi a gambar'] || '';
    const imgB = map['gambar opsi b'] || map['gambar b'] || map['opsi b gambar'] || '';
    const imgC = map['gambar opsi c'] || map['gambar c'] || map['opsi c gambar'] || '';
    const imgD = map['gambar opsi d'] || map['gambar d'] || map['opsi d gambar'] || '';
    const rawKey = (map['kunci jawaban'] || map['kunci'] || map['correct_answer'] || 'A').toUpperCase();
    const points = Number(map['bobot'] || map['poin'] || map['points'] || 10) || 10;

    if (!questionText || (!optA && !imgA) || (!optB && !imgB)) {
      errors.push(`Baris ${idx + 2}: Teks soal atau opsi A/B belum lengkap.`);
      return;
    }

    const correctAnswer: OptionKey = (['A', 'B', 'C', 'D'].includes(rawKey)
      ? rawKey
      : 'A') as OptionKey;

    questions.push({
      id: `q-imp-${Date.now()}-${idx}`,
      subject,
      targetClasses: targetClasses.length > 0 ? targetClasses : [...ALL_CLASSES],
      questionText,
      questionImageUrl: questionImageUrl || undefined,
      options: [
        { key: 'A', text: optA, imageUrl: imgA || undefined },
        { key: 'B', text: optB, imageUrl: imgB || undefined },
        { key: 'C', text: optC || (imgC ? '' : '-'), imageUrl: imgC || undefined },
        { key: 'D', text: optD || (imgD ? '' : '-'), imageUrl: imgD || undefined },
      ],
      correctAnswer,
      points,
      orderIndex: idx + 1,
    });
  });

  return { questions, errors };
}

/**
 * Import Questions from Word (.docx) supporting LaTeX ($...$), Gambar: <url>, Mapel:, Kelas:
 */
export async function parseQuestionsDocx(
  file: File,
  defaultTargetClasses: string[],
  defaultSubject = 'Matematika'
): Promise<{ questions: Question[]; errors: string[] }> {
  const arrayBuffer = await file.arrayBuffer();
  const { value: rawText } = await mammoth.extractRawText({ arrayBuffer });

  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let currentSubject = defaultSubject;
  let currentClasses = defaultTargetClasses.length > 0 ? defaultTargetClasses : [...ALL_CLASSES];

  const questions: Question[] = [];
  const errors: string[] = [];

  let activeQ: {
    questionText: string;
    questionImageUrl?: string;
    options: Partial<Record<OptionKey, string>>;
    correctAnswer: OptionKey;
  } | null = null;

  const flushQuestion = () => {
    if (!activeQ) return;
    if (activeQ.questionText && activeQ.options.A && activeQ.options.B) {
      questions.push({
        id: `q-docx-${Date.now()}-${questions.length + 1}`,
        subject: currentSubject,
        targetClasses: [...currentClasses],
        questionText: activeQ.questionText.trim(),
        questionImageUrl: activeQ.questionImageUrl,
        options: [
          { key: 'A', text: activeQ.options.A || '-' },
          { key: 'B', text: activeQ.options.B || '-' },
          { key: 'C', text: activeQ.options.C || '-' },
          { key: 'D', text: activeQ.options.D || '-' },
        ],
        correctAnswer: activeQ.correctAnswer,
        points: 10,
        orderIndex: questions.length + 1,
      });
    } else if (activeQ.questionText) {
      errors.push(`Soal "${activeQ.questionText.slice(0, 35)}..." dilewati karena opsi A/B kurang.`);
    }
    activeQ = null;
  };

  for (const line of lines) {
    const subjectMatch = line.match(/^(?:mapel|mata pelajaran)\s*[:=]\s*(.+)$/i);
    if (subjectMatch) {
      currentSubject = subjectMatch[1].trim();
      continue;
    }

    const classMatch = line.match(/^(?:kelas|target kelas)\s*[:=]\s*(.+)$/i);
    if (classMatch) {
      const parsed = parseTargetClassesInput(classMatch[1]);
      if (parsed.length > 0) currentClasses = parsed;
      continue;
    }

    const qStart = line.match(/^(\d+)[\.\)]\s*(.+)$/);
    if (qStart) {
      flushQuestion();
      activeQ = {
        questionText: qStart[2].trim(),
        options: {},
        correctAnswer: 'A',
      };
      continue;
    }

    const imgMatch = line.match(/^(?:gambar|image)\s*[:=]\s*(https?:\/\/\S+)$/i);
    if (imgMatch && activeQ) {
      activeQ.questionImageUrl = imgMatch[1].trim();
      continue;
    }

    const optMatch = line.match(/^([A-Da-d])[\.\)]\s*(.+)$/);
    if (optMatch && activeQ) {
      const key = optMatch[1].toUpperCase() as OptionKey;
      activeQ.options[key] = optMatch[2].trim();
      continue;
    }

    const keyMatch = line.match(/^(?:kunci|jawaban)\s*[:=]\s*([A-Da-d])/i);
    if (keyMatch && activeQ) {
      activeQ.correctAnswer = keyMatch[1].toUpperCase() as OptionKey;
      continue;
    }

    if (activeQ && Object.keys(activeQ.options).length === 0) {
      activeQ.questionText += ` ${line}`;
    }
  }

  flushQuestion();
  return { questions, errors };
}

export function downloadParticipantsTemplate(): void {
  const rows = [
    {
      'Nomor Peserta': '2026-7A-010',
      Token: 'TKN7A0',
      'Nama Lengkap': 'Andi Saputra',
      Kelas: '7A',
    },
    {
      'Nomor Peserta': '2026-8E-011',
      Token: 'TKN8E1',
      'Nama Lengkap': 'Bella Permata',
      Kelas: '8E',
    },
    {
      'Nomor Peserta': '2026-9I-012',
      Token: 'TKN9I2',
      'Nama Lengkap': 'Candra Wijaya',
      Kelas: '9I',
    },
  ];
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Peserta');
  XLSX.writeFile(wb, 'Template_Import_Peserta_Token_CBT.xlsx');
}

export function downloadQuestionsTemplate(): void {
  const rows = [
    {
      'Mata Pelajaran': 'Matematika',
      'Target Kelas': '7A-7I',
      Pertanyaan: 'Jika $\\frac{2x + 4}{3} = 6$, maka nilai $x$ adalah...',
      'Gambar URL': '',
      'Opsi A': '$5$',
      'Opsi B': '$7$',
      'Opsi C': '$9$',
      'Opsi D': '$11$',
      'Kunci Jawaban': 'B',
      Bobot: 25,
    },
    {
      'Mata Pelajaran': 'Ilmu Pengetahuan Alam',
      'Target Kelas': '8A, 8B, 8C',
      Pertanyaan: 'Rumus Hukum II Newton dinyatakan sebagai $F = m \\times a$. Satuan SI untuk gaya adalah...',
      'Gambar URL': '',
      'Opsi A': 'Joule',
      'Opsi B': 'Watt',
      'Opsi C': 'Newton',
      'Opsi D': 'Pascal',
      'Kunci Jawaban': 'C',
      Bobot: 25,
    },
  ];
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'BankSoal');
  XLSX.writeFile(wb, 'Template_Import_Bank_Soal_LaTeX_CBT.xlsx');
}

export async function downloadQuestionsWordTemplate(): Promise<void> {
  const lines = [
    'Mapel: Matematika',
    'Kelas: 7A-7I',
    '',
    '1. Tentukan nilai $x$ yang memenuhi persamaan $\\frac{3x - 3}{2} = 6$!',
    'A. $3$',
    'B. $5$',
    'C. $7$',
    'D. $9$',
    'Kunci: B',
    '',
    '2. Sebuah persegi memiliki luas $144\\text{ cm}^2$. Berapakah keliling persegi tersebut?',
    'A. $24\\text{ cm}$',
    'B. $36\\text{ cm}$',
    'C. $48\\text{ cm}$',
    'D. $72\\text{ cm}$',
    'Kunci: C',
  ];

  const doc = new Document({
    sections: [
      {
        children: lines.map(
          (line) =>
            new Paragraph({
              children: [new TextRun({ text: line, size: 22 })],
            })
        ),
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'Template_Import_Soal_Word_CBT.docx';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function getKkmForSubject(schedules: ExamSchedule[], subject: string): number {
  const matched = schedules.find(
    (s) => s.subject.toLowerCase() === subject.toLowerCase()
  );
  return matched ? matched.kkm : 75;
}

export function exportExamResultsExcel(
  results: ExamResult[],
  schedules: ExamSchedule[],
  schoolName: string
): void {
  const rows = results.map((r, index) => {
    const kkm = getKkmForSubject(schedules, r.subject);
    const kkmLabel =
      r.status === 'in_progress'
        ? 'Sedang Ujian'
        : r.score >= kkm
          ? 'Tuntas'
          : 'Belum Tuntas';

    return {
      No: index + 1,
      'Nomor Peserta': r.participantNumber,
      'Nama Peserta': r.studentName,
      Kelas: r.className,
      'Mata Pelajaran': r.subject || '-',
      'Jawaban Benar': r.correctCount,
      'Total Soal': r.totalQuestions,
      KKM: kkm,
      'Nilai Akhir': r.status === 'in_progress' ? 0 : r.score,
      Ketuntasan: kkmLabel,
      'Pelanggaran Tab': r.tabSwitchCount,
      'Waktu Selesai': r.submittedAt ? new Date(r.submittedAt).toLocaleString('id-ID') : '-',
    };
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'RekapNilai');
  const safeName = schoolName.replace(/[^a-zA-Z0-9]/g, '_');
  XLSX.writeFile(wb, `Rekap_Nilai_${safeName}_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

export function exportExamResultsPdf(
  results: ExamResult[],
  schedules: ExamSchedule[],
  profile: SchoolProfile,
  filters: { subject: string; className: string }
): void {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text(profile.schoolName.toUpperCase(), 14, 16);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(profile.address, 14, 21);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(`REKAPITULASI NILAI — ${profile.examTitle.toUpperCase()}`, 14, 29);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const mapelText = filters.subject === 'ALL' ? 'Semua Mata Pelajaran' : filters.subject;
  const kelasText = filters.className === 'ALL' ? 'Semua Kelas (7A–9I)' : `Kelas ${filters.className}`;
  doc.text(
    `Tahun Ajaran: ${profile.academicYear}  |  Filter Mapel: ${mapelText}  |  Filter Kelas: ${kelasText}`,
    14,
    34
  );

  const tableRows = results.map((r, idx) => {
    const kkm = getKkmForSubject(schedules, r.subject);
    const statusText =
      r.status === 'in_progress'
        ? 'Aktif'
        : r.score >= kkm
          ? 'Tuntas'
          : 'Belum Tuntas';
    return [
      String(idx + 1),
      r.participantNumber,
      r.studentName,
      r.className,
      r.subject || '-',
      `${r.correctCount}/${r.totalQuestions}`,
      String(kkm),
      r.status === 'in_progress' ? '-' : r.score.toFixed(1),
      statusText,
    ];
  });

  autoTable(doc, {
    startY: 39,
    head: [
      ['No', 'No. Peserta', 'Nama Peserta', 'Kelas', 'Mata Pelajaran', 'Benar', 'KKM', 'Nilai', 'Ket.'],
    ],
    body: tableRows,
    styles: { fontSize: 8, cellPadding: 2.2 },
    headStyles: { fillColor: [6, 78, 59], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: {
      0: { halign: 'center', cellWidth: 8 },
      3: { halign: 'center', cellWidth: 13 },
      5: { halign: 'center', cellWidth: 14 },
      6: { halign: 'center', cellWidth: 12 },
      7: { halign: 'right', cellWidth: 14 },
      8: { halign: 'center', cellWidth: 22 },
    },
  });

  const finalY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 120;
  if (finalY < 255) {
    doc.setFontSize(9);
    doc.text('Mengetahui,', 140, finalY + 12);
    doc.text('Kepala Sekolah / Ketua Panitia', 140, finalY + 17);
    doc.setFont('helvetica', 'bold');
    doc.text(profile.principalName, 140, finalY + 34);
  }

  const safeName = profile.schoolName.replace(/[^a-zA-Z0-9]/g, '_');
  doc.save(`Rekap_Nilai_${safeName}_${new Date().toISOString().slice(0, 10)}.pdf`);
}

async function convertDataUrlToPng(dataUrl: string): Promise<string | null> {
  if (!dataUrl) return null;
  if (dataUrl.startsWith('data:image/png')) return dataUrl;
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const size = 240;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.clearRect(0, 0, size, size);
        const scale = Math.min(size / img.width, size / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        resolve(canvas.toDataURL('image/png'));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

function fitTextSingleLine(doc: jsPDF, text: string, maxWidth: number): string {
  const clean = (text || '').trim();
  if (!clean) return '';
  if (doc.getTextWidth(clean) <= maxWidth) return clean;
  let truncated = clean;
  while (truncated.length > 3 && doc.getTextWidth(`${truncated}...`) > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}...`;
}

export async function exportExamCardsPdf(
  participants: Participant[],
  profile: SchoolProfile,
  classFilter = 'ALL'
): Promise<void> {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const logoPng = profile.logoDataUrl ? await convertDataUrlToPng(profile.logoDataUrl) : null;

  const marginX = 8;
  const marginY = 8.5;
  const cardW = 97; // 2 cols = 194mm
  const cardH = 56; // 5 rows = 280mm
  const padX = 3.5;
  const padY = 3;

  participants.forEach((student, idx) => {
    const indexOnPage = idx % 10;
    if (idx > 0 && indexOnPage === 0) {
      doc.addPage();
    }

    const col = indexOnPage % 2;
    const row = Math.floor(indexOnPage / 2);
    const x = marginX + col * cardW;
    const y = marginY + row * cardH;

    // White card background + dashed cut border
    doc.setFillColor(255, 255, 255);
    doc.rect(x, y, cardW, cardH, 'F');
    doc.setDrawColor(100, 116, 139);
    doc.setLineWidth(0.25);
    doc.setLineDashPattern([1.2, 1.2], 0);
    doc.rect(x, y, cardW, cardH, 'S');
    doc.setLineDashPattern([], 0);

    // Kop Instansi
    const logoSize = 11.5;
    const kopTop = y + padY;
    const hasLogo = Boolean(logoPng);
    if (logoPng) {
      try {
        doc.addImage(logoPng, 'PNG', x + padX, kopTop + 0.5, logoSize, logoSize);
      } catch {
        // Skip image if unreadable
      }
    }

    const textAreaLeft = x + padX + (hasLogo ? logoSize + 2 : 0);
    const textAreaWidth = cardW - padX * 2 - (hasLogo ? logoSize + 2 : 0);
    const textCenterX = textAreaLeft + textAreaWidth / 2;

    doc.setTextColor(15, 23, 42);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.text(
      fitTextSingleLine(doc, profile.schoolName.toUpperCase(), textAreaWidth),
      textCenterX,
      kopTop + 2.8,
      { align: 'center' }
    );

    doc.setTextColor(71, 85, 105);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6);
    doc.text(
      fitTextSingleLine(doc, profile.address, textAreaWidth),
      textCenterX,
      kopTop + 6,
      { align: 'center' }
    );

    // "KARTU PESERTA" berada di baris sendiri center di antara alamat lembaga dan judul ujian
    doc.setTextColor(15, 23, 42);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.text('KARTU PESERTA', textCenterX, kopTop + 9.6, { align: 'center' });

    doc.setTextColor(6, 78, 59);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.text(
      fitTextSingleLine(doc, `${profile.examTitle} (${profile.academicYear})`, textAreaWidth),
      textCenterX,
      kopTop + 13,
      { align: 'center' }
    );

    // Kop bottom border line
    const kopBottomY = kopTop + 15.2;
    doc.setDrawColor(30, 41, 59);
    doc.setLineWidth(0.35);
    doc.line(x + padX, kopBottomY, x + cardW - padX, kopBottomY);

    // Student fields
    const labelX = x + padX;
    const valueX = x + padX + 24;
    const valueMaxW = cardW - padX * 2 - 24;
    let curY = kopBottomY + 5;

    doc.setFontSize(7.5);
    doc.setTextColor(71, 85, 105);
    doc.setFont('helvetica', 'normal');
    doc.text('Nama Peserta', labelX, curY);
    doc.setTextColor(15, 23, 42);
    doc.setFont('helvetica', 'bold');
    doc.text(`: ${fitTextSingleLine(doc, student.fullName, valueMaxW - 2)}`, valueX, curY);

    curY += 4.5;
    doc.setTextColor(71, 85, 105);
    doc.setFont('helvetica', 'normal');
    doc.text('Kelas', labelX, curY);
    doc.setTextColor(15, 23, 42);
    doc.setFont('courier', 'bold');
    doc.text(`: ${student.className}`, valueX, curY);

    curY += 5;
    doc.setTextColor(51, 65, 85);
    doc.setFont('helvetica', 'bold');
    doc.text('No. Peserta', labelX, curY);

    doc.setFillColor(241, 245, 249);
    doc.setDrawColor(203, 213, 225);
    doc.setLineWidth(0.2);
    doc.roundedRect(valueX + 1.5, curY - 3.3, valueMaxW - 2, 4.6, 0.8, 0.8, 'FD');
    doc.setTextColor(15, 23, 42);
    doc.setFont('courier', 'bold');
    doc.setFontSize(8);
    doc.text(student.participantNumber, valueX + 3, curY);

    curY += 5.2;
    doc.setFontSize(7.5);
    doc.setTextColor(51, 65, 85);
    doc.setFont('helvetica', 'bold');
    doc.text('Token Ujian', labelX, curY);
    doc.setTextColor(6, 78, 59);
    doc.setFont('courier', 'bold');
    doc.setFontSize(8.5);
    doc.text(`: ${student.token || '-'}`, valueX, curY);

    // Bottom Footer & Signature
    const footerY = y + cardH - padY - 1;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6);
    doc.setTextColor(100, 116, 139);
    doc.text('Login dengan No. Peserta & Token.', labelX, footerY);

    const signRightX = x + cardW - padX;
    doc.setTextColor(51, 65, 85);
    doc.setFontSize(6.5);
    doc.text('Ketua Panitia,', signRightX, footerY - 6.8, { align: 'right' });

    doc.setFont('helvetica', 'bold');
    doc.setTextColor(15, 23, 42);
    const chairName = fitTextSingleLine(doc, profile.committeeChairName, 45);
    doc.text(chairName, signRightX, footerY, { align: 'right' });
    const chairW = doc.getTextWidth(chairName);
    doc.setDrawColor(148, 163, 184);
    doc.setLineWidth(0.2);
    doc.line(signRightX - chairW, footerY + 0.6, signRightX, footerY + 0.6);
  });

  const safeSchool = profile.schoolName.replace(/[^a-zA-Z0-9]/g, '_');
  const scopeSuffix = classFilter === 'ALL' ? 'Semua_Kelas' : `Kelas_${classFilter}`;
  doc.save(`Kartu_Peserta_${safeSchool}_${scopeSuffix}.pdf`);
}
