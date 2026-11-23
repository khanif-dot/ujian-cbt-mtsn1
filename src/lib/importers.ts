import {
  AlignmentType,
  BorderStyle,
  Document,
  HeightRule,
  ImageRun,
  Packer,
  PageBreak,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlignTable,
  WidthType,
} from 'docx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import {
  KEMENAG_HEADER_TITLE,
  KEMENAG_LOGO_DATA_URL,
} from '@/src/lib/seedData';
import {
  ALL_CLASSES,
  type ExamResult,
  type ExamSchedule,
  type OptionKey,
  type Participant,
  type Question,
  type QuestionOption,
  type RecapEntry,
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

function generateUuidLikeId(prefix: string): string {
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
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

export async function compressDataUrlImage(
  dataUrl: string,
  maxWidth = 820,
  maxHeight = 620,
  quality = 0.82
): Promise<string> {
  const trimmed = (dataUrl || '').trim();
  if (!trimmed.startsWith('data:image/') || typeof document === 'undefined') {
    return trimmed;
  }
  return new Promise((resolve) => {
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
        resolve(trimmed);
        return;
      }
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      const compressed = canvas.toDataURL('image/webp', quality);
      const candidate = compressed.startsWith('data:image/webp')
        ? compressed
        : canvas.toDataURL('image/png');
      resolve(candidate.length < trimmed.length ? candidate : trimmed);
    };
    img.onerror = () => resolve(trimmed);
    img.src = trimmed;
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
      id: generateUuidLikeId('ptc'),
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
  const subjectOrderCounter = new Map<string, number>();

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
    const rawKey = (
      map['kunci jawaban'] ||
      map['kunci'] ||
      map['correct_answer'] ||
      ''
    )
      .trim()
      .toUpperCase();
    const rawPoints = Number(map['bobot'] || map['poin'] || map['points'] || 10);
    const points = Number.isFinite(rawPoints) && rawPoints > 0 ? rawPoints : 10;

    const rawType = (
      map['jenis soal'] ||
      map['tipe soal'] ||
      map['question_type'] ||
      map['jenis'] ||
      ''
    )
      .trim()
      .toLowerCase();
    const isTrueFalse =
      rawType === 'true_false' ||
      rawType === 'benar salah' ||
      rawType === 'benar/salah' ||
      rawType === 'benar / salah' ||
      rawType === 'bs';

    const subjKey = subject.trim().toLowerCase();
    const resolvedClasses = targetClasses.length > 0 ? targetClasses : [...ALL_CLASSES];
    const groupOrderKey = `${subjKey}::${[...resolvedClasses].sort().join(',')}`;
    const nextOrder = (subjectOrderCounter.get(groupOrderKey) ?? 0) + 1;
    subjectOrderCounter.set(groupOrderKey, nextOrder);

    if (isTrueFalse) {
      if (!questionText && !questionImageUrl) {
        errors.push(`Baris ${idx + 2}: Teks/gambar pernyataan Benar Salah belum diisi.`);
        return;
      }
      let tfCorrect: OptionKey | null = null;
      if (rawKey === 'BENAR' || rawKey === 'A' || rawKey === 'TRUE' || rawKey === 'B') {
        tfCorrect = rawKey === 'B' && optB.toUpperCase() === 'SALAH' ? 'B' : 'A';
      }
      if (rawKey === 'SALAH' || rawKey === 'S' || rawKey === 'FALSE') {
        tfCorrect = 'B';
      }
      if (!tfCorrect) {
        errors.push(
          `Baris ${idx + 2}: Kunci jawaban Benar/Salah "${rawKey || '(kosong)'}" tidak valid (gunakan BENAR atau SALAH).`
        );
        return;
      }

      questions.push({
        id: `q-imp-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
        subject,
        targetClasses: targetClasses.length > 0 ? targetClasses : [...ALL_CLASSES],
        questionType: 'true_false',
        questionText,
        questionImageUrl: questionImageUrl || undefined,
        options: [
          { key: 'A', text: 'Benar' },
          { key: 'B', text: 'Salah' },
        ],
        correctAnswer: tfCorrect,
        points,
        orderIndex: nextOrder,
      });
      return;
    }

    if ((!questionText && !questionImageUrl) || (!optA && !imgA) || (!optB && !imgB)) {
      errors.push(`Baris ${idx + 2}: Teks/gambar soal atau opsi A/B belum lengkap.`);
      return;
    }

    if (!['A', 'B', 'C', 'D'].includes(rawKey)) {
      errors.push(
        `Baris ${idx + 2}: Kunci jawaban "${rawKey || '(kosong)'}" tidak valid (wajib A, B, C, atau D).`
      );
      return;
    }

    const correctAnswer = rawKey as OptionKey;
    const allBuiltOptions: QuestionOption[] = [
      { key: 'A', text: optA, imageUrl: imgA || undefined },
      { key: 'B', text: optB, imageUrl: imgB || undefined },
      { key: 'C', text: optC, imageUrl: imgC || undefined },
      { key: 'D', text: optD, imageUrl: imgD || undefined },
    ];
    const filteredOptions = allBuiltOptions.filter(
      (opt) => opt.key === 'A' || opt.key === 'B' || Boolean(opt.text || opt.imageUrl)
    );
    if (!filteredOptions.some((opt) => opt.key === correctAnswer)) {
      errors.push(
        `Baris ${idx + 2}: Kunci jawaban "${correctAnswer}" menunjuk ke opsi yang kosong.`
      );
      return;
    }

    questions.push({
      id: `q-imp-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
      subject,
      targetClasses: targetClasses.length > 0 ? targetClasses : [...ALL_CLASSES],
      questionType: 'multiple_choice',
      questionText,
      questionImageUrl: questionImageUrl || undefined,
      options: filteredOptions,
      correctAnswer,
      points,
      orderIndex: nextOrder,
    });
  });

  return { questions, errors };
}

/**
 * Import Questions from Word (.docx) supporting embedded Word images, LaTeX ($...$),
 * Gambar: <url>, Mapel:, Kelas:, Bobot:/Poin:
 */
export async function parseQuestionsDocx(
  file: File,
  defaultTargetClasses: string[],
  defaultSubject = 'Matematika'
): Promise<{ questions: Question[]; errors: string[] }> {
  const arrayBuffer = await file.arrayBuffer();
  const { value: htmlContent } = await mammoth.convertToHtml({ arrayBuffer });

  // Ekstrak blok paragraf & gambar embedded dari HTML hasil mammoth
  const tokens: Array<{ type: 'text'; value: string } | { type: 'image'; src: string }> = [];
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(htmlContent, 'text/html');
    const walkBlock = (el: Element) => {
      const imgs = el.querySelectorAll('img');
      const text = (el.textContent || '').replace(/\u00a0/g, ' ').trim();
      if (text) {
        text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .forEach((line) => tokens.push({ type: 'text', value: line }));
      }
      imgs.forEach((img) => {
        const src = img.getAttribute('src')?.trim();
        if (src) tokens.push({ type: 'image', src });
      });
    };

    const blocks = doc.body.querySelectorAll('p, li, h1, h2, h3, h4, td, th');
    if (blocks.length > 0) {
      blocks.forEach((b) => {
        // Avoid double-reading nested <p> inside <li> or <td>
        if ((b.tagName === 'LI' || b.tagName === 'TD' || b.tagName === 'TH') && b.querySelector('p')) {
          return;
        }
        walkBlock(b);
      });
    } else {
      const fallbackText = (doc.body.textContent || '').trim();
      fallbackText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .forEach((line) => tokens.push({ type: 'text', value: line }));
    }
  } else {
    const { value: rawText } = await mammoth.extractRawText({ arrayBuffer });
    rawText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .forEach((line) => tokens.push({ type: 'text', value: line }));
  }

  let currentSubject = defaultSubject;
  let currentClasses = defaultTargetClasses.length > 0 ? defaultTargetClasses : [...ALL_CLASSES];

  const questions: Question[] = [];
  const errors: string[] = [];
  const subjectOrderCounter = new Map<string, number>();

  let activeQ: {
    questionText: string;
    questionImageUrl?: string;
    options: Partial<Record<OptionKey, string>>;
    optionImages: Partial<Record<OptionKey, string>>;
    lastOptionKey: OptionKey | null;
    correctAnswer: OptionKey | null;
    points: number;
  } | null = null;

  const flushQuestion = () => {
    if (!activeQ) return;
    const hasPrompt = Boolean(activeQ.questionText.trim() || activeQ.questionImageUrl);
    const hasOptA = Boolean(activeQ.options.A?.trim() || activeQ.optionImages.A);
    const hasOptB = Boolean(activeQ.options.B?.trim() || activeQ.optionImages.B);

    if (hasPrompt && hasOptA && hasOptB) {
      if (!activeQ.correctAnswer) {
        errors.push(
          `Soal "${(activeQ.questionText || 'Bergambar').slice(0, 35)}..." tidak memiliki baris "Kunci: A/B/C/D" yang valid.`
        );
        activeQ = null;
        return;
      }

      const docxOptions: QuestionOption[] = (
        [
          { key: 'A', text: (activeQ.options.A || '').trim(), imageUrl: activeQ.optionImages.A },
          { key: 'B', text: (activeQ.options.B || '').trim(), imageUrl: activeQ.optionImages.B },
          { key: 'C', text: (activeQ.options.C || '').trim(), imageUrl: activeQ.optionImages.C },
          { key: 'D', text: (activeQ.options.D || '').trim(), imageUrl: activeQ.optionImages.D },
        ] as QuestionOption[]
      ).filter((opt) => opt.key === 'A' || opt.key === 'B' || Boolean(opt.text || opt.imageUrl));

      if (!docxOptions.some((opt) => opt.key === activeQ!.correctAnswer)) {
        errors.push(
          `Soal "${(activeQ.questionText || 'Bergambar').slice(0, 35)}..." memiliki kunci "${activeQ.correctAnswer}" tetapi opsi tersebut kosong.`
        );
        activeQ = null;
        return;
      }

      const subjKey = currentSubject.trim().toLowerCase();
      const groupOrderKey = `${subjKey}::${[...currentClasses].sort().join(',')}`;
      const nextOrder = (subjectOrderCounter.get(groupOrderKey) ?? 0) + 1;
      subjectOrderCounter.set(groupOrderKey, nextOrder);

      questions.push({
        id: `q-docx-${Date.now()}-${questions.length + 1}-${Math.random().toString(36).slice(2, 5)}`,
        subject: currentSubject,
        targetClasses: [...currentClasses],
        questionText: activeQ.questionText.trim(),
        questionImageUrl: activeQ.questionImageUrl,
        options: docxOptions,
        correctAnswer: activeQ.correctAnswer,
        points: activeQ.points,
        orderIndex: nextOrder,
      });
    } else if (hasPrompt) {
      errors.push(
        `Soal "${(activeQ.questionText || 'Bergambar').slice(0, 35)}..." dilewati karena opsi A/B kurang.`
      );
    }
    activeQ = null;
  };

  let expectedNum = 1;

  for (const token of tokens) {
    if (token.type === 'image') {
      if (activeQ) {
        if (activeQ.lastOptionKey && !activeQ.optionImages[activeQ.lastOptionKey]) {
          activeQ.optionImages[activeQ.lastOptionKey] = token.src;
        } else if (!activeQ.questionImageUrl) {
          activeQ.questionImageUrl = token.src;
        }
      }
      continue;
    }

    const line = token.value;

    const subjectMatch = line.match(/^(?:mapel|mata pelajaran)\s*[:=]\s*(.+)$/i);
    if (subjectMatch) {
      flushQuestion();
      currentSubject = subjectMatch[1].trim();
      expectedNum = 1;
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
      const numVal = Number(qStart[1]);
      const optCount = activeQ ? Object.keys(activeQ.options).length : 0;
      // Hindari salah deteksi tahun/angka di tengah teks soal (mis. "2026. ..." atau sebelum opsi dimulai)
      const isLikelyQuestionStart =
        !activeQ ||
        (numVal > 0 &&
          numVal <= 300 &&
          (numVal === expectedNum || optCount >= 2 || Boolean(activeQ.correctAnswer)));

      if (isLikelyQuestionStart) {
        flushQuestion();
        expectedNum = numVal + 1;
        activeQ = {
          questionText: qStart[2].trim(),
          options: {},
          optionImages: {},
          lastOptionKey: null,
          correctAnswer: null,
          points: 10,
        };
        continue;
      }
    }

    const imgMatch = line.match(/^(?:gambar|image)\s*[:=]\s*((?:https?:\/\/|data:image\/)\S+)$/i);
    if (imgMatch && activeQ) {
      activeQ.questionImageUrl = imgMatch[1].trim();
      continue;
    }

    const pointsMatch = line.match(/^(?:bobot|poin|points)\s*[:=]\s*(\d+)$/i);
    if (pointsMatch && activeQ) {
      const pVal = Number(pointsMatch[1]);
      if (Number.isFinite(pVal) && pVal > 0) activeQ.points = pVal;
      continue;
    }

    const optMatch = line.match(/^([A-Da-d])[\.\)]\s*(.*)$/);
    if (optMatch && activeQ) {
      const key = optMatch[1].toUpperCase() as OptionKey;
      activeQ.options[key] = optMatch[2].trim();
      activeQ.lastOptionKey = key;
      continue;
    }

    const keyMatch = line.match(/^(?:kunci(?:\s+jawaban)?|jawaban)\s*[:=]\s*([A-Da-d])\b/i);
    if (keyMatch && activeQ) {
      activeQ.correctAnswer = keyMatch[1].toUpperCase() as OptionKey;
      activeQ.lastOptionKey = null;
      continue;
    }

    if (activeQ) {
      if (activeQ.lastOptionKey) {
        activeQ.options[activeQ.lastOptionKey] = `${activeQ.options[activeQ.lastOptionKey] || ''} ${line}`.trim();
      } else {
        activeQ.questionText += ` ${line}`;
      }
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

export const PDF_RECAP_MAX_ROWS = 1500;

function buildScheduleLookups(schedules: ExamSchedule[]) {
  const byId = new Map<string, ExamSchedule>();
  const bySubject = new Map<string, ExamSchedule>();
  for (const s of schedules) {
    byId.set(s.id, s);
    const norm = (s.subject || '').trim().toLowerCase();
    if (norm && !bySubject.has(norm)) {
      bySubject.set(norm, s);
    }
  }
  return { byId, bySubject };
}

function resolveScheduleForExport(
  lookups: ReturnType<typeof buildScheduleLookups>,
  examId: string | undefined,
  subject: string
): ExamSchedule | undefined {
  if (examId) {
    const matchedById = lookups.byId.get(examId);
    if (matchedById) return matchedById;
  }
  const normSubj = (subject || '').trim().toLowerCase();
  return normSubj ? lookups.bySubject.get(normSubj) : undefined;
}

type ExportableResultRow = ExamResult | RecapEntry;

function getExportAttendanceStatus(
  row: ExportableResultRow
): 'completed' | 'flagged' | 'in_progress' | 'not_attended' {
  if ('attendanceStatus' in row) {
    return row.attendanceStatus;
  }
  if (row.status === 'in_progress') return 'in_progress';
  if (row.status === 'flagged') return 'flagged';
  return 'completed';
}

export function exportExamResultsExcel(
  results: ExportableResultRow[],
  schedules: ExamSchedule[],
  schoolName: string
): void {
  const lookups = buildScheduleLookups(schedules);
  const rows = results.map((r, index) => {
    const sched = resolveScheduleForExport(lookups, r.examId, r.subject);
    const kkm = sched ? sched.kkm : 75;
    const displaySubject = sched?.subject || r.subject || '-';
    const attStatus = getExportAttendanceStatus(r);
    const kkmLabel =
      attStatus === 'not_attended'
        ? 'Tidak Ikut Ujian'
        : attStatus === 'in_progress'
          ? 'Sedang Ujian'
          : r.score >= kkm
            ? 'Tuntas'
            : 'Belum Tuntas';

    return {
      No: index + 1,
      'Nomor Peserta': r.participantNumber,
      'Nama Peserta': r.studentName,
      Kelas: r.className,
      'Mata Pelajaran': displaySubject,
      'Jawaban Benar': attStatus === 'not_attended' ? 0 : r.correctCount,
      'Total Soal': r.totalQuestions,
      KKM: kkm,
      'Nilai Akhir': attStatus === 'in_progress' || attStatus === 'not_attended' ? 0 : r.score,
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

export interface PdfExportResult {
  ok: boolean;
  reason?: 'too_many_rows';
  rowCount: number;
}

export async function exportExamResultsPdf(
  results: ExportableResultRow[],
  schedules: ExamSchedule[],
  profile: SchoolProfile,
  filters: { subject: string; className: string; statusLabel?: string }
): Promise<PdfExportResult> {
  if (results.length > PDF_RECAP_MAX_ROWS) {
    return {
      ok: false,
      reason: 'too_many_rows',
      rowCount: results.length,
    };
  }

  const lookups = buildScheduleLookups(schedules);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const [kemenagPng, schoolLogoPng] = await Promise.all([
    convertDataUrlToPng(profile.kemenagLogoDataUrl || KEMENAG_LOGO_DATA_URL),
    profile.logoDataUrl ? convertDataUrlToPng(profile.logoDataUrl) : Promise.resolve(null),
  ]);

  const marginX = 12;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  let cursorY = drawPdfInstitutionKop(
    doc,
    profile,
    kemenagPng,
    schoolLogoPng,
    'REKAPITULASI NILAI HASIL UJIAN',
    `${(profile.examTitle || 'UJIAN CBT').toUpperCase()} — TAHUN AJARAN ${profile.academicYear}`
  );

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(51, 65, 85);
  const mapelText = filters.subject === 'ALL' ? 'Semua Mata Pelajaran' : filters.subject;
  const kelasText = filters.className === 'ALL' ? 'Semua Kelas (7A–9I)' : `Kelas ${filters.className}`;
  const statusSuffix = filters.statusLabel ? `  |  Status: ${filters.statusLabel}` : '';
  doc.text(
    fitTextSingleLine(
      doc,
      `Mata Pelajaran: ${mapelText}  |  Kelas: ${kelasText}${statusSuffix}`,
      pageWidth - marginX * 2
    ),
    pageWidth / 2,
    cursorY,
    { align: 'center' }
  );
  cursorY += 4;

  const omitClassCol = filters.className !== 'ALL';

  const tableRows = results.map((r, idx) => {
    const sched = resolveScheduleForExport(lookups, r.examId, r.subject);
    const kkm = sched ? sched.kkm : 75;
    const displaySubject = sched?.subject || r.subject || '-';
    const attStatus = getExportAttendanceStatus(r);
    const statusText =
      attStatus === 'not_attended'
        ? 'Tidak Ikut'
        : attStatus === 'in_progress'
          ? 'Aktif'
          : r.score >= kkm
            ? 'Tuntas'
            : 'Belum Tuntas';
    const baseRow = [
      String(idx + 1),
      r.participantNumber,
      r.studentName,
    ];
    if (!omitClassCol) {
      baseRow.push(r.className);
    }
    baseRow.push(
      displaySubject,
      attStatus === 'not_attended' && r.totalQuestions === 0
        ? '-'
        : `${r.correctCount}/${r.totalQuestions}`,
      String(kkm),
      attStatus === 'in_progress'
        ? '-'
        : attStatus === 'not_attended'
          ? '0.0'
          : r.score.toFixed(1),
      statusText
    );
    return baseRow;
  });

  // Compact row padding so a full class (~35-45 students) fits on 1 A4 page with signature
  const rowCount = results.length;
  let fontSize = 8;
  let padV = 1.5;
  if (rowCount > 28 && rowCount <= 36) {
    fontSize = 7.6;
    padV = 1.15;
  } else if (rowCount > 36 && rowCount <= 45) {
    fontSize = 7.2;
    padV = 0.85;
  } else if (rowCount > 45) {
    fontSize = 7.5;
    padV = 1.1;
  }

  autoTable(doc, {
    startY: cursorY,
    margin: { left: marginX, right: marginX, top: 8, bottom: 8 },
    rowPageBreak: 'avoid',
    head: [
      omitClassCol
        ? ['No', 'No. Peserta', 'Nama Peserta', 'Mata Pelajaran', 'Benar', 'KKM', 'Nilai', 'Ket.']
        : ['No', 'No. Peserta', 'Nama Peserta', 'Kelas', 'Mata Pelajaran', 'Benar', 'KKM', 'Nilai', 'Ket.'],
    ],
    body: tableRows,
    styles: {
      fontSize,
      cellPadding: { top: padV, right: 1.8, bottom: padV, left: 1.8 },
      valign: 'middle',
    },
    headStyles: {
      fillColor: [6, 78, 59],
      textColor: 255,
      fontStyle: 'bold',
      halign: 'center',
      cellPadding: { top: 2, right: 1.5, bottom: 2, left: 1.5 },
    },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: omitClassCol
      ? {
          0: { halign: 'center', cellWidth: 9 },
          1: { halign: 'center', cellWidth: 28, fontStyle: 'bold' },
          2: { halign: 'left', cellWidth: 52 },
          3: { halign: 'left', cellWidth: 37 },
          4: { halign: 'center', cellWidth: 14 },
          5: { halign: 'center', cellWidth: 12 },
          6: { halign: 'right', cellWidth: 13 },
          7: { halign: 'center', cellWidth: 21 },
        }
      : {
          0: { halign: 'center', cellWidth: 8 },
          1: { halign: 'center', cellWidth: 27, fontStyle: 'bold' },
          2: { halign: 'left', cellWidth: 46 },
          3: { halign: 'center', cellWidth: 12 },
          4: { halign: 'left', cellWidth: 34 },
          5: { halign: 'center', cellWidth: 14 },
          6: { halign: 'center', cellWidth: 12 },
          7: { halign: 'right', cellWidth: 13 },
          8: { halign: 'center', cellWidth: 20 },
        },
  });

  doc.setPage(doc.getNumberOfPages());
  const finalY =
    (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 120;

  const signX = Math.max(122, pageWidth - 78);
  const maxWidth = pageWidth - signX - marginX;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  const chairLines = doc.splitTextToSize(profile.committeeChairName || '-', maxWidth) as string[];
  const nameLineHeight = 3.8;
  const blockHeight = 20 + Math.max(1, chairLines.length) * nameLineHeight;

  let signY = finalY + 6;
  if (signY + blockHeight > pageHeight - 8) {
    doc.addPage();
    signY = 20;
  }

  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.text('Mengetahui,', signX, signY);
  doc.text('Ketua Panitia Ujian,', signX, signY + 4.2);

  const nameY = signY + 17;
  doc.setFont('helvetica', 'bold');
  doc.text(chairLines, signX, nameY);

  const lineY = nameY + Math.max(1, chairLines.length) * nameLineHeight + 0.8;
  doc.setDrawColor(100, 116, 139);
  doc.setLineWidth(0.3);
  doc.line(signX, lineY, signX + maxWidth, lineY);

  const safeName = profile.schoolName.replace(/[^a-zA-Z0-9]/g, '_');
  doc.save(`Rekap_Nilai_${safeName}_${new Date().toISOString().slice(0, 10)}.pdf`);
  return { ok: true, rowCount: results.length };
}

async function convertDataUrlToPng(dataUrl: string): Promise<string | null> {
  if (!dataUrl) return null;
  if (dataUrl.startsWith('data:image/png')) return dataUrl;

  let effectiveSrc = dataUrl;
  let revokeObjectUrl: string | null = null;
  if (/^https?:\/\//i.test(dataUrl)) {
    try {
      const resp = await fetch(dataUrl, { mode: 'cors' });
      if (resp.ok) {
        const blob = await resp.blob();
        effectiveSrc = URL.createObjectURL(blob);
        revokeObjectUrl = effectiveSrc;
      }
    } catch {
      // Fallback to direct <img> load below
    }
  }

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const cleanup = () => {
      if (revokeObjectUrl) {
        URL.revokeObjectURL(revokeObjectUrl);
        revokeObjectUrl = null;
      }
    };
    img.onload = () => {
      try {
        const size = 240;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          cleanup();
          resolve(null);
          return;
        }
        ctx.clearRect(0, 0, size, size);
        const scale = Math.min(size / img.width, size / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        const png = canvas.toDataURL('image/png');
        cleanup();
        resolve(png);
      } catch {
        cleanup();
        resolve(null);
      }
    };
    img.onerror = () => {
      cleanup();
      resolve(null);
    };
    img.src = effectiveSrc;
  });
}

async function dataUrlToPngUint8Array(dataUrl: string): Promise<Uint8Array | null> {
  const pngDataUrl = await convertDataUrlToPng(dataUrl);
  if (!pngDataUrl) return null;
  const commaIdx = pngDataUrl.indexOf(',');
  if (commaIdx === -1) return null;
  try {
    const b64 = pngDataUrl.slice(commaIdx + 1);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
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
  const [kemenagPng, schoolLogoPng] = await Promise.all([
    convertDataUrlToPng(profile.kemenagLogoDataUrl || KEMENAG_LOGO_DATA_URL),
    profile.logoDataUrl ? convertDataUrlToPng(profile.logoDataUrl) : Promise.resolve(null),
  ]);

  const marginX = 8;
  const marginY = 8.5;
  const cardW = 97; // 2 cols = 194mm
  const cardH = 56; // 5 rows = 280mm
  const padX = 3;
  const padY = 2.5;

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

    // Kop Instansi: Logo Kemenag (Kiri) + Teks Kop (Tengah) + Logo Sekolah (Kanan)
    const logoSize = 9.5;
    const kopTop = y + padY;
    if (kemenagPng) {
      try {
        doc.addImage(kemenagPng, 'PNG', x + padX, kopTop + 0.2, logoSize, logoSize);
      } catch {
        // Skip image if unreadable
      }
    }
    if (schoolLogoPng) {
      try {
        doc.addImage(
          schoolLogoPng,
          'PNG',
          x + cardW - padX - logoSize,
          kopTop + 0.2,
          logoSize,
          logoSize
        );
      } catch {
        // Skip image if unreadable
      }
    }

    const textAreaWidth = cardW - padX * 2 - (logoSize + 2) * 2;
    const textCenterX = x + cardW / 2;

    doc.setTextColor(15, 23, 42);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6);
    doc.text(
      fitTextSingleLine(doc, KEMENAG_HEADER_TITLE, textAreaWidth),
      textCenterX,
      kopTop + 2.5,
      { align: 'center' }
    );

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.text(
      fitTextSingleLine(doc, profile.schoolName.toUpperCase(), textAreaWidth),
      textCenterX,
      kopTop + 5.7,
      { align: 'center' }
    );

    doc.setTextColor(71, 85, 105);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(5.5);
    doc.text(
      fitTextSingleLine(doc, profile.address, textAreaWidth),
      textCenterX,
      kopTop + 8.6,
      { align: 'center' }
    );

    // Kop bottom border line
    const kopBottomY = kopTop + 10.4;
    doc.setDrawColor(30, 41, 59);
    doc.setLineWidth(0.35);
    doc.line(x + padX, kopBottomY, x + cardW - padX, kopBottomY);

    // "KARTU PESERTA" & judul ujian di bawah garis kop
    doc.setTextColor(15, 23, 42);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.text('KARTU PESERTA', textCenterX, kopBottomY + 3.4, { align: 'center' });

    doc.setTextColor(6, 78, 59);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.5);
    doc.text(
      fitTextSingleLine(doc, `${profile.examTitle} (${profile.academicYear})`, cardW - padX * 2),
      textCenterX,
      kopBottomY + 6.4,
      { align: 'center' }
    );

    // Student fields
    const labelX = x + padX;
    const valueX = x + padX + 24;
    const valueMaxW = cardW - padX * 2 - 24;
    let curY = kopBottomY + 11.2;

    doc.setFontSize(7.5);
    doc.setTextColor(71, 85, 105);
    doc.setFont('helvetica', 'normal');
    doc.text('Nama Peserta', labelX, curY);
    doc.setTextColor(15, 23, 42);
    doc.setFont('helvetica', 'bold');
    doc.text(`: ${fitTextSingleLine(doc, student.fullName, valueMaxW - 2)}`, valueX, curY);

    curY += 4.3;
    doc.setTextColor(71, 85, 105);
    doc.setFont('helvetica', 'normal');
    doc.text('Kelas', labelX, curY);
    doc.setTextColor(15, 23, 42);
    doc.setFont('courier', 'bold');
    doc.text(`: ${student.className}`, valueX, curY);

    curY += 4.8;
    doc.setTextColor(51, 65, 85);
    doc.setFont('helvetica', 'bold');
    doc.text('No. Peserta', labelX, curY);

    const boxX = valueX + 1.5;
    const boxW = valueMaxW - 2;
    doc.setFillColor(241, 245, 249);
    doc.setDrawColor(203, 213, 225);
    doc.setLineWidth(0.2);
    doc.roundedRect(boxX, curY - 3.3, boxW, 4.6, 0.8, 0.8, 'FD');
    doc.setTextColor(15, 23, 42);
    doc.setFont('courier', 'bold');
    doc.setFontSize(8);
    doc.text(student.participantNumber, boxX + boxW / 2, curY, { align: 'center' });

    curY += 5.0;
    doc.setFontSize(7.5);
    doc.setTextColor(51, 65, 85);
    doc.setFont('helvetica', 'bold');
    doc.text('Token Ujian', labelX, curY);
    doc.setTextColor(6, 78, 59);
    doc.setFont('courier', 'bold');
    doc.setFontSize(8.5);
    doc.text(`: ${student.token || '-'}`, valueX, curY);

    // Bottom Footer & Signature
    const footerY = y + cardH - padY - 0.8;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6);
    doc.setTextColor(100, 116, 139);
    doc.text('Login dengan No. Peserta & Token.', labelX, footerY);

    const signRightX = x + cardW - padX;
    doc.setTextColor(51, 65, 85);
    doc.setFontSize(6.5);
    doc.text('Ketua Panitia,', signRightX, footerY - 6.5, { align: 'right' });

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

export interface ExamDocumentMeta {
  subject: string;
  className: string;
  roomName: string;
  examDate: string;
  timeRange: string;
  sessionLabel: string;
  supervisor1: string;
  supervisor2: string;
  notes: string;
  splitByClass?: boolean;
  signatureStyle?: 'zigzag' | 'single';
}

interface IndonesianDateParts {
  hari: string;
  tanggal: string;
  bulan: string;
  tahun: string;
  full: string;
}

const INDONESIAN_DAYS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const INDONESIAN_MONTHS = [
  'Januari',
  'Februari',
  'Maret',
  'April',
  'Mei',
  'Juni',
  'Juli',
  'Agustus',
  'September',
  'Oktober',
  'November',
  'Desember',
];

function formatIndonesianDateParts(dateStr: string): IndonesianDateParts {
  const clean = (dateStr || '').trim();
  const match = clean.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const year = Number(match[1]);
    const monthIdx = Number(match[2]) - 1;
    const day = Number(match[3]);
    const dt = new Date(year, monthIdx, day);
    if (
      !Number.isNaN(dt.getTime()) &&
      dt.getFullYear() === year &&
      dt.getMonth() === monthIdx &&
      dt.getDate() === day
    ) {
      const hari = INDONESIAN_DAYS[dt.getDay()] || '................';
      const bulan = INDONESIAN_MONTHS[monthIdx] || '................';
      const tanggal = String(day);
      const tahun = String(year);
      return {
        hari,
        tanggal,
        bulan,
        tahun,
        full: `${hari}, ${day} ${bulan} ${year}`,
      };
    }
  }
  return {
    hari: '....................',
    tanggal: '......',
    bulan: '....................',
    tahun: '20....',
    full: '...................., ...... .................... 20....',
  };
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function sanitizeFilenamePart(value: string, fallback = 'Dokumen'): string {
  const cleaned = (value || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

function groupAttendanceParticipants(
  participants: Participant[],
  meta: ExamDocumentMeta
): Array<{ classLabel: string; items: Participant[] }> {
  const sorted = [...participants].sort((a, b) =>
    a.className !== b.className
      ? a.className.localeCompare(b.className, 'id', { numeric: true })
      : a.participantNumber.localeCompare(b.participantNumber, 'id', { numeric: true }) ||
        a.fullName.localeCompare(b.fullName, 'id')
  );

  if (meta.splitByClass && meta.className === 'ALL') {
    const groups = new Map<string, Participant[]>();
    for (const p of sorted) {
      const key = p.className || '-';
      const list = groups.get(key) || [];
      list.push(p);
      groups.set(key, list);
    }
    return Array.from(groups.entries()).map(([cls, items]) => ({
      classLabel: `Kelas ${cls}`,
      items,
    }));
  }

  return [
    {
      classLabel:
        meta.className === 'ALL'
          ? 'Semua Kelas'
          : `Kelas ${meta.className}`,
      items: sorted,
    },
  ];
}

function drawPdfInstitutionKop(
  doc: jsPDF,
  profile: SchoolProfile,
  kemenagPng: string | null,
  schoolLogoPng: string | null,
  documentTitle: string,
  subtitle: string
): number {
  const pageWidth = doc.internal.pageSize.getWidth();
  const marginX = 12;
  const logoSize = 15;
  const kopTopY = 8.5;

  // Logo Kiri: Kementerian Agama RI
  if (kemenagPng) {
    try {
      doc.addImage(kemenagPng, 'PNG', marginX, kopTopY, logoSize, logoSize);
    } catch {
      // Ignore logo render failure
    }
  }

  // Logo Kanan: Sekolah / Madrasah
  if (schoolLogoPng) {
    try {
      doc.addImage(
        schoolLogoPng,
        'PNG',
        pageWidth - marginX - logoSize,
        kopTopY,
        logoSize,
        logoSize
      );
    } catch {
      // Ignore logo render failure
    }
  }

  const textCenterX = pageWidth / 2;
  const textMaxW = pageWidth - marginX * 2 - (logoSize + 4) * 2;

  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text(fitTextSingleLine(doc, KEMENAG_HEADER_TITLE, textMaxW), textCenterX, 12.2, {
    align: 'center',
  });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12.5);
  doc.text(fitTextSingleLine(doc, profile.schoolName.toUpperCase(), textMaxW), textCenterX, 17, {
    align: 'center',
  });

  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8.2);
  doc.setTextColor(51, 65, 85);
  const addrLines = doc.splitTextToSize(profile.address || '', textMaxW) as string[];
  doc.text(addrLines.slice(0, 2), textCenterX, 21, { align: 'center' });

  const dividerY = Math.max(25.5, 21 + Math.min(2, addrLines.length) * 3.4 + 0.8);
  doc.setDrawColor(15, 23, 42);
  doc.setLineWidth(0.7);
  doc.line(marginX, dividerY, pageWidth - marginX, dividerY);
  doc.setLineWidth(0.25);
  doc.line(marginX, dividerY + 1, pageWidth - marginX, dividerY + 1);

  const titleY = dividerY + 6.2;
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(documentTitle, pageWidth / 2, titleY, { align: 'center' });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.8);
  doc.setTextColor(6, 78, 59);
  doc.text(subtitle, pageWidth / 2, titleY + 4.2, { align: 'center' });

  return titleY + 8.5;
}

export async function exportAttendancePdf(
  participants: Participant[],
  profile: SchoolProfile,
  meta: ExamDocumentMeta
): Promise<void> {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const [kemenagPng, schoolLogoPng] = await Promise.all([
    convertDataUrlToPng(profile.kemenagLogoDataUrl || KEMENAG_LOGO_DATA_URL),
    profile.logoDataUrl ? convertDataUrlToPng(profile.logoDataUrl) : Promise.resolve(null),
  ]);
  const dateParts = formatIndonesianDateParts(meta.examDate);
  const groups = groupAttendanceParticipants(participants, meta);
  const signatureStyle = meta.signatureStyle || 'zigzag';

  const subjectDisplay =
    meta.subject && meta.subject !== 'ALL'
      ? meta.subject
      : '..................................................';
  const roomSessionDisplay = [meta.roomName.trim(), meta.sessionLabel.trim()]
    .filter(Boolean)
    .join(' / ') || '....................................';
  const timeDisplay = meta.timeRange.trim() || '............ s.d. ............ WIB';

  groups.forEach((group, groupIdx) => {
    if (groupIdx > 0) {
      doc.addPage();
    }

    let cursorY = drawPdfInstitutionKop(
      doc,
      profile,
      kemenagPng,
      schoolLogoPng,
      'DAFTAR HADIR PESERTA UJIAN',
      `${(profile.examTitle || 'UJIAN CBT').toUpperCase()} — TAHUN AJARAN ${profile.academicYear}`
    );

    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const marginX = 12;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(15, 23, 42);

    const col1LabelX = marginX;
    const col1ValX = marginX + 28;
    const col2LabelX = 112;
    const col2ValX = 138;

    doc.text('Mata Pelajaran', col1LabelX, cursorY);
    doc.text(`: ${fitTextSingleLine(doc, subjectDisplay, 50)}`, col1ValX, cursorY);
    doc.text('Hari / Tanggal', col2LabelX, cursorY);
    doc.text(`: ${fitTextSingleLine(doc, dateParts.full, 58)}`, col2ValX, cursorY);

    cursorY += 4.1;
    doc.text('Kelas', col1LabelX, cursorY);
    doc.setFont('helvetica', 'bold');
    doc.text(`: ${group.classLabel}`, col1ValX, cursorY);
    doc.setFont('helvetica', 'normal');
    doc.text('Waktu / Pukul', col2LabelX, cursorY);
    doc.text(`: ${fitTextSingleLine(doc, timeDisplay, 58)}`, col2ValX, cursorY);

    cursorY += 4.1;
    doc.text('Ruang / Sesi', col1LabelX, cursorY);
    doc.text(`: ${fitTextSingleLine(doc, roomSessionDisplay, 50)}`, col1ValX, cursorY);
    doc.text('Jumlah Peserta', col2LabelX, cursorY);
    doc.setFont('helvetica', 'bold');
    doc.text(`: ${group.items.length} Siswa`, col2ValX, cursorY);
    doc.setFont('helvetica', 'normal');

    cursorY += 3.5;

    const tableBody = group.items.map((p, idx) => {
      const rowNum = idx + 1;
      const sigLabel =
        signatureStyle === 'zigzag'
          ? rowNum % 2 === 1
            ? `${rowNum}. ........................`
            : `                       ${rowNum}. ........................`
          : `${rowNum}. ........................................`;

      return [
        String(rowNum),
        p.participantNumber,
        p.fullName,
        sigLabel,
        '',
      ];
    });

    // Reduce row spacing so a full class fits cleanly on 1 A4 page
    const rowCount = group.items.length;
    let bodyFontSize = 8.2;
    let padV = 1.4;
    if (rowCount > 24 && rowCount <= 32) {
      bodyFontSize = 7.8;
      padV = 1.1;
    } else if (rowCount > 32 && rowCount <= 38) {
      bodyFontSize = 7.4;
      padV = 0.85;
    } else if (rowCount > 38 && rowCount <= 44) {
      bodyFontSize = 7.0;
      padV = 0.65;
    } else if (rowCount > 44 && rowCount <= 50) {
      bodyFontSize = 6.7;
      padV = 0.5;
    } else if (rowCount > 50) {
      bodyFontSize = 7.4;
      padV = 0.9;
    }

    autoTable(doc, {
      startY: cursorY,
      margin: { left: marginX, right: marginX, top: 8, bottom: 7 },
      rowPageBreak: 'avoid',
      head: [['No', 'Nomor Peserta', 'Nama Peserta', 'Tanda Tangan', 'Ket.']],
      body: tableBody,
      theme: 'grid',
      styles: {
        fontSize: bodyFontSize,
        textColor: [15, 23, 42],
        lineColor: [148, 163, 184],
        lineWidth: 0.2,
        cellPadding: { top: padV, right: 2, bottom: padV, left: 2 },
        valign: 'middle',
      },
      headStyles: {
        fillColor: [6, 78, 59],
        textColor: 255,
        fontStyle: 'bold',
        halign: 'center',
        cellPadding: { top: 1.8, right: 2, bottom: 1.8, left: 2 },
      },
      columnStyles: {
        0: { halign: 'center', cellWidth: 9 },
        1: { halign: 'center', cellWidth: 33, fontStyle: 'bold' },
        2: { halign: 'left', cellWidth: 68 },
        3: {
          halign: 'left',
          cellWidth: 56,
          fontSize: Math.max(6.5, bodyFontSize - 0.4),
          textColor: [100, 116, 139],
        },
        4: { halign: 'center', cellWidth: 20 },
      },
    });

    doc.setPage(doc.getNumberOfPages());
    const tableEndY =
      (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ??
      cursorY + 30;

    const neededFooterHeight = 46;
    let footerY = tableEndY + 3.5;
    if (footerY + neededFooterHeight > pageHeight - 6) {
      doc.addPage();
      footerY = 16;
    }

    // Tally box (filled during/after exam)
    doc.setDrawColor(148, 163, 184);
    doc.setLineWidth(0.25);
    doc.setFillColor(248, 250, 252);
    doc.roundedRect(marginX, footerY, pageWidth - marginX * 2, 7.5, 1.2, 1.2, 'FD');

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(15, 23, 42);
    doc.text(
      `Jumlah Peserta Seharusnya: ${group.items.length} siswa    |    Hadir: ........... siswa    |    Tidak Hadir: ........... siswa`,
      pageWidth / 2,
      footerY + 4.9,
      { align: 'center' }
    );

    const signTopY = footerY + 11.5;
    const leftSignX = marginX + 6;
    const rightSignX = pageWidth - marginX - 58;
    const sup1Name = meta.supervisor1.trim() || '............................................';
    const sup2Name = meta.supervisor2.trim() || '............................................';
    const chairName =
      (profile.committeeChairName || '').trim() || '............................................';

    doc.setFontSize(8.5);
    doc.text('Pengawas Ruang 1,', leftSignX, signTopY);
    doc.text('Pengawas Ruang 2 / Proktor,', rightSignX, signTopY);

    doc.setFont('helvetica', 'bold');
    doc.text(fitTextSingleLine(doc, sup1Name, 60), leftSignX, signTopY + 12.5);
    doc.text(fitTextSingleLine(doc, sup2Name, 60), rightSignX, signTopY + 12.5);

    const chairSignY = signTopY + 18;
    doc.setFont('helvetica', 'normal');
    doc.text('Mengetahui,', pageWidth / 2, chairSignY, { align: 'center' });
    doc.text('Ketua Panitia Ujian,', pageWidth / 2, chairSignY + 4, { align: 'center' });

    doc.setFont('helvetica', 'bold');
    doc.text(fitTextSingleLine(doc, chairName, 85), pageWidth / 2, chairSignY + 15.5, {
      align: 'center',
    });
  });

  const safeSchool = sanitizeFilenamePart(profile.schoolName, 'Sekolah');
  const safeClass =
    meta.className === 'ALL' ? 'Semua_Kelas' : sanitizeFilenamePart(meta.className, 'Kelas');
  doc.save(`Daftar_Hadir_Peserta_${safeSchool}_${safeClass}.pdf`);
}

function buildDocxNoBorders() {
  return {
    top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  };
}

function buildDocxGridBorders() {
  return {
    top: { style: BorderStyle.SINGLE, size: 6, color: '475569' },
    bottom: { style: BorderStyle.SINGLE, size: 6, color: '475569' },
    left: { style: BorderStyle.SINGLE, size: 6, color: '475569' },
    right: { style: BorderStyle.SINGLE, size: 6, color: '475569' },
    insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: '94A3B8' },
    insideVertical: { style: BorderStyle.SINGLE, size: 4, color: '94A3B8' },
  };
}

function buildDocxKopElements(
  profile: SchoolProfile,
  kemenagBytes: Uint8Array | null,
  schoolLogoBytes: Uint8Array | null,
  title: string,
  subtitle: string
): Array<Paragraph | Table> {
  const logoImgCell = (bytes: Uint8Array | null, align: (typeof AlignmentType)[keyof typeof AlignmentType]) =>
    new TableCell({
      width: { size: 13, type: WidthType.PERCENTAGE },
      verticalAlign: VerticalAlignTable.CENTER,
      margins: { top: 20, bottom: 20, left: 20, right: 20 },
      children: [
        new Paragraph({
          alignment: align,
          spacing: { after: 0 },
          children: bytes
            ? [
                new ImageRun({
                  type: 'png',
                  data: bytes,
                  transformation: { width: 50, height: 50 },
                }),
              ]
            : [],
        }),
      ],
    });

  const kopTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: buildDocxNoBorders(),
    rows: [
      new TableRow({
        cantSplit: true,
        children: [
          logoImgCell(kemenagBytes, AlignmentType.LEFT),
          new TableCell({
            width: { size: 74, type: WidthType.PERCENTAGE },
            verticalAlign: VerticalAlignTable.CENTER,
            margins: { top: 20, bottom: 20, left: 40, right: 40 },
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { after: 20 },
                children: [
                  new TextRun({
                    text: KEMENAG_HEADER_TITLE,
                    bold: true,
                    size: 21,
                    font: 'Calibri',
                  }),
                ],
              }),
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { after: 20 },
                children: [
                  new TextRun({
                    text: profile.schoolName.toUpperCase(),
                    bold: true,
                    size: 25,
                    font: 'Calibri',
                  }),
                ],
              }),
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { after: 0 },
                children: [
                  new TextRun({
                    text: profile.address || '-',
                    italics: true,
                    size: 17,
                    color: '334155',
                    font: 'Calibri',
                  }),
                ],
              }),
            ],
          }),
          logoImgCell(schoolLogoBytes, AlignmentType.RIGHT),
        ],
      }),
    ],
  });

  return [
    kopTable,
    new Paragraph({
      spacing: { before: 20, after: 80 },
      border: {
        bottom: {
          style: BorderStyle.DOUBLE,
          size: 12,
          color: '0F172A',
          space: 4,
        },
      },
      children: [],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 40, after: 20 },
      children: [
        new TextRun({
          text: title,
          bold: true,
          size: 22,
          font: 'Calibri',
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 100 },
      children: [
        new TextRun({
          text: subtitle,
          bold: true,
          size: 18,
          color: '064E3B',
          font: 'Calibri',
        }),
      ],
    }),
  ];
}

