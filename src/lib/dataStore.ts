import {
  ALL_ADMIN_TABS,
  SEED_SCHOOL_PROFILE,
  SEED_STAFF_ACCOUNTS,
} from '@/src/lib/seedData';
import {
  getSupabaseAdminClient,
  getSupabaseClient,
  getSupabaseConfig,
  isLiveSupabaseConfigured,
} from '@/src/lib/supabase';
import type {
  ActiveExamSession,
  ExamResult,
  ExamSchedule,
  OptionKey,
  Participant,
  Question,
  SchoolProfile,
  StaffAccount,
  StudentQuestion,
} from '@/src/types/cbt';

const DB_NAME = 'nusantara_cbt_localfirst_v2';
const DB_VERSION = 2;

const STORES = {
  META: 'meta',
  PARTICIPANTS: 'participants',
  QUESTIONS: 'questions',
  SCHEDULES: 'schedules',
  RESULTS: 'exam_results',
  STAFF_ACCOUNTS: 'staff_accounts',
} as const;

const ACTIVE_SESSION_KEY = 'cbt_active_exam_session_v2';
const CHANNEL_NAME = 'nusantara_cbt_sync';

type SyncListener = () => void;

const listeners = new Set<SyncListener>();
let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return null;
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = () => {
      notifyLocalListeners();
    };
  }
  return channel;
}

function notifyLocalListeners(): void {
  listeners.forEach((cb) => cb());
}

export function broadcastDataChange(topic = 'update'): void {
  notifyLocalListeners();
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
    tx.oncomplete = () => resolve();
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
  if (!force && Date.now() - lastClockSyncMs < 30_000) {
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
    tx.oncomplete = () => resolve();
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
    tx.oncomplete = () => resolve();
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
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let initialized = false;
let initPromise: Promise<void> | null = null;

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

    initialized = true;

    if (isLiveSupabaseConfigured()) {
      void syncServerClock();
      void pullFromSupabaseSilent();
    }
  })();

  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

let syncInFlight: Promise<void> | null = null;
let lastSyncPullMs = 0;

export async function syncFromSupabase(options?: {
  force?: boolean;
  currentParticipantNumber?: string;
  isAdmin?: boolean;
}): Promise<void> {
  if (!isLiveSupabaseConfigured()) return;
  const now = Date.now();
  if (!options?.force && !syncInFlight && now - lastSyncPullMs < 1500) {
    return;
  }
  if (syncInFlight) {
    return syncInFlight;
  }
  syncInFlight = (async () => {
    try {
      await pullFromSupabaseSilent({
        currentParticipantNumber: options?.currentParticipantNumber,
        isAdmin: options?.isAdmin,
      });
      lastSyncPullMs = Date.now();
    } finally {
      syncInFlight = null;
    }
  })();
  return syncInFlight;
}

function isMissingTableError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('does not exist') ||
    lower.includes('could not find') ||
    lower.includes('relation') && lower.includes('not')
  );
}

