/**
 * Mass Exam & Resilience Simulation Harness for Nusantara CBT
 * Tests REAL dataStore.ts & questionUtils.ts against a simulated Supabase PostgREST/RPC server
 * enforcing Chromium's 64 KiB shared per-document Fetch keepalive quota, server concurrency limits,
 * offline/online blackouts, multi-tab shared IndexedDB/localStorage/WebLocks, and last-second expiry races.
 */

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

class MemoryIDBStore {
  data = new Map<string, unknown>();
  keyPath: string;
  constructor(keyPath: string) {
    this.keyPath = keyPath;
  }
  createIndex(): void {}
  put(value: Record<string, unknown>) {
    const key = String(value[this.keyPath]);
    this.data.set(key, structuredClone(value));
    const req: Record<string, unknown> = { result: key, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      if (typeof req.onsuccess === 'function') (req.onsuccess as () => void)();
    });
    return req;
  }
  get(key: string) {
    const val = this.data.has(key) ? structuredClone(this.data.get(key)) : undefined;
    const req: Record<string, unknown> = { result: val, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      if (typeof req.onsuccess === 'function') (req.onsuccess as () => void)();
    });
    return req;
  }
  getAll() {
    const vals = Array.from(this.data.values()).map((v) => structuredClone(v));
    const req: Record<string, unknown> = { result: vals, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      if (typeof req.onsuccess === 'function') (req.onsuccess as () => void)();
    });
    return req;
  }
  delete(key: string) {
    this.data.delete(key);
    const req: Record<string, unknown> = { result: undefined, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      if (typeof req.onsuccess === 'function') (req.onsuccess as () => void)();
    });
    return req;
  }
  clear() {
    this.data.clear();
    const req: Record<string, unknown> = { result: undefined, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      if (typeof req.onsuccess === 'function') (req.onsuccess as () => void)();
    });
    return req;
  }
}

class MemoryIDBDatabase {
  stores = new Map<string, MemoryIDBStore>();
  onversionchange: (() => void) | null = null;
  onclose: (() => void) | null = null;
  objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  };
  createObjectStore(name: string, opts: { keyPath: string }) {
    const store = new MemoryIDBStore(opts.keyPath);
    this.stores.set(name, store);
    return store;
  }
  transaction(storeName: string) {
    const store = this.stores.get(storeName);
    if (!store) throw new Error(`Missing IDB store: ${storeName}`);
    const tx: Record<string, unknown> = {
      oncomplete: null,
      onerror: null,
      objectStore: () => store,
    };
    Promise.resolve()
      .then(() => Promise.resolve())
      .then(() => {
        if (typeof tx.oncomplete === 'function') (tx.oncomplete as () => void)();
      });
    return tx;
  }
  close(): void {}
}

const sharedDb = new MemoryIDBDatabase();
let dbInitialized = false;

const memoryIndexedDB = {
  open() {
    const req: Record<string, unknown> = {
      result: sharedDb,
      onupgradeneeded: null,
      onsuccess: null,
      onerror: null,
      onblocked: null,
    };
    queueMicrotask(() => {
      if (!dbInitialized) {
        dbInitialized = true;
        if (typeof req.onupgradeneeded === 'function') {
          (req.onupgradeneeded as () => void)();
        }
      }
      if (typeof req.onsuccess === 'function') {
        (req.onsuccess as () => void)();
      }
    });
    return req;
  },
};

const localStorageShim = new MemoryStorage();
const windowListeners = new Map<string, Set<(...args: unknown[]) => void>>();

const windowShim = {
  addEventListener: (ev: string, fn: (...args: unknown[]) => void) => {
    if (!windowListeners.has(ev)) windowListeners.set(ev, new Set());
    windowListeners.get(ev)!.add(fn);
  },
  removeEventListener: (ev: string, fn: (...args: unknown[]) => void) => {
    windowListeners.get(ev)?.delete(fn);
  },
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
  localStorage: localStorageShim,
};

const g = globalThis as unknown as Record<string, unknown>;
g.window = windowShim;
g.localStorage = localStorageShim;
g.indexedDB = memoryIndexedDB;
g.document = { hidden: false };
Object.defineProperty(globalThis, 'navigator', {
  value: {
    onLine: true,
    locks: {
      _held: new Set<string>(),
      async request(
        name: string,
        optsOrCb: { ifAvailable?: boolean } | ((lock: unknown) => Promise<unknown>),
        maybeCb?: (lock: unknown) => Promise<unknown>
      ) {
        const opts = typeof optsOrCb === 'function' ? {} : optsOrCb;
        const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb!;
        const held = (g.navigator as { locks: { _held: Set<string> } }).locks._held;
        if (held.has(name)) {
          if (opts.ifAvailable) {
            return cb(null);
          }
          while (held.has(name)) {
            await new Promise((r) => setTimeout(r, 5));
          }
        }
        held.add(name);
        try {
          return await cb({ name });
        } finally {
          held.delete(name);
        }
      },
    },
  },
  configurable: true,
});

interface ServerRow {
  id: string;
  participant_id: string;
  participant_number: string;
  student_name: string;
  class_name: string;
  exam_id: string;
  exam_title: string;
  subject: string;
  answers: Record<string, unknown>;
  flagged_questions: string[];
  question_ids: string[] | null;
  correct_count: number;
  total_questions: number;
  score: number;
  tab_switch_count: number;
  status: 'in_progress' | 'submitted' | 'flagged';
  started_at: string;
  submitted_at: string | null;
  updated_at: string;
}

