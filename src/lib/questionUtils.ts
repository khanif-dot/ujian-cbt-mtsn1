import type {
  MatchingItem,
  MatchingPair,
  MatchingPayload,
  OptionKey,
  Question,
  QuestionOption,
  QuestionType,
  StudentQuestion,
} from '@/src/types/cbt';

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  multiple_choice: 'Pilihan Ganda',
  true_false: 'Benar / Salah',
  matching: 'Menjodohkan',
};

function hashString32(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function createSeededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleItemsWithSeed<T extends { id: string }>(
  items: T[],
  seedString: string
): T[] {
  if (items.length < 2) return [...items];
  const seed = hashString32(seedString);
  const rand = createSeededRandom(seed);
  rand();
  rand();

  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  const sameOrder = copy.every((item, idx) => item.id === items[idx].id);
  if (sameOrder) {
    const shift = (seed % (copy.length - 1)) + 1;
    return [...copy.slice(shift), ...copy.slice(0, shift)];
  }
  return copy;
}

export function shuffleMatchingItemsRandomly(items: MatchingItem[]): MatchingItem[] {
  if (items.length < 2) return [...items];
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  const sameOrder = copy.every((item, idx) => item.id === items[idx].id);
  if (sameOrder) {
    return [...copy.slice(1), copy[0]];
  }
  return copy;
}

export function getEffectiveQuestionType(q: {
  questionType?: QuestionType;
  options?: unknown;
  matchingData?: MatchingPayload;
  matchingPairs?: MatchingPair[];
}): QuestionType {
  if (
    q.questionType === 'multiple_choice' ||
    q.questionType === 'true_false' ||
    q.questionType === 'matching'
  ) {
    return q.questionType;
  }
  if (q.matchingData || (Array.isArray(q.matchingPairs) && q.matchingPairs.length > 0)) {
    return 'matching';
  }
  if (
    q.options &&
    !Array.isArray(q.options) &&
    typeof q.options === 'object' &&
    (q.options as { type?: string }).type === 'matching'
  ) {
    return 'matching';
  }
  if (Array.isArray(q.options) && q.options.length === 2) {
    const t0 = String((q.options[0] as QuestionOption)?.text || '').trim().toLowerCase();
    const t1 = String((q.options[1] as QuestionOption)?.text || '').trim().toLowerCase();
    if (t0 === 'benar' && t1 === 'salah') {
      return 'true_false';
    }
  }
  return 'multiple_choice';
}

export function extractMatchingPayload(raw: {
  questionType?: QuestionType;
  options?: unknown;
  matchingData?: MatchingPayload;
}): MatchingPayload | null {
  if (raw.matchingData && Array.isArray(raw.matchingData.leftItems)) {
    return raw.matchingData;
  }
  if (
    raw.options &&
    !Array.isArray(raw.options) &&
    typeof raw.options === 'object' &&
    (raw.options as { type?: string }).type === 'matching'
  ) {
    const obj = raw.options as { leftItems?: MatchingItem[]; rightItems?: MatchingItem[] };
    if (Array.isArray(obj.leftItems) && Array.isArray(obj.rightItems)) {
      return {
        leftItems: obj.leftItems,
        rightItems: obj.rightItems,
      };
    }
  }
  return null;
}

export function normalizeStoredOptions(rawOptions: unknown): QuestionOption[] {
  if (Array.isArray(rawOptions)) {
    return rawOptions as QuestionOption[];
  }
  return [];
}

export function parseMatchingMap(raw: unknown): Record<string, string> {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) {
        out[k] = v;
      }
    }
    return out;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{')) return {};
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'string' && v.trim()) {
            out[k] = v;
          }
        }
        return out;
      }
    } catch {
      return {};
    }
  }
  return {};
}