export async function exportAttendanceWord(
  participants: Participant[],
  profile: SchoolProfile,
  meta: ExamDocumentMeta
): Promise<void> {
  const [kemenagBytes, schoolLogoBytes] = await Promise.all([
    dataUrlToPngUint8Array(profile.kemenagLogoDataUrl || KEMENAG_LOGO_DATA_URL),
    profile.logoDataUrl ? dataUrlToPngUint8Array(profile.logoDataUrl) : Promise.resolve(null),
  ]);
  const dateParts = formatIndonesianDateParts(meta.examDate);
  const groups = groupAttendanceParticipants(participants, meta);
  const signatureStyle = meta.signatureStyle || 'zigzag';

  const subjectDisplay =
    meta.subject && meta.subject !== 'ALL'
      ? meta.subject
      : '..................................................';
  const roomSessionDisplay = [meta.roomName.trim(), meta.sessionLabel.trim()]
    .filter(Boolean)
    .join(' / ') || '....................................';
  const timeDisplay = meta.timeRange.trim() || '............ s.d. ............ WIB';
  const sup1Name = meta.supervisor1.trim() || '............................................';
  const sup2Name = meta.supervisor2.trim() || '............................................';
  const chairName =
    (profile.committeeChairName || '').trim() || '............................................';

  const children: Array<Paragraph | Table> = [];

  groups.forEach((group, groupIdx) => {
    if (groupIdx > 0) {
      children.push(new Paragraph({ children: [new PageBreak()] }));
    }

    children.push(
      ...buildDocxKopElements(
        profile,
        kemenagBytes,
        schoolLogoBytes,
        'DAFTAR HADIR PESERTA UJIAN',
        `${(profile.examTitle || 'UJIAN CBT').toUpperCase()} — TAHUN AJARAN ${profile.academicYear}`
      )
    );

    const makeMetaCell = (text: string, bold = false, widthPct = 25) =>
      new TableCell({
        width: { size: widthPct, type: WidthType.PERCENTAGE },
        margins: { top: 20, bottom: 20, left: 40, right: 40 },
        children: [
          new Paragraph({
            spacing: { after: 0 },
            children: [
              new TextRun({
                text,
                bold,
                size: 18,
                font: 'Calibri',
              }),
            ],
          }),
        ],
      });

    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        layout: TableLayoutType.FIXED,
        borders: buildDocxNoBorders(),
        rows: [
          new TableRow({
            children: [
              makeMetaCell('Mata Pelajaran', false, 18),
              makeMetaCell(`: ${subjectDisplay}`, true, 32),
              makeMetaCell('Hari / Tanggal', false, 18),
              makeMetaCell(`: ${dateParts.full}`, false, 32),
            ],
          }),
          new TableRow({
            children: [
              makeMetaCell('Kelas', false, 18),
              makeMetaCell(`: ${group.classLabel}`, true, 32),
              makeMetaCell('Waktu / Pukul', false, 18),
              makeMetaCell(`: ${timeDisplay}`, false, 32),
            ],
          }),
          new TableRow({
            children: [
              makeMetaCell('Ruang / Sesi', false, 18),
              makeMetaCell(`: ${roomSessionDisplay}`, false, 32),
              makeMetaCell('Jumlah Peserta', false, 18),
              makeMetaCell(`: ${group.items.length} Siswa`, true, 32),
            ],
          }),
        ],
      })
    );

    children.push(new Paragraph({ spacing: { after: 60 } }));

    const makeHeaderCell = (label: string, widthPct: number) =>
      new TableCell({
        width: { size: widthPct, type: WidthType.PERCENTAGE },
        verticalAlign: VerticalAlignTable.CENTER,
        shading: { fill: '064E3B', type: ShadingType.CLEAR, color: 'auto' },
        margins: { top: 50, bottom: 50, left: 70, right: 70 },
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 0 },
            children: [
              new TextRun({
                text: label,
                bold: true,
                color: 'FFFFFF',
                size: 17,
                font: 'Calibri',
              }),
            ],
          }),
        ],
      });

    const headerRow = new TableRow({
      tableHeader: true,
      cantSplit: true,
      children: [
        makeHeaderCell('No', 6),
        makeHeaderCell('Nomor Peserta', 20),
        makeHeaderCell('Nama Peserta', 36),
        makeHeaderCell('Tanda Tangan', 26),
        makeHeaderCell('Ket.', 12),
      ],
    });

    const dataRows = group.items.map((p, idx) => {
      const rowNum = idx + 1;
      const isZigzagRight = signatureStyle === 'zigzag' && rowNum % 2 === 0;
      const sigText =
        signatureStyle === 'zigzag'
          ? `${rowNum}. .......................`
          : `${rowNum}. .............................`;

      return new TableRow({
        cantSplit: true,
        height: { value: 280, rule: HeightRule.ATLEAST },
        children: [
          new TableCell({
            width: { size: 6, type: WidthType.PERCENTAGE },
            verticalAlign: VerticalAlignTable.CENTER,
            margins: { top: 24, bottom: 24, left: 60, right: 60 },
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { after: 0 },
                children: [new TextRun({ text: String(rowNum), size: 17, font: 'Calibri' })],
              }),
            ],
          }),
          new TableCell({
            width: { size: 20, type: WidthType.PERCENTAGE },
            verticalAlign: VerticalAlignTable.CENTER,
            margins: { top: 24, bottom: 24, left: 60, right: 60 },
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { after: 0 },
                children: [
                  new TextRun({
                    text: p.participantNumber,
                    bold: true,
                    size: 17,
                    font: 'Consolas',
                  }),
                ],
              }),
            ],
          }),
          new TableCell({
            width: { size: 36, type: WidthType.PERCENTAGE },
            verticalAlign: VerticalAlignTable.CENTER,
            margins: { top: 24, bottom: 24, left: 75, right: 75 },
            children: [
              new Paragraph({
                spacing: { after: 0 },
                children: [new TextRun({ text: p.fullName, size: 17, font: 'Calibri' })],
              }),
            ],
          }),
          new TableCell({
            width: { size: 26, type: WidthType.PERCENTAGE },
            verticalAlign: VerticalAlignTable.CENTER,
            margins: { top: 24, bottom: 24, left: 80, right: 80 },
            children: [
              new Paragraph({
                alignment: isZigzagRight ? AlignmentType.RIGHT : AlignmentType.LEFT,
                spacing: { after: 0 },
                children: [
                  new TextRun({
                    text: sigText,
                    size: 16,
                    color: '64748B',
                    font: 'Calibri',
                  }),
                ],
              }),
            ],
          }),
          new TableCell({
            width: { size: 12, type: WidthType.PERCENTAGE },
            verticalAlign: VerticalAlignTable.CENTER,
            margins: { top: 24, bottom: 24, left: 60, right: 60 },
            children: [new Paragraph({ spacing: { after: 0 }, children: [] })],
          }),
        ],
      });
    });

    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        layout: TableLayoutType.FIXED,
        borders: buildDocxGridBorders(),
        rows: [headerRow, ...dataRows],
      })
    );

    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 100, after: 120 },
        children: [
          new TextRun({
            text: `Jumlah Peserta Seharusnya: ${group.items.length} siswa    |    Hadir: ............ siswa    |    Tidak Hadir: ............ siswa`,
            size: 17,
            font: 'Calibri',
          }),
        ],
      })
    );

    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        layout: TableLayoutType.FIXED,
        borders: buildDocxNoBorders(),
        rows: [
          new TableRow({
            cantSplit: true,
            children: [
              new TableCell({
                width: { size: 50, type: WidthType.PERCENTAGE },
                children: [
                  new Paragraph({
                    spacing: { after: 440 },
                    children: [new TextRun({ text: 'Pengawas Ruang 1,', size: 18, font: 'Calibri' })],
                  }),
                  new Paragraph({
                    spacing: { after: 0 },
                    children: [new TextRun({ text: sup1Name, bold: true, size: 18, font: 'Calibri' })],
                  }),
                ],
              }),
              new TableCell({
                width: { size: 50, type: WidthType.PERCENTAGE },
                children: [
                  new Paragraph({
                    spacing: { after: 440 },
                    children: [
                      new TextRun({ text: 'Pengawas Ruang 2 / Proktor,', size: 18, font: 'Calibri' }),
                    ],
                  }),
                  new Paragraph({
                    spacing: { after: 0 },
                    children: [new TextRun({ text: sup2Name, bold: true, size: 18, font: 'Calibri' })],
                  }),
                ],
              }),
            ],
          }),
        ],
      })
    );

    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        layout: TableLayoutType.FIXED,
        borders: buildDocxNoBorders(),
        rows: [
          new TableRow({
            cantSplit: true,
            children: [
              new TableCell({
                width: { size: 100, type: WidthType.PERCENTAGE },
                margins: { top: 140, bottom: 20, left: 40, right: 40 },
                children: [
                  new Paragraph({
                    alignment: AlignmentType.CENTER,
                    spacing: { after: 20 },
                    children: [new TextRun({ text: 'Mengetahui,', size: 18, font: 'Calibri' })],
                  }),
                  new Paragraph({
                    alignment: AlignmentType.CENTER,
                    spacing: { after: 440 },
                    children: [
                      new TextRun({ text: 'Ketua Panitia Ujian,', size: 18, font: 'Calibri' }),
                    ],
                  }),
                  new Paragraph({
                    alignment: AlignmentType.CENTER,
                    spacing: { after: 0 },
                    children: [
                      new TextRun({ text: chairName, bold: true, size: 18, font: 'Calibri' }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      })
    );
  });

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: { top: 480, right: 640, bottom: 480, left: 640 },
          },
        },
        children,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const safeSchool = sanitizeFilenamePart(profile.schoolName, 'Sekolah');
  const safeClass =
    meta.className === 'ALL' ? 'Semua_Kelas' : sanitizeFilenamePart(meta.className, 'Kelas');
  triggerBlobDownload(blob, `Daftar_Hadir_Peserta_${safeSchool}_${safeClass}.docx`);
}

export async function exportBeritaAcaraPdf(
  expectedParticipantsCount: number,
  profile: SchoolProfile,
  meta: ExamDocumentMeta
): Promise<void> {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const [kemenagPng, schoolLogoPng] = await Promise.all([
    convertDataUrlToPng(profile.kemenagLogoDataUrl || KEMENAG_LOGO_DATA_URL),
    profile.logoDataUrl ? convertDataUrlToPng(profile.logoDataUrl) : Promise.resolve(null),
  ]);
  const dateParts = formatIndonesianDateParts(meta.examDate);

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginX = 14;
  const contentWidth = pageWidth - marginX * 2;

  let cursorY = drawPdfInstitutionKop(
    doc,
    profile,
    kemenagPng,
    schoolLogoPng,
    'BERITA ACARA PELAKSANAAN UJIAN',
    `${(profile.examTitle || 'UJIAN CBT').toUpperCase()} — TAHUN AJARAN ${profile.academicYear}`
  );

  cursorY += 2;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(15, 23, 42);

  const openingText =
    `Pada hari ini ${dateParts.hari}, tanggal ${dateParts.tanggal} bulan ${dateParts.bulan} tahun ${dateParts.tahun}, ` +
    `bertempat di ${profile.schoolName}, telah diselenggarakan kegiatan ${profile.examTitle} ` +
    `Tahun Ajaran ${profile.academicYear} dengan rincian pelaksanaan sebagai berikut:`;

  const openingLines = doc.splitTextToSize(openingText, contentWidth) as string[];
  doc.text(openingLines, marginX, cursorY);
  cursorY += openingLines.length * 4.6 + 3.5;

  const subjectDisplay =
    meta.subject && meta.subject !== 'ALL'
      ? meta.subject
      : '......................................................................';
  const classDisplay =
    meta.className === 'ALL' ? 'Semua Kelas' : `Kelas ${meta.className}`;
  const roomSessionDisplay =
    [meta.roomName.trim(), meta.sessionLabel.trim()].filter(Boolean).join(' / ') ||
    '......................................................................';
  const timeDisplay = meta.timeRange.trim() || '............ s.d. ............ WIB';
  const expectedDisplay =
    expectedParticipantsCount > 0
      ? `${expectedParticipantsCount} orang`
      : '............ orang';

  const infoRows: Array<[string, string]> = [
    ['1. Mata Pelajaran', subjectDisplay],
    ['2. Kelas / Tingkat', classDisplay],
    ['3. Ruang Ujian / Sesi', roomSessionDisplay],
    ['4. Waktu Pelaksanaan', timeDisplay],
    ['5. Jumlah Peserta Seharusnya', expectedDisplay],
    ['6. Jumlah Peserta Hadir', '............ orang'],
    ['7. Jumlah Peserta Tidak Hadir', '............ orang'],
    [
      '8. Nomor Peserta Tidak Hadir',
      '..................................................................................',
    ],
    [
      '',
      '..................................................................................',
    ],
  ];

  const labelW = 56;
  for (const [label, val] of infoRows) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.text(label, marginX + 2, cursorY);
    doc.text(label ? ':' : ' ', marginX + labelW, cursorY);
    doc.setFont('helvetica', label.startsWith('1.') || label.startsWith('5.') ? 'bold' : 'normal');
    const wrappedVal = doc.splitTextToSize(val, contentWidth - labelW - 4) as string[];
    doc.text(wrappedVal, marginX + labelW + 3, cursorY);
    cursorY += Math.max(1, wrappedVal.length) * 4.6 + 1.0;
  }

  cursorY += 3;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.text('Catatan Kejadian Penting Selama Pelaksanaan Ujian:', marginX, cursorY);
  cursorY += 2.5;

  const trimmedNotes = meta.notes.trim();
  const noteLines = trimmedNotes
    ? (doc.splitTextToSize(trimmedNotes, contentWidth - 8) as string[])
    : [];
  const totalLinesInBox = Math.max(4, Math.min(6, noteLines.length + 1));
  const boxHeight = totalLinesInBox * 5.6 + 4.5;

  doc.setDrawColor(100, 116, 139);
  doc.setLineWidth(0.3);
  doc.roundedRect(marginX, cursorY, contentWidth, boxHeight, 1.5, 1.5, 'S');

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  let lineY = cursorY + 5.8;
  for (let i = 0; i < totalLinesInBox; i++) {
    if (i < noteLines.length) {
      doc.setTextColor(15, 23, 42);
      doc.text(noteLines[i], marginX + 4, lineY);
    } else {
      doc.setDrawColor(203, 213, 225);
      doc.setLineDashPattern([1, 1.2], 0);
      doc.line(marginX + 4, lineY, marginX + contentWidth - 4, lineY);
      doc.setLineDashPattern([], 0);
    }
    lineY += 5.6;
  }

  cursorY += boxHeight + 5;

  const closingText =
    'Demikian Berita Acara pelaksanaan ujian ini dibuat dengan sebenar-benarnya untuk dapat dipergunakan sebagaimana mestinya.';
  const closingLines = doc.splitTextToSize(closingText, contentWidth) as string[];

  if (cursorY + closingLines.length * 4.5 + 56 > pageHeight - 8) {
    doc.addPage();
    cursorY = 18;
  }

  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.text(closingLines, marginX, cursorY);
  cursorY += closingLines.length * 4.6 + 6;

  const sup1Name = meta.supervisor1.trim() || '............................................';
  const sup2Name = meta.supervisor2.trim() || '............................................';
  const chairName = (profile.committeeChairName || '').trim() || '............................................';

  const leftColX = marginX + 4;
  const rightColX = pageWidth / 2 + 10;

  doc.setFontSize(9);
  doc.text('Pengawas Ruang 1,', leftColX, cursorY);
  doc.text('Pengawas Ruang 2 / Proktor,', rightColX, cursorY);

  doc.setFont('helvetica', 'bold');
  doc.text(fitTextSingleLine(doc, sup1Name, 68), leftColX, cursorY + 17);
  doc.text(fitTextSingleLine(doc, sup2Name, 68), rightColX, cursorY + 17);

  cursorY += 26;
  doc.setFont('helvetica', 'normal');
  doc.text('Mengetahui,', pageWidth / 2, cursorY, { align: 'center' });
  cursorY += 4.5;
  doc.text('Ketua Panitia Ujian,', pageWidth / 2, cursorY, { align: 'center' });

  doc.setFont('helvetica', 'bold');
  doc.text(fitTextSingleLine(doc, chairName, 90), pageWidth / 2, cursorY + 17, {
    align: 'center',
  });

  const safeSchool = sanitizeFilenamePart(profile.schoolName, 'Sekolah');
  const safeSubj =
    meta.subject && meta.subject !== 'ALL'
      ? sanitizeFilenamePart(meta.subject, 'Ujian')
      : 'Semua_Mapel';
  doc.save(`Berita_Acara_Ujian_${safeSchool}_${safeSubj}.pdf`);
}

export async function exportBeritaAcaraWord(
  expectedParticipantsCount: number,
  profile: SchoolProfile,
  meta: ExamDocumentMeta
): Promise<void> {
  const [kemenagBytes, schoolLogoBytes] = await Promise.all([
    dataUrlToPngUint8Array(profile.kemenagLogoDataUrl || KEMENAG_LOGO_DATA_URL),
    profile.logoDataUrl ? dataUrlToPngUint8Array(profile.logoDataUrl) : Promise.resolve(null),
  ]);
  const dateParts = formatIndonesianDateParts(meta.examDate);

  const subjectDisplay =
    meta.subject && meta.subject !== 'ALL'
      ? meta.subject
      : '......................................................................';
  const classDisplay =
    meta.className === 'ALL' ? 'Semua Kelas' : `Kelas ${meta.className}`;
  const roomSessionDisplay =
    [meta.roomName.trim(), meta.sessionLabel.trim()].filter(Boolean).join(' / ') ||
    '......................................................................';
  const timeDisplay = meta.timeRange.trim() || '............ s.d. ............ WIB';
  const expectedDisplay =
    expectedParticipantsCount > 0
      ? `${expectedParticipantsCount} orang`
      : '............ orang';

  const sup1Name = meta.supervisor1.trim() || '............................................';
  const sup2Name = meta.supervisor2.trim() || '............................................';
  const chairName = (profile.committeeChairName || '').trim() || '............................................';

  const infoRows: Array<[string, string, boolean]> = [
    ['1. Mata Pelajaran', subjectDisplay, true],
    ['2. Kelas / Tingkat', classDisplay, false],
    ['3. Ruang Ujian / Sesi', roomSessionDisplay, false],
    ['4. Waktu Pelaksanaan', timeDisplay, false],
    ['5. Jumlah Peserta Seharusnya', expectedDisplay, true],
    ['6. Jumlah Peserta Hadir', '............ orang', false],
    ['7. Jumlah Peserta Tidak Hadir', '............ orang', false],
    [
      '8. Nomor Peserta Tidak Hadir',
      '...........................................................................',
      false,
    ],
    [
      '',
      '...........................................................................',
      false,
    ],
  ];

  const detailTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: buildDocxNoBorders(),
    rows: infoRows.map(
      ([label, val, isBold]) =>
        new TableRow({
          cantSplit: true,
          children: [
            new TableCell({
              width: { size: 35, type: WidthType.PERCENTAGE },
              margins: { top: 30, bottom: 30, left: 50, right: 50 },
              children: [
                new Paragraph({
                  spacing: { after: 0 },
                  children: [new TextRun({ text: label, size: 19, font: 'Calibri' })],
                }),
              ],
            }),
            new TableCell({
              width: { size: 4, type: WidthType.PERCENTAGE },
              margins: { top: 30, bottom: 30, left: 20, right: 20 },
              children: [
                new Paragraph({
                  spacing: { after: 0 },
                  children: [new TextRun({ text: label ? ':' : '', size: 19, font: 'Calibri' })],
                }),
              ],
            }),
            new TableCell({
              width: { size: 61, type: WidthType.PERCENTAGE },
              margins: { top: 30, bottom: 30, left: 30, right: 50 },
              children: [
                new Paragraph({
                  spacing: { after: 0 },
                  children: [new TextRun({ text: val, bold: isBold, size: 19, font: 'Calibri' })],
                }),
              ],
            }),
          ],
        })
    ),
  });

  const noteLinesRaw = meta.notes.trim()
    ? meta.notes
        .trim()
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
    : [];
  const totalNoteLines = Math.max(4, noteLinesRaw.length + 1);
  const noteParagraphs: Paragraph[] = [];
  for (let i = 0; i < totalNoteLines; i++) {
    noteParagraphs.push(
      new Paragraph({
        spacing: { before: 25, after: 50 },
        children: [
          new TextRun({
            text:
              i < noteLinesRaw.length
                ? noteLinesRaw[i]
                : '....................................................................................................................',
            size: 18,
            color: i < noteLinesRaw.length ? '0F172A' : '94A3B8',
            font: 'Calibri',
          }),
        ],
      })
    );
  }

  const notesBox = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: buildDocxGridBorders(),
    rows: [
      new TableRow({
        cantSplit: true,
        children: [
          new TableCell({
            width: { size: 100, type: WidthType.PERCENTAGE },
            margins: { top: 70, bottom: 70, left: 120, right: 120 },
            children: noteParagraphs,
          }),
        ],
      }),
    ],
  });

  const signTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: buildDocxNoBorders(),
    rows: [
      new TableRow({
        cantSplit: true,
        children: [
          new TableCell({
            width: { size: 50, type: WidthType.PERCENTAGE },
            margins: { top: 40, bottom: 40, left: 50, right: 50 },
            children: [
              new Paragraph({
                spacing: { after: 520 },
                children: [new TextRun({ text: 'Pengawas Ruang 1,', size: 19, font: 'Calibri' })],
              }),
              new Paragraph({
                spacing: { after: 100 },
                children: [new TextRun({ text: sup1Name, bold: true, size: 19, font: 'Calibri' })],
              }),
            ],
          }),
          new TableCell({
            width: { size: 50, type: WidthType.PERCENTAGE },
            margins: { top: 40, bottom: 40, left: 50, right: 50 },
            children: [
              new Paragraph({
                spacing: { after: 520 },
                children: [
                  new TextRun({ text: 'Pengawas Ruang 2 / Proktor,', size: 19, font: 'Calibri' }),
                ],
              }),
              new Paragraph({
                spacing: { after: 100 },
                children: [new TextRun({ text: sup2Name, bold: true, size: 19, font: 'Calibri' })],
              }),
            ],
          }),
        ],
      }),
    ],
  });

  const chairSignTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: buildDocxNoBorders(),
    rows: [
      new TableRow({
        cantSplit: true,
        children: [
          new TableCell({
            width: { size: 100, type: WidthType.PERCENTAGE },
            margins: { top: 140, bottom: 40, left: 50, right: 50 },
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { after: 20 },
                children: [new TextRun({ text: 'Mengetahui,', size: 18, font: 'Calibri' })],
              }),
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { after: 520 },
                children: [
                  new TextRun({ text: 'Ketua Panitia Ujian,', size: 19, font: 'Calibri' }),
                ],
              }),
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { after: 0 },
                children: [new TextRun({ text: chairName, bold: true, size: 19, font: 'Calibri' })],
              }),
            ],
          }),
        ],
      }),
    ],
  });

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: { top: 520, right: 720, bottom: 520, left: 720 },
          },
        },
        children: [
          ...buildDocxKopElements(
            profile,
            kemenagBytes,
            schoolLogoBytes,
            'BERITA ACARA PELAKSANAAN UJIAN',
            `${(profile.examTitle || 'UJIAN CBT').toUpperCase()} — TAHUN AJARAN ${profile.academicYear}`
          ),
          new Paragraph({
            spacing: { before: 40, after: 100 },
            children: [
              new TextRun({
                text:
                  `Pada hari ini ${dateParts.hari}, tanggal ${dateParts.tanggal} bulan ${dateParts.bulan} tahun ${dateParts.tahun}, ` +
                  `bertempat di ${profile.schoolName}, telah diselenggarakan kegiatan ${profile.examTitle} ` +
                  `Tahun Ajaran ${profile.academicYear} dengan rincian pelaksanaan sebagai berikut:`,
                size: 19,
                font: 'Calibri',
              }),
            ],
          }),
          detailTable,
          new Paragraph({
            spacing: { before: 120, after: 60 },
            children: [
              new TextRun({
                text: 'Catatan Kejadian Penting Selama Pelaksanaan Ujian:',
                bold: true,
                size: 19,
                font: 'Calibri',
              }),
            ],
          }),
          notesBox,
          new Paragraph({
            spacing: { before: 120, after: 120 },
            children: [
              new TextRun({
                text: 'Demikian Berita Acara pelaksanaan ujian ini dibuat dengan sebenar-benarnya untuk dapat dipergunakan sebagaimana mestinya.',
                size: 19,
                font: 'Calibri',
              }),
            ],
          }),
          signTable,
          chairSignTable,
        ],
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const safeSchool = sanitizeFilenamePart(profile.schoolName, 'Sekolah');
  const safeSubj =
    meta.subject && meta.subject !== 'ALL'
      ? sanitizeFilenamePart(meta.subject, 'Ujian')
      : 'Semua_Mapel';
  triggerBlobDownload(blob, `Berita_Acara_Ujian_${safeSchool}_${safeSubj}.docx`);
}