const serverState = {
  online: true,
  poolCapacity: 60,
  inFlightRequests: 0,
  peakInFlightRequests: 0,
  totalRequests: 0,
  error503Count: 0,
  timeoutCount: 0,
  offlineDropCount: 0,
  keepaliveLimitBytes: 65_536,
  activeKeepaliveBytes: 0,
  keepaliveAttempts: 0,
  keepaliveSucceeded: 0,
  keepaliveRejectedOverLimit: 0,
  nonKeepaliveDuringUnloadCount: 0,
  lastKeepaliveBodies: [] as Array<{ bytes: number; keepalive: boolean; ok: boolean; error?: string }>,
  rpcCounts: new Map<string, number>(),
  questions: new Map<string, { id: string; correct_answer: string; points: number; q_type: string }>(),
  results: new Map<string, ServerRow>(),
  baseLatencyMs: 12,
  simulateUnloadAbortNonKeepalive: false,
};

function resetServerStats() {
  serverState.inFlightRequests = 0;
  serverState.peakInFlightRequests = 0;
  serverState.totalRequests = 0;
  serverState.error503Count = 0;
  serverState.timeoutCount = 0;
  serverState.offlineDropCount = 0;
  serverState.activeKeepaliveBytes = 0;
  serverState.keepaliveAttempts = 0;
  serverState.keepaliveSucceeded = 0;
  serverState.keepaliveRejectedOverLimit = 0;
  serverState.nonKeepaliveDuringUnloadCount = 0;
  serverState.lastKeepaliveBodies = [];
  serverState.rpcCounts.clear();
  serverState.simulateUnloadAbortNonKeepalive = false;
}

function scoreAnswersOnServer(answers: Record<string, unknown>, questionIds: string[] | null) {
  let totalQ = 0;
  let correctCount = 0;
  let totalPts = 0;
  let earnedPts = 0;

  const qList =
    questionIds && questionIds.length > 0
      ? questionIds.map((id) => serverState.questions.get(id)).filter(Boolean)
      : Array.from(serverState.questions.values());

  for (const q of qList) {
    if (!q) continue;
    totalQ++;
    totalPts += q.points;
    const rawAns = answers[q.id];
    if (q.q_type === 'matching') {
      const correctMap = JSON.parse(q.correct_answer) as Record<string, string>;
      const studentMap =
        typeof rawAns === 'object' && rawAns !== null
          ? (rawAns as Record<string, string>)
          : typeof rawAns === 'string' && rawAns.startsWith('{')
            ? (JSON.parse(rawAns) as Record<string, string>)
            : {};
      const entries = Object.entries(correctMap);
      let matched = 0;
      for (const [k, v] of entries) {
        if (studentMap[k] === v) matched++;
      }
      if (entries.length > 0) {
        earnedPts += (q.points * matched) / entries.length;
        if (matched === entries.length) correctCount++;
      }
    } else if (rawAns === q.correct_answer) {
      correctCount++;
      earnedPts += q.points;
    }
  }
  const score = totalPts > 0 ? Math.round((earnedPts / totalPts) * 10000) / 100 : 0;
  return { correct_count: correctCount, total_questions: totalQ, score };
}