export function buildMatchingQuestionData(pairs: MatchingPair[]): {
  matchingPairs: MatchingPair[];
  matchingData: MatchingPayload;
  correctAnswer: string;
} {
  const cleanPairs: MatchingPair[] = pairs.map((p, idx) => ({
    id: p.id || `pair-${idx + 1}`,
    leftText: p.leftText.trim(),
    leftImageUrl: p.leftImageUrl?.trim() || undefined,
    rightText: p.rightText.trim(),
    rightImageUrl: p.rightImageUrl?.trim() || undefined,
  }));

  const leftItems: MatchingItem[] = [];
  const rightItemsUnshuffled: MatchingItem[] = [];
  const answerMap: Record<string, string> = {};

  cleanPairs.forEach((pair, idx) => {
    const leftId = pair.id || `L${idx + 1}`;
    const randSuffix = Math.random().toString(36).slice(2, 8);
    const rightId = `r_${idx + 1}_${randSuffix}`;

    leftItems.push({
      id: leftId,
      text: pair.leftText,
      imageUrl: pair.leftImageUrl,
    });
    rightItemsUnshuffled.push({
      id: rightId,
      text: pair.rightText,
      imageUrl: pair.rightImageUrl,
    });
    answerMap[leftId] = rightId;
  });

  const rightItems = shuffleMatchingItemsRandomly(rightItemsUnshuffled);

  return {
    matchingPairs: cleanPairs,
    matchingData: {
      leftItems,
      rightItems,
    },
    correctAnswer: JSON.stringify(answerMap),
  };
}

export function reconstructMatchingPairs(q: {
  matchingPairs?: MatchingPair[];
  matchingData?: MatchingPayload;
  options?: unknown;
  correctAnswer?: string;
}): MatchingPair[] {
  if (Array.isArray(q.matchingPairs) && q.matchingPairs.length > 0) {
    return q.matchingPairs;
  }
  const payload = extractMatchingPayload(q);
  if (!payload) return [];
  const correctMap = parseMatchingMap(q.correctAnswer);
  const rightById = new Map(payload.rightItems.map((r) => [r.id, r]));

  return payload.leftItems.map((left, idx) => {
    const matchedRightId = correctMap[left.id];
    const right = matchedRightId ? rightById.get(matchedRightId) : undefined;
    return {
      id: left.id || `pair-${idx + 1}`,
      leftText: left.text || '',
      leftImageUrl: left.imageUrl,
      rightText: right?.text || '',
      rightImageUrl: right?.imageUrl,
    };
  });
}

export function serializeOptionsForDatabase(q: Question): unknown {
  const qType = getEffectiveQuestionType(q);
  if (qType === 'matching') {
    const payload =
      q.matchingData ||
      (q.matchingPairs && q.matchingPairs.length > 0
        ? buildMatchingQuestionData(q.matchingPairs).matchingData
        : { leftItems: [], rightItems: [] });
    return {
      type: 'matching',
      leftItems: payload.leftItems,
      rightItems: payload.rightItems,
    };
  }
  return q.options;
}

export function hydrateQuestionFromDbRow(row: {
  id: string;
  subject: string;
  target_classes?: string[];
  question_type?: string;
  question_text: string;
  question_image_url?: string;
  options: unknown;
  matching_pairs?: MatchingPair[] | null;
  correct_answer: string;
  points?: number;
  order_index?: number;
}): Question {
  const matchingData = extractMatchingPayload({
    questionType: row.question_type as QuestionType | undefined,
    options: row.options,
  });
  const qType = getEffectiveQuestionType({
    questionType: row.question_type as QuestionType | undefined,
    options: row.options,
    matchingData: matchingData || undefined,
    matchingPairs: Array.isArray(row.matching_pairs) ? row.matching_pairs : undefined,
  });

  const hydrated: Question = {
    id: row.id,
    subject: row.subject,
    targetClasses: row.target_classes || [],
    questionType: qType,
    questionText: row.question_text,
    questionImageUrl: row.question_image_url || undefined,
    options: normalizeStoredOptions(row.options),
    matchingPairs: Array.isArray(row.matching_pairs) ? row.matching_pairs : undefined,
    matchingData: matchingData || undefined,
    correctAnswer: row.correct_answer,
    points: Number(row.points ?? 1),
    orderIndex: Number(row.order_index ?? 1),
  };

  if (qType === 'matching' && (!hydrated.matchingPairs || hydrated.matchingPairs.length === 0)) {
    hydrated.matchingPairs = reconstructMatchingPairs(hydrated);
  }

  return hydrated;
}

