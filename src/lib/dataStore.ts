import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ALL_ADMIN_TABS,
  SEED_SCHOOL_PROFILE,
  SEED_STAFF_ACCOUNTS,
} from '@/src/lib/seedData';
import {
  getSupabaseAdminClient,
  getSupabaseClient,
  getSupabaseConfig,
  hasSupabaseServiceRoleKey,
  isLiveSupabaseConfigured,
  validateServiceRoleKey,
} from '@/src/lib/supabase';
import {
  getEffectiveQuestionType,
  hydrateQuestionFromDbRow,
  hydrateStudentQuestionFromDbRow,
  sanitizeQuestionForStudent,
  scoreSingleQuestion,
  serializeOptionsForDatabase,
} from '@/src/lib/questionUtils';
import {
  ALL_CLASSES,
  type ActiveExamSession,
  type ExamResult,
  type ExamSchedule,
  type Participant,
  type Question,
  type SchoolProfile,
  type StaffAccount,
  type StudentQuestion,
} from '@/src/types/cbt';

const DB_NAME = 'nusantara_cbt_localfirst_v2';
const DB_VERSION = 3;

const STORES = {
  META: 'meta',
  PARTICIPANTS: 'participants',
  QUESTIONS: 'questions',
  SCHEDULES: 'schedules',
  RESULTS: 'exam_results',
  STAFF_ACCOUNTS: 'staff_accounts',
  ACTIVE_SESSION: 'active_session',
} as const;

const ACTIVE_SESSION_KEY = 'cbt_active_exam_session_v2';
const CHANNEL_NAME = 'nusantara_cbt_sync';

type SyncListener = (topic?: string) => void;

const listeners = new Set<SyncListener>();
let channel: BroadcastChannel | null = null;
let resultsKeyMapCache: Map<string, { id: string; syncStatus?: string; fingerprint: string }> | null =
  null;
let resultsSortedCache: ExamResult[] | null = null;
let schedulesSortedCache: ExamSchedule[] | null = null;
let participantsSortedCache: Participant[] | null = null;
let questionsSortedCache: Question[] | null = null;

// Kredensial staf aktif disimpan hanya di memori JS (tidak pernah di localStorage) untuk otorisasi RPC admin
let activeStaffCredentials: { userId: string; passwordHash: string } | null = null;
const confirmedQuestionIdsSyncSet = new Set<string>();

export function setActiveStaffCredentials(
  staff: { userId: string; password?: string } | null
): void {
  if (!staff || !staff.userId) {
    activeStaffCredentials = null;
    return;
  }
  const pwdHash = (staff.password || '').trim();
  if (!pwdHash || pwdHash === '__CLOUD_MANAGED__') {
    activeStaffCredentials = null;
    return;
  }
  activeStaffCredentials = {
    userId: staff.userId.trim(),
    passwordHash: pwdHash,
  };
}

function getStaffRpcAuthArgs(): {
  p_staff_user_id: string | null;
  p_staff_password_sha256: string | null;
} {
  return {
    p_staff_user_id: activeStaffCredentials?.userId || null,
    p_staff_password_sha256: activeStaffCredentials?.passwordHash || null,
  };
}

function isRpcSignatureMismatchError(msg: string): boolean {
  const lower = (msg || '').toLowerCase();
  return (
    lower.includes('could not find the function') ||
    (lower.includes('function') && lower.includes('does not exist')) ||
    lower.includes('pgrst202')
  );
}

function invalidateStoreCache(storeName?: string): void {
  if (!storeName || storeName === STORES.RESULTS) {
    resultsKeyMapCache = null;
    resultsSortedCache = null;
  }
  if (!storeName || storeName === STORES.SCHEDULES) {
    schedulesSortedCache = null;
  }
  if (!storeName || storeName === STORES.PARTICIPANTS) {
    participantsSortedCache = null;
  }
  if (!storeName || storeName === STORES.QUESTIONS) {
    questionsSortedCache = null;
  }
}

function buildResultFingerprint(r: ExamResult): string {
  const answersKeys = Object.keys(r.answers || {}).sort();
  let answersSig = '';
  for (let i = 0; i < answersKeys.length; i++) {
    const k = answersKeys[i];
    const v = r.answers[k];
    answersSig += `${k}:${typeof v === 'string' ? v : JSON.stringify(v)};`;
  }
  const flagsSig = (r.flaggedQuestions || []).join(',');
  const qIdsSig = (r.questionIds || []).join(',');
  return `${r.id}|${r.status}|${r.submittedAt || ''}|${r.score}|${r.correctCount}|${r.totalQuestions}|${r.tabSwitchCount}|${r.syncStatus || ''}|${r.examId}|${r.subject}|${flagsSig}|${qIdsSig}|${answersSig}`;
}

function findScheduleForExam(
  schedules: ExamSchedule[],
  examId?: string,
  subject?: string
): ExamSchedule | undefined {
  if (examId) {
    const byId = schedules.find((s) => s.id === examId);
    if (byId) return byId;
  }
  const normSubj = (subject || '').trim().toLowerCase();
  if (normSubj) {
    return schedules.find((s) => (s.subject || '').trim().toLowerCase() === normSubj);
  }
  return undefined;
}

function getChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return null;
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (ev: MessageEvent<{ topic?: string }>) => {
      const topic = ev.data?.topic;
      if (!topic || topic === 'reset' || topic === 'backup_restored' || topic === 'supabase_pull' || topic === 'supabase_pull_detailed') {
        invalidateStoreCache();
      } else if (topic === 'results' || topic === 'sync_flushed') {
        invalidateStoreCache(STORES.RESULTS);
      } else if (topic === 'schedules' || topic === 'schedules_admin_sync') {
        invalidateStoreCache(STORES.SCHEDULES);
      } else if (topic === 'participants') {
        invalidateStoreCache(STORES.PARTICIPANTS);
      } else if (topic === 'questions' || topic === 'questions_admin_sync') {
        invalidateStoreCache(STORES.QUESTIONS);
      } else if (topic.startsWith('supabase_pull_changed:')) {
        const parts = topic.slice('supabase_pull_changed:'.length).split(',');
        parts.forEach((p) => {
          if (p === 'results') invalidateStoreCache(STORES.RESULTS);
          else if (p === 'schedules') invalidateStoreCache(STORES.SCHEDULES);
          else if (p === 'participants') invalidateStoreCache(STORES.PARTICIPANTS);
          else if (p === 'questions') invalidateStoreCache(STORES.QUESTIONS);
        });
      } else if (topic.startsWith('supabase_pull')) {
        invalidateStoreCache(STORES.RESULTS);
        invalidateStoreCache(STORES.SCHEDULES);
      }
      notifyLocalListeners(topic);
    };
  }
  return channel;
}

function notifyLocalListeners(topic?: string): void {
  listeners.forEach((cb) => cb(topic));
}

export function broadcastDataChange(topic = 'update'): void {
  notifyLocalListeners(topic);
  try {
    getChannel()?.postMessage({ topic, ts: Date.now() });
  } catch {
    // Ignore broadcast errors in restricted contexts
  }
}