g.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const bodyStr = typeof init?.body === 'string' ? init.body : '';
  const bodyBytes = new TextEncoder().encode(bodyStr).length;
  const isKeepalive = Boolean(init?.keepalive);

  if (isKeepalive) {
    serverState.keepaliveAttempts++;
    if (serverState.activeKeepaliveBytes + bodyBytes > serverState.keepaliveLimitBytes) {
      serverState.keepaliveRejectedOverLimit++;
      serverState.lastKeepaliveBodies.push({
        bytes: bodyBytes,
        keepalive: true,
        ok: false,
        error: `Keepalive quota exceeded: active(${serverState.activeKeepaliveBytes}) + req(${bodyBytes}) > ${serverState.keepaliveLimitBytes}`,
      });
      throw new TypeError('Failed to fetch: keepalive payload limit (64 KiB) exceeded');
    }
    serverState.activeKeepaliveBytes += bodyBytes;
  } else if (serverState.simulateUnloadAbortNonKeepalive) {
    serverState.nonKeepaliveDuringUnloadCount++;
    serverState.lastKeepaliveBodies.push({
      bytes: bodyBytes,
      keepalive: false,
      ok: false,
      error: 'Browser aborted non-keepalive fetch during page unload',
    });
    throw new TypeError('Failed to fetch: aborted on page unload');
  }

  serverState.totalRequests++;
  serverState.inFlightRequests++;
  if (serverState.inFlightRequests > serverState.peakInFlightRequests) {
    serverState.peakInFlightRequests = serverState.inFlightRequests;
  }

  try {
    if (!serverState.online) {
      serverState.offlineDropCount++;
      await new Promise((r) => setTimeout(r, 5));
      throw new TypeError('Failed to fetch: ERR_INTERNET_DISCONNECTED');
    }

    if (serverState.inFlightRequests > serverState.poolCapacity) {
      serverState.error503Count++;
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ message: '503 Service Unavailable: Pool exhausted' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const loadDelay = serverState.baseLatencyMs + Math.floor(serverState.inFlightRequests * 1.2);
    await new Promise((r) => setTimeout(r, loadDelay));

    if (init?.signal?.aborted) {
      serverState.timeoutCount++;
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    const parsedUrl = new URL(urlStr);
    const path = parsedUrl.pathname;

    if (path.includes('/rest/v1/rpc/')) {
      const rpcName = path.split('/rest/v1/rpc/')[1];
      serverState.rpcCounts.set(rpcName, (serverState.rpcCounts.get(rpcName) || 0) + 1);
      const args = bodyStr ? (JSON.parse(bodyStr) as Record<string, unknown>) : {};

      if (rpcName === 'get_server_time') {
        return new Response(JSON.stringify(new Date().toISOString()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (rpcName === 'upsert_exam_progress') {
        const pNum = String(args.p_participant_number || '').trim().toUpperCase();
        const examId = String(args.p_exam_id || '');
        const key = `${pNum}::${examId}`;
        const existing = serverState.results.get(key);
        if (existing && (existing.status !== 'in_progress' || existing.submitted_at !== null)) {
          if (isKeepalive) {
            serverState.keepaliveSucceeded++;
            serverState.lastKeepaliveBodies.push({ bytes: bodyBytes, keepalive: true, ok: true });
          }
          return new Response(
            JSON.stringify([
              { applied: false, current_status: existing.status, submitted_at: existing.submitted_at },
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        const nextRow: ServerRow = {
          id: existing?.id || String(args.p_result_id),
          participant_id: String(args.p_participant_id || existing?.participant_id || ''),
          participant_number: pNum,
          student_name: existing?.student_name || String(args.p_student_name || ''),
          class_name: existing?.class_name || String(args.p_class_name || ''),
          exam_id: examId,
          exam_title: existing?.exam_title || String(args.p_exam_title || ''),
          subject: existing?.subject || String(args.p_subject || ''),
          answers: (args.p_answers as Record<string, unknown>) || {},
          flagged_questions: Array.isArray(args.p_flagged_questions)
            ? (args.p_flagged_questions as string[])
            : [],
          question_ids:
            existing?.question_ids ||
            (Array.isArray(args.p_question_ids) ? (args.p_question_ids as string[]) : null),
          correct_count: 0,
          total_questions: Number(args.p_total_questions || 0),
          score: 0,
          tab_switch_count: Math.max(existing?.tab_switch_count || 0, Number(args.p_tab_switch_count || 0)),
          status: 'in_progress',
          started_at: existing?.started_at || String(args.p_started_at || new Date().toISOString()),
          submitted_at: null,
          updated_at: new Date().toISOString(),
        };
        serverState.results.set(key, nextRow);

        if (isKeepalive) {
          serverState.keepaliveSucceeded++;
          serverState.lastKeepaliveBodies.push({ bytes: bodyBytes, keepalive: true, ok: true });
        }
        return new Response(
          JSON.stringify([{ applied: true, current_status: 'in_progress', submitted_at: null }]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (rpcName === 'submit_exam_and_score') {
        const pNum = String(args.p_participant_number || '').trim().toUpperCase();
        const examId = String(args.p_exam_id || '');
        const key = `${pNum}::${examId}`;
        const existing = serverState.results.get(key);
        if (existing && (existing.status !== 'in_progress' || existing.submitted_at !== null)) {
          return new Response(
            JSON.stringify([
              {
                correct_count: existing.correct_count,
                total_questions: existing.total_questions,
                score: existing.score,
              },
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        const qIds =
          existing?.question_ids ||
          (Array.isArray(args.p_question_ids) ? (args.p_question_ids as string[]) : null);
        const answers = (args.p_answers as Record<string, unknown>) || {};
        const scored = scoreAnswersOnServer(answers, qIds);
        const maxTabs = Number(args.p_max_tab_switches ?? 3);
        const tabSwitches = Math.max(existing?.tab_switch_count || 0, Number(args.p_tab_switch_count || 0));

        const finalRow: ServerRow = {
          id: existing?.id || String(args.p_result_id),
          participant_id: String(args.p_participant_id || ''),
          participant_number: pNum,
          student_name: String(args.p_student_name || ''),
          class_name: String(args.p_class_name || ''),
          exam_id: examId,
          exam_title: String(args.p_exam_title || ''),
          subject: String(args.p_subject || ''),
          answers,
          flagged_questions: Array.isArray(args.p_flagged_questions)
            ? (args.p_flagged_questions as string[])
            : [],
          question_ids: qIds,
          correct_count: scored.correct_count,
          total_questions: scored.total_questions,
          score: scored.score,
          tab_switch_count: tabSwitches,
          status: tabSwitches >= maxTabs ? 'flagged' : 'submitted',
          started_at: existing?.started_at || String(args.p_started_at || new Date().toISOString()),
          submitted_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        serverState.results.set(key, finalRow);

        return new Response(JSON.stringify([scored]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    if (path.endsWith('/rest/v1/school_profile')) {
      serverState.rpcCounts.set('REST:school_profile', (serverState.rpcCounts.get('REST:school_profile') || 0) + 1);
      return new Response(
        JSON.stringify({
          id: 'default',
          school_name: 'MTs Negeri Simulasi',
          address: 'Jl. Pendidikan No. 1',
          academic_year: '2026/2027',
          principal_name: 'Kepala Madrasah',
          committee_chair_name: 'Ketua Panitia',
          exam_title: 'Asesmen Sumatif Akhir Semester',
          logo_data_url: '',
          kemenag_logo_data_url: '',
          updated_at: '2026-11-01T00:00:00.000Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (path.endsWith('/rest/v1/exam_schedules')) {
      serverState.rpcCounts.set('REST:exam_schedules', (serverState.rpcCounts.get('REST:exam_schedules') || 0) + 1);
      return new Response(
        JSON.stringify([
          {
            id: 'sched-mtk-1',
            title: 'Ujian Matematika',
            subject: 'Matematika',
            kkm: 75,
            duration_minutes: 60,
            target_classes: ['7A', '8A', '9A'],
            is_active: true,
            randomize_questions: false,
            max_tab_switches: 3,
            created_at: '2026-11-01T00:00:00.000Z',
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (path.endsWith('/rest/v1/exam_results')) {
      serverState.rpcCounts.set('REST:exam_results', (serverState.rpcCounts.get('REST:exam_results') || 0) + 1);
      const pFilter = parsedUrl.searchParams.get('participant_number');
      let rows = Array.from(serverState.results.values());
      if (pFilter && pFilter.startsWith('eq.')) {
        const target = pFilter.slice(3).toUpperCase();
        rows = rows.filter((r) => r.participant_number === target);
      }
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } finally {
    serverState.inFlightRequests--;
    if (isKeepalive) {
      serverState.activeKeepaliveBytes = Math.max(0, serverState.activeKeepaliveBytes - bodyBytes);
    }
  }
};

async function runSimulations() {
  const dataStore = await import('../src/lib/dataStore.ts');
  const { saveSupabaseConfig } = await import('../src/lib/supabase.ts');
  type ActiveExamSession = import('../src/types/cbt.ts').ActiveExamSession;
  type StudentQuestion = import('../src/types/cbt.ts').StudentQuestion;
  type ExamSchedule = import('../src/types/cbt.ts').ExamSchedule;
  type Question = import('../src/types/cbt.ts').Question;

  saveSupabaseConfig(
    'https://sim-local-test.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsInJlZiI6InNpbS1sb2NhbC10ZXN0In0.sim'
  );
  await dataStore.ensureInitialized();

  const baseSchedule: ExamSchedule = {
    id: 'sched-mtk-1',
    title: 'Ujian Matematika Massal',
    subject: 'Matematika',
    kkm: 75,
    durationMinutes: 60,
    targetClasses: ['7A', '8A', '9A'],
    isActive: true,
    randomizeQuestions: false,
    maxTabSwitches: 3,
    createdAt: '2026-11-01T00:00:00.000Z',
  };
  await dataStore.upsertExamSchedule(baseSchedule);

  const mcQuestions: StudentQuestion[] = [];
  const fullQuestions: Question[] = [];
  for (let i = 1; i <= 40; i++) {
    const id = `q-mtk-${String(i).padStart(3, '0')}`;
    serverState.questions.set(id, { id, correct_answer: 'A', points: 1, q_type: 'multiple_choice' });
    const opts = [
      { key: 'A' as const, text: 'Opsi A' },
      { key: 'B' as const, text: 'Opsi B' },
      { key: 'C' as const, text: 'Opsi C' },
      { key: 'D' as const, text: 'Opsi D' },
    ];
    mcQuestions.push({
      id,
      subject: 'Matematika',
      targetClasses: ['7A', '8A', '9A'],
      questionType: 'multiple_choice',
      questionText: `Soal Matematika ke-${i}`,
      options: opts,
      points: 1,
      orderIndex: i,
    });
    fullQuestions.push({
      ...mcQuestions[mcQuestions.length - 1],
      correctAnswer: 'A',
    });
  }

  function makeSession(idx: number, questions = mcQuestions, answers: Record<string, string> = {}): ActiveExamSession {
    const pNum = `SIM-${String(idx).padStart(4, '0')}`;
    const now = Date.now();
    return {
      resultId: `res-${pNum}-${baseSchedule.id}`,
      participant: {
        id: `part-${idx}`,
        participantNumber: pNum,
        token: 'CBT2026',
        fullName: `Siswa Simulasi ${idx}`,
        className: '7A',
        isActive: true,
        createdAt: new Date(now).toISOString(),
      },
      schedule: baseSchedule,
      questions,
      answers: { ...answers },
      flaggedQuestions: [],
      currentIndex: 0,
      tabSwitchCount: 0,
      startedAt: new Date(now - 59 * 60 * 1000).toISOString(),
      endsAt: new Date(now + 60 * 1000).toISOString(),
    };
  }

  let allPassed = true;
  const assertPass = (cond: boolean, label: string) => {
    if (!cond) allPassed = false;
    return cond ? 'PASS' : 'FAIL';
  };

  console.log('========================================================================');
  console.log('SIMULASI UJIAN MASSAL NUSANTARA CBT — VERIFIKASI PASCA-HARDENING');
  console.log('========================================================================\n');

  // ==========================================================================
  // UJI 1: SUBMIT DETIK AKHIR
  // ==========================================================================
  console.log('--- [UJI 1] Submit Detik Akhir (50 siswa + crash recovery + jitter race) ---');
  resetServerStats();
  serverState.results.clear();

  let lastSecondRecordedCount = 0;
  let lastSecondScoreCorrectCount = 0;
  let staleOverwriteDuringJitterCount = 0;

  const t1Tasks = Array.from({ length: 50 }, async (_, idx) => {
    const baseAnswers: Record<string, string> = {};
    for (let q = 1; q <= 39; q++) baseAnswers[`q-mtk-${String(q).padStart(3, '0')}`] = 'A';
    const session = makeSession(1000 + idx, mcQuestions, baseAnswers);

    await dataStore.upsertExamProgress(session, { includeQuestionIds: true });

    // T - 50ms: siswa klik jawaban detik terakhir Q40 = 'A'
    session.answers['q-mtk-040'] = 'A';
    dataStore.saveActiveSessionLocal(session);
    // Timer habis -> ExamRoom segera simpan snapshot lokal ke exam_results sebelum menunggu expiryJitter
    await dataStore.saveLocalResultProgressSnapshot(session);

    // Simulasi flushPendingSyncQueue berjalan di tengah masa tunggu expiryJitter
    await new Promise((r) => setTimeout(r, 15 + Math.floor(Math.random() * 80)));
    if (idx % 5 === 0) {
      await dataStore.flushPendingSyncQueue();
    }

    const finalRes = await dataStore.submitFinalExam(session, { skipInitialJitter: true });
    const serverRow = serverState.results.get(`${session.participant.participantNumber}::${baseSchedule.id}`);
    if (finalRes.status === 'submitted' && serverRow?.status === 'submitted') {
      if (serverRow.answers['q-mtk-040'] === 'A') {
        lastSecondRecordedCount++;
      } else {
        staleOverwriteDuringJitterCount++;
      }
      if (serverRow.correct_count === 40 && serverRow.score === 100) {
        lastSecondScoreCorrectCount++;
      }
    }
  });
  await Promise.all(t1Tasks);

  // Test 1B: Abrupt crash right after last-second click (before async IDB completes) -> recovery via sync localStorage
  let crashRecoveredQ40 = false;
  {
    const baseAnswers: Record<string, string> = {};
    for (let q = 1; q <= 39; q++) baseAnswers[`q-mtk-${String(q).padStart(3, '0')}`] = 'A';
    const crashSession = makeSession(1999, mcQuestions, baseAnswers);
    await dataStore.upsertExamProgress(crashSession, { includeQuestionIds: true });
    await new Promise((r) => setTimeout(r, 15));

    // Click Q40='A' at T - 30ms
    crashSession.answers['q-mtk-040'] = 'A';
    dataStore.saveActiveSessionLocal(crashSession);

    // Simulate async IDB write being lost on sudden tab crash (revert IDB active_session to Q1..Q39)
    const staleIdbCopy = structuredClone(crashSession);
    delete staleIdbCopy.answers['q-mtk-040'];
    sharedDb.stores.get('active_session')?.data.set('current', { id: 'current', session: staleIdbCopy });

    // Re-read via getSavedActiveSession() (reconciles with synchronous localStorage emergency backup)
    const recovered = dataStore.getSavedActiveSession();
    crashRecoveredQ40 = recovered?.answers['q-mtk-040'] === 'A';
    dataStore.clearActiveSessionLocal();
  }

  console.log(`  Jawaban detik akhir Q40 tercatat di server: ${lastSecondRecordedCount}/50 [${assertPass(lastSecondRecordedCount === 50, 'U1A')}]`);
  console.log(`  Skor akhir 100 (40/40 benar) akurat:        ${lastSecondScoreCorrectCount}/50 [${assertPass(lastSecondScoreCorrectCount === 50, 'U1B')}]`);
  console.log(`  Stale overwrite saat jitter:                ${staleOverwriteDuringJitterCount} [${assertPass(staleOverwriteDuringJitterCount === 0, 'U1C')}]`);
  console.log(`  Recovery crash via sync localStorage:       ${crashRecoveredQ40 ? '1/1' : '0/1'} [${assertPass(crashRecoveredQ40, 'U1D')}]\n`);

  // ==========================================================================
  // UJI 2: OFFLINE -> ONLINE MULTI-TAB & MULTI-PERANGKAT
  // ==========================================================================
  console.log('--- [UJI 2] Offline -> Online Multi-Tab & Multi-Perangkat ---');
  resetServerStats();
  serverState.results.clear();
  sharedDb.stores.get('exam_results')?.clear();

  // Seed questions locally for 1 locally-scored offline submit (regression test for stuck pending bug)
  await dataStore.upsertQuestions(fullQuestions);
  serverState.online = false;
  (globalThis.navigator as { onLine: boolean }).onLine = false;

  const offlineScoredSession = makeSession(2001, mcQuestions);
  for (let q = 1; q <= 35; q++) offlineScoredSession.answers[`q-mtk-${String(q).padStart(3, '0')}`] = 'A';
  const offlineSubmitted = await dataStore.submitFinalExam(offlineScoredSession, { skipInitialJitter: true });

  // Clear local questions vault for 20 offline in_progress + 20 offline unscored submitted records
  sharedDb.stores.get('questions')?.clear();
  for (let i = 2002; i <= 2021; i++) {
    const s = makeSession(i, mcQuestions);
    for (let q = 1; q <= 20; q++) s.answers[`q-mtk-${String(q).padStart(3, '0')}`] = 'A';
    await dataStore.upsertExamProgress(s, { includeQuestionIds: true });
  }
  for (let i = 2022; i <= 2041; i++) {
    const s = makeSession(i, mcQuestions);
    for (let q = 1; q <= 30; q++) s.answers[`q-mtk-${String(q).padStart(3, '0')}`] = 'A';
    await dataStore.submitFinalExam(s, { skipInitialJitter: true });
  }

  const pendingBeforeOnline = (await dataStore.getExamResults()).filter((r) => r.syncStatus === 'pending').length;

  // Go ONLINE simultaneously!
  serverState.online = true;
  (globalThis.navigator as { onLine: boolean }).onLine = true;
  localStorageShim.removeItem('cbt_server_clock_cache_v1');
  localStorageShim.removeItem('cbt_student_pull_ts_v1');
  resetServerStats();

  // Simulate 5 browser tabs reconnecting simultaneously (clock sync + flush + student pull)
  const [clockCalls, flushCounts] = await Promise.all([
    Promise.all([
      dataStore.syncServerClock(true),
      dataStore.syncServerClock(true),
      dataStore.syncServerClock(true),
      dataStore.syncServerClock(true),
      dataStore.syncServerClock(true),
    ]),
    Promise.all([
      dataStore.flushPendingSyncQueue(),
      dataStore.flushPendingSyncQueue(),
      dataStore.flushPendingSyncQueue(),
      dataStore.flushPendingSyncQueue(),
      dataStore.flushPendingSyncQueue(),
    ]),
    Promise.all([
      dataStore.syncFromSupabase({ force: false }),
      dataStore.syncFromSupabase({ force: false }),
      dataStore.syncFromSupabase({ force: false }),
      dataStore.syncFromSupabase({ force: false }),
      dataStore.syncFromSupabase({ force: false }),
    ]),
  ]);
  void clockCalls;

  // Also test subsequent cross-tab calls after first tab finished (using shared localStorage cooldowns)
  await dataStore.syncServerClock(true);
  await dataStore.syncFromSupabase({ force: false });

  const allLocalAfterOnline = await dataStore.getExamResults();
  const pendingAfterOnline = allLocalAfterOnline.filter((r) => r.syncStatus === 'pending');
  const offlineScoredAfter = allLocalAfterOnline.find((r) => r.id === offlineSubmitted.id);
  const clockRpcCount = serverState.rpcCounts.get('get_server_time') || 0;
  const schedPullCount = serverState.rpcCounts.get('REST:exam_schedules') || 0;

  // Multi-device reconnect storm: 200 devices reconnecting across proportional jitter window (30-450ms -> 3-45s real)
  const deviceReconnectTasks = Array.from({ length: 200 }, async (_, idx) => {
    const jitter = 30 + Math.floor(Math.random() * 420);
    await new Promise((r) => setTimeout(r, jitter));
    const s = makeSession(3000 + idx, mcQuestions);
    for (let q = 1; q <= 25; q++) s.answers[`q-mtk-${String(q).padStart(3, '0')}`] = 'A';
    await dataStore.upsertExamProgress(s, { includeQuestionIds: false });
  });
  await Promise.all(deviceReconnectTasks);

  const syncedOnServer200 = Array.from(serverState.results.keys()).filter((k) => k.startsWith('SIM-3')).length;

  console.log(`  Pending lokal sebelum online:               ${pendingBeforeOnline}`);
  console.log(`  Pending lokal tersisa setelah online:       ${pendingAfterOnline.length} [${assertPass(pendingAfterOnline.length === 0, 'U2A')}]`);
  console.log(`  Item offline locally-scored (87.5) synced:  ${offlineScoredAfter?.syncStatus} [${assertPass(offlineScoredAfter?.syncStatus === 'synced', 'U2B')}]`);
  console.log(`  Cross-tab dedup (6 calls):                  get_server_time=${clockRpcCount}, exam_schedules=${schedPullCount} [${assertPass(clockRpcCount === 1 && schedPullCount === 1, 'U2C')}]`);
  console.log(`  200 perangkat reconnect serentak tersinkron:${syncedOnServer200}/200 [${assertPass(syncedOnServer200 === 200, 'U2D')}]`);
  console.log(`  Peak concurrent req / 503 / timeout:        peak=${serverState.peakInFlightRequests}/${serverState.poolCapacity}, 503=${serverState.error503Count}, timeout=${serverState.timeoutCount} [${assertPass(serverState.error503Count === 0 && serverState.timeoutCount === 0, 'U2E')}]`);
  console.log(`  Multi-tab flush return values:              [${flushCounts.join(', ')}]\n`);

  // ==========================================================================
  // UJI 3: TUTUP / PINDAH HALAMAN SAAT UJIAN (KEEPALIVE PAYLOAD SIZE)
  // ==========================================================================
  console.log('--- [UJI 3] Tutup / Pindah Halaman Saat Ujian (Keepalive & 64 KiB Quota) ---');
  resetServerStats();
  serverState.results.clear();
  serverState.simulateUnloadAbortNonKeepalive = true;

  function makeMatchingSession(idx: number, numMatchingQs: number): ActiveExamSession {
    const qs: StudentQuestion[] = [];
    const ans: Record<string, string> = {};
    const flags: string[] = [];
    for (let i = 1; i <= numMatchingQs; i++) {
      const qId = `question-matching-uuid-${String(i).padStart(4, '0')}-abcdef123456`;
      const pairMap: Record<string, string> = {};
      for (let p = 1; p <= 6; p++) {
        pairMap[`left_item_uuid_${i}_${p}_xyz`] = `right_item_uuid_${i}_${p}_987654`;
      }
      ans[qId] = JSON.stringify(pairMap);
      flags.push(qId);
      qs.push({
        id: qId,
        subject: 'Matematika',
        targetClasses: ['7A'],
        questionType: 'matching',
        questionText: `Soal Menjodohkan ${i}`,
        options: [],
        points: 2,
        orderIndex: i,
      });
    }
    const sess = makeSession(4000 + idx, qs, ans);
    sess.flaggedQuestions = flags;
    return sess;
  }

  // Case 3A: 40 PG + new answer + beforeunload immediately followed by pagehide -> deduped to 1 keepalive!
  {
    const sessA = makeSession(401, mcQuestions);
    for (let q = 1; q <= 39; q++) sessA.answers[`q-mtk-${String(q).padStart(3, '0')}`] = 'A';
    sessA.answers['q-mtk-040'] = 'B';
    const r1 = dataStore.flushExamProgressKeepalive(sessA); // beforeunload
    const r2 = dataStore.flushExamProgressKeepalive(sessA); // pagehide (duplicate -> skipped)
    // User cancels leave, changes Q40 -> 'C', then closes tab -> MUST send new keepalive!
    sessA.answers['q-mtk-040'] = 'C';
    const r3 = dataStore.flushExamProgressKeepalive(sessA);
    await new Promise((r) => setTimeout(r, 60));
    const rowA = serverState.results.get(`${sessA.participant.participantNumber}::${baseSchedule.id}`);
    const ok3A =
      r1.usedKeepalive &&
      r2.skippedDuplicate &&
      r3.usedKeepalive &&
      serverState.keepaliveRejectedOverLimit === 0 &&
      rowA?.answers['q-mtk-040'] === 'C';
    console.log(
      `  [3A] 40 PG (beforeunload+pagehide dedup + ubah jawaban): ` +
        `r1=${(r1.byteLength / 1024).toFixed(1)}KiB, r2.dedup=${r2.skippedDuplicate}, r3=${(r3.byteLength / 1024).toFixed(1)}KiB, Q40=${String(rowA?.answers['q-mtk-040'])} [${assertPass(ok3A, 'U3A')}]`
    );
  }

  // Case 3B: Heavy 90 Matching Qs + beforeunload followed IMMEDIATELY by pagehide (was FAIL before!)
  resetServerStats();
  serverState.simulateUnloadAbortNonKeepalive = true;
  {
    const sessB = makeMatchingSession(402, 90);
    const r1 = dataStore.flushExamProgressKeepalive(sessB);
    const r2 = dataStore.flushExamProgressKeepalive(sessB);
    await new Promise((r) => setTimeout(r, 80));
    const rowB = serverState.results.get(`${sessB.participant.participantNumber}::${baseSchedule.id}`);
    const savedB = rowB ? Object.keys(rowB.answers).length : 0;
    const ok3B =
      r1.usedKeepalive &&
      r2.skippedDuplicate &&
      serverState.keepaliveAttempts === 1 &&
      serverState.keepaliveSucceeded === 1 &&
      serverState.keepaliveRejectedOverLimit === 0 &&
      savedB === 90;
    console.log(
      `  [3B] 90 Menjodohkan (beforeunload+pagehide serentak): ` +
        `size=${(r1.byteLength / 1024).toFixed(1)}KiB (compacted=${r1.compacted}), attempts=${serverState.keepaliveAttempts}, rejected64KiB=${serverState.keepaliveRejectedOverLimit}, saved=${savedB}/90 [${assertPass(ok3B, 'U3B')}]`
    );
  }

  // Case 3C: Very Heavy 155 Matching Qs (~69 KiB raw > 64 KiB with double-escaping, compacted < 60 KiB!)
  resetServerStats();
  serverState.simulateUnloadAbortNonKeepalive = true;
  {
    const sessC = makeMatchingSession(403, 155);
    const rawUncompactedBytes = new TextEncoder().encode(
      JSON.stringify({ p_answers: sessC.answers, p_flagged_questions: sessC.flaggedQuestions })
    ).length;
    const r1 = dataStore.flushExamProgressKeepalive(sessC);
    await new Promise((r) => setTimeout(r, 80));
    const rowC = serverState.results.get(`${sessC.participant.participantNumber}::${baseSchedule.id}`);
    const savedC = rowC ? Object.keys(rowC.answers).length : 0;
    const ok3C =
      rawUncompactedBytes > 64 * 1024 &&
      r1.usedKeepalive &&
      r1.byteLength <= 60 * 1024 &&
      serverState.keepaliveSucceeded === 1 &&
      serverState.keepaliveRejectedOverLimit === 0 &&
      savedC === 155;
    console.log(
      `  [3C] 155 Menjodohkan (raw=${(rawUncompactedBytes / 1024).toFixed(1)}KiB > 64KiB -> compacted=${(r1.byteLength / 1024).toFixed(1)}KiB): ` +
        `keepalive=${r1.usedKeepalive}, ok=${serverState.keepaliveSucceeded}, rejected64KiB=${serverState.keepaliveRejectedOverLimit}, saved=${savedC}/155 [${assertPass(ok3C, 'U3C')}]`
    );
  }

  // Case 3D: Pathological 300 Matching Qs (> 95 KiB even compacted) -> must NOT trigger 64 KiB keepalive error & must persist local backup!
  resetServerStats();
  serverState.simulateUnloadAbortNonKeepalive = true;
  {
    const sessD = makeMatchingSession(404, 300);
    const r1 = dataStore.flushExamProgressKeepalive(sessD);
    await new Promise((r) => setTimeout(r, 40));
    const backupExists = Boolean(localStorageShim.getItem('cbt_active_answers_backup_v1')?.includes('question-matching-uuid-0300'));
    const ok3D =
      !r1.usedKeepalive &&
      serverState.keepaliveRejectedOverLimit === 0 &&
      backupExists;
    console.log(
      `  [3D] 300 Menjodohkan ekstrem (${(r1.byteLength / 1024).toFixed(1)}KiB > 60KiB): ` +
        `keepalive=${r1.usedKeepalive}, rejected64KiB=${serverState.keepaliveRejectedOverLimit}, syncBackup=${backupExists} [${assertPass(ok3D, 'U3D')}]\n`
    );
  }

  // ==========================================================================
  // UJI 4: SIMULASI UJIAN MASSAL 500 SISWA SERENTAK (Paced Realistically)
  // ==========================================================================
  console.log('--- [UJI 4] Simulasi Ujian Massal 500 Siswa Serentak (Start -> Autosave -> Last-Second Submit) ---');
  resetServerStats();
  serverState.results.clear();
  serverState.poolCapacity = 80;
  serverState.baseLatencyMs = 8;

  const MASS_COUNT = 500;
  const massStart = performance.now();
  let massSubmittedOk = 0;
  let massLastAnsOk = 0;

  // Spread 500 students proportionally across realistic jitter windows (scaled 10x: 3000ms = 30s real expiry jitter)
  const massTasks = Array.from({ length: MASS_COUNT }, async (_, idx) => {
    const sess = makeSession(5000 + idx, mcQuestions);
    // Staggered login/start (0..3000ms -> 0..30s real)
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 3000)));
    await dataStore.upsertExamProgress(sess, { includeQuestionIds: true });

    // Answer Q1..Q39 + periodic debounced autosave (10-14s real -> 1000-1400ms scaled)
    for (let q = 1; q <= 39; q++) {
      sess.answers[`q-mtk-${String(q).padStart(3, '0')}`] = q % 4 === 0 ? 'B' : 'A';
    }
    await new Promise((r) => setTimeout(r, 1000 + Math.floor(Math.random() * 1400)));
    await dataStore.upsertExamProgress(sess, { includeQuestionIds: false });

    // Last-second answer Q40='A' right before expiry + 2-30s expiryJitter (scaled 10x: 200..3000ms)
    sess.answers['q-mtk-040'] = 'A';
    dataStore.saveActiveSessionLocal(sess);
    await dataStore.saveLocalResultProgressSnapshot(sess);
    await new Promise((r) => setTimeout(r, 200 + Math.floor(Math.random() * 2800)));

    const res = await dataStore.submitFinalExam(sess, { skipInitialJitter: true });
    const row = serverState.results.get(`${sess.participant.participantNumber}::${baseSchedule.id}`);
    if (res.status === 'submitted' && res.syncStatus === 'synced' && row?.status === 'submitted') {
      massSubmittedOk++;
      if (row.answers['q-mtk-040'] === 'A') {
        massLastAnsOk++;
      }
    }
  });
  await Promise.all(massTasks);
  const massElapsedMs = Math.round(performance.now() - massStart);

  console.log(`  Total peserta simulasi massal:      ${MASS_COUNT}`);
  console.log(`  Submitted & synced ke server:       ${massSubmittedOk}/${MASS_COUNT} [${assertPass(massSubmittedOk === MASS_COUNT, 'U4A')}]`);
  console.log(`  Jawaban detik akhir Q40 tercatat:   ${massLastAnsOk}/${MASS_COUNT} [${assertPass(massLastAnsOk === MASS_COUNT, 'U4B')}]`);
  console.log(`  Peak concurrent requests:           ${serverState.peakInFlightRequests} (pool cap=${serverState.poolCapacity}) [${assertPass(serverState.peakInFlightRequests <= serverState.poolCapacity, 'U4C')}]`);
  console.log(`  Server 503 / timeout:               503=${serverState.error503Count}, timeout=${serverState.timeoutCount} [${assertPass(serverState.error503Count === 0 && serverState.timeoutCount === 0, 'U4D')}]`);
  console.log(`  Total waktu simulasi:               ${massElapsedMs} ms`);
  console.log('========================================================================');
  console.log(`HASIL AKHIR SIMULASI: ${allPassed ? 'SEMUA SKENARIO LULUS (100% PASS)' : 'ADA SKENARIO GAGAL'}`);
  console.log('========================================================================');

  if (!allPassed) {
    throw new Error('One or more mass exam simulation assertions failed.');
  }
}

void runSimulations().catch((err) => {
  console.error('Simulation failed:', err);
  (globalThis as { process?: { exitCode?: number } }).process &&
    ((globalThis as { process?: { exitCode?: number } }).process!.exitCode = 1);
});