export function hydrateStudentQuestionFromDbRow(row: {
  id: string;
  subject: string;
  target_classes?: string[];
  question_type?: string;
  question_text: string;
  question_image_url?: string;
  options: unknown;
  points?: number;
  order_index?: number;
}): StudentQuestion {
  const matchingData = extractMatchingPayload({
    questionType: row.question_type as QuestionType | undefined,
    options: row.options,
  });
  const qType = getEffectiveQuestionType({
    questionType: row.question_type as QuestionType | undefined,
    options: row.options,
    matchingData: matchingData || undefined,
  });

  return {
    id: row.id,
    subject: row.subject,
    targetClasses: row.target_classes || [],
    questionType: qType,
    questionText: row.question_text,
    questionImageUrl: row.question_image_url || undefined,
    options: normalizeStoredOptions(row.options),
    matchingData: matchingData || undefined,
    points: Number(row.points ?? 1),
    orderIndex: Number(row.order_index ?? 1),
  };
}

export function sanitizeQuestionForStudent(q: Question): StudentQuestion {
  const qType = getEffectiveQuestionType(q);
  let matchingData = extractMatchingPayload(q) || undefined;
  if (qType === 'matching' && !matchingData && q.matchingPairs && q.matchingPairs.length > 0) {
    matchingData = buildMatchingQuestionData(q.matchingPairs).matchingData;
  }
  return {
    id: q.id,
    subject: q.subject,
    targetClasses: q.targetClasses,
    questionType: qType,
    questionText: q.questionText,
    questionImageUrl: q.questionImageUrl,
    options: Array.isArray(q.options) ? q.options : [],
    matchingData,
    points: q.points,
    orderIndex: q.orderIndex,
  };
}

export function prepareMatchingForStudentSession(
  questions: StudentQuestion[],
  seedPrefix: string
): StudentQuestion[] {
  return questions.map((q) => {
    const qType = getEffectiveQuestionType(q);
    if (qType !== 'matching' || !q.matchingData) {
      return { ...q, questionType: qType };
    }
    return {
      ...q,
      questionType: 'matching',
      matchingData: {
        leftItems: q.matchingData.leftItems,
        rightItems: shuffleItemsWithSeed(
          q.matchingData.rightItems,
          `${seedPrefix}::${q.id}::matching`
        ),
      },
    };
  });
}

export function scoreSingleQuestion(
  q: Question,
  rawAnswer: string | undefined
): { isFullCorrect: boolean; earnedPoints: number; maxPoints: number } {
  const maxPoints = q.points || 1;
  const qType = getEffectiveQuestionType(q);

  if (qType === 'matching') {
    const correctMap = parseMatchingMap(q.correctAnswer);
    const entries = Object.entries(correctMap);
    const totalPairs = entries.length;
    if (totalPairs === 0 || !rawAnswer) {
      return { isFullCorrect: false, earnedPoints: 0, maxPoints };
    }
    const studentMap = parseMatchingMap(rawAnswer);
    let matchedCount = 0;
    for (const [leftId, rightId] of entries) {
      if (studentMap[leftId] && studentMap[leftId] === rightId) {
        matchedCount += 1;
      }
    }
    const earnedPoints = (maxPoints * matchedCount) / totalPairs;
    return {
      isFullCorrect: matchedCount === totalPairs,
      earnedPoints,
      maxPoints,
    };
  }

  const isCorrect = Boolean(rawAnswer && rawAnswer === q.correctAnswer);
  return {
    isFullCorrect: isCorrect,
    earnedPoints: isCorrect ? maxPoints : 0,
    maxPoints,
  };
}

export function isQuestionAnswered(
  q: Pick<StudentQuestion | Question, 'id' | 'questionType' | 'options' | 'matchingData'>,
  rawAnswer: string | undefined
): boolean {
  if (!rawAnswer) return false;
  const qType = getEffectiveQuestionType(q);
  if (qType === 'matching') {
    const map = parseMatchingMap(rawAnswer);
    return Object.keys(map).length > 0;
  }
  return Boolean(rawAnswer.trim());
}

export const TRUE_FALSE_DEFAULT_OPTIONS: QuestionOption[] = [
  { key: 'A' as OptionKey, text: 'Benar' },
  { key: 'B' as OptionKey, text: 'Salah' },
];