export function subscribeDataChanges(cb: SyncListener): () => void {
  listeners.add(cb);
  getChannel();
  return () => {
    listeners.delete(cb);
  };
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.META)) {
        db.createObjectStore(STORES.META, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.PARTICIPANTS)) {
        const s = db.createObjectStore(STORES.PARTICIPANTS, { keyPath: 'id' });
        s.createIndex('participantNumber', 'participantNumber', { unique: true });
      }
      if (!db.objectStoreNames.contains(STORES.QUESTIONS)) {
        db.createObjectStore(STORES.QUESTIONS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.SCHEDULES)) {
        db.createObjectStore(STORES.SCHEDULES, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.RESULTS)) {
        db.createObjectStore(STORES.RESULTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.STAFF_ACCOUNTS)) {
        const s = db.createObjectStore(STORES.STAFF_ACCOUNTS, { keyPath: 'id' });
        s.createIndex('userId', 'userId', { unique: true });
      }
      if (!db.objectStoreNames.contains(STORES.ACTIVE_SESSION)) {
        db.createObjectStore(STORES.ACTIVE_SESSION, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbGetAll<T>(storeName: string): Promise<T[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result as T[]) || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(storeName: string, key: string): Promise<T | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut<T>(storeName: string, item: T): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(item);
    tx.oncomplete = () => {
      invalidateStoreCache(storeName);
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

// ============================================================================
// SHA-256 PASSWORD HASHING (WEB CRYPTO + DETERMINISTIC LAN FALLBACK)
// ============================================================================
const HASH_PREFIX = 'sha256$';

function sha256FallbackHex(ascii: string): string {
  const rightRotate = (value: number, amount: number) => (value >>> amount) | (value << (32 - amount));
  const mathPow = Math.pow;
  const maxWord = mathPow(2, 32);
  let result = '';
  const words: number[] = [];
  const encoded = unescape(encodeURIComponent(ascii));
  const asciiBitLength = encoded.length * 8;

  const hash: number[] = [];
  const k: number[] = [];
  let primeCounter = 0;
  const isComposite: Record<number, boolean> = {};
  for (let candidate = 2; primeCounter < 64; candidate++) {
    if (!isComposite[candidate]) {
      for (let i = 0; i < 313; i += candidate) {
        isComposite[i] = true;
      }
      hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
      k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
    }
  }

  let msg = encoded + '\x80';
  while ((msg.length % 64) - 56) msg += '\x00';
  for (let i = 0; i < msg.length; i++) {
    const j = msg.charCodeAt(i);
    words[i >> 2] |= j << (((3 - i) % 4) * 8);
  }
  words[words.length] = (asciiBitLength / maxWord) | 0;
  words[words.length] = asciiBitLength;

  for (let j = 0; j < words.length; ) {
    const w = words.slice(j, (j += 16));
    const oldHash = hash.slice(0);
    for (let i = 0; i < 64; i++) {
      const w15 = w[i - 15];
      const w2 = w[i - 2];
      const a = hash[0];
      const e = hash[4];
      const temp1 =
        hash[7] +
        (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) +
        ((e & hash[5]) ^ (~e & hash[6])) +
        k[i] +
        (w[i] =
          i < 16
            ? w[i]
            : (w[i - 16] +
                (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)) +
                w[i - 7] +
                (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))) |
              0);
      const temp2 =
        (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) +
        ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
      hash[7] = hash[6];
      hash[6] = hash[5];
      hash[5] = hash[4];
      hash[4] = (hash[3] + temp1) | 0;
      hash[3] = hash[2];
      hash[2] = hash[1];
      hash[1] = hash[0];
      hash[0] = (temp1 + temp2) | 0;
    }
    for (let i = 0; i < 8; i++) {
      hash[i] = (hash[i] + oldHash[i]) | 0;
    }
  }
  for (let i = 0; i < 8; i++) {
    for (let j = 3; j + 1; j--) {
      const b = (hash[i] >> (j * 8)) & 255;
      result += (b < 16 ? '0' : '') + b.toString(16);
    }
  }
  return result;
}

export function isPasswordHashed(value: string): boolean {
  return value.startsWith(HASH_PREFIX);
}

export async function hashPassword(raw: string): Promise<string> {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (isPasswordHashed(trimmed)) return trimmed;
  try {
    if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle) {
      const data = new TextEncoder().encode(trimmed);
      const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
      const bytes = Array.from(new Uint8Array(digest));
      return HASH_PREFIX + bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // Fallback to deterministic JS SHA-256
  }
  return HASH_PREFIX + sha256FallbackHex(trimmed);
}

export async function verifyPassword(input: string, stored: string): Promise<boolean> {
  const cleanInput = input.trim();
  const cleanStored = (stored || '').trim();
  if (!cleanInput || !cleanStored) return false;
  if (isPasswordHashed(cleanStored)) {
    const hashed = await hashPassword(cleanInput);
    return hashed === cleanStored;
  }
  return cleanInput === cleanStored;
}

// ============================================================================
// SERVER CLOCK OFFSET (ANTI MANIPULASI JAM PERANGKAT)
// ============================================================================
let serverClockOffsetMs = 0;
let lastClockSyncMs = 0;

export function getServerNowMs(): number {
  return Date.now() + serverClockOffsetMs;
}

export function getServerClockOffsetMs(): number {
  return serverClockOffsetMs;
}

export async function syncServerClock(force = false): Promise<number> {
  if (!isLiveSupabaseConfigured()) return serverClockOffsetMs;
  if (!force && Date.now() - lastClockSyncMs < 300_000) {
    return serverClockOffsetMs;
  }
  try {
    const supabase = getSupabaseClient();
    const reqStart = Date.now();
    const { data, error } = await supabase.rpc('get_server_time');
    const reqEnd = Date.now();
    if (!error && typeof data === 'string') {
      const serverMs = new Date(data).getTime();
      if (Number.isFinite(serverMs)) {
        const midpoint = Math.round((reqStart + reqEnd) / 2);
        serverClockOffsetMs = serverMs - midpoint;
        lastClockSyncMs = Date.now();
        return serverClockOffsetMs;
      }
    }
  } catch {
    // Fallback below using HTTP Date header
  }

  try {
    const { url, anonKey } = getSupabaseConfig();
    if (url && anonKey) {
      const reqStart = Date.now();
      const resp = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/`, {
        method: 'HEAD',
        headers: { apikey: anonKey },
      });
      const reqEnd = Date.now();
      const dateHeader = resp.headers.get('date');
      if (dateHeader) {
        const serverMs = new Date(dateHeader).getTime();
        if (Number.isFinite(serverMs)) {
          const midpoint = Math.round((reqStart + reqEnd) / 2);
          serverClockOffsetMs = serverMs - midpoint;
          lastClockSyncMs = Date.now();
        }
      }
    }
  } catch {
    // Keep existing offset if offline
  }
  return serverClockOffsetMs;
}

// ============================================================================
// INDEXEDDB SAFE HELPERS (ANTI CONSTRAINT ERROR)
// ============================================================================
async function idbPutMany<T>(storeName: string, items: T[], clearFirst = false): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    if (clearFirst) {
      store.clear();
    }
    for (const item of items) {
      store.put(item);
    }
    tx.oncomplete = () => {
      invalidateStoreCache(storeName);
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

async function idbPutParticipantsSafe(items: Participant[], clearFirst = false): Promise<void> {
  if (clearFirst) {
    const dedup = new Map<string, Participant>();
    for (const item of items) {
      const key = item.participantNumber.trim().toUpperCase();
      dedup.set(key, { ...item, participantNumber: item.participantNumber.trim() });
    }
    await idbPutMany(STORES.PARTICIPANTS, Array.from(dedup.values()), true);
    return;
  }

  const existing = await idbGetAll<Participant>(STORES.PARTICIPANTS);
  const byNumber = new Map<string, Participant>();
  for (const row of existing) {
    byNumber.set(row.participantNumber.trim().toUpperCase(), row);
  }

  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORES.PARTICIPANTS, 'readwrite');
    const store = tx.objectStore(STORES.PARTICIPANTS);
    for (const rawItem of items) {
      const normNum = rawItem.participantNumber.trim().toUpperCase();
      const conflict = byNumber.get(normNum);
      if (conflict && conflict.id !== rawItem.id) {
        store.delete(conflict.id);
      }
      const cleanItem: Participant = {
        ...rawItem,
        participantNumber: rawItem.participantNumber.trim(),
      };
      byNumber.set(normNum, cleanItem);
      store.put(cleanItem);
    }
    tx.oncomplete = () => {
      invalidateStoreCache(STORES.PARTICIPANTS);
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

async function idbPutStaffSafe(items: StaffAccount[], clearFirst = false): Promise<void> {
  if (clearFirst) {
    const dedup = new Map<string, StaffAccount>();
    for (const item of items) {
      dedup.set(item.userId.trim().toLowerCase(), { ...item, userId: item.userId.trim() });
    }
    await idbPutMany(STORES.STAFF_ACCOUNTS, Array.from(dedup.values()), true);
    return;
  }

  const existing = await idbGetAll<StaffAccount>(STORES.STAFF_ACCOUNTS);
  const byUserId = new Map<string, StaffAccount>();
  for (const row of existing) {
    byUserId.set(row.userId.trim().toLowerCase(), row);
  }

  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORES.STAFF_ACCOUNTS, 'readwrite');
    const store = tx.objectStore(STORES.STAFF_ACCOUNTS);
    for (const rawItem of items) {
      const normUser = rawItem.userId.trim().toLowerCase();
      const conflict = byUserId.get(normUser);
      if (conflict && conflict.id !== rawItem.id) {
        store.delete(conflict.id);
      }
      const cleanItem: StaffAccount = {
        ...rawItem,
        userId: rawItem.userId.trim(),
      };
      byUserId.set(normUser, cleanItem);
      store.put(cleanItem);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(storeName: string, key: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => {
      invalidateStoreCache(storeName);
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

let initialized = false;
let initPromise: Promise<void> | null = null;
let cachedActiveSession: ActiveExamSession | null = null;

export async function ensureInitialized(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const initFlags = await idbGet<{ id: string; seeded: boolean }>(STORES.META, 'init_flags');
    const existingProfile = await idbGet<SchoolProfile>(STORES.META, 'default');

    if (!existingProfile) {
      await idbPut(STORES.META, SEED_SCHOOL_PROFILE);
    } else if (!existingProfile.adminPassword) {
      await idbPut(STORES.META, { ...existingProfile, adminPassword: 'admin123' });
    }

    if (!initFlags) {
      await idbPut(STORES.META, { id: 'init_flags', seeded: true });
    }

    const existingStaff = await idbGetAll<StaffAccount>(STORES.STAFF_ACCOUNTS);
    if (existingStaff.length === 0) {
      const profilePwd = existingProfile?.adminPassword || SEED_SCHOOL_PROFILE.adminPassword;
      const seededHashed = await Promise.all(
        SEED_STAFF_ACCOUNTS.map(async (acc) => ({
          ...acc,
          password: await hashPassword(acc.userId === 'admin' ? profilePwd : acc.password),
        }))
      );
      await idbPutStaffSafe(seededHashed);
    } else {
      const mainAdmin = existingStaff.find((s) => s.userId.toLowerCase() === 'admin');
      if (mainAdmin && !mainAdmin.allowedTabs.includes('roles')) {
        await idbPut(STORES.STAFF_ACCOUNTS, {
          ...mainAdmin,
          allowedTabs: ALL_ADMIN_TABS,
        });
      }
    }

    // Hydrate active exam session from IndexedDB (migrating legacy full session from localStorage if present)
    try {
      const savedIdb = await idbGet<{ id: string; session: ActiveExamSession }>(
        STORES.ACTIVE_SESSION,
        'current'
      );
      if (savedIdb?.session && Array.isArray(savedIdb.session.questions)) {
        cachedActiveSession = savedIdb.session;
      } else {
        const legacyRaw = localStorage.getItem(ACTIVE_SESSION_KEY);
        if (legacyRaw) {
          const parsed = JSON.parse(legacyRaw) as Partial<ActiveExamSession>;
          if (parsed && Array.isArray(parsed.questions) && parsed.participant && parsed.schedule) {
            cachedActiveSession = parsed as ActiveExamSession;
            await idbPut(STORES.ACTIVE_SESSION, { id: 'current', session: cachedActiveSession });
            try {
              localStorage.setItem(
                ACTIVE_SESSION_KEY,
                JSON.stringify({
                  resultId: cachedActiveSession.resultId,
                  participantNumber: cachedActiveSession.participant.participantNumber,
                  examId: cachedActiveSession.schedule.id,
                  startedAt: cachedActiveSession.startedAt,
                  endsAt: cachedActiveSession.endsAt,
                })
              );
            } catch {
              // Ignore quota error
            }
          }
        }
      }
    } catch {
      // Ignore storage errors on bootstrap
    }

    initialized = true;

    if (isLiveSupabaseConfigured()) {
      void syncServerClock();
    }
  })();

  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

export interface CloudSyncWriteResult {
  synced: boolean;
  error?: string;
}

export interface AdminCloudSyncResult {
  ok: boolean;
  syncedFromCloud: boolean;
  hasServiceRoleKey: boolean;
  questionCount: number;
  scheduleCount: number;
  error?: string;
}

function isMissingQuestionColumnsError(msg: string): boolean {
  const lower = (msg || '').toLowerCase();
  const mentionsCol = lower.includes('question_type') || lower.includes('matching_pairs');
  return (
    mentionsCol &&
    (lower.includes('column') || lower.includes('schema cache') || lower.includes('does not exist'))
  );
}

function buildQuestionDbRow(q: Question, includeExtendedColumns = true): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: q.id,
    subject: q.subject,
    target_classes: q.targetClasses,
    question_text: q.questionText,
    question_image_url: q.questionImageUrl || '',
    options: serializeOptionsForDatabase(q),
    correct_answer: q.correctAnswer,
    points: q.points,
    order_index: q.orderIndex,
  };
  if (includeExtendedColumns) {
    base.question_type = getEffectiveQuestionType(q);
    base.matching_pairs = q.matchingPairs || null;
  }
  return base;
}

const PUBLIC_SCHOOL_PROFILE_COLUMNS =
  'id,school_name,address,academic_year,principal_name,committee_chair_name,exam_title,logo_data_url,updated_at';
const ADMIN_SCHOOL_PROFILE_COLUMNS =
  'id,school_name,address,academic_year,principal_name,committee_chair_name,exam_title,logo_data_url,admin_password,updated_at';
const EXAM_RESULTS_ADMIN_COLUMNS =
  'id,participant_id,participant_number,student_name,class_name,exam_id,exam_title,subject,answers,flagged_questions,question_ids,correct_count,total_questions,score,tab_switch_count,status,started_at,submitted_at,updated_at';
const EXAM_RESULTS_ADMIN_COLUMNS_LEGACY =
  'id,participant_id,participant_number,student_name,class_name,exam_id,exam_title,subject,answers,flagged_questions,correct_count,total_questions,score,tab_switch_count,status,started_at,submitted_at,updated_at';
const EXAM_RESULTS_LIVE_STATUS_COLUMNS = 'id,status,submitted_at,tab_switch_count';

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

async function fetchSingleParticipantByNumber(
  client: SupabaseClient,
  rawParticipantNumber: string,
  activeOnly = false
): Promise<{ data: Record<string, unknown> | null; error?: { message: string } | null }> {
  const trimmed = rawParticipantNumber.trim();
  const normUpper = trimmed.toUpperCase();
  if (!normUpper) return { data: null, error: null };

  let exactQuery = client.from('participants').select('*').eq('participant_number', normUpper);
  if (activeOnly) exactQuery = exactQuery.eq('is_active', true);
  const exactRes = await exactQuery.limit(1).maybeSingle();
  if (exactRes.error) return { data: null, error: exactRes.error };
  if (exactRes.data) return { data: exactRes.data as Record<string, unknown>, error: null };

  let fallbackQuery = client
    .from('participants')
    .select('*')
    .ilike('participant_number', escapeLikePattern(normUpper));
  if (activeOnly) fallbackQuery = fallbackQuery.eq('is_active', true);
  const fallbackRes = await fallbackQuery.limit(1).maybeSingle();
  return {
    data: (fallbackRes.data as Record<string, unknown> | null) || null,
    error: fallbackRes.error,
  };
}

async function fetchSingleExamResult(
  client: SupabaseClient,
  rawParticipantNumber: string,
  examId: string,
  columns: string
): Promise<{ data: Record<string, unknown> | null; error?: { message: string } | null }> {
  const normUpper = rawParticipantNumber.trim().toUpperCase();
  if (!normUpper) return { data: null, error: null };

  let activeCols = columns;
  let exactRes = await client
    .from('exam_results')
    .select(activeCols)
    .eq('participant_number', normUpper)
    .eq('exam_id', examId)
    .limit(1)
    .maybeSingle();

  if (
    exactRes.error &&
    activeCols === EXAM_RESULTS_ADMIN_COLUMNS &&
    exactRes.error.message.includes('question_ids')
  ) {
    activeCols = EXAM_RESULTS_ADMIN_COLUMNS_LEGACY;
    exactRes = await client
      .from('exam_results')
      .select(activeCols)
      .eq('participant_number', normUpper)
      .eq('exam_id', examId)
      .limit(1)
      .maybeSingle();
  }

  if (exactRes.error) return { data: null, error: exactRes.error };
  if (exactRes.data) {
    return { data: exactRes.data as unknown as Record<string, unknown>, error: null };
  }

  const fallbackRes = await client
    .from('exam_results')
    .select(activeCols)
    .ilike('participant_number', escapeLikePattern(normUpper))
    .eq('exam_id', examId)
    .limit(1)
    .maybeSingle();
  return {
    data: (fallbackRes.data as unknown as Record<string, unknown> | null) || null,
    error: fallbackRes.error,
  };
}

async function fetchExamResultsForParticipant(
  client: SupabaseClient,
  rawParticipantNumber: string,
  columns: string
): Promise<{ data: Record<string, unknown>[]; error?: { message: string } | null }> {
  const normUpper = rawParticipantNumber.trim().toUpperCase();
  if (!normUpper) return { data: [], error: null };

  let activeCols = columns;
  let exactRes = await client
    .from('exam_results')
    .select(activeCols)
    .eq('participant_number', normUpper);

  if (
    exactRes.error &&
    activeCols === EXAM_RESULTS_ADMIN_COLUMNS &&
    exactRes.error.message.includes('question_ids')
  ) {
    activeCols = EXAM_RESULTS_ADMIN_COLUMNS_LEGACY;
    exactRes = await client
      .from('exam_results')
      .select(activeCols)
      .eq('participant_number', normUpper);
  }

  if (exactRes.error) return { data: [], error: exactRes.error };
  if (Array.isArray(exactRes.data) && exactRes.data.length > 0) {
    return { data: exactRes.data as unknown as Record<string, unknown>[], error: null };
  }

  const fallbackRes = await client
    .from('exam_results')
    .select(activeCols)
    .ilike('participant_number', escapeLikePattern(normUpper));
  return {
    data: Array.isArray(fallbackRes.data)
      ? (fallbackRes.data as unknown as Record<string, unknown>[])
      : [],
    error: fallbackRes.error,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAllRowsByIdPaginated<T = any>(
  client: SupabaseClient,
  table: string,
  columns = '*',
  maxRows = 50_000
): Promise<{ data: T[]; error?: string }> {
  const collected: T[] = [];
  const pageSize = 1000;
  let activeCols = columns;
  for (let from = 0; from < maxRows; from += pageSize) {
    let { data, error } = await client
      .from(table)
      .select(activeCols)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (
      error &&
      table === 'exam_results' &&
      activeCols === EXAM_RESULTS_ADMIN_COLUMNS &&
      error.message.includes('question_ids')
    ) {
      activeCols = EXAM_RESULTS_ADMIN_COLUMNS_LEGACY;
      const retry = await client
        .from(table)
        .select(activeCols)
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1);
      data = retry.data;
      error = retry.error;
    }
    if (error) {
      return { data: collected, error: error.message };
    }
    if (!Array.isArray(data) || data.length === 0) {
      break;
    }
    collected.push(...(data as T[]));
    if (data.length < pageSize) {
      break;
    }
  }
  return { data: collected };
}

async function fetchExamResultsDelta(
  client: SupabaseClient,
  sinceIso: string,
  maxRows = 100_000
): Promise<{ data: Record<string, unknown>[]; maxUpdatedAt: string; error?: string }> {
  const sinceMs = new Date(sinceIso).getTime();
  const safeOverlapIso = new Date(Math.max(0, (Number.isFinite(sinceMs) ? sinceMs : Date.now()) - 1500)).toISOString();
  const collected: Record<string, unknown>[] = [];
  let maxUpdatedMs = Number.isFinite(sinceMs) ? sinceMs : 0;
  const pageSize = 1000;
  let activeCols = EXAM_RESULTS_ADMIN_COLUMNS;

  for (let from = 0; from < maxRows; from += pageSize) {
    let { data, error } = await client
      .from('exam_results')
      .select(activeCols)
      .gte('updated_at', safeOverlapIso)
      .order('updated_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error && activeCols === EXAM_RESULTS_ADMIN_COLUMNS && error.message.includes('question_ids')) {
      activeCols = EXAM_RESULTS_ADMIN_COLUMNS_LEGACY;
      const retry = await client
        .from('exam_results')
        .select(activeCols)
        .gte('updated_at', safeOverlapIso)
        .order('updated_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1);
      data = retry.data;
      error = retry.error;
    }

    if (error) {
      return { data: collected, maxUpdatedAt: sinceIso, error: error.message };
    }
    if (!Array.isArray(data) || data.length === 0) {
      break;
    }
    for (const raw of data as unknown as Record<string, unknown>[]) {
      collected.push(raw);
      const ms = raw.updated_at ? new Date(String(raw.updated_at)).getTime() : NaN;
      if (Number.isFinite(ms) && ms > maxUpdatedMs) {
        maxUpdatedMs = ms;
      }
    }
    if (data.length < pageSize) {
      break;
    }
  }

  return {
    data: collected,
    maxUpdatedAt: maxUpdatedMs > 0 ? new Date(maxUpdatedMs).toISOString() : sinceIso,
  };
}

function getMaxUpdatedAtIso(rows: Array<Record<string, unknown>>): string {
  let maxMs = 0;
  for (const row of rows) {
    const ms = row.updated_at ? new Date(String(row.updated_at)).getTime() : NaN;
    if (Number.isFinite(ms) && ms > maxMs) {
      maxMs = ms;
    }
  }
  return maxMs > 0 ? new Date(maxMs).toISOString() : new Date(getServerNowMs()).toISOString();
}

interface QuestionsCloudMeta {
  totalCount: number;
  maxUpdatedAt: string | null;
}

let lastQuestionsCloudMeta: QuestionsCloudMeta | null = null;

async function fetchQuestionsCloudMeta(
  client: SupabaseClient
): Promise<QuestionsCloudMeta | null> {
  try {
    let { data, error } = await client.rpc('get_questions_sync_meta', getStaffRpcAuthArgs());
    if (error && isRpcSignatureMismatchError(error.message)) {
      const legacy = await client.rpc('get_questions_sync_meta');
      data = legacy.data;
      error = legacy.error;
    }
    if (!error && Array.isArray(data) && data[0]) {
      return {
        totalCount: Number(data[0].total_count || 0),
        maxUpdatedAt: data[0].max_updated_at ? String(data[0].max_updated_at) : null,
      };
    }
  } catch {
    // Fallback to head count query
  }
  try {
    const { count, error } = await client
      .from('questions')
      .select('id', { count: 'exact', head: true });
    if (!error && typeof count === 'number') {
      return { totalCount: count, maxUpdatedAt: null };
    }
  } catch {
    // Ignore meta check error
  }
  return null;
}

async function shouldDownloadAllQuestions(
  adminClient: SupabaseClient,
  localCount: number
): Promise<{ shouldFetch: boolean; meta: QuestionsCloudMeta | null }> {
  const meta = await fetchQuestionsCloudMeta(adminClient);
  if (!meta) {
    return { shouldFetch: true, meta: null };
  }
  if (localCount === 0 && meta.totalCount > 0) {
    return { shouldFetch: true, meta };
  }
  if (localCount !== meta.totalCount) {
    return { shouldFetch: true, meta };
  }
  if (
    lastQuestionsCloudMeta &&
    lastQuestionsCloudMeta.totalCount === meta.totalCount &&
    (meta.maxUpdatedAt === null || lastQuestionsCloudMeta.maxUpdatedAt === meta.maxUpdatedAt)
  ) {
    return { shouldFetch: false, meta };
  }
  if (localCount > 0 && lastQuestionsCloudMeta === null && meta.maxUpdatedAt === null) {
    lastQuestionsCloudMeta = meta;
    return { shouldFetch: false, meta };
  }
  return { shouldFetch: true, meta };
}

async function fetchAllQuestionsFromSupabaseAdmin(
  adminClient: SupabaseClient
): Promise<{ questions: Question[]; error?: string }> {
  const collected: Question[] = [];
  const pageSize = 1000;
  for (let from = 0; from < 50_000; from += pageSize) {
    const { data, error } = await adminClient
      .from('questions')
      .select('*')
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) {
      return { questions: [], error: error.message };
    }
    if (!Array.isArray(data) || data.length === 0) {
      break;
    }
    for (const row of data) {
      collected.push(hydrateQuestionFromDbRow(row));
    }
    if (data.length < pageSize) {
      break;
    }
  }
  return { questions: collected };
}

const ADMIN_SYNC_THROTTLE_MS = 25_000;
let syncInFlight: Promise<void> | null = null;
let syncInFlightIsAdmin = false;
let lastSyncPullMs = 0;
let lastAdminDeltaPullMs = 0;
let lastProfilePullMs = 0;
let lastStudentSchedulesPullMs = 0;
let lastAdminStaticPullMs = 0;
let lastAdminResultsDeltaIso: string | null = null;
let lastAdminAutoFinalizeMs = 0;

function mapDbExamResultRow(r: Record<string, unknown>): ExamResult {
  return {
    id: String(r.id),
    participantId: String(r.participant_id || ''),
    participantNumber: String(r.participant_number || ''),
    studentName: String(r.student_name || ''),
    className: String(r.class_name || ''),
    examId: String(r.exam_id || ''),
    examTitle: String(r.exam_title || ''),
    subject: String(r.subject || ''),
    answers: (r.answers as Record<string, string>) || {},
    flaggedQuestions: Array.isArray(r.flagged_questions)
      ? (r.flagged_questions as string[])
      : [],
    questionIds: Array.isArray(r.question_ids) ? (r.question_ids as string[]) : undefined,
    correctCount: Number(r.correct_count || 0),
    totalQuestions: Number(r.total_questions || 0),
    score: Number(r.score || 0),
    tabSwitchCount: Number(r.tab_switch_count || 0),
    status: (r.status as ExamResult['status']) || 'in_progress',
    startedAt: String(r.started_at || ''),
    submittedAt: r.submitted_at ? String(r.submitted_at) : null,
    syncStatus: 'synced',
  };
}

/**
 * Menggabungkan hasil cloud ke IndexedDB dalam SATU transaksi atomic:
 * - Item lokal dengan `syncStatus === 'pending'` TIDAK pernah ditimpa atau dihapus
 * - Item lokal `syncStatus === 'synced'` yang cocok scope (`scopeParticipantUpper`) namun sudah
 *   terhapus di cloud (mis. Reset Ujian oleh Proktor) akan ikut dihapus
 */
async function syncResultsStoreAtomic(
  cloudResults: ExamResult[],
  scopeParticipantUpper?: string
): Promise<{ hasPending: boolean; changed: boolean }> {
  const db = await openDB();
  return new Promise<{ hasPending: boolean; changed: boolean }>((resolve, reject) => {
    const tx = db.transaction(STORES.RESULTS, 'readwrite');
    const store = tx.objectStore(STORES.RESULTS);
    const req = store.getAll();
    let hasPending = false;
    let changed = false;

    req.onsuccess = () => {
      const localList = (req.result as ExamResult[]) || [];
      const pendingKeySet = new Set<string>();
      const localById = new Map<string, ExamResult>();
      const cloudIdSet = new Set(cloudResults.map((c) => c.id));
      const cloudKeySet = new Set(
        cloudResults.map((c) => `${c.participantNumber.trim().toUpperCase()}::${c.examId}`)
      );

      for (const lr of localList) {
        localById.set(lr.id, lr);
        const normNum = lr.participantNumber.trim().toUpperCase();
        const key = `${normNum}::${lr.examId}`;
        if (lr.syncStatus === 'pending') {
          pendingKeySet.add(key);
          hasPending = true;
          continue;
        }
        const inScope = !scopeParticipantUpper || normNum === scopeParticipantUpper;
        if (inScope && !cloudIdSet.has(lr.id) && !cloudKeySet.has(key)) {
          store.delete(lr.id);
          changed = true;
        }
      }

      for (const cr of cloudResults) {
        const key = `${cr.participantNumber.trim().toUpperCase()}::${cr.examId}`;
        if (!pendingKeySet.has(key)) {
          const prev = localById.get(cr.id);
          if (!prev || buildResultFingerprint(prev) !== buildResultFingerprint(cr)) {
            changed = true;
          }
          store.put(cr);
        }
      }
    };

    tx.oncomplete = () => {
      if (changed) {
        invalidateStoreCache(STORES.RESULTS);
      }
      resolve({ hasPending, changed });
    };
    tx.onerror = () => reject(tx.error);
  });
}

async function ensureResultsKeyMapCache(): Promise<
  Map<string, { id: string; syncStatus?: string; fingerprint: string }>
> {
  if (resultsKeyMapCache) return resultsKeyMapCache;
  const localList = await idbGetAll<ExamResult>(STORES.RESULTS);
  const map = new Map<string, { id: string; syncStatus?: string; fingerprint: string }>();
  for (const lr of localList) {
    const key = `${lr.participantNumber.trim().toUpperCase()}::${lr.examId}`;
    map.set(key, {
      id: lr.id,
      syncStatus: lr.syncStatus,
      fingerprint: buildResultFingerprint(lr),
    });
  }
  resultsKeyMapCache = map;
  return map;
}

async function mergeResultsStoreDelta(
  deltaResults: ExamResult[]
): Promise<{ hasPending: boolean; updatedCount: number }> {
  const keyMap = await ensureResultsKeyMapCache();
  let hasPending = false;
  keyMap.forEach((v) => {
    if (v.syncStatus === 'pending') hasPending = true;
  });

  const toWrite: ExamResult[] = [];
  const toDeleteIds: string[] = [];

  for (const dr of deltaResults) {
    const key = `${dr.participantNumber.trim().toUpperCase()}::${dr.examId}`;
    const existing = keyMap.get(key);
    if (existing && existing.syncStatus === 'pending') {
      hasPending = true;
      continue;
    }
    const incomingFingerprint = buildResultFingerprint(dr);
    if (
      existing &&
      existing.id === dr.id &&
      existing.fingerprint === incomingFingerprint
    ) {
      continue;
    }
    if (existing && existing.id !== dr.id) {
      toDeleteIds.push(existing.id);
    }
    toWrite.push(dr);
    keyMap.set(key, {
      id: dr.id,
      syncStatus: dr.syncStatus,
      fingerprint: incomingFingerprint,
    });
  }

  if (toWrite.length === 0 && toDeleteIds.length === 0) {
    return { hasPending, updatedCount: 0 };
  }

  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORES.RESULTS, 'readwrite');
    const store = tx.objectStore(STORES.RESULTS);
    for (const delId of toDeleteIds) {
      store.delete(delId);
    }
    for (const dr of toWrite) {
      store.put(dr);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  if (resultsSortedCache) {
    const delSet = new Set(toDeleteIds);
    const writeByKey = new Map<string, ExamResult>();
    const writeById = new Map<string, ExamResult>();
    for (const dr of toWrite) {
      writeByKey.set(`${dr.participantNumber.trim().toUpperCase()}::${dr.examId}`, dr);
      writeById.set(dr.id, dr);
    }
    const merged: ExamResult[] = [];
    const seenKeys = new Set<string>();
    for (const existingItem of resultsSortedCache) {
      if (delSet.has(existingItem.id)) continue;
      const key = `${existingItem.participantNumber.trim().toUpperCase()}::${existingItem.examId}`;
      const replacement = writeByKey.get(key) || writeById.get(existingItem.id);
      if (replacement) {
        merged.push(replacement);
        seenKeys.add(key);
      } else {
        merged.push(existingItem);
        seenKeys.add(key);
      }
    }
    for (const dr of toWrite) {
      const key = `${dr.participantNumber.trim().toUpperCase()}::${dr.examId}`;
      if (!seenKeys.has(key)) {
        merged.push(dr);
        seenKeys.add(key);
      }
    }
    resultsSortedCache = merged.sort((a, b) =>
      (b.submittedAt || b.startedAt).localeCompare(a.submittedAt || a.startedAt)
    );
  }

  return { hasPending, updatedCount: toWrite.length + toDeleteIds.length };
}

async function reconcileDeletedResultsAdmin(client: SupabaseClient): Promise<number> {
  const idRes = await fetchAllRowsByIdPaginated<{ id: string }>(
    client,
    'exam_results',
    'id',
    100_000
  );
  if (idRes.error) return 0;
  const cloudIdSet = new Set(idRes.data.map((r) => String(r.id)));
  const localList = await idbGetAll<ExamResult>(STORES.RESULTS);
  const toDelete = localList.filter(
    (lr) => lr.syncStatus !== 'pending' && !cloudIdSet.has(lr.id)
  );
  if (toDelete.length === 0) return 0;

  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORES.RESULTS, 'readwrite');
    const store = tx.objectStore(STORES.RESULTS);
    for (const item of toDelete) {
      store.delete(item.id);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  invalidateStoreCache(STORES.RESULTS);
  return toDelete.length;
}

export async function deleteExamResultLocalById(resultId: string): Promise<void> {
  if (!resultId) return;
  await ensureInitialized();
  const existing = await idbGet<ExamResult>(STORES.RESULTS, resultId);
  if (!existing || existing.syncStatus === 'pending') return;
  for (const key of confirmedQuestionIdsSyncSet) {
    if (key.startsWith(`${resultId}::`)) {
      confirmedQuestionIdsSyncSet.delete(key);
    }
  }
  await idbDelete(STORES.RESULTS, resultId);
  broadcastDataChange('results');
}

export async function forceDeleteExamResultForReset(
  participantNumber: string,
  examId: string
): Promise<void> {
  await ensureInitialized();
  const normNum = participantNumber.trim().toUpperCase();
  for (const key of confirmedQuestionIdsSyncSet) {
    if (key.endsWith(`::${normNum}::${examId}`)) {
      confirmedQuestionIdsSyncSet.delete(key);
    }
  }
  const all = await idbGetAll<ExamResult>(STORES.RESULTS);
  const matches = all.filter(
    (r) => r.participantNumber.trim().toUpperCase() === normNum && r.examId === examId
  );
  if (matches.length > 0) {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORES.RESULTS, 'readwrite');
      const store = tx.objectStore(STORES.RESULTS);
      for (const m of matches) {
        store.delete(m.id);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    invalidateStoreCache(STORES.RESULTS);
    broadcastDataChange('results');
  }
}

export async function syncStudentResultsFromCloud(
  participantNumber: string
): Promise<ExamResult[]> {
  await ensureInitialized();
  const normNum = participantNumber.trim().toUpperCase();
  if (!normNum) return [];

  if (isLiveSupabaseConfigured()) {
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await fetchExamResultsForParticipant(
        supabase,
        normNum,
        EXAM_RESULTS_ADMIN_COLUMNS
      );

      if (!error && Array.isArray(data)) {
        const mapped = data.map((row) => mapDbExamResultRow(row));
        const syncRes = await syncResultsStoreAtomic(mapped, normNum);
        if (syncRes.changed) {
          broadcastDataChange('results');
        }
      }
    } catch {
      // Keep operating cleanly with local cache
    }
  }

  const allLocal = await getExamResults();
  return allLocal.filter((r) => r.participantNumber.trim().toUpperCase() === normNum);
}

export async function syncFromSupabase(options?: {
  force?: boolean;
  currentParticipantNumber?: string;
  isAdmin?: boolean;
  resultsOnly?: boolean;
}): Promise<void> {
  if (!isLiveSupabaseConfigured()) return;
  const wantAdmin = Boolean(options?.isAdmin);
  const now = Date.now();
  if (!options?.force && !syncInFlight && now - lastSyncPullMs < 1500) {
    return;
  }
  if (
    !options?.force &&
    wantAdmin &&
    options?.resultsOnly &&
    !syncInFlight &&
    now - lastAdminDeltaPullMs < ADMIN_SYNC_THROTTLE_MS
  ) {
    return;
  }
  if (syncInFlight) {
    const runningAsAdmin = syncInFlightIsAdmin;
    await syncInFlight;
    if (!wantAdmin || runningAsAdmin) {
      return;
    }
  }
  syncInFlightIsAdmin = wantAdmin;
  syncInFlight = (async () => {
    try {
      await pullFromSupabaseSilent({
        currentParticipantNumber: options?.currentParticipantNumber,
        isAdmin: wantAdmin,
        force: options?.force,
        resultsOnly: options?.resultsOnly,
      });
      lastSyncPullMs = Date.now();
    } finally {
      syncInFlight = null;
      syncInFlightIsAdmin = false;
    }
  })();
  return syncInFlight;
}

function isMissingTableError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('does not exist') ||
    lower.includes('could not find') ||
    (lower.includes('relation') && lower.includes('not'))
  );
}

async function pullFromSupabaseSilent(options?: {
  currentParticipantNumber?: string;
  isAdmin?: boolean;
  force?: boolean;
  resultsOnly?: boolean;
}): Promise<void> {
  try {
    await syncServerClock();
    const supabase = getSupabaseClient();
    const adminClient = getSupabaseAdminClient();
    const isAdmin = Boolean(options?.isAdmin);
    const readClient = isAdmin && adminClient ? adminClient : supabase;
    const normParticipant = options?.currentParticipantNumber?.trim().toUpperCase() || '';

    if (isAdmin) {
      const shouldFetchStatic =
        !options?.resultsOnly &&
        (Boolean(options?.force) ||
          lastAdminStaticPullMs === 0 ||
          Date.now() - lastAdminStaticPullMs > 300_000);

      const maybeAutoFinalizeAdmin = () => {
        if (Date.now() - lastAdminAutoFinalizeMs >= ADMIN_SYNC_THROTTLE_MS) {
          lastAdminAutoFinalizeMs = Date.now();
          void autoFinalizeExpiredExams({
            currentParticipantNumber: options?.currentParticipantNumber,
            isAdmin: true,
          });
        }
      };

      if (!shouldFetchStatic) {
        lastAdminDeltaPullMs = Date.now();
        if (lastAdminResultsDeltaIso) {
          const deltaRes = await fetchExamResultsDelta(readClient, lastAdminResultsDeltaIso);
          if (!deltaRes.error) {
            lastAdminResultsDeltaIso = deltaRes.maxUpdatedAt;
            const deltaMapped = deltaRes.data.map((r) => mapDbExamResultRow(r));
            const { hasPending, updatedCount } = await mergeResultsStoreDelta(deltaMapped);
            if (hasPending) {
              void flushPendingSyncQueue();
            }
            if (updatedCount > 0) {
              broadcastDataChange('results');
            }
            maybeAutoFinalizeAdmin();
          }
          return;
        }

        const resRes = await fetchAllRowsByIdPaginated(
          readClient,
          'exam_results',
          EXAM_RESULTS_ADMIN_COLUMNS
        );
        if (!resRes.error) {
          lastAdminResultsDeltaIso = getMaxUpdatedAtIso(resRes.data as Record<string, unknown>[]);
          const cloudResults = resRes.data.map((r) =>
            mapDbExamResultRow(r as Record<string, unknown>)
          );
          const { hasPending, changed } = await syncResultsStoreAtomic(cloudResults);
          if (hasPending) {
            void flushPendingSyncQueue();
          }
          if (changed) {
            broadcastDataChange('results');
          }
          maybeAutoFinalizeAdmin();
        }
        return;
      }

      lastAdminStaticPullMs = Date.now();
      lastAdminDeltaPullMs = Date.now();
      const useFullResultsReconcile = !lastAdminResultsDeltaIso || Boolean(options?.force);
      const changedTopics: string[] = [];

      const fetchStaffForAdminSilent = async (): Promise<{
        data: Record<string, unknown>[];
        error?: string;
      }> => {
        if (adminClient) {
          return fetchAllRowsByIdPaginated(adminClient, 'staff_accounts');
        }
        const rpcRes = await supabase.rpc('staff_list_accounts', getStaffRpcAuthArgs());
        if (!rpcRes.error && Array.isArray(rpcRes.data)) {
          return { data: rpcRes.data as Record<string, unknown>[] };
        }
        if (rpcRes.error && isRpcSignatureMismatchError(rpcRes.error.message)) {
          return fetchAllRowsByIdPaginated(supabase, 'staff_accounts');
        }
        return { data: [], error: rpcRes.error?.message };
      };

      const [profRes, schedRes, partRes, staffRes] = await Promise.all([
        readClient
          .from('school_profile')
          .select(adminClient ? ADMIN_SCHOOL_PROFILE_COLUMNS : PUBLIC_SCHOOL_PROFILE_COLUMNS)
          .eq('id', 'default')
          .maybeSingle(),
        fetchAllRowsByIdPaginated(readClient, 'exam_schedules'),
        fetchAllRowsByIdPaginated(readClient, 'participants'),
        fetchStaffForAdminSilent(),
      ]);

      const hasCloudProfile = Boolean(!profRes.error && profRes.data);

      if (hasCloudProfile && profRes.data) {
        lastProfilePullMs = Date.now();
        const existingProfile = await idbGet<SchoolProfile>(STORES.META, 'default');
        const profRow = profRes.data as unknown as Record<string, unknown>;
        const resolvedAdminPwd =
          (typeof profRow.admin_password === 'string' && profRow.admin_password) ||
          existingProfile?.adminPassword ||
          SEED_SCHOOL_PROFILE.adminPassword;
        const nextProfile: SchoolProfile = {
          id: 'default',
          schoolName: String(profRow.school_name || ''),
          address: String(profRow.address || ''),
          academicYear: String(profRow.academic_year || ''),
          principalName: String(profRow.principal_name || ''),
          committeeChairName: String(profRow.committee_chair_name || ''),
          examTitle: String(profRow.exam_title || ''),
          logoDataUrl: String(profRow.logo_data_url || '') || SEED_SCHOOL_PROFILE.logoDataUrl,
          adminPassword: resolvedAdminPwd,
          updatedAt: String(profRow.updated_at || new Date().toISOString()),
        };
        const profileDiffers =
          !existingProfile ||
          existingProfile.updatedAt !== nextProfile.updatedAt ||
          existingProfile.schoolName !== nextProfile.schoolName ||
          existingProfile.examTitle !== nextProfile.examTitle ||
          existingProfile.adminPassword !== nextProfile.adminPassword ||
          existingProfile.logoDataUrl !== nextProfile.logoDataUrl;
        if (profileDiffers) {
          await idbPut(STORES.META, nextProfile);
          changedTopics.push('profile');
        }
      }

      if (!schedRes.error && (schedRes.data.length > 0 || hasCloudProfile)) {
        const nextSchedules: ExamSchedule[] = schedRes.data.map((r) => ({
          id: r.id,
          title: r.title,
          subject: r.subject,
          kkm: Number(r.kkm ?? 75),
          durationMinutes: r.duration_minutes,
          targetClasses: r.target_classes,
          isActive: r.is_active,
          randomizeQuestions: Boolean(r.randomize_questions ?? false),
          maxTabSwitches: r.max_tab_switches,
          createdAt: r.created_at,
        }));
        const existingSchedules = await idbGetAll<ExamSchedule>(STORES.SCHEDULES);
        const schedSig = (list: ExamSchedule[]) =>
          [...list]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map(
              (s) =>
                `${s.id}|${s.title}|${s.subject}|${s.kkm}|${s.durationMinutes}|${s.isActive}|${Boolean(s.randomizeQuestions)}|${s.maxTabSwitches}|${(s.targetClasses || []).join(',')}`
            )
            .join(';;');
        if (
          existingSchedules.length !== nextSchedules.length ||
          schedSig(existingSchedules) !== schedSig(nextSchedules)
        ) {
          await idbPutMany(STORES.SCHEDULES, nextSchedules, true);
          changedTopics.push('schedules');
        }
      }

      if (!partRes.error && (partRes.data.length > 0 || hasCloudProfile)) {
        const nextParticipants: Participant[] = partRes.data.map((r) => ({
          id: String(r.id),
          participantNumber: r.participant_number,
          token: r.token || 'CBT2026',
          fullName: r.full_name,
          className: r.class_name,
          isActive: r.is_active,
          createdAt: r.created_at,
        }));
        const existingParts = await idbGetAll<Participant>(STORES.PARTICIPANTS);
        let partsChanged = existingParts.length !== nextParticipants.length;
        if (!partsChanged) {
          const existingMap = new Map(existingParts.map((p) => [p.id, p]));
          for (const np of nextParticipants) {
            const ep = existingMap.get(np.id);
            if (
              !ep ||
              ep.participantNumber !== np.participantNumber ||
              ep.token !== np.token ||
              ep.fullName !== np.fullName ||
              ep.className !== np.className ||
              ep.isActive !== np.isActive
            ) {
              partsChanged = true;
              break;
            }
          }
        }
        if (partsChanged) {
          await idbPutParticipantsSafe(nextParticipants, true);
          changedTopics.push('participants');
        }
      }

      if (useFullResultsReconcile) {
        const resRes = await fetchAllRowsByIdPaginated(
          readClient,
          'exam_results',
          EXAM_RESULTS_ADMIN_COLUMNS,
          100_000
        );
        if (!resRes.error) {
          lastAdminResultsDeltaIso = getMaxUpdatedAtIso(resRes.data as Record<string, unknown>[]);
          const cloudResults = resRes.data.map((r) =>
            mapDbExamResultRow(r as Record<string, unknown>)
          );
          const localResults = await idbGetAll<ExamResult>(STORES.RESULTS);
          let resultsDiffer = localResults.length !== cloudResults.length;
          if (!resultsDiffer) {
            const localById = new Map(localResults.map((r) => [r.id, r]));
            for (const cr of cloudResults) {
              const lr = localById.get(cr.id);
              if (!lr) {
                resultsDiffer = true;
                break;
              }
              if (lr.syncStatus === 'pending') continue;
              if (buildResultFingerprint(lr) !== buildResultFingerprint(cr)) {
                resultsDiffer = true;
                break;
              }
            }
          }
          if (resultsDiffer || options?.force) {
            const { hasPending } = await syncResultsStoreAtomic(cloudResults);
            if (hasPending) {
              void flushPendingSyncQueue();
            }
            changedTopics.push('results');
          }
        }
      } else if (lastAdminResultsDeltaIso) {
        const [deltaRes, deletedCount] = await Promise.all([
          fetchExamResultsDelta(readClient, lastAdminResultsDeltaIso),
          reconcileDeletedResultsAdmin(readClient),
        ]);
        if (!deltaRes.error) {
          lastAdminResultsDeltaIso = deltaRes.maxUpdatedAt;
          const deltaMapped = deltaRes.data.map((r) => mapDbExamResultRow(r));
          const { hasPending, updatedCount } = await mergeResultsStoreDelta(deltaMapped);
          if (hasPending) {
            void flushPendingSyncQueue();
          }
          if (updatedCount > 0 || deletedCount > 0) {
            changedTopics.push('results');
          }
        } else if (deletedCount > 0) {
          changedTopics.push('results');
        }
      }

      if (!staffRes.error && staffRes.data.length > 0) {
        const existingStaff = await idbGetAll<StaffAccount>(STORES.STAFF_ACCOUNTS);
        const existingByUser = new Map(
          existingStaff.map((e) => [e.userId.trim().toLowerCase(), e])
        );
        const mappedStaff: StaffAccount[] = staffRes.data.map((s) => {
          const userId = String(s.user_id || '');
          const localPrev = existingByUser.get(userId.trim().toLowerCase());
          const rawPwd = typeof s.password_hash === 'string' ? s.password_hash : '';
          return {
            id: String(s.id),
            userId,
            name: String(s.name || ''),
            password: rawPwd || localPrev?.password || '__CLOUD_MANAGED__',
            roleType: s.role_type as StaffAccount['roleType'],
            roleLabel: String(s.role_label || 'Staff'),
            allowedTabs: Array.isArray(s.allowed_tabs)
              ? (s.allowed_tabs as StaffAccount['allowedTabs'])
              : [],
            assignedSubjects: Array.isArray(s.assigned_subjects)
              ? (s.assigned_subjects as string[])
              : [],
            restrictToAssignedSubjects: Boolean(s.restrict_to_assigned_subjects),
            isActive: Boolean(s.is_active),
            createdAt: String(s.created_at || new Date().toISOString()),
          };
        });
        const hasCloudAdmin = mappedStaff.some(
          (s) => s.userId.trim().toLowerCase() === 'admin'
        );
        if (!hasCloudAdmin) {
          const localAdmin = existingStaff.find(
            (s) => s.userId.trim().toLowerCase() === 'admin'
          );
          if (localAdmin) {
            mappedStaff.unshift(localAdmin);
          }
        }
        const staffSig = (list: StaffAccount[]) =>
          [...list]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map(
              (s) =>
                `${s.id}|${s.userId}|${s.name}|${s.password}|${s.roleType}|${s.isActive}|${s.allowedTabs.join(',')}|${s.assignedSubjects.join(',')}|${s.restrictToAssignedSubjects}`
            )
            .join(';;');
        if (staffSig(existingStaff) !== staffSig(mappedStaff)) {
          await idbPutStaffSafe(mappedStaff, true);
          changedTopics.push('staff_accounts');
        }
      }

      if (adminClient) {
        const localQuestions = await idbGetAll<Question>(STORES.QUESTIONS);
        const check = await shouldDownloadAllQuestions(adminClient, localQuestions.length);
        if (check.shouldFetch) {
          const qFetch = await fetchAllQuestionsFromSupabaseAdmin(adminClient);
          if (!qFetch.error && (qFetch.questions.length > 0 || hasCloudProfile)) {
            await idbPutMany(STORES.QUESTIONS, qFetch.questions, true);
            lastQuestionsCloudMeta = check.meta || {
              totalCount: qFetch.questions.length,
              maxUpdatedAt: null,
            };
            changedTopics.push('questions');
          }
        }
      }

      if (changedTopics.length > 0) {
        broadcastDataChange(`supabase_pull_changed:${changedTopics.join(',')}`);
      }
      maybeAutoFinalizeAdmin();
      return;
    }

    // Student / Public route: HANYA tarik metadata profil (logo ditarik hanya jika updated_at berubah & tanpa admin_password),
    // jadwal aktif (cache 60 detik), dan hasil milik peserta sendiri.
    const shouldFetchProfile =
      Boolean(options?.force) ||
      lastProfilePullMs === 0 ||
      Date.now() - lastProfilePullMs > 300_000;

    const shouldFetchSchedules =
      Boolean(options?.force) ||
      lastStudentSchedulesPullMs === 0 ||
      Date.now() - lastStudentSchedulesPullMs > 60_000;

    const localProfile = shouldFetchProfile
      ? await idbGet<SchoolProfile>(STORES.META, 'default')
      : undefined;

    const [profMetaRes, schedRes, myResRes] = await Promise.all([
      shouldFetchProfile
        ? supabase.from('school_profile').select('id,updated_at').eq('id', 'default').maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      shouldFetchSchedules
        ? fetchAllRowsByIdPaginated(supabase, 'exam_schedules')
        : Promise.resolve({ data: [] as Record<string, unknown>[], error: undefined }),
      normParticipant
        ? fetchExamResultsForParticipant(supabase, normParticipant, EXAM_RESULTS_ADMIN_COLUMNS)
        : Promise.resolve({ data: [] as Record<string, unknown>[], error: null }),
    ]);

    let hasCloudProfile = Boolean(!profMetaRes.error && profMetaRes.data);

    if (hasCloudProfile && profMetaRes.data) {
      lastProfilePullMs = Date.now();
      const needsFullProfile =
        !localProfile ||
        !localProfile.logoDataUrl ||
        profMetaRes.data.updated_at !== localProfile.updatedAt;

      if (needsFullProfile) {
        const profRes = await supabase
          .from('school_profile')
          .select(PUBLIC_SCHOOL_PROFILE_COLUMNS)
          .eq('id', 'default')
          .maybeSingle();

        if (!profRes.error && profRes.data) {
          await idbPut(STORES.META, {
            id: 'default',
            schoolName: profRes.data.school_name,
            address: profRes.data.address,
            academicYear: profRes.data.academic_year,
            principalName: profRes.data.principal_name,
            committeeChairName: profRes.data.committee_chair_name,
            examTitle: profRes.data.exam_title,
            logoDataUrl: profRes.data.logo_data_url || SEED_SCHOOL_PROFILE.logoDataUrl,
            adminPassword: localProfile?.adminPassword || SEED_SCHOOL_PROFILE.adminPassword,
            updatedAt: profRes.data.updated_at,
          } satisfies SchoolProfile);
        } else {
          hasCloudProfile = false;
        }
      }
    }

    if (shouldFetchSchedules && !schedRes.error && (schedRes.data.length > 0 || hasCloudProfile)) {
      lastStudentSchedulesPullMs = Date.now();
      await idbPutMany(
        STORES.SCHEDULES,
        schedRes.data.map((r) => ({
          id: r.id,
          title: r.title,
          subject: r.subject,
          kkm: Number(r.kkm ?? 75),
          durationMinutes: r.duration_minutes,
          targetClasses: r.target_classes,
          isActive: r.is_active,
          randomizeQuestions: Boolean(r.randomize_questions ?? false),
          maxTabSwitches: r.max_tab_switches,
          createdAt: r.created_at,
        })),
        true
      );
    }

    if (normParticipant && !myResRes.error && Array.isArray(myResRes.data)) {
      const cloudOwn = myResRes.data.map((r) => mapDbExamResultRow(r));
      const { hasPending } = await syncResultsStoreAtomic(cloudOwn, normParticipant);
      if (hasPending) {
        void flushPendingSyncQueue();
      }
    }

    broadcastDataChange('supabase_pull_student');
    if (normParticipant) {
      void autoFinalizeExpiredExams({
        currentParticipantNumber: normParticipant,
        isAdmin: false,
      });
    }
  } catch {
    // Keep operating cleanly with Local-First IndexedDB cache
  }
}

// ============================================================================
// SCHOOL PROFILE & ADMIN PASSWORD
// ============================================================================
export async function getSchoolProfile(): Promise<SchoolProfile> {
  await ensureInitialized();
  const profile = await idbGet<SchoolProfile>(STORES.META, 'default');
  return profile || SEED_SCHOOL_PROFILE;
}

export async function saveSchoolProfile(profile: SchoolProfile): Promise<void> {
  await ensureInitialized();
  const hashedAdminPwd = await hashPassword(profile.adminPassword || 'admin123');
  const updated: SchoolProfile = {
    ...profile,
    id: 'default',
    adminPassword: hashedAdminPwd,
    updatedAt: new Date().toISOString(),
  };
  await idbPut(STORES.META, updated);

  if (activeStaffCredentials?.userId.toLowerCase() === 'admin') {
    activeStaffCredentials.passwordHash = hashedAdminPwd;
  }

  // Keep primary 'admin' staff account password in sync (hashed in staff_accounts)
  const staffList = await idbGetAll<StaffAccount>(STORES.STAFF_ACCOUNTS);
  const existingAdmin = staffList.find((s) => s.userId.toLowerCase() === 'admin');
  const baseAdmin = existingAdmin || {
    ...SEED_STAFF_ACCOUNTS[0],
    allowedTabs: ALL_ADMIN_TABS,
  };
  if (!existingAdmin || existingAdmin.password !== hashedAdminPwd) {
    const updatedAdmin: StaffAccount = { ...baseAdmin, password: hashedAdminPwd };
    await idbPutStaffSafe([updatedAdmin]);
    if (isLiveSupabaseConfigured()) {
      try {
        const adminClient = getSupabaseAdminClient();
        const supabase = getSupabaseClient();
        if (adminClient) {
          await adminClient.from('staff_accounts').upsert(
            {
              id: updatedAdmin.id,
              user_id: updatedAdmin.userId,
              name: updatedAdmin.name,
              password_hash: updatedAdmin.password,
              role_type: updatedAdmin.roleType,
              role_label: updatedAdmin.roleLabel,
              allowed_tabs: updatedAdmin.allowedTabs,
              assigned_subjects: updatedAdmin.assignedSubjects,
              restrict_to_assigned_subjects: updatedAdmin.restrictToAssignedSubjects,
              is_active: updatedAdmin.isActive,
              created_at: updatedAdmin.createdAt,
            },
            { onConflict: 'user_id' }
          );
        } else {
          const { error: rpcErr } = await supabase.rpc('staff_upsert_account', {
            ...getStaffRpcAuthArgs(),
            p_id: updatedAdmin.id,
            p_target_user_id: updatedAdmin.userId,
            p_name: updatedAdmin.name,
            p_password_hash: updatedAdmin.password,
            p_role_type: updatedAdmin.roleType,
            p_role_label: updatedAdmin.roleLabel,
            p_allowed_tabs: updatedAdmin.allowedTabs,
            p_assigned_subjects: updatedAdmin.assignedSubjects,
            p_restrict_to_assigned_subjects: updatedAdmin.restrictToAssignedSubjects,
            p_is_active: updatedAdmin.isActive,
            p_created_at: updatedAdmin.createdAt,
          });
          if (rpcErr && isRpcSignatureMismatchError(rpcErr.message)) {
            await supabase.from('staff_accounts').upsert(
              {
                id: updatedAdmin.id,
                user_id: updatedAdmin.userId,
                name: updatedAdmin.name,
                password_hash: updatedAdmin.password,
                role_type: updatedAdmin.roleType,
                role_label: updatedAdmin.roleLabel,
                allowed_tabs: updatedAdmin.allowedTabs,
                assigned_subjects: updatedAdmin.assignedSubjects,
                restrict_to_assigned_subjects: updatedAdmin.restrictToAssignedSubjects,
                is_active: updatedAdmin.isActive,
                created_at: updatedAdmin.createdAt,
              },
              { onConflict: 'user_id' }
            );
          }
        }
      } catch {
        // Ignore if staff_accounts table not yet migrated
      }
    }
  }

  broadcastDataChange('profile');

  if (isLiveSupabaseConfigured()) {
    try {
      const adminClient = getSupabaseAdminClient();
      const supabase = getSupabaseClient();
      if (adminClient) {
        await adminClient.from('school_profile').upsert({
          id: 'default',
          school_name: updated.schoolName,
          address: updated.address,
          academic_year: updated.academicYear,
          principal_name: updated.principalName,
          committee_chair_name: updated.committeeChairName,
          exam_title: updated.examTitle,
          logo_data_url: updated.logoDataUrl,
          admin_password: hashedAdminPwd,
          updated_at: updated.updatedAt,
        });
      } else {
        const { error: rpcErr } = await supabase.rpc('staff_upsert_school_profile', {
          ...getStaffRpcAuthArgs(),
          p_school_name: updated.schoolName,
          p_address: updated.address,
          p_academic_year: updated.academicYear,
          p_principal_name: updated.principalName,
          p_committee_chair_name: updated.committeeChairName,
          p_exam_title: updated.examTitle,
          p_logo_data_url: updated.logoDataUrl,
          p_admin_password_hash: hashedAdminPwd,
          p_updated_at: updated.updatedAt,
        });
        if (rpcErr && isRpcSignatureMismatchError(rpcErr.message)) {
          await supabase.from('school_profile').upsert({
            id: 'default',
            school_name: updated.schoolName,
            address: updated.address,
            academic_year: updated.academicYear,
            principal_name: updated.principalName,
            committee_chair_name: updated.committeeChairName,
            exam_title: updated.examTitle,
            logo_data_url: updated.logoDataUrl,
            admin_password: hashedAdminPwd,
            updated_at: updated.updatedAt,
          });
        }
      }
    } catch {
      // Cached locally
    }
  }
}

// ============================================================================
// STAFF ACCOUNTS & ROLE-BASED ACCESS CONTROL
// ============================================================================
export async function getStaffAccounts(): Promise<StaffAccount[]> {
  await ensureInitialized();
  const list = await idbGetAll<StaffAccount>(STORES.STAFF_ACCOUNTS);
  return list.sort((a, b) => {
    if (a.userId.toLowerCase() === 'admin') return -1;
    if (b.userId.toLowerCase() === 'admin') return 1;
    return a.roleType.localeCompare(b.roleType) || a.userId.localeCompare(b.userId);
  });
}

export async function upsertStaffAccount(
  account: StaffAccount
): Promise<{ synced: boolean; error?: string }> {
  await ensureInitialized();
  const rawPassword = account.password.trim();
  const isCloudPlaceholder = rawPassword === '__CLOUD_MANAGED__';
  const hashedPassword = isCloudPlaceholder
    ? '__CLOUD_MANAGED__'
    : rawPassword
      ? await hashPassword(rawPassword)
      : '';
  const normalized: StaffAccount = {
    ...account,
    userId: account.userId.trim(),
    password: hashedPassword,
  };
  await idbPutStaffSafe([normalized]);

  if (
    activeStaffCredentials &&
    activeStaffCredentials.userId.trim().toLowerCase() === normalized.userId.toLowerCase() &&
    hashedPassword &&
    !isCloudPlaceholder
  ) {
    activeStaffCredentials.passwordHash = hashedPassword;
  }

  if (normalized.userId.toLowerCase() === 'admin' && hashedPassword && !isCloudPlaceholder) {
    const profile = await idbGet<SchoolProfile>(STORES.META, 'default');
    if (profile && profile.adminPassword !== hashedPassword) {
      const updatedProfile = {
        ...profile,
        adminPassword: hashedPassword,
        updatedAt: new Date().toISOString(),
      };
      await idbPut(STORES.META, updatedProfile);
      if (isLiveSupabaseConfigured()) {
        try {
          const adminClient = getSupabaseAdminClient();
          const supabase = getSupabaseClient();
          if (adminClient) {
            await adminClient
              .from('school_profile')
              .update({ admin_password: hashedPassword, updated_at: updatedProfile.updatedAt })
              .eq('id', 'default');
          } else {
            await supabase.rpc('staff_upsert_school_profile', {
              ...getStaffRpcAuthArgs(),
              p_school_name: updatedProfile.schoolName,
              p_address: updatedProfile.address,
              p_academic_year: updatedProfile.academicYear,
              p_principal_name: updatedProfile.principalName,
              p_committee_chair_name: updatedProfile.committeeChairName,
              p_exam_title: updatedProfile.examTitle,
              p_logo_data_url: updatedProfile.logoDataUrl,
              p_admin_password_hash: hashedPassword,
              p_updated_at: updatedProfile.updatedAt,
            });
          }
        } catch {
          // Cached locally
        }
      }
    }
  }

  let synced = false;
  let syncError: string | undefined;

  if (isLiveSupabaseConfigured()) {
    try {
      const adminClient = getSupabaseAdminClient();
      const supabase = getSupabaseClient();
      if (adminClient) {
        const dbRow: Record<string, unknown> = {
          id: normalized.id,
          user_id: normalized.userId,
          name: normalized.name,
          role_type: normalized.roleType,
          role_label: normalized.roleLabel,
          allowed_tabs: normalized.allowedTabs,
          assigned_subjects: normalized.assignedSubjects,
          restrict_to_assigned_subjects: normalized.restrictToAssignedSubjects,
          is_active: normalized.isActive,
          created_at: normalized.createdAt,
        };
        if (!isCloudPlaceholder && normalized.password) {
          dbRow.password_hash = normalized.password;
        }
        const { error } = await adminClient
          .from('staff_accounts')
          .upsert(dbRow, { onConflict: 'user_id' });
        if (error) {
          syncError = error.message;
        } else {
          synced = true;
        }
      } else {
        const { error: rpcErr } = await supabase.rpc('staff_upsert_account', {
          ...getStaffRpcAuthArgs(),
          p_id: normalized.id,
          p_target_user_id: normalized.userId,
          p_name: normalized.name,
          p_password_hash: normalized.password,
          p_role_type: normalized.roleType,
          p_role_label: normalized.roleLabel,
          p_allowed_tabs: normalized.allowedTabs,
          p_assigned_subjects: normalized.assignedSubjects,
          p_restrict_to_assigned_subjects: normalized.restrictToAssignedSubjects,
          p_is_active: normalized.isActive,
          p_created_at: normalized.createdAt,
        });
        if (!rpcErr) {
          synced = true;
        } else if (isRpcSignatureMismatchError(rpcErr.message) && !isCloudPlaceholder) {
          const { error } = await supabase.from('staff_accounts').upsert(
            {
              id: normalized.id,
              user_id: normalized.userId,
              name: normalized.name,
              password_hash: normalized.password,
              role_type: normalized.roleType,
              role_label: normalized.roleLabel,
              allowed_tabs: normalized.allowedTabs,
              assigned_subjects: normalized.assignedSubjects,
              restrict_to_assigned_subjects: normalized.restrictToAssignedSubjects,
              is_active: normalized.isActive,
              created_at: normalized.createdAt,
            },
            { onConflict: 'user_id' }
          );
          if (error) syncError = error.message;
          else synced = true;
        } else {
          syncError = rpcErr.message;
        }
      }
    } catch (err) {
      syncError = err instanceof Error ? err.message : 'Gagal terhubung ke Supabase';
    }
  }

  broadcastDataChange('staff_accounts');
  return { synced, error: syncError };
}

export async function deleteStaffAccount(
  id: string
): Promise<{ synced: boolean; error?: string }> {
  await ensureInitialized();
  const existing = await idbGet<StaffAccount>(STORES.STAFF_ACCOUNTS, id);
  if (existing && existing.userId.toLowerCase() === 'admin') {
    return { synced: true };
  }
  await idbDelete(STORES.STAFF_ACCOUNTS, id);

  let synced = false;
  let syncError: string | undefined;

  if (isLiveSupabaseConfigured()) {
    try {
      const adminClient = getSupabaseAdminClient();
      const supabase = getSupabaseClient();
      if (adminClient) {
        const { error: idErr } = await adminClient.from('staff_accounts').delete().eq('id', id);
        if (idErr) {
          syncError = idErr.message;
        } else {
          if (existing?.userId) {
            await adminClient
              .from('staff_accounts')
              .delete()
              .ilike('user_id', escapeLikePattern(existing.userId));
          }
          synced = true;
        }
      } else {
        const { error: rpcErr } = await supabase.rpc('staff_delete_account', {
          ...getStaffRpcAuthArgs(),
          p_target_id: id,
          p_target_user_id: existing?.userId || null,
        });
        if (!rpcErr) {
          synced = true;
        } else if (isRpcSignatureMismatchError(rpcErr.message)) {
          const { error: idErr } = await supabase.from('staff_accounts').delete().eq('id', id);
          if (idErr) syncError = idErr.message;
          else synced = true;
        } else {
          syncError = rpcErr.message;
        }
      }
    } catch (err) {
      syncError = err instanceof Error ? err.message : 'Gagal terhubung ke Supabase';
    }
  }

  broadcastDataChange('staff_accounts');
  return { synced, error: syncError };
}

export async function authenticateStaff(
  rawUserId: string,
  rawPassword: string
): Promise<{ ok: boolean; staff: StaffAccount | null; message?: string }> {
  await ensureInitialized();
  const normId = rawUserId.trim().toLowerCase();
  const pwd = rawPassword.trim();

  if (!normId) {
    return { ok: false, staff: null, message: 'Masukkan ID Pengguna / Role terlebih dahulu.' };
  }
  if (!pwd) {
    return { ok: false, staff: null, message: 'Masukkan Sandi / PIN terlebih dahulu.' };
  }

  if (isLiveSupabaseConfigured()) {
    try {
      const supabase = getSupabaseClient();
      const hashedPwd = await hashPassword(pwd);
      const { data: rpcData, error: rpcErr } = await supabase.rpc('verify_staff_login', {
        p_user_id: normId,
        p_password_plain: pwd,
        p_password_sha256: hashedPwd,
      });

      if (!rpcErr && Array.isArray(rpcData) && rpcData[0]) {
        const row = rpcData[0] as Record<string, unknown>;
        if (row.ok === true) {
          const verified: StaffAccount = {
            id: String(row.id),
            userId: String(row.user_id),
            name: String(row.name),
            password: hashedPwd,
            roleType: row.role_type as StaffAccount['roleType'],
            roleLabel: String(row.role_label || 'Staff'),
            allowedTabs: Array.isArray(row.allowed_tabs)
              ? (row.allowed_tabs as StaffAccount['allowedTabs'])
              : [],
            assignedSubjects: Array.isArray(row.assigned_subjects)
              ? (row.assigned_subjects as string[])
              : [],
            restrictToAssignedSubjects: Boolean(row.restrict_to_assigned_subjects),
            isActive: Boolean(row.is_active),
            createdAt: String(row.created_at || new Date().toISOString()),
          };
          await idbPutStaffSafe([verified]);
          setActiveStaffCredentials(verified);
          return { ok: true, staff: verified };
        }
        const rpcMsg = row.message ? String(row.message) : '';
        if (rpcMsg && rpcMsg !== 'not_found') {
          return { ok: false, staff: null, message: rpcMsg };
        }
      }

      // Fallback untuk database lama yang belum menjalankan fungsi RPC verify_staff_login
      if (rpcErr) {
        const adminClient = getSupabaseAdminClient();
        const readClient = adminClient || supabase;
        const { data: remoteStaff, error: staffErr } = await readClient
          .from('staff_accounts')
          .select('*')
          .ilike('user_id', escapeLikePattern(normId))
          .limit(1)
          .maybeSingle();

        if (!staffErr && remoteStaff) {
          const mapped: StaffAccount = {
            id: String(remoteStaff.id),
            userId: String(remoteStaff.user_id),
            name: String(remoteStaff.name),
            password: String(remoteStaff.password_hash || ''),
            roleType: remoteStaff.role_type,
            roleLabel: String(remoteStaff.role_label || 'Staff'),
            allowedTabs: Array.isArray(remoteStaff.allowed_tabs) ? remoteStaff.allowed_tabs : [],
            assignedSubjects: Array.isArray(remoteStaff.assigned_subjects)
              ? remoteStaff.assigned_subjects
              : [],
            restrictToAssignedSubjects: Boolean(remoteStaff.restrict_to_assigned_subjects),
            isActive: Boolean(remoteStaff.is_active),
            createdAt: remoteStaff.created_at,
          };
          await idbPutStaffSafe([mapped]);
        } else if (normId === 'admin' && adminClient) {
          const { data: prof } = await adminClient
            .from('school_profile')
            .select('admin_password')
            .eq('id', 'default')
            .maybeSingle();
          if (prof?.admin_password) {
            const localList = await idbGetAll<StaffAccount>(STORES.STAFF_ACCOUNTS);
            const localAdmin = localList.find(
              (acc) => acc.userId.trim().toLowerCase() === 'admin'
            );
            if (localAdmin) {
              await idbPutStaffSafe([
                { ...localAdmin, password: await hashPassword(prof.admin_password) },
              ]);
            }
          }
        }
      }
    } catch {
      // Fallback to local cache when offline
    }
  }

  const list = await idbGetAll<StaffAccount>(STORES.STAFF_ACCOUNTS);
  let matched = list.find((acc) => acc.userId.trim().toLowerCase() === normId);

  if (!matched) {
    return { ok: false, staff: null, message: `ID "${rawUserId.trim()}" tidak ditemukan.` };
  }
  if (!matched.isActive) {
    return {
      ok: false,
      staff: null,
      message: `Akun dengan ID "${matched.userId}" sedang dinonaktifkan oleh Administrator.`,
    };
  }

  let valid = await verifyPassword(pwd, matched.password);
  if (!valid && normId === 'admin') {
    const profile = await idbGet<SchoolProfile>(STORES.META, 'default');
    if (profile && (await verifyPassword(pwd, profile.adminPassword))) {
      valid = true;
      matched = { ...matched, password: await hashPassword(pwd) };
      await idbPutStaffSafe([matched]);
    }
  }

  if (!valid) {
    return { ok: false, staff: null, message: 'Sandi / PIN tidak sesuai.' };
  }

  // Upgrade legacy plaintext stored hash transparently
  if (!isPasswordHashed(matched.password)) {
    matched = { ...matched, password: await hashPassword(matched.password) };
    await idbPutStaffSafe([matched]);
  }

  setActiveStaffCredentials(matched);
  return { ok: true, staff: matched };
}

// ============================================================================
// PARTICIPANTS & TOKENS
// ============================================================================
export async function getParticipants(): Promise<Participant[]> {
  await ensureInitialized();
  if (participantsSortedCache) return participantsSortedCache;
  const list = await idbGetAll<Participant>(STORES.PARTICIPANTS);
  participantsSortedCache = list.sort(
    (a, b) =>
      a.className.localeCompare(b.className) ||
      a.participantNumber.localeCompare(b.participantNumber)
  );
  return participantsSortedCache;
}

export async function upsertParticipants(items: Participant[]): Promise<void> {
  await ensureInitialized();
  const existing = await idbGetAll<Participant>(STORES.PARTICIPANTS);
  const existingByNumber = new Map<string, Participant>();
  for (const row of existing) {
    existingByNumber.set(row.participantNumber.trim().toUpperCase(), row);
  }

  const normalizedItems: Participant[] = items.map((p) => {
    const cleanNum = p.participantNumber.trim().toUpperCase();
    const matched = existingByNumber.get(cleanNum);
    return {
      ...p,
      id: matched ? matched.id : p.id,
      participantNumber: cleanNum,
    };
  });

  await idbPutParticipantsSafe(normalizedItems);
  broadcastDataChange('participants');

  if (isLiveSupabaseConfigured()) {
    try {
      const supabase = getSupabaseClient();
      const CHUNK = 50;
      for (let i = 0; i < normalizedItems.length; i += CHUNK) {
        const chunk = normalizedItems.slice(i, i + CHUNK);
        await supabase.from('participants').upsert(
          chunk.map((p) => ({
            id: p.id,
            participant_number: p.participantNumber,
            token: p.token,
            full_name: p.fullName,
            class_name: p.className,
            is_active: p.isActive,
            created_at: p.createdAt,
          })),
          { onConflict: 'participant_number' }
        );
      }
    } catch {
      // Local-first persists regardless
    }
  }
}

export async function deleteParticipant(id: string): Promise<void> {
  await ensureInitialized();
  await idbDelete(STORES.PARTICIPANTS, id);
  broadcastDataChange('participants');

  if (isLiveSupabaseConfigured()) {
    try {
      const supabase = getSupabaseClient();
      await supabase.from('participants').delete().eq('id', id);
    } catch {
      // Ignore offline error
    }
  }
}

export async function clearAllParticipants(): Promise<number> {
  await ensureInitialized();
  const existing = await idbGetAll<Participant>(STORES.PARTICIPANTS);
  const count = existing.length;

  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORES.PARTICIPANTS, 'readwrite');
    tx.objectStore(STORES.PARTICIPANTS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  invalidateStoreCache(STORES.PARTICIPANTS);
  broadcastDataChange('participants');

  if (isLiveSupabaseConfigured()) {
    try {
      const supabase = getSupabaseClient();
      const idRes = await fetchAllRowsByIdPaginated<{ id: string }>(
        supabase,
        'participants',
        'id'
      );
      if (!idRes.error && idRes.data.length > 0) {
        const CHUNK = 50;
        const ids = idRes.data.map((r) => String(r.id));
        for (let i = 0; i < ids.length; i += CHUNK) {
          await supabase.from('participants').delete().in('id', ids.slice(i, i + CHUNK));
        }
      } else {
        await supabase.from('participants').delete().not('id', 'is', null);
      }
    } catch {
      // Local delete persists regardless
    }
  }

  return count;
}

export async function validateParticipantAndToken(
  rawNumber: string,
  rawToken: string
): Promise<{
  status: 'ok' | 'not_found' | 'wrong_token';
  participant: Participant | null;
  source: 'supabase' | 'local-cache';
}> {
  await ensureInitialized();
  const normalizedNum = rawNumber.trim().toUpperCase();
  const normalizedToken = rawToken.trim().toUpperCase();
  if (!normalizedNum) {
    return { status: 'not_found', participant: null, source: 'local-cache' };
  }

  let found: Participant | null = null;
  let source: 'supabase' | 'local-cache' = 'local-cache';

  if (isLiveSupabaseConfigured()) {
    try {
      const supabase = getSupabaseClient();
      const { data: rpcData, error: rpcErr } = await supabase.rpc('verify_participant_login', {
        p_participant_number: normalizedNum,
        p_token: normalizedToken,
      });

      if (!rpcErr && Array.isArray(rpcData) && rpcData[0]) {
        const row = rpcData[0] as Record<string, unknown>;
        const rpcStatus = String(row.status || 'not_found');
        if (rpcStatus === 'ok') {
          const verified: Participant = {
            id: String(row.id),
            participantNumber: String(row.participant_number),
            token: String(row.token || ''),
            fullName: String(row.full_name),
            className: String(row.class_name),
            isActive: Boolean(row.is_active),
            createdAt: String(row.created_at),
          };
          await idbPutParticipantsSafe([verified]);
          return { status: 'ok', participant: verified, source: 'supabase' };
        }
        if (rpcStatus === 'wrong_token') {
          return { status: 'wrong_token', participant: null, source: 'supabase' };
        }
        return { status: 'not_found', participant: null, source: 'supabase' };
      }

      // Fallback untuk database lama sebelum skrip RPC verify_participant_login dijalankan
      if (rpcErr) {
        const { data, error } = await fetchSingleParticipantByNumber(supabase, normalizedNum, true);

        if (!error && data) {
          found = {
            id: String(data.id),
            participantNumber: String(data.participant_number),
            token: String(data.token || ''),
            fullName: String(data.full_name),
            className: String(data.class_name),
            isActive: Boolean(data.is_active),
            createdAt: String(data.created_at),
          };
          source = 'supabase';
          await idbPutParticipantsSafe([found]);
        }
      }
    } catch {
      // Fallback to local cache
    }
  }

  if (!found) {
    const all = await idbGetAll<Participant>(STORES.PARTICIPANTS);
    found =
      all.find((p) => p.participantNumber.trim().toUpperCase() === normalizedNum && p.isActive) ||
      null;
  }

  if (!found) {
    return { status: 'not_found', participant: null, source };
  }

  if ((found.token || '').trim().toUpperCase() !== normalizedToken) {
    return { status: 'wrong_token', participant: null, source };
  }

  return { status: 'ok', participant: found, source };
}

// ============================================================================
// EXAM SCHEDULES (MULTI-SUBJECT + KKM) & QUESTIONS
// ============================================================================
export async function getExamSchedules(): Promise<ExamSchedule[]> {
  await ensureInitialized();
  if (schedulesSortedCache) return schedulesSortedCache;
  const list = await idbGetAll<ExamSchedule>(STORES.SCHEDULES);
  schedulesSortedCache = list.sort((a, b) => a.subject.localeCompare(b.subject));
  return schedulesSortedCache;
}

export async function upsertExamSchedule(schedule: ExamSchedule): Promise<CloudSyncWriteResult> {
  await ensureInitialized();
  await idbPut(STORES.SCHEDULES, schedule);
  broadcastDataChange('schedules');

  if (!isLiveSupabaseConfigured()) {
    return { synced: false };
  }

  try {
    const client = getSupabaseAdminClient() || getSupabaseClient();
    const { error } = await client.from('exam_schedules').upsert({
      id: schedule.id,
      title: schedule.title,
      subject: schedule.subject,
      kkm: schedule.kkm,
      duration_minutes: schedule.durationMinutes,
      target_classes: schedule.targetClasses,
      is_active: schedule.isActive,
      randomize_questions: Boolean(schedule.randomizeQuestions ?? false),
      max_tab_switches: schedule.maxTabSwitches,
      created_at: schedule.createdAt,
    });
    if (error) {
      return { synced: false, error: error.message };
    }
    return { synced: true };
  } catch (err) {
    return {
      synced: false,
      error: err instanceof Error ? err.message : 'Gagal terhubung ke Supabase',
    };
  }
}

export async function deleteExamSchedule(id: string): Promise<CloudSyncWriteResult> {
  await ensureInitialized();
  await idbDelete(STORES.SCHEDULES, id);
  broadcastDataChange('schedules');

  if (!isLiveSupabaseConfigured()) {
    return { synced: false };
  }

  try {
    const client = getSupabaseAdminClient() || getSupabaseClient();
    const { error } = await client.from('exam_schedules').delete().eq('id', id);
    if (error) {
      return { synced: false, error: error.message };
    }
    return { synced: true };
  } catch (err) {
    return {
      synced: false,
      error: err instanceof Error ? err.message : 'Gagal terhubung ke Supabase',
    };
  }
}

export async function clearAllSchedules(allowedSubjects?: string[]): Promise<number> {
  await ensureInitialized();
  const all = await idbGetAll<ExamSchedule>(STORES.SCHEDULES);
  const hasRestriction = Boolean(allowedSubjects && allowedSubjects.length > 0);
  const normalizedAllowed = new Set(
    (allowedSubjects || []).map((s) => s.trim().toLowerCase())
  );
  const targetIds = hasRestriction
    ? all
        .filter((s) => normalizedAllowed.has(s.subject.trim().toLowerCase()))
        .map((s) => s.id)
    : all.map((s) => s.id);

  if (targetIds.length === 0) return 0;

  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORES.SCHEDULES, 'readwrite');
    const store = tx.objectStore(STORES.SCHEDULES);
    if (!hasRestriction) {
      store.clear();
    } else {
      for (const id of targetIds) {
        store.delete(id);
      }
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  invalidateStoreCache(STORES.SCHEDULES);
  broadcastDataChange('schedules');

  if (isLiveSupabaseConfigured()) {
    try {
      const client = getSupabaseAdminClient() || getSupabaseClient();
      if (!hasRestriction) {
        await client.from('exam_schedules').delete().not('id', 'is', null);
      } else {
        const CHUNK = 50;
        for (let i = 0; i < targetIds.length; i += CHUNK) {
          await client.from('exam_schedules').delete().in('id', targetIds.slice(i, i + CHUNK));
        }
      }
    } catch {
      // Local delete persists regardless
    }
  }

  return targetIds.length;
}

export async function getAdminQuestions(): Promise<Question[]> {
  await ensureInitialized();
  if (questionsSortedCache) return questionsSortedCache;
  const list = await idbGetAll<Question>(STORES.QUESTIONS);
  questionsSortedCache = list.sort(
    (a, b) =>
      a.subject.localeCompare(b.subject) ||
      a.orderIndex - b.orderIndex ||
      a.id.localeCompare(b.id)
  );
  return questionsSortedCache;
}

/**
 * Menarik langsung seluruh jadwal mapel & bank soal dari database Supabase
 * (menggunakan Service Role Key agar menembus RLS anti-cheat pada role Admin & Proktor).
 */
export async function syncAdminQuestionsFromCloud(options?: {
  force?: boolean;
}): Promise<AdminCloudSyncResult> {
  await ensureInitialized();
  const hasServiceRoleKey = hasSupabaseServiceRoleKey();

  if (!isLiveSupabaseConfigured()) {
    const [localSchedules, localQuestions] = await Promise.all([
      idbGetAll<ExamSchedule>(STORES.SCHEDULES),
      idbGetAll<Question>(STORES.QUESTIONS),
    ]);
    return {
      ok: true,
      syncedFromCloud: false,
      hasServiceRoleKey,
      questionCount: localQuestions.length,
      scheduleCount: localSchedules.length,
    };
  }

  const adminClient = getSupabaseAdminClient();
  const supabase = getSupabaseClient();
  const readClient = adminClient || supabase;

  try {
    const [profRes, schedFetch] = await Promise.all([
      readClient.from('school_profile').select('id').eq('id', 'default').maybeSingle(),
      fetchAllRowsByIdPaginated(readClient, 'exam_schedules'),
    ]);

    const hasCloudProfile = Boolean(!profRes.error && profRes.data);
    let scheduleCount = 0;

    if (!schedFetch.error) {
      const cloudSchedules: ExamSchedule[] = schedFetch.data
        .map((r) => ({
          id: r.id,
          title: r.title,
          subject: r.subject,
          kkm: Number(r.kkm ?? 75),
          durationMinutes: r.duration_minutes,
          targetClasses: Array.isArray(r.target_classes) ? r.target_classes : [],
          isActive: Boolean(r.is_active),
          randomizeQuestions: Boolean(r.randomize_questions ?? false),
          maxTabSwitches: Number(r.max_tab_switches ?? 3),
          createdAt: r.created_at,
        }))
        .sort((a, b) => a.subject.localeCompare(b.subject));

      if (cloudSchedules.length > 0 || hasCloudProfile) {
        await idbPutMany(STORES.SCHEDULES, cloudSchedules, true);
      }
      scheduleCount = cloudSchedules.length;
    } else {
      const localSchedules = await idbGetAll<ExamSchedule>(STORES.SCHEDULES);
      scheduleCount = localSchedules.length;
    }

    if (!adminClient) {
      const localQuestions = await idbGetAll<Question>(STORES.QUESTIONS);
      broadcastDataChange('schedules_admin_sync');
      return {
        ok: true,
        syncedFromCloud: false,
        hasServiceRoleKey: false,
        questionCount: localQuestions.length,
        scheduleCount,
      };
    }

    const localQuestions = await idbGetAll<Question>(STORES.QUESTIONS);
    let checkMeta: QuestionsCloudMeta | null = null;
    if (!options?.force) {
      const check = await shouldDownloadAllQuestions(adminClient, localQuestions.length);
      checkMeta = check.meta;
      if (!check.shouldFetch) {
        broadcastDataChange('schedules_admin_sync');
        return {
          ok: true,
          syncedFromCloud: true,
          hasServiceRoleKey: true,
          questionCount: localQuestions.length,
          scheduleCount,
        };
      }
    }

    const qFetch = await fetchAllQuestionsFromSupabaseAdmin(adminClient);
    if (qFetch.error) {
      broadcastDataChange('schedules_admin_sync');
      return {
        ok: false,
        syncedFromCloud: false,
        hasServiceRoleKey: true,
        questionCount: localQuestions.length,
        scheduleCount,
        error: qFetch.error,
      };
    }

    await idbPutMany(STORES.QUESTIONS, qFetch.questions, true);
    lastQuestionsCloudMeta = checkMeta || {
      totalCount: qFetch.questions.length,
      maxUpdatedAt: null,
    };
    broadcastDataChange('questions_admin_sync');

    return {
      ok: true,
      syncedFromCloud: true,
      hasServiceRoleKey: true,
      questionCount: qFetch.questions.length,
      scheduleCount,
    };
  } catch (err) {
    const localQuestions = await idbGetAll<Question>(STORES.QUESTIONS);
    const localSchedules = await idbGetAll<ExamSchedule>(STORES.SCHEDULES);
    return {
      ok: false,
      syncedFromCloud: false,
      hasServiceRoleKey,
      questionCount: localQuestions.length,
      scheduleCount: localSchedules.length,
      error: err instanceof Error ? err.message : 'Gagal terhubung ke database Supabase',
    };
  }
}

export async function upsertQuestions(items: Question[]): Promise<CloudSyncWriteResult> {
  await ensureInitialized();
  lastQuestionsCloudMeta = null;
  await idbPutMany(STORES.QUESTIONS, items);
  broadcastDataChange('questions');

  if (!isLiveSupabaseConfigured()) {
    return { synced: false };
  }

  try {
    const adminClient = getSupabaseAdminClient();
    const supabase = getSupabaseClient();
    const CHUNK = 50;

    if (adminClient) {
      for (let i = 0; i < items.length; i += CHUNK) {
        const chunk = items.slice(i, i + CHUNK);
        const extendedPayload = chunk.map((q) => buildQuestionDbRow(q, true));
        let { error } = await adminClient
          .from('questions')
          .upsert(extendedPayload, { onConflict: 'id' });
        if (error && isMissingQuestionColumnsError(error.message)) {
          const legacyPayload = chunk.map((q) => buildQuestionDbRow(q, false));
          const retry = await adminClient
            .from('questions')
            .upsert(legacyPayload, { onConflict: 'id' });
          error = retry.error;
        }
        if (error) {
          return { synced: false, error: error.message };
        }
      }
      return { synced: true };
    }

    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK);
      const extendedPayload = chunk.map((q) => buildQuestionDbRow(q, true));
      let { error: rpcError } = await supabase.rpc('upsert_questions_batch', {
        p_questions: extendedPayload,
        ...getStaffRpcAuthArgs(),
      });
      if (rpcError && isRpcSignatureMismatchError(rpcError.message)) {
        const legacyRpc = await supabase.rpc('upsert_questions_batch', {
          p_questions: extendedPayload,
        });
        rpcError = legacyRpc.error;
      }
      if (rpcError && isMissingQuestionColumnsError(rpcError.message)) {
        const legacyPayload = chunk.map((q) => buildQuestionDbRow(q, false));
        const retry = await supabase.rpc('upsert_questions_batch', {
          p_questions: legacyPayload,
          ...getStaffRpcAuthArgs(),
        });
        rpcError = retry.error;
        if (rpcError && isRpcSignatureMismatchError(rpcError.message)) {
          const retryLegacy = await supabase.rpc('upsert_questions_batch', {
            p_questions: legacyPayload,
          });
          rpcError = retryLegacy.error;
        }
      }
      if (rpcError) {
        return { synced: false, error: rpcError.message };
      }
    }
    return { synced: true };
  } catch (err) {
    return {
      synced: false,
      error: err instanceof Error ? err.message : 'Gagal menyimpan soal ke database Supabase',
    };
  }
}

export async function deleteQuestion(id: string): Promise<CloudSyncWriteResult> {
  await ensureInitialized();
  lastQuestionsCloudMeta = null;
  await idbDelete(STORES.QUESTIONS, id);
  broadcastDataChange('questions');

  if (!isLiveSupabaseConfigured()) {
    return { synced: false };
  }

  try {
    const adminClient = getSupabaseAdminClient();
    const supabase = getSupabaseClient();
    if (adminClient) {
      const { error } = await adminClient.from('questions').delete().eq('id', id);
      if (error) {
        return { synced: false, error: error.message };
      }
      return { synced: true };
    }

    let { error: rpcError } = await supabase.rpc('delete_question_by_id', {
      p_id: id,
      ...getStaffRpcAuthArgs(),
    });
    if (rpcError && isRpcSignatureMismatchError(rpcError.message)) {
      const legacy = await supabase.rpc('delete_question_by_id', { p_id: id });
      rpcError = legacy.error;
    }
    if (rpcError) {
      return { synced: false, error: rpcError.message };
    }
    return { synced: true };
  } catch (err) {
    return {
      synced: false,
      error: err instanceof Error ? err.message : 'Gagal menghapus soal di database Supabase',
    };
  }
}

export async function deleteQuestionsBatch(ids: string[]): Promise<number> {
  await ensureInitialized();
  if (ids.length === 0) return 0;
  lastQuestionsCloudMeta = null;

  const uniqueIds = Array.from(new Set(ids));
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORES.QUESTIONS, 'readwrite');
    const store = tx.objectStore(STORES.QUESTIONS);
    for (const id of uniqueIds) {
      store.delete(id);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  invalidateStoreCache(STORES.QUESTIONS);
  broadcastDataChange('questions');

  if (isLiveSupabaseConfigured()) {
    try {
      const adminClient = getSupabaseAdminClient();
      const supabase = getSupabaseClient();
      if (adminClient) {
        const CHUNK = 50;
        for (let i = 0; i < uniqueIds.length; i += CHUNK) {
          await adminClient.from('questions').delete().in('id', uniqueIds.slice(i, i + CHUNK));
        }
      } else {
        const CHUNK = 20;
        for (let i = 0; i < uniqueIds.length; i += CHUNK) {
          await Promise.all(
            uniqueIds.slice(i, i + CHUNK).map(async (id) => {
              const res = await supabase.rpc('delete_question_by_id', {
                p_id: id,
                ...getStaffRpcAuthArgs(),
              });
              if (res.error && isRpcSignatureMismatchError(res.error.message)) {
                await supabase.rpc('delete_question_by_id', { p_id: id });
              }
            })
          );
        }
      }
    } catch {
      // Local delete persists regardless
    }
  }

  return uniqueIds.length;
}

export async function clearAllQuestions(allowedSubjects?: string[]): Promise<number> {
  await ensureInitialized();
  lastQuestionsCloudMeta = null;
  const all = await idbGetAll<Question>(STORES.QUESTIONS);
  const hasRestriction = Boolean(allowedSubjects && allowedSubjects.length > 0);
  const normalizedAllowed = new Set(
    (allowedSubjects || []).map((s) => s.trim().toLowerCase())
  );

  if (hasRestriction) {
    const targetIds = all
      .filter((q) => normalizedAllowed.has(q.subject.trim().toLowerCase()))
      .map((q) => q.id);
    return deleteQuestionsBatch(targetIds);
  }

  const count = all.length;
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORES.QUESTIONS, 'readwrite');
    tx.objectStore(STORES.QUESTIONS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  invalidateStoreCache(STORES.QUESTIONS);
  broadcastDataChange('questions');

  if (isLiveSupabaseConfigured()) {
    try {
      const adminClient = getSupabaseAdminClient();
      const supabase = getSupabaseClient();
      if (adminClient) {
        await adminClient.from('questions').delete().not('id', 'is', null);
      } else {
        const allIds = all.map((q) => q.id);
        const CHUNK = 20;
        for (let i = 0; i < allIds.length; i += CHUNK) {
          await Promise.all(
            allIds.slice(i, i + CHUNK).map(async (id) => {
              const res = await supabase.rpc('delete_question_by_id', {
                p_id: id,
                ...getStaffRpcAuthArgs(),
              });
              if (res.error && isRpcSignatureMismatchError(res.error.message)) {
                await supabase.rpc('delete_question_by_id', { p_id: id });
              }
            })
          );
        }
      }
    } catch {
      // Local delete persists regardless
    }
  }

  return count;
}

/**
 * Fetch sanitized questions for a student's class & chosen subject.
 * Never returns `correctAnswer` to prevent Inspect Element cheating.
 */
export async function getStudentQuestionsForClass(
  className: string,
  subject?: string
): Promise<StudentQuestion[]> {
  await ensureInitialized();

  let rpcHadFailure = false;

  if (isLiveSupabaseConfigured()) {
    const supabase = getSupabaseClient();
    const retryDelays = [0, 250, 600];

    for (let attempt = 0; attempt < retryDelays.length; attempt++) {
      if (retryDelays[attempt] > 0) {
        await new Promise((r) => setTimeout(r, retryDelays[attempt]));
      }
      try {
        const { data, error } = await supabase.rpc('get_student_questions', {
          p_class_name: className,
          p_subject: subject || null,
        });
        if (!error && Array.isArray(data)) {
          if (data.length > 0) {
            return data.map((q) => hydrateStudentQuestionFromDbRow(q));
          }
          rpcHadFailure = false;
          break;
        }
        rpcHadFailure = true;
      } catch {
        rpcHadFailure = true;
      }
    }
  }

  const all = await idbGetAll<Question>(STORES.QUESTIONS);
  const localFiltered = all
    .filter(
      (q) =>
        q.targetClasses.includes(className) &&
        (!subject || q.subject.toLowerCase() === subject.toLowerCase())
    )
    .sort((a, b) => a.orderIndex - b.orderIndex || a.id.localeCompare(b.id))
    .map((q) => sanitizeQuestionForStudent(q));

  if (localFiltered.length > 0) {
    return localFiltered;
  }

  if (rpcHadFailure && isLiveSupabaseConfigured()) {
    throw new Error(
      'Server bank soal sedang sibuk memuat data. Silakan tekan tombol Mulai Ujian kembali beberapa detik lagi.'
    );
  }

  return localFiltered;
}

export interface CloudQuestionCoverageItem {
  id: string;
  subject: string;
  targetClasses: string[];
}

export interface CloudQuestionCoveragePayload {
  source: 'supabase' | 'local';
  schedules: ExamSchedule[];
  questions: CloudQuestionCoverageItem[];
  participantClasses: string[];
  fetchedAt: string;
  methodUsed: 'admin_table' | 'rpc_summary' | 'rpc_per_class' | 'local_cache';
  error?: string;
}

/**
 * Mengambil data pemetaan soal seluruh mata pelajaran & kelas langsung dari Supabase
 * agar setiap role (Admin, Proktor, dll) pada perangkat mana pun melihat hasil yang sama.
 */
export async function fetchQuestionCoverageFromCloud(
  existingParticipantClasses?: string[]
): Promise<CloudQuestionCoveragePayload> {
  await ensureInitialized();
  const fetchedAt = new Date().toISOString();

  const buildLocalFallback = async (error?: string): Promise<CloudQuestionCoveragePayload> => {
    const [localSchedules, localQuestions, localParticipants] = await Promise.all([
      idbGetAll<ExamSchedule>(STORES.SCHEDULES),
      idbGetAll<Question>(STORES.QUESTIONS),
      idbGetAll<Participant>(STORES.PARTICIPANTS),
    ]);
    const participantClasses = Array.from(
      new Set(
        localParticipants
          .map((p) => (p.className || '').trim().toUpperCase())
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b, 'id'));

    return {
      source: 'local',
      schedules: localSchedules.sort((a, b) => a.subject.localeCompare(b.subject)),
      questions: localQuestions.map((q) => ({
        id: q.id,
        subject: q.subject,
        targetClasses: q.targetClasses || [],
      })),
      participantClasses,
      fetchedAt,
      methodUsed: 'local_cache',
      error,
    };
  };

  if (!isLiveSupabaseConfigured()) {
    return buildLocalFallback();
  }

  try {
    const supabase = getSupabaseClient();
    const adminClient = getSupabaseAdminClient();
    const hasPreloadedParticipantClasses = Boolean(
      existingParticipantClasses && existingParticipantClasses.length > 0
    );

    // 1. Fetch exam_schedules & only fetch participants' class_name if not already loaded in Admin state
    const [schedFetch, partClasses] = await Promise.all([
      fetchAllRowsByIdPaginated(supabase, 'exam_schedules'),
      hasPreloadedParticipantClasses
        ? Promise.resolve(
            Array.from(
              new Set(
                (existingParticipantClasses || [])
                  .map((c) => c.trim().toUpperCase())
                  .filter(Boolean)
              )
            ).sort((a, b) => a.localeCompare(b, 'id'))
          )
        : (async () => {
            const collected = new Set<string>();
            const pageSize = 1000;
            for (let from = 0; from < 20_000; from += pageSize) {
              const { data, error } = await supabase
                .from('participants')
                .select('class_name')
                .range(from, from + pageSize - 1);
              if (error) {
                throw new Error(`Gagal membaca daftar kelas peserta dari Supabase: ${error.message}`);
              }
              if (!Array.isArray(data) || data.length === 0) break;
              for (const row of data) {
                const cls = String((row as { class_name?: string }).class_name || '')
                  .trim()
                  .toUpperCase();
                if (cls) collected.add(cls);
              }
              if (data.length < pageSize) break;
            }
            return Array.from(collected).sort((a, b) => a.localeCompare(b, 'id'));
          })(),
    ]);

    if (schedFetch.error) {
      return buildLocalFallback(`Gagal membaca jadwal mapel dari Supabase: ${schedFetch.error}`);
    }

    const cloudSchedules: ExamSchedule[] = schedFetch.data
      .map((r) => ({
        id: r.id,
        title: r.title,
        subject: r.subject,
        kkm: Number(r.kkm ?? 75),
        durationMinutes: r.duration_minutes,
        targetClasses: Array.isArray(r.target_classes) ? r.target_classes : [],
        isActive: Boolean(r.is_active),
        randomizeQuestions: Boolean(r.randomize_questions ?? false),
        maxTabSwitches: Number(r.max_tab_switches ?? 3),
        createdAt: r.created_at,
      }))
      .sort((a, b) => a.subject.localeCompare(b.subject));

    // Sync cloud schedules into local IDB silently so schedules stay aligned too
    if (cloudSchedules.length > 0) {
      await idbPutMany(STORES.SCHEDULES, cloudSchedules, true);
    }

    // 2. Fetch questions coverage directly from Supabase public.questions
    // Path A: Admin client (jika Service Role Key tersedia di sesi)
    if (adminClient) {
      const collected: CloudQuestionCoverageItem[] = [];
      const pageSize = 1000;
      let adminFailed: string | null = null;
      for (let from = 0; from < 50_000; from += pageSize) {
        const { data, error } = await adminClient
          .from('questions')
          .select('id, subject, target_classes')
          .order('id', { ascending: true })
          .range(from, from + pageSize - 1);
        if (error) {
          adminFailed = error.message;
          break;
        }
        if (!Array.isArray(data) || data.length === 0) break;
        for (const q of data) {
          collected.push({
            id: String(q.id),
            subject: String(q.subject || ''),
            targetClasses: Array.isArray(q.target_classes) ? q.target_classes : [],
          });
        }
        if (data.length < pageSize) break;
      }
      if (!adminFailed) {
        return {
          source: 'supabase',
          schedules: cloudSchedules,
          questions: collected,
          participantClasses: partClasses,
          fetchedAt,
          methodUsed: 'admin_table',
        };
      }
    }

    // Path B: RPC get_question_coverage_summary (ringan, aman tanpa kunci jawaban)
    const summaryItems: CloudQuestionCoverageItem[] = [];
    let summaryMissingOrError: string | null = null;
    const summaryPageSize = 1000;
    for (let from = 0; from < 50_000; from += summaryPageSize) {
      let { data, error } = await supabase
        .rpc('get_question_coverage_summary', getStaffRpcAuthArgs())
        .range(from, from + summaryPageSize - 1);
      if (error && isRpcSignatureMismatchError(error.message)) {
        const legacy = await supabase
          .rpc('get_question_coverage_summary')
          .range(from, from + summaryPageSize - 1);
        data = legacy.data;
        error = legacy.error;
      }
      if (error) {
        summaryMissingOrError = error.message;
        break;
      }
      if (!Array.isArray(data) || data.length === 0) break;
      for (const q of data as Array<{ id: string; subject: string; target_classes: string[] }>) {
        summaryItems.push({
          id: String(q.id),
          subject: String(q.subject || ''),
          targetClasses: Array.isArray(q.target_classes) ? q.target_classes : [],
        });
      }
      if (data.length < summaryPageSize) break;
    }

    if (!summaryMissingOrError) {
      return {
        source: 'supabase',
        schedules: cloudSchedules,
        questions: summaryItems,
        participantClasses: partClasses,
        fetchedAt,
        methodUsed: 'rpc_summary',
      };
    }

    // Path C: Fallback kompatibel langsung untuk database yang sudah terpasang get_student_questions
    const classPool = new Set<string>(ALL_CLASSES);
    partClasses.forEach((cls) => classPool.add(cls));
    cloudSchedules.forEach((s) =>
      s.targetClasses.forEach((c) => {
        const clean = (c || '').trim().toUpperCase();
        if (clean) classPool.add(clean);
      })
    );
    const classesToQuery = Array.from(classPool);
    const deduped = new Map<string, CloudQuestionCoverageItem>();

    const BATCH_SIZE = 9;
    for (let i = 0; i < classesToQuery.length; i += BATCH_SIZE) {
      const batch = classesToQuery.slice(i, i + BATCH_SIZE);
      const responses = await Promise.all(
        batch.map((cls) =>
          supabase.rpc('get_student_questions', {
            p_class_name: cls,
            p_subject: null,
          })
        )
      );
      for (const res of responses) {
        if (res.error) {
          return buildLocalFallback(
            `Gagal membaca pemetaan soal dari Supabase (${res.error.message}).`
          );
        }
        if (Array.isArray(res.data)) {
          for (const q of res.data as Array<{
            id: string;
            subject: string;
            target_classes: string[];
          }>) {
            if (!deduped.has(q.id)) {
              deduped.set(q.id, {
                id: String(q.id),
                subject: String(q.subject || ''),
                targetClasses: Array.isArray(q.target_classes) ? q.target_classes : [],
              });
            }
          }
        }
      }
    }

    return {
      source: 'supabase',
      schedules: cloudSchedules,
      questions: Array.from(deduped.values()),
      participantClasses: partClasses,
      fetchedAt,
      methodUsed: 'rpc_per_class',
    };
  } catch (err) {
    return buildLocalFallback(
      err instanceof Error ? err.message : 'Gagal terhubung ke database Supabase.'
    );
  }
}

// ============================================================================
// ACTIVE EXAM SESSION & BACKGROUND SYNC TO SUPABASE `exam_results`
// ============================================================================
export function getSavedActiveSession(): ActiveExamSession | null {
  if (cachedActiveSession) return cachedActiveSession;
  try {
    const raw = localStorage.getItem(ACTIVE_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ActiveExamSession>;
    if (parsed && Array.isArray(parsed.questions) && parsed.participant && parsed.schedule) {
      cachedActiveSession = parsed as ActiveExamSession;
      return cachedActiveSession;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveActiveSessionLocal(session: ActiveExamSession): void {
  cachedActiveSession = session;
  try {
    localStorage.setItem(
      ACTIVE_SESSION_KEY,
      JSON.stringify({
        resultId: session.resultId,
        participantNumber: session.participant.participantNumber,
        examId: session.schedule.id,
        startedAt: session.startedAt,
        endsAt: session.endsAt,
      })
    );
  } catch {
    // Ignore localStorage quota restrictions; full session persists in IndexedDB
  }
  void idbPut(STORES.ACTIVE_SESSION, { id: 'current', session }).catch(() => {});
}

export function clearActiveSessionLocal(): void {
  cachedActiveSession = null;
  try {
    localStorage.removeItem(ACTIVE_SESSION_KEY);
  } catch {
    // Ignore localStorage restrictions
  }
  void idbDelete(STORES.ACTIVE_SESSION, 'current').catch(() => {});
}

export async function getExamResults(): Promise<ExamResult[]> {
  await ensureInitialized();
  if (resultsSortedCache) return resultsSortedCache;
  const list = await idbGetAll<ExamResult>(STORES.RESULTS);
  resultsSortedCache = list.sort((a, b) =>
    (b.submittedAt || b.startedAt).localeCompare(a.submittedAt || a.startedAt)
  );
  return resultsSortedCache;
}

export async function checkStudentExamLock(
  participantNumber: string,
  schedule: ExamSchedule
): Promise<{
  locked: boolean;
  reason: 'in_progress' | 'flagged' | 'submitted' | 'network_error' | null;
  result: ExamResult | null;
  errorMessage?: string;
}> {
  await ensureInitialized();
  const normNum = participantNumber.trim().toUpperCase();

  let matched: ExamResult | null = null;
  let checkedRemote = false;

  if (isLiveSupabaseConfigured()) {
    await syncServerClock();
    try {
      const supabase = getSupabaseClient();
      const { data: remoteMatch, error } = await fetchSingleExamResult(
        supabase,
        normNum,
        schedule.id,
        EXAM_RESULTS_ADMIN_COLUMNS
      );

      if (error) {
        return {
          locked: true,
          reason: 'network_error',
          result: null,
          errorMessage: `Gagal memverifikasi status ujian ke server: ${error.message}. Periksa koneksi lalu coba lagi.`,
        };
      }

      checkedRemote = true;
      if (remoteMatch) {
        matched = mapDbExamResultRow(remoteMatch);
        await idbPut(STORES.RESULTS, matched);
      }
    } catch {
      return {
        locked: true,
        reason: 'network_error',
        result: null,
        errorMessage:
          'Koneksi ke server terputus saat memeriksa status ujian. Silakan coba lagi beberapa detik lagi.',
      };
    }
  }

  if (!matched && !checkedRemote) {
    const localList = await idbGetAll<ExamResult>(STORES.RESULTS);
    matched =
      localList.find(
        (r) =>
          r.participantNumber.trim().toUpperCase() === normNum && r.examId === schedule.id
      ) || null;
  }

  if (!matched) {
    return { locked: false, reason: null, result: null };
  }

  if (matched.status === 'in_progress') {
    const startedMs = new Date(matched.startedAt).getTime();
    const durationMs = Math.max(1, schedule.durationMinutes) * 60 * 1000;
    if (
      Number.isFinite(startedMs) &&
      getServerNowMs() >= startedMs + durationMs + EXPIRY_GRACE_MS
    ) {
      matched = await finalizeExamResultRecord(matched, {
        maxTabSwitches: schedule.maxTabSwitches,
        skipIfFinalized: true,
        broadcast: true,
      });
    }
  }

  return {
    locked: true,
    reason: matched.status,
    result: matched,
  };
}

export async function verifyStudentCanStartExam(
  participantNumber: string,
  scheduleId: string
): Promise<{
  ok: boolean;
  participant?: Participant;
  schedule?: ExamSchedule;
  message?: string;
}> {
  await ensureInitialized();
  const normNum = participantNumber.trim().toUpperCase();

  if (isLiveSupabaseConfigured()) {
    try {
      const supabase = getSupabaseClient();
      const [pRes, sRes] = await Promise.all([
        fetchSingleParticipantByNumber(supabase, normNum, false),
        supabase.from('exam_schedules').select('*').eq('id', scheduleId).maybeSingle(),
      ]);

      if (pRes.error || sRes.error) {
        return {
          ok: false,
          message: 'Gagal memverifikasi status peserta/jadwal ke server. Coba lagi.',
        };
      }
      if (!pRes.data || !pRes.data.is_active) {
        return {
          ok: false,
          message: 'Akun peserta Anda sedang dinonaktifkan atau dihapus oleh Panitia.',
        };
      }
      if (!sRes.data || !sRes.data.is_active) {
        return {
          ok: false,
          message: 'Jadwal ujian ini sudah ditutup atau dinonaktifkan oleh Panitia.',
        };
      }

      const freshParticipant: Participant = {
        id: String(pRes.data.id),
        participantNumber: String(pRes.data.participant_number),
        token: String(pRes.data.token || 'CBT2026'),
        fullName: String(pRes.data.full_name),
        className: String(pRes.data.class_name),
        isActive: Boolean(pRes.data.is_active),
        createdAt: String(pRes.data.created_at),
      };
      const freshSchedule: ExamSchedule = {
        id: sRes.data.id,
        title: sRes.data.title,
        subject: sRes.data.subject,
        kkm: Number(sRes.data.kkm ?? 75),
        durationMinutes: sRes.data.duration_minutes,
        targetClasses: sRes.data.target_classes,
        isActive: Boolean(sRes.data.is_active),
        randomizeQuestions: Boolean(sRes.data.randomize_questions ?? false),
        maxTabSwitches: sRes.data.max_tab_switches,
        createdAt: sRes.data.created_at,
      };

      if (!freshSchedule.targetClasses.includes(freshParticipant.className)) {
        return {
          ok: false,
          message: `Kelas ${freshParticipant.className} tidak terdaftar pada jadwal ujian ini.`,
        };
      }

      await idbPutParticipantsSafe([freshParticipant]);
      await idbPut(STORES.SCHEDULES, freshSchedule);

      return { ok: true, participant: freshParticipant, schedule: freshSchedule };
    } catch {
      return {
        ok: false,
        message: 'Koneksi ke server terputus saat memverifikasi jadwal ujian.',
      };
    }
  }

  const [parts, scheds] = await Promise.all([
    idbGetAll<Participant>(STORES.PARTICIPANTS),
    idbGetAll<ExamSchedule>(STORES.SCHEDULES),
  ]);
  const participant = parts.find(
    (p) => p.participantNumber.trim().toUpperCase() === normNum && p.isActive
  );
  const schedule = scheds.find((s) => s.id === scheduleId && s.isActive);

  if (!participant) {
    return { ok: false, message: 'Akun peserta tidak aktif atau tidak ditemukan.' };
  }
  if (!schedule) {
    return { ok: false, message: 'Jadwal ujian tidak aktif atau telah ditutup.' };
  }
  if (!schedule.targetClasses.includes(participant.className)) {
    return { ok: false, message: 'Kelas Anda tidak termasuk sasaran jadwal ujian ini.' };
  }

  return { ok: true, participant, schedule };
}

export async function checkLiveSessionStatusFromCloud(
  participantNumber: string,
  examId: string
): Promise<{
  status: 'ok' | 'finalized' | 'reset_deleted' | 'offline';
  result?: ExamResult;
}> {
  if (!isLiveSupabaseConfigured()) {
    return { status: 'offline' };
  }
  try {
    const supabase = getSupabaseClient();
    const { data: statusRow, error } = await fetchSingleExamResult(
      supabase,
      participantNumber,
      examId,
      EXAM_RESULTS_LIVE_STATUS_COLUMNS
    );

    if (error) return { status: 'offline' };
    if (!statusRow) {
      return { status: 'reset_deleted' };
    }
    const rowStatus = String(statusRow.status || 'in_progress');
    if (rowStatus === 'submitted' || rowStatus === 'flagged') {
      const { data: fullRow, error: fullErr } = await supabase
        .from('exam_results')
        .select(EXAM_RESULTS_ADMIN_COLUMNS)
        .eq('id', String(statusRow.id))
        .maybeSingle();

      if (!fullErr && fullRow) {
        const mapped = mapDbExamResultRow(fullRow as unknown as Record<string, unknown>);
        await idbPut(STORES.RESULTS, mapped);
        return { status: 'finalized', result: mapped };
      }
      return { status: 'offline' };
    }
    return { status: 'ok' };
  } catch {
    return { status: 'offline' };
  }
}

const DASHBOARD_HIDDEN_LOGS_META_ID = 'dashboard_hidden_logs';

interface HiddenDashboardLogsRecord {
  id: string;
  entries: Record<string, string>;
}

export async function getHiddenDashboardLogs(): Promise<Record<string, string>> {
  await ensureInitialized();
  const rec = await idbGet<HiddenDashboardLogsRecord>(
    STORES.META,
    DASHBOARD_HIDDEN_LOGS_META_ID
  );
  return rec?.entries || {};
}

export async function hideDashboardExamLogs(
  items: Array<{ id: string; startedAt: string }>
): Promise<number> {
  await ensureInitialized();
  if (items.length === 0) return 0;
  const current = await getHiddenDashboardLogs();
  const next = { ...current };
  for (const item of items) {
    next[item.id] = item.startedAt || 'hidden';
  }
  await idbPut<HiddenDashboardLogsRecord>(STORES.META, {
    id: DASHBOARD_HIDDEN_LOGS_META_ID,
    entries: next,
  });
  broadcastDataChange('dashboard_logs');
  return items.length;
}

export async function clearAllDashboardExamLogs(): Promise<number> {
  await ensureInitialized();
  const allResults = await idbGetAll<ExamResult>(STORES.RESULTS);
  const current = await getHiddenDashboardLogs();
  const next = { ...current };
  let count = 0;
  for (const r of allResults) {
    if (next[r.id] !== r.startedAt) {
      count += 1;
    }
    next[r.id] = r.startedAt || 'hidden';
  }
  await idbPut<HiddenDashboardLogsRecord>(STORES.META, {
    id: DASHBOARD_HIDDEN_LOGS_META_ID,
    entries: next,
  });
  broadcastDataChange('dashboard_logs');
  return count || allResults.length;
}

async function unhideDashboardLogsByIds(resultIds: string[]): Promise<void> {
  if (resultIds.length === 0) return;
  const rec = await idbGet<HiddenDashboardLogsRecord>(
    STORES.META,
    DASHBOARD_HIDDEN_LOGS_META_ID
  );
  if (!rec?.entries) return;
  const next = { ...rec.entries };
  let changed = false;
  for (const id of resultIds) {
    if (id in next) {
      delete next[id];
      changed = true;
    }
  }
  if (changed) {
    await idbPut<HiddenDashboardLogsRecord>(STORES.META, {
      id: DASHBOARD_HIDDEN_LOGS_META_ID,
      entries: next,
    });
  }
}

export async function resetStudentExamResult(resultId: string): Promise<void> {
  await ensureInitialized();
  const existing = await idbGet<ExamResult>(STORES.RESULTS, resultId);
  const normNum = existing?.participantNumber.trim().toUpperCase() || '';
  for (const key of confirmedQuestionIdsSyncSet) {
    if (
      key.startsWith(`${resultId}::`) ||
      (normNum && existing && key.endsWith(`::${normNum}::${existing.examId}`))
    ) {
      confirmedQuestionIdsSyncSet.delete(key);
    }
  }

  await idbDelete(STORES.RESULTS, resultId);
  await unhideDashboardLogsByIds([resultId]);

  const savedSession = getSavedActiveSession();
  if (
    savedSession &&
    (savedSession.resultId === resultId ||
      (existing &&
        savedSession.participant.participantNumber.trim().toUpperCase() === normNum &&
        savedSession.schedule.id === existing.examId))
  ) {
    clearActiveSessionLocal();
  }

  if (isLiveSupabaseConfigured()) {
    try {
      const adminClient = getSupabaseAdminClient();
      const supabase = getSupabaseClient();
      if (adminClient) {
        await adminClient.from('exam_results').delete().eq('id', resultId);
        if (normNum && existing) {
          await adminClient
            .from('exam_results')
            .delete()
            .ilike('participant_number', escapeLikePattern(normNum))
            .eq('exam_id', existing.examId);
        }
      } else {
        const { error: rpcErr } = await supabase.rpc('staff_delete_exam_results', {
          ...getStaffRpcAuthArgs(),
          p_result_ids: [resultId],
          p_participant_number: normNum || null,
          p_exam_id: existing?.examId || null,
        });
        if (rpcErr && isRpcSignatureMismatchError(rpcErr.message)) {
          await supabase.from('exam_results').delete().eq('id', resultId);
          if (normNum && existing) {
            await supabase
              .from('exam_results')
              .delete()
              .eq('participant_number', normNum)
              .eq('exam_id', existing.examId);
          }
        }
      }
    } catch {
      // Local reset persists regardless
    }
  }

  broadcastDataChange('results');
}

export async function deleteExamResultsBatch(resultIds: string[]): Promise<number> {
  await ensureInitialized();
  if (resultIds.length === 0) return 0;

  const uniqueIds = Array.from(new Set(resultIds));
  const idSet = new Set(uniqueIds);
  const allResults = await idbGetAll<ExamResult>(STORES.RESULTS);
  const matched = allResults.filter((r) => idSet.has(r.id));
  for (const key of confirmedQuestionIdsSyncSet) {
    const idPart = key.split('::')[0];
    if (idSet.has(idPart)) {
      confirmedQuestionIdsSyncSet.delete(key);
    }
  }

  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORES.RESULTS, 'readwrite');
    const store = tx.objectStore(STORES.RESULTS);
    for (const id of uniqueIds) {
      store.delete(id);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  const savedSession = getSavedActiveSession();
  if (
    savedSession &&
    (idSet.has(savedSession.resultId) ||
      matched.some(
        (existing) =>
          savedSession.participant.participantNumber.trim().toUpperCase() ===
            existing.participantNumber.trim().toUpperCase() &&
          savedSession.schedule.id === existing.examId
      ))
  ) {
    clearActiveSessionLocal();
  }

  await unhideDashboardLogsByIds(uniqueIds);

  if (isLiveSupabaseConfigured()) {
    try {
      const adminClient = getSupabaseAdminClient();
      const supabase = getSupabaseClient();
      const CHUNK = 50;
      for (let i = 0; i < uniqueIds.length; i += CHUNK) {
        const chunk = uniqueIds.slice(i, i + CHUNK);
        if (adminClient) {
          await adminClient.from('exam_results').delete().in('id', chunk);
        } else {
          const { error: rpcErr } = await supabase.rpc('staff_delete_exam_results', {
            ...getStaffRpcAuthArgs(),
            p_result_ids: chunk,
            p_participant_number: null,
            p_exam_id: null,
          });
          if (rpcErr && isRpcSignatureMismatchError(rpcErr.message)) {
            await supabase.from('exam_results').delete().in('id', chunk);
          }
        }
      }
    } catch {
      // Local delete persists regardless
    }
  }

  invalidateStoreCache(STORES.RESULTS);
  broadcastDataChange('results');
  return matched.length || uniqueIds.length;
}

export async function clearAllExamResults(): Promise<number> {
  await ensureInitialized();
  const allResults = await idbGetAll<ExamResult>(STORES.RESULTS);
  const count = allResults.length;
  confirmedQuestionIdsSyncSet.clear();

  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORES.RESULTS, 'readwrite');
    tx.objectStore(STORES.RESULTS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  await idbDelete(STORES.META, DASHBOARD_HIDDEN_LOGS_META_ID);
  clearActiveSessionLocal();
  lastAdminResultsDeltaIso = null;
  invalidateStoreCache(STORES.RESULTS);

  if (isLiveSupabaseConfigured()) {
    try {
      const adminClient = getSupabaseAdminClient();
      const supabase = getSupabaseClient();
      const readClient = adminClient || supabase;
      const idRes = await fetchAllRowsByIdPaginated<{ id: string }>(
        readClient,
        'exam_results',
        'id'
      );
      if (!idRes.error && idRes.data.length > 0) {
        const CHUNK = 50;
        const ids = idRes.data.map((r) => String(r.id));
        for (let i = 0; i < ids.length; i += CHUNK) {
          const chunk = ids.slice(i, i + CHUNK);
          if (adminClient) {
            await adminClient.from('exam_results').delete().in('id', chunk);
          } else {
            const { error: rpcErr } = await supabase.rpc('staff_delete_exam_results', {
              ...getStaffRpcAuthArgs(),
              p_result_ids: chunk,
              p_participant_number: null,
              p_exam_id: null,
            });
            if (rpcErr && isRpcSignatureMismatchError(rpcErr.message)) {
              await supabase.from('exam_results').delete().in('id', chunk);
            }
          }
        }
      }
    } catch {
      // Local clear persists regardless
    }
  }

  broadcastDataChange('results');
  return count;
}

export async function resetBulkExamResults(resultIds: string[]): Promise<void> {
  await deleteExamResultsBatch(resultIds);
}

async function pushResultToSupabase(
  result: ExamResult,
  options?: { includeQuestionIds?: boolean }
): Promise<{ ok: boolean; finalizedFromServer?: ExamResult }> {
  if (!isLiveSupabaseConfigured()) {
    return { ok: false };
  }
  try {
    const supabase = getSupabaseClient();
    const adminClient = getSupabaseAdminClient();
    const normParticipant = result.participantNumber.trim().toUpperCase();
    const syncKey = `${result.id}::${normParticipant}::${result.examId}`;
    const hasQuestionIds = Boolean(result.questionIds && result.questionIds.length > 0);
    const shouldIncludeQuestionIds =
      hasQuestionIds &&
      (options?.includeQuestionIds !== false || !confirmedQuestionIdsSyncSet.has(syncKey));

    if (result.status === 'in_progress' && result.submittedAt === null) {
      const { data: rpcData, error: rpcError } = await supabase.rpc('upsert_exam_progress', {
        p_result_id: result.id,
        p_participant_id: result.participantId,
        p_participant_number: normParticipant,
        p_student_name: result.studentName,
        p_class_name: result.className,
        p_exam_id: result.examId,
        p_exam_title: result.examTitle,
        p_subject: result.subject,
        p_answers: result.answers,
        p_flagged_questions: result.flaggedQuestions,
        p_total_questions: result.totalQuestions,
        p_tab_switch_count: result.tabSwitchCount,
        p_started_at: result.startedAt,
        p_question_ids: shouldIncludeQuestionIds ? result.questionIds! : null,
      });

      if (!rpcError && Array.isArray(rpcData) && rpcData[0]) {
        if (rpcData[0].applied === true) {
          if (shouldIncludeQuestionIds) {
            confirmedQuestionIdsSyncSet.add(syncKey);
          }
          return { ok: true };
        }
        const { data: serverRow } = await fetchSingleExamResult(
          supabase,
          normParticipant,
          result.examId,
          EXAM_RESULTS_ADMIN_COLUMNS
        );

        if (serverRow) {
          return { ok: false, finalizedFromServer: mapDbExamResultRow(serverRow) };
        }
        return { ok: false };
      }

      // Fallback when upsert_exam_progress RPC hasn't been deployed on Supabase yet
      const writeClient = adminClient || supabase;
      const { data: existingRow, error: checkErr } = await fetchSingleExamResult(
        writeClient,
        normParticipant,
        result.examId,
        EXAM_RESULTS_ADMIN_COLUMNS
      );

      if (checkErr) return { ok: false };

      if (existingRow) {
        if (existingRow.status !== 'in_progress' || existingRow.submitted_at !== null) {
          return { ok: false, finalizedFromServer: mapDbExamResultRow(existingRow) };
        }

        const existingHasQIds =
          Array.isArray(existingRow.question_ids) && existingRow.question_ids.length > 0;
        const sendQIds = hasQuestionIds && (shouldIncludeQuestionIds || !existingHasQIds);

        const updatePayload: Record<string, unknown> = {
          answers: result.answers,
          flagged_questions: result.flaggedQuestions,
          total_questions: result.totalQuestions,
          tab_switch_count: Math.max(
            Number(existingRow.tab_switch_count || 0),
            result.tabSwitchCount
          ),
          updated_at: new Date().toISOString(),
        };
        if (sendQIds) {
          updatePayload.question_ids = result.questionIds;
        }

        let { error: updErr } = await writeClient
          .from('exam_results')
          .update(updatePayload)
          .eq('id', String(existingRow.id))
          .eq('status', 'in_progress')
          .is('submitted_at', null);

        if (updErr && 'question_ids' in updatePayload && updErr.message.includes('question_ids')) {
          delete updatePayload.question_ids;
          const retry = await writeClient
            .from('exam_results')
            .update(updatePayload)
            .eq('id', String(existingRow.id))
            .eq('status', 'in_progress')
            .is('submitted_at', null);
          updErr = retry.error;
        }

        if (!updErr && (sendQIds || existingHasQIds)) {
          confirmedQuestionIdsSyncSet.add(syncKey);
        }
        return { ok: !updErr };
      }

      const insertPayload: Record<string, unknown> = {
        id: result.id,
        participant_id: result.participantId,
        participant_number: normParticipant,
        student_name: result.studentName,
        class_name: result.className,
        exam_id: result.examId,
        exam_title: result.examTitle,
        subject: result.subject,
        answers: result.answers,
        flagged_questions: result.flaggedQuestions,
        correct_count: 0,
        total_questions: result.totalQuestions,
        score: 0,
        tab_switch_count: result.tabSwitchCount,
        status: 'in_progress',
        started_at: result.startedAt,
        submitted_at: null,
        updated_at: new Date().toISOString(),
      };
      if (hasQuestionIds) {
        insertPayload.question_ids = result.questionIds;
      }

      let { error: insErr } = await writeClient.from('exam_results').insert(insertPayload);
      if (insErr && 'question_ids' in insertPayload && insErr.message.includes('question_ids')) {
        delete insertPayload.question_ids;
        const retry = await writeClient.from('exam_results').insert(insertPayload);
        insErr = retry.error;
      }
      if (!insErr && hasQuestionIds) {
        confirmedQuestionIdsSyncSet.add(syncKey);
      }
      return { ok: !insErr };
    }

    const basePayload: Record<string, unknown> = {
      id: result.id,
      participant_id: result.participantId,
      participant_number: normParticipant,
      student_name: result.studentName,
      class_name: result.className,
      exam_id: result.examId,
      exam_title: result.examTitle,
      subject: result.subject,
      answers: result.answers,
      flagged_questions: result.flaggedQuestions,
      correct_count: result.correctCount,
      total_questions: result.totalQuestions,
      score: result.score,
      tab_switch_count: result.tabSwitchCount,
      status: result.status,
      started_at: result.startedAt,
      submitted_at: result.submittedAt,
      updated_at: new Date().toISOString(),
    };
    if (hasQuestionIds) {
      basePayload.question_ids = result.questionIds;
    }

    if (adminClient) {
      let { error } = await adminClient
        .from('exam_results')
        .upsert(basePayload, { onConflict: 'participant_number,exam_id' });

      if (error && 'question_ids' in basePayload && error.message.includes('question_ids')) {
        delete basePayload.question_ids;
        const retry = await adminClient
          .from('exam_results')
          .upsert(basePayload, { onConflict: 'participant_number,exam_id' });
        error = retry.error;
      }
      if (!error && hasQuestionIds) {
        confirmedQuestionIdsSyncSet.add(syncKey);
      }
      return { ok: !error };
    }

    if (activeStaffCredentials) {
      const { error: rpcErr } = await supabase.rpc('staff_upsert_exam_results_batch', {
        ...getStaffRpcAuthArgs(),
        p_results: [basePayload],
      });
      if (!rpcErr) {
        if (hasQuestionIds) confirmedQuestionIdsSyncSet.add(syncKey);
        return { ok: true };
      }
      if (!isRpcSignatureMismatchError(rpcErr.message)) {
        return { ok: false };
      }
    } else {
      // Pada perangkat siswa (role anon tanpa kredensial staf), gunakan submit_exam_and_score SECURITY DEFINER
      const schedules = await getExamSchedules();
      const matchedSched = findScheduleForExam(schedules, result.examId, result.subject);
      const { data: scoreData, error: scoreErr } = await supabase.rpc('submit_exam_and_score', {
        p_result_id: result.id,
        p_participant_id: result.participantId,
        p_participant_number: normParticipant,
        p_student_name: result.studentName,
        p_class_name: result.className,
        p_exam_id: result.examId,
        p_exam_title: result.examTitle,
        p_subject: matchedSched?.subject || result.subject,
        p_answers: result.answers,
        p_flagged_questions: result.flaggedQuestions,
        p_tab_switch_count: result.tabSwitchCount,
        p_started_at: result.startedAt,
        p_max_tab_switches: matchedSched?.maxTabSwitches ?? 3,
        p_question_ids: hasQuestionIds ? result.questionIds! : null,
      });
      if (!scoreErr && Array.isArray(scoreData) && scoreData[0] && Number(scoreData[0].total_questions) > 0) {
        if (hasQuestionIds) confirmedQuestionIdsSyncSet.add(syncKey);
        return { ok: true };
      }
    }

    let { error } = await supabase
      .from('exam_results')
      .upsert(basePayload, { onConflict: 'participant_number,exam_id' });

    if (error && 'question_ids' in basePayload && error.message.includes('question_ids')) {
      delete basePayload.question_ids;
      const retry = await supabase
        .from('exam_results')
        .upsert(basePayload, { onConflict: 'participant_number,exam_id' });
      error = retry.error;
    }

    if (!error && hasQuestionIds) {
      confirmedQuestionIdsSyncSet.add(syncKey);
    }
    return { ok: !error };
  } catch {
    return { ok: false };
  }
}

const EXPIRY_GRACE_MS = 5000;
const ADMIN_EXPIRY_GRACE_MS = 60_000;

export function flushExamProgressKeepalive(session: ActiveExamSession): void {
  const isLocked = session.tabSwitchCount >= session.schedule.maxTabSwitches;
  if (!isLocked) {
    saveActiveSessionLocal(session);
  }
  if (!isLiveSupabaseConfigured()) return;

  try {
    const { url, anonKey } = getSupabaseConfig();
    if (!url || !anonKey) return;
    const cleanUrl = url.replace(/\/+$/, '');

    const normParticipantNum = session.participant.participantNumber.trim().toUpperCase();
    const questionIds = session.questions.map((q) => q.id);

    // Gunakan RPC upsert_exam_progress (POST + keepalive) agar aman RLS dan menangani baris yang belum dibuat
    void fetch(`${cleanUrl}/rest/v1/rpc/upsert_exam_progress`, {
      method: 'POST',
      keepalive: true,
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        p_result_id: session.resultId,
        p_participant_id: session.participant.id,
        p_participant_number: normParticipantNum,
        p_student_name: session.participant.fullName,
        p_class_name: session.participant.className,
        p_exam_id: session.schedule.id,
        p_exam_title: session.schedule.title,
        p_subject: session.schedule.subject,
        p_answers: session.answers,
        p_flagged_questions: session.flaggedQuestions,
        p_total_questions: session.questions.length,
        p_tab_switch_count: session.tabSwitchCount,
        p_started_at: session.startedAt,
        p_question_ids: questionIds.length > 0 ? questionIds : null,
      }),
    }).catch(() => {
      // Silent fail on network/unload
    });
  } catch {
    // Ignore keepalive network issues on unload
  }
}

export async function upsertExamProgress(
  session: ActiveExamSession,
  options?: { includeQuestionIds?: boolean }
): Promise<ExamResult> {
  await ensureInitialized();
  const isLocked = session.tabSwitchCount >= session.schedule.maxTabSwitches;
  if (!isLocked) {
    saveActiveSessionLocal(session);
  }

  // Guard: jangan pernah menimpa hasil lokal yang sudah submitted/flagged
  const existingLocal = await idbGet<ExamResult>(STORES.RESULTS, session.resultId);
  if (
    existingLocal &&
    (existingLocal.status === 'submitted' ||
      (existingLocal.status === 'flagged' && existingLocal.submittedAt !== null))
  ) {
    clearActiveSessionLocal();
    return existingLocal;
  }

  const questionIds = session.questions.map((q) => q.id);
  const normParticipantNum = session.participant.participantNumber.trim().toUpperCase();

  const progressRecord: ExamResult = {
    id: session.resultId,
    participantId: session.participant.id,
    participantNumber: normParticipantNum,
    studentName: session.participant.fullName,
    className: session.participant.className,
    examId: session.schedule.id,
    examTitle: session.schedule.title,
    subject: session.schedule.subject,
    answers: session.answers,
    flaggedQuestions: session.flaggedQuestions,
    questionIds,
    correctCount: 0,
    totalQuestions: session.questions.length,
    score: 0,
    tabSwitchCount: session.tabSwitchCount,
    status: isLocked ? 'flagged' : 'in_progress',
    startedAt: session.startedAt,
    submittedAt: null,
    syncStatus: 'pending',
  };

  await idbPut(STORES.RESULTS, progressRecord);

  if (!isLocked) {
    const pushRes = await pushResultToSupabase(progressRecord, {
      includeQuestionIds: options?.includeQuestionIds,
    });
    if (pushRes.finalizedFromServer) {
      await idbPut(STORES.RESULTS, pushRes.finalizedFromServer);
      clearActiveSessionLocal();
      broadcastDataChange('results');
      return pushRes.finalizedFromServer;
    }
    if (pushRes.ok) {
      progressRecord.syncStatus = 'synced';
      await idbPut(STORES.RESULTS, progressRecord);
    }
  }

  broadcastDataChange('results');
  return progressRecord;
}

function clearLocalSessionIfMatches(result: ExamResult): void {
  const savedSession = getSavedActiveSession();
  if (
    savedSession &&
    (savedSession.resultId === result.id ||
      (savedSession.participant.participantNumber.trim().toUpperCase() ===
        result.participantNumber.trim().toUpperCase() &&
        savedSession.schedule.id === result.examId))
  ) {
    clearActiveSessionLocal();
  }
}

async function finalizeExamResultRecord(
  rawResult: ExamResult,
  options?: {
    maxTabSwitches?: number;
    totalQuestionsFallback?: number;
    skipIfFinalized?: boolean;
    keepInProgressIfUnscored?: boolean;
    broadcast?: boolean;
  }
): Promise<ExamResult> {
  if (
    options?.skipIfFinalized &&
    (rawResult.status === 'submitted' ||
      (rawResult.status === 'flagged' && rawResult.submittedAt !== null))
  ) {
    return rawResult;
  }

  const nowIso = new Date(getServerNowMs()).toISOString();
  const normParticipantNum = rawResult.participantNumber.trim().toUpperCase();
  const answers = rawResult.answers || {};
  const flaggedQuestions = rawResult.flaggedQuestions || [];
  const questionIds = rawResult.questionIds;

  let maxTabSwitches = options?.maxTabSwitches;
  let resolvedSubject = rawResult.subject;
  const schedules = await getExamSchedules();
  const matchingSchedule = findScheduleForExam(
    schedules,
    rawResult.examId,
    rawResult.subject
  );
  if (maxTabSwitches === undefined) {
    maxTabSwitches = matchingSchedule?.maxTabSwitches ?? 3;
  }
  if (matchingSchedule?.subject) {
    resolvedSubject = matchingSchedule.subject;
  }

  const computedStatus: ExamResult['status'] =
    rawResult.tabSwitchCount >= maxTabSwitches ? 'flagged' : 'submitted';

  let correctCount = 0;
  let totalQuestions = options?.totalQuestionsFallback ?? rawResult.totalQuestions;
  let score = 0;
  let synced = false;

  if (isLiveSupabaseConfigured()) {
    const supabase = getSupabaseClient();
    const retryBackoffs = [0, 600, 1800, 3500];

    for (let attempt = 0; attempt < retryBackoffs.length; attempt++) {
      if (retryBackoffs[attempt] > 0) {
        const jitter = Math.floor(Math.random() * 400);
        await new Promise((r) => setTimeout(r, retryBackoffs[attempt] + jitter));
      }
      try {
        let rpcResult = await supabase.rpc('submit_exam_and_score', {
          p_result_id: rawResult.id,
          p_participant_id: rawResult.participantId,
          p_participant_number: normParticipantNum,
          p_student_name: rawResult.studentName,
          p_class_name: rawResult.className,
          p_exam_id: rawResult.examId,
          p_exam_title: rawResult.examTitle,
          p_subject: resolvedSubject,
          p_answers: answers,
          p_flagged_questions: flaggedQuestions,
          p_tab_switch_count: rawResult.tabSwitchCount,
          p_started_at: rawResult.startedAt,
          p_max_tab_switches: maxTabSwitches,
          p_question_ids: questionIds && questionIds.length > 0 ? questionIds : null,
        });

        // Graceful fallback ke signature 12 argumen jika SQL DB belum di-upgrade
        if (rpcResult.error && rpcResult.error.message.toLowerCase().includes('function')) {
          rpcResult = await supabase.rpc('submit_exam_and_score', {
            p_result_id: rawResult.id,
            p_participant_id: rawResult.participantId,
            p_participant_number: normParticipantNum,
            p_student_name: rawResult.studentName,
            p_class_name: rawResult.className,
            p_exam_id: rawResult.examId,
            p_exam_title: rawResult.examTitle,
            p_subject: resolvedSubject,
            p_answers: answers,
            p_flagged_questions: flaggedQuestions,
            p_tab_switch_count: rawResult.tabSwitchCount,
            p_started_at: rawResult.startedAt,
          });
        }

        if (
          !rpcResult.error &&
          Array.isArray(rpcResult.data) &&
          rpcResult.data[0] &&
          Number(rpcResult.data[0].total_questions) > 0
        ) {
          correctCount = rpcResult.data[0].correct_count;
          totalQuestions = rpcResult.data[0].total_questions;
          score = Number(rpcResult.data[0].score);
          synced = true;
          break;
        }
      } catch {
        // Retry with backoff
      }
    }
  }

  let needsServerScoring = false;

  if (!synced) {
    const vaultQuestions = await idbGetAll<Question>(STORES.QUESTIONS);
    const idFilterSet =
      questionIds && questionIds.length > 0 ? new Set(questionIds) : null;
    const normResolvedSubject = (resolvedSubject || '').trim().toLowerCase();

    const classSubjectQuestions = vaultQuestions.filter(
      (q) =>
        q.targetClasses.includes(rawResult.className) &&
        q.subject.trim().toLowerCase() === normResolvedSubject &&
        (!idFilterSet || idFilterSet.has(q.id))
    );
    if (classSubjectQuestions.length > 0) {
      let totalPoints = 0;
      let earnedPoints = 0;
      for (const q of classSubjectQuestions) {
        const scored = scoreSingleQuestion(q, answers[q.id]);
        totalPoints += scored.maxPoints;
        earnedPoints += scored.earnedPoints;
        if (scored.isFullCorrect) {
          correctCount += 1;
        }
      }
      totalQuestions = classSubjectQuestions.length;
      score = totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 10000) / 100 : 0;
    } else {
      totalQuestions = options?.totalQuestionsFallback ?? rawResult.totalQuestions;
      const hasEvidenceOfExam =
        totalQuestions > 0 ||
        Boolean(questionIds && questionIds.length > 0) ||
        Object.keys(answers).length > 0;
      // Pada browser siswa/admin tanpa cache soal lengkap, jangan simpan score=0 permanen bila diminta keepInProgressIfUnscored
      if (hasEvidenceOfExam && isLiveSupabaseConfigured()) {
        needsServerScoring = true;
        if (options?.keepInProgressIfUnscored) {
          const deferredRecord: ExamResult = {
            ...rawResult,
            participantNumber: normParticipantNum,
            subject: resolvedSubject,
            answers,
            flaggedQuestions,
            questionIds,
            totalQuestions: totalQuestions || questionIds?.length || 0,
            status: 'in_progress',
            submittedAt: null,
            syncStatus: 'pending',
            needsServerScoring: true,
          };
          await idbPut(STORES.RESULTS, deferredRecord);
          return deferredRecord;
        }
        try {
          await pushResultToSupabase(
            {
              ...rawResult,
              participantNumber: normParticipantNum,
              subject: resolvedSubject,
              answers,
              flaggedQuestions,
              questionIds,
              totalQuestions: totalQuestions || questionIds?.length || 0,
              status: 'in_progress',
              submittedAt: null,
            },
            { includeQuestionIds: Boolean(questionIds && questionIds.length > 0) }
          );
        } catch {
          // Best-effort snapshot
        }
      }
    }
  }

  const finalResult: ExamResult = {
    ...rawResult,
    participantNumber: normParticipantNum,
    subject: resolvedSubject,
    answers,
    flaggedQuestions,
    questionIds,
    correctCount,
    totalQuestions,
    score,
    status: computedStatus,
    submittedAt: nowIso,
    syncStatus: synced ? 'synced' : 'pending',
    needsServerScoring: synced ? undefined : needsServerScoring || undefined,
  };

  if (!synced && !needsServerScoring) {
    const pushRes = await pushResultToSupabase(finalResult);
    if (pushRes.ok) {
      finalResult.syncStatus = 'synced';
    }
  }

  await idbPut(STORES.RESULTS, finalResult);
  clearLocalSessionIfMatches(finalResult);

  if (options?.broadcast !== false) {
    broadcastDataChange('results');
  }

  return finalResult;
}

export async function submitFinalExam(session: ActiveExamSession): Promise<ExamResult> {
  await ensureInitialized();

  const baseResult: ExamResult = {
    id: session.resultId,
    participantId: session.participant.id,
    participantNumber: session.participant.participantNumber.trim().toUpperCase(),
    studentName: session.participant.fullName,
    className: session.participant.className,
    examId: session.schedule.id,
    examTitle: session.schedule.title,
    subject: session.schedule.subject,
    answers: session.answers,
    flaggedQuestions: session.flaggedQuestions,
    questionIds: session.questions.map((q) => q.id),
    correctCount: 0,
    totalQuestions: session.questions.length,
    score: 0,
    tabSwitchCount: session.tabSwitchCount,
    status: 'in_progress',
    startedAt: session.startedAt,
    submittedAt: null,
    syncStatus: 'pending',
  };

  const finalResult = await finalizeExamResultRecord(baseResult, {
    maxTabSwitches: session.schedule.maxTabSwitches,
    totalQuestionsFallback: session.questions.length,
    broadcast: true,
  });

  clearActiveSessionLocal();
  return finalResult;
}

export async function lockoutExamSession(session: ActiveExamSession): Promise<ExamResult> {
  const lockedSession: ActiveExamSession = {
    ...session,
    tabSwitchCount: Math.max(session.tabSwitchCount, session.schedule.maxTabSwitches),
  };
  clearActiveSessionLocal();
  return submitFinalExam(lockedSession);
}

export async function forceFinishExamResults(
  resultIds: string[]
): Promise<{ finishedCount: number; results: ExamResult[] }> {
  await ensureInitialized();
  if (resultIds.length === 0) return { finishedCount: 0, results: [] };

  const idSet = new Set(resultIds);
  const [allResults, schedules] = await Promise.all([
    idbGetAll<ExamResult>(STORES.RESULTS),
    getExamSchedules(),
  ]);

  const targets = allResults.filter((r) => idSet.has(r.id) && r.status === 'in_progress');
  if (targets.length === 0) return { finishedCount: 0, results: [] };

  const finalized: ExamResult[] = [];
  const finalizedIdSet = new Set<string>();
  const RPC_BATCH_SIZE = 50;

  if (isLiveSupabaseConfigured()) {
    const supabase = getSupabaseClient();
    const readClient = getSupabaseAdminClient() || supabase;

    for (let i = 0; i < targets.length; i += RPC_BATCH_SIZE) {
      const batchTargets = targets.slice(i, i + RPC_BATCH_SIZE);
      const batchIds = batchTargets.map((t) => t.id);

      try {
        let { error: rpcErr } = await supabase.rpc('force_finish_exam_results', {
          p_result_ids: batchIds,
          p_limit: RPC_BATCH_SIZE,
          ...getStaffRpcAuthArgs(),
        });
        if (rpcErr && isRpcSignatureMismatchError(rpcErr.message)) {
          const legacy = await supabase.rpc('force_finish_exam_results', {
            p_result_ids: batchIds,
            p_limit: RPC_BATCH_SIZE,
          });
          rpcErr = legacy.error;
        }

        if (!rpcErr) {
          let { data: fetchedRows, error: fetchErr } = await readClient
            .from('exam_results')
            .select(EXAM_RESULTS_ADMIN_COLUMNS)
            .in('id', batchIds);

          if (fetchErr && fetchErr.message.includes('question_ids')) {
            const legacyRes = await readClient
              .from('exam_results')
              .select(EXAM_RESULTS_ADMIN_COLUMNS_LEGACY)
              .in('id', batchIds);
            fetchedRows = legacyRes.data as typeof fetchedRows;
            fetchErr = legacyRes.error;
          }

          if (!fetchErr && Array.isArray(fetchedRows)) {
            const serverFinished: ExamResult[] = [];
            for (const row of fetchedRows as unknown as Record<string, unknown>[]) {
              const mapped = mapDbExamResultRow(row);
              if (
                mapped.status === 'submitted' ||
                (mapped.status === 'flagged' && mapped.submittedAt !== null)
              ) {
                serverFinished.push(mapped);
                finalizedIdSet.add(mapped.id);
                finalized.push(mapped);
                clearLocalSessionIfMatches(mapped);
              }
            }
            if (serverFinished.length > 0) {
              await idbPutMany(STORES.RESULTS, serverFinished);
            }
          }
        }
      } catch {
        // Fallback below for items not finalized by server batch RPC
      }
    }
  }

  const remainingTargets = targets.filter((t) => !finalizedIdSet.has(t.id));
  if (remainingTargets.length > 0) {
    const FALLBACK_CHUNK = 10;
    for (let i = 0; i < remainingTargets.length; i += FALLBACK_CHUNK) {
      const chunk = remainingTargets.slice(i, i + FALLBACK_CHUNK);
      const chunkDone = await Promise.all(
        chunk.map((item) => {
          const sched = findScheduleForExam(schedules, item.examId, item.subject);
          return finalizeExamResultRecord(item, {
            maxTabSwitches: sched?.maxTabSwitches ?? 3,
            skipIfFinalized: true,
            broadcast: false,
          });
        })
      );
      finalized.push(...chunkDone);
    }
  }

  broadcastDataChange('results');
  return { finishedCount: finalized.length, results: finalized };
}

let autoFinalizeInFlight: Promise<number> | null = null;

export async function autoFinalizeExpiredExams(options?: {
  currentParticipantNumber?: string;
  isAdmin?: boolean;
}): Promise<number> {
  if (autoFinalizeInFlight) return autoFinalizeInFlight;

  autoFinalizeInFlight = (async () => {
    try {
      await ensureInitialized();
      const savedSession = getSavedActiveSession();
      const targetParticipant =
        options?.currentParticipantNumber?.trim().toUpperCase() ||
        savedSession?.participant.participantNumber.trim().toUpperCase() ||
        '';

      // Hanya panel Admin/Proktor yang boleh mem-finalisasi peserta lain secara massal.
      // Peramban siswa hanya mem-finalisasi sesi miliknya sendiri agar tidak menghitung skor 0 dari vault kosong.
      if (!options?.isAdmin && !targetParticipant) {
        return 0;
      }

      const [allResults, schedules] = await Promise.all([
        idbGetAll<ExamResult>(STORES.RESULTS),
        getExamSchedules(),
      ]);

      const nowMs = getServerNowMs();
      const expiredItems: Array<{ result: ExamResult; maxTabSwitches: number; durationMinutes: number }> = [];

      for (const res of allResults) {
        if (res.status !== 'in_progress') continue;
        if (!options?.isAdmin && res.participantNumber.trim().toUpperCase() !== targetParticipant) {
          continue;
        }
        const sched = findScheduleForExam(schedules, res.examId, res.subject);
        if (!sched) continue;

        const startedMs = new Date(res.startedAt).getTime();
        if (!Number.isFinite(startedMs)) continue;

        const graceMs = options?.isAdmin ? ADMIN_EXPIRY_GRACE_MS : EXPIRY_GRACE_MS;
        const durationMs = Math.max(1, sched.durationMinutes) * 60 * 1000;
        if (nowMs >= startedMs + durationMs + graceMs) {
          expiredItems.push({
            result: res,
            maxTabSwitches: sched.maxTabSwitches,
            durationMinutes: Math.max(1, sched.durationMinutes),
          });
        }
      }

      if (expiredItems.length === 0) return 0;

      // Pada Portal Admin dengan Supabase Live, eksekusi penilaian batch bertahap (LIMIT 50) di server via RPC auto_finalize_expired_results
      if (options?.isAdmin && isLiveSupabaseConfigured()) {
        const supabase = getSupabaseClient();
        const examGroups = new Map<
          string,
          { cutoffIso: string; maxTabSwitches: number; items: Array<{ result: ExamResult; maxTabSwitches: number }> }
        >();

        for (const entry of expiredItems) {
          const durationMs = entry.durationMinutes * 60 * 1000;
          const cutoffIso = new Date(nowMs - durationMs - ADMIN_EXPIRY_GRACE_MS).toISOString();
          const group = examGroups.get(entry.result.examId);
          if (!group) {
            examGroups.set(entry.result.examId, {
              cutoffIso,
              maxTabSwitches: entry.maxTabSwitches,
              items: [entry],
            });
          } else {
            group.items.push(entry);
          }
        }

        let serverRpcFinalizedTotal = 0;
        let rpcAnySuccess = false;
        const fallbackItems: Array<{ result: ExamResult; maxTabSwitches: number }> = [];
        const RPC_LIMIT = 50;
        const MAX_ROUNDS = 40;

        for (const [examId, group] of examGroups.entries()) {
          try {
            let signatureMode: 'with_staff' | 'four_args' | 'three_args' = 'with_staff';
            let groupFailed = false;
            for (let round = 0; round < MAX_ROUNDS; round++) {
              const callRpc = async (mode: 'with_staff' | 'four_args' | 'three_args') => {
                if (mode === 'with_staff') {
                  return supabase.rpc('auto_finalize_expired_results', {
                    p_exam_id: examId,
                    p_cutoff: group.cutoffIso,
                    p_max_tab_switches: group.maxTabSwitches,
                    p_limit: RPC_LIMIT,
                    ...getStaffRpcAuthArgs(),
                  });
                }
                if (mode === 'four_args') {
                  return supabase.rpc('auto_finalize_expired_results', {
                    p_exam_id: examId,
                    p_cutoff: group.cutoffIso,
                    p_max_tab_switches: group.maxTabSwitches,
                    p_limit: RPC_LIMIT,
                  });
                }
                return supabase.rpc('auto_finalize_expired_results', {
                  p_exam_id: examId,
                  p_cutoff: group.cutoffIso,
                  p_max_tab_switches: group.maxTabSwitches,
                });
              };

              let rpcRes = await callRpc(signatureMode);
              if (
                signatureMode === 'with_staff' &&
                rpcRes.error &&
                isRpcSignatureMismatchError(rpcRes.error.message)
              ) {
                signatureMode = 'four_args';
                rpcRes = await callRpc(signatureMode);
              }
              if (
                signatureMode === 'four_args' &&
                rpcRes.error &&
                isRpcSignatureMismatchError(rpcRes.error.message)
              ) {
                signatureMode = 'three_args';
                rpcRes = await callRpc(signatureMode);
              }

              if (rpcRes.error) {
                groupFailed = true;
                break;
              }

              rpcAnySuccess = true;
              const batchCount = Number(rpcRes.data || 0);
              serverRpcFinalizedTotal += batchCount;
              if (signatureMode === 'three_args' || batchCount < RPC_LIMIT) {
                break;
              }
            }
            if (groupFailed) {
              fallbackItems.push(...group.items);
            }
          } catch {
            fallbackItems.push(...group.items);
          }
        }

        if (rpcAnySuccess && serverRpcFinalizedTotal > 0) {
          const readClient = getSupabaseAdminClient() || supabase;
          if (lastAdminResultsDeltaIso) {
            const deltaRes = await fetchExamResultsDelta(readClient, lastAdminResultsDeltaIso);
            if (!deltaRes.error && deltaRes.data.length > 0) {
              lastAdminResultsDeltaIso = deltaRes.maxUpdatedAt;
              await mergeResultsStoreDelta(
                deltaRes.data.map((r) => mapDbExamResultRow(r))
              );
            }
          }
        }

        let fallbackFinalizedCount = 0;
        if (fallbackItems.length > 0) {
          const CHUNK = 10;
          for (let i = 0; i < fallbackItems.length; i += CHUNK) {
            const chunk = fallbackItems.slice(i, i + CHUNK);
            const done = await Promise.all(
              chunk.map(({ result, maxTabSwitches }) =>
                finalizeExamResultRecord(result, {
                  maxTabSwitches,
                  skipIfFinalized: true,
                  keepInProgressIfUnscored: true,
                  broadcast: false,
                })
              )
            );
            fallbackFinalizedCount += done.filter((d) => d.status !== 'in_progress').length;
          }
        }

        const totalFinalized = serverRpcFinalizedTotal + fallbackFinalizedCount;
        if (totalFinalized > 0) {
          broadcastDataChange('results');
        }
        return totalFinalized;
      }

      const CHUNK = 10;
      let localFinalizedCount = 0;
      for (let i = 0; i < expiredItems.length; i += CHUNK) {
        const chunk = expiredItems.slice(i, i + CHUNK);
        const done = await Promise.all(
          chunk.map(({ result, maxTabSwitches }) =>
            finalizeExamResultRecord(result, {
              maxTabSwitches,
              skipIfFinalized: true,
              keepInProgressIfUnscored: true,
              broadcast: false,
            })
          )
        );
        localFinalizedCount += done.filter((d) => d.status !== 'in_progress').length;
      }

      if (localFinalizedCount > 0) {
        broadcastDataChange('results');
      }
      return localFinalizedCount;
    } finally {
      autoFinalizeInFlight = null;
    }
  })();

  return autoFinalizeInFlight;
}

let flushPendingInFlight: Promise<number> | null = null;

function shouldRetryServerScoring(item: ExamResult): boolean {
  return Boolean(
    item.needsServerScoring ||
      ((item.status === 'submitted' ||
        (item.status === 'flagged' && item.submittedAt !== null)) &&
        item.score === 0 &&
        item.correctCount === 0)
  );
}

export async function flushPendingSyncQueue(): Promise<number> {
  if (!isLiveSupabaseConfigured()) return 0;
  if (flushPendingInFlight) return flushPendingInFlight;

  flushPendingInFlight = (async () => {
    try {
      const results = await idbGetAll<ExamResult>(STORES.RESULTS);
      const pending = results.filter((r) => r.syncStatus === 'pending');
      if (pending.length === 0) return 0;

      let syncedCount = 0;
      const CHUNK = 8;

      for (let i = 0; i < pending.length; i += CHUNK) {
        const chunk = pending.slice(i, i + CHUNK);
        await Promise.all(
          chunk.map(async (item) => {
            if (shouldRetryServerScoring(item)) {
              const finalized = await finalizeExamResultRecord(item, {
                skipIfFinalized: false,
                keepInProgressIfUnscored: true,
                broadcast: false,
              });
              if (finalized.syncStatus === 'synced') {
                syncedCount += 1;
              }
              return;
            }

            const pushRes = await pushResultToSupabase(item);
            if (pushRes.finalizedFromServer) {
              await idbPut(STORES.RESULTS, pushRes.finalizedFromServer);
              syncedCount += 1;
            } else if (pushRes.ok) {
              item.syncStatus = 'synced';
              await idbPut(STORES.RESULTS, item);
              syncedCount += 1;
            }
          })
        );
      }

      if (syncedCount > 0) {
        broadcastDataChange('sync_flushed');
      }
      return syncedCount;
    } finally {
      flushPendingInFlight = null;
    }
  })();

  return flushPendingInFlight;
}

export async function testSupabaseConnection(): Promise<{ ok: boolean; message: string }> {
  if (!isLiveSupabaseConfigured()) {
    return {
      ok: false,
      message:
        'Menggunakan konfigurasi default lokal. Masukkan Project URL & Anon Key Supabase live untuk menyambungkan cloud PostgreSQL.',
    };
  }
  try {
    const cfg = getSupabaseConfig();
    const supabase = getSupabaseClient();
    const { error } = await supabase.from('school_profile').select('id').limit(1);
    if (error) {
      const msg = error.message || '';
      if (msg.toLowerCase().includes('permission denied')) {
        return {
          ok: false,
          message: `Koneksi merespons error tabel (${msg}). Role database belum memiliki hak akses GRANT/RLS pada schema public. Buka tab "Skema SQL & RLS" → Salin seluruh Skrip SQL terbaru → tempel & klik Run di Supabase SQL Editor.`,
        };
      }
      if (msg.toLowerCase().includes('does not exist') || msg.toLowerCase().includes('could not find')) {
        return {
          ok: false,
          message: `Tabel belum tersedia di Supabase (${msg}). Buka tab "Skema SQL & RLS" → Salin seluruh Skrip SQL → jalankan di Supabase SQL Editor terlebih dahulu.`,
        };
      }
      return { ok: false, message: `Koneksi merespons error tabel: ${msg}` };
    }

    const svcValidation = validateServiceRoleKey(cfg.serviceRoleKey, cfg.url);
    if (svcValidation.hasKey) {
      if (!svcValidation.valid) {
        return {
          ok: false,
          message: `Anon Key terhubung, tetapi Service Role Key tidak valid: ${svcValidation.reason}`,
        };
      }
      const adminClient = getSupabaseAdminClient();
      if (adminClient) {
        const { error: qErr } = await adminClient.from('questions').select('id').limit(1);
        if (qErr) {
          const qMsg = qErr.message || '';
          if (qMsg.toLowerCase().includes('permission denied')) {
            return {
              ok: false,
              message: `Anon Key terhubung, tetapi Service Role Key ditolak pada tabel questions (${qMsg}). Jalankan ulang Skrip SQL terbaru di tab "Skema SQL & RLS" (bagian GRANT ... TO service_role) pada Supabase SQL Editor.`,
            };
          }
          if (qMsg.toLowerCase().includes('does not exist') || qMsg.toLowerCase().includes('could not find')) {
            return {
              ok: false,
              message: `Tabel questions belum tersedia di Supabase (${qMsg}). Jalankan Skrip SQL di Supabase SQL Editor.`,
            };
          }
          return {
            ok: false,
            message: `Anon Key terhubung, tetapi Service Role Key gagal membaca tabel questions: ${qMsg}`,
          };
        }
        return {
          ok: true,
          message:
            'Terhubung langsung ke PostgreSQL Supabase (Anon Key & Service Role Key aktif penuh pada seluruh tabel termasuk questions).',
        };
      }
    }

    return { ok: true, message: 'Terhubung langsung ke PostgreSQL Supabase & tabel aktif.' };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Gagal menghubungi server Supabase.',
    };
  }
}

export async function resetDemoDatabase(): Promise<void> {
  await idbPut(STORES.META, SEED_SCHOOL_PROFILE);
  await idbPut(STORES.META, { id: 'init_flags', seeded: true });
  await idbDelete(STORES.META, DASHBOARD_HIDDEN_LOGS_META_ID);
  await idbPutMany(STORES.PARTICIPANTS, [], true);
  await idbPutMany(STORES.SCHEDULES, [], true);
  await idbPutMany(STORES.QUESTIONS, [], true);
  await idbPutMany(STORES.RESULTS, [], true);
  const hashedStaff = await Promise.all(
    SEED_STAFF_ACCOUNTS.map(async (acc) => ({
      ...acc,
      password: await hashPassword(acc.password),
    }))
  );
  await idbPutStaffSafe(hashedStaff, true);
  clearActiveSessionLocal();
  confirmedQuestionIdsSyncSet.clear();
  lastAdminResultsDeltaIso = null;
  invalidateStoreCache();
  lastQuestionsCloudMeta = null;
  broadcastDataChange('reset');
}

// ============================================================================
// OPERASI SINKRONISASI DATA & DIAGNOSTIK CLOUD <-> LOKAL
// ============================================================================
const LAST_SYNC_KEY = 'cbt_last_cloud_sync_at_v1';

export interface SyncTableStats {
  table:
    | 'school_profile'
    | 'participants'
    | 'exam_schedules'
    | 'questions'
    | 'exam_results'
    | 'staff_accounts';
  label: string;
  localCount: number;
  cloudCount: number | null;
  note?: string;
}

export interface SyncOperationReport {
  ok: boolean;
  action: string;
  timestamp: string;
  summary: string;
  details: Record<string, number>;
  errors: string[];
}

export function getLastSyncTimestamp(): string | null {
  try {
    return localStorage.getItem(LAST_SYNC_KEY);
  } catch {
    return null;
  }
}

function setLastSyncTimestamp(iso: string): void {
  try {
    localStorage.setItem(LAST_SYNC_KEY, iso);
  } catch {
    // Ignore storage quota errors
  }
}

export async function getSyncDiagnostics(): Promise<{
  tables: SyncTableStats[];
  pendingResultsCount: number;
  lastSyncAt: string | null;
}> {
  await ensureInitialized();
  const [profile, participants, schedules, questions, results, staffAccounts] = await Promise.all([
    idbGet<SchoolProfile>(STORES.META, 'default'),
    idbGetAll<Participant>(STORES.PARTICIPANTS),
    idbGetAll<ExamSchedule>(STORES.SCHEDULES),
    idbGetAll<Question>(STORES.QUESTIONS),
    idbGetAll<ExamResult>(STORES.RESULTS),
    idbGetAll<StaffAccount>(STORES.STAFF_ACCOUNTS),
  ]);

  const pendingResultsCount = results.filter((r) => r.syncStatus === 'pending').length;

  const tables: SyncTableStats[] = [
    {
      table: 'school_profile',
      label: 'Profil Sekolah & Pengaturan',
      localCount: profile ? 1 : 0,
      cloudCount: null,
    },
    {
      table: 'staff_accounts',
      label: 'Akun Role & Hak Akses Panitia',
      localCount: staffAccounts.length,
      cloudCount: null,
    },
    {
      table: 'participants',
      label: 'Peserta & Token Ujian',
      localCount: participants.length,
      cloudCount: null,
    },
    {
      table: 'exam_schedules',
      label: 'Jadwal & KKM Mapel',
      localCount: schedules.length,
      cloudCount: null,
    },
    {
      table: 'questions',
      label: 'Bank Soal & Kunci Jawaban',
      localCount: questions.length,
      cloudCount: null,
    },
    {
      table: 'exam_results',
      label: 'Hasil & Status Ujian Siswa',
      localCount: results.length,
      cloudCount: null,
      note: pendingResultsCount > 0 ? `${pendingResultsCount} antrean pending` : undefined,
    },
  ];

  if (isLiveSupabaseConfigured()) {
    const cfg = getSupabaseConfig();
    const svcValidation = validateServiceRoleKey(cfg.serviceRoleKey, cfg.url);
    const supabase = getSupabaseClient();
    const adminClient = getSupabaseAdminClient();

    await Promise.all(
      tables.map(async (entry) => {
        try {
          if (entry.table === 'questions') {
            if (adminClient) {
              const { count, error } = await adminClient
                .from('questions')
                .select('id', { count: 'exact', head: true });
              if (error) {
                entry.note = error.message;
              } else {
                entry.cloudCount = count ?? 0;
              }
              return;
            }
            const meta = await fetchQuestionsCloudMeta(supabase);
            if (meta) {
              entry.cloudCount = meta.totalCount;
              entry.note = 'Diproteksi RLS (terhitung via RPC staf)';
            } else {
              entry.note =
                svcValidation.hasKey && !svcValidation.valid
                  ? svcValidation.reason || 'Service Role Key tidak valid'
                  : 'Diproteksi RLS (isi Service Role Key atau login Admin untuk cek jumlah cloud)';
            }
            return;
          }

          if (entry.table === 'staff_accounts') {
            if (adminClient) {
              const { count, error } = await adminClient
                .from('staff_accounts')
                .select('id', { count: 'exact', head: true });
              if (error) entry.note = error.message;
              else entry.cloudCount = count ?? 0;
            } else {
              let { data, error } = await supabase.rpc('staff_list_accounts', getStaffRpcAuthArgs());
              if (error && isRpcSignatureMismatchError(error.message)) {
                const legacy = await supabase
                  .from('staff_accounts')
                  .select('id', { count: 'exact', head: true });
                if (legacy.error) entry.note = legacy.error.message;
                else entry.cloudCount = legacy.count ?? 0;
                return;
              }
              if (error) {
                entry.note = 'Diproteksi RLS (login Admin atau isi Service Role Key)';
              } else if (Array.isArray(data)) {
                entry.cloudCount = data.length;
              }
            }
            return;
          }

          const readClient = adminClient || supabase;
          const { count, error } = await readClient
            .from(entry.table)
            .select('id', { count: 'exact', head: true });
          if (error) {
            entry.note = error.message;
          } else {
            entry.cloudCount = count ?? 0;
          }
        } catch (err) {
          entry.note = err instanceof Error ? err.message : 'Gagal membaca cloud';
        }
      })
    );
  }

  return {
    tables,
    pendingResultsCount,
    lastSyncAt: getLastSyncTimestamp(),
  };
}

export async function pullAllFromSupabaseDetailed(): Promise<SyncOperationReport> {
  const timestamp = new Date().toISOString();
  if (!isLiveSupabaseConfigured()) {
    return {
      ok: false,
      action: 'Pull Cloud → Lokal',
      timestamp,
      summary: 'Koneksi Supabase Live belum dikonfigurasi.',
      details: {},
      errors: ['Masukkan Project URL & Anon Key Supabase live terlebih dahulu.'],
    };
  }

  const errors: string[] = [];
  const details: Record<string, number> = {
    school_profile: 0,
    staff_accounts: 0,
    exam_schedules: 0,
    participants: 0,
    questions: 0,
    exam_results: 0,
  };

  try {
    const cfg = getSupabaseConfig();
    const svcValidation = validateServiceRoleKey(cfg.serviceRoleKey, cfg.url);
    const supabase = getSupabaseClient();
    const adminClient = getSupabaseAdminClient();
    const readClient = adminClient || supabase;

    const fetchStaffDetailed = async (): Promise<{
      data: Record<string, unknown>[];
      error?: string;
    }> => {
      if (adminClient) {
        return fetchAllRowsByIdPaginated(adminClient, 'staff_accounts');
      }
      const rpcRes = await supabase.rpc('staff_list_accounts', getStaffRpcAuthArgs());
      if (!rpcRes.error && Array.isArray(rpcRes.data)) {
        return { data: rpcRes.data as Record<string, unknown>[] };
      }
      if (rpcRes.error && isRpcSignatureMismatchError(rpcRes.error.message)) {
        return fetchAllRowsByIdPaginated(supabase, 'staff_accounts');
      }
      return { data: [], error: rpcRes.error?.message };
    };

    const [profRes, schedRes, partRes, resRes, staffRes] = await Promise.all([
      readClient
        .from('school_profile')
        .select(adminClient ? ADMIN_SCHOOL_PROFILE_COLUMNS : PUBLIC_SCHOOL_PROFILE_COLUMNS)
        .eq('id', 'default')
        .maybeSingle(),
      fetchAllRowsByIdPaginated(readClient, 'exam_schedules'),
      fetchAllRowsByIdPaginated(readClient, 'participants'),
      fetchAllRowsByIdPaginated(readClient, 'exam_results', EXAM_RESULTS_ADMIN_COLUMNS, 100_000),
      fetchStaffDetailed(),
    ]);

    const hasCloudProfile = Boolean(!profRes.error && profRes.data);

    if (profRes.error) {
      errors.push(`school_profile: ${profRes.error.message}`);
    } else if (profRes.data) {
      const existingProf = await idbGet<SchoolProfile>(STORES.META, 'default');
      const profRow = profRes.data as unknown as Record<string, unknown>;
      await idbPut(STORES.META, {
        id: 'default',
        schoolName: String(profRow.school_name || ''),
        address: String(profRow.address || ''),
        academicYear: String(profRow.academic_year || ''),
        principalName: String(profRow.principal_name || ''),
        committeeChairName: String(profRow.committee_chair_name || ''),
        examTitle: String(profRow.exam_title || ''),
        logoDataUrl: String(profRow.logo_data_url || '') || SEED_SCHOOL_PROFILE.logoDataUrl,
        adminPassword:
          (typeof profRow.admin_password === 'string' && profRow.admin_password) ||
          existingProf?.adminPassword ||
          'admin123',
        updatedAt: String(profRow.updated_at || timestamp),
      } satisfies SchoolProfile);
      details.school_profile = 1;
    }

    if (schedRes.error) {
      errors.push(`exam_schedules: ${schedRes.error}`);
    } else {
      if (schedRes.data.length > 0 || hasCloudProfile) {
        await idbPutMany(
          STORES.SCHEDULES,
          schedRes.data.map((r) => ({
            id: r.id,
            title: r.title,
            subject: r.subject,
            kkm: Number(r.kkm ?? 75),
            durationMinutes: r.duration_minutes,
            targetClasses: r.target_classes,
            isActive: r.is_active,
            randomizeQuestions: Boolean(r.randomize_questions ?? false),
            maxTabSwitches: r.max_tab_switches,
            createdAt: r.created_at,
          })),
          true
        );
      }
      details.exam_schedules = schedRes.data.length;
    }

    if (partRes.error) {
      errors.push(`participants: ${partRes.error}`);
    } else {
      if (partRes.data.length > 0 || hasCloudProfile) {
        await idbPutParticipantsSafe(
          partRes.data.map((r) => ({
            id: String(r.id),
            participantNumber: String(r.participant_number || '').trim().toUpperCase(),
            token: r.token || 'CBT2026',
            fullName: r.full_name,
            className: r.class_name,
            isActive: r.is_active,
            createdAt: r.created_at,
          })),
          true
        );
      }
      details.participants = partRes.data.length;
    }

    if (resRes.error) {
      errors.push(`exam_results: ${resRes.error}`);
    } else {
      lastAdminStaticPullMs = Date.now();
      lastAdminResultsDeltaIso = getMaxUpdatedAtIso(resRes.data as Record<string, unknown>[]);
      const cloudResults = resRes.data.map((r) =>
        mapDbExamResultRow(r as Record<string, unknown>)
      );
      await syncResultsStoreAtomic(cloudResults);
      details.exam_results = resRes.data.length;
    }

    if (staffRes.error) {
      if (isMissingTableError(staffRes.error)) {
        errors.push('staff_accounts: Tabel belum dibuat di Supabase (jalankan Skema SQL terlebih dahulu).');
      } else {
        errors.push(`staff_accounts: ${staffRes.error}`);
      }
    } else {
      details.staff_accounts = staffRes.data.length;
      if (staffRes.data.length > 0) {
        const existingStaff = await idbGetAll<StaffAccount>(STORES.STAFF_ACCOUNTS);
        const existingByUser = new Map(
          existingStaff.map((e) => [e.userId.trim().toLowerCase(), e])
        );
        const mappedStaff: StaffAccount[] = staffRes.data.map((s) => {
          const userId = String(s.user_id || '');
          const localPrev = existingByUser.get(userId.trim().toLowerCase());
          const rawPwd = typeof s.password_hash === 'string' ? s.password_hash : '';
          return {
            id: String(s.id),
            userId,
            name: String(s.name || ''),
            password: rawPwd || localPrev?.password || '__CLOUD_MANAGED__',
            roleType: s.role_type as StaffAccount['roleType'],
            roleLabel: String(s.role_label || 'Staff'),
            allowedTabs: Array.isArray(s.allowed_tabs)
              ? (s.allowed_tabs as StaffAccount['allowedTabs'])
              : [],
            assignedSubjects: Array.isArray(s.assigned_subjects)
              ? (s.assigned_subjects as string[])
              : [],
            restrictToAssignedSubjects: Boolean(s.restrict_to_assigned_subjects),
            isActive: Boolean(s.is_active),
            createdAt: String(s.created_at || timestamp),
          };
        });
        const hasCloudAdmin = mappedStaff.some(
          (s) => s.userId.trim().toLowerCase() === 'admin'
        );
        if (!hasCloudAdmin) {
          const localAdmin = existingStaff.find(
            (s) => s.userId.trim().toLowerCase() === 'admin'
          );
          if (localAdmin) {
            mappedStaff.unshift(localAdmin);
          }
        }
        await idbPutStaffSafe(mappedStaff, true);
      }
    }

    if (adminClient) {
      const qFetch = await fetchAllQuestionsFromSupabaseAdmin(adminClient);
      if (qFetch.error) {
        errors.push(`questions: ${qFetch.error}`);
      } else {
        await idbPutMany(STORES.QUESTIONS, qFetch.questions, true);
        details.questions = qFetch.questions.length;
      }
    } else if (svcValidation.hasKey && !svcValidation.valid) {
      errors.push(`questions (Service Role Key): ${svcValidation.reason}`);
    }

    if (errors.some((e) => e.toLowerCase().includes('permission denied'))) {
      errors.push(
        'Solusi SQL: Error "permission denied for table ..." berarti role database (anon / service_role) belum diberi hak akses GRANT di Supabase. Buka tab "Skema SQL & RLS" → Salin seluruh Skrip SQL terbaru → tempel & Run di Supabase SQL Editor.'
      );
    }

    if (errors.length === 0) {
      setLastSyncTimestamp(timestamp);
    }
    broadcastDataChange('supabase_pull_detailed');

    const totalPulled = Object.values(details).reduce((acc, n) => acc + n, 0);
    return {
      ok: errors.length === 0,
      action: 'Pull Cloud → Lokal',
      timestamp,
      summary:
        errors.length === 0
          ? `Berhasil menarik ${totalPulled} data dari PostgreSQL Supabase ke cache lokal.`
          : `Pull selesai dengan ${errors.length} peringatan/kendala tabel.`,
      details,
      errors,
    };
  } catch (err) {
    return {
      ok: false,
      action: 'Pull Cloud → Lokal',
      timestamp,
      summary: 'Terjadi kesalahan saat menarik data dari Supabase.',
      details,
      errors: [err instanceof Error ? err.message : 'Network error'],
    };
  }
}

export async function pushAllToSupabase(): Promise<SyncOperationReport> {
  const timestamp = new Date().toISOString();
  if (!isLiveSupabaseConfigured()) {
    return {
      ok: false,
      action: 'Push Lokal → Cloud',
      timestamp,
      summary: 'Koneksi Supabase Live belum dikonfigurasi.',
      details: {},
      errors: ['Masukkan Project URL & Anon Key Supabase live terlebih dahulu.'],
    };
  }

  await ensureInitialized();
  const supabase = getSupabaseClient();
  const adminClient = getSupabaseAdminClient();
  const errors: string[] = [];
  const details: Record<string, number> = {
    school_profile: 0,
    staff_accounts: 0,
    exam_schedules: 0,
    participants: 0,
    questions: 0,
    exam_results: 0,
  };

  try {
    const [profile, schedules, participants, questions, results, staffAccounts] = await Promise.all([
      idbGet<SchoolProfile>(STORES.META, 'default'),
      idbGetAll<ExamSchedule>(STORES.SCHEDULES),
      idbGetAll<Participant>(STORES.PARTICIPANTS),
      idbGetAll<Question>(STORES.QUESTIONS),
      idbGetAll<ExamResult>(STORES.RESULTS),
      idbGetAll<StaffAccount>(STORES.STAFF_ACCOUNTS),
    ]);

    if (profile) {
      const isPlaceholder = !profile.adminPassword || profile.adminPassword === '__CLOUD_MANAGED__';
      const hashedAdminPwd = isPlaceholder ? null : await hashPassword(profile.adminPassword);
      if (adminClient) {
        const row: Record<string, unknown> = {
          id: 'default',
          school_name: profile.schoolName,
          address: profile.address,
          academic_year: profile.academicYear,
          principal_name: profile.principalName,
          committee_chair_name: profile.committeeChairName,
          exam_title: profile.examTitle,
          logo_data_url: profile.logoDataUrl,
          updated_at: profile.updatedAt || timestamp,
        };
        if (hashedAdminPwd) {
          row.admin_password = hashedAdminPwd;
        }
        const { error } = await adminClient.from('school_profile').upsert(row);
        if (error) errors.push(`school_profile: ${error.message}`);
        else details.school_profile = 1;
      } else {
        const { error: rpcErr } = await supabase.rpc('staff_upsert_school_profile', {
          ...getStaffRpcAuthArgs(),
          p_school_name: profile.schoolName,
          p_address: profile.address,
          p_academic_year: profile.academicYear,
          p_principal_name: profile.principalName,
          p_committee_chair_name: profile.committeeChairName,
          p_exam_title: profile.examTitle,
          p_logo_data_url: profile.logoDataUrl,
          p_admin_password_hash: hashedAdminPwd,
          p_updated_at: profile.updatedAt || timestamp,
        });
        if (!rpcErr) {
          details.school_profile = 1;
        } else if (isRpcSignatureMismatchError(rpcErr.message)) {
          const { error } = await supabase.from('school_profile').upsert({
            id: 'default',
            school_name: profile.schoolName,
            address: profile.address,
            academic_year: profile.academicYear,
            principal_name: profile.principalName,
            committee_chair_name: profile.committeeChairName,
            exam_title: profile.examTitle,
            logo_data_url: profile.logoDataUrl,
            admin_password: hashedAdminPwd || (await hashPassword('admin123')),
            updated_at: profile.updatedAt || timestamp,
          });
          if (error) errors.push(`school_profile: ${error.message}`);
          else details.school_profile = 1;
        } else {
          errors.push(`school_profile: ${rpcErr.message}`);
        }
      }
    }

    if (schedules.length > 0) {
      const { error } = await supabase.from('exam_schedules').upsert(
        schedules.map((s) => ({
          id: s.id,
          title: s.title,
          subject: s.subject,
          kkm: s.kkm,
          duration_minutes: s.durationMinutes,
          target_classes: s.targetClasses,
          is_active: s.isActive,
          randomize_questions: Boolean(s.randomizeQuestions ?? false),
          max_tab_switches: s.maxTabSwitches,
          created_at: s.createdAt,
        }))
      );
      if (error) errors.push(`exam_schedules: ${error.message}`);
      else details.exam_schedules = schedules.length;
    }

    if (participants.length > 0) {
      const CHUNK = 50;
      let pushedParts = 0;
      for (let i = 0; i < participants.length; i += CHUNK) {
        const chunk = participants.slice(i, i + CHUNK);
        const { error } = await supabase.from('participants').upsert(
          chunk.map((p) => ({
            id: p.id,
            participant_number: p.participantNumber.trim().toUpperCase(),
            token: p.token,
            full_name: p.fullName,
            class_name: p.className,
            is_active: p.isActive,
            created_at: p.createdAt,
          })),
          { onConflict: 'participant_number' }
        );
        if (error) {
          errors.push(`participants (batch ${i / CHUNK + 1}): ${error.message}`);
        } else {
          pushedParts += chunk.length;
        }
      }
      details.participants = pushedParts;
    }

    if (staffAccounts.length > 0) {
      if (adminClient) {
        const directRows: Array<Record<string, unknown>> = [];
        const placeholderRows: StaffAccount[] = [];
        for (const s of staffAccounts) {
          const isPlaceholder = !s.password || s.password === '__CLOUD_MANAGED__';
          if (isPlaceholder) {
            placeholderRows.push(s);
          } else {
            directRows.push({
              id: s.id,
              user_id: s.userId,
              name: s.name,
              password_hash: await hashPassword(s.password),
              role_type: s.roleType,
              role_label: s.roleLabel,
              allowed_tabs: s.allowedTabs,
              assigned_subjects: s.assignedSubjects,
              restrict_to_assigned_subjects: s.restrictToAssignedSubjects,
              is_active: s.isActive,
              created_at: s.createdAt,
            });
          }
        }
        let staffSuccess = 0;
        if (directRows.length > 0) {
          const { error: staffErr } = await adminClient
            .from('staff_accounts')
            .upsert(directRows, { onConflict: 'user_id' });
          if (staffErr) {
            if (isMissingTableError(staffErr.message)) {
              errors.push('staff_accounts: Tabel belum dibuat di Supabase (jalankan Skema SQL terlebih dahulu).');
            } else {
              errors.push(`staff_accounts: ${staffErr.message}`);
            }
          } else {
            staffSuccess += directRows.length;
          }
        }
        for (const s of placeholderRows) {
          const { error: updErr } = await adminClient
            .from('staff_accounts')
            .update({
              name: s.name,
              role_type: s.roleType,
              role_label: s.roleLabel,
              allowed_tabs: s.allowedTabs,
              assigned_subjects: s.assignedSubjects,
              restrict_to_assigned_subjects: s.restrictToAssignedSubjects,
              is_active: s.isActive,
            })
            .eq('user_id', s.userId);
          if (!updErr) staffSuccess += 1;
        }
        details.staff_accounts = staffSuccess;
      } else {
        let staffSuccess = 0;
        let usedLegacy = false;
        for (const s of staffAccounts) {
          const isPlaceholder = !s.password || s.password === '__CLOUD_MANAGED__';
          const pwdHash = isPlaceholder ? '__CLOUD_MANAGED__' : await hashPassword(s.password);
          const { error: rpcErr } = await supabase.rpc('staff_upsert_account', {
            ...getStaffRpcAuthArgs(),
            p_id: s.id,
            p_target_user_id: s.userId,
            p_name: s.name,
            p_password_hash: pwdHash,
            p_role_type: s.roleType,
            p_role_label: s.roleLabel,
            p_allowed_tabs: s.allowedTabs,
            p_assigned_subjects: s.assignedSubjects,
            p_restrict_to_assigned_subjects: s.restrictToAssignedSubjects,
            p_is_active: s.isActive,
            p_created_at: s.createdAt,
          });
          if (!rpcErr) {
            staffSuccess += 1;
          } else if (isRpcSignatureMismatchError(rpcErr.message)) {
            usedLegacy = true;
            break;
          } else {
            errors.push(`staff_accounts (${s.userId}): ${rpcErr.message}`);
          }
        }
        if (usedLegacy) {
          const hashedPayload = await Promise.all(
            staffAccounts
              .filter((s) => s.password && s.password !== '__CLOUD_MANAGED__')
              .map(async (s) => ({
                id: s.id,
                user_id: s.userId,
                name: s.name,
                password_hash: await hashPassword(s.password),
                role_type: s.roleType,
                role_label: s.roleLabel,
                allowed_tabs: s.allowedTabs,
                assigned_subjects: s.assignedSubjects,
                restrict_to_assigned_subjects: s.restrictToAssignedSubjects,
                is_active: s.isActive,
                created_at: s.createdAt,
              }))
          );
          const { error: staffErr } = await supabase
            .from('staff_accounts')
            .upsert(hashedPayload, { onConflict: 'user_id' });
          if (staffErr) errors.push(`staff_accounts: ${staffErr.message}`);
          else staffSuccess = hashedPayload.length;
        }
        details.staff_accounts = staffSuccess;
      }
    }

    if (questions.length > 0) {
      const CHUNK = 50;
      let pushedQuestions = 0;
      for (let i = 0; i < questions.length; i += CHUNK) {
        const chunk = questions.slice(i, i + CHUNK);
        const extendedPayload = chunk.map((q) => buildQuestionDbRow(q, true));

        if (adminClient) {
          let { error: adminErr } = await adminClient
            .from('questions')
            .upsert(extendedPayload, { onConflict: 'id' });
          if (adminErr && isMissingQuestionColumnsError(adminErr.message)) {
            const legacyPayload = chunk.map((q) => buildQuestionDbRow(q, false));
            const retry = await adminClient
              .from('questions')
              .upsert(legacyPayload, { onConflict: 'id' });
            adminErr = retry.error;
          }
          if (adminErr) {
            errors.push(`questions (batch ${i / CHUNK + 1}): ${adminErr.message}`);
          } else {
            pushedQuestions += chunk.length;
          }
        } else {
          let { error: rpcError } = await supabase.rpc('upsert_questions_batch', {
            p_questions: extendedPayload,
            ...getStaffRpcAuthArgs(),
          });
          if (rpcError && isRpcSignatureMismatchError(rpcError.message)) {
            const legacyCall = await supabase.rpc('upsert_questions_batch', {
              p_questions: extendedPayload,
            });
            rpcError = legacyCall.error;
          }
          if (rpcError && isMissingQuestionColumnsError(rpcError.message)) {
            const legacyPayload = chunk.map((q) => buildQuestionDbRow(q, false));
            let retry = await supabase.rpc('upsert_questions_batch', {
              p_questions: legacyPayload,
              ...getStaffRpcAuthArgs(),
            });
            if (retry.error && isRpcSignatureMismatchError(retry.error.message)) {
              retry = await supabase.rpc('upsert_questions_batch', {
                p_questions: legacyPayload,
              });
            }
            rpcError = retry.error;
          }
          if (rpcError) {
            errors.push(`questions (RPC batch ${i / CHUNK + 1}): ${rpcError.message}`);
          } else {
            pushedQuestions += chunk.length;
          }
        }
      }
      details.questions = pushedQuestions;
    }

    if (results.length > 0) {
      const CHUNK = 50;
      let pushedResults = 0;
      const updatedLocalResults: ExamResult[] = [];
      for (let i = 0; i < results.length; i += CHUNK) {
        const chunk = results.slice(i, i + CHUNK);
        const buildRow = (r: ExamResult, includeQuestionIds: boolean) => {
          const row: Record<string, unknown> = {
            id: r.id,
            participant_id: r.participantId,
            participant_number: r.participantNumber.trim().toUpperCase(),
            student_name: r.studentName,
            class_name: r.className,
            exam_id: r.examId,
            exam_title: r.examTitle,
            subject: r.subject,
            answers: r.answers,
            flagged_questions: r.flaggedQuestions,
            correct_count: r.correctCount,
            total_questions: r.totalQuestions,
            score: r.score,
            tab_switch_count: r.tabSwitchCount,
            status: r.status,
            started_at: r.startedAt,
            submitted_at: r.submittedAt,
            updated_at: timestamp,
          };
          if (includeQuestionIds) {
            row.question_ids =
              r.questionIds && r.questionIds.length > 0 ? r.questionIds : null;
          }
          return row;
        };

        let writeErrMessage: string | undefined;
        if (adminClient) {
          let { error } = await adminClient
            .from('exam_results')
            .upsert(chunk.map((r) => buildRow(r, true)), {
              onConflict: 'participant_number,exam_id',
            });
          if (error && error.message.includes('question_ids')) {
            const retry = await adminClient
              .from('exam_results')
              .upsert(chunk.map((r) => buildRow(r, false)), {
                onConflict: 'participant_number,exam_id',
              });
            error = retry.error;
          }
          writeErrMessage = error?.message;
        } else {
          const { error: rpcErr } = await supabase.rpc('staff_upsert_exam_results_batch', {
            ...getStaffRpcAuthArgs(),
            p_results: chunk.map((r) => buildRow(r, true)),
          });
          if (rpcErr && isRpcSignatureMismatchError(rpcErr.message)) {
            let { error } = await supabase
              .from('exam_results')
              .upsert(chunk.map((r) => buildRow(r, true)), {
                onConflict: 'participant_number,exam_id',
              });
            if (error && error.message.includes('question_ids')) {
              const retry = await supabase
                .from('exam_results')
                .upsert(chunk.map((r) => buildRow(r, false)), {
                  onConflict: 'participant_number,exam_id',
                });
              error = retry.error;
            }
            writeErrMessage = error?.message;
          } else {
            writeErrMessage = rpcErr?.message;
          }
        }

        if (writeErrMessage) {
          errors.push(`exam_results (batch ${i / CHUNK + 1}): ${writeErrMessage}`);
        } else {
          pushedResults += chunk.length;
          chunk.forEach((r) =>
            updatedLocalResults.push({
              ...r,
              syncStatus: 'synced',
              needsServerScoring: undefined,
            })
          );
        }
      }
      if (updatedLocalResults.length > 0) {
        await idbPutMany(STORES.RESULTS, updatedLocalResults);
      }
      details.exam_results = pushedResults;
    }

    if (errors.some((e) => e.toLowerCase().includes('permission denied'))) {
      errors.push(
        'Solusi SQL: Error "permission denied for table ..." berarti hak akses GRANT/RLS pada PostgreSQL Supabase belum dijalankan. Buka tab "Skema SQL & RLS" → Salin seluruh Skrip SQL terbaru → tempel & Run di Supabase SQL Editor.'
      );
    }

    if (errors.length === 0) {
      setLastSyncTimestamp(timestamp);
    }
    broadcastDataChange('supabase_push_all');

    const totalPushed = Object.values(details).reduce((acc, n) => acc + n, 0);
    return {
      ok: errors.length === 0,
      action: 'Push Lokal → Cloud',
      timestamp,
      summary:
        errors.length === 0
          ? `Berhasil mengunggah ${totalPushed} record lokal ke PostgreSQL Supabase.`
          : `Push selesai dengan ${errors.length} error.`,
      details,
      errors,
    };
  } catch (err) {
    return {
      ok: false,
      action: 'Push Lokal → Cloud',
      timestamp,
      summary: 'Gagal mengirim data lokal ke Supabase.',
      details,
      errors: [err instanceof Error ? err.message : 'Network error'],
    };
  }
}

export async function flushPendingQueueDetailed(): Promise<SyncOperationReport> {
  const timestamp = new Date().toISOString();
  if (!isLiveSupabaseConfigured()) {
    return {
      ok: false,
      action: 'Flush Antrean Pending',
      timestamp,
      summary: 'Koneksi Supabase Live belum dikonfigurasi.',
      details: { flushed: 0 },
      errors: ['Masukkan Project URL & Anon Key Supabase live terlebih dahulu.'],
    };
  }

  const results = await idbGetAll<ExamResult>(STORES.RESULTS);
  const pending = results.filter((r) => r.syncStatus === 'pending');
  let flushed = 0;
  const errors: string[] = [];

  const CHUNK = 8;
  for (let i = 0; i < pending.length; i += CHUNK) {
    const chunk = pending.slice(i, i + CHUNK);
    await Promise.all(
      chunk.map(async (item) => {
        if (shouldRetryServerScoring(item)) {
          const finalized = await finalizeExamResultRecord(item, {
            skipIfFinalized: false,
            keepInProgressIfUnscored: true,
            broadcast: false,
          });
          if (finalized.syncStatus === 'synced') {
            flushed += 1;
          } else if (finalized.status === 'in_progress' && finalized.needsServerScoring) {
            errors.push(
              `Menunggu koneksi/soal server untuk menilai hasil ${item.participantNumber} (${item.subject})`
            );
          } else {
            errors.push(
              `Gagal menilai/mengunggah hasil ${item.participantNumber} (${item.subject})`
            );
          }
          return;
        }

        const pushRes = await pushResultToSupabase(item);
        if (pushRes.finalizedFromServer) {
          await idbPut(STORES.RESULTS, pushRes.finalizedFromServer);
          flushed += 1;
        } else if (pushRes.ok) {
          item.syncStatus = 'synced';
          await idbPut(STORES.RESULTS, item);
          flushed += 1;
        } else {
          errors.push(`Gagal mengunggah hasil ${item.participantNumber} (${item.subject})`);
        }
      })
    );
  }

  if (flushed > 0) {
    setLastSyncTimestamp(timestamp);
    broadcastDataChange('sync_flushed');
  }

  return {
    ok: errors.length === 0,
    action: 'Flush Antrean Pending',
    timestamp,
    summary:
      pending.length === 0
        ? 'Tidak ada antrean hasil ujian pending yang perlu diunggah.'
        : `Berhasil mengunggah ${flushed} dari ${pending.length} hasil ujian tertunda ke cloud.`,
    details: { pending_total: pending.length, flushed },
    errors,
  };
}

export async function runTwoWaySync(): Promise<SyncOperationReport> {
  const timestamp = new Date().toISOString();
  if (!isLiveSupabaseConfigured()) {
    return {
      ok: false,
      action: 'Sinkronisasi Dua Arah',
      timestamp,
      summary: 'Koneksi Supabase Live belum dikonfigurasi.',
      details: {},
      errors: ['Masukkan Project URL & Anon Key Supabase live terlebih dahulu.'],
    };
  }

  const flushReport = await flushPendingQueueDetailed();
  const pullReport = await pullAllFromSupabaseDetailed();
  const combinedErrors = [...flushReport.errors, ...pullReport.errors];

  if (combinedErrors.length === 0) {
    setLastSyncTimestamp(timestamp);
  }

  return {
    ok: combinedErrors.length === 0,
    action: 'Sinkronisasi Dua Arah',
    timestamp,
    summary:
      combinedErrors.length === 0
        ? `Sinkronisasi 2-arah selesai: ${flushReport.details.flushed || 0} antrean diunggah & data cloud terbaru ditarik ke lokal.`
        : `Sinkronisasi 2-arah selesai dengan ${combinedErrors.length} kendala.`,
    details: {
      flushed_pending: flushReport.details.flushed || 0,
      ...pullReport.details,
    },
    errors: combinedErrors,
  };
}

export interface LocalBackupSnapshot {
  app: string;
  version: number;
  exportedAt: string;
  profile: SchoolProfile;
  participants: Participant[];
  schedules: ExamSchedule[];
  questions: Question[];
  results: ExamResult[];
  staffAccounts: StaffAccount[];
}

export async function exportLocalBackupSnapshot(): Promise<LocalBackupSnapshot> {
  await ensureInitialized();
  const [profile, participants, schedules, questions, results, staffAccounts] = await Promise.all([
    idbGet<SchoolProfile>(STORES.META, 'default'),
    idbGetAll<Participant>(STORES.PARTICIPANTS),
    idbGetAll<ExamSchedule>(STORES.SCHEDULES),
    idbGetAll<Question>(STORES.QUESTIONS),
    idbGetAll<ExamResult>(STORES.RESULTS),
    idbGetAll<StaffAccount>(STORES.STAFF_ACCOUNTS),
  ]);

  return {
    app: 'Nusantara CBT',
    version: 2,
    exportedAt: new Date().toISOString(),
    profile: profile || SEED_SCHOOL_PROFILE,
    participants,
    schedules,
    questions,
    results,
    staffAccounts,
  };
}

export async function restoreLocalBackupSnapshot(
  rawPayload: unknown
): Promise<{ ok: boolean; message: string; counts?: Record<string, number> }> {
  if (!rawPayload || typeof rawPayload !== 'object') {
    return { ok: false, message: 'Format file JSON backup tidak valid.' };
  }
  const snap = rawPayload as Partial<LocalBackupSnapshot>;
  if (
    !snap.profile ||
    !Array.isArray(snap.participants) ||
    !Array.isArray(snap.schedules) ||
    !Array.isArray(snap.questions) ||
    !Array.isArray(snap.results)
  ) {
    return {
      ok: false,
      message:
        'Struktur backup tidak lengkap (wajib memuat profile, participants, schedules, questions, results).',
    };
  }

  await idbPut(STORES.META, { ...snap.profile, id: 'default' });
  await idbPutParticipantsSafe(snap.participants, true);
  await idbPutMany(STORES.SCHEDULES, snap.schedules, true);
  await idbPutMany(STORES.QUESTIONS, snap.questions, true);
  await idbPutMany(STORES.RESULTS, snap.results, true);
  if (Array.isArray(snap.staffAccounts) && snap.staffAccounts.length > 0) {
    await idbPutStaffSafe(snap.staffAccounts, true);
  }
  clearActiveSessionLocal();
  confirmedQuestionIdsSyncSet.clear();
  lastAdminResultsDeltaIso = null;
  invalidateStoreCache();
  broadcastDataChange('backup_restored');

  return {
    ok: true,
    message: `Backup berhasil dipulihkan (${snap.participants.length} peserta, ${snap.questions.length} soal, ${snap.results.length} hasil ujian).`,
    counts: {
      participants: snap.participants.length,
      schedules: snap.schedules.length,
      questions: snap.questions.length,
      results: snap.results.length,
    },
  };
}
