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
  questionContainsBase64Image,
  registerQuestionImageTicketRequester,
  validateServiceRoleKey,
} from '@/src/lib/supabase';
import {
  countAnsweredEntries,
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
const ACTIVE_ANSWERS_BACKUP_KEY = 'cbt_active_answers_backup_v1';
const SERVER_CLOCK_CACHE_KEY = 'cbt_server_clock_cache_v1';
const STUDENT_PULL_COOLDOWN_KEY = 'cbt_student_pull_ts_v1';
const FLUSH_QUEUE_LOCK_KEY = 'cbt_lock_flush_pending_v1';
const CHANNEL_NAME = 'nusantara_cbt_sync';

type SyncListener = (topic?: string) => void;

const listeners = new Set<SyncListener>();
let channel: BroadcastChannel | null = null;
let resultsKeyMapCache: Map<
  string,
  { id: string; syncStatus?: string; finalized: boolean; fingerprint: string }
> | null = null;
let resultsSortedCache: ExamResult[] | null = null;
let schedulesSortedCache: ExamSchedule[] | null = null;
let participantsSortedCache: Participant[] | null = null;
let questionsSortedCache: Question[] | null = null;

// Kredensial staf aktif disimpan hanya di memori JS (tidak pernah di localStorage) untuk otorisasi RPC admin
let activeStaffCredentials: { userId: string; passwordHash: string } | null = null;
const confirmedQuestionIdsSyncSet = new Set<string>();
const confirmedCloudSessionKeys = new Set<string>();
const lastCloudProgressConfirmedAt = new Map<string, number>();
const lastLivePollCloudCheckAt = new Map<string, number>();
const LIVE_POLL_RECENT_SYNC_SKIP_MS = 50_000;
const LIVE_POLL_MAX_SKIP_WINDOW_MS = 180_000;
const finalizingSessionKeys = new Set<string>();
const finalizingSessionPromises = new Map<string, Promise<ExamResult>>();
const RECENT_PREFLIGHT_CACHE_TTL_MS = 180_000;
const RECENT_STUDENT_RESULTS_CACHE_TTL_MS = 90_000;
const recentlyVerifiedParticipants = new Map<
  string,
  { participant: Participant; verifiedAt: number }
>();
const recentlyVerifiedStudentResults = new Map<
  string,
  { results: ExamResult[]; verifiedAt: number }
>();
const verifiedSchedulesCache = new Map<
  string,
  { schedule: ExamSchedule; verifiedAt: number }
>();
const inFlightSchedulePreflight = new Map<
  string,
  Promise<{ data: Record<string, unknown> | null; error?: { message: string } | null }>
>();
const studentQuestionsCache = new Map<
  string,
  { questions: StudentQuestion[]; cachedAt: number }
>();
const inFlightStudentQuestions = new Map<string, Promise<StudentQuestion[]>>();
const STUDENT_QUESTIONS_CACHE_TTL_MS = 900_000;
let studentBootstrapRpcAvailable: boolean | null = null;
let studentLoginBundleRpcAvailable: boolean | null = null;
const verifiedParticipantTokens = new Map<string, string>();

export function normalizeParticipantNumber(raw: string | null | undefined): string {
  return String(raw ?? '').trim().toUpperCase();
}

function rememberParticipantToken(
  rawNumber: string | null | undefined,
  rawToken: string | null | undefined
): void {
  const normNum = normalizeParticipantNumber(rawNumber);
  const normToken = String(rawToken ?? '').trim().toUpperCase();
  if (normNum && normToken) {
    verifiedParticipantTokens.set(normNum, normToken);
  }
}

async function resolveParticipantToken(
  rawNumber: string | null | undefined,
  explicitToken?: string | null
): Promise<string | null> {
  const normExplicit = String(explicitToken ?? '').trim().toUpperCase();
  const normNum = normalizeParticipantNumber(rawNumber);
  if (normExplicit) {
    if (normNum) verifiedParticipantTokens.set(normNum, normExplicit);
    return normExplicit;
  }
  if (!normNum) return null;

  const memToken = verifiedParticipantTokens.get(normNum);
  if (memToken) return memToken;

  if (
    cachedActiveSession &&
    normalizeParticipantNumber(cachedActiveSession.participant.participantNumber) === normNum
  ) {
    const activeToken = String(cachedActiveSession.participant.token || '').trim().toUpperCase();
    if (activeToken) {
      verifiedParticipantTokens.set(normNum, activeToken);
      return activeToken;
    }
  }

  const recentPart = recentlyVerifiedParticipants.get(normNum);
  if (recentPart?.participant.token) {
    const t = recentPart.participant.token.trim().toUpperCase();
    if (t) {
      verifiedParticipantTokens.set(normNum, t);
      return t;
    }
  }

  try {
    const localParts = await idbGetAll<Participant>(STORES.PARTICIPANTS);
    const matched = localParts.find(
      (p) => normalizeParticipantNumber(p.participantNumber) === normNum && Boolean(p.token)
    );
    if (matched?.token) {
      const t = matched.token.trim().toUpperCase();
      if (t) {
        verifiedParticipantTokens.set(normNum, t);
        return t;
      }
    }
  } catch {
    // Ignore IDB read error
  }
  return null;
}

function areTimestampsEqual(a?: string | null, b?: string | null): boolean {
  const sa = String(a ?? '').trim();
  const sb = String(b ?? '').trim();
  if (!sa || !sb) return false;
  if (sa === sb) return true;
  const ma = Date.parse(sa);
  const mb = Date.parse(sb);
  if (!Number.isFinite(ma) || !Number.isFinite(mb)) return false;
  return Math.abs(ma - mb) < 1000;
}

function makeSessionSyncKey(participantNumber: string, examId: string): string {
  return `${normalizeParticipantNumber(participantNumber)}::${examId}`;
}

function isExamResultFinalized(r: ExamResult | null | undefined): boolean {
  if (!r) return false;
  return r.status === 'submitted' || (r.status === 'flagged' && r.submittedAt !== null);
}

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
    passwordHash: isPasswordHashed(pwdHash) ? pwdHash.toLowerCase() : pwdHash,
  };
}

interface StaffRpcAuthArgs {
  p_staff_user_id: string | null;
  p_staff_password_sha256: string | null;
}

async function normalizePasswordToSha256(raw: string): Promise<string | null> {
  const clean = (raw || '').trim();
  if (!clean || clean === '__CLOUD_MANAGED__') return null;
  if (isPasswordHashed(clean)) return clean.toLowerCase();
  if (/^[0-9a-f]{64}$/i.test(clean)) return `sha256$${clean.toLowerCase()}`;
  return (await hashPassword(clean)).toLowerCase();
}

/**
 * Menyelesaikan kredensial staf (`p_staff_user_id` & `p_staff_password_sha256`) yang valid untuk semua RPC admin.
 * Termasuk normalisasi hash SHA-256 dan fallback ke `school_profile.adminPassword` bila akun `admin` memakai kredensial utama.
 */
async function resolveStaffRpcAuthArgs(): Promise<StaffRpcAuthArgs> {
  if (activeStaffCredentials?.userId) {
    const activeSha = await normalizePasswordToSha256(activeStaffCredentials.passwordHash);
    if (activeSha) {
      activeStaffCredentials.passwordHash = activeSha;
      return {
        p_staff_user_id: activeStaffCredentials.userId.trim(),
        p_staff_password_sha256: activeSha,
      };
    }
  }

  try {
    const preferredUserId = activeStaffCredentials?.userId?.trim().toLowerCase() || 'admin';
    const staffList = await idbGetAll<StaffAccount>(STORES.STAFF_ACCOUNTS);
    const matchedStaff = staffList.find(
      (s) => s.isActive && s.userId.trim().toLowerCase() === preferredUserId
    );
    if (matchedStaff) {
      const staffSha = await normalizePasswordToSha256(matchedStaff.password);
      if (staffSha) {
        return {
          p_staff_user_id: matchedStaff.userId.trim(),
          p_staff_password_sha256: staffSha,
        };
      }
    }

    if (preferredUserId === 'admin') {
      const profile = await idbGet<SchoolProfile>(STORES.META, 'default');
      if (profile?.adminPassword) {
        const profSha = await normalizePasswordToSha256(profile.adminPassword);
        if (profSha) {
          return {
            p_staff_user_id: 'admin',
            p_staff_password_sha256: profSha,
          };
        }
      }
    }
  } catch {
    // Ignore local IDB read error; fall back to null args
  }

  return {
    p_staff_user_id: activeStaffCredentials?.userId?.trim() || null,
    p_staff_password_sha256: null,
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

// Daftarkan penerbit tiket upload gambar soal terverifikasi agar upload Storage bekerja untuk semua staf Bank Soal
registerQuestionImageTicketRequester(async (prefix: string, ext: string) => {
  try {
    if (!isLiveSupabaseConfigured()) return { path: null };
    const supabase = getSupabaseClient();
    const authArgs = await resolveStaffRpcAuthArgs();
    const { data, error } = await supabase.rpc('staff_issue_image_upload_ticket', {
      ...authArgs,
      p_prefix: prefix,
      p_ext: ext,
    });
    if (error) {
      return {
        path: null,
        error: error.message,
        rpcMissing: isRpcSignatureMismatchError(error.message),
      };
    }
    const issuedPath = typeof data === 'string' ? data.trim() : '';
    return issuedPath ? { path: issuedPath } : { path: null, error: 'Tiket path upload kosong.' };
  } catch (err) {
    return {
      path: null,
      error: err instanceof Error ? err.message : 'Gagal meminta tiket upload gambar.',
    };
  }
});

function isDigestRpcBugError(
  err: { code?: string; message?: string } | null | undefined
): boolean {
  if (!err) return false;
  const code = String(err.code || '').trim();
  const msg = String(err.message || '').toLowerCase();
  return code === '42883' || (msg.includes('digest') && msg.includes('does not exist'));
}

function isNetworkOrOfflineError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const msg = (
    err instanceof Error
      ? err.message
      : typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message?: unknown }).message || '')
        : String(err || '')
  ).toLowerCase();
  return (
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('network request failed') ||
    msg.includes('load failed') ||
    msg.includes('err_internet_disconnected') ||
    msg.includes('timeout') ||
    msg.includes('aborted')
  );
}

function isTransientServerOrNetworkError(err: unknown): boolean {
  if (isNetworkOrOfflineError(err)) return true;
  if (!err || typeof err !== 'object') {
    const raw = String(err || '').toLowerCase();
    return (
      raw.includes('503') ||
      raw.includes('502') ||
      raw.includes('504') ||
      raw.includes('429') ||
      raw.includes('pgrst003') ||
      raw.includes('connection pool') ||
      raw.includes('too many')
    );
  }
  const obj = err as { status?: unknown; code?: unknown; message?: unknown; details?: unknown };
  const status = Number(obj.status);
  if ([408, 429, 500, 502, 503, 504].includes(status)) return true;
  const code = String(obj.code || '').toUpperCase();
  if (['PGRST003', 'PGRST000', '57014', '53300', '08000', '08003', '08006', '40001'].includes(code)) {
    return true;
  }
  const combined = `${String(obj.message || '')} ${String(obj.details || '')}`.toLowerCase();
  return (
    combined.includes('connection pool') ||
    combined.includes('timed out acquiring') ||
    combined.includes('service unavailable') ||
    combined.includes('too many requests') ||
    combined.includes('too many connections') ||
    combined.includes('statement timeout') ||
    combined.includes('bad gateway') ||
    combined.includes('gateway timeout') ||
    combined.includes('rate limit') ||
    combined.includes('503') ||
    combined.includes('429')
  );
}

function isBrowserExplicitlyOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

async function retryTransientSupabaseCall<T extends { error?: unknown }>(
  fn: () => Promise<T>,
  options?: {
    backoffsMs?: number[];
    jitterMs?: number;
  }
): Promise<T> {
  const backoffs = options?.backoffsMs || [0, 350, 900];
  const jitterMax = options?.jitterMs ?? 450;
  let lastRes: T | null = null;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < backoffs.length; attempt++) {
    if (isBrowserExplicitlyOffline()) {
      if (lastRes) return lastRes;
      throw lastErr instanceof Error ? lastErr : new Error('Offline');
    }
    if (attempt > 0) {
      const waitMs = backoffs[attempt] + Math.floor(Math.random() * jitterMax);
      await new Promise((r) => setTimeout(r, waitMs));
      if (isBrowserExplicitlyOffline()) {
        if (lastRes) return lastRes;
        throw lastErr instanceof Error ? lastErr : new Error('Offline');
      }
    }
    try {
      const res = await fn();
      if (!res || !res.error) {
        return res;
      }
      lastRes = res;
      if (!isTransientServerOrNetworkError(res.error) || attempt === backoffs.length - 1) {
        return res;
      }
    } catch (err) {
      lastErr = err;
      if (!isTransientServerOrNetworkError(err) || attempt === backoffs.length - 1) {
        throw err;
      }
    }
  }
  if (lastRes) return lastRes;
  throw lastErr instanceof Error ? lastErr : new Error('Transient request failed');
}

function invalidateStoreCache(storeName?: string): void {
  if (!storeName || storeName === STORES.RESULTS) {
    resultsKeyMapCache = null;
    resultsSortedCache = null;
    recentlyVerifiedStudentResults.clear();
  }
  if (!storeName || storeName === STORES.SCHEDULES) {
    schedulesSortedCache = null;
    verifiedSchedulesCache.clear();
  }
  if (!storeName || storeName === STORES.PARTICIPANTS) {
    participantsSortedCache = null;
    recentlyVerifiedParticipants.clear();
  }
  if (!storeName || storeName === STORES.QUESTIONS) {
    questionsSortedCache = null;
    studentQuestionsCache.clear();
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
  const answeredCountSig =
    typeof r.answeredCount === 'number' && Number.isFinite(r.answeredCount)
      ? r.answeredCount
      : countAnsweredEntries(r.answers);
  const flagsSig = (r.flaggedQuestions || []).join(',');
  const qIdsSig = (r.questionIds || []).join(',');
  return `${r.id}|${r.status}|${r.submittedAt || ''}|${r.score}|${r.correctCount}|${r.totalQuestions}|${answeredCountSig}|${r.tabSwitchCount}|${r.syncStatus || ''}|${r.examId}|${r.subject}|${flagsSig}|${qIdsSig}|${answersSig}`;
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
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      dbPromise = null;
      reject(err);
      return;
    }
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
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    req.onblocked = () => {
      dbPromise = null;
      reject(new Error('IndexedDB diblokir oleh tab lain.'));
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
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
  return value.trim().toLowerCase().startsWith(HASH_PREFIX);
}

export async function hashPassword(raw: string): Promise<string> {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (isPasswordHashed(trimmed)) {
    return HASH_PREFIX + trimmed.slice(HASH_PREFIX.length).toLowerCase();
  }
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
    return hashed.toLowerCase() === cleanStored.toLowerCase();
  }
  if (/^[a-f0-9]{64}$/i.test(cleanStored)) {
    const hashed = await hashPassword(cleanInput);
    return hashed.slice(HASH_PREFIX.length).toLowerCase() === cleanStored.toLowerCase();
  }
  return cleanInput === cleanStored;
}

// ============================================================================
// SERVER CLOCK OFFSET & MONOTONIC ANCHOR (ANTI MANIPULASI JAM PERANGKAT)
// ============================================================================
let serverClockOffsetMs = 0;
let lastClockSyncMs = 0;
let syncedServerEpochMs: number | null = null;
let syncedPerfNowMs: number | null = null;
let lastDriftResyncTriggerMs = 0;
let clockSyncInFlight: Promise<number> | null = null;

function getMonotonicPerfMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export function applyServerTimeSample(
  serverMs: number,
  wallMidpointMs: number,
  perfMidpointMs: number
): void {
  if (!Number.isFinite(serverMs)) return;
  serverClockOffsetMs = serverMs - wallMidpointMs;
  syncedServerEpochMs = serverMs;
  syncedPerfNowMs = perfMidpointMs;
  lastClockSyncMs = Date.now();
}

export function getServerNowMs(): number {
  const wallNow = Date.now() + serverClockOffsetMs;
  if (syncedServerEpochMs !== null && syncedPerfNowMs !== null) {
    const monotonicNow = syncedServerEpochMs + Math.max(0, getMonotonicPerfMs() - syncedPerfNowMs);
    const drift = wallNow - monotonicNow;
    // Jika jam OS dimundurkan (drift < -2 detik), tetap gunakan monotonicNow agar siswa tidak mendapat waktu ekstra.
    // Jika perangkat bangun dari sleep atau jam dimajukan jauh (> 15 detik), gunakan nilai terbesar & picu resync server.
    if (drift > 15_000 && Date.now() - lastDriftResyncTriggerMs > 15_000) {
      lastDriftResyncTriggerMs = Date.now();
      void syncServerClock(true);
    }
    return Math.max(monotonicNow, wallNow);
  }
  return wallNow;
}

export function getServerClockOffsetMs(): number {
  return serverClockOffsetMs;
}

const CROSS_TAB_CLOCK_CACHE_TTL_MS = 60_000;
const CROSS_TAB_CLOCK_FORCE_MIN_GAP_MS = 15_000;