async function pullFromSupabaseSilent(options?: {
  currentParticipantNumber?: string;
  isAdmin?: boolean;
}): Promise<void> {
  try {
    await syncServerClock();
    const supabase = getSupabaseClient();
    const adminClient = getSupabaseAdminClient();
    const [profRes, schedRes, partRes, resRes, staffRes] = await Promise.all([
      supabase.from('school_profile').select('*').eq('id', 'default').maybeSingle(),
      supabase.from('exam_schedules').select('*'),
      supabase.from('participants').select('*'),
      supabase.from('exam_results').select('*'),
      supabase.from('staff_accounts').select('*'),
    ]);

    const hasCloudProfile = Boolean(!profRes.error && profRes.data);

    if (hasCloudProfile && profRes.data) {
      await idbPut(STORES.META, {
        id: 'default',
        schoolName: profRes.data.school_name,
        address: profRes.data.address,
        academicYear: profRes.data.academic_year,
        principalName: profRes.data.principal_name,
        committeeChairName: profRes.data.committee_chair_name,
        examTitle: profRes.data.exam_title,
        logoDataUrl: profRes.data.logo_data_url || SEED_SCHOOL_PROFILE.logoDataUrl,
        adminPassword: profRes.data.admin_password || 'admin123',
        updatedAt: profRes.data.updated_at,
      } satisfies SchoolProfile);
    }

    if (!schedRes.error && Array.isArray(schedRes.data)) {
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
    }

    if (!partRes.error && Array.isArray(partRes.data)) {
      if (partRes.data.length > 0 || hasCloudProfile) {
        await idbPutParticipantsSafe(
          partRes.data.map((r) => ({
            id: String(r.id),
            participantNumber: r.participant_number,
            token: r.token || 'CBT2026',
            fullName: r.full_name,
            className: r.class_name,
            isActive: r.is_active,
            createdAt: r.created_at,
          })),
          true
        );
      }
    }

    if (!resRes.error && Array.isArray(resRes.data)) {
      const localResults = await idbGetAll<ExamResult>(STORES.RESULTS);
      const pendingLocals = localResults.filter((lr) => lr.syncStatus === 'pending');
      const pendingKeySet = new Set(
        pendingLocals.map((lr) => `${lr.participantNumber.trim().toUpperCase()}::${lr.examId}`)
      );

      const cloudResults: ExamResult[] = resRes.data
        .filter(
          (r) =>
            !pendingKeySet.has(
              `${String(r.participant_number || '').trim().toUpperCase()}::${r.exam_id}`
            )
        )
        .map((r) => ({
          id: r.id,
          participantId: r.participant_id,
          participantNumber: r.participant_number,
          studentName: r.student_name,
          className: r.class_name,
          examId: r.exam_id,
          examTitle: r.exam_title,
          subject: r.subject || '',
          answers: r.answers || {},
          flaggedQuestions: r.flagged_questions || [],
          questionIds: Array.isArray(r.question_ids) ? r.question_ids : undefined,
          correctCount: r.correct_count,
          totalQuestions: r.total_questions,
          score: Number(r.score),
          tabSwitchCount: r.tab_switch_count,
          status: r.status,
          startedAt: r.started_at,
          submittedAt: r.submitted_at,
          syncStatus: 'synced' as const,
        }));

      await idbPutMany(STORES.RESULTS, [...cloudResults, ...pendingLocals], true);

      if (pendingLocals.length > 0) {
        void flushPendingSyncQueue();
      }
    }

    if (!staffRes.error && Array.isArray(staffRes.data) && staffRes.data.length > 0) {
      const mappedStaff: StaffAccount[] = staffRes.data.map((s) => ({
        id: String(s.id),
        userId: String(s.user_id),
        name: String(s.name),
        password: String(s.password_hash || ''),
        roleType: s.role_type,
        roleLabel: String(s.role_label || 'Staff'),
        allowedTabs: Array.isArray(s.allowed_tabs) ? s.allowed_tabs : [],
        assignedSubjects: Array.isArray(s.assigned_subjects) ? s.assigned_subjects : [],
        restrictToAssignedSubjects: Boolean(s.restrict_to_assigned_subjects),
        isActive: Boolean(s.is_active),
        createdAt: s.created_at,
      }));
      const hasCloudAdmin = mappedStaff.some(
        (s) => s.userId.trim().toLowerCase() === 'admin'
      );
      if (!hasCloudAdmin) {
        const localStaff = await idbGetAll<StaffAccount>(STORES.STAFF_ACCOUNTS);
        const localAdmin = localStaff.find(
          (s) => s.userId.trim().toLowerCase() === 'admin'
        );
        if (localAdmin) {
          mappedStaff.unshift(localAdmin);
        }
      }
      await idbPutStaffSafe(mappedStaff, true);
    }

    if (options?.isAdmin && adminClient) {
      const qRes = await adminClient.from('questions').select('*');
      if (!qRes.error && Array.isArray(qRes.data) && (qRes.data.length > 0 || hasCloudProfile)) {
        await idbPutMany(
          STORES.QUESTIONS,
          qRes.data.map((q) => ({
            id: q.id,
            subject: q.subject,
            targetClasses: q.target_classes || [],
            questionText: q.question_text,
            questionImageUrl: q.question_image_url || undefined,
            options: q.options || [],
            correctAnswer: q.correct_answer,
            points: Number(q.points ?? 1),
            orderIndex: Number(q.order_index ?? 1),
          })),
          true
        );
      }
    }

    broadcastDataChange('supabase_pull');
    void autoFinalizeExpiredExams({
      currentParticipantNumber: options?.currentParticipantNumber,
      isAdmin: options?.isAdmin,
    });
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
  const updated: SchoolProfile = { ...profile, id: 'default', updatedAt: new Date().toISOString() };
  await idbPut(STORES.META, updated);

  // Keep primary 'admin' staff account password in sync (hashed in staff_accounts)
  const staffList = await idbGetAll<StaffAccount>(STORES.STAFF_ACCOUNTS);
  const existingAdmin = staffList.find((s) => s.userId.toLowerCase() === 'admin');
  const hashedAdminPwd = await hashPassword(updated.adminPassword);
  const baseAdmin = existingAdmin || {
    ...SEED_STAFF_ACCOUNTS[0],
    allowedTabs: ALL_ADMIN_TABS,
  };
  if (!existingAdmin || existingAdmin.password !== hashedAdminPwd) {
    const updatedAdmin: StaffAccount = { ...baseAdmin, password: hashedAdminPwd };
    await idbPutStaffSafe([updatedAdmin]);
    if (isLiveSupabaseConfigured()) {
      try {
        const supabase = getSupabaseClient();
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
      } catch {
        // Ignore if staff_accounts table not yet migrated
      }
    }
  }

  broadcastDataChange('profile');

  if (isLiveSupabaseConfigured()) {
    try {
      const supabase = getSupabaseClient();
      await supabase.from('school_profile').upsert({
        id: 'default',
        school_name: updated.schoolName,
        address: updated.address,
        academic_year: updated.academicYear,
        principal_name: updated.principalName,
        committee_chair_name: updated.committeeChairName,
        exam_title: updated.examTitle,
        logo_data_url: updated.logoDataUrl,
        admin_password: updated.adminPassword,
        updated_at: updated.updatedAt,
      });
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
  const hashedPassword = rawPassword ? await hashPassword(rawPassword) : '';
  const normalized: StaffAccount = {
    ...account,
    userId: account.userId.trim(),
    password: hashedPassword,
  };
  await idbPutStaffSafe([normalized]);

  if (normalized.userId.toLowerCase() === 'admin' && rawPassword && !isPasswordHashed(rawPassword)) {
    const profile = await idbGet<SchoolProfile>(STORES.META, 'default');
    if (profile && profile.adminPassword !== rawPassword) {
      const updatedProfile = {
        ...profile,
        adminPassword: rawPassword,
        updatedAt: new Date().toISOString(),
      };
      await idbPut(STORES.META, updatedProfile);
      if (isLiveSupabaseConfigured()) {
        try {
          const supabase = getSupabaseClient();
          await supabase
            .from('school_profile')
            .update({ admin_password: rawPassword, updated_at: updatedProfile.updatedAt })
            .eq('id', 'default');
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
      const supabase = getSupabaseClient();
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
      if (error) {
        syncError = error.message;
      } else {
        synced = true;
        // Pastikan akun 'admin' utama juga tersimpan di cloud jika sebelumnya tabel masih kosong
        if (normalized.userId.toLowerCase() !== 'admin') {
          const { data: cloudAdmin } = await supabase
            .from('staff_accounts')
            .select('id')
            .ilike('user_id', 'admin')
            .maybeSingle();
          if (!cloudAdmin) {
            const localStaff = await idbGetAll<StaffAccount>(STORES.STAFF_ACCOUNTS);
            const localAdmin = localStaff.find(
              (s) => s.userId.trim().toLowerCase() === 'admin'
            );
            if (localAdmin) {
              await supabase.from('staff_accounts').upsert(
                {
                  id: localAdmin.id,
                  user_id: localAdmin.userId,
                  name: localAdmin.name,
                  password_hash: await hashPassword(localAdmin.password),
                  role_type: localAdmin.roleType,
                  role_label: localAdmin.roleLabel,
                  allowed_tabs: localAdmin.allowedTabs,
                  assigned_subjects: localAdmin.assignedSubjects,
                  restrict_to_assigned_subjects: localAdmin.restrictToAssignedSubjects,
                  is_active: localAdmin.isActive,
                  created_at: localAdmin.createdAt,
                },
                { onConflict: 'user_id' }
              );
            }
          }
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
      const supabase = getSupabaseClient();
      const { error: idErr } = await supabase.from('staff_accounts').delete().eq('id', id);
      if (idErr) {
        syncError = idErr.message;
      } else {
        if (existing?.userId) {
          await supabase.from('staff_accounts').delete().ilike('user_id', existing.userId);
        }
        synced = true;
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
      const { data: remoteStaff, error: staffErr } = await supabase
        .from('staff_accounts')
        .select('*')
        .ilike('user_id', normId)
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
      } else if (normId === 'admin') {
        const { data: prof } = await supabase
          .from('school_profile')
          .select('admin_password')
          .eq('id', 'default')
          .maybeSingle();
        if (prof?.admin_password) {
          const localList = await idbGetAll<StaffAccount>(STORES.STAFF_ACCOUNTS);
          const localAdmin = localList.find((acc) => acc.userId.trim().toLowerCase() === 'admin');
          if (localAdmin) {
            await idbPutStaffSafe([
              { ...localAdmin, password: await hashPassword(prof.admin_password) },
            ]);
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

  return { ok: true, staff: matched };
}

// ============================================================================
// PARTICIPANTS & TOKENS
// ============================================================================
export async function getParticipants(): Promise<Participant[]> {
  await ensureInitialized();
  const list = await idbGetAll<Participant>(STORES.PARTICIPANTS);
  return list.sort(
    (a, b) =>
      a.className.localeCompare(b.className) ||
      a.participantNumber.localeCompare(b.participantNumber)
  );
}

export async function upsertParticipants(items: Participant[]): Promise<void> {
  await ensureInitialized();
  await idbPutParticipantsSafe(items);
  broadcastDataChange('participants');

  if (isLiveSupabaseConfigured()) {
    try {
      const supabase = getSupabaseClient();
      const CHUNK = 200;
      for (let i = 0; i < items.length; i += CHUNK) {
        const chunk = items.slice(i, i + CHUNK);
        await supabase.from('participants').upsert(
          chunk.map((p) => ({
            id: p.id,
            participant_number: p.participantNumber.trim(),
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

  broadcastDataChange('participants');

  if (isLiveSupabaseConfigured()) {
    try {
      const supabase = getSupabaseClient();
      await supabase.from('participants').delete().not('id', 'is', null);
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
      const { data, error } = await supabase
        .from('participants')
        .select('*')
        .ilike('participant_number', normalizedNum)
        .eq('is_active', true)
        .maybeSingle();

      if (!error && data) {
        found = {
          id: data.id,
          participantNumber: data.participant_number,
          token: data.token || '',
          fullName: data.full_name,
          className: data.class_name,
          isActive: data.is_active,
          createdAt: data.created_at,
        };
        source = 'supabase';
        await idbPutParticipantsSafe([found]);
      }
    } catch {
      // Fallback to local cache
    }
  }

  if (!found) {
    const all = await idbGetAll<Participant>(STORES.PARTICIPANTS);
    found =
      all.find((p) => p.participantNumber.toUpperCase() === normalizedNum && p.isActive) ||
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
  const list = await idbGetAll<ExamSchedule>(STORES.SCHEDULES);
  return list.sort((a, b) => a.subject.localeCompare(b.subject));
}

export async function upsertExamSchedule(schedule: ExamSchedule): Promise<void> {
  await ensureInitialized();
  await idbPut(STORES.SCHEDULES, schedule);
  broadcastDataChange('schedules');

  if (isLiveSupabaseConfigured()) {
    try {
      const supabase = getSupabaseClient();
      await supabase.from('exam_schedules').upsert({
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
    } catch {
      // Cached locally
    }
  }
}

export async function deleteExamSchedule(id: string): Promise<void> {
  await ensureInitialized();
  await idbDelete(STORES.SCHEDULES, id);
  broadcastDataChange('schedules');

  if (isLiveSupabaseConfigured()) {
    try {
      const supabase = getSupabaseClient();
      await supabase.from('exam_schedules').delete().eq('id', id);
    } catch {
      // Ignore
    }
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

  broadcastDataChange('schedules');

  if (isLiveSupabaseConfigured()) {
    try {
      const supabase = getSupabaseClient();
      if (!hasRestriction) {
        await supabase.from('exam_schedules').delete().not('id', 'is', null);
      } else {
        await supabase.from('exam_schedules').delete().in('id', targetIds);
      }
    } catch {
      // Local delete persists regardless
    }
  }

  return targetIds.length;
}

export async function getAdminQuestions(): Promise<Question[]> {
  await ensureInitialized();
  const list = await idbGetAll<Question>(STORES.QUESTIONS);
  return list.sort(
    (a, b) =>
      a.subject.localeCompare(b.subject) ||
      a.orderIndex - b.orderIndex ||
      a.id.localeCompare(b.id)
  );
}

export async function upsertQuestions(items: Question[]): Promise<void> {
  await ensureInitialized();
  await idbPutMany(STORES.QUESTIONS, items);
  broadcastDataChange('questions');

  if (isLiveSupabaseConfigured()) {
    try {
      const supabase = getSupabaseClient();
      const payload = items.map((q) => ({
        id: q.id,
        subject: q.subject,
        target_classes: q.targetClasses,
        question_text: q.questionText,
        question_image_url: q.questionImageUrl || '',
        options: q.options,
        correct_answer: q.correctAnswer,
        points: q.points,
        order_index: q.orderIndex,
      }));
      const { error: rpcError } = await supabase.rpc('upsert_questions_batch', {
        p_questions: payload,
      });
      if (rpcError) {
        await supabase.from('questions').upsert(payload);
      }
    } catch {
      // Cached locally
    }
  }
}

export async function deleteQuestion(id: string): Promise<void> {
  await ensureInitialized();
  await idbDelete(STORES.QUESTIONS, id);
  broadcastDataChange('questions');

  if (isLiveSupabaseConfigured()) {
    try {
      const supabase = getSupabaseClient();
      const { error: rpcError } = await supabase.rpc('delete_question_by_id', {
        p_id: id,
      });
      if (rpcError) {
        await supabase.from('questions').delete().eq('id', id);
      }
    } catch {
      // Ignore
    }
  }
}

export async function deleteQuestionsBatch(ids: string[]): Promise<number> {
  await ensureInitialized();
  if (ids.length === 0) return 0;

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

  broadcastDataChange('questions');

  if (isLiveSupabaseConfigured()) {
    try {
      const adminClient = getSupabaseAdminClient();
      const supabase = getSupabaseClient();
      if (adminClient) {
        const CHUNK = 150;
        for (let i = 0; i < uniqueIds.length; i += CHUNK) {
          await adminClient.from('questions').delete().in('id', uniqueIds.slice(i, i + CHUNK));
        }
      } else {
        const CHUNK = 20;
        for (let i = 0; i < uniqueIds.length; i += CHUNK) {
          await Promise.all(
            uniqueIds.slice(i, i + CHUNK).map((id) =>
              supabase.rpc('delete_question_by_id', { p_id: id })
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
            allIds.slice(i, i + CHUNK).map((id) =>
              supabase.rpc('delete_question_by_id', { p_id: id })
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
  subject?: string
): Promise<StudentQuestion[]> {
  await ensureInitialized();

  if (isLiveSupabaseConfigured()) {
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase.rpc('get_student_questions', {
        p_class_name: className,
        p_subject: subject || null,
      });
      if (!error && Array.isArray(data) && data.length > 0) {
        return data.map((q) => ({
          id: q.id,
          subject: q.subject,
          targetClasses: q.target_classes,
          questionText: q.question_text,
          questionImageUrl: q.question_image_url || undefined,
          options: q.options,
          points: q.points,
          orderIndex: q.order_index,
        }));
      }
    } catch {
      // Fallback to local-first sanitized projection
    }
  }

  const all = await idbGetAll<Question>(STORES.QUESTIONS);
  return all
    .filter(
      (q) =>
        q.targetClasses.includes(className) &&
        (!subject || q.subject.toLowerCase() === subject.toLowerCase())
    )
    .sort((a, b) => a.orderIndex - b.orderIndex || a.id.localeCompare(b.id))
    .map(({ correctAnswer: _stripped, ...safeQuestion }) => safeQuestion);
}

// ============================================================================
// ACTIVE EXAM SESSION & BACKGROUND SYNC TO SUPABASE `exam_results`
// ============================================================================
export function getSavedActiveSession(): ActiveExamSession | null {
  try {
    const raw = localStorage.getItem(ACTIVE_SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ActiveExamSession;
  } catch {
    return null;
  }
}

export function saveActiveSessionLocal(session: ActiveExamSession): void {
  localStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(session));
}

export function clearActiveSessionLocal(): void {
  localStorage.removeItem(ACTIVE_SESSION_KEY);
}

export async function getExamResults(): Promise<ExamResult[]> {
  await ensureInitialized();
  const list = await idbGetAll<ExamResult>(STORES.RESULTS);
  return list.sort((a, b) =>
    (b.submittedAt || b.startedAt).localeCompare(a.submittedAt || a.startedAt)
  );
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
      const { data, error } = await supabase
        .from('exam_results')
        .select('*')
        .ilike('participant_number', normNum)
        .eq('exam_id', schedule.id);

      if (error) {
        return {
          locked: true,
          reason: 'network_error',
          result: null,
          errorMessage: `Gagal memverifikasi status ujian ke server: ${error.message}. Periksa koneksi lalu coba lagi.`,
        };
      }

      checkedRemote = true;
      if (Array.isArray(data) && data.length > 0) {
        const remoteMatch = data[0];
        matched = {
          id: remoteMatch.id,
          participantId: remoteMatch.participant_id,
          participantNumber: remoteMatch.participant_number,
          studentName: remoteMatch.student_name,
          className: remoteMatch.class_name,
          examId: remoteMatch.exam_id,
          examTitle: remoteMatch.exam_title,
          subject: remoteMatch.subject || '',
          answers: remoteMatch.answers || {},
          flaggedQuestions: remoteMatch.flagged_questions || [],
          questionIds: Array.isArray(remoteMatch.question_ids)
            ? remoteMatch.question_ids
            : undefined,
          correctCount: remoteMatch.correct_count,
          totalQuestions: remoteMatch.total_questions,
          score: Number(remoteMatch.score),
          tabSwitchCount: remoteMatch.tab_switch_count,
          status: remoteMatch.status,
          startedAt: remoteMatch.started_at,
          submittedAt: remoteMatch.submitted_at,
          syncStatus: 'synced',
        };
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
        supabase
          .from('participants')
          .select('*')
          .ilike('participant_number', normNum)
          .maybeSingle(),
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
        participantNumber: pRes.data.participant_number,
        token: pRes.data.token || 'CBT2026',
        fullName: pRes.data.full_name,
        className: pRes.data.class_name,
        isActive: Boolean(pRes.data.is_active),
        createdAt: pRes.data.created_at,
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
    const { data, error } = await supabase
      .from('exam_results')
      .select('*')
      .ilike('participant_number', participantNumber.trim().toUpperCase())
      .eq('exam_id', examId)
      .maybeSingle();

    if (error) return { status: 'offline' };
    if (!data) {
      return { status: 'reset_deleted' };
    }
    const mapped: ExamResult = {
      id: data.id,
      participantId: data.participant_id,
      participantNumber: data.participant_number,
      studentName: data.student_name,
      className: data.class_name,
      examId: data.exam_id,
      examTitle: data.exam_title,
      subject: data.subject || '',
      answers: data.answers || {},
      flaggedQuestions: data.flagged_questions || [],
      questionIds: Array.isArray(data.question_ids) ? data.question_ids : undefined,
      correctCount: data.correct_count,
      totalQuestions: data.total_questions,
      score: Number(data.score),
      tabSwitchCount: data.tab_switch_count,
      status: data.status,
      startedAt: data.started_at,
      submittedAt: data.submitted_at,
      syncStatus: 'synced',
    };
    if (mapped.status === 'submitted' || mapped.status === 'flagged') {
      await idbPut(STORES.RESULTS, mapped);
      return { status: 'finalized', result: mapped };
    }
    return { status: 'ok', result: mapped };
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
  await idbDelete(STORES.RESULTS, resultId);
  await unhideDashboardLogsByIds([resultId]);

  const savedSession = getSavedActiveSession();
  if (
    savedSession &&
    (savedSession.resultId === resultId ||
      (existing &&
        savedSession.participant.participantNumber.toUpperCase() ===
          existing.participantNumber.toUpperCase() &&
        savedSession.schedule.id === existing.examId))
  ) {
    clearActiveSessionLocal();
  }

  if (isLiveSupabaseConfigured()) {
    try {
      const supabase = getSupabaseClient();
      await supabase.from('exam_results').delete().eq('id', resultId);
      if (existing) {
        await supabase
          .from('exam_results')
          .delete()
          .eq('participant_number', existing.participantNumber)
          .eq('exam_id', existing.examId);
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
          savedSession.participant.participantNumber.toUpperCase() ===
            existing.participantNumber.toUpperCase() &&
          savedSession.schedule.id === existing.examId
      ))
  ) {
    clearActiveSessionLocal();
  }

  await unhideDashboardLogsByIds(uniqueIds);

  if (isLiveSupabaseConfigured()) {
    try {
      const supabase = getSupabaseClient();
      const CHUNK = 150;
      for (let i = 0; i < uniqueIds.length; i += CHUNK) {
        const chunk = uniqueIds.slice(i, i + CHUNK);
        await supabase.from('exam_results').delete().in('id', chunk);
      }
    } catch {
      // Local delete persists regardless
    }
  }

  broadcastDataChange('results');
  return matched.length || uniqueIds.length;
}

export async function clearAllExamResults(): Promise<number> {
  await ensureInitialized();
  const allResults = await idbGetAll<ExamResult>(STORES.RESULTS);
  const count = allResults.length;

  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORES.RESULTS, 'readwrite');
    tx.objectStore(STORES.RESULTS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  await idbDelete(STORES.META, DASHBOARD_HIDDEN_LOGS_META_ID);
  clearActiveSessionLocal();

  if (isLiveSupabaseConfigured()) {
    try {
      const supabase = getSupabaseClient();
      await supabase.from('exam_results').delete().not('id', 'is', null);
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
  result: ExamResult
): Promise<{ ok: boolean; finalizedFromServer?: ExamResult }> {
  if (!isLiveSupabaseConfigured()) {
    return { ok: false };
  }
  try {
    const supabase = getSupabaseClient();

    if (result.status === 'in_progress' && result.submittedAt === null) {
      const { data: rpcData, error: rpcError } = await supabase.rpc('upsert_exam_progress', {
        p_result_id: result.id,
        p_participant_id: result.participantId,
        p_participant_number: result.participantNumber,
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
        p_question_ids: result.questionIds || null,
      });

      if (!rpcError && Array.isArray(rpcData) && rpcData[0]) {
        if (rpcData[0].applied === true) {
          return { ok: true };
        }
        const { data: serverRow } = await supabase
          .from('exam_results')
          .select('*')
          .ilike('participant_number', result.participantNumber)
          .eq('exam_id', result.examId)
          .maybeSingle();

        if (serverRow) {
          const mapped: ExamResult = {
            id: serverRow.id,
            participantId: serverRow.participant_id,
            participantNumber: serverRow.participant_number,
            studentName: serverRow.student_name,
            className: serverRow.class_name,
            examId: serverRow.exam_id,
            examTitle: serverRow.exam_title,
            subject: serverRow.subject || '',
            answers: serverRow.answers || {},
            flaggedQuestions: serverRow.flagged_questions || [],
            questionIds: Array.isArray(serverRow.question_ids)
              ? serverRow.question_ids
              : undefined,
            correctCount: serverRow.correct_count,
            totalQuestions: serverRow.total_questions,
            score: Number(serverRow.score),
            tabSwitchCount: serverRow.tab_switch_count,
            status: serverRow.status,
            startedAt: serverRow.started_at,
            submittedAt: serverRow.submitted_at,
            syncStatus: 'synced',
          };
          return { ok: false, finalizedFromServer: mapped };
        }
        return { ok: false };
      }

      // Fallback when upsert_exam_progress RPC hasn't been deployed on Supabase yet
      const { data: existingRow, error: checkErr } = await supabase
        .from('exam_results')
        .select('*')
        .ilike('participant_number', result.participantNumber)
        .eq('exam_id', result.examId)
        .maybeSingle();

      if (checkErr) return { ok: false };

      if (existingRow) {
        if (existingRow.status !== 'in_progress' || existingRow.submitted_at !== null) {
          const mapped: ExamResult = {
            id: existingRow.id,
            participantId: existingRow.participant_id,
            participantNumber: existingRow.participant_number,
            studentName: existingRow.student_name,
            className: existingRow.class_name,
            examId: existingRow.exam_id,
            examTitle: existingRow.exam_title,
            subject: existingRow.subject || '',
            answers: existingRow.answers || {},
            flaggedQuestions: existingRow.flagged_questions || [],
            questionIds: Array.isArray(existingRow.question_ids)
              ? existingRow.question_ids
              : undefined,
            correctCount: existingRow.correct_count,
            totalQuestions: existingRow.total_questions,
            score: Number(existingRow.score),
            tabSwitchCount: existingRow.tab_switch_count,
            status: existingRow.status,
            startedAt: existingRow.started_at,
            submittedAt: existingRow.submitted_at,
            syncStatus: 'synced',
          };
          return { ok: false, finalizedFromServer: mapped };
        }

        const { error: updErr } = await supabase
          .from('exam_results')
          .update({
            answers: result.answers,
            flagged_questions: result.flaggedQuestions,
            total_questions: result.totalQuestions,
            tab_switch_count: Math.max(existingRow.tab_switch_count || 0, result.tabSwitchCount),
            updated_at: new Date().toISOString(),
          })
          .eq('id', existingRow.id)
          .eq('status', 'in_progress')
          .is('submitted_at', null);

        return { ok: !updErr };
      }

      const { error: insErr } = await supabase.from('exam_results').insert({
        id: result.id,
        participant_id: result.participantId,
        participant_number: result.participantNumber,
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
      });
      return { ok: !insErr };
    }

    const basePayload: Record<string, unknown> = {
      id: result.id,
      participant_id: result.participantId,
      participant_number: result.participantNumber,
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
    if (result.questionIds && result.questionIds.length > 0) {
      basePayload.question_ids = result.questionIds;
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

    return { ok: !error };
  } catch {
    return { ok: false };
  }
}

const EXPIRY_GRACE_MS = 5000;

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

    // Conditional PATCH hanya jika row masih in_progress & submitted_at IS NULL
    // agar tidak pernah menimpa status submitted/flagged dari perangkat lain atau Proktor!
    const query = `participant_number=eq.${encodeURIComponent(
      session.participant.participantNumber
    )}&exam_id=eq.${encodeURIComponent(session.schedule.id)}&status=eq.in_progress&submitted_at=is.null`;

    void fetch(`${cleanUrl}/rest/v1/exam_results?${query}`, {
      method: 'PATCH',
      keepalive: true,
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        answers: session.answers,
        flagged_questions: session.flaggedQuestions,
        total_questions: session.questions.length,
        tab_switch_count: session.tabSwitchCount,
        updated_at: new Date().toISOString(),
      }),
    });
  } catch {
    // Ignore keepalive network issues on unload
  }
}

export async function upsertExamProgress(session: ActiveExamSession): Promise<ExamResult> {
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

  const progressRecord: ExamResult = {
    id: session.resultId,
    participantId: session.participant.id,
    participantNumber: session.participant.participantNumber,
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
  broadcastDataChange('results');

  if (!isLocked) {
    const pushRes = await pushResultToSupabase(progressRecord);
    if (pushRes.finalizedFromServer) {
      await idbPut(STORES.RESULTS, pushRes.finalizedFromServer);
      clearActiveSessionLocal();
      broadcastDataChange('results');
      return pushRes.finalizedFromServer;
    }
    if (pushRes.ok) {
      progressRecord.syncStatus = 'synced';
      await idbPut(STORES.RESULTS, progressRecord);
      broadcastDataChange('results');
    }
  }

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
  const answers = rawResult.answers || {};
  const flaggedQuestions = rawResult.flaggedQuestions || [];
  const questionIds = rawResult.questionIds;

  let maxTabSwitches = options?.maxTabSwitches;
  if (maxTabSwitches === undefined) {
    const schedules = await idbGetAll<ExamSchedule>(STORES.SCHEDULES);
    const matchingSchedule = schedules.find(
      (s) =>
        s.id === rawResult.examId ||
        (rawResult.subject &&
          s.subject.trim().toLowerCase() === rawResult.subject.trim().toLowerCase())
    );
    maxTabSwitches = matchingSchedule?.maxTabSwitches ?? 3;
  }

  const computedStatus: ExamResult['status'] =
    rawResult.tabSwitchCount >= maxTabSwitches ? 'flagged' : 'submitted';

  let correctCount = 0;
  let totalQuestions = options?.totalQuestionsFallback ?? rawResult.totalQuestions;
  let score = 0;
  let synced = false;

  if (isLiveSupabaseConfigured()) {
    try {
      const supabase = getSupabaseClient();
      let rpcResult = await supabase.rpc('submit_exam_and_score', {
        p_result_id: rawResult.id,
        p_participant_id: rawResult.participantId,
        p_participant_number: rawResult.participantNumber,
        p_student_name: rawResult.studentName,
        p_class_name: rawResult.className,
        p_exam_id: rawResult.examId,
        p_exam_title: rawResult.examTitle,
        p_subject: rawResult.subject,
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
          p_participant_number: rawResult.participantNumber,
          p_student_name: rawResult.studentName,
          p_class_name: rawResult.className,
          p_exam_id: rawResult.examId,
          p_exam_title: rawResult.examTitle,
          p_subject: rawResult.subject,
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
      }
    } catch {
      // Fallback to local vault scoring + background upsert queue
    }
  }

  if (!synced) {
    const vaultQuestions = await idbGetAll<Question>(STORES.QUESTIONS);
    const idFilterSet =
      questionIds && questionIds.length > 0 ? new Set(questionIds) : null;

    const classSubjectQuestions = vaultQuestions.filter(
      (q) =>
        q.targetClasses.includes(rawResult.className) &&
        q.subject.trim().toLowerCase() === (rawResult.subject || '').trim().toLowerCase() &&
        (!idFilterSet || idFilterSet.has(q.id))
    );
    if (classSubjectQuestions.length > 0) {
      let totalPoints = 0;
      let earnedPoints = 0;
      for (const q of classSubjectQuestions) {
        totalPoints += q.points || 1;
        const ans: OptionKey | undefined = answers[q.id];
        if (ans && ans === q.correctAnswer) {
          correctCount += 1;
          earnedPoints += q.points || 1;
        }
      }
      totalQuestions = classSubjectQuestions.length;
      score = totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 10000) / 100 : 0;
    } else {
      totalQuestions = options?.totalQuestionsFallback ?? rawResult.totalQuestions;
    }
  }

  const finalResult: ExamResult = {
    ...rawResult,
    answers,
    flaggedQuestions,
    questionIds,
    correctCount,
    totalQuestions,
    score,
    status: computedStatus,
    submittedAt: nowIso,
    syncStatus: synced ? 'synced' : 'pending',
  };

  if (!synced) {
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
    participantNumber: session.participant.participantNumber,
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
    idbGetAll<ExamSchedule>(STORES.SCHEDULES),
  ]);

  const targets = allResults.filter((r) => idSet.has(r.id) && r.status === 'in_progress');
  if (targets.length === 0) return { finishedCount: 0, results: [] };

  const finalized: ExamResult[] = [];
  const CHUNK = 10;
  for (let i = 0; i < targets.length; i += CHUNK) {
    const chunk = targets.slice(i, i + CHUNK);
    const chunkDone = await Promise.all(
      chunk.map((item) => {
        const sched = schedules.find(
          (s) =>
            s.id === item.examId ||
            (item.subject && s.subject.trim().toLowerCase() === item.subject.trim().toLowerCase())
        );
        return finalizeExamResultRecord(item, {
          maxTabSwitches: sched?.maxTabSwitches ?? 3,
          skipIfFinalized: true,
          broadcast: false,
        });
      })
    );
    finalized.push(...chunkDone);
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
        idbGetAll<ExamSchedule>(STORES.SCHEDULES),
      ]);

      const nowMs = getServerNowMs();
      const expiredItems: Array<{ result: ExamResult; maxTabSwitches: number }> = [];

      for (const res of allResults) {
        if (res.status !== 'in_progress') continue;
        if (!options?.isAdmin && res.participantNumber.trim().toUpperCase() !== targetParticipant) {
          continue;
        }
        const sched = schedules.find(
          (s) =>
            s.id === res.examId ||
            (res.subject && s.subject.trim().toLowerCase() === res.subject.trim().toLowerCase())
        );
        if (!sched) continue;

        const startedMs = new Date(res.startedAt).getTime();
        if (!Number.isFinite(startedMs)) continue;

        const durationMs = Math.max(1, sched.durationMinutes) * 60 * 1000;
        if (nowMs >= startedMs + durationMs + EXPIRY_GRACE_MS) {
          expiredItems.push({ result: res, maxTabSwitches: sched.maxTabSwitches });
        }
      }

      if (expiredItems.length === 0) return 0;

      const CHUNK = 10;
      for (let i = 0; i < expiredItems.length; i += CHUNK) {
        const chunk = expiredItems.slice(i, i + CHUNK);
        await Promise.all(
          chunk.map(({ result, maxTabSwitches }) =>
            finalizeExamResultRecord(result, {
              maxTabSwitches,
              skipIfFinalized: true,
              broadcast: false,
            })
          )
        );
      }

      broadcastDataChange('results');
      return expiredItems.length;
    } finally {
      autoFinalizeInFlight = null;
    }
  })();

  return autoFinalizeInFlight;
}

export async function flushPendingSyncQueue(): Promise<number> {
  if (!isLiveSupabaseConfigured()) return 0;
  const results = await idbGetAll<ExamResult>(STORES.RESULTS);
  const pending = results.filter((r) => r.syncStatus === 'pending');
  let syncedCount = 0;

  for (const item of pending) {
    if (
      (item.status === 'submitted' || (item.status === 'flagged' && item.submittedAt !== null)) &&
      item.score === 0 &&
      item.correctCount === 0
    ) {
      // Coba sinkron dengan penilaian server RPC jika sebelumnya submit saat offline
      const finalized = await finalizeExamResultRecord(item, {
        skipIfFinalized: false,
        broadcast: false,
      });
      if (finalized.syncStatus === 'synced') {
        syncedCount += 1;
      }
      continue;
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
  }

  if (syncedCount > 0) {
    broadcastDataChange('sync_flushed');
  }
  return syncedCount;
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
    const supabase = getSupabaseClient();
    const { error } = await supabase.from('school_profile').select('id').limit(1);
    if (error) {
      const msg = error.message || '';
      if (msg.toLowerCase().includes('permission denied')) {
        return {
          ok: false,
          message: `Koneksi merespons error tabel: ${msg}. Salin dan jalankan ulang Skrip SQL di bawah pada Supabase SQL Editor untuk memberikan hak akses GRANT & kebijakan RLS pada role anon/authenticated.`,
        };
      }
      if (msg.toLowerCase().includes('does not exist') || msg.toLowerCase().includes('could not find')) {
        return {
          ok: false,
          message: `Tabel belum tersedia di Supabase (${msg}). Salin dan jalankan Skrip SQL di bawah pada Supabase SQL Editor terlebih dahulu.`,
        };
      }
      return { ok: false, message: `Koneksi merespons error tabel: ${msg}` };
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
    const supabase = getSupabaseClient();
    const adminClient = getSupabaseAdminClient();

    await Promise.all(
      tables.map(async (entry) => {
        try {
          if (entry.table === 'questions') {
            if (!adminClient) {
              entry.note = 'Diproteksi RLS (isi Service Role Key untuk cek jumlah cloud)';
              return;
            }
            const { count, error } = await adminClient
              .from('questions')
              .select('*', { count: 'exact', head: true });
            if (error) {
              entry.note = error.message;
            } else {
              entry.cloudCount = count ?? 0;
            }
            return;
          }
          const { count, error } = await supabase
            .from(entry.table)
            .select('*', { count: 'exact', head: true });
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
    const supabase = getSupabaseClient();
    const adminClient = getSupabaseAdminClient();

    const [profRes, schedRes, partRes, resRes, staffRes] = await Promise.all([
      supabase.from('school_profile').select('*').eq('id', 'default').maybeSingle(),
      supabase.from('exam_schedules').select('*'),
      supabase.from('participants').select('*'),
      supabase.from('exam_results').select('*'),
      supabase.from('staff_accounts').select('*'),
    ]);

    const hasCloudProfile = Boolean(!profRes.error && profRes.data);

    if (profRes.error) {
      errors.push(`school_profile: ${profRes.error.message}`);
    } else if (profRes.data) {
      await idbPut(STORES.META, {
        id: 'default',
        schoolName: profRes.data.school_name,
        address: profRes.data.address,
        academicYear: profRes.data.academic_year,
        principalName: profRes.data.principal_name,
        committeeChairName: profRes.data.committee_chair_name,
        examTitle: profRes.data.exam_title,
        logoDataUrl: profRes.data.logo_data_url || SEED_SCHOOL_PROFILE.logoDataUrl,
        adminPassword: profRes.data.admin_password || 'admin123',
        updatedAt: profRes.data.updated_at,
      } satisfies SchoolProfile);
      details.school_profile = 1;
    }

    if (schedRes.error) {
      errors.push(`exam_schedules: ${schedRes.error.message}`);
    } else if (schedRes.data) {
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
      errors.push(`participants: ${partRes.error.message}`);
    } else if (partRes.data) {
      if (partRes.data.length > 0 || hasCloudProfile) {
        await idbPutParticipantsSafe(
          partRes.data.map((r) => ({
            id: String(r.id),
            participantNumber: r.participant_number,
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
      errors.push(`exam_results: ${resRes.error.message}`);
    } else if (resRes.data) {
      const localResults = await idbGetAll<ExamResult>(STORES.RESULTS);
      const pendingLocals = localResults.filter((lr) => lr.syncStatus === 'pending');
      const pendingKeySet = new Set(
        pendingLocals.map((lr) => `${lr.participantNumber.trim().toUpperCase()}::${lr.examId}`)
      );

      const cloudResults: ExamResult[] = resRes.data
        .filter(
          (r) =>
            !pendingKeySet.has(
              `${String(r.participant_number || '').trim().toUpperCase()}::${r.exam_id}`
            )
        )
        .map((r) => ({
          id: r.id,
          participantId: r.participant_id,
          participantNumber: r.participant_number,
          studentName: r.student_name,
          className: r.class_name,
          examId: r.exam_id,
          examTitle: r.exam_title,
          subject: r.subject || '',
          answers: r.answers || {},
          flaggedQuestions: r.flagged_questions || [],
          questionIds: Array.isArray(r.question_ids) ? r.question_ids : undefined,
          correctCount: r.correct_count,
          totalQuestions: r.total_questions,
          score: Number(r.score),
          tabSwitchCount: r.tab_switch_count,
          status: r.status,
          startedAt: r.started_at,
          submittedAt: r.submitted_at,
          syncStatus: 'synced' as const,
        }));

      await idbPutMany(STORES.RESULTS, [...cloudResults, ...pendingLocals], true);
      details.exam_results = resRes.data.length;
    }

    if (staffRes.error) {
      if (isMissingTableError(staffRes.error.message)) {
        errors.push('staff_accounts: Tabel belum dibuat di Supabase (jalankan Skema SQL terlebih dahulu).');
      } else {
        errors.push(`staff_accounts: ${staffRes.error.message}`);
      }
    } else if (staffRes.data) {
      details.staff_accounts = staffRes.data.length;
      if (staffRes.data.length > 0) {
        const mappedStaff: StaffAccount[] = staffRes.data.map((s) => ({
          id: String(s.id),
          userId: String(s.user_id),
          name: String(s.name),
          password: String(s.password_hash || ''),
          roleType: s.role_type,
          roleLabel: String(s.role_label || 'Staff'),
          allowedTabs: Array.isArray(s.allowed_tabs) ? s.allowed_tabs : [],
          assignedSubjects: Array.isArray(s.assigned_subjects) ? s.assigned_subjects : [],
          restrictToAssignedSubjects: Boolean(s.restrict_to_assigned_subjects),
          isActive: Boolean(s.is_active),
          createdAt: s.created_at,
        }));
        const hasCloudAdmin = mappedStaff.some(
          (s) => s.userId.trim().toLowerCase() === 'admin'
        );
        if (!hasCloudAdmin) {
          const localStaff = await idbGetAll<StaffAccount>(STORES.STAFF_ACCOUNTS);
          const localAdmin = localStaff.find(
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
      const qRes = await adminClient.from('questions').select('*');
      if (qRes.error) {
        errors.push(`questions: ${qRes.error.message}`);
      } else if (qRes.data) {
        await idbPutMany(
          STORES.QUESTIONS,
          qRes.data.map((q) => ({
            id: q.id,
            subject: q.subject,
            targetClasses: q.target_classes || [],
            questionText: q.question_text,
            questionImageUrl: q.question_image_url || undefined,
            options: q.options || [],
            correctAnswer: q.correct_answer,
            points: Number(q.points ?? 1),
            orderIndex: Number(q.order_index ?? 1),
          })),
          true
        );
        details.questions = qRes.data.length;
      }
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
      const { error } = await supabase.from('school_profile').upsert({
        id: 'default',
        school_name: profile.schoolName,
        address: profile.address,
        academic_year: profile.academicYear,
        principal_name: profile.principalName,
        committee_chair_name: profile.committeeChairName,
        exam_title: profile.examTitle,
        logo_data_url: profile.logoDataUrl,
        admin_password: profile.adminPassword,
        updated_at: profile.updatedAt || timestamp,
      });
      if (error) errors.push(`school_profile: ${error.message}`);
      else details.school_profile = 1;
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
      const CHUNK = 200;
      let pushedParts = 0;
      for (let i = 0; i < participants.length; i += CHUNK) {
        const chunk = participants.slice(i, i + CHUNK);
        const { error } = await supabase.from('participants').upsert(
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
        if (error) {
          errors.push(`participants (batch ${i / CHUNK + 1}): ${error.message}`);
        } else {
          pushedParts += chunk.length;
        }
      }
      details.participants = pushedParts;
    }

    if (staffAccounts.length > 0) {
      const hashedPayload = await Promise.all(
        staffAccounts.map(async (s) => ({
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
      if (staffErr) {
        if (isMissingTableError(staffErr.message)) {
          errors.push('staff_accounts: Tabel belum dibuat di Supabase (jalankan Skema SQL terlebih dahulu).');
        } else {
          errors.push(`staff_accounts: ${staffErr.message}`);
        }
      } else {
        details.staff_accounts = staffAccounts.length;
      }
    }

    if (questions.length > 0) {
      const CHUNK = 100;
      let pushedQuestions = 0;
      for (let i = 0; i < questions.length; i += CHUNK) {
        const chunk = questions.slice(i, i + CHUNK);
        const payload = chunk.map((q) => ({
          id: q.id,
          subject: q.subject,
          target_classes: q.targetClasses,
          question_text: q.questionText,
          question_image_url: q.questionImageUrl || '',
          options: q.options,
          correct_answer: q.correctAnswer,
          points: q.points,
          order_index: q.orderIndex,
        }));
        const { error: rpcError } = await supabase.rpc('upsert_questions_batch', {
          p_questions: payload,
        });
        if (rpcError) {
          if (adminClient) {
            const { error: adminErr } = await adminClient.from('questions').upsert(payload);
            if (adminErr) {
              errors.push(`questions (batch ${i / CHUNK + 1}): ${adminErr.message}`);
            } else {
              pushedQuestions += chunk.length;
            }
          } else {
            errors.push(`questions (RPC batch ${i / CHUNK + 1}): ${rpcError.message}`);
          }
        } else {
          pushedQuestions += chunk.length;
        }
      }
      details.questions = pushedQuestions;
    }

    if (results.length > 0) {
      const CHUNK = 200;
      let pushedResults = 0;
      const updatedLocalResults: ExamResult[] = [];
      for (let i = 0; i < results.length; i += CHUNK) {
        const chunk = results.slice(i, i + CHUNK);
        const { error } = await supabase.from('exam_results').upsert(
          chunk.map((r) => ({
            id: r.id,
            participant_id: r.participantId,
            participant_number: r.participantNumber,
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
          })),
          { onConflict: 'participant_number,exam_id' }
        );
        if (error) {
          errors.push(`exam_results (batch ${i / CHUNK + 1}): ${error.message}`);
        } else {
          pushedResults += chunk.length;
          chunk.forEach((r) => updatedLocalResults.push({ ...r, syncStatus: 'synced' }));
        }
      }
      if (updatedLocalResults.length > 0) {
        await idbPutMany(STORES.RESULTS, updatedLocalResults);
      }
      details.exam_results = pushedResults;
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

  for (const item of pending) {
    if (
      (item.status === 'submitted' || (item.status === 'flagged' && item.submittedAt !== null)) &&
      item.score === 0 &&
      item.correctCount === 0
    ) {
      const finalized = await finalizeExamResultRecord(item, {
        skipIfFinalized: false,
        broadcast: false,
      });
      if (finalized.syncStatus === 'synced') {
        flushed += 1;
      } else {
        errors.push(`Gagal menilai/mengunggah hasil ${item.participantNumber} (${item.subject})`);
      }
      continue;
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