function readSharedClockCache(): { offsetMs: number; serverEpochMs: number; syncedAt: number } | null {
  try {
    const raw = localStorage.getItem(SERVER_CLOCK_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<{
      offsetMs: number;
      serverEpochMs: number;
      syncedAt: number;
    }>;
    if (
      typeof parsed.offsetMs === 'number' &&
      Number.isFinite(parsed.offsetMs) &&
      typeof parsed.syncedAt === 'number' &&
      Number.isFinite(parsed.syncedAt)
    ) {
      return {
        offsetMs: parsed.offsetMs,
        serverEpochMs:
          typeof parsed.serverEpochMs === 'number' && Number.isFinite(parsed.serverEpochMs)
            ? parsed.serverEpochMs
            : parsed.syncedAt + parsed.offsetMs,
        syncedAt: parsed.syncedAt,
      };
    }
  } catch {
    // Ignore localStorage restrictions
  }
  return null;
}

function writeSharedClockCache(offsetMs: number, serverEpochMs: number): void {
  try {
    localStorage.setItem(
      SERVER_CLOCK_CACHE_KEY,
      JSON.stringify({ offsetMs, serverEpochMs, syncedAt: Date.now() })
    );
  } catch {
    // Ignore localStorage restrictions
  }
}

export async function syncServerClock(force = false): Promise<number> {
  if (!isLiveSupabaseConfigured()) return serverClockOffsetMs;
  const now = Date.now();
  if (!force && now - lastClockSyncMs < 300_000 && syncedServerEpochMs !== null) {
    return serverClockOffsetMs;
  }
  // Koordinasi lintas-tab: jika tab lain di perangkat yang sama baru saja menyinkronkan jam server,
  // pakai ulang offset terbaru agar 3-5 tab yang online serentak tidak menggandakan RPC get_server_time.
  const sharedClock = readSharedClockCache();
  if (sharedClock) {
    const cacheAgeMs = now - sharedClock.syncedAt;
    const thresholdMs = force ? CROSS_TAB_CLOCK_FORCE_MIN_GAP_MS : CROSS_TAB_CLOCK_CACHE_TTL_MS;
    if (cacheAgeMs >= 0 && cacheAgeMs < thresholdMs) {
      const estimatedServerMs = sharedClock.serverEpochMs + cacheAgeMs;
      applyServerTimeSample(estimatedServerMs, now, getMonotonicPerfMs());
      return serverClockOffsetMs;
    }
  }
  // Deduplikasi in-flight promise lock agar pemanggilan bersamaan (cold load / ensureInitialized / syncFromSupabase)
  // cukup menembakkan 1 RPC get_server_time saja.
  if (clockSyncInFlight) {
    return clockSyncInFlight;
  }

  clockSyncInFlight = (async () => {
    try {
      const supabase = getSupabaseClient();
      const reqStart = Date.now();
      const perfStart = getMonotonicPerfMs();
      const { data, error } = await supabase.rpc('get_server_time');
      const reqEnd = Date.now();
      const perfEnd = getMonotonicPerfMs();
      if (!error && typeof data === 'string') {
        const serverMs = new Date(data).getTime();
        if (Number.isFinite(serverMs)) {
          const wallMidpoint = Math.round((reqStart + reqEnd) / 2);
          const perfMidpoint = perfStart + (perfEnd - perfStart) / 2;
          applyServerTimeSample(serverMs, wallMidpoint, perfMidpoint);
          writeSharedClockCache(serverClockOffsetMs, serverMs);
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
        const perfStart = getMonotonicPerfMs();
        const resp = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/`, {
          method: 'HEAD',
          headers: { apikey: anonKey },
        });
        const reqEnd = Date.now();
        const perfEnd = getMonotonicPerfMs();
        const dateHeader = resp.headers.get('date');
        if (dateHeader) {
          const serverMs = new Date(dateHeader).getTime();
          if (Number.isFinite(serverMs)) {
            const wallMidpoint = Math.round((reqStart + reqEnd) / 2);
            const perfMidpoint = perfStart + (perfEnd - perfStart) / 2;
            applyServerTimeSample(serverMs, wallMidpoint, perfMidpoint);
          }
        }
      }
    } catch {
      // Keep existing offset if offline
    }
    return serverClockOffsetMs;
  })().finally(() => {
    clockSyncInFlight = null;
  });

  return clockSyncInFlight;
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
      const key = normalizeParticipantNumber(item.participantNumber);
      dedup.set(key, { ...item, participantNumber: key });
    }
    await idbPutMany(STORES.PARTICIPANTS, Array.from(dedup.values()), true);
    return;
  }

  const existing = await idbGetAll<Participant>(STORES.PARTICIPANTS);
  const byNumber = new Map<string, Participant>();
  for (const row of existing) {
    byNumber.set(normalizeParticipantNumber(row.participantNumber), row);
  }

  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORES.PARTICIPANTS, 'readwrite');
    const store = tx.objectStore(STORES.PARTICIPANTS);
    for (const rawItem of items) {
      const normNum = normalizeParticipantNumber(rawItem.participantNumber);
      const conflict = byNumber.get(normNum);
      if (conflict && conflict.id !== rawItem.id) {
        store.delete(conflict.id);
      }
      const cleanItem: Participant = {
        ...rawItem,
        participantNumber: normNum,
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
        cachedActiveSession = reconcileSessionWithEmergencyBackup(savedIdb.session);
      } else {
        const legacyRaw = localStorage.getItem(ACTIVE_SESSION_KEY);
        if (legacyRaw) {
          const parsed = JSON.parse(legacyRaw) as Partial<ActiveExamSession>;
          if (parsed && Array.isArray(parsed.questions) && parsed.participant && parsed.schedule) {
            cachedActiveSession = reconcileSessionWithEmergencyBackup(parsed as ActiveExamSession);
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
    // Jangan menembakkan RPC get_server_time terpisah di ensureInitialized karena syncFromSupabase /
    // get_student_bootstrap / student_login_bundle sudah menyinkronkan waktu server dalam 1 roundtrip.
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
  'id,school_name,address,academic_year,principal_name,committee_chair_name,exam_title,logo_data_url,kemenag_logo_data_url,updated_at';
const PUBLIC_SCHOOL_PROFILE_COLUMNS_LEGACY =
  'id,school_name,address,academic_year,principal_name,committee_chair_name,exam_title,logo_data_url,updated_at';
const STUDENT_SCHOOL_PROFILE_COLUMNS =
  'id,school_name,address,academic_year,principal_name,committee_chair_name,exam_title,logo_data_url,updated_at';
const ADMIN_SCHOOL_PROFILE_COLUMNS =
  'id,school_name,address,academic_year,principal_name,committee_chair_name,exam_title,logo_data_url,kemenag_logo_data_url,admin_password,updated_at';
const ADMIN_SCHOOL_PROFILE_COLUMNS_LEGACY =
  'id,school_name,address,academic_year,principal_name,committee_chair_name,exam_title,logo_data_url,admin_password,updated_at';

let schoolProfileHasKemenagColumn: boolean | null = null;
let staffUpsertProfileHasKemenagArg: boolean | null = null;

function isMissingKemenagLogoColumnError(msg: string): boolean {
  const lower = (msg || '').toLowerCase();
  return (
    lower.includes('kemenag_logo_data_url') ||
    (lower.includes('permission denied') && lower.includes('school_profile'))
  );
}

async function fetchSchoolProfileRow(
  client: SupabaseClient,
  includeAdminCols: boolean,
  options?: { studentLight?: boolean }
): Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }> {
  if (!includeAdminCols && options?.studentLight) {
    const lightRes = await client
      .from('school_profile')
      .select(STUDENT_SCHOOL_PROFILE_COLUMNS)
      .eq('id', 'default')
      .maybeSingle();
    return {
      data: (lightRes.data as unknown as Record<string, unknown> | null) || null,
      error: lightRes.error,
    };
  }

  const primaryCols = includeAdminCols ? ADMIN_SCHOOL_PROFILE_COLUMNS : PUBLIC_SCHOOL_PROFILE_COLUMNS;
  const legacyCols = includeAdminCols
    ? ADMIN_SCHOOL_PROFILE_COLUMNS_LEGACY
    : PUBLIC_SCHOOL_PROFILE_COLUMNS_LEGACY;

  if (schoolProfileHasKemenagColumn === false) {
    const cachedLegacy = await client
      .from('school_profile')
      .select(legacyCols)
      .eq('id', 'default')
      .maybeSingle();
    return {
      data: (cachedLegacy.data as unknown as Record<string, unknown> | null) || null,
      error: cachedLegacy.error,
    };
  }

  const first = await client
    .from('school_profile')
    .select(primaryCols)
    .eq('id', 'default')
    .maybeSingle();

  if (first.error && isMissingKemenagLogoColumnError(first.error.message)) {
    schoolProfileHasKemenagColumn = false;
    const fallback = await client
      .from('school_profile')
      .select(legacyCols)
      .eq('id', 'default')
      .maybeSingle();
    return {
      data: (fallback.data as unknown as Record<string, unknown> | null) || null,
      error: fallback.error,
    };
  }

  if (!first.error) {
    schoolProfileHasKemenagColumn = true;
  }

  return {
    data: (first.data as unknown as Record<string, unknown> | null) || null,
    error: first.error,
  };
}

async function upsertSchoolProfileRowDirect(
  client: SupabaseClient,
  row: Record<string, unknown>
): Promise<{ error: { message: string } | null }> {
  if (schoolProfileHasKemenagColumn === false && 'kemenag_logo_data_url' in row) {
    const legacyRow = { ...row };
    delete legacyRow.kemenag_logo_data_url;
    const retry = await client.from('school_profile').upsert(legacyRow);
    return { error: retry.error };
  }
  const first = await client.from('school_profile').upsert(row);
  if (first.error && 'kemenag_logo_data_url' in row && isMissingKemenagLogoColumnError(first.error.message)) {
    schoolProfileHasKemenagColumn = false;
    const legacyRow = { ...row };
    delete legacyRow.kemenag_logo_data_url;
    const retry = await client.from('school_profile').upsert(legacyRow);
    return { error: retry.error };
  }
  if (!first.error && 'kemenag_logo_data_url' in row) {
    schoolProfileHasKemenagColumn = true;
  }
  return { error: first.error };
}

async function callStaffUpsertSchoolProfileRpc(
  supabase: SupabaseClient,
  payload: Record<string, unknown>
): Promise<{ error: { message: string } | null }> {
  if (staffUpsertProfileHasKemenagArg === false && 'p_kemenag_logo_data_url' in payload) {
    const legacyPayload = { ...payload };
    delete legacyPayload.p_kemenag_logo_data_url;
    const retry = await supabase.rpc('staff_upsert_school_profile', legacyPayload);
    return { error: retry.error };
  }
  const first = await supabase.rpc('staff_upsert_school_profile', payload);
  if (
    first.error &&
    'p_kemenag_logo_data_url' in payload &&
    isRpcSignatureMismatchError(first.error.message)
  ) {
    staffUpsertProfileHasKemenagArg = false;
    const legacyPayload = { ...payload };
    delete legacyPayload.p_kemenag_logo_data_url;
    const retry = await supabase.rpc('staff_upsert_school_profile', legacyPayload);
    return { error: retry.error };
  }
  if (!first.error && 'p_kemenag_logo_data_url' in payload) {
    staffUpsertProfileHasKemenagArg = true;
  }
  return { error: first.error };
}

function resolveCloudKemenagLogo(
  profRow: Record<string, unknown>,
  existingProfile?: SchoolProfile
): string {
  if ('kemenag_logo_data_url' in profRow) {
    return (
      String(profRow.kemenag_logo_data_url || '') ||
      SEED_SCHOOL_PROFILE.kemenagLogoDataUrl ||
      ''
    );
  }
  return existingProfile?.kemenagLogoDataUrl || SEED_SCHOOL_PROFILE.kemenagLogoDataUrl || '';
}

const EXAM_RESULTS_ADMIN_COLUMNS =
  'id,participant_id,participant_number,student_name,class_name,exam_id,exam_title,subject,answers,flagged_questions,question_ids,answered_count,correct_count,total_questions,score,tab_switch_count,status,started_at,submitted_at,updated_at';
const EXAM_RESULTS_ADMIN_COLUMNS_LEGACY =
  'id,participant_id,participant_number,student_name,class_name,exam_id,exam_title,subject,answers,flagged_questions,correct_count,total_questions,score,tab_switch_count,status,started_at,submitted_at,updated_at';
const EXAM_RESULTS_ADMIN_SUMMARY_COLUMNS =
  'id,participant_id,participant_number,student_name,class_name,exam_id,exam_title,subject,answered_count,correct_count,total_questions,score,tab_switch_count,status,started_at,submitted_at,updated_at';
const EXAM_RESULTS_LIVE_STATUS_COLUMNS = 'id,status,submitted_at,tab_switch_count';

interface AdminResultsCursor {
  updatedAt: string;
  id: string;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function computeMaxAdminResultsCursor(
  rows: Array<Record<string, unknown>>,
  prev?: AdminResultsCursor | null
): AdminResultsCursor {
  let maxMs = prev ? new Date(prev.updatedAt).getTime() : 0;
  if (!Number.isFinite(maxMs)) maxMs = 0;
  let maxIso = prev?.updatedAt || '';
  let maxId = prev?.id || '';

  for (const row of rows) {
    const rawIso = row.updated_at ? String(row.updated_at) : '';
    const rawId = row.id ? String(row.id) : '';
    const ms = rawIso ? new Date(rawIso).getTime() : NaN;
    if (!Number.isFinite(ms)) continue;
    if (ms > maxMs || (ms === maxMs && rawId > maxId)) {
      maxMs = ms;
      maxIso = rawIso;
      maxId = rawId;
    }
  }

  if (maxMs > 0 && maxIso) {
    return { updatedAt: maxIso, id: maxId };
  }
  return { updatedAt: new Date(getServerNowMs()).toISOString(), id: '' };
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
  columns: string,
  options?: {
    token?: string | null;
    includeFull?: boolean;
    isAdminClient?: boolean;
  }
): Promise<{ data: Record<string, unknown> | null; error?: { message: string } | null }> {
  const normUpper = rawParticipantNumber.trim().toUpperCase();
  if (!normUpper) return { data: null, error: null };

  if (!options?.isAdminClient) {
    const resolvedToken = await resolveParticipantToken(normUpper, options?.token);
    const includeFull =
      options?.includeFull ?? columns !== EXAM_RESULTS_LIVE_STATUS_COLUMNS;
    const rpcRes = await client.rpc('student_check_exam_status', {
      p_participant_number: normUpper,
      p_exam_id: examId,
      p_token: resolvedToken,
      p_include_full: includeFull,
    });
    if (!rpcRes.error) {
      const row =
        Array.isArray(rpcRes.data) && rpcRes.data[0]
          ? (rpcRes.data[0] as Record<string, unknown>)
          : null;
      return { data: row, error: null };
    }
    if (!isRpcSignatureMismatchError(rpcRes.error.message)) {
      return { data: null, error: rpcRes.error };
    }
  }

  // Fallback hanya untuk adminClient (service_role) atau skema DB lama sebelum migrasi hardening
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
    (exactRes.error.message.includes('question_ids') ||
      exactRes.error.message.includes('answered_count'))
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
  return {
    data: (exactRes.data as unknown as Record<string, unknown> | null) || null,
    error: null,
  };
}

async function fetchExamResultsForParticipant(
  client: SupabaseClient,
  rawParticipantNumber: string,
  columns: string,
  options?: {
    token?: string | null;
    isAdminClient?: boolean;
  }
): Promise<{ data: Record<string, unknown>[]; error?: { message: string } | null }> {
  const normUpper = rawParticipantNumber.trim().toUpperCase();
  if (!normUpper) return { data: [], error: null };

  if (!options?.isAdminClient) {
    const resolvedToken = await resolveParticipantToken(normUpper, options?.token);
    const rpcRes = await client.rpc('student_get_my_results', {
      p_participant_number: normUpper,
      p_token: resolvedToken,
    });
    if (!rpcRes.error) {
      const rows = Array.isArray(rpcRes.data)
        ? (rpcRes.data as Record<string, unknown>[])
        : [];
      return { data: rows, error: null };
    }
    if (!isRpcSignatureMismatchError(rpcRes.error.message)) {
      return { data: [], error: rpcRes.error };
    }
  }

  // Fallback hanya untuk adminClient (service_role) atau skema DB lama sebelum migrasi hardening
  let activeCols = columns;
  let exactRes = await client
    .from('exam_results')
    .select(activeCols)
    .eq('participant_number', normUpper);

  if (
    exactRes.error &&
    activeCols === EXAM_RESULTS_ADMIN_COLUMNS &&
    (exactRes.error.message.includes('question_ids') ||
      exactRes.error.message.includes('answered_count'))
  ) {
    activeCols = EXAM_RESULTS_ADMIN_COLUMNS_LEGACY;
    exactRes = await client
      .from('exam_results')
      .select(activeCols)
      .eq('participant_number', normUpper);
  }

  if (exactRes.error) return { data: [], error: exactRes.error };
  return {
    data: Array.isArray(exactRes.data)
      ? (exactRes.data as unknown as Record<string, unknown>[])
      : [],
    error: null,
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
      (activeCols === EXAM_RESULTS_ADMIN_COLUMNS ||
        activeCols === EXAM_RESULTS_ADMIN_SUMMARY_COLUMNS) &&
      (error.message.includes('question_ids') || error.message.includes('answered_count'))
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

async function fetchAdminExamResultsSummaryPaginated(
  client: SupabaseClient,
  cursor: AdminResultsCursor | null,
  isAdminClient: boolean,
  maxRows = 100_000
): Promise<{
  data: Record<string, unknown>[];
  nextCursor: AdminResultsCursor;
  error?: string;
}> {
  const pageSize = 1000;
  const collected: Record<string, unknown>[] = [];
  const seenIds = new Set<string>();

  if (!isAdminClient) {
    const authArgs = await resolveStaffRpcAuthArgs();
    if (authArgs.p_staff_user_id && authArgs.p_staff_password_sha256) {
      let pageUpdatedAfter: string | null = null;
      let pageAfterId: string | null = null;
      if (cursor?.updatedAt) {
        const ms = new Date(cursor.updatedAt).getTime();
        pageUpdatedAfter = Number.isFinite(ms)
          ? new Date(Math.max(0, ms - 1500)).toISOString()
          : cursor.updatedAt;
      }

      let signatureMismatch = false;
      for (let fetched = 0; fetched < maxRows; fetched += pageSize) {
        const rpcRes: { data: unknown; error: { message: string } | null } = await client.rpc(
          'staff_list_exam_results_summary',
          {
            ...authArgs,
            p_updated_after: pageUpdatedAfter,
            p_after_id: pageAfterId,
            p_limit: pageSize,
            p_exam_id: null,
          }
        );
        if (rpcRes.error) {
          if (isRpcSignatureMismatchError(rpcRes.error.message)) {
            signatureMismatch = true;
            break;
          }
          return {
            data: collected,
            nextCursor: computeMaxAdminResultsCursor(collected, cursor),
            error: rpcRes.error.message,
          };
        }
        const rows: Record<string, unknown>[] = Array.isArray(rpcRes.data)
          ? (rpcRes.data as Record<string, unknown>[])
          : [];
        if (rows.length === 0) break;
        for (const raw of rows) {
          const rid = String(raw.id || '');
          if (rid && seenIds.has(rid)) continue;
          if (rid) seenIds.add(rid);
          collected.push(raw);
        }
        if (rows.length < pageSize) break;
        const lastRow: Record<string, unknown> = rows[rows.length - 1];
        const nextUpd: string | null = lastRow.updated_at ? String(lastRow.updated_at) : null;
        const nextId: string | null = lastRow.id ? String(lastRow.id) : null;
        if (!nextUpd || !nextId) break;
        pageUpdatedAfter = nextUpd;
        pageAfterId = nextId;
      }

      if (!signatureMismatch) {
        return {
          data: collected,
          nextCursor: computeMaxAdminResultsCursor(collected, cursor),
        };
      }
    }
  }

  // Jalur service_role (adminClient) atau fallback skema lama sebelum RPC summary terpasang
  if (cursor?.updatedAt) {
    const legacyDelta = await fetchExamResultsDelta(client, cursor.updatedAt, maxRows);
    return {
      data: legacyDelta.data,
      nextCursor: computeMaxAdminResultsCursor(legacyDelta.data, {
        updatedAt: legacyDelta.maxUpdatedAt,
        id: cursor.id,
      }),
      error: legacyDelta.error,
    };
  }

  const fullRes = await fetchAllRowsByIdPaginated<Record<string, unknown>>(
    client,
    'exam_results',
    EXAM_RESULTS_ADMIN_SUMMARY_COLUMNS,
    maxRows
  );
  return {
    data: fullRes.data,
    nextCursor: computeMaxAdminResultsCursor(fullRes.data, cursor),
    error: fullRes.error,
  };
}

async function fetchAdminExamResultIdsPaginated(
  client: SupabaseClient,
  isAdminClient: boolean,
  maxRows = 100_000
): Promise<{ data: string[]; error?: string }> {
  if (!isAdminClient) {
    const authArgs = await resolveStaffRpcAuthArgs();
    if (authArgs.p_staff_user_id && authArgs.p_staff_password_sha256) {
      const pageSize = 5000;
      const ids: string[] = [];
      let afterId: string | null = null;
      let signatureMismatch = false;

      for (let fetched = 0; fetched < maxRows; fetched += pageSize) {
        const rpcRes: { data: unknown; error: { message: string } | null } = await client.rpc(
          'staff_list_exam_result_ids',
          {
            ...authArgs,
            p_after_id: afterId,
            p_limit: pageSize,
          }
        );
        if (rpcRes.error) {
          if (isRpcSignatureMismatchError(rpcRes.error.message)) {
            signatureMismatch = true;
            break;
          }
          return { data: [], error: rpcRes.error.message };
        }
        const rows: Array<{ id?: unknown }> = Array.isArray(rpcRes.data)
          ? (rpcRes.data as Array<{ id?: unknown }>)
          : [];
        if (rows.length === 0) break;
        for (const r of rows) {
          if (r.id) ids.push(String(r.id));
        }
        if (rows.length < pageSize) break;
        const lastId: unknown = rows[rows.length - 1]?.id;
        if (!lastId) break;
        afterId = String(lastId);
      }

      if (!signatureMismatch) {
        return { data: ids };
      }
    }
  }

  const fallback = await fetchAllRowsByIdPaginated<{ id: string }>(
    client,
    'exam_results',
    'id',
    maxRows
  );
  return {
    data: fallback.data.map((r) => String(r.id)),
    error: fallback.error,
  };
}

async function fetchAdminExamResultsByIds(
  client: SupabaseClient,
  resultIds: string[],
  isAdminClient: boolean,
  includeAnswers = false
): Promise<{ data: Record<string, unknown>[]; error?: string }> {
  if (resultIds.length === 0) return { data: [] };

  if (!isAdminClient) {
    const authArgs = await resolveStaffRpcAuthArgs();
    if (authArgs.p_staff_user_id && authArgs.p_staff_password_sha256) {
      const rpcRes = await retryTransientSupabaseCall(
        async () =>
          await client.rpc('staff_get_exam_results_by_ids', {
            ...authArgs,
            p_result_ids: resultIds,
            p_include_answers: includeAnswers,
          }),
        { backoffsMs: [0, 300, 750, 1500, 2600], jitterMs: 400 }
      );
      if (!rpcRes.error) {
        return {
          data: Array.isArray(rpcRes.data)
            ? (rpcRes.data as Record<string, unknown>[])
            : [],
        };
      }
      if (!isRpcSignatureMismatchError(rpcRes.error.message)) {
        return { data: [], error: rpcRes.error.message };
      }
    }
  }

  let activeCols = includeAnswers
    ? EXAM_RESULTS_ADMIN_COLUMNS
    : EXAM_RESULTS_ADMIN_SUMMARY_COLUMNS;
  let res = await retryTransientSupabaseCall(
    async () =>
      await client
        .from('exam_results')
        .select(activeCols)
        .in('id', resultIds),
    { backoffsMs: [0, 300, 750, 1500, 2600], jitterMs: 400 }
  );

  if (
    res.error &&
    (res.error.message.includes('question_ids') ||
      res.error.message.includes('answered_count'))
  ) {
    activeCols = EXAM_RESULTS_ADMIN_COLUMNS_LEGACY;
    res = await retryTransientSupabaseCall(
      async () =>
        await client
          .from('exam_results')
          .select(activeCols)
          .in('id', resultIds),
      { backoffsMs: [0, 300, 750, 1500, 2600], jitterMs: 400 }
    );
  }

  if (res.error) {
    return { data: [], error: res.error.message };
  }
  return {
    data: Array.isArray(res.data)
      ? (res.data as unknown as Record<string, unknown>[])
      : [],
  };
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
  let activeCols = EXAM_RESULTS_ADMIN_SUMMARY_COLUMNS;

  for (let from = 0; from < maxRows; from += pageSize) {
    let { data, error } = await client
      .from('exam_results')
      .select(activeCols)
      .gte('updated_at', safeOverlapIso)
      .order('updated_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);

    if (
      error &&
      (activeCols === EXAM_RESULTS_ADMIN_SUMMARY_COLUMNS ||
        activeCols === EXAM_RESULTS_ADMIN_COLUMNS) &&
      (error.message.includes('question_ids') || error.message.includes('answered_count'))
    ) {
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

interface QuestionsCloudMeta {
  totalCount: number;
  maxUpdatedAt: string | null;
}

let lastQuestionsCloudMeta: QuestionsCloudMeta | null = null;

async function fetchQuestionsCloudMeta(
  client: SupabaseClient,
  isAdminClient = false
): Promise<QuestionsCloudMeta | null> {
  try {
    const authArgs = await resolveStaffRpcAuthArgs();
    const { data, error } = await client.rpc('get_questions_sync_meta', authArgs);
    if (!error && Array.isArray(data) && data[0]) {
      return {
        totalCount: Number(data[0].total_count || 0),
        maxUpdatedAt: data[0].max_updated_at ? String(data[0].max_updated_at) : null,
      };
    }
  } catch {
    // RPC meta check failed
  }
  // Hanya izinkan direct SELECT ke tabel questions jika memakai service_role (adminClient)
  if (!isAdminClient) {
    return null;
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
  const meta = await fetchQuestionsCloudMeta(adminClient, true);
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
const ADMIN_DELETED_RECONCILE_COOLDOWN_MS = 90_000;
let syncInFlight: Promise<void> | null = null;
let syncInFlightIsAdmin = false;
let lastSyncPullMs = 0;
let lastAdminDeltaPullMs = 0;
let lastProfilePullMs = 0;
let lastStudentSchedulesPullMs = 0;
let lastAdminStaticPullMs = 0;
let lastAdminDeletedReconcileMs = 0;
let lastAdminResultsCursor: AdminResultsCursor | null = null;
let lastAdminAutoFinalizeMs = 0;

/**
 * Menarik seluruh peserta melalui RPC staff_list_participants secara berhalaman (.range)
 * agar tidak pernah terpotong oleh batas default PostgREST (1.000 baris) pada madrasah dengan 1.000+ siswa.
 */
async function fetchStaffParticipantsPaginated(
  client: SupabaseClient,
  authArgs: { p_staff_user_id: string | null; p_staff_password_sha256: string | null },
  maxRows = 50_000
): Promise<{ data: Record<string, unknown>[]; error?: string; signatureMismatch?: boolean }> {
  const pageSize = 1000;
  const collected: Record<string, unknown>[] = [];
  const seenIds = new Set<string>();
  for (let from = 0; from < maxRows; from += pageSize) {
    const rpcRes = await client
      .rpc('staff_list_participants', authArgs)
      .range(from, from + pageSize - 1);
    if (rpcRes.error) {
      return {
        data: [],
        error: rpcRes.error.message,
        signatureMismatch: isRpcSignatureMismatchError(rpcRes.error.message),
      };
    }
    const rows = Array.isArray(rpcRes.data) ? (rpcRes.data as Record<string, unknown>[]) : [];
    if (rows.length === 0) break;
    let added = 0;
    for (const row of rows) {
      const rowKey = String(row.id || row.participant_number || '');
      if (rowKey && seenIds.has(rowKey)) continue;
      if (rowKey) seenIds.add(rowKey);
      collected.push(row);
      added += 1;
    }
    if (rows.length < pageSize || added === 0) break;
  }
  return { data: collected };
}

function normalizeDbAnswersMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') {
      out[k] = v;
    } else if (v !== null && v !== undefined && typeof v === 'object') {
      try {
        out[k] = JSON.stringify(v);
      } catch {
        // Ignore unserializable entry
      }
    }
  }
  return out;
}

function mapDbExamResultRow(r: Record<string, unknown>): ExamResult {
  const mappedAnswers = normalizeDbAnswersMap(r.answers);
  const answeredCount =
    typeof r.answered_count === 'number' && Number.isFinite(r.answered_count)
      ? Math.max(0, Math.floor(r.answered_count))
      : countAnsweredEntries(mappedAnswers);
  return {
    id: String(r.id),
    participantId: String(r.participant_id || ''),
    participantNumber: normalizeParticipantNumber(String(r.participant_number || '')),
    studentName: String(r.student_name || ''),
    className: String(r.class_name || ''),
    examId: String(r.exam_id || ''),
    examTitle: String(r.exam_title || ''),
    subject: String(r.subject || ''),
    answers: mappedAnswers,
    flaggedQuestions: Array.isArray(r.flagged_questions)
      ? (r.flagged_questions as string[])
      : [],
    questionIds: Array.isArray(r.question_ids) ? (r.question_ids as string[]) : undefined,
    answeredCount,
    correctCount: Number(r.correct_count || 0),
    totalQuestions: Number(r.total_questions || 0),
    score: Number(r.score || 0),
    tabSwitchCount: Number(r.tab_switch_count || 0),
    status: (r.status as ExamResult['status']) || 'in_progress',
    startedAt: String(r.started_at || ''),
    submittedAt: r.submitted_at ? String(r.submitted_at) : null,
    updatedAt: r.updated_at ? String(r.updated_at) : undefined,
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

      const localByKey = new Map<string, ExamResult>();

      for (const lr of localList) {
        localById.set(lr.id, lr);
        const normNum = lr.participantNumber.trim().toUpperCase();
        const key = `${normNum}::${lr.examId}`;
        localByKey.set(key, lr);
        if (lr.syncStatus === 'pending' || finalizingSessionKeys.has(key)) {
          pendingKeySet.add(key);
          if (lr.syncStatus === 'pending') hasPending = true;
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
          const prev = localById.get(cr.id) || localByKey.get(key);
          // Jangan pernah menimpa jawaban final lokal yang sudah sah dengan baris cloud stale (in_progress)
          if (isExamResultFinalized(prev) && !isExamResultFinalized(cr)) {
            continue;
          }
          // Jika baris cloud merupakan ringkasan admin (tanpa answers JSONB), pertahankan answers lokal bila ada
          const mergedCr: ExamResult =
            prev &&
            prev.id === cr.id &&
            Object.keys(cr.answers || {}).length === 0 &&
            Object.keys(prev.answers || {}).length > 0
              ? {
                  ...cr,
                  answers: prev.answers,
                  flaggedQuestions:
                    cr.flaggedQuestions.length > 0
                      ? cr.flaggedQuestions
                      : prev.flaggedQuestions,
                  questionIds: cr.questionIds ?? prev.questionIds,
                }
              : cr;
          if (!prev || buildResultFingerprint(prev) !== buildResultFingerprint(mergedCr)) {
            changed = true;
          }
          store.put(mergedCr);
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
  Map<string, { id: string; syncStatus?: string; finalized: boolean; fingerprint: string }>
> {
  if (resultsKeyMapCache) return resultsKeyMapCache;
  const localList = await idbGetAll<ExamResult>(STORES.RESULTS);
  const map = new Map<
    string,
    { id: string; syncStatus?: string; finalized: boolean; fingerprint: string }
  >();
  for (const lr of localList) {
    const key = `${lr.participantNumber.trim().toUpperCase()}::${lr.examId}`;
    map.set(key, {
      id: lr.id,
      syncStatus: lr.syncStatus,
      finalized: isExamResultFinalized(lr),
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
    if (finalizingSessionKeys.has(key)) {
      continue;
    }
    if (existing && existing.syncStatus === 'pending') {
      hasPending = true;
      continue;
    }
    const drFinalized = isExamResultFinalized(dr);
    if (existing && existing.finalized && !drFinalized) {
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
      finalized: drFinalized,
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

async function reconcileDeletedResultsAdmin(
  client: SupabaseClient,
  isAdminClient = false
): Promise<number> {
  const idRes = await fetchAdminExamResultIdsPaginated(client, isAdminClient, 100_000);
  if (idRes.error) return 0;
  const cloudIdSet = new Set(idRes.data);
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
  const sessionKey = makeSessionSyncKey(normNum, examId);
  confirmedCloudSessionKeys.delete(sessionKey);
  lastCloudProgressConfirmedAt.delete(sessionKey);
  lastLivePollCloudCheckAt.delete(sessionKey);
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
  participantNumber: string,
  token?: string
): Promise<ExamResult[]> {
  await ensureInitialized();
  const normNum = participantNumber.trim().toUpperCase();
  if (!normNum) return [];
  rememberParticipantToken(normNum, token);

  if (isLiveSupabaseConfigured() && !isBrowserExplicitlyOffline()) {
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await retryTransientSupabaseCall(
        () =>
          fetchExamResultsForParticipant(
            supabase,
            normNum,
            EXAM_RESULTS_ADMIN_COLUMNS,
            { token }
          ),
        { backoffsMs: [0, 1000, 2600], jitterMs: 900 }
      );

      if (!error && Array.isArray(data)) {
        const mapped = data.map((row) => mapDbExamResultRow(row));
        const syncRes = await syncResultsStoreAtomic(mapped, normNum);
        recentlyVerifiedStudentResults.set(normNum, {
          results: mapped,
          verifiedAt: Date.now(),
        });
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

const CROSS_TAB_STUDENT_PULL_COOLDOWN_MS = 45_000;

export type SyncTableScope =
  | 'profile'
  | 'schedules'
  | 'participants'
  | 'staff_accounts'
  | 'results';

export async function syncFromSupabase(options?: {
  force?: boolean;
  currentParticipantNumber?: string;
  currentParticipantToken?: string;
  isAdmin?: boolean;
  resultsOnly?: boolean;
  deltaPreferred?: boolean;
  tables?: SyncTableScope[];
}): Promise<void> {
  if (!isLiveSupabaseConfigured()) return;
  const wantAdmin = Boolean(options?.isAdmin);
  const now = Date.now();
  if (!options?.force && !options?.tables?.length && !syncInFlight && now - lastSyncPullMs < 1500) {
    return;
  }
  // Koordinasi lintas-tab pada browser yang sama agar 3-5 tab siswa yang online bersamaan
  // tidak menarik profil & jadwal secara duplikat.
  if (!wantAdmin && !options?.force && !syncInFlight) {
    try {
      const lastSharedPull = Number(localStorage.getItem(STUDENT_PULL_COOLDOWN_KEY) || '0');
      if (Number.isFinite(lastSharedPull) && now - lastSharedPull >= 0 && now - lastSharedPull < CROSS_TAB_STUDENT_PULL_COOLDOWN_MS) {
        return;
      }
      localStorage.setItem(STUDENT_PULL_COOLDOWN_KEY, String(now));
    } catch {
      // Ignore localStorage restrictions
    }
  }
  if (
    !options?.force &&
    !options?.tables?.length &&
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
    if (!wantAdmin || (runningAsAdmin && !options?.tables?.length)) {
      return;
    }
  }
  syncInFlightIsAdmin = wantAdmin;
  syncInFlight = (async () => {
    try {
      await pullFromSupabaseSilent({
        currentParticipantNumber: options?.currentParticipantNumber,
        currentParticipantToken: options?.currentParticipantToken,
        isAdmin: wantAdmin,
        force: options?.force,
        resultsOnly: options?.resultsOnly,
        deltaPreferred: options?.deltaPreferred,
        tables: options?.tables,
      });
      lastSyncPullMs = Date.now();
      if (!wantAdmin) {
        try {
          localStorage.setItem(STUDENT_PULL_COOLDOWN_KEY, String(lastSyncPullMs));
        } catch {
          // Ignore localStorage restrictions
        }
      }
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
  currentParticipantToken?: string;
  isAdmin?: boolean;
  force?: boolean;
  resultsOnly?: boolean;
  deltaPreferred?: boolean;
  tables?: SyncTableScope[];
}): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    const adminClient = getSupabaseAdminClient();
    const isAdmin = Boolean(options?.isAdmin);
    if (isAdmin) {
      await syncServerClock();
    }
    const readClient = isAdmin && adminClient ? adminClient : supabase;
    const isReadAdminClient = Boolean(isAdmin && adminClient);
    const normParticipant = normalizeParticipantNumber(options?.currentParticipantNumber);
    if (normParticipant && options?.currentParticipantToken) {
      rememberParticipantToken(normParticipant, options.currentParticipantToken);
    }

    if (isAdmin) {
      const requestedTables =
        options?.tables && options.tables.length > 0 ? new Set<SyncTableScope>(options.tables) : null;
      const staticCacheFreshForDelta =
        Boolean(options?.deltaPreferred) &&
        !requestedTables &&
        Boolean(lastAdminResultsCursor) &&
        lastAdminStaticPullMs > 0 &&
        Date.now() - lastAdminStaticPullMs < 90_000;
      const shouldFetchStatic =
        !options?.resultsOnly &&
        !staticCacheFreshForDelta &&
        (Boolean(requestedTables) ||
          Boolean(options?.force) ||
          lastAdminStaticPullMs === 0 ||
          Date.now() - lastAdminStaticPullMs > 300_000);

      const maybeAutoFinalizeAdmin = () => {
        if (Date.now() - lastAdminAutoFinalizeMs >= ADMIN_SYNC_THROTTLE_MS) {
          lastAdminAutoFinalizeMs = Date.now();
          void autoFinalizeExpiredExams({
            currentParticipantNumber: normParticipant || undefined,
            isAdmin: true,
          });
        }
      };

      if (!shouldFetchStatic) {
        lastAdminDeltaPullMs = Date.now();
        if (lastAdminResultsCursor) {
          const shouldReconcileDeleted =
            Boolean(options?.force && options?.deltaPreferred) &&
            Date.now() - lastAdminDeletedReconcileMs >= ADMIN_DELETED_RECONCILE_COOLDOWN_MS;
          const [deltaRes, deletedCount] = await Promise.all([
            fetchAdminExamResultsSummaryPaginated(
              readClient,
              lastAdminResultsCursor,
              isReadAdminClient
            ),
            shouldReconcileDeleted
              ? reconcileDeletedResultsAdmin(readClient, isReadAdminClient).then((cnt) => {
                  lastAdminDeletedReconcileMs = Date.now();
                  return cnt;
                })
              : Promise.resolve(0),
          ]);
          if (!deltaRes.error) {
            lastAdminResultsCursor = deltaRes.nextCursor;
            const deltaMapped = deltaRes.data.map((r) => mapDbExamResultRow(r));
            const { hasPending, updatedCount } = await mergeResultsStoreDelta(deltaMapped);
            if (hasPending) {
              void flushPendingSyncQueue();
            }
            if (updatedCount > 0 || deletedCount > 0) {
              broadcastDataChange('results');
            }
            maybeAutoFinalizeAdmin();
          } else if (deletedCount > 0) {
            broadcastDataChange('results');
          }
          return;
        }

        const resRes = await fetchAdminExamResultsSummaryPaginated(
          readClient,
          null,
          isReadAdminClient
        );
        if (!resRes.error) {
          lastAdminResultsCursor = resRes.nextCursor;
          const cloudResults = resRes.data.map((r) => mapDbExamResultRow(r));
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

      const wantProfile = !requestedTables || requestedTables.has('profile');
      const wantSchedules = !requestedTables || requestedTables.has('schedules');
      const wantParticipants = !requestedTables || requestedTables.has('participants');
      const wantStaff = !requestedTables || requestedTables.has('staff_accounts');
      const wantResults = !requestedTables || requestedTables.has('results');

      if (!requestedTables) {
        lastAdminStaticPullMs = Date.now();
        lastAdminDeltaPullMs = Date.now();
      }
      // Hanya lakukan full reconcile exam_results pada cold load awal atau full-pull eksplisit.
      // Saat deltaPreferred aktif (mis. tombol Sinkronkan Cloud pada Dashboard/Rekap), gunakan delta + rekonsiliasi ID saja agar hemat bandwidth & DB saat 800+ peserta aktif.
      const useFullResultsReconcile =
        wantResults &&
        (!lastAdminResultsCursor ||
          (Boolean(options?.force) && !options?.deltaPreferred && !requestedTables));
      const changedTopics: string[] = [];

      const fetchStaffForAdminSilent = async (): Promise<{
        data: Record<string, unknown>[];
        error?: string;
      }> => {
        if (adminClient) {
          return fetchAllRowsByIdPaginated(adminClient, 'staff_accounts');
        }
        const authArgs = await resolveStaffRpcAuthArgs();
        if (!authArgs.p_staff_user_id || !authArgs.p_staff_password_sha256) {
          return { data: [] };
        }
        const rpcRes = await supabase.rpc('staff_list_accounts', authArgs);
        if (!rpcRes.error && Array.isArray(rpcRes.data)) {
          return { data: rpcRes.data as Record<string, unknown>[] };
        }
        return { data: [], error: rpcRes.error?.message };
      };

      const fetchParticipantsForAdminSilent = async (): Promise<{
        data: Record<string, unknown>[];
        error?: string;
      }> => {
        if (adminClient) {
          return fetchAllRowsByIdPaginated(adminClient, 'participants');
        }
        const authArgs = await resolveStaffRpcAuthArgs();
        if (authArgs.p_staff_user_id && authArgs.p_staff_password_sha256) {
          const rpcRes = await fetchStaffParticipantsPaginated(supabase, authArgs);
          if (!rpcRes.error) {
            return { data: rpcRes.data };
          }
          if (!rpcRes.signatureMismatch) {
            return { data: [], error: rpcRes.error };
          }
        }
        return fetchAllRowsByIdPaginated(readClient, 'participants');
      };

      const existingProfileForMeta = wantProfile
        ? await idbGet<SchoolProfile>(STORES.META, 'default')
        : undefined;

      const [profMetaRes, schedRes, partRes, staffRes] = await Promise.all([
        wantProfile
          ? readClient.from('school_profile').select('id,updated_at').eq('id', 'default').maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        wantSchedules
          ? fetchAllRowsByIdPaginated(readClient, 'exam_schedules')
          : Promise.resolve({ data: [] as Record<string, unknown>[], error: undefined }),
        wantParticipants
          ? fetchParticipantsForAdminSilent()
          : Promise.resolve({ data: [] as Record<string, unknown>[], error: undefined }),
        wantStaff
          ? fetchStaffForAdminSilent()
          : Promise.resolve({ data: [] as Record<string, unknown>[], error: undefined }),
      ]);

      let hasCloudProfile = Boolean(!profMetaRes.error && profMetaRes.data);

      if (wantProfile && hasCloudProfile && profMetaRes.data) {
        lastProfilePullMs = Date.now();
        const remoteUpdatedAt = String(profMetaRes.data.updated_at || '');
        const needsFullProfileFetch =
          !existingProfileForMeta ||
          !existingProfileForMeta.logoDataUrl ||
          !existingProfileForMeta.kemenagLogoDataUrl ||
          !areTimestampsEqual(remoteUpdatedAt, existingProfileForMeta.updatedAt);

        if (needsFullProfileFetch) {
          const profRes = await fetchSchoolProfileRow(readClient, Boolean(adminClient));
          if (!profRes.error && profRes.data) {
            const profRow = profRes.data;
            const cloudAdminPwd =
              typeof profRow.admin_password === 'string' && profRow.admin_password.trim()
                ? profRow.admin_password.trim()
                : '';
            const verifiedActiveAdminPwd =
              activeStaffCredentials?.userId.toLowerCase() === 'admin'
                ? activeStaffCredentials.passwordHash
                : '';
            const resolvedAdminPwd =
              cloudAdminPwd || verifiedActiveAdminPwd || '__CLOUD_MANAGED__';
            const nextProfile: SchoolProfile = {
              id: 'default',
              schoolName: String(profRow.school_name || ''),
              address: String(profRow.address || ''),
              academicYear: String(profRow.academic_year || ''),
              principalName: String(profRow.principal_name || ''),
              committeeChairName: String(profRow.committee_chair_name || ''),
              examTitle: String(profRow.exam_title || ''),
              logoDataUrl: String(profRow.logo_data_url || '') || SEED_SCHOOL_PROFILE.logoDataUrl,
              kemenagLogoDataUrl: resolveCloudKemenagLogo(profRow, existingProfileForMeta),
              adminPassword: resolvedAdminPwd,
              updatedAt: String(profRow.updated_at || new Date().toISOString()),
            };
            const profileDiffers =
              !existingProfileForMeta ||
              !areTimestampsEqual(existingProfileForMeta.updatedAt, nextProfile.updatedAt) ||
              existingProfileForMeta.schoolName !== nextProfile.schoolName ||
              existingProfileForMeta.address !== nextProfile.address ||
              existingProfileForMeta.academicYear !== nextProfile.academicYear ||
              existingProfileForMeta.principalName !== nextProfile.principalName ||
              existingProfileForMeta.committeeChairName !== nextProfile.committeeChairName ||
              existingProfileForMeta.examTitle !== nextProfile.examTitle ||
              existingProfileForMeta.adminPassword !== nextProfile.adminPassword ||
              existingProfileForMeta.logoDataUrl !== nextProfile.logoDataUrl ||
              (existingProfileForMeta.kemenagLogoDataUrl || '') !==
                (nextProfile.kemenagLogoDataUrl || '');
            if (profileDiffers) {
              await idbPut(STORES.META, nextProfile);
              changedTopics.push('profile');
            }
          } else {
            hasCloudProfile = false;
          }
        }
      }

      if (wantSchedules && !schedRes.error && (schedRes.data.length > 0 || hasCloudProfile || Boolean(requestedTables))) {
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
        const verifiedAt = Date.now();
        for (const sched of nextSchedules) {
          verifiedSchedulesCache.set(sched.id, { schedule: sched, verifiedAt });
        }
      }

      if (wantParticipants && !partRes.error && (partRes.data.length > 0 || hasCloudProfile || Boolean(requestedTables))) {
        const nextParticipants: Participant[] = partRes.data.map((r) => ({
          id: String(r.id),
          participantNumber: normalizeParticipantNumber(String(r.participant_number || '')),
          token: String(r.token || 'CBT2026'),
          fullName: String(r.full_name || ''),
          className: String(r.class_name || ''),
          isActive: Boolean(r.is_active ?? true),
          createdAt: String(r.created_at || ''),
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

      if (wantResults) {
        if (useFullResultsReconcile) {
          const resRes = await fetchAdminExamResultsSummaryPaginated(
            readClient,
            null,
            isReadAdminClient,
            100_000
          );
          if (!resRes.error) {
            lastAdminResultsCursor = resRes.nextCursor;
            const cloudResults = resRes.data.map((r) => mapDbExamResultRow(r));
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
        } else if (lastAdminResultsCursor) {
          const shouldReconcileDeleted =
            !options?.deltaPreferred ||
            Date.now() - lastAdminDeletedReconcileMs >= ADMIN_DELETED_RECONCILE_COOLDOWN_MS;
          const [deltaRes, deletedCount] = await Promise.all([
            fetchAdminExamResultsSummaryPaginated(
              readClient,
              lastAdminResultsCursor,
              isReadAdminClient
            ),
            shouldReconcileDeleted
              ? reconcileDeletedResultsAdmin(readClient, isReadAdminClient).then((cnt) => {
                  lastAdminDeletedReconcileMs = Date.now();
                  return cnt;
                })
              : Promise.resolve(0),
          ]);
          if (!deltaRes.error) {
            lastAdminResultsCursor = deltaRes.nextCursor;
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
      }

      if (wantStaff && !staffRes.error && staffRes.data.length > 0) {
        const existingStaff = await idbGetAll<StaffAccount>(STORES.STAFF_ACCOUNTS);
        const activeUserLower = activeStaffCredentials?.userId.trim().toLowerCase() || '';
        const mappedStaff: StaffAccount[] = staffRes.data.map((s) => {
          const userId = String(s.user_id || '');
          const normUser = userId.trim().toLowerCase();
          const rawPwd = typeof s.password_hash === 'string' ? s.password_hash.trim() : '';
          // Jangan pernah mempertahankan sandi seed lokal (proktor123/guru123/admin123) saat cloud tidak mengembalikan hash.
          const resolvedPwd =
            rawPwd ||
            (normUser && normUser === activeUserLower && activeStaffCredentials?.passwordHash
              ? activeStaffCredentials.passwordHash
              : '__CLOUD_MANAGED__');
          return {
            id: String(s.id),
            userId,
            name: String(s.name || ''),
            password: resolvedPwd,
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

      if (!requestedTables && adminClient) {
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
      if (wantResults) {
        maybeAutoFinalizeAdmin();
      }
      return;
    }

    // Student / Public route: gunakan 1 RPC gabungan get_student_bootstrap (server_time + profil tanpa logo kemenag + jadwal aktif saja)
    // untuk memangkas 4 roundtrip DB menjadi 1 roundtrip ringan saat 800-1.000 siswa membuka halaman serentak.
    const shouldFetchProfile =
      Boolean(options?.force) ||
      lastProfilePullMs === 0 ||
      Date.now() - lastProfilePullMs > 300_000;

    const shouldFetchSchedules =
      Boolean(options?.force) ||
      lastStudentSchedulesPullMs === 0 ||
      Date.now() - lastStudentSchedulesPullMs > 120_000;

    const localProfile =
      shouldFetchProfile || studentBootstrapRpcAvailable !== false
        ? await idbGet<SchoolProfile>(STORES.META, 'default')
        : undefined;

    let usedBootstrapRpc = false;
    let bootstrapTransientFailed = false;

    if ((shouldFetchProfile || shouldFetchSchedules) && studentBootstrapRpcAvailable !== false) {
      let reqStart = Date.now();
      let perfStart = getMonotonicPerfMs();
      const knownUpdatedAt =
        localProfile?.logoDataUrl && localProfile.updatedAt ? localProfile.updatedAt : null;

      const bootRes = await retryTransientSupabaseCall(
        async () => {
          reqStart = Date.now();
          perfStart = getMonotonicPerfMs();
          return supabase.rpc('get_student_bootstrap', {
            p_known_profile_updated_at: knownUpdatedAt,
          });
        },
        { backoffsMs: [0, 900, 2200], jitterMs: 700 }
      );
      const reqEnd = Date.now();
      const perfEnd = getMonotonicPerfMs();

      if (!bootRes.error && Array.isArray(bootRes.data) && bootRes.data[0]) {
        studentBootstrapRpcAvailable = true;
        usedBootstrapRpc = true;
        const bootRow = bootRes.data[0] as Record<string, unknown>;

        if (typeof bootRow.server_time === 'string') {
          const serverMs = new Date(bootRow.server_time).getTime();
          if (Number.isFinite(serverMs)) {
            const wallMidpoint = Math.round((reqStart + reqEnd) / 2);
            const perfMidpoint = perfStart + (perfEnd - perfStart) / 2;
            applyServerTimeSample(serverMs, wallMidpoint, perfMidpoint);
            writeSharedClockCache(serverClockOffsetMs, serverMs);
          }
        }

        const profObj =
          bootRow.profile && typeof bootRow.profile === 'object'
            ? (bootRow.profile as Record<string, unknown>)
            : null;
        const hasCloudProfile = Boolean(profObj);

        if (hasCloudProfile && profObj) {
          lastProfilePullMs = Date.now();
          if (bootRow.profile_changed === true || !localProfile || !localProfile.logoDataUrl) {
            const safeAdminPwd =
              activeStaffCredentials?.userId.toLowerCase() === 'admin'
                ? activeStaffCredentials.passwordHash
                : '__CLOUD_MANAGED__';
            await idbPut(STORES.META, {
              id: 'default',
              schoolName: String(profObj.school_name || localProfile?.schoolName || ''),
              address: String(profObj.address || localProfile?.address || ''),
              academicYear: String(profObj.academic_year || localProfile?.academicYear || ''),
              principalName: String(profObj.principal_name || localProfile?.principalName || ''),
              committeeChairName: String(
                profObj.committee_chair_name || localProfile?.committeeChairName || ''
              ),
              examTitle: String(profObj.exam_title || localProfile?.examTitle || ''),
              logoDataUrl:
                String(profObj.logo_data_url || '') ||
                localProfile?.logoDataUrl ||
                SEED_SCHOOL_PROFILE.logoDataUrl,
              kemenagLogoDataUrl:
                localProfile?.kemenagLogoDataUrl || SEED_SCHOOL_PROFILE.kemenagLogoDataUrl || '',
              adminPassword: safeAdminPwd,
              updatedAt: String(profObj.updated_at || new Date().toISOString()),
            } satisfies SchoolProfile);
          }
        }

        const rawScheds = Array.isArray(bootRow.active_schedules)
          ? (bootRow.active_schedules as Record<string, unknown>[])
          : [];
        if (rawScheds.length > 0 || hasCloudProfile) {
          const mappedSchedules: ExamSchedule[] = rawScheds.map((r) => ({
            id: String(r.id),
            title: String(r.title || ''),
            subject: String(r.subject || ''),
            kkm: Number(r.kkm ?? 75),
            durationMinutes: Number(r.duration_minutes ?? 60),
            targetClasses: Array.isArray(r.target_classes) ? (r.target_classes as string[]) : [],
            isActive: Boolean(r.is_active ?? true),
            randomizeQuestions: Boolean(r.randomize_questions ?? false),
            maxTabSwitches: Number(r.max_tab_switches ?? 3),
            createdAt: String(r.created_at || new Date().toISOString()),
          }));
          await idbPutMany(STORES.SCHEDULES, mappedSchedules, true);
          const verifiedAt = Date.now();
          lastStudentSchedulesPullMs = verifiedAt;
          for (const sched of mappedSchedules) {
            verifiedSchedulesCache.set(sched.id, { schedule: sched, verifiedAt });
          }
        }
      } else if (bootRes.error && isRpcSignatureMismatchError(bootRes.error.message)) {
        studentBootstrapRpcAvailable = false;
      } else if (bootRes.error) {
        // Kegagalan sementara (503/429/timeout): jangan picu 3-4 kueri fallback tambahan yang memperparah beban server
        bootstrapTransientFailed = true;
      }
    }

    if (!usedBootstrapRpc && !bootstrapTransientFailed && (shouldFetchProfile || shouldFetchSchedules)) {
      // Fallback kompatibel mundur jika SQL get_student_bootstrap belum dijalankan di Supabase:
      // tetap hanya tarik jadwal is_active = true & profil siswa tanpa logo Kemenag (hemat ~25 KB/siswa).
      const [profMetaRes, schedRes] = await Promise.all([
        shouldFetchProfile
          ? supabase.from('school_profile').select('id,updated_at').eq('id', 'default').maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        shouldFetchSchedules
          ? supabase
              .from('exam_schedules')
              .select('id,title,subject,kkm,duration_minutes,target_classes,is_active,randomize_questions,max_tab_switches,created_at')
              .eq('is_active', true)
              .order('id', { ascending: true })
          : Promise.resolve({ data: [] as Record<string, unknown>[], error: null }),
      ]);

      let hasCloudProfile = Boolean(!profMetaRes.error && profMetaRes.data);

      if (hasCloudProfile && profMetaRes.data) {
        lastProfilePullMs = Date.now();
        const needsFullProfile =
          !localProfile ||
          !localProfile.logoDataUrl ||
          !areTimestampsEqual(String(profMetaRes.data.updated_at || ''), localProfile.updatedAt);

        if (needsFullProfile) {
          const profRes = await fetchSchoolProfileRow(supabase, false, { studentLight: true });

          if (!profRes.error && profRes.data) {
            const profRow = profRes.data;
            const safeAdminPwd =
              activeStaffCredentials?.userId.toLowerCase() === 'admin'
                ? activeStaffCredentials.passwordHash
                : '__CLOUD_MANAGED__';
            await idbPut(STORES.META, {
              id: 'default',
              schoolName: String(profRow.school_name || ''),
              address: String(profRow.address || ''),
              academicYear: String(profRow.academic_year || ''),
              principalName: String(profRow.principal_name || ''),
              committeeChairName: String(profRow.committee_chair_name || ''),
              examTitle: String(profRow.exam_title || ''),
              logoDataUrl: String(profRow.logo_data_url || '') || SEED_SCHOOL_PROFILE.logoDataUrl,
              kemenagLogoDataUrl:
                localProfile?.kemenagLogoDataUrl || SEED_SCHOOL_PROFILE.kemenagLogoDataUrl || '',
              adminPassword: safeAdminPwd,
              updatedAt: String(profRow.updated_at || new Date().toISOString()),
            } satisfies SchoolProfile);
          } else {
            hasCloudProfile = false;
          }
        }
      }

      if (
        shouldFetchSchedules &&
        !schedRes.error &&
        Array.isArray(schedRes.data) &&
        (schedRes.data.length > 0 || hasCloudProfile)
      ) {
        const mappedSchedules: ExamSchedule[] = schedRes.data.map((r) => ({
          id: String(r.id),
          title: String(r.title || ''),
          subject: String(r.subject || ''),
          kkm: Number(r.kkm ?? 75),
          durationMinutes: Number(r.duration_minutes ?? 60),
          targetClasses: Array.isArray(r.target_classes) ? (r.target_classes as string[]) : [],
          isActive: Boolean(r.is_active ?? true),
          randomizeQuestions: Boolean(r.randomize_questions ?? false),
          maxTabSwitches: Number(r.max_tab_switches ?? 3),
          createdAt: String(r.created_at || new Date().toISOString()),
        }));
        await idbPutMany(STORES.SCHEDULES, mappedSchedules, true);
        const verifiedAt = Date.now();
        lastStudentSchedulesPullMs = verifiedAt;
        for (const sched of mappedSchedules) {
          verifiedSchedulesCache.set(sched.id, { schedule: sched, verifiedAt });
        }
      }

      // Sinkronkan jam server hanya jika belum ada cache jam valid (hindari RPC ekstra pada cold load)
      if (syncedServerEpochMs === null) {
        void syncServerClock(false);
      }
    }

    if (normParticipant) {
      const myResRes = await fetchExamResultsForParticipant(
        supabase,
        normParticipant,
        EXAM_RESULTS_ADMIN_COLUMNS,
        { token: options?.currentParticipantToken }
      );
      if (!myResRes.error && Array.isArray(myResRes.data)) {
        const cloudOwn = myResRes.data.map((r) => mapDbExamResultRow(r));
        const { hasPending } = await syncResultsStoreAtomic(cloudOwn, normParticipant);
        recentlyVerifiedStudentResults.set(normParticipant, {
          results: cloudOwn,
          verifiedAt: Date.now(),
        });
        if (hasPending) {
          void flushPendingSyncQueue();
        }
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
  if (!profile) return SEED_SCHOOL_PROFILE;
  return {
    ...profile,
    kemenagLogoDataUrl:
      profile.kemenagLogoDataUrl || SEED_SCHOOL_PROFILE.kemenagLogoDataUrl,
  };
}

export async function saveSchoolProfile(
  profile: SchoolProfile,
  options?: { updateAdminPassword?: boolean }
): Promise<CloudSyncWriteResult> {
  await ensureInitialized();
  const existingProfile = await idbGet<SchoolProfile>(STORES.META, 'default');
  const shouldUpdateAdminPwd = Boolean(options?.updateAdminPassword);
  const rawAdminPwd = (profile.adminPassword || '').trim();
  const hasRealNewAdminPwd =
    shouldUpdateAdminPwd && Boolean(rawAdminPwd) && rawAdminPwd !== '__CLOUD_MANAGED__';
  const hashedAdminPwd = hasRealNewAdminPwd ? await hashPassword(rawAdminPwd) : null;

  // Tangkap kredensial RPC LAMA sebelum memperbarui activeStaffCredentials agar assert_verified_staff di server menerima permintaan
  const oldAuthArgs = await resolveStaffRpcAuthArgs();
  const isUpdatingSelfAdmin =
    (activeStaffCredentials?.userId || oldAuthArgs.p_staff_user_id || '').trim().toLowerCase() ===
    'admin';

  const updated: SchoolProfile = {
    ...profile,
    id: 'default',
    adminPassword:
      hashedAdminPwd ||
      existingProfile?.adminPassword ||
      (isLiveSupabaseConfigured() ? '__CLOUD_MANAGED__' : SEED_SCHOOL_PROFILE.adminPassword),
    updatedAt: new Date().toISOString(),
  };
  await idbPut(STORES.META, updated);

  let updatedAdminAccount: StaffAccount | null = null;
  if (hashedAdminPwd) {
    const staffList = await idbGetAll<StaffAccount>(STORES.STAFF_ACCOUNTS);
    const existingAdmin = staffList.find((s) => s.userId.toLowerCase() === 'admin');
    const baseAdmin = existingAdmin || {
      ...SEED_STAFF_ACCOUNTS[0],
      allowedTabs: ALL_ADMIN_TABS,
    };
    updatedAdminAccount = { ...baseAdmin, password: hashedAdminPwd };
    await idbPutStaffSafe([updatedAdminAccount]);
  }

  let synced = false;
  let syncError: string | undefined;

  if (isLiveSupabaseConfigured()) {
    try {
      const adminClient = getSupabaseAdminClient();
      const supabase = getSupabaseClient();
      let staffSynced = !hashedAdminPwd;

      if (hashedAdminPwd && updatedAdminAccount) {
        if (adminClient) {
          const { error: stErr } = await adminClient.from('staff_accounts').upsert(
            {
              id: updatedAdminAccount.id,
              user_id: updatedAdminAccount.userId,
              name: updatedAdminAccount.name,
              password_hash: updatedAdminAccount.password,
              role_type: updatedAdminAccount.roleType,
              role_label: updatedAdminAccount.roleLabel,
              allowed_tabs: updatedAdminAccount.allowedTabs,
              assigned_subjects: updatedAdminAccount.assignedSubjects,
              restrict_to_assigned_subjects: updatedAdminAccount.restrictToAssignedSubjects,
              is_active: updatedAdminAccount.isActive,
              created_at: updatedAdminAccount.createdAt,
            },
            { onConflict: 'user_id' }
          );
          if (stErr) syncError = stErr.message;
          else staffSynced = true;
        } else {
          const { error: rpcErr } = await supabase.rpc('staff_upsert_account', {
            ...oldAuthArgs,
            p_id: updatedAdminAccount.id,
            p_target_user_id: updatedAdminAccount.userId,
            p_name: updatedAdminAccount.name,
            p_password_hash: updatedAdminAccount.password,
            p_role_type: updatedAdminAccount.roleType,
            p_role_label: updatedAdminAccount.roleLabel,
            p_allowed_tabs: updatedAdminAccount.allowedTabs,
            p_assigned_subjects: updatedAdminAccount.assignedSubjects,
            p_restrict_to_assigned_subjects: updatedAdminAccount.restrictToAssignedSubjects,
            p_is_active: updatedAdminAccount.isActive,
            p_created_at: updatedAdminAccount.createdAt,
          });
          if (!rpcErr) {
            staffSynced = true;
          } else {
            syncError = rpcErr.message;
          }
        }
      }

      if (adminClient) {
        const row: Record<string, unknown> = {
          id: 'default',
          school_name: updated.schoolName,
          address: updated.address,
          academic_year: updated.academicYear,
          principal_name: updated.principalName,
          committee_chair_name: updated.committeeChairName,
          exam_title: updated.examTitle,
          logo_data_url: updated.logoDataUrl,
          kemenag_logo_data_url: updated.kemenagLogoDataUrl || '',
          updated_at: updated.updatedAt,
        };
        if (hashedAdminPwd) {
          row.admin_password = hashedAdminPwd;
        }
        const { error: profErr } = await upsertSchoolProfileRowDirect(adminClient, row);
        if (profErr) {
          syncError = syncError ? `${syncError}; ${profErr.message}` : profErr.message;
        } else if (staffSynced) {
          synced = true;
        }
      } else {
        // Jika sandi admin baru saja berhasil disimpan ke staff_accounts, gunakan kredensial baru untuk RPC berikutnya (dengan fallback ke lama)
        const profileAuthArgs =
          isUpdatingSelfAdmin && hashedAdminPwd && staffSynced
            ? { p_staff_user_id: 'admin', p_staff_password_sha256: hashedAdminPwd }
            : oldAuthArgs;

        let { error: rpcErr } = await callStaffUpsertSchoolProfileRpc(supabase, {
          ...profileAuthArgs,
          p_school_name: updated.schoolName,
          p_address: updated.address,
          p_academic_year: updated.academicYear,
          p_principal_name: updated.principalName,
          p_committee_chair_name: updated.committeeChairName,
          p_exam_title: updated.examTitle,
          p_logo_data_url: updated.logoDataUrl,
          p_kemenag_logo_data_url: updated.kemenagLogoDataUrl ?? '',
          p_admin_password_hash: hashedAdminPwd,
          p_updated_at: updated.updatedAt,
        });

        if (
          rpcErr &&
          isUpdatingSelfAdmin &&
          hashedAdminPwd &&
          staffSynced &&
          rpcErr.message.toLowerCase().includes('unauthorized')
        ) {
          const retry = await callStaffUpsertSchoolProfileRpc(supabase, {
            ...oldAuthArgs,
            p_school_name: updated.schoolName,
            p_address: updated.address,
            p_academic_year: updated.academicYear,
            p_principal_name: updated.principalName,
            p_committee_chair_name: updated.committeeChairName,
            p_exam_title: updated.examTitle,
            p_logo_data_url: updated.logoDataUrl,
            p_kemenag_logo_data_url: updated.kemenagLogoDataUrl ?? '',
            p_admin_password_hash: hashedAdminPwd,
            p_updated_at: updated.updatedAt,
          });
          rpcErr = retry.error;
        }

        if (!rpcErr) {
          if (staffSynced) synced = true;
        } else {
          syncError = syncError ? `${syncError}; ${rpcErr.message}` : rpcErr.message;
        }
      }

      if (isUpdatingSelfAdmin && hashedAdminPwd && staffSynced && activeStaffCredentials) {
        activeStaffCredentials.passwordHash = hashedAdminPwd;
      }
    } catch (err) {
      syncError = err instanceof Error ? err.message : 'Gagal terhubung ke Supabase';
    }
  } else if (isUpdatingSelfAdmin && hashedAdminPwd && activeStaffCredentials) {
    activeStaffCredentials.passwordHash = hashedAdminPwd;
  }

  broadcastDataChange('profile');
  if (hashedAdminPwd) {
    broadcastDataChange('staff_accounts');
  }
  return { synced, error: syncError };
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
  account: StaffAccount,
  options?: { updatePassword?: boolean }
): Promise<{ synced: boolean; error?: string }> {
  await ensureInitialized();
  const existingStaffList = await idbGetAll<StaffAccount>(STORES.STAFF_ACCOUNTS);
  const existingLocal = existingStaffList.find(
    (s) =>
      s.id === account.id ||
      s.userId.trim().toLowerCase() === account.userId.trim().toLowerCase()
  );

  const rawPassword = (account.password || '').trim();
  const isCloudPlaceholder = !rawPassword || rawPassword === '__CLOUD_MANAGED__';
  const shouldUpdatePassword =
    options?.updatePassword !== undefined
      ? Boolean(options.updatePassword) && !isCloudPlaceholder
      : !isCloudPlaceholder;

  const hashedPassword = shouldUpdatePassword ? await hashPassword(rawPassword) : '';
  const localPasswordToStore = shouldUpdatePassword
    ? hashedPassword
    : existingLocal?.password || '__CLOUD_MANAGED__';
  const cloudPasswordToSend = shouldUpdatePassword ? hashedPassword : '';

  // Tangkap kredensial RPC LAMA sebelum mengubah activeStaffCredentials agar RPC terotorisasi
  const oldAuthArgs = await resolveStaffRpcAuthArgs();
  const normalizedUserId = account.userId.trim();
  const isUpdatingSelf = Boolean(
    activeStaffCredentials &&
      (activeStaffCredentials.userId.trim().toLowerCase() === normalizedUserId.toLowerCase() ||
        (existingLocal &&
          activeStaffCredentials.userId.trim().toLowerCase() ===
            existingLocal.userId.trim().toLowerCase()))
  );

  const normalized: StaffAccount = {
    ...account,
    userId: normalizedUserId,
    password: localPasswordToStore,
  };
  await idbPutStaffSafe([normalized]);

  let synced = false;
  let syncError: string | undefined;
  let staffCloudSaved = false;

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
        if (shouldUpdatePassword && hashedPassword) {
          dbRow.password_hash = hashedPassword;
        }

        if (!shouldUpdatePassword) {
          const { data: updRows, error: updErr } = await adminClient
            .from('staff_accounts')
            .update({
              user_id: normalized.userId,
              name: normalized.name,
              role_type: normalized.roleType,
              role_label: normalized.roleLabel,
              allowed_tabs: normalized.allowedTabs,
              assigned_subjects: normalized.assignedSubjects,
              restrict_to_assigned_subjects: normalized.restrictToAssignedSubjects,
              is_active: normalized.isActive,
            })
            .eq('id', normalized.id)
            .select('id');
          if (updErr) {
            syncError = updErr.message;
          } else if (Array.isArray(updRows) && updRows.length > 0) {
            staffCloudSaved = true;
          } else {
            const { error: byUidErr } = await adminClient
              .from('staff_accounts')
              .update({
                name: normalized.name,
                role_type: normalized.roleType,
                role_label: normalized.roleLabel,
                allowed_tabs: normalized.allowedTabs,
                assigned_subjects: normalized.assignedSubjects,
                restrict_to_assigned_subjects: normalized.restrictToAssignedSubjects,
                is_active: normalized.isActive,
              })
              .ilike('user_id', escapeLikePattern(normalized.userId));
            if (byUidErr) syncError = byUidErr.message;
            else staffCloudSaved = true;
          }
        } else {
          const { error } = await adminClient
            .from('staff_accounts')
            .upsert(dbRow, { onConflict: 'id' });
          if (error) {
            const retry = await adminClient
              .from('staff_accounts')
              .upsert(dbRow, { onConflict: 'user_id' });
            if (retry.error) syncError = retry.error.message;
            else staffCloudSaved = true;
          } else {
            staffCloudSaved = true;
          }
        }
      } else {
        const rpcPayload = {
          ...oldAuthArgs,
          p_id: normalized.id,
          p_target_user_id: normalized.userId,
          p_name: normalized.name,
          p_password_hash: cloudPasswordToSend,
          p_role_type: normalized.roleType,
          p_role_label: normalized.roleLabel,
          p_allowed_tabs: normalized.allowedTabs,
          p_assigned_subjects: normalized.assignedSubjects,
          p_restrict_to_assigned_subjects: normalized.restrictToAssignedSubjects,
          p_is_active: normalized.isActive,
          p_created_at: normalized.createdAt,
        };
        let { error: rpcErr } = await supabase.rpc('staff_upsert_account', rpcPayload);

        // Tangani kasus ubah kapitalisasi / rename ID pada database lama yang masih memakai ON CONFLICT (user_id)
        if (
          rpcErr &&
          shouldUpdatePassword &&
          (rpcErr.code === '23505' || rpcErr.message.toLowerCase().includes('staff_accounts_pkey')) &&
          existingLocal &&
          existingLocal.userId !== normalized.userId &&
          existingLocal.userId.toLowerCase() !== 'admin'
        ) {
          await supabase.rpc('staff_delete_account', {
            ...oldAuthArgs,
            p_target_id: existingLocal.id,
            p_target_user_id: existingLocal.userId,
          });
          const retry = await supabase.rpc('staff_upsert_account', rpcPayload);
          rpcErr = retry.error;
        }

        if (!rpcErr) {
          staffCloudSaved = true;
        } else {
          syncError = rpcErr.message;
        }
      }

      // Sinkronkan juga school_profile.admin_password ketika sandi akun admin utama diubah
      if (normalized.userId.toLowerCase() === 'admin' && shouldUpdatePassword && hashedPassword) {
        const profile = await idbGet<SchoolProfile>(STORES.META, 'default');
        const updatedProfile: SchoolProfile = {
          ...(profile || SEED_SCHOOL_PROFILE),
          id: 'default',
          adminPassword: hashedPassword,
          updatedAt: new Date().toISOString(),
        };
        await idbPut(STORES.META, updatedProfile);

        if (adminClient) {
          const { error: profErr } = await adminClient
            .from('school_profile')
            .update({ admin_password: hashedPassword, updated_at: updatedProfile.updatedAt })
            .eq('id', 'default');
          if (profErr) {
            syncError = syncError ? `${syncError}; ${profErr.message}` : profErr.message;
          }
        } else {
          const profileAuthArgs =
            isUpdatingSelf && staffCloudSaved
              ? { p_staff_user_id: normalized.userId, p_staff_password_sha256: hashedPassword }
              : oldAuthArgs;

          let { error: profRpcErr } = await callStaffUpsertSchoolProfileRpc(supabase, {
            ...profileAuthArgs,
            p_school_name: updatedProfile.schoolName,
            p_address: updatedProfile.address,
            p_academic_year: updatedProfile.academicYear,
            p_principal_name: updatedProfile.principalName,
            p_committee_chair_name: updatedProfile.committeeChairName,
            p_exam_title: updatedProfile.examTitle,
            p_logo_data_url: updatedProfile.logoDataUrl,
            p_kemenag_logo_data_url: updatedProfile.kemenagLogoDataUrl ?? null,
            p_admin_password_hash: hashedPassword,
            p_updated_at: updatedProfile.updatedAt,
          });
          if (
            profRpcErr &&
            isUpdatingSelf &&
            staffCloudSaved &&
            profRpcErr.message.toLowerCase().includes('unauthorized')
          ) {
            const retry = await callStaffUpsertSchoolProfileRpc(supabase, {
              ...oldAuthArgs,
              p_school_name: updatedProfile.schoolName,
              p_address: updatedProfile.address,
              p_academic_year: updatedProfile.academicYear,
              p_principal_name: updatedProfile.principalName,
              p_committee_chair_name: updatedProfile.committeeChairName,
              p_exam_title: updatedProfile.examTitle,
              p_logo_data_url: updatedProfile.logoDataUrl,
              p_kemenag_logo_data_url: updatedProfile.kemenagLogoDataUrl ?? null,
              p_admin_password_hash: hashedPassword,
              p_updated_at: updatedProfile.updatedAt,
            });
            profRpcErr = retry.error;
          }
          if (profRpcErr) {
            syncError = syncError ? `${syncError}; ${profRpcErr.message}` : profRpcErr.message;
          }
        }
      }

      if (staffCloudSaved && !syncError) {
        synced = true;
      }

      // Perbarui kredensial aktif di memori HANYA setelah tersimpan ke cloud
      if (isUpdatingSelf && staffCloudSaved && activeStaffCredentials) {
        activeStaffCredentials.userId = normalized.userId;
        if (shouldUpdatePassword && hashedPassword) {
          activeStaffCredentials.passwordHash = hashedPassword;
        }
      }
    } catch (err) {
      syncError = err instanceof Error ? err.message : 'Gagal terhubung ke Supabase';
    }
  } else {
    if (normalized.userId.toLowerCase() === 'admin' && shouldUpdatePassword && hashedPassword) {
      const profile = await idbGet<SchoolProfile>(STORES.META, 'default');
      if (profile) {
        await idbPut(STORES.META, {
          ...profile,
          adminPassword: hashedPassword,
          updatedAt: new Date().toISOString(),
        });
      }
    }
    if (isUpdatingSelf && activeStaffCredentials) {
      activeStaffCredentials.userId = normalized.userId;
      if (shouldUpdatePassword && hashedPassword) {
        activeStaffCredentials.passwordHash = hashedPassword;
      }
    }
  }

  broadcastDataChange('staff_accounts');
  if (normalized.userId.toLowerCase() === 'admin' && shouldUpdatePassword) {
    broadcastDataChange('profile');
  }
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
        const authArgs = await resolveStaffRpcAuthArgs();
        const { error: rpcErr } = await supabase.rpc('staff_delete_account', {
          ...authArgs,
          p_target_id: id,
          p_target_user_id: existing?.userId || null,
        });
        if (!rpcErr) {
          synced = true;
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

export async function verifyStaffPassword(
  rawUserId: string,
  rawPassword: string
): Promise<boolean> {
  const res = await authenticateStaffInternal(rawUserId, rawPassword, false);
  return res.ok;
}

export async function authenticateStaff(
  rawUserId: string,
  rawPassword: string
): Promise<{
  ok: boolean;
  staff: StaffAccount | null;
  message?: string;
  sqlUpdateRequired?: boolean;
}> {
  return authenticateStaffInternal(rawUserId, rawPassword, true);
}

async function authenticateStaffInternal(
  rawUserId: string,
  rawPassword: string,
  establishSession: boolean
): Promise<{
  ok: boolean;
  staff: StaffAccount | null;
  message?: string;
  sqlUpdateRequired?: boolean;
}> {
  await ensureInitialized();
  const normId = rawUserId.trim().toLowerCase();
  const pwd = rawPassword.trim();

  if (!normId) {
    return { ok: false, staff: null, message: 'Masukkan ID Pengguna / Role terlebih dahulu.' };
  }
  if (!pwd) {
    return { ok: false, staff: null, message: 'Masukkan Sandi / PIN terlebih dahulu.' };
  }

  let allowLocalFallback = !isLiveSupabaseConfigured();

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
          if (establishSession) {
            await idbPutStaffSafe([verified]);
            if (verified.userId.trim().toLowerCase() === 'admin') {
              const existingProf = await idbGet<SchoolProfile>(STORES.META, 'default');
              if (existingProf) {
                await idbPut(STORES.META, { ...existingProf, adminPassword: hashedPwd });
              }
            }
            setActiveStaffCredentials(verified);
          }
          return { ok: true, staff: verified };
        }
        const rpcMsg = row.message ? String(row.message).trim() : '';
        const lowerMsg = rpcMsg.toLowerCase();
        if (row.is_active === false || lowerMsg.includes('dinonaktifkan') || lowerMsg === 'inactive') {
          return {
            ok: false,
            staff: null,
            message:
              rpcMsg && lowerMsg !== 'inactive'
                ? rpcMsg
                : `Akun dengan ID "${rawUserId.trim()}" sedang dinonaktifkan oleh Administrator.`,
          };
        }
        if (
          lowerMsg === 'wrong_password' ||
          lowerMsg.includes('sandi') ||
          lowerMsg.includes('pin tidak sesuai')
        ) {
          return {
            ok: false,
            staff: null,
            message:
              rpcMsg && lowerMsg !== 'wrong_password' ? rpcMsg : 'Sandi / PIN tidak sesuai.',
          };
        }
        if (rpcMsg && lowerMsg !== 'not_found') {
          return { ok: false, staff: null, message: rpcMsg };
        }
        if (lowerMsg === 'not_found' || !rpcMsg) {
          // Cek apakah database cloud sudah terisi (otoritatif). Jika ya, jangan fallback ke akun seed lokal!
          const { data: cloudProf, error: profCheckErr } = await supabase
            .from('school_profile')
            .select('id')
            .eq('id', 'default')
            .maybeSingle();
          if (!profCheckErr && cloudProf) {
            return {
              ok: false,
              staff: null,
              message: `ID "${rawUserId.trim()}" tidak ditemukan di database server.`,
            };
          }
          if (!profCheckErr && !cloudProf && normId !== 'admin') {
            return {
              ok: false,
              staff: null,
              message: `ID "${rawUserId.trim()}" tidak ditemukan di database server.`,
            };
          }
          // Hanya izinkan bootstrap awal lokal untuk 'admin' saat database cloud masih kosong total
          allowLocalFallback = normId === 'admin';
        }
      } else if (rpcErr) {
        // Pada PostgreSQL PL/pgSQL, error 42883 ("function digest(text, unknown) does not exist") terjadi saat
        // planning ekspresi IF di fungsi verify_staff_login versi lama — SEBELUM sandi dibandingkan.
        // Akibatnya login ditolak meski sandi benar. Tampilkan instruksi pembaruan SQL tanpa membuka bypass lokal.
        if (isDigestRpcBugError(rpcErr)) {
          return {
            ok: false,
            staff: null,
            sqlUpdateRequired: true,
            message:
              'Fungsi login server (verify_staff_login) di Supabase masih versi lama (error digest 42883), sehingga login selalu ditolak meskipun sandi benar. Jalankan Skrip SQL terbaru di Supabase SQL Editor lalu coba login lagi.',
          };
        }

        if (isNetworkOrOfflineError(rpcErr)) {
          allowLocalFallback = true;
        } else if (isRpcSignatureMismatchError(rpcErr.message)) {
          // Hanya izinkan pembacaan tabel staff_accounts langsung bila service_role (adminClient) aktif
          const adminClient = getSupabaseAdminClient();
          if (adminClient) {
            const { data: remoteStaff, error: staffErr } = await adminClient
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
              if (!mapped.isActive) {
                return {
                  ok: false,
                  staff: null,
                  message: `Akun dengan ID "${mapped.userId}" sedang dinonaktifkan oleh Administrator.`,
                };
              }
              const ok = await verifyPassword(pwd, mapped.password);
              if (!ok) {
                return { ok: false, staff: null, message: 'Sandi / PIN tidak sesuai.' };
              }
              const verified: StaffAccount = { ...mapped, password: hashedPwd };
              if (establishSession) {
                await idbPutStaffSafe([verified]);
                setActiveStaffCredentials(verified);
              }
              return { ok: true, staff: verified };
            }
            if (!staffErr && !remoteStaff) {
              return {
                ok: false,
                staff: null,
                message: `ID "${rawUserId.trim()}" tidak ditemukan di database server.`,
              };
            }
          }
          return {
            ok: false,
            staff: null,
            sqlUpdateRequired: true,
            message:
              'Fungsi login server (verify_staff_login) belum terpasang di Supabase. Salin dan jalankan Skrip SQL terbaru di Supabase SQL Editor lalu coba login lagi.',
          };
        } else {
          return {
            ok: false,
            staff: null,
            message: `Gagal memverifikasi akun ke server (${rpcErr.message}).`,
          };
        }
      }
    } catch (err) {
      if (isNetworkOrOfflineError(err)) {
        allowLocalFallback = true;
      } else {
        return {
          ok: false,
          staff: null,
          message:
            err instanceof Error
              ? `Gagal memverifikasi akun ke server (${err.message}).`
              : 'Gagal memverifikasi akun ke server.',
        };
      }
    }
  }

  if (!allowLocalFallback) {
    return { ok: false, staff: null, message: 'Sandi / PIN tidak sesuai.' };
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
    if (
      profile &&
      profile.adminPassword !== '__CLOUD_MANAGED__' &&
      (await verifyPassword(pwd, profile.adminPassword))
    ) {
      valid = true;
      matched = { ...matched, password: await hashPassword(pwd) };
      if (establishSession) {
        await idbPutStaffSafe([matched]);
      }
    }
  }

  if (!valid) {
    return { ok: false, staff: null, message: 'Sandi / PIN tidak sesuai.' };
  }

  if (establishSession) {
    if (!isPasswordHashed(matched.password)) {
      matched = { ...matched, password: await hashPassword(matched.password) };
      await idbPutStaffSafe([matched]);
    }
    setActiveStaffCredentials(matched);
  }
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
      const adminClient = getSupabaseAdminClient();
      const supabase = getSupabaseClient();
      const authArgs = adminClient ? null : await resolveStaffRpcAuthArgs();
      const CHUNK = 50;
      for (let i = 0; i < normalizedItems.length; i += CHUNK) {
        const chunk = normalizedItems.slice(i, i + CHUNK);
        const rows = chunk.map((p) => ({
          id: p.id,
          participant_number: p.participantNumber,
          token: p.token,
          full_name: p.fullName,
          class_name: p.className,
          is_active: p.isActive,
          created_at: p.createdAt,
        }));
        if (adminClient) {
          await adminClient.from('participants').upsert(rows, { onConflict: 'participant_number' });
        } else {
          const { error: rpcErr } = await supabase.rpc('staff_upsert_participants_batch', {
            ...(authArgs || {}),
            p_participants: rows,
          });
          if (rpcErr && isRpcSignatureMismatchError(rpcErr.message)) {
            await supabase.from('participants').upsert(rows, { onConflict: 'participant_number' });
          }
        }
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
      const adminClient = getSupabaseAdminClient();
      const supabase = getSupabaseClient();
      if (adminClient) {
        await adminClient.from('participants').delete().eq('id', id);
      } else {
        const authArgs = await resolveStaffRpcAuthArgs();
        const { error: rpcErr } = await supabase.rpc('staff_delete_participants', {
          ...authArgs,
          p_ids: [id],
          p_delete_all: false,
        });
        if (rpcErr && isRpcSignatureMismatchError(rpcErr.message)) {
          await supabase.from('participants').delete().eq('id', id);
        }
      }
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
      const adminClient = getSupabaseAdminClient();
      const supabase = getSupabaseClient();
      if (adminClient) {
        const idRes = await fetchAllRowsByIdPaginated<{ id: string }>(
          adminClient,
          'participants',
          'id'
        );
        if (!idRes.error && idRes.data.length > 0) {
          const CHUNK = 50;
          const ids = idRes.data.map((r) => String(r.id));
          for (let i = 0; i < ids.length; i += CHUNK) {
            await adminClient.from('participants').delete().in('id', ids.slice(i, i + CHUNK));
          }
        } else {
          await adminClient.from('participants').delete().not('id', 'is', null);
        }
      } else {
        const authArgs = await resolveStaffRpcAuthArgs();
        const { error: rpcErr } = await supabase.rpc('staff_delete_participants', {
          ...authArgs,
          p_ids: null,
          p_delete_all: true,
        });
        if (rpcErr && isRpcSignatureMismatchError(rpcErr.message)) {
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
        }
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
  status: 'ok' | 'not_found' | 'inactive' | 'wrong_token' | 'server_busy';
  participant: Participant | null;
  source: 'supabase' | 'local-cache';
  bundledResults?: ExamResult[];
  errorMessage?: string;
}> {
  await ensureInitialized();
  const normalizedNum = normalizeParticipantNumber(rawNumber);
  const normalizedToken = (rawToken || '').trim().toUpperCase();
  if (!normalizedNum) {
    return { status: 'not_found', participant: null, source: 'local-cache' };
  }

  let found: Participant | null = null;
  let source: 'supabase' | 'local-cache' = 'local-cache';
  let allowLocalFallback = !isLiveSupabaseConfigured();
  let hadServerOrNetworkFailure = false;

  const isBrowserOffline =
    typeof navigator !== 'undefined' && navigator.onLine === false;

  if (isLiveSupabaseConfigured() && isBrowserOffline) {
    allowLocalFallback = true;
    hadServerOrNetworkFailure = true;
  } else if (isLiveSupabaseConfigured()) {
    const supabase = getSupabaseClient();
    // Backoff lebih lapang + jitter 1.2 detik agar 600-800 siswa yang login serentak tidak memicu retry storm
    const retryBackoffs = [0, 1200, 3000, 6000];

    for (let attempt = 0; attempt < retryBackoffs.length; attempt++) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        allowLocalFallback = true;
        hadServerOrNetworkFailure = true;
        break;
      }
      if (retryBackoffs[attempt] > 0) {
        const jitter = Math.floor(Math.random() * 1200);
        await new Promise((r) => setTimeout(r, retryBackoffs[attempt] + jitter));
      }

      try {
        // Jalur utama: 1 roundtrip RPC student_login_bundle (auth peserta + jam server + hasil ujian siswa)
        if (studentLoginBundleRpcAvailable !== false) {
          const reqStart = Date.now();
          const perfStart = getMonotonicPerfMs();
          const { data: bundleData, error: bundleErr } = await supabase.rpc('student_login_bundle', {
            p_participant_number: normalizedNum,
            p_token: normalizedToken,
          });
          const reqEnd = Date.now();
          const perfEnd = getMonotonicPerfMs();

          if (!bundleErr && Array.isArray(bundleData) && bundleData[0]) {
            studentLoginBundleRpcAvailable = true;
            const row = bundleData[0] as Record<string, unknown>;
            if (typeof row.server_time === 'string') {
              const serverMs = new Date(row.server_time).getTime();
              if (Number.isFinite(serverMs)) {
                const wallMidpoint = Math.round((reqStart + reqEnd) / 2);
                const perfMidpoint = perfStart + (perfEnd - perfStart) / 2;
                applyServerTimeSample(serverMs, wallMidpoint, perfMidpoint);
                writeSharedClockCache(serverClockOffsetMs, serverMs);
              }
            }
            const rpcStatus = String(row.status || 'not_found').trim().toLowerCase();
            if (rpcStatus === 'ok') {
              const verified: Participant = {
                id: String(row.id),
                participantNumber: normalizeParticipantNumber(
                  String(row.participant_number || normalizedNum)
                ),
                token: String(row.token || ''),
                fullName: String(row.full_name),
                className: String(row.class_name),
                isActive: Boolean(row.is_active),
                createdAt: String(row.created_at),
              };
              await idbPutParticipantsSafe([verified]);
              rememberParticipantToken(verified.participantNumber, verified.token);
              recentlyVerifiedParticipants.set(verified.participantNumber, {
                participant: verified,
                verifiedAt: Date.now(),
              });

              const rawResults = Array.isArray(row.results)
                ? (row.results as Record<string, unknown>[])
                : [];
              const mappedResults = rawResults.map((r) => mapDbExamResultRow(r));
              for (const mr of mappedResults) {
                confirmedCloudSessionKeys.add(
                  makeSessionSyncKey(verified.participantNumber, mr.examId)
                );
              }
              const syncRes = await syncResultsStoreAtomic(
                mappedResults,
                verified.participantNumber
              );
              recentlyVerifiedStudentResults.set(verified.participantNumber, {
                results: mappedResults,
                verifiedAt: Date.now(),
              });
              if (syncRes.changed) {
                broadcastDataChange('results');
              }
              const allLocal = await getExamResults();
              const effectiveStudentResults = allLocal.filter(
                (r) =>
                  normalizeParticipantNumber(r.participantNumber) === verified.participantNumber
              );
              return {
                status: 'ok',
                participant: verified,
                source: 'supabase',
                bundledResults: effectiveStudentResults,
              };
            }
            if (rpcStatus === 'inactive' || row.is_active === false) {
              return { status: 'inactive', participant: null, source: 'supabase' };
            }
            if (rpcStatus === 'wrong_token') {
              return { status: 'wrong_token', participant: null, source: 'supabase' };
            }
            return { status: 'not_found', participant: null, source: 'supabase' };
          }

          if (bundleErr) {
            if (isRpcSignatureMismatchError(bundleErr.message)) {
              studentLoginBundleRpcAvailable = false;
              // Langsung lanjut ke fallback verify_participant_login pada iterasi yang sama
            } else {
              hadServerOrNetworkFailure = true;
              if (isNetworkOrOfflineError(bundleErr)) {
                allowLocalFallback = true;
              }
              if (
                isTransientServerOrNetworkError(bundleErr) &&
                attempt < retryBackoffs.length - 1
              ) {
                continue;
              }
              break;
            }
          }
        }

        // Fallback kompatibel mundur jika SQL student_login_bundle belum dijalankan di Supabase
        const { data: rpcData, error: rpcErr } = await supabase.rpc('verify_participant_login', {
          p_participant_number: normalizedNum,
          p_token: normalizedToken,
        });

        if (!rpcErr && Array.isArray(rpcData) && rpcData[0]) {
          const row = rpcData[0] as Record<string, unknown>;
          const rpcStatus = String(row.status || 'not_found').trim().toLowerCase();
          if (rpcStatus === 'ok') {
            const verified: Participant = {
              id: String(row.id),
              participantNumber: normalizeParticipantNumber(
                String(row.participant_number || normalizedNum)
              ),
              token: String(row.token || ''),
              fullName: String(row.full_name),
              className: String(row.class_name),
              isActive: Boolean(row.is_active),
              createdAt: String(row.created_at),
            };
            await idbPutParticipantsSafe([verified]);
            rememberParticipantToken(verified.participantNumber, verified.token);
            recentlyVerifiedParticipants.set(verified.participantNumber, {
              participant: verified,
              verifiedAt: Date.now(),
            });
            return { status: 'ok', participant: verified, source: 'supabase' };
          }
          if (rpcStatus === 'inactive' || row.is_active === false) {
            return { status: 'inactive', participant: null, source: 'supabase' };
          }
          if (rpcStatus === 'wrong_token') {
            return { status: 'wrong_token', participant: null, source: 'supabase' };
          }
          return { status: 'not_found', participant: null, source: 'supabase' };
        }

        if (rpcErr) {
          if (isRpcSignatureMismatchError(rpcErr.message)) {
            // Fallback untuk database lama sebelum RPC verify_participant_login dijalankan
            const { data, error } = await fetchSingleParticipantByNumber(
              supabase,
              normalizedNum,
              false
            );
            if (!error && data) {
              const mapped: Participant = {
                id: String(data.id),
                participantNumber: normalizeParticipantNumber(
                  String(data.participant_number || normalizedNum)
                ),
                token: String(data.token || ''),
                fullName: String(data.full_name),
                className: String(data.class_name),
                isActive: Boolean(data.is_active),
                createdAt: String(data.created_at),
              };
              if (!mapped.isActive) {
                return { status: 'inactive', participant: null, source: 'supabase' };
              }
              found = mapped;
              source = 'supabase';
              await idbPutParticipantsSafe([found]);
              if ((found.token || '').trim().toUpperCase() === normalizedToken) {
                recentlyVerifiedParticipants.set(found.participantNumber, {
                  participant: found,
                  verifiedAt: Date.now(),
                });
              }
              break;
            }
            if (!error && !data) {
              return { status: 'not_found', participant: null, source: 'supabase' };
            }
            hadServerOrNetworkFailure = true;
            if (isNetworkOrOfflineError(error)) {
              allowLocalFallback = true;
            }
            if (!isTransientServerOrNetworkError(error)) {
              break;
            }
            continue;
          }

          hadServerOrNetworkFailure = true;
          if (isNetworkOrOfflineError(rpcErr)) {
            allowLocalFallback = true;
          }
          if (isTransientServerOrNetworkError(rpcErr) && attempt < retryBackoffs.length - 1) {
            continue;
          }
          break;
        }
      } catch (err) {
        hadServerOrNetworkFailure = true;
        if (isNetworkOrOfflineError(err)) {
          allowLocalFallback = true;
        }
        if (isTransientServerOrNetworkError(err) && attempt < retryBackoffs.length - 1) {
          continue;
        }
        break;
      }
    }
  }

  if (!found && allowLocalFallback) {
    const all = await idbGetAll<Participant>(STORES.PARTICIPANTS);
    const matchedLocal =
      all.find((p) => normalizeParticipantNumber(p.participantNumber) === normalizedNum) || null;
    if (matchedLocal) {
      if (!matchedLocal.isActive) {
        return { status: 'inactive', participant: null, source: 'local-cache' };
      }
      found = {
        ...matchedLocal,
        participantNumber: normalizeParticipantNumber(matchedLocal.participantNumber),
      };
    }
  }

  if (!found) {
    // Jangan pernah menampilkan pesan palsu "Nomor Peserta tidak ditemukan" saat server padat (503/429) atau jaringan terputus
    if (hadServerOrNetworkFailure) {
      return {
        status: 'server_busy',
        participant: null,
        source: 'supabase',
        errorMessage:
          'Server ujian sedang padat memproses antrean peserta lain atau koneksi tidak stabil. Tunggu beberapa detik lalu klik Cek Data & Masuk kembali.',
      };
    }
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
    const adminClient = getSupabaseAdminClient();
    const supabase = getSupabaseClient();
    const row = {
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
    };
    if (adminClient) {
      const { error } = await adminClient.from('exam_schedules').upsert(row);
      if (error) return { synced: false, error: error.message };
      return { synced: true };
    }
    const authArgs = await resolveStaffRpcAuthArgs();
    const { error: rpcErr } = await supabase.rpc('staff_upsert_exam_schedules_batch', {
      ...authArgs,
      p_schedules: [row],
    });
    if (!rpcErr) {
      return { synced: true };
    }
    if (isRpcSignatureMismatchError(rpcErr.message)) {
      const { error } = await supabase.from('exam_schedules').upsert(row);
      if (error) return { synced: false, error: error.message };
      return { synced: true };
    }
    return { synced: false, error: rpcErr.message };
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
    const adminClient = getSupabaseAdminClient();
    const supabase = getSupabaseClient();
    if (adminClient) {
      const { error } = await adminClient.from('exam_schedules').delete().eq('id', id);
      if (error) return { synced: false, error: error.message };
      return { synced: true };
    }
    const authArgs = await resolveStaffRpcAuthArgs();
    const { error: rpcErr } = await supabase.rpc('staff_delete_exam_schedules', {
      ...authArgs,
      p_ids: [id],
      p_delete_all: false,
    });
    if (!rpcErr) {
      return { synced: true };
    }
    if (isRpcSignatureMismatchError(rpcErr.message)) {
      const { error } = await supabase.from('exam_schedules').delete().eq('id', id);
      if (error) return { synced: false, error: error.message };
      return { synced: true };
    }
    return { synced: false, error: rpcErr.message };
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
      const adminClient = getSupabaseAdminClient();
      const supabase = getSupabaseClient();
      if (adminClient) {
        if (!hasRestriction) {
          await adminClient.from('exam_schedules').delete().not('id', 'is', null);
        } else {
          const CHUNK = 50;
          for (let i = 0; i < targetIds.length; i += CHUNK) {
            await adminClient.from('exam_schedules').delete().in('id', targetIds.slice(i, i + CHUNK));
          }
        }
      } else {
        const authArgs = await resolveStaffRpcAuthArgs();
        const { error: rpcErr } = await supabase.rpc('staff_delete_exam_schedules', {
          ...authArgs,
          p_ids: hasRestriction ? targetIds : null,
          p_delete_all: !hasRestriction,
        });
        if (rpcErr && isRpcSignatureMismatchError(rpcErr.message)) {
          if (!hasRestriction) {
            await supabase.from('exam_schedules').delete().not('id', 'is', null);
          } else {
            const CHUNK = 50;
            for (let i = 0; i < targetIds.length; i += CHUNK) {
              await supabase.from('exam_schedules').delete().in('id', targetIds.slice(i, i + CHUNK));
            }
          }
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
  if (isLiveSupabaseConfigured() && items.some((q) => questionContainsBase64Image(q))) {
    return {
      synced: false,
      error:
        'Terdapat gambar soal berformat Base64 yang tidak diizinkan disimpan ke database. Unggah ulang gambar soal via Supabase Storage sebelum menyimpan.',
    };
  }
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

    const authArgs = await resolveStaffRpcAuthArgs();
    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK);
      const extendedPayload = chunk.map((q) => buildQuestionDbRow(q, true));
      let { error: rpcError } = await supabase.rpc('upsert_questions_batch', {
        p_questions: extendedPayload,
        ...authArgs,
      });
      if (rpcError && isMissingQuestionColumnsError(rpcError.message)) {
        const legacyPayload = chunk.map((q) => buildQuestionDbRow(q, false));
        const retry = await supabase.rpc('upsert_questions_batch', {
          p_questions: legacyPayload,
          ...authArgs,
        });
        rpcError = retry.error;
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

    const authArgs = await resolveStaffRpcAuthArgs();
    const { error: rpcError } = await supabase.rpc('delete_question_by_id', {
      p_id: id,
      ...authArgs,
    });
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
        const authArgs = await resolveStaffRpcAuthArgs();
        const CHUNK = 20;
        for (let i = 0; i < uniqueIds.length; i += CHUNK) {
          await Promise.all(
            uniqueIds.slice(i, i + CHUNK).map((id) =>
              supabase.rpc('delete_question_by_id', {
                p_id: id,
                ...authArgs,
              })
            )
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
        const authArgs = await resolveStaffRpcAuthArgs();
        const allIds = all.map((q) => q.id);
        const CHUNK = 20;
        for (let i = 0; i < allIds.length; i += CHUNK) {
          await Promise.all(
            allIds.slice(i, i + CHUNK).map((id) =>
              supabase.rpc('delete_question_by_id', {
                p_id: id,
                ...authArgs,
              })
            )
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
  subject?: string,
  options?: {
    participantNumber?: string;
    token?: string;
  }
): Promise<StudentQuestion[]> {
  await ensureInitialized();

  const cacheKey = `${className.trim().toUpperCase()}::${(subject || '').trim().toLowerCase()}`;
  const metaCacheId = `student_q_cache_${cacheKey}`;
  const now = Date.now();

  const memCached = studentQuestionsCache.get(cacheKey);
  if (
    memCached &&
    memCached.questions.length > 0 &&
    now - memCached.cachedAt < STUDENT_QUESTIONS_CACHE_TTL_MS
  ) {
    return memCached.questions;
  }

  // Deduplikasi in-flight: klik ganda atau permintaan paralel mapel & kelas yang sama berbagi 1 RPC
  const existingFlight = inFlightStudentQuestions.get(cacheKey);
  if (existingFlight) {
    return existingFlight;
  }

  const resolvedParticipantNumber =
    normalizeParticipantNumber(
      options?.participantNumber || cachedActiveSession?.participant.participantNumber
    ) || null;
  const resolvedToken = await resolveParticipantToken(
    resolvedParticipantNumber,
    options?.token || cachedActiveSession?.participant.token
  );

  const loaderPromise = (async (): Promise<StudentQuestion[]> => {
    let rpcHadFailure = false;

    if (isLiveSupabaseConfigured() && !isBrowserExplicitlyOffline()) {
      const supabase = getSupabaseClient();
      // 4 percobaan dengan exponential backoff lebih lapang + jitter 1.5s agar tahan badai 800 peserta mulai ujian serentak
      const RETRY_BACKOFFS_MS = [0, 1200, 3200, 6500];
      let hasFreshIdbFallback: boolean | null = null;

      for (let attempt = 0; attempt < RETRY_BACKOFFS_MS.length; attempt++) {
        if (isBrowserExplicitlyOffline()) {
          rpcHadFailure = true;
          break;
        }
        if (attempt > 0) {
          const jitter = Math.floor(Math.random() * 1500);
          await new Promise((r) => setTimeout(r, RETRY_BACKOFFS_MS[attempt] + jitter));
          if (isBrowserExplicitlyOffline()) {
            rpcHadFailure = true;
            break;
          }
        }
        try {
          let rpcRes = await supabase.rpc('get_student_questions', {
            p_class_name: className,
            p_subject: subject || null,
            p_participant_number: resolvedParticipantNumber,
            p_token: resolvedToken,
          });
          if (rpcRes.error && isRpcSignatureMismatchError(rpcRes.error.message)) {
            rpcRes = await supabase.rpc('get_student_questions', {
              p_class_name: className,
              p_subject: subject || null,
            });
          }
          const { data, error } = rpcRes;
          if (!error && Array.isArray(data)) {
            if (data.length > 0) {
              const hydrated = data.map((q) => hydrateStudentQuestionFromDbRow(q));
              studentQuestionsCache.set(cacheKey, { questions: hydrated, cachedAt: Date.now() });
              void idbPut(STORES.META, {
                id: metaCacheId,
                cachedAt: Date.now(),
                questions: hydrated,
              }).catch(() => {});
              return hydrated;
            }
            rpcHadFailure = false;
            break;
          }
          rpcHadFailure = true;
          if (error && !isTransientServerOrNetworkError(error)) {
            break;
          }
        } catch (err) {
          rpcHadFailure = true;
          if (!isTransientServerOrNetworkError(err)) {
            break;
          }
        }

        // Jika sudah gagal 2x saat server padat dan perangkat sudah punya cache soal IDB segar (< 6 jam),
        // hentikan retry lebih awal dan pakai cache lokal agar tidak menambah antrean DB.
        if (attempt >= 1) {
          if (hasFreshIdbFallback === null) {
            try {
              const cachedMeta = await idbGet<{
                id: string;
                cachedAt: number;
                questions: StudentQuestion[];
              }>(STORES.META, metaCacheId);
              hasFreshIdbFallback = Boolean(
                cachedMeta &&
                  Array.isArray(cachedMeta.questions) &&
                  cachedMeta.questions.length > 0 &&
                  Date.now() - Number(cachedMeta.cachedAt || 0) < 6 * 60 * 60 * 1000
              );
            } catch {
              hasFreshIdbFallback = false;
            }
          }
          if (hasFreshIdbFallback) {
            break;
          }
        }
      }
    } else if (isLiveSupabaseConfigured() && isBrowserExplicitlyOffline()) {
      rpcHadFailure = true;
    }

    // Fallback ke cache soal ter-sanitasi di IndexedDB (khusus perangkat siswa yang sudah pernah memuat mapel ini)
    try {
      const cachedMeta = await idbGet<{
        id: string;
        cachedAt: number;
        questions: StudentQuestion[];
      }>(STORES.META, metaCacheId);
      if (
        cachedMeta &&
        Array.isArray(cachedMeta.questions) &&
        cachedMeta.questions.length > 0 &&
        Date.now() - Number(cachedMeta.cachedAt || 0) < 6 * 60 * 60 * 1000
      ) {
        studentQuestionsCache.set(cacheKey, {
          questions: cachedMeta.questions,
          cachedAt: Date.now(),
        });
        return cachedMeta.questions;
      }
    } catch {
      // Ignore IDB meta cache read issues
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
        isBrowserExplicitlyOffline()
          ? 'Perangkat sedang offline dan soal belum tersimpan di cache lokal. Hubungkan internet lalu coba lagi.'
          : 'Server bank soal sedang sibuk memuat data. Silakan tekan tombol Mulai Ujian kembali beberapa detik lagi.'
      );
    }

    return localFiltered;
  })();

  inFlightStudentQuestions.set(cacheKey, loaderPromise);
  try {
    return await loaderPromise;
  } finally {
    if (inFlightStudentQuestions.get(cacheKey) === loaderPromise) {
      inFlightStudentQuestions.delete(cacheKey);
    }
  }
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
            if (!adminClient) {
              const authArgs = await resolveStaffRpcAuthArgs();
              if (authArgs.p_staff_user_id && authArgs.p_staff_password_sha256) {
                const rpcRes = await fetchStaffParticipantsPaginated(supabase, authArgs);
                if (!rpcRes.error) {
                  for (const row of rpcRes.data) {
                    const cls = String((row as { class_name?: string }).class_name || '')
                      .trim()
                      .toUpperCase();
                    if (cls) collected.add(cls);
                  }
                  return Array.from(collected).sort((a, b) => a.localeCompare(b, 'id'));
                }
              }
            }
            const partClient = adminClient || supabase;
            const pageSize = 1000;
            for (let from = 0; from < 20_000; from += pageSize) {
              const { data, error } = await partClient
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
    const coverageAuthArgs = await resolveStaffRpcAuthArgs();
    for (let from = 0; from < 50_000; from += summaryPageSize) {
      const { data, error } = await supabase
        .rpc('get_question_coverage_summary', coverageAuthArgs)
        .range(from, from + summaryPageSize - 1);
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
interface EmergencyAnswersBackup {
  resultId: string;
  participantNumber: string;
  examId: string;
  answers: Record<string, string>;
  flaggedQuestions: string[];
  tabSwitchCount: number;
  savedAt: number;
}

function readEmergencyAnswersBackup(): EmergencyAnswersBackup | null {
  try {
    const raw = localStorage.getItem(ACTIVE_ANSWERS_BACKUP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<EmergencyAnswersBackup>;
    if (
      parsed &&
      typeof parsed.participantNumber === 'string' &&
      typeof parsed.examId === 'string' &&
      parsed.answers &&
      typeof parsed.answers === 'object'
    ) {
      return {
        resultId: String(parsed.resultId || ''),
        participantNumber: parsed.participantNumber.trim().toUpperCase(),
        examId: parsed.examId,
        answers: normalizeDbAnswersMap(parsed.answers),
        flaggedQuestions: Array.isArray(parsed.flaggedQuestions)
          ? (parsed.flaggedQuestions as string[])
          : [],
        tabSwitchCount: Number(parsed.tabSwitchCount || 0),
        savedAt: Number(parsed.savedAt || 0),
      };
    }
  } catch {
    // Ignore localStorage parse errors
  }
  return null;
}

function reconcileSessionWithEmergencyBackup(session: ActiveExamSession): ActiveExamSession {
  const backup = readEmergencyAnswersBackup();
  if (!backup) return session;
  const normPNum = session.participant.participantNumber.trim().toUpperCase();
  const sameSession =
    (backup.resultId && backup.resultId === session.resultId) ||
    (backup.participantNumber === normPNum && backup.examId === session.schedule.id);
  if (!sameSession) return session;

  // Gabungkan jawaban dari backup sinkron localStorage bila transaksi async IndexedDB sempat terpotong saat tab ditutup mendadak
  const mergedAnswers: Record<string, string> = {
    ...session.answers,
    ...backup.answers,
  };
  const backupKeys = Object.keys(backup.answers).length;
  const sessionKeys = Object.keys(session.answers).length;
  const effectiveAnswers =
    backupKeys >= sessionKeys ? { ...backup.answers } : mergedAnswers;

  return {
    ...session,
    answers: effectiveAnswers,
    flaggedQuestions:
      backup.flaggedQuestions.length > 0 || session.flaggedQuestions.length === 0
        ? [...backup.flaggedQuestions]
        : [...session.flaggedQuestions],
    tabSwitchCount: Math.max(session.tabSwitchCount || 0, backup.tabSwitchCount || 0),
  };
}

export function getSavedActiveSession(): ActiveExamSession | null {
  if (cachedActiveSession) {
    cachedActiveSession = reconcileSessionWithEmergencyBackup(cachedActiveSession);
    return cachedActiveSession;
  }
  try {
    const raw = localStorage.getItem(ACTIVE_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ActiveExamSession>;
    if (parsed && Array.isArray(parsed.questions) && parsed.participant && parsed.schedule) {
      cachedActiveSession = reconcileSessionWithEmergencyBackup(parsed as ActiveExamSession);
      return cachedActiveSession;
    }
    return null;
  } catch {
    return null;
  }
}

let activeSessionIdbWriteTimer: ReturnType<typeof setTimeout> | null = null;
let lastSavedActiveSessionMetaKey = '';
let lastSavedActiveSessionIdbResultId = '';
let lastSavedEmergencyBackupSig = '';

function buildEmergencyBackupSignature(session: ActiveExamSession): string {
  const answerKeys = Object.keys(session.answers || {}).sort();
  let sig = `${session.resultId}|${session.tabSwitchCount}|${session.flaggedQuestions.join(',')}|`;
  for (const k of answerKeys) {
    sig += `${k}=${session.answers[k]};`;
  }
  return sig;
}

export function saveActiveSessionLocal(
  session: ActiveExamSession,
  options?: { flushIdbNow?: boolean }
): void {
  cachedActiveSession = session;
  const normParticipantNum = session.participant.participantNumber.trim().toUpperCase();
  rememberParticipantToken(normParticipantNum, session.participant.token);
  const metaKey = `${session.resultId}|${normParticipantNum}|${session.schedule.id}|${session.startedAt}|${session.endsAt}`;

  if (metaKey !== lastSavedActiveSessionMetaKey) {
    try {
      localStorage.setItem(
        ACTIVE_SESSION_KEY,
        JSON.stringify({
          resultId: session.resultId,
          participantNumber: normParticipantNum,
          examId: session.schedule.id,
          startedAt: session.startedAt,
          endsAt: session.endsAt,
        })
      );
      lastSavedActiveSessionMetaKey = metaKey;
    } catch {
      // Ignore localStorage quota restrictions; full session persists in IndexedDB
    }
  }

  // Tulis backup jawaban secara SINKRON ke localStorage hanya saat jawaban/ragu/pelanggaran berubah
  // (navigasi pindah nomor soal tidak perlu memicu serialisasi penuh berulang)
  const backupSig = buildEmergencyBackupSignature(session);
  if (backupSig !== lastSavedEmergencyBackupSig || options?.flushIdbNow) {
    try {
      const backup: EmergencyAnswersBackup = {
        resultId: session.resultId,
        participantNumber: normParticipantNum,
        examId: session.schedule.id,
        answers: { ...session.answers },
        flaggedQuestions: [...session.flaggedQuestions],
        tabSwitchCount: session.tabSwitchCount,
        savedAt: Date.now(),
      };
      localStorage.setItem(ACTIVE_ANSWERS_BACKUP_KEY, JSON.stringify(backup));
      lastSavedEmergencyBackupSig = backupSig;
    } catch {
      // Ignore localStorage quota restrictions on very large answer sets
    }
  }

  // Tulis objek sesi lengkap (termasuk 40+ soal) ke IndexedDB langsung saat pertama kali sesi dimulai / saat flush kritis,
  // lalu gabungkan (coalesce) penulisan klik berikutnya tiap 1,2 detik untuk memangkas >90% overhead structuredClone di perangkat rendah.
  const isFirstIdbForSession = lastSavedActiveSessionIdbResultId !== session.resultId;
  if (isFirstIdbForSession || options?.flushIdbNow) {
    if (activeSessionIdbWriteTimer !== null) {
      clearTimeout(activeSessionIdbWriteTimer);
      activeSessionIdbWriteTimer = null;
    }
    lastSavedActiveSessionIdbResultId = session.resultId;
    void idbPut(STORES.ACTIVE_SESSION, { id: 'current', session }).catch(() => {});
  } else if (activeSessionIdbWriteTimer === null) {
    activeSessionIdbWriteTimer = setTimeout(() => {
      activeSessionIdbWriteTimer = null;
      if (cachedActiveSession) {
        lastSavedActiveSessionIdbResultId = cachedActiveSession.resultId;
        void idbPut(STORES.ACTIVE_SESSION, { id: 'current', session: cachedActiveSession }).catch(
          () => {}
        );
      }
    }, 1200);
  }
}

export function clearActiveSessionLocal(): void {
  cachedActiveSession = null;
  lastSavedActiveSessionMetaKey = '';
  lastSavedActiveSessionIdbResultId = '';
  lastSavedEmergencyBackupSig = '';
  if (activeSessionIdbWriteTimer !== null) {
    clearTimeout(activeSessionIdbWriteTimer);
    activeSessionIdbWriteTimer = null;
  }
  try {
    localStorage.removeItem(ACTIVE_SESSION_KEY);
    localStorage.removeItem(ACTIVE_ANSWERS_BACKUP_KEY);
  } catch {
    // Ignore localStorage restrictions
  }
  void idbDelete(STORES.ACTIVE_SESSION, 'current').catch(() => {});
}

/**
 * Menyimpan snapshot progres `in_progress` terbaru langsung ke IndexedDB `exam_results` (lokal saja,
 * tanpa request jaringan) dengan status `pending` agar tidak pernah terjadi stale-overwrite saat
 * masa tunggu expiry jitter atau ketika tab ditutup mendadak.
 */
export async function saveLocalResultProgressSnapshot(session: ActiveExamSession): Promise<void> {
  await ensureInitialized();
  const normParticipantNum = session.participant.participantNumber.trim().toUpperCase();
  const sessionKey = makeSessionSyncKey(normParticipantNum, session.schedule.id);
  if (finalizingSessionKeys.has(sessionKey)) return;

  const existingLocal = await idbGet<ExamResult>(STORES.RESULTS, session.resultId);
  if (isExamResultFinalized(existingLocal)) return;

  const isLocked = session.tabSwitchCount >= session.schedule.maxTabSwitches;
  const snapshotRecord: ExamResult = {
    id: session.resultId,
    participantId: session.participant.id,
    participantNumber: normParticipantNum,
    studentName: session.participant.fullName,
    className: session.participant.className,
    examId: session.schedule.id,
    examTitle: session.schedule.title,
    subject: session.schedule.subject,
    answers: { ...session.answers },
    flaggedQuestions: [...session.flaggedQuestions],
    questionIds:
      existingLocal?.questionIds && existingLocal.questionIds.length > 0
        ? existingLocal.questionIds
        : session.questions.map((q) => q.id),
    answeredCount: countAnsweredEntries(session.answers),
    correctCount: existingLocal?.correctCount || 0,
    totalQuestions: Math.max(existingLocal?.totalQuestions || 0, session.questions.length),
    score: existingLocal?.score || 0,
    tabSwitchCount: Math.max(existingLocal?.tabSwitchCount || 0, session.tabSwitchCount),
    status: isLocked ? 'flagged' : 'in_progress',
    startedAt: existingLocal?.startedAt || session.startedAt,
    submittedAt: null,
    syncStatus: 'pending',
  };

  await idbPut(STORES.RESULTS, snapshotRecord);
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
  schedule: ExamSchedule,
  token?: string
): Promise<{
  locked: boolean;
  reason: 'in_progress' | 'flagged' | 'submitted' | 'network_error' | null;
  result: ExamResult | null;
  errorMessage?: string;
}> {
  await ensureInitialized();
  const normNum = participantNumber.trim().toUpperCase();
  rememberParticipantToken(normNum, token);

  // Baca record lokal terlebih dahulu agar jawaban lokal yang belum tersinkron (syncStatus: 'pending')
  // atau ujian yang sudah disubmit offline TIDAK PERNAH tertimpa oleh data cloud yang lebih lama.
  const allLocalBefore = await idbGetAll<ExamResult>(STORES.RESULTS);
  const localMatches = allLocalBefore.filter(
    (r) => r.participantNumber.trim().toUpperCase() === normNum && r.examId === schedule.id
  );
  // Prioritaskan record lokal yang sudah final / pending / memiliki jawaban terbanyak
  const localBest =
    localMatches.sort((a, b) => {
      const aFin = isExamResultFinalized(a) ? 2 : a.syncStatus === 'pending' ? 1 : 0;
      const bFin = isExamResultFinalized(b) ? 2 : b.syncStatus === 'pending' ? 1 : 0;
      if (bFin !== aFin) return bFin - aFin;
      return Object.keys(b.answers || {}).length - Object.keys(a.answers || {}).length;
    })[0] || null;

  // Cek juga backup jawaban darurat sinkron (ACTIVE_ANSWERS_BACKUP_KEY) untuk sesi ini
  let backupAnswers: Record<string, string> | null = null;
  let backupFlagged: string[] | null = null;
  let backupTabSwitches = 0;
  try {
    const rawBackup = localStorage.getItem(ACTIVE_ANSWERS_BACKUP_KEY);
    if (rawBackup) {
      const parsed = JSON.parse(rawBackup) as Partial<EmergencyAnswersBackup>;
      if (
        parsed &&
        normalizeParticipantNumber(String(parsed.participantNumber || '')) === normNum &&
        parsed.examId === schedule.id
      ) {
        if (parsed.answers && typeof parsed.answers === 'object') {
          backupAnswers = parsed.answers;
        }
        if (Array.isArray(parsed.flaggedQuestions)) {
          backupFlagged = parsed.flaggedQuestions;
        }
        if (typeof parsed.tabSwitchCount === 'number' && parsed.tabSwitchCount > 0) {
          backupTabSwitches = parsed.tabSwitchCount;
        }
      }
    }
  } catch {
    // Ignore localStorage parse errors
  }

  let matched: ExamResult | null = null;
  let checkedRemote = false;

  if (isLiveSupabaseConfigured()) {
    if (isBrowserExplicitlyOffline()) {
      return {
        locked: true,
        reason: 'network_error',
        result: null,
        errorMessage:
          'Perangkat sedang offline. Sambungkan internet untuk memverifikasi status ujian sebelum masuk ruang ujian.',
      };
    }
    if (syncedServerEpochMs === null) {
      await syncServerClock();
    }
    try {
      const cachedResultsEntry = recentlyVerifiedStudentResults.get(normNum);
      const localHasPendingBeforeCheck = Boolean(localBest && localBest.syncStatus === 'pending');
      let remoteMapped: ExamResult | null = null;

      if (
        cachedResultsEntry &&
        Date.now() - cachedResultsEntry.verifiedAt < RECENT_STUDENT_RESULTS_CACHE_TTL_MS &&
        !localHasPendingBeforeCheck
      ) {
        // Gunakan hasil cloud yang baru saja diverifikasi saat login (< 90 detik) agar tidak menembak SELECT ulang ke exam_results
        checkedRemote = true;
        remoteMapped =
          cachedResultsEntry.results.find((r) => r.examId === schedule.id) || null;
      } else {
        const supabase = getSupabaseClient();
        const { data: remoteMatch, error } = await retryTransientSupabaseCall(
          () =>
            fetchSingleExamResult(
              supabase,
              normNum,
              schedule.id,
              EXAM_RESULTS_ADMIN_COLUMNS,
              { token, includeFull: true }
            ),
          { backoffsMs: [0, 1200, 3000, 6000], jitterMs: 1500 }
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
        remoteMapped = remoteMatch ? mapDbExamResultRow(remoteMatch) : null;
      }

      if (remoteMapped) {
        confirmedCloudSessionKeys.add(makeSessionSyncKey(normNum, schedule.id));

        const localHasPending = Boolean(localBest && localBest.syncStatus === 'pending');
        const localIsFinalizedPending = Boolean(localHasPending && isExamResultFinalized(localBest));

        // KASUS 1 (KRITIS): Siswa sudah menyelesaikan ujian saat offline (status lokal submitted/flagged, pending),
        // sementara server masih in_progress. JANGAN timpa lokal — segera kirim & kunci hasil final ke server!
        if (localIsFinalizedPending && !isExamResultFinalized(remoteMapped) && localBest) {
          const mergedAnswers = {
            ...(remoteMapped.answers || {}),
            ...(localBest.answers || {}),
            ...(backupAnswers || {}),
          };
          const toFinalize: ExamResult = {
            ...localBest,
            id: remoteMapped.id || localBest.id,
            answers: mergedAnswers,
            flaggedQuestions: Array.from(
              new Set([
                ...(remoteMapped.flaggedQuestions || []),
                ...(localBest.flaggedQuestions || []),
                ...(backupFlagged || []),
              ])
            ),
            questionIds:
              remoteMapped.questionIds && remoteMapped.questionIds.length > 0
                ? remoteMapped.questionIds
                : localBest.questionIds,
            tabSwitchCount: Math.max(
              remoteMapped.tabSwitchCount || 0,
              localBest.tabSwitchCount || 0,
              backupTabSwitches
            ),
            startedAt: remoteMapped.startedAt || localBest.startedAt,
            syncStatus: 'pending',
          };
          if (localBest.id !== toFinalize.id) {
            await idbDelete(STORES.RESULTS, localBest.id);
          }
          const finalized = await finalizeExamResultRecord(toFinalize, {
            maxTabSwitches: schedule.maxTabSwitches,
            skipIfFinalized: false,
            broadcast: true,
          });
          matched = finalized;
        }
        // KASUS 2 (KRITIS): Server masih in_progress, namun perangkat lokal memiliki jawaban pending / backup darurat
        // yang belum sempat tersinkron. Gabungkan (merge) agar 0 jawaban lokal yang hilang!
        else if (
          !isExamResultFinalized(remoteMapped) &&
          (localHasPending || (backupAnswers && Object.keys(backupAnswers).length > 0))
        ) {
          const mergedAnswers: Record<string, string> = {
            ...(remoteMapped.answers || {}),
            ...(localHasPending && localBest ? localBest.answers || {} : {}),
            ...(backupAnswers || {}),
          };
          const mergedFlagged = Array.from(
            new Set([
              ...(remoteMapped.flaggedQuestions || []),
              ...(localHasPending && localBest ? localBest.flaggedQuestions || [] : []),
              ...(backupFlagged || []),
            ])
          );
          const mergedTabSwitches = Math.max(
            remoteMapped.tabSwitchCount || 0,
            localHasPending && localBest ? localBest.tabSwitchCount || 0 : 0,
            backupTabSwitches
          );
          const remoteAnsCount = Object.keys(remoteMapped.answers || {}).length;
          const mergedAnsCount = Object.keys(mergedAnswers).length;
          const hasLocalDiff =
            mergedAnsCount > remoteAnsCount ||
            mergedTabSwitches > (remoteMapped.tabSwitchCount || 0) ||
            JSON.stringify(mergedAnswers) !== JSON.stringify(remoteMapped.answers || {});

          matched = {
            ...remoteMapped,
            answers: mergedAnswers,
            flaggedQuestions: mergedFlagged,
            tabSwitchCount: mergedTabSwitches,
            questionIds:
              remoteMapped.questionIds && remoteMapped.questionIds.length > 0
                ? remoteMapped.questionIds
                : localBest?.questionIds,
            syncStatus: hasLocalDiff ? 'pending' : 'synced',
          };
          if (localBest && localBest.id !== matched.id) {
            await idbDelete(STORES.RESULTS, localBest.id);
          }
          await idbPut(STORES.RESULTS, matched);
        }
        // KASUS 3: Server sudah berstatus submitted (mis. auto-expired saat offline), namun lokal punya jawaban pending
        // lebih lengkap — coba rekonsiliasi aman via submit_exam_and_score sebelum mengunci ke hasil server.
        else if (
          remoteMapped.status === 'submitted' &&
          localHasPending &&
          localBest &&
          Object.keys({ ...(remoteMapped.answers || {}), ...(localBest.answers || {}) }).length >
            Object.keys(remoteMapped.answers || {}).length
        ) {
          const reconciledCandidate: ExamResult = {
            ...remoteMapped,
            answers: {
              ...(remoteMapped.answers || {}),
              ...(localBest.answers || {}),
              ...(backupAnswers || {}),
            },
            tabSwitchCount: Math.max(
              remoteMapped.tabSwitchCount || 0,
              localBest.tabSwitchCount || 0,
              backupTabSwitches
            ),
            syncStatus: 'pending',
          };
          if (localBest.id !== reconciledCandidate.id) {
            await idbDelete(STORES.RESULTS, localBest.id);
          }
          matched = await finalizeExamResultRecord(reconciledCandidate, {
            maxTabSwitches: schedule.maxTabSwitches,
            skipIfFinalized: false,
            broadcast: true,
          });
        } else {
          matched = remoteMapped;
          if (localBest && localBest.id !== matched.id) {
            await idbDelete(STORES.RESULTS, localBest.id);
          }
          await idbPut(STORES.RESULTS, matched);
        }
      } else if (localBest && localBest.syncStatus === 'pending') {
        // Baris belum sempat tercipta di cloud (mis. mulai/submit saat jaringan putus), pertahankan lokal!
        if (isExamResultFinalized(localBest)) {
          matched = await finalizeExamResultRecord(localBest, {
            maxTabSwitches: schedule.maxTabSwitches,
            skipIfFinalized: false,
            broadcast: true,
          });
        } else {
          matched = localBest;
        }
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
    matched = localBest;
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
  scheduleId: string,
  options?: { forceRefresh?: boolean; token?: string }
): Promise<{
  ok: boolean;
  participant?: Participant;
  schedule?: ExamSchedule;
  message?: string;
}> {
  await ensureInitialized();
  const normNum = participantNumber.trim().toUpperCase();
  rememberParticipantToken(normNum, options?.token);

  if (isLiveSupabaseConfigured()) {
    try {
      const now = Date.now();
      const cachedPartEntry = !options?.forceRefresh
        ? recentlyVerifiedParticipants.get(normNum)
        : undefined;
      const freshCachedParticipant =
        cachedPartEntry &&
        cachedPartEntry.participant.isActive &&
        now - cachedPartEntry.verifiedAt < RECENT_PREFLIGHT_CACHE_TTL_MS
          ? cachedPartEntry.participant
          : null;

      const cachedSchedEntry = !options?.forceRefresh
        ? verifiedSchedulesCache.get(scheduleId)
        : undefined;
      const freshCachedSchedule =
        cachedSchedEntry &&
        cachedSchedEntry.schedule.isActive &&
        now - cachedSchedEntry.verifiedAt < RECENT_PREFLIGHT_CACHE_TTL_MS
          ? cachedSchedEntry.schedule
          : null;

      // Jika peserta baru saja diverifikasi saat login dan jadwal baru saja disinkronkan (< 60 detik),
      // lewati preflight SELECT berulang ke tabel participants & exam_schedules.
      if (freshCachedParticipant && freshCachedSchedule) {
        if (!freshCachedSchedule.targetClasses.includes(freshCachedParticipant.className)) {
          return {
            ok: false,
            message: `Kelas ${freshCachedParticipant.className} tidak terdaftar pada jadwal ujian ini.`,
          };
        }
        return {
          ok: true,
          participant: freshCachedParticipant,
          schedule: freshCachedSchedule,
        };
      }

      const supabase = getSupabaseClient();
      if (isBrowserExplicitlyOffline()) {
        return {
          ok: false,
          message:
            'Perangkat sedang offline. Hubungkan internet lalu tekan Mulai Ujian kembali.',
        };
      }
      const resolvedToken = await resolveParticipantToken(normNum, options?.token);
      const fetchParticipantForPreflight = async (): Promise<{
        data: Record<string, unknown> | null;
        error?: { message: string } | null;
      }> => {
        let rpcRes = await supabase.rpc('check_participant_active', {
          p_participant_number: normNum,
          p_token: resolvedToken,
        });
        if (rpcRes.error && isRpcSignatureMismatchError(rpcRes.error.message)) {
          rpcRes = await supabase.rpc('check_participant_active', {
            p_participant_number: normNum,
          });
        }
        if (!rpcRes.error) {
          const row =
            Array.isArray(rpcRes.data) && rpcRes.data[0]
              ? (rpcRes.data[0] as Record<string, unknown>)
              : null;
          return { data: row, error: null };
        }
        if (isRpcSignatureMismatchError(rpcRes.error.message)) {
          return fetchSingleParticipantByNumber(supabase, normNum, false);
        }
        return { data: null, error: rpcRes.error };
      };

      const fetchScheduleForPreflight = (): Promise<{
        data: Record<string, unknown> | null;
        error?: { message: string } | null;
      }> => {
        const existingFlight = inFlightSchedulePreflight.get(scheduleId);
        if (existingFlight) return existingFlight;
        const p = retryTransientSupabaseCall(
          async () => {
            const res = await supabase
              .from('exam_schedules')
              .select('*')
              .eq('id', scheduleId)
              .maybeSingle();
            return {
              data: (res.data as Record<string, unknown> | null) ?? null,
              error: res.error,
            };
          },
          { backoffsMs: [0, 1200, 3000, 6000], jitterMs: 1500 }
        ).finally(() => {
          if (inFlightSchedulePreflight.get(scheduleId) === p) {
            inFlightSchedulePreflight.delete(scheduleId);
          }
        });
        inFlightSchedulePreflight.set(scheduleId, p);
        return p;
      };

      const [pRes, sRes] = await Promise.all([
        freshCachedParticipant
          ? Promise.resolve<{ data: Record<string, unknown> | null; error?: { message: string } | null }>({
              data: null,
              error: null,
            })
          : retryTransientSupabaseCall(() => fetchParticipantForPreflight(), {
              backoffsMs: [0, 1200, 3000, 6000],
              jitterMs: 1500,
            }),
        freshCachedSchedule
          ? Promise.resolve<{ data: Record<string, unknown> | null; error?: { message: string } | null }>({
              data: null,
              error: null,
            })
          : fetchScheduleForPreflight(),
      ]);

      if (pRes.error || sRes.error) {
        return {
          ok: false,
          message: 'Gagal memverifikasi status peserta/jadwal ke server. Coba lagi.',
        };
      }

      let freshParticipant = freshCachedParticipant;
      if (!freshParticipant) {
        if (!pRes.data || !pRes.data.is_active) {
          return {
            ok: false,
            message: 'Akun peserta Anda sedang dinonaktifkan atau dihapus oleh Panitia.',
          };
        }
        const localPrevParticipant = (await idbGetAll<Participant>(STORES.PARTICIPANTS)).find(
          (p) => normalizeParticipantNumber(p.participantNumber) === normNum
        );
        freshParticipant = {
          id: String(pRes.data.id),
          participantNumber: normalizeParticipantNumber(String(pRes.data.participant_number || normNum)),
          token: String(pRes.data.token || localPrevParticipant?.token || ''),
          fullName: String(pRes.data.full_name),
          className: String(pRes.data.class_name),
          isActive: Boolean(pRes.data.is_active),
          createdAt: String(pRes.data.created_at),
        };
        await idbPutParticipantsSafe([freshParticipant]);
        recentlyVerifiedParticipants.set(freshParticipant.participantNumber, {
          participant: freshParticipant,
          verifiedAt: Date.now(),
        });
      }

      let freshSchedule = freshCachedSchedule;
      if (!freshSchedule) {
        if (!sRes.data || !sRes.data.is_active) {
          return {
            ok: false,
            message: 'Jadwal ujian ini sudah ditutup atau dinonaktifkan oleh Panitia.',
          };
        }
        freshSchedule = {
          id: String(sRes.data.id),
          title: String(sRes.data.title || ''),
          subject: String(sRes.data.subject || ''),
          kkm: Number(sRes.data.kkm ?? 75),
          durationMinutes: Number(sRes.data.duration_minutes ?? 60),
          targetClasses: Array.isArray(sRes.data.target_classes)
            ? (sRes.data.target_classes as string[])
            : [],
          isActive: Boolean(sRes.data.is_active),
          randomizeQuestions: Boolean(sRes.data.randomize_questions ?? false),
          maxTabSwitches: Number(sRes.data.max_tab_switches ?? 3),
          createdAt: String(sRes.data.created_at || new Date().toISOString()),
        };
        await idbPut(STORES.SCHEDULES, freshSchedule);
        verifiedSchedulesCache.set(freshSchedule.id, {
          schedule: freshSchedule,
          verifiedAt: Date.now(),
        });
      }

      if (!freshSchedule.targetClasses.includes(freshParticipant.className)) {
        return {
          ok: false,
          message: `Kelas ${freshParticipant.className} tidak terdaftar pada jadwal ujian ini.`,
        };
      }

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
  examId: string,
  options?: {
    forceNetwork?: boolean;
    activeAnswers?: Record<string, string>;
    activeTabSwitchCount?: number;
    maxTabSwitches?: number;
    token?: string;
  }
): Promise<{
  status: 'ok' | 'finalized' | 'reset_deleted' | 'unsynced_local' | 'offline';
  result?: ExamResult;
}> {
  if (!isLiveSupabaseConfigured() || isBrowserExplicitlyOffline()) {
    return { status: 'offline' };
  }
  const sessionKey = makeSessionSyncKey(participantNumber, examId);
  rememberParticipantToken(participantNumber, options?.token);

  // Jangan pernah menimpa atau menginterupsi proses submit final yang sedang berjalan
  if (finalizingSessionKeys.has(sessionKey)) {
    return { status: 'ok' };
  }

  // Deduplikasi polling: jika autosave baru saja terkonfirmasi sukses di server (<25 detik)
  // dan verifikasi penuh terakhir belum melewati batas 2 menit, lewati SELECT berulang untuk hemat DB read pada 800 peserta.
  if (!options?.forceNetwork) {
    const now = Date.now();
    const lastProgressOk = lastCloudProgressConfirmedAt.get(sessionKey) || 0;
    const lastFullCheck = lastLivePollCloudCheckAt.get(sessionKey) || 0;
    if (
      lastProgressOk > 0 &&
      now - lastProgressOk < LIVE_POLL_RECENT_SYNC_SKIP_MS &&
      lastFullCheck > 0 &&
      now - lastFullCheck < LIVE_POLL_MAX_SKIP_WINDOW_MS
    ) {
      return { status: 'ok' };
    }
  }

  const resolveFinalizedRowSafely = async (
    mapped: ExamResult
  ): Promise<{
    status: 'ok' | 'finalized';
    result?: ExamResult;
  }> => {
    if (finalizingSessionKeys.has(sessionKey)) {
      return { status: 'ok' };
    }
    // Cek apakah lokal / sesi aktif memiliki jawaban lebih lengkap dibanding baris server
    // (misalnya server melakukan auto_expired saat perangkat sempat offline).
    if (mapped.status === 'submitted') {
      const normNum = normalizeParticipantNumber(participantNumber);
      const localList = await idbGetAll<ExamResult>(STORES.RESULTS);
      const localMatch = localList.find(
        (r) => normalizeParticipantNumber(r.participantNumber) === normNum && r.examId === examId
      );
      const localAnswers = localMatch?.answers || {};
      const activeAnswers = options?.activeAnswers || {};
      const mergedAnswers: Record<string, string> = {
        ...(mapped.answers || {}),
        ...localAnswers,
        ...activeAnswers,
      };
      if (Object.keys(mergedAnswers).length > Object.keys(mapped.answers || {}).length) {
        const reconciledCandidate: ExamResult = {
          ...mapped,
          answers: mergedAnswers,
          tabSwitchCount: Math.max(
            mapped.tabSwitchCount || 0,
            localMatch?.tabSwitchCount || 0,
            options?.activeTabSwitchCount || 0
          ),
          syncStatus: 'pending',
        };
        const reconciled = await finalizeExamResultRecord(reconciledCandidate, {
          maxTabSwitches: options?.maxTabSwitches ?? 3,
          skipIfFinalized: false,
          broadcast: true,
        });
        return { status: 'finalized', result: reconciled };
      }
    }
    await idbPut(STORES.RESULTS, mapped);
    return { status: 'finalized', result: mapped };
  };

  try {
    const supabase = getSupabaseClient();
    const { data: statusRow, error } = await fetchSingleExamResult(
      supabase,
      participantNumber,
      examId,
      EXAM_RESULTS_LIVE_STATUS_COLUMNS,
      { token: options?.token, includeFull: false }
    );

    if (error) return { status: 'offline' };
    if (finalizingSessionKeys.has(sessionKey)) {
      return { status: 'ok' };
    }

    if (!statusRow) {
      // Guard anti-false-reset: jika sesi lokal belum pernah terkonfirmasi masuk ke cloud
      // (misalnya saat awal mulai ujian jaringan padat sehingga upsert awal gagal),
      // JANGAN hapus jawaban lokal siswa — minta sinkronisasi ulang antrean pending.
      const localList = await idbGetAll<ExamResult>(STORES.RESULTS);
      const normNum = participantNumber.trim().toUpperCase();
      const localMatch = localList.find(
        (r) => r.participantNumber.trim().toUpperCase() === normNum && r.examId === examId
      );
      const wasEverConfirmedOnCloud =
        confirmedCloudSessionKeys.has(sessionKey) || localMatch?.syncStatus === 'synced';

      if (!wasEverConfirmedOnCloud) {
        return { status: 'unsynced_local' };
      }

      // Konfirmasi ulang sekali lagi setelah jeda singkat untuk mencegah false-reset akibat replika/jaringan
      await new Promise((r) => setTimeout(r, 1200));
      if (finalizingSessionKeys.has(sessionKey)) {
        return { status: 'ok' };
      }
      const { data: confirmRow, error: confirmErr } = await fetchSingleExamResult(
        supabase,
        participantNumber,
        examId,
        EXAM_RESULTS_LIVE_STATUS_COLUMNS,
        { token: options?.token, includeFull: false }
      );
      if (confirmErr) return { status: 'offline' };
      if (confirmRow) {
        confirmedCloudSessionKeys.add(sessionKey);
        lastLivePollCloudCheckAt.set(sessionKey, Date.now());
        const confirmStatus = String(confirmRow.status || 'in_progress');
        if (confirmStatus === 'submitted' || confirmStatus === 'flagged') {
          const { data: fullRow, error: fullErr } = await fetchSingleExamResult(
            supabase,
            participantNumber,
            examId,
            EXAM_RESULTS_ADMIN_COLUMNS,
            { token: options?.token, includeFull: true }
          );
          if (!fullErr && fullRow) {
            const mapped = mapDbExamResultRow(fullRow);
            return await resolveFinalizedRowSafely(mapped);
          }
          return { status: 'offline' };
        }
        return { status: 'ok' };
      }

      confirmedCloudSessionKeys.delete(sessionKey);
      lastCloudProgressConfirmedAt.delete(sessionKey);
      lastLivePollCloudCheckAt.delete(sessionKey);
      return { status: 'reset_deleted' };
    }

    confirmedCloudSessionKeys.add(sessionKey);
    lastLivePollCloudCheckAt.set(sessionKey, Date.now());
    const rowStatus = String(statusRow.status || 'in_progress');
    if (rowStatus === 'submitted' || rowStatus === 'flagged') {
      const { data: fullRow, error: fullErr } = await fetchSingleExamResult(
        supabase,
        participantNumber,
        examId,
        EXAM_RESULTS_ADMIN_COLUMNS,
        { token: options?.token, includeFull: true }
      );

      if (!fullErr && fullRow) {
        const mapped = mapDbExamResultRow(fullRow);
        return await resolveFinalizedRowSafely(mapped);
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
  if (normNum && existing) {
    const sKey = makeSessionSyncKey(normNum, existing.examId);
    confirmedCloudSessionKeys.delete(sKey);
    lastCloudProgressConfirmedAt.delete(sKey);
    lastLivePollCloudCheckAt.delete(sKey);
  }
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
        await retryTransientSupabaseCall(
          async () => await adminClient.from('exam_results').delete().eq('id', resultId),
          { backoffsMs: [0, 350, 900], jitterMs: 400 }
        );
        if (normNum && existing) {
          await retryTransientSupabaseCall(
            async () =>
              await adminClient
                .from('exam_results')
                .delete()
                .eq('participant_number', normNum)
                .eq('exam_id', existing.examId),
            { backoffsMs: [0, 350, 900], jitterMs: 400 }
          );
        }
      } else {
        const authArgs = await resolveStaffRpcAuthArgs();
        await retryTransientSupabaseCall(
          async () =>
            await supabase.rpc('staff_delete_exam_results', {
              ...authArgs,
              p_result_ids: [resultId],
              p_participant_number: normNum || null,
              p_exam_id: existing?.examId || null,
            }),
          { backoffsMs: [0, 350, 900], jitterMs: 400 }
        );
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
  for (const m of matched) {
    const sKey = makeSessionSyncKey(m.participantNumber, m.examId);
    confirmedCloudSessionKeys.delete(sKey);
    lastCloudProgressConfirmedAt.delete(sKey);
    lastLivePollCloudCheckAt.delete(sKey);
  }
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
          normalizeParticipantNumber(savedSession.participant.participantNumber) ===
            normalizeParticipantNumber(existing.participantNumber) &&
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
      const authArgs = adminClient ? null : await resolveStaffRpcAuthArgs();
      const CHUNK = 50;
      const runDeleteChunk = async (chunk: string[]): Promise<boolean> => {
        try {
          if (adminClient) {
            const res = await retryTransientSupabaseCall(
              async () => await adminClient.from('exam_results').delete().in('id', chunk),
              { backoffsMs: [0, 300, 750, 1500, 2600], jitterMs: 400 }
            );
            return !res.error;
          } else if (authArgs) {
            const res = await retryTransientSupabaseCall(
              async () =>
                await supabase.rpc('staff_delete_exam_results', {
                  ...authArgs,
                  p_result_ids: chunk,
                  p_participant_number: null,
                  p_exam_id: null,
                }),
              { backoffsMs: [0, 300, 750, 1500, 2600], jitterMs: 400 }
            );
            return !res.error;
          }
          return true;
        } catch {
          return false;
        }
      };

      const failedChunks: string[][] = [];
      for (let i = 0; i < uniqueIds.length; i += CHUNK) {
        const chunk = uniqueIds.slice(i, i + CHUNK);
        const ok = await runDeleteChunk(chunk);
        if (!ok) {
          failedChunks.push(chunk);
        }
      }
      // Putaran pemulihan kedua bila ada batch yang gagal sementara saat badai beban puncak
      if (failedChunks.length > 0 && !isBrowserExplicitlyOffline()) {
        await new Promise((r) => setTimeout(r, 800));
        for (const chunk of failedChunks) {
          await runDeleteChunk(chunk);
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
  confirmedCloudSessionKeys.clear();
  lastCloudProgressConfirmedAt.clear();
  lastLivePollCloudCheckAt.clear();

  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORES.RESULTS, 'readwrite');
    tx.objectStore(STORES.RESULTS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  await idbDelete(STORES.META, DASHBOARD_HIDDEN_LOGS_META_ID);
  clearActiveSessionLocal();
  lastAdminResultsCursor = null;
  lastAdminDeletedReconcileMs = 0;
  invalidateStoreCache(STORES.RESULTS);

  if (isLiveSupabaseConfigured()) {
    try {
      const adminClient = getSupabaseAdminClient();
      const supabase = getSupabaseClient();
      const readClient = adminClient || supabase;
      const idRes = await fetchAdminExamResultIdsPaginated(
        readClient,
        Boolean(adminClient),
        100_000
      );
      if (!idRes.error && idRes.data.length > 0) {
        const authArgs = adminClient ? null : await resolveStaffRpcAuthArgs();
        const CHUNK = 50;
        const ids = idRes.data;
        for (let i = 0; i < ids.length; i += CHUNK) {
          const chunk = ids.slice(i, i + CHUNK);
          try {
            if (adminClient) {
              await retryTransientSupabaseCall(
                async () => await adminClient.from('exam_results').delete().in('id', chunk),
                { backoffsMs: [0, 300, 750, 1500, 2600], jitterMs: 400 }
              );
            } else if (authArgs) {
              await retryTransientSupabaseCall(
                async () =>
                  await supabase.rpc('staff_delete_exam_results', {
                    ...authArgs,
                    p_result_ids: chunk,
                    p_participant_number: null,
                    p_exam_id: null,
                  }),
                { backoffsMs: [0, 300, 750, 1500, 2600], jitterMs: 400 }
              );
            }
          } catch {
            // Continue clearing remaining chunks
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
): Promise<{ ok: boolean; finalizedFromServer?: ExamResult; serverStartedAt?: string }> {
  if (!isLiveSupabaseConfigured() || isBrowserExplicitlyOffline()) {
    return { ok: false };
  }
  try {
    const supabase = getSupabaseClient();
    const adminClient = getSupabaseAdminClient();
    const normParticipant = normalizeParticipantNumber(result.participantNumber);
    const participantToken = await resolveParticipantToken(normParticipant);
    const sessionKey = makeSessionSyncKey(normParticipant, result.examId);
    const syncKey = `${result.id}::${normParticipant}::${result.examId}`;
    const hasQuestionIds = Boolean(result.questionIds && result.questionIds.length > 0);
    const shouldIncludeQuestionIds =
      hasQuestionIds &&
      (options?.includeQuestionIds !== false || !confirmedQuestionIdsSyncSet.has(syncKey));

    if (result.status === 'in_progress' && result.submittedAt === null) {
      let rpcCall = await supabase.rpc('upsert_exam_progress', {
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
        p_token: participantToken,
      });

      if (rpcCall.error && isRpcSignatureMismatchError(rpcCall.error.message)) {
        rpcCall = await supabase.rpc('upsert_exam_progress', {
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
      }

      const { data: rpcData, error: rpcError } = rpcCall;

      if (!rpcError && Array.isArray(rpcData) && rpcData[0]) {
        const rpcRow = rpcData[0] as Record<string, unknown>;
        const serverStartedAt =
          typeof rpcRow.started_at === 'string' && rpcRow.started_at.trim()
            ? rpcRow.started_at
            : undefined;
        if (rpcRow.applied === true) {
          confirmedCloudSessionKeys.add(sessionKey);
          lastCloudProgressConfirmedAt.set(sessionKey, Date.now());
          if (shouldIncludeQuestionIds) {
            confirmedQuestionIdsSyncSet.add(syncKey);
          }
          return { ok: true, serverStartedAt };
        }
        const { data: serverRow } = await fetchSingleExamResult(
          supabase,
          normParticipant,
          result.examId,
          EXAM_RESULTS_ADMIN_COLUMNS,
          { token: participantToken, includeFull: true }
        );

        if (serverRow) {
          return { ok: false, finalizedFromServer: mapDbExamResultRow(serverRow) };
        }
        return { ok: false };
      }

      // Role anon tidak memiliki hak INSERT/UPDATE langsung ke exam_results; hanya adminClient (service_role) yang boleh direct write
      if (!adminClient) {
        return { ok: false };
      }

      const { data: existingRow, error: checkErr } = await fetchSingleExamResult(
        adminClient,
        normParticipant,
        result.examId,
        EXAM_RESULTS_ADMIN_COLUMNS,
        { isAdminClient: true }
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

        let { error: updErr } = await adminClient
          .from('exam_results')
          .update(updatePayload)
          .eq('id', String(existingRow.id))
          .eq('status', 'in_progress')
          .is('submitted_at', null);

        if (updErr && 'question_ids' in updatePayload && updErr.message.includes('question_ids')) {
          delete updatePayload.question_ids;
          const retry = await adminClient
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

      let { error: insErr } = await adminClient.from('exam_results').insert(insertPayload);
      if (insErr && 'question_ids' in insertPayload && insErr.message.includes('question_ids')) {
        delete insertPayload.question_ids;
        const retry = await adminClient.from('exam_results').insert(insertPayload);
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
      const authArgs = await resolveStaffRpcAuthArgs();
      const { error: rpcErr } = await supabase.rpc('staff_upsert_exam_results_batch', {
        ...authArgs,
        p_results: [basePayload],
      });
      if (!rpcErr) {
        if (hasQuestionIds) confirmedQuestionIdsSyncSet.add(syncKey);
        return { ok: true };
      }
      return { ok: false };
    }

    // Pada perangkat siswa (role anon tanpa kredensial staf), gunakan submit_exam_and_score SECURITY DEFINER
    const schedules = await getExamSchedules();
    const matchedSched = findScheduleForExam(schedules, result.examId, result.subject);
    let scoreCall = await supabase.rpc('submit_exam_and_score', {
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
      p_token: participantToken,
    });
    if (scoreCall.error && isRpcSignatureMismatchError(scoreCall.error.message)) {
      scoreCall = await supabase.rpc('submit_exam_and_score', {
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
    }
    const { data: scoreData, error: scoreErr } = scoreCall;
    if (!scoreErr && Array.isArray(scoreData) && scoreData[0] && Number(scoreData[0].total_questions) > 0) {
      if (hasQuestionIds) confirmedQuestionIdsSyncSet.add(syncKey);
      return { ok: true };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

// Grace period finalisasi global dibuat lebih besar dari batas atas expiryJitter ExamRoom (30s) + submit deadline (35s)
// dan ADMIN_EXPIRY_GRACE_MS = 5 menit agar auto-finalize Admin tidak mendahului siswa yang sedang retry/reconnect.
const EXPIRY_GRACE_MS = 120_000;
const ADMIN_EXPIRY_GRACE_MS = 300_000;
const KEEPALIVE_SAFE_MAX_BYTES = 54 * 1024;
const KEEPALIVE_HARD_MAX_BYTES = 60 * 1024;
const KEEPALIVE_DEDUP_WINDOW_MS = 3_000;

export interface KeepaliveFlushReport {
  attempted: boolean;
  skippedDuplicate: boolean;
  usedKeepalive: boolean;
  compacted: boolean;
  byteLength: number;
}

const lastKeepaliveFlushMap = new Map<string, { fingerprint: string; ts: number }>();

function measureUtf8ByteLength(text: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text).length;
  }
  return text.length * 2;
}

/**
 * Mengompresi jawaban JSON-stringified (soal Menjodohkan) menjadi objek JSON native agar tidak terkena
 * double-escaping (`\"`), menghemat ~20-30% ukuran payload keepalive tanpa kehilangan 1 byte data pun.
 * Baik RPC `submit_exam_and_score` maupun `mapDbExamResultRow` & `parseMatchingMap` mendukung objek native.
 */
function compactAnswersForKeepalive(
  answers: Record<string, string>
): { compacted: Record<string, unknown>; changed: boolean } {
  const out: Record<string, unknown> = {};
  let changed = false;
  for (const [qId, rawVal] of Object.entries(answers || {})) {
    if (typeof rawVal === 'string') {
      const trimmed = rawVal.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            out[qId] = parsed;
            changed = true;
            continue;
          }
        } catch {
          // Keep original string if not valid JSON object
        }
      }
    }
    out[qId] = rawVal;
  }
  return { compacted: out, changed };
}

function buildKeepaliveStateFingerprint(session: ActiveExamSession): string {
  const keys = Object.keys(session.answers || {}).sort();
  let sig = `${session.tabSwitchCount}|${session.flaggedQuestions.join(',')}|`;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    sig += `${k}:${session.answers[k]};`;
  }
  return sig;
}

export function flushExamProgressKeepalive(session: ActiveExamSession): KeepaliveFlushReport {
  const normParticipantNum = session.participant.participantNumber.trim().toUpperCase();
  const sessionKey = makeSessionSyncKey(normParticipantNum, session.schedule.id);
  const isLocked = session.tabSwitchCount >= session.schedule.maxTabSwitches;
  if (!isLocked) {
    saveActiveSessionLocal(session, { flushIdbNow: true });
    void saveLocalResultProgressSnapshot(session).catch(() => {});
  }
  if (!isLiveSupabaseConfigured() || finalizingSessionKeys.has(sessionKey)) {
    return {
      attempted: false,
      skippedDuplicate: false,
      usedKeepalive: false,
      compacted: false,
      byteLength: 0,
    };
  }

  // Deduplikasi panggilan beruntun identik (mis. `beforeunload` diikuti langsung `pagehide`):
  // mencegah pengiriman ganda yang menggandakan kuota 64 KiB bersama (shared keepalive budget) browser.
  const now = Date.now();
  const stateFingerprint = buildKeepaliveStateFingerprint(session);
  const prevFlush = lastKeepaliveFlushMap.get(sessionKey);
  if (
    prevFlush &&
    prevFlush.fingerprint === stateFingerprint &&
    now - prevFlush.ts < KEEPALIVE_DEDUP_WINDOW_MS
  ) {
    return {
      attempted: false,
      skippedDuplicate: true,
      usedKeepalive: false,
      compacted: false,
      byteLength: 0,
    };
  }

  try {
    const { url, anonKey } = getSupabaseConfig();
    if (!url || !anonKey) {
      return {
        attempted: false,
        skippedDuplicate: false,
        usedKeepalive: false,
        compacted: false,
        byteLength: 0,
      };
    }
    const cleanUrl = url.replace(/\/+$/, '');

    const { compacted: compactedAnswers, changed: answersCompacted } = compactAnswersForKeepalive(
      session.answers
    );
    let wasCompacted = answersCompacted;

    // Jangan kirim p_question_ids penuh pada keepalive (browser membatasi body keepalive <= 64 KiB).
    // RPC upsert_exam_progress mempertahankan question_ids yang sudah tersimpan di DB via COALESCE.
    const payload: Record<string, unknown> = {
      p_result_id: session.resultId,
      p_participant_id: session.participant.id,
      p_participant_number: normParticipantNum,
      p_student_name: session.participant.fullName,
      p_class_name: session.participant.className,
      p_exam_id: session.schedule.id,
      p_exam_title: session.schedule.title,
      p_subject: session.schedule.subject,
      p_answers: compactedAnswers,
      p_flagged_questions: session.flaggedQuestions,
      p_total_questions: session.questions.length,
      p_tab_switch_count: session.tabSwitchCount,
      p_started_at: session.startedAt,
      p_question_ids: null,
      p_token: session.participant.token?.trim().toUpperCase() || null,
    };

    let body = JSON.stringify(payload);
    let byteLen = measureUtf8ByteLength(body);

    // Tahap 1: Jika payload mendekati batas aman keepalive, ringkaskan field non-kritis agar jawaban tetap terkirim.
    if (byteLen > KEEPALIVE_SAFE_MAX_BYTES && session.flaggedQuestions.length > 0) {
      payload.p_flagged_questions = [];
      wasCompacted = true;
      body = JSON.stringify(payload);
      byteLen = measureUtf8ByteLength(body);
    }

    // Tahap 2: Jika baris sesi sudah ada di cloud, ON CONFLICT DO UPDATE tidak menimpa nama/judul/mapel,
    // sehingga metadata teks panjang aman dipangkas untuk memberi ruang ekstra bagi p_answers.
    if (byteLen > KEEPALIVE_SAFE_MAX_BYTES && confirmedCloudSessionKeys.has(sessionKey)) {
      payload.p_student_name = '';
      payload.p_exam_title = '';
      payload.p_subject = '';
      wasCompacted = true;
      body = JSON.stringify(payload);
      byteLen = measureUtf8ByteLength(body);
    }

    const canUseKeepalive = byteLen <= KEEPALIVE_HARD_MAX_BYTES;
    lastKeepaliveFlushMap.set(sessionKey, { fingerprint: stateFingerprint, ts: now });

    // Gunakan RPC upsert_exam_progress (POST + keepalive) agar aman RLS dan menangani baris yang belum dibuat
    void fetch(`${cleanUrl}/rest/v1/rpc/upsert_exam_progress`, {
      method: 'POST',
      keepalive: canUseKeepalive,
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body,
    }).catch(() => {
      // Silent fail on network/unload; local backup + pending IDB record will auto-sync next online cycle
    });

    return {
      attempted: true,
      skippedDuplicate: false,
      usedKeepalive: canUseKeepalive,
      compacted: wasCompacted,
      byteLength: byteLen,
    };
  } catch {
    // Ignore keepalive network issues on unload
    return {
      attempted: false,
      skippedDuplicate: false,
      usedKeepalive: false,
      compacted: false,
      byteLength: 0,
    };
  }
}

interface ProgressWriteQueueState {
  inFlight: boolean;
  pendingSession: ActiveExamSession | null;
  pendingIncludeQuestionIds: boolean;
  waiters: Array<(res: ExamResult) => void>;
}

const progressWriteQueues = new Map<string, ProgressWriteQueueState>();

async function executeUpsertExamProgressSingle(
  session: ActiveExamSession,
  options?: { includeQuestionIds?: boolean }
): Promise<ExamResult> {
  await ensureInitialized();
  const normParticipantNum = session.participant.participantNumber.trim().toUpperCase();
  const sessionKey = makeSessionSyncKey(normParticipantNum, session.schedule.id);

  // Guard: jangan pernah menimpa hasil lokal yang sedang atau sudah difinalisasi (submitted/flagged)
  const existingLocal = await idbGet<ExamResult>(STORES.RESULTS, session.resultId);
  if (isExamResultFinalized(existingLocal)) {
    clearActiveSessionLocal();
    return existingLocal!;
  }
  if (finalizingSessionKeys.has(sessionKey)) {
    return (
      existingLocal || {
        id: session.resultId,
        participantId: session.participant.id,
        participantNumber: normParticipantNum,
        studentName: session.participant.fullName,
        className: session.participant.className,
        examId: session.schedule.id,
        examTitle: session.schedule.title,
        subject: session.schedule.subject,
        answers: { ...session.answers },
        flaggedQuestions: [...session.flaggedQuestions],
        questionIds: session.questions.map((q) => q.id),
        correctCount: 0,
        totalQuestions: session.questions.length,
        score: 0,
        tabSwitchCount: session.tabSwitchCount,
        status: 'in_progress',
        startedAt: session.startedAt,
        submittedAt: null,
        syncStatus: 'pending',
      }
    );
  }

  const isLocked = session.tabSwitchCount >= session.schedule.maxTabSwitches;
  if (!isLocked) {
    saveActiveSessionLocal(session);
  }

  const questionIds = session.questions.map((q) => q.id);

  const progressRecord: ExamResult = {
    id: session.resultId,
    participantId: session.participant.id,
    participantNumber: normParticipantNum,
    studentName: session.participant.fullName,
    className: session.participant.className,
    examId: session.schedule.id,
    examTitle: session.schedule.title,
    subject: session.schedule.subject,
    answers: { ...session.answers },
    flaggedQuestions: [...session.flaggedQuestions],
    questionIds,
    answeredCount: countAnsweredEntries(session.answers),
    correctCount: 0,
    totalQuestions: session.questions.length,
    score: 0,
    tabSwitchCount: Math.max(existingLocal?.tabSwitchCount || 0, session.tabSwitchCount),
    status: isLocked ? 'flagged' : 'in_progress',
    startedAt: existingLocal?.startedAt || session.startedAt,
    submittedAt: null,
    syncStatus: 'pending',
  };

  await idbPut(STORES.RESULTS, progressRecord);

  if (!isLocked) {
    const pushRes = await pushResultToSupabase(progressRecord, {
      includeQuestionIds: options?.includeQuestionIds,
    });
    // Periksa ulang kondisi lokal setelah network selesai agar autosave in-flight yang terlambat
    // TIDAK pernah menimpa snapshot final `submitted` atau jawaban yang lebih baru.
    const latestLocalAfterPush = await idbGet<ExamResult>(STORES.RESULTS, session.resultId);
    if (finalizingSessionKeys.has(sessionKey) || isExamResultFinalized(latestLocalAfterPush)) {
      if (latestLocalAfterPush) {
        return latestLocalAfterPush;
      }
    }
    if (pushRes.finalizedFromServer) {
      confirmedCloudSessionKeys.add(sessionKey);
      const serverFinal = pushRes.finalizedFromServer;
      const mergedAnswers: Record<string, string> = {
        ...(serverFinal.answers || {}),
        ...(progressRecord.answers || {}),
      };
      // Jika server sudah memfinalisasi (mis. auto_expired) saat siswa sempat offline,
      // namun jawaban lokal lebih lengkap, coba rekonsiliasi aman satu kali ke server sebelum mengunci hasil.
      if (
        serverFinal.status === 'submitted' &&
        Object.keys(mergedAnswers).length > Object.keys(serverFinal.answers || {}).length
      ) {
        const reconciled = await finalizeExamResultRecord(
          {
            ...serverFinal,
            answers: mergedAnswers,
            tabSwitchCount: Math.max(
              serverFinal.tabSwitchCount || 0,
              progressRecord.tabSwitchCount || 0
            ),
            syncStatus: 'pending',
          },
          {
            maxTabSwitches: session.schedule.maxTabSwitches,
            skipIfFinalized: false,
            broadcast: true,
          }
        );
        clearActiveSessionLocal();
        return reconciled;
      }
      await idbPut(STORES.RESULTS, serverFinal);
      clearActiveSessionLocal();
      broadcastDataChange('results');
      return serverFinal;
    }
    if (pushRes.ok) {
      confirmedCloudSessionKeys.add(sessionKey);
      lastCloudProgressConfirmedAt.set(sessionKey, Date.now());
      // Adopsi started_at otoritatif dari server agar timer tidak bisa dimanipulasi jam perangkat
      if (pushRes.serverStartedAt) {
        const serverStartMs = Date.parse(pushRes.serverStartedAt);
        if (Number.isFinite(serverStartMs)) {
          progressRecord.startedAt = pushRes.serverStartedAt;
          if (
            cachedActiveSession &&
            cachedActiveSession.resultId === session.resultId &&
            !areTimestampsEqual(cachedActiveSession.startedAt, pushRes.serverStartedAt)
          ) {
            const durationMs =
              Math.max(1, cachedActiveSession.schedule.durationMinutes) * 60 * 1000;
            const syncedSession: ActiveExamSession = {
              ...cachedActiveSession,
              startedAt: pushRes.serverStartedAt,
              endsAt: new Date(serverStartMs + durationMs).toISOString(),
            };
            saveActiveSessionLocal(syncedSession);
          }
        }
      }
      const localUnchanged =
        !latestLocalAfterPush ||
        buildResultFingerprint(latestLocalAfterPush) === buildResultFingerprint(progressRecord);
      if (localUnchanged) {
        progressRecord.syncStatus = 'synced';
        await idbPut(STORES.RESULTS, progressRecord);
      } else if (latestLocalAfterPush) {
        if (pushRes.serverStartedAt && !areTimestampsEqual(latestLocalAfterPush.startedAt, pushRes.serverStartedAt)) {
          const updatedLatest: ExamResult = {
            ...latestLocalAfterPush,
            startedAt: pushRes.serverStartedAt,
          };
          await idbPut(STORES.RESULTS, updatedLatest);
          return updatedLatest;
        }
        return latestLocalAfterPush;
      }
    }
  }

  // Hindari broadcast 'results' (yang memicu pembacaan ulang penuh IDB & sort) pada autosave rutin in_progress
  // saat record sudah ada dan status tidak berubah menjadi locked/finalized.
  const isRoutineInProgressUpdate =
    !isLocked && Boolean(existingLocal) && existingLocal?.status === 'in_progress';
  if (!isRoutineInProgressUpdate) {
    broadcastDataChange('results');
  }
  return progressRecord;
}

/**
 * Serialized & coalesced progress writer per (participantNumber, examId).
 * Mencegah request jaringan yang datang tidak berurutan (out-of-order) menimpa jawaban siswa terbaru.
 */
export async function upsertExamProgress(
  session: ActiveExamSession,
  options?: { includeQuestionIds?: boolean }
): Promise<ExamResult> {
  const sessionKey = makeSessionSyncKey(
    session.participant.participantNumber,
    session.schedule.id
  );
  const snapshot: ActiveExamSession = {
    ...session,
    answers: { ...session.answers },
    flaggedQuestions: [...session.flaggedQuestions],
  };

  let queue = progressWriteQueues.get(sessionKey);
  if (!queue) {
    queue = {
      inFlight: false,
      pendingSession: null,
      pendingIncludeQuestionIds: false,
      waiters: [],
    };
    progressWriteQueues.set(sessionKey, queue);
  }

  if (queue.inFlight) {
    queue.pendingSession = snapshot;
    queue.pendingIncludeQuestionIds =
      queue.pendingIncludeQuestionIds || Boolean(options?.includeQuestionIds);
    return new Promise<ExamResult>((resolve) => {
      queue!.waiters.push(resolve);
    });
  }

  queue.inFlight = true;
  try {
    let currentSession: ActiveExamSession | null = snapshot;
    let currentIncludeQIds = Boolean(options?.includeQuestionIds);
    let lastResult!: ExamResult;

    while (currentSession) {
      const batchWaiters = queue.waiters.splice(0, queue.waiters.length);
      lastResult = await executeUpsertExamProgressSingle(currentSession, {
        includeQuestionIds: currentIncludeQIds,
      });

      if (queue.pendingSession) {
        currentSession = queue.pendingSession;
        currentIncludeQIds = queue.pendingIncludeQuestionIds;
        queue.pendingSession = null;
        queue.pendingIncludeQuestionIds = false;
        // Resolve waiters from the completed pass only when no newer pass replaces their result,
        // or keep them to resolve with latest authoritative result.
        queue.waiters.unshift(...batchWaiters);
      } else {
        for (const resolve of batchWaiters) {
          resolve(lastResult);
        }
        currentSession = null;
      }
    }

    return lastResult;
  } finally {
    queue.inFlight = false;
    if (!queue.pendingSession && queue.waiters.length === 0) {
      progressWriteQueues.delete(sessionKey);
    }
  }
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
    maxAttempts?: number;
    deadlineMs?: number;
    initialJitterMs?: number;
    onProgress?: (statusText: string) => void;
  }
): Promise<ExamResult> {
  if (
    options?.skipIfFinalized &&
    (rawResult.status === 'submitted' ||
      (rawResult.status === 'flagged' && rawResult.submittedAt !== null))
  ) {
    return rawResult;
  }

  const startedSubmitMs = Date.now();
  const deadlineMs = options?.deadlineMs ?? 45_000;
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

  const isBrowserOffline =
    typeof navigator !== 'undefined' && navigator.onLine === false;

  if (isLiveSupabaseConfigured() && !isBrowserOffline) {
    const supabase = getSupabaseClient();
    const participantToken = await resolveParticipantToken(normParticipantNum);
    const allBackoffs = [0, 2000, 5000, 9000, 14000];
    const maxAttempts = Math.max(1, Math.min(options?.maxAttempts ?? 5, allBackoffs.length));

    if (options?.initialJitterMs && options.initialJitterMs > 0) {
      options?.onProgress?.('Mengantre pengiriman jawaban ke server...');
      await new Promise((r) => setTimeout(r, options.initialJitterMs));
    }

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        break;
      }
      if (attempt > 0 && Date.now() - startedSubmitMs >= deadlineMs) {
        break;
      }
      if (allBackoffs[attempt] > 0) {
        const jitter = Math.floor(Math.random() * 2000);
        const remainingBudget = deadlineMs - (Date.now() - startedSubmitMs);
        if (remainingBudget <= 1500) break;
        const waitMs = Math.min(allBackoffs[attempt] + jitter, Math.max(200, remainingBudget - 1500));
        options?.onProgress?.(
          `Server sedang padat, mencoba ulang (${attempt + 1}/${maxAttempts})...`
        );
        await new Promise((r) => setTimeout(r, waitMs));
      } else {
        options?.onProgress?.(
          maxAttempts > 1
            ? `Mengirim & menilai jawaban di server (1/${maxAttempts})...`
            : 'Mengirim ulang jawaban ke server...'
        );
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
          p_token: participantToken,
        });

        // Graceful fallback ke signature 14 argumen lalu 12 argumen HANYA jika fungsi belum di-upgrade di SQL DB
        if (rpcResult.error && isRpcSignatureMismatchError(rpcResult.error.message)) {
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
            p_max_tab_switches: maxTabSwitches,
            p_question_ids: questionIds && questionIds.length > 0 ? questionIds : null,
          });
        }
        if (rpcResult.error && isRpcSignatureMismatchError(rpcResult.error.message)) {
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

        if (!rpcResult.error && Array.isArray(rpcResult.data) && rpcResult.data[0]) {
          const serverTotalQ = Number(rpcResult.data[0].total_questions);
          if (serverTotalQ > 0) {
            correctCount = rpcResult.data[0].correct_count;
            totalQuestions = serverTotalQ;
            score = Number(rpcResult.data[0].score);
            synced = true;
            break;
          }
          // Jika DB mengembalikan total_questions = 0, jangan ulangi karena bukan gangguan sementara
          break;
        }
        if (rpcResult.error && !isTransientServerOrNetworkError(rpcResult.error)) {
          break;
        }
      } catch {
        // Retry with bounded backoff until deadlineMs
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
      // Pada browser siswa/admin tanpa cache soal lengkap, tandai needsServerScoring agar segera dinilai
      // ulang oleh antrean background (tanpa memblokir UI dengan request tambahan saat submit gagal).
      if (hasEvidenceOfExam && isLiveSupabaseConfigured()) {
        needsServerScoring = true;
        const wasStillInProgress =
          rawResult.status === 'in_progress' && rawResult.submittedAt === null;
        if (options?.keepInProgressIfUnscored && wasStillInProgress) {
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
    submittedAt: rawResult.submittedAt || nowIso,
    syncStatus: synced ? 'synced' : 'pending',
    needsServerScoring: synced ? undefined : needsServerScoring || undefined,
  };
  if (synced) {
    confirmedCloudSessionKeys.add(makeSessionSyncKey(normParticipantNum, rawResult.examId));
  }

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

export async function submitFinalExam(
  session: ActiveExamSession,
  options?: {
    onProgress?: (statusText: string) => void;
    skipInitialJitter?: boolean;
  }
): Promise<ExamResult> {
  await ensureInitialized();

  const normParticipantNum = session.participant.participantNumber.trim().toUpperCase();
  const sessionKey = makeSessionSyncKey(normParticipantNum, session.schedule.id);

  // Deduplikasi submit paralel pada sesi yang sama agar tidak menembakkan RPC ganda
  const existingSubmit = finalizingSessionPromises.get(sessionKey);
  if (existingSubmit) {
    return existingSubmit;
  }

  // Batalkan antrean penulisan autosave in_progress yang masih tertunda agar tidak menimpa jawaban final
  const queuedProgress = progressWriteQueues.get(sessionKey);
  if (queuedProgress) {
    queuedProgress.pendingSession = null;
    queuedProgress.pendingIncludeQuestionIds = false;
  }

  finalizingSessionKeys.add(sessionKey);

  const submitPromise = (async () => {
    try {
      const questionIds = session.questions.map((q) => q.id);
      const nowIso = new Date(getServerNowMs()).toISOString();
      const existingLocal = await idbGet<ExamResult>(STORES.RESULTS, session.resultId);
      const effectiveTabSwitches = Math.max(
        existingLocal?.tabSwitchCount || 0,
        session.tabSwitchCount
      );
      const computedStatus: ExamResult['status'] =
        effectiveTabSwitches >= session.schedule.maxTabSwitches ? 'flagged' : 'submitted';

      const baseResult: ExamResult = {
        id: session.resultId,
        participantId: session.participant.id,
        participantNumber: normParticipantNum,
        studentName: session.participant.fullName,
        className: session.participant.className,
        examId: session.schedule.id,
        examTitle: session.schedule.title,
        subject: session.schedule.subject,
        answers: { ...session.answers },
        flaggedQuestions: [...session.flaggedQuestions],
        questionIds,
        correctCount: 0,
        totalQuestions: session.questions.length,
        score: 0,
        tabSwitchCount: effectiveTabSwitches,
        status: computedStatus,
        startedAt: existingLocal?.startedAt || session.startedAt,
        submittedAt: nowIso,
        syncStatus: 'pending',
        needsServerScoring: isLiveSupabaseConfigured() ? true : undefined,
      };

      // Simpan snapshot final ke IndexedDB TERLEBIH DAHULU sebelum menyentuh jaringan
      // agar jawaban akhir 100% aman meskipun browser ditutup/refresh di tengah pengiriman.
      options?.onProgress?.('Menyimpan jawaban lokal...');
      await idbPut(STORES.RESULTS, baseResult);

      // Sebarkan klik "Akhiri Ujian" manual (0.8 - 3.5 detik) agar gelombang ratusan siswa merata dan tidak menabrak DB sekaligus
      const initialJitterMs = options?.skipInitialJitter
        ? 0
        : 800 + Math.floor(Math.random() * 2700);

      const finalResult = await finalizeExamResultRecord(baseResult, {
        maxTabSwitches: session.schedule.maxTabSwitches,
        totalQuestionsFallback: session.questions.length,
        broadcast: true,
        maxAttempts: 5,
        deadlineMs: 45_000,
        initialJitterMs,
        onProgress: options?.onProgress,
      });

      clearActiveSessionLocal();
      return finalResult;
    } finally {
      finalizingSessionKeys.delete(sessionKey);
      finalizingSessionPromises.delete(sessionKey);
    }
  })();

  finalizingSessionPromises.set(sessionKey, submitPromise);
  return submitPromise;
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
  const serverEvaluatedIdSet = new Set<string>();
  const RPC_BATCH_SIZE = 50;

  if (isLiveSupabaseConfigured()) {
    const supabase = getSupabaseClient();
    const adminClient = getSupabaseAdminClient();
    const readClient = adminClient || supabase;
    const isReadAdminClient = Boolean(adminClient);
    const authArgs = await resolveStaffRpcAuthArgs();

    for (let i = 0; i < targets.length; i += RPC_BATCH_SIZE) {
      const batchTargets = targets.slice(i, i + RPC_BATCH_SIZE);
      const batchIds = batchTargets.map((t) => t.id);

      try {
        const { error: rpcErr } = await retryTransientSupabaseCall(
          async () =>
            await supabase.rpc('force_finish_exam_results', {
              p_result_ids: batchIds,
              p_limit: RPC_BATCH_SIZE,
              ...authArgs,
            }),
          { backoffsMs: [0, 300, 750, 1500, 2600], jitterMs: 400 }
        );

        if (!rpcErr) {
          const fetchedRes = await fetchAdminExamResultsByIds(
            readClient,
            batchIds,
            isReadAdminClient,
            false
          );

          if (!fetchedRes.error && Array.isArray(fetchedRes.data)) {
            const serverFinished: ExamResult[] = [];
            for (const id of batchIds) {
              serverEvaluatedIdSet.add(id);
            }
            for (const row of fetchedRes.data) {
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

  const remainingTargets = targets.filter(
    (t) => !finalizedIdSet.has(t.id) && !serverEvaluatedIdSet.has(t.id)
  );
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
            keepInProgressIfUnscored: true,
            broadcast: false,
          });
        })
      );
      for (const done of chunkDone) {
        if (done.status !== 'in_progress') {
          finalized.push(done);
        }
      }
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
        normalizeParticipantNumber(options?.currentParticipantNumber) ||
        normalizeParticipantNumber(savedSession?.participant.participantNumber);

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
        const normResPart = normalizeParticipantNumber(res.participantNumber);
        const resSessionKey = makeSessionSyncKey(normResPart, res.examId);
        // Lewati sesi yang sedang dalam proses submit final aktif oleh ExamRoom
        if (finalizingSessionKeys.has(resSessionKey)) continue;
        if (!options?.isAdmin && normResPart !== targetParticipant) {
          continue;
        }
        const sched = findScheduleForExam(schedules, res.examId, res.subject);
        if (!sched) continue;

        const startedMs = new Date(res.startedAt).getTime();
        if (!Number.isFinite(startedMs)) continue;

        const graceMs = options?.isAdmin ? ADMIN_EXPIRY_GRACE_MS : EXPIRY_GRACE_MS;
        const durationMs = Math.max(1, sched.durationMinutes) * 60 * 1000;
        if (nowMs >= startedMs + durationMs + graceMs) {
          // Pada perangkat siswa, gabungkan snapshot jawaban terbaru dari memori/active_session
          // agar finalisasi otomatis tidak pernah mengunci data jawaban lama (stale) dari IndexedDB results.
          let effectiveResult = res;
          if (
            !options?.isAdmin &&
            savedSession &&
            (savedSession.resultId === res.id ||
              (normalizeParticipantNumber(savedSession.participant.participantNumber) === normResPart &&
                savedSession.schedule.id === res.examId))
          ) {
            const savedAnsCount = Object.keys(savedSession.answers || {}).length;
            const resAnsCount = Object.keys(res.answers || {}).length;
            const freshestAnswers =
              savedAnsCount > 0 || resAnsCount === 0
                ? { ...(savedSession.answers || {}) }
                : { ...(res.answers || {}) };
            const sessionQIds =
              savedSession.questions.length > 0
                ? savedSession.questions.map((q) => q.id)
                : undefined;
            effectiveResult = {
              ...res,
              answers: freshestAnswers,
              flaggedQuestions: [...savedSession.flaggedQuestions],
              questionIds:
                res.questionIds && res.questionIds.length > 0 ? res.questionIds : sessionQIds,
              totalQuestions: Math.max(res.totalQuestions || 0, savedSession.questions.length || 0),
              tabSwitchCount: Math.max(res.tabSwitchCount || 0, savedSession.tabSwitchCount || 0),
            };
          }

          expiredItems.push({
            result: effectiveResult,
            maxTabSwitches: sched.maxTabSwitches,
            durationMinutes: Math.max(1, sched.durationMinutes),
          });
        }
      }

      if (expiredItems.length === 0) return 0;

      // Pada Portal Admin dengan Supabase Live, eksekusi penilaian batch bertahap (LIMIT 50) di server via RPC auto_finalize_expired_results
      if (options?.isAdmin && isLiveSupabaseConfigured()) {
        const supabase = getSupabaseClient();
        const authArgs = await resolveStaffRpcAuthArgs();
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
            let groupFailed = false;
            for (let round = 0; round < MAX_ROUNDS; round++) {
              const rpcRes = await retryTransientSupabaseCall(
                async () =>
                  await supabase.rpc('auto_finalize_expired_results', {
                    p_exam_id: examId,
                    p_cutoff: group.cutoffIso,
                    p_max_tab_switches: group.maxTabSwitches,
                    p_limit: RPC_LIMIT,
                    ...authArgs,
                  }),
                { backoffsMs: [0, 300, 750, 1500, 2600], jitterMs: 400 }
              );

              if (rpcRes.error) {
                groupFailed = true;
                break;
              }

              rpcAnySuccess = true;
              const batchCount = Number(rpcRes.data || 0);
              serverRpcFinalizedTotal += batchCount;
              if (batchCount < RPC_LIMIT) {
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
          const adminClient = getSupabaseAdminClient();
          const readClient = adminClient || supabase;
          const isReadAdminClient = Boolean(adminClient);
          let syncedViaDelta = false;
          if (lastAdminResultsCursor) {
            const deltaRes = await fetchAdminExamResultsSummaryPaginated(
              readClient,
              lastAdminResultsCursor,
              isReadAdminClient
            );
            if (!deltaRes.error && deltaRes.data.length > 0) {
              lastAdminResultsCursor = deltaRes.nextCursor;
              await mergeResultsStoreDelta(
                deltaRes.data.map((r) => mapDbExamResultRow(r))
              );
              syncedViaDelta = true;
            }
          }
          // Cold-start guard: bila kursor delta belum terinisialisasi (atau delta kosong akibat selisih jam),
          // tarik langsung baris yang baru difinalisasi berdasarkan ID agar Dashboard Admin langsung terbarui.
          if (!syncedViaDelta) {
            const expiredIds = Array.from(new Set(expiredItems.map((e) => e.result.id)));
            const FETCH_CHUNK = 100;
            const fetchedMapped: ExamResult[] = [];
            for (let i = 0; i < expiredIds.length; i += FETCH_CHUNK) {
              const chunkIds = expiredIds.slice(i, i + FETCH_CHUNK);
              try {
                const chunkRes = await fetchAdminExamResultsByIds(
                  readClient,
                  chunkIds,
                  isReadAdminClient,
                  false
                );
                if (!chunkRes.error && Array.isArray(chunkRes.data)) {
                  for (const row of chunkRes.data) {
                    fetchedMapped.push(mapDbExamResultRow(row));
                  }
                }
              } catch {
                // Keep merging other chunks
              }
            }
            if (fetchedMapped.length > 0) {
              await mergeResultsStoreDelta(fetchedMapped);
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
const TAB_INSTANCE_ID = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function shouldRetryServerScoring(item: ExamResult): boolean {
  return Boolean(
    item.needsServerScoring ||
      item.status === 'submitted' ||
      (item.status === 'flagged' && item.submittedAt !== null)
  );
}

/**
 * Mengoordinasikan antrean sync lintas-tab di browser yang sama (Web Locks API + fallback lease localStorage)
 * agar ketika banyak tab terbuka lalu koneksi offline -> online bersamaan, hanya 1 tab yang melakukan flush
 * tanpa request ganda atau race condition pada IndexedDB.
 */
async function runWithCrossTabLock<T>(
  lockName: string,
  storageKey: string,
  leaseMs: number,
  work: () => Promise<T>,
  skippedValue: T
): Promise<T> {
  const navLocks =
    typeof navigator !== 'undefined'
      ? (
          navigator as Navigator & {
            locks?: {
              request: <R>(
                name: string,
                options: { ifAvailable?: boolean },
                callback: (lock: unknown | null) => Promise<R>
              ) => Promise<R>;
            };
          }
        ).locks
      : undefined;

  if (navLocks && typeof navLocks.request === 'function') {
    try {
      return await navLocks.request(lockName, { ifAvailable: true }, async (lock) => {
        if (!lock) return skippedValue;
        return work();
      });
    } catch {
      // Fallback to localStorage lease below
    }
  }

  let acquiredLease = false;
  const now = Date.now();
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw) as { owner?: string; expiresAt?: number };
      if (parsed.owner && parsed.owner !== TAB_INSTANCE_ID && (parsed.expiresAt || 0) > now) {
        return skippedValue;
      }
    }
    localStorage.setItem(
      storageKey,
      JSON.stringify({ owner: TAB_INSTANCE_ID, expiresAt: now + leaseMs })
    );
    acquiredLease = true;
  } catch {
    // Proceed without cross-tab lock if localStorage is blocked
  }

  try {
    return await work();
  } finally {
    if (acquiredLease) {
      try {
        const raw = localStorage.getItem(storageKey);
        if (raw) {
          const parsed = JSON.parse(raw) as { owner?: string };
          if (parsed.owner === TAB_INSTANCE_ID) {
            localStorage.removeItem(storageKey);
          }
        }
      } catch {
        // Ignore storage release errors
      }
    }
  }
}

export async function flushPendingSyncQueue(): Promise<number> {
  if (!isLiveSupabaseConfigured()) return 0;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 0;
  if (flushPendingInFlight) return flushPendingInFlight;

  flushPendingInFlight = runWithCrossTabLock(
    'nusantara_cbt_flush_pending_queue',
    FLUSH_QUEUE_LOCK_KEY,
    30_000,
    async () => {
      const results = await idbGetAll<ExamResult>(STORES.RESULTS);
      const pending = results.filter((r) => r.syncStatus === 'pending');
      if (pending.length === 0) return 0;

      const activeSaved = getSavedActiveSession();
      let syncedCount = 0;
      let consecutiveFailures = 0;
      const MAX_CONSECUTIVE_FAILURES = 3;
      const CHUNK = 4;

      for (let i = 0; i < pending.length; i += CHUNK) {
        if (
          consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ||
          (typeof navigator !== 'undefined' && navigator.onLine === false)
        ) {
          break;
        }
        if (i > 0) {
          // Jeda ringan antar batch agar pemulihan koneksi massal tidak memicu lonjakan timeout/503
          await new Promise((r) => setTimeout(r, 150 + Math.floor(Math.random() * 200)));
        }
        const chunk = pending.slice(i, i + CHUNK);
        const chunkOutcomes = await Promise.all(
          chunk.map(async (rawItem): Promise<'synced' | 'skipped' | 'failed'> => {
            const normPartNum = rawItem.participantNumber.trim().toUpperCase();
            const itemSessionKey = makeSessionSyncKey(normPartNum, rawItem.examId);
            if (finalizingSessionKeys.has(itemSessionKey)) {
              return 'skipped';
            }

            // Jika item `in_progress` cocok dengan sesi aktif, gabungkan jawaban terbaru dari activeSession/backup
            // agar flush tidak pernah menimpa server dengan jawaban lama.
            let item = rawItem;
            if (
              !isExamResultFinalized(rawItem) &&
              activeSaved &&
              (activeSaved.resultId === rawItem.id ||
                (activeSaved.participant.participantNumber.trim().toUpperCase() === normPartNum &&
                  activeSaved.schedule.id === rawItem.examId))
            ) {
              const activeAnsCount = Object.keys(activeSaved.answers || {}).length;
              const rawAnsCount = Object.keys(rawItem.answers || {}).length;
              if (activeAnsCount >= rawAnsCount && activeAnsCount > 0) {
                item = {
                  ...rawItem,
                  answers: { ...activeSaved.answers },
                  flaggedQuestions: [...activeSaved.flaggedQuestions],
                  tabSwitchCount: Math.max(
                    rawItem.tabSwitchCount || 0,
                    activeSaved.tabSwitchCount || 0
                  ),
                };
              }
            }

            const itemFingerprintBefore = buildResultFingerprint(rawItem);

            if (shouldRetryServerScoring(item)) {
              const finalized = await finalizeExamResultRecord(item, {
                skipIfFinalized: false,
                keepInProgressIfUnscored:
                  item.status === 'in_progress' && item.submittedAt === null,
                broadcast: false,
                maxAttempts: 1,
                deadlineMs: 12_000,
              });
              if (finalized.syncStatus === 'synced') {
                syncedCount += 1;
                return 'synced';
              }
              return 'failed';
            }

            const pushRes = await pushResultToSupabase(item);
            if (finalizingSessionKeys.has(itemSessionKey)) {
              return 'skipped';
            }
            const latestLocal = await idbGet<ExamResult>(STORES.RESULTS, item.id);
            if (pushRes.finalizedFromServer) {
              await idbPut(STORES.RESULTS, pushRes.finalizedFromServer);
              syncedCount += 1;
              return 'synced';
            }
            if (pushRes.ok) {
              // Hanya tandai synced bila record lokal belum diperbarui dengan jawaban/status baru selama flush berjalan,
              // serta izinkan item yang memang sudah finalized (`submitted`/`flagged`) ditandai synced.
              const itemWasFinalized = isExamResultFinalized(item);
              const latestIsFinalized = isExamResultFinalized(latestLocal);
              const statusCompatible = itemWasFinalized || !latestIsFinalized;
              const stillMatches =
                !latestLocal ||
                (statusCompatible &&
                  (buildResultFingerprint(latestLocal) === itemFingerprintBefore ||
                    buildResultFingerprint(latestLocal) === buildResultFingerprint(item)));
              if (stillMatches) {
                item.syncStatus = 'synced';
                await idbPut(STORES.RESULTS, item);
                syncedCount += 1;
              }
              return 'synced';
            }
            return 'failed';
          })
        );

        for (const outcome of chunkOutcomes) {
          if (outcome === 'failed') {
            consecutiveFailures += 1;
          } else if (outcome === 'synced') {
            consecutiveFailures = 0;
          }
        }
      }

      const brokeEarlyDueToFailures =
        consecutiveFailures >= MAX_CONSECUTIVE_FAILURES &&
        (typeof navigator === 'undefined' || navigator.onLine !== false);

      if (syncedCount > 0) {
        broadcastDataChange('sync_flushed');
      }
      if (brokeEarlyDueToFailures && flushPendingRetryTimer === null && typeof window !== 'undefined') {
        const retryDelayMs = 18_000 + Math.floor(Math.random() * 14_000);
        flushPendingRetryTimer = window.setTimeout(() => {
          flushPendingRetryTimer = null;
          void flushPendingSyncQueue();
        }, retryDelayMs);
      }
      return syncedCount;
    },
    0
  ).finally(() => {
    flushPendingInFlight = null;
  });

  return flushPendingInFlight;
}

let flushPendingRetryTimer: number | null = null;

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
  lastAdminResultsCursor = null;
  lastAdminDeletedReconcileMs = 0;
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
            const meta = await fetchQuestionsCloudMeta(supabase, false);
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
              const authArgs = await resolveStaffRpcAuthArgs();
              const { data, error } = await supabase.rpc('staff_list_accounts', authArgs);
              if (error) {
                entry.note = 'Diproteksi RLS (login Admin atau isi Service Role Key)';
              } else if (Array.isArray(data)) {
                entry.cloudCount = data.length;
              }
            }
            return;
          }

          if (entry.table === 'participants' && !adminClient) {
            const authArgs = await resolveStaffRpcAuthArgs();
            const countRpc = await supabase.rpc('staff_count_participants', authArgs);
            if (!countRpc.error && typeof countRpc.data === 'number') {
              entry.cloudCount = countRpc.data;
              entry.note = 'Diproteksi RLS (terhitung via RPC staf)';
              return;
            }
            if (countRpc.error && !isRpcSignatureMismatchError(countRpc.error.message)) {
              entry.note = 'Diproteksi RLS (login Admin atau isi Service Role Key)';
              return;
            }
            const paginated = await fetchStaffParticipantsPaginated(supabase, authArgs);
            if (!paginated.error) {
              entry.cloudCount = paginated.data.length;
              entry.note = 'Diproteksi RLS (terhitung via RPC staf)';
              return;
            }
            if (!paginated.signatureMismatch) {
              entry.note = 'Diproteksi RLS (login Admin atau isi Service Role Key)';
              return;
            }
          }

          if (entry.table === 'exam_results' && !adminClient) {
            const authArgs = await resolveStaffRpcAuthArgs();
            const countRpc = await supabase.rpc('staff_count_exam_results', authArgs);
            if (!countRpc.error && typeof countRpc.data === 'number') {
              entry.cloudCount = countRpc.data;
              entry.note =
                pendingResultsCount > 0
                  ? `${pendingResultsCount} antrean pending · Diproteksi RLS (RPC staf)`
                  : 'Diproteksi RLS (terhitung via RPC staf)';
              return;
            }
            if (countRpc.error && !isRpcSignatureMismatchError(countRpc.error.message)) {
              entry.note = 'Diproteksi RLS (login Admin atau isi Service Role Key)';
              return;
            }
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
      const authArgs = await resolveStaffRpcAuthArgs();
      const rpcRes = await supabase.rpc('staff_list_accounts', authArgs);
      if (!rpcRes.error && Array.isArray(rpcRes.data)) {
        return { data: rpcRes.data as Record<string, unknown>[] };
      }
      return { data: [], error: rpcRes.error?.message };
    };

    const fetchParticipantsDetailed = async (): Promise<{
      data: Record<string, unknown>[];
      error?: string;
    }> => {
      if (adminClient) {
        return fetchAllRowsByIdPaginated(adminClient, 'participants');
      }
      const authArgs = await resolveStaffRpcAuthArgs();
      const rpcRes = await fetchStaffParticipantsPaginated(supabase, authArgs);
      if (!rpcRes.error) {
        return { data: rpcRes.data };
      }
      if (rpcRes.signatureMismatch) {
        return fetchAllRowsByIdPaginated(readClient, 'participants');
      }
      return { data: [], error: rpcRes.error };
    };

    const [profRes, schedRes, partRes, resRes, staffRes] = await Promise.all([
      fetchSchoolProfileRow(readClient, Boolean(adminClient)),
      fetchAllRowsByIdPaginated(readClient, 'exam_schedules'),
      fetchParticipantsDetailed(),
      fetchAdminExamResultsSummaryPaginated(readClient, null, Boolean(adminClient), 100_000),
      fetchStaffDetailed(),
    ]);

    const hasCloudProfile = Boolean(!profRes.error && profRes.data);

    if (profRes.error) {
      errors.push(`school_profile: ${profRes.error.message}`);
    } else if (profRes.data) {
      const existingProfile = await idbGet<SchoolProfile>(STORES.META, 'default');
      const profRow = profRes.data;
      const cloudAdminPwd =
        typeof profRow.admin_password === 'string' && profRow.admin_password.trim()
          ? profRow.admin_password.trim()
          : '';
      const verifiedActiveAdminPwd =
        activeStaffCredentials?.userId.toLowerCase() === 'admin'
          ? activeStaffCredentials.passwordHash
          : '';
      await idbPut(STORES.META, {
        id: 'default',
        schoolName: String(profRow.school_name || ''),
        address: String(profRow.address || ''),
        academicYear: String(profRow.academic_year || ''),
        principalName: String(profRow.principal_name || ''),
        committeeChairName: String(profRow.committee_chair_name || ''),
        examTitle: String(profRow.exam_title || ''),
        logoDataUrl: String(profRow.logo_data_url || '') || SEED_SCHOOL_PROFILE.logoDataUrl,
        kemenagLogoDataUrl: resolveCloudKemenagLogo(profRow, existingProfile),
        adminPassword: cloudAdminPwd || verifiedActiveAdminPwd || '__CLOUD_MANAGED__',
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
            participantNumber: normalizeParticipantNumber(String(r.participant_number || '')),
            token: String(r.token || 'CBT2026'),
            fullName: String(r.full_name || ''),
            className: String(r.class_name || ''),
            isActive: Boolean(r.is_active ?? true),
            createdAt: String(r.created_at || ''),
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
      lastAdminResultsCursor = resRes.nextCursor;
      const cloudResults = resRes.data.map((r) => mapDbExamResultRow(r));
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
        const activeUserLower = activeStaffCredentials?.userId.trim().toLowerCase() || '';
        const mappedStaff: StaffAccount[] = staffRes.data.map((s) => {
          const userId = String(s.user_id || '');
          const normUser = userId.trim().toLowerCase();
          const rawPwd = typeof s.password_hash === 'string' ? s.password_hash.trim() : '';
          const resolvedPwd =
            rawPwd ||
            (normUser && normUser === activeUserLower && activeStaffCredentials?.passwordHash
              ? activeStaffCredentials.passwordHash
              : '__CLOUD_MANAGED__');
          return {
            id: String(s.id),
            userId,
            name: String(s.name || ''),
            password: resolvedPwd,
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
  const staffAuthArgs = adminClient ? null : await resolveStaffRpcAuthArgs();
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
          kemenag_logo_data_url: profile.kemenagLogoDataUrl || '',
          updated_at: profile.updatedAt || timestamp,
        };
        if (hashedAdminPwd) {
          row.admin_password = hashedAdminPwd;
        }
        const { error } = await upsertSchoolProfileRowDirect(adminClient, row);
        if (error) errors.push(`school_profile: ${error.message}`);
        else details.school_profile = 1;
      } else {
        const { error: rpcErr } = await callStaffUpsertSchoolProfileRpc(supabase, {
          ...(staffAuthArgs || {}),
          p_school_name: profile.schoolName,
          p_address: profile.address,
          p_academic_year: profile.academicYear,
          p_principal_name: profile.principalName,
          p_committee_chair_name: profile.committeeChairName,
          p_exam_title: profile.examTitle,
          p_logo_data_url: profile.logoDataUrl,
          p_kemenag_logo_data_url: profile.kemenagLogoDataUrl ?? '',
          p_admin_password_hash: hashedAdminPwd,
          p_updated_at: profile.updatedAt || timestamp,
        });
        if (!rpcErr) {
          details.school_profile = 1;
        } else {
          errors.push(`school_profile: ${rpcErr.message}`);
        }
      }
    }

    if (schedules.length > 0) {
      const schedRows = schedules.map((s) => ({
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
      }));
      let schedErr: string | undefined;
      if (adminClient) {
        const { error } = await adminClient.from('exam_schedules').upsert(schedRows);
        schedErr = error?.message;
      } else {
        const { error: rpcErr } = await supabase.rpc('staff_upsert_exam_schedules_batch', {
          ...(staffAuthArgs || {}),
          p_schedules: schedRows,
        });
        if (rpcErr && isRpcSignatureMismatchError(rpcErr.message)) {
          const { error } = await supabase.from('exam_schedules').upsert(schedRows);
          schedErr = error?.message;
        } else {
          schedErr = rpcErr?.message;
        }
      }
      if (schedErr) errors.push(`exam_schedules: ${schedErr}`);
      else details.exam_schedules = schedules.length;
    }

    if (participants.length > 0) {
      const CHUNK = 50;
      let pushedParts = 0;
      for (let i = 0; i < participants.length; i += CHUNK) {
        const chunk = participants.slice(i, i + CHUNK);
        const partRows = chunk.map((p) => ({
          id: p.id,
          participant_number: normalizeParticipantNumber(p.participantNumber),
          token: p.token,
          full_name: p.fullName,
          class_name: p.className,
          is_active: p.isActive,
          created_at: p.createdAt,
        }));
        let partErr: string | undefined;
        if (adminClient) {
          const { error } = await adminClient
            .from('participants')
            .upsert(partRows, { onConflict: 'participant_number' });
          partErr = error?.message;
        } else {
          const { error: rpcErr } = await supabase.rpc('staff_upsert_participants_batch', {
            ...(staffAuthArgs || {}),
            p_participants: partRows,
          });
          if (rpcErr && isRpcSignatureMismatchError(rpcErr.message)) {
            const { error } = await supabase
              .from('participants')
              .upsert(partRows, { onConflict: 'participant_number' });
            partErr = error?.message;
          } else {
            partErr = rpcErr?.message;
          }
        }
        if (partErr) {
          errors.push(`participants (batch ${i / CHUNK + 1}): ${partErr}`);
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
        for (const s of staffAccounts) {
          const isPlaceholder = !s.password || s.password === '__CLOUD_MANAGED__';
          const pwdHash = isPlaceholder ? '' : await hashPassword(s.password);
          const { error: rpcErr } = await supabase.rpc('staff_upsert_account', {
            ...(staffAuthArgs || {}),
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
          } else {
            errors.push(`staff_accounts (${s.userId}): ${rpcErr.message}`);
          }
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
            ...(staffAuthArgs || {}),
          });
          if (rpcError && isMissingQuestionColumnsError(rpcError.message)) {
            const legacyPayload = chunk.map((q) => buildQuestionDbRow(q, false));
            const retry = await supabase.rpc('upsert_questions_batch', {
              p_questions: legacyPayload,
              ...(staffAuthArgs || {}),
            });
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
            participant_number: normalizeParticipantNumber(r.participantNumber),
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
            ...(staffAuthArgs || {}),
            p_results: chunk.map((r) => buildRow(r, true)),
          });
          writeErrMessage = rpcErr?.message;
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

  await idbPut(STORES.META, {
    ...snap.profile,
    id: 'default',
    kemenagLogoDataUrl:
      snap.profile.kemenagLogoDataUrl || SEED_SCHOOL_PROFILE.kemenagLogoDataUrl,
  });
  await idbPutParticipantsSafe(snap.participants, true);
  await idbPutMany(STORES.SCHEDULES, snap.schedules, true);
  await idbPutMany(STORES.QUESTIONS, snap.questions, true);
  await idbPutMany(STORES.RESULTS, snap.results, true);
  if (Array.isArray(snap.staffAccounts) && snap.staffAccounts.length > 0) {
    await idbPutStaffSafe(snap.staffAccounts, true);
  }
  clearActiveSessionLocal();
  confirmedQuestionIdsSyncSet.clear();
  confirmedCloudSessionKeys.clear();
  lastCloudProgressConfirmedAt.clear();
  lastLivePollCloudCheckAt.clear();
  lastAdminResultsCursor = null;
  lastAdminDeletedReconcileMs = 0;
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
