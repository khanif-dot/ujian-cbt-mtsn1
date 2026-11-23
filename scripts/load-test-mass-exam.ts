/**
 * Comprehensive Mass Exam Load Testing Suite for Nusantara CBT
 * Tests:
 *   STAGE 1: Website Production Build & HTTP Concurrency Load Test (100 -> 500 -> 1,000 concurrent users)
 *   STAGE 2: Live Supabase Cloud Database Read/RPC Concurrency & Payload Audit (100% non-destructive)
 *   STAGE 3: 1,000-Student Full Mass Exam Lifecycle Stress Test (Start -> Autosave -> 503 Storm -> Submit)
 *   STAGE 4: Heavy Data Volume Benchmark (3,000 exam_results, 1,000 participants, 1,000 questions)
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';

const LIVE_SUPABASE_URL = 'https://mvymlqexsaykuciujdkq.supabase.co';
const LIVE_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im12eW1scWV4c2F5a3VjaXVqZGtxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ3NjU3MTUsImV4cCI6MjExMDM0MTcxNX0.E3J3gT2Q62Q5ESlIojAcUi9Zw7do4WHmai_S3YCckHw';

const realFetch = globalThis.fetch.bind(globalThis);

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarizeLatencies(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    avg: sorted.length ? sum / sorted.length : 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function formatKB(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ============================================================================
// STAGE 1: WEBSITE PRODUCTION BUNDLE & HTTP LOAD TEST
// ============================================================================
async function runStage1WebsiteLoadTest() {
  console.log('\n========================================================================');
  console.log('STAGE 1: UJI BEBAN WEBSITE (BUNDLE AUDIT & HTTP CONCURRENCY 100-1000)');
  console.log('========================================================================');

  const distDir = path.resolve(process.cwd(), 'dist');
  const indexHtmlPath = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexHtmlPath)) {
    throw new Error('Folder dist/ tidak ditemukan. Jalankan "npm run build" terlebih dahulu.');
  }

  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
  const scriptMatches = Array.from(indexHtml.matchAll(/src="(\/assets\/[^"]+\.js)"/g)).map((m) => m[1]);
  const cssMatches = Array.from(indexHtml.matchAll(/href="(\/assets\/[^"]+\.css)"/g)).map((m) => m[1]);
  const preloadMatches = Array.from(indexHtml.matchAll(/rel="modulepreload"[^>]*href="(\/assets\/[^"]+\.js)"/g)).map((m) => m[1]);

  const initialAssets = Array.from(new Set(['/index.html', ...scriptMatches, ...preloadMatches, ...cssMatches]));

  const assetCache = new Map<string, { raw: Buffer; gzip: Buffer; contentType: string }>();
  let totalRawInitial = 0;
  let totalGzipInitial = 0;

  console.log('\n[1A] Audit Ukuran Aset Initial Load Halaman Siswa:');
  for (const relPath of initialAssets) {
    const filePath = path.join(distDir, relPath.replace(/^\//, ''));
    if (!fs.existsSync(filePath)) continue;
    const raw = fs.readFileSync(filePath);
    const gzip = zlib.gzipSync(raw, { level: 6 });
    const contentType = relPath.endsWith('.js')
      ? 'application/javascript; charset=utf-8'
      : relPath.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : 'text/html; charset=utf-8';
    const routeKey = relPath === '/index.html' ? '/' : relPath;
    assetCache.set(routeKey, { raw, gzip, contentType });
    totalRawInitial += raw.length;
    totalGzipInitial += gzip.length;
    console.log(
      `  - ${routeKey.padEnd(42)} raw=${formatKB(raw.length).padStart(10)} | gzip=${formatKB(gzip.length).padStart(9)}`
    );
  }

  console.log(
    `  TOTAL INITIAL LOAD PER SISWA:              raw=${formatKB(totalRawInitial).padStart(10)} | gzip=${formatKB(totalGzipInitial).padStart(9)}`
  );
  const total1000GzipBytes = totalGzipInitial * 1000;
  const wifi50MbpsSec = (total1000GzipBytes * 8) / (50 * 1_000_000);
  const wifi100MbpsSec = (total1000GzipBytes * 8) / (100 * 1_000_000);
  console.log(
    `  Proyeksi Bandwidth 1.000 Siswa Serentak:   ${formatMB(total1000GzipBytes)} (gzip) -> Wi-Fi 50Mbps: ~${wifi50MbpsSec.toFixed(1)}s | Wi-Fi 100Mbps: ~${wifi100MbpsSec.toFixed(1)}s`
  );

  // Start temporary gzip-enabled static server serving dist/ to measure real HTTP throughput
  const server = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    const asset = assetCache.get(urlPath) || assetCache.get('/');
    if (!asset) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const acceptGzip = String(req.headers['accept-encoding'] || '').includes('gzip');
    if (acceptGzip) {
      res.writeHead(200, {
        'Content-Type': asset.contentType,
        'Content-Encoding': 'gzip',
        'Cache-Control': urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        'Content-Length': asset.gzip.length,
      });
      res.end(asset.gzip);
    } else {
      res.writeHead(200, {
        'Content-Type': asset.contentType,
        'Content-Length': asset.raw.length,
      });
      res.end(asset.raw);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 4179;
  const baseUrl = `http://127.0.0.1:${port}`;
  const routesToFetch = Array.from(assetCache.keys());

  console.log(`\n[1B] Uji Beban HTTP Server Produksi (gzip) — Simulasi Muat Penuh (HTML + JS + CSS):`);
  const concurrencyLevels = [100, 500, 1000];
  for (const users of concurrencyLevels) {
    const latencies: number[] = [];
    let okUsers = 0;
    let errUsers = 0;
    let totalBytes = 0;
    const tStart = performance.now();

    await Promise.all(
      Array.from({ length: users }, async () => {
        const uStart = performance.now();
        try {
          const results = await Promise.all(
            routesToFetch.map(async (r) => {
              const resp = await realFetch(`${baseUrl}${r}`, {
                headers: { 'Accept-Encoding': 'gzip' },
              });
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
              const buf = await resp.arrayBuffer();
              return buf.byteLength;
            })
          );
          totalBytes += results.reduce((a, b) => a + b, 0);
          okUsers++;
          latencies.push(performance.now() - uStart);
        } catch {
          errUsers++;
        }
      })
    );
    const elapsedMs = performance.now() - tStart;
    const stats = summarizeLatencies(latencies);
    const rps = ((okUsers * routesToFetch.length) / (elapsedMs / 1000)).toFixed(0);
    console.log(
      `  - ${String(users).padStart(4)} siswa serentak: OK=${okUsers}/${users} err=${errUsers} | total=${elapsedMs.toFixed(0)}ms | req/s=${rps} | p50=${stats.p50.toFixed(0)}ms p95=${stats.p95.toFixed(0)}ms p99=${stats.p99.toFixed(0)}ms max=${stats.max.toFixed(0)}ms | rx=${formatMB(totalBytes)}`
    );
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));

  // Also test live dev server on port 3000 with 100 concurrent HTML requests
  console.log('\n[1C] Cek Kesiapan Live Website Server (http://127.0.0.1:3000/):');
  const devLatencies: number[] = [];
  let devOk = 0;
  let devErr = 0;
  const devStart = performance.now();
  await Promise.all(
    Array.from({ length: 100 }, async () => {
      const t0 = performance.now();
      try {
        const res = await realFetch('http://127.0.0.1:3000/');
        await res.text();
        if (res.ok) {
          devOk++;
          devLatencies.push(performance.now() - t0);
        } else {
          devErr++;
        }
      } catch {
        devErr++;
      }
    })
  );
  const devStats = summarizeLatencies(devLatencies);
  console.log(
    `  - 100 concurrent GET /: OK=${devOk}/100 err=${devErr} | total=${(performance.now() - devStart).toFixed(0)}ms | p50=${devStats.p50.toFixed(1)}ms p95=${devStats.p95.toFixed(1)}ms max=${devStats.max.toFixed(1)}ms`
  );

  return { totalRawInitial, totalGzipInitial };
}

// ============================================================================
// STAGE 2: LIVE SUPABASE CLOUD DATABASE READ/RPC CONCURRENCY & PAYLOAD AUDIT
// ============================================================================
async function runStage2LiveSupabaseAudit() {
  console.log('\n========================================================================');
  console.log('STAGE 2: UJI BEBAN DATABASE CLOUD SUPABASE LIVE (100% READ-ONLY / AMAN)');
  console.log('========================================================================');

  const headers = {
    apikey: LIVE_SUPABASE_ANON_KEY,
    Authorization: `Bearer ${LIVE_SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
  };

  // 2A: Audit ALL schedules & question payloads
  const schedResp = await realFetch(`${LIVE_SUPABASE_URL}/rest/v1/exam_schedules?select=*`, { headers });
  const schedules = (await schedResp.json()) as Array<{
    id: string;
    subject: string;
    is_active: boolean;
    target_classes: string[];
    duration_minutes: number;
  }>;

  const resCountResp = await realFetch(`${LIVE_SUPABASE_URL}/rest/v1/exam_results?select=id&limit=1`, {
    headers: { ...headers, Prefer: 'count=exact' },
  });
  const resultsContentRange = resCountResp.headers.get('content-range') || '-';

  console.log(`\n[2A] Inventaris Data Live Supabase (${LIVE_SUPABASE_URL}):`);
  console.log(`  - Total Jadwal Ujian:        ${schedules.length} (aktif=${schedules.filter((s) => s.is_active).length})`);
  console.log(`  - Total Baris exam_results:  ${resultsContentRange}`);

  // Sample heaviest question sets across schedules (batched 6 at a time)
  const subjectPayloadReport: Array<{
    subject: string;
    className: string;
    count: number;
    bytes: number;
    base64Count: number;
    storageUrlCount: number;
    ms: number;
  }> = [];

  const uniqueChecks = new Map<string, { subject: string; className: string }>();
  for (const s of schedules) {
    const cls = s.target_classes?.[0] || '7A';
    const key = `${cls}::${s.subject}`;
    if (!uniqueChecks.has(key)) uniqueChecks.set(key, { subject: s.subject, className: cls });
  }
  const checkList = Array.from(uniqueChecks.values());
  for (let i = 0; i < checkList.length; i += 6) {
    const batch = checkList.slice(i, i + 6);
    const batchRes = await Promise.all(
      batch.map(async ({ subject, className }) => {
        const t0 = performance.now();
        const r = await realFetch(`${LIVE_SUPABASE_URL}/rest/v1/rpc/get_student_questions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ p_class_name: className, p_subject: subject }),
        });
        const text = await r.text();
        const ms = performance.now() - t0;
        if (!r.ok) return { subject, className, count: 0, bytes: 0, base64Count: 0, storageUrlCount: 0, ms };
        const qs = JSON.parse(text) as Array<Record<string, unknown>>;
        let base64Count = 0;
        let storageUrlCount = 0;
        for (const q of qs) {
          const str = JSON.stringify(q);
          const b64Matches = str.match(/data:image\//g);
          if (b64Matches) base64Count += b64Matches.length;
          const cdnMatches = str.match(/\/storage\/v1\/object\/public\//g);
          if (cdnMatches) storageUrlCount += cdnMatches.length;
        }
        return {
          subject,
          className,
          count: qs.length,
          bytes: Buffer.byteLength(text),
          base64Count,
          storageUrlCount,
          ms,
        };
      })
    );
    subjectPayloadReport.push(...batchRes);
  }

  subjectPayloadReport.sort((a, b) => b.bytes - a.bytes);
  const totalBase64Inline = subjectPayloadReport.reduce((acc, s) => acc + s.base64Count, 0);
  const totalStorageUrls = subjectPayloadReport.reduce((acc, s) => acc + s.storageUrlCount, 0);
  console.log(`  - Total Gambar Base64 Inline di Soal: ${totalBase64Inline} | Gambar via Storage CDN: ${totalStorageUrls}`);
  console.log(`  - Top 8 Paket Soal Terberat (RPC get_student_questions):`);
  for (const item of subjectPayloadReport.slice(0, 8)) {
    const projected1000 = formatMB(item.bytes * 1000);
    console.log(
      `    * ${item.subject.padEnd(26)} (${item.className}) | ${String(item.count).padStart(2)} soal | ${formatKB(item.bytes).padStart(9)} | base64=${item.base64Count} | ${item.ms.toFixed(0)}ms | 1000 siswa=${projected1000}`
    );
  }

  // 2B: Progressive Live Read/RPC Concurrency Stress Test (Non-Destructive)
  console.log('\n[2B] Uji Konkurensi Live Supabase PostgREST/RPC (Non-Destruktif):');
  const heaviestSubject = subjectPayloadReport[0] || { subject: 'IPS 9', className: '9A', bytes: 0 };

  async function runLiveWave(
    label: string,
    concurrency: number,
    makeReq: (i: number) => Promise<Response>
  ) {
    const latencies: number[] = [];
    const statusCounts = new Map<string, number>();
    let totalBytes = 0;
    const tStart = performance.now();

    await Promise.all(
      Array.from({ length: concurrency }, async (_, i) => {
        const t0 = performance.now();
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 15_000);
          const resp = await makeReq(i);
          clearTimeout(timer);
          const buf = await resp.arrayBuffer();
          totalBytes += buf.byteLength;
          const code = String(resp.status);
          statusCounts.set(code, (statusCounts.get(code) || 0) + 1);
          if (resp.ok) latencies.push(performance.now() - t0);
        } catch (err) {
          const code = err instanceof Error && err.name === 'AbortError' ? 'TIMEOUT' : 'NET_ERR';
          statusCounts.set(code, (statusCounts.get(code) || 0) + 1);
        }
      })
    );

    const elapsedMs = performance.now() - tStart;
    const stats = summarizeLatencies(latencies);
    const okCount = (statusCounts.get('200') || 0) + (statusCounts.get('206') || 0);
    const statusSummary = Array.from(statusCounts.entries())
      .map(([k, v]) => `${k}:${v}`)
      .join(', ');
    const rps = (okCount / (elapsedMs / 1000)).toFixed(1);
    console.log(
      `  - ${label.padEnd(40)} conc=${String(concurrency).padStart(3)} | OK=${okCount}/${concurrency} [${statusSummary}] | ${elapsedMs.toFixed(0)}ms (${rps} req/s) | p50=${stats.p50.toFixed(0)}ms p95=${stats.p95.toFixed(0)}ms max=${stats.max.toFixed(0)}ms | rx=${formatMB(totalBytes)}`
    );
    return { okCount, concurrency, statusCounts, stats, elapsedMs };
  }

  // Test lightweight RPC (get_server_time) across 20 -> 50 -> 100 -> 200 concurrent
  for (const conc of [20, 50, 100, 200]) {
    await runLiveWave('RPC get_server_time', conc, () =>
      realFetch(`${LIVE_SUPABASE_URL}/rest/v1/rpc/get_server_time`, {
        method: 'POST',
        headers,
        body: '{}',
      })
    );
  }

  // Test realistic mixed student login burst (school_profile metadata + exam_schedules + get_student_questions)
  for (const conc of [25, 50, 100]) {
    await runLiveWave(`RPC get_student_questions (${heaviestSubject.subject.slice(0, 12)})`, conc, () =>
      realFetch(`${LIVE_SUPABASE_URL}/rest/v1/rpc/get_student_questions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          p_class_name: heaviestSubject.className,
          p_subject: heaviestSubject.subject,
        }),
      })
    );
  }

  // Test filtered exam_results lookup (simulating checkStudentExamLock across 100 concurrent students)
  await runLiveWave('GET exam_results (indexed lock check)', 100, (i) =>
    realFetch(
      `${LIVE_SUPABASE_URL}/rest/v1/exam_results?select=id,status,submitted_at,started_at&participant_number=eq.SIM-LOAD-${String(i).padStart(4, '0')}&limit=5`,
      { headers }
    )
  );

  // Test Admin pagination fetch of all 565 exam_results (simulating Admin Console initial sync)
  await runLiveWave('GET exam_results (Admin full sync 565)', 3, () =>
    realFetch(
      `${LIVE_SUPABASE_URL}/rest/v1/exam_results?select=id,participant_id,participant_number,student_name,class_name,exam_id,exam_title,subject,answers,flagged_questions,question_ids,correct_count,total_questions,score,tab_switch_count,status,started_at,submitted_at,updated_at&order=id.asc&limit=1000`,
      { headers }
    )
  );
}

// ============================================================================
// STAGE 3 & 4: 1,000-STUDENT FULL MASS EXAM STRESS TEST + 3,000-ROW HEAVY VOLUME
// ============================================================================
async function runStage3And4MassExamAndHeavyVolume() {
  console.log('\n========================================================================');
  console.log('STAGE 3: SIMULASI BEBAN PENUH 1.000 SISWA SERENTAK (WRITE + 503 STORM)');
  console.log('========================================================================');

  // Setup isolated browser shims for real dataStore.ts execution
  class MemoryStorage implements Storage {
    private map = new Map<string, string>();
    get length() { return this.map.size; }
    clear() { this.map.clear(); }
    getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
    key(i: number) { return Array.from(this.map.keys())[i] ?? null; }
    removeItem(k: string) { this.map.delete(k); }
    setItem(k: string, v: string) { this.map.set(k, String(v)); }
  }

  class MemoryIDBStore {
    data = new Map<string, unknown>();
    keyPath: string;
    constructor(keyPath: string) { this.keyPath = keyPath; }
    createIndex() {}
    put(value: Record<string, unknown>) {
      const key = String(value[this.keyPath]);
      this.data.set(key, structuredClone(value));
      const req: Record<string, unknown> = { result: key, onsuccess: null, onerror: null };
      queueMicrotask(() => { if (typeof req.onsuccess === 'function') (req.onsuccess as () => void)(); });
      return req;
    }
    get(key: string) {
      const val = this.data.has(key) ? structuredClone(this.data.get(key)) : undefined;
      const req: Record<string, unknown> = { result: val, onsuccess: null, onerror: null };
      queueMicrotask(() => { if (typeof req.onsuccess === 'function') (req.onsuccess as () => void)(); });
      return req;
    }
    getAll() {
      const vals = Array.from(this.data.values()).map((v) => structuredClone(v));
      const req: Record<string, unknown> = { result: vals, onsuccess: null, onerror: null };
      queueMicrotask(() => { if (typeof req.onsuccess === 'function') (req.onsuccess as () => void)(); });
      return req;
    }
    delete(key: string) {
      this.data.delete(key);
      const req: Record<string, unknown> = { result: undefined, onsuccess: null, onerror: null };
      queueMicrotask(() => { if (typeof req.onsuccess === 'function') (req.onsuccess as () => void)(); });
      return req;
    }
    clear() {
      this.data.clear();
      const req: Record<string, unknown> = { result: undefined, onsuccess: null, onerror: null };
      queueMicrotask(() => { if (typeof req.onsuccess === 'function') (req.onsuccess as () => void)(); });
      return req;
    }
  }

  class MemoryIDBDatabase {
    stores = new Map<string, MemoryIDBStore>();
    onversionchange: (() => void) | null = null;
    onclose: (() => void) | null = null;
    objectStoreNames = { contains: (name: string) => this.stores.has(name) };
    createObjectStore(name: string, opts: { keyPath: string }) {
      const store = new MemoryIDBStore(opts.keyPath);
      this.stores.set(name, store);
      return store;
    }
    transaction(storeName: string) {
      const store = this.stores.get(storeName);
      if (!store) throw new Error(`Missing store ${storeName}`);
      const tx: Record<string, unknown> = { oncomplete: null, onerror: null, objectStore: () => store };
      Promise.resolve().then(() => Promise.resolve()).then(() => {
        if (typeof tx.oncomplete === 'function') (tx.oncomplete as () => void)();
      });
      return tx;
    }
    close() {}
  }

  const sharedDb = new MemoryIDBDatabase();
  let dbInit = false;
  const localStorageShim = new MemoryStorage();
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    localStorage: localStorageShim,
  };
  g.localStorage = localStorageShim;
  g.document = { hidden: false };
  g.indexedDB = {
    open() {
      const req: Record<string, unknown> = { result: sharedDb, onupgradeneeded: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        if (!dbInit) {
          dbInit = true;
          if (typeof req.onupgradeneeded === 'function') (req.onupgradeneeded as () => void)();
        }
        if (typeof req.onsuccess === 'function') (req.onsuccess as () => void)();
      });
      return req;
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: true },
    configurable: true,
  });

  // Simulated PostgreSQL / Supabase Pool enforcing strict 60-connection pool limit + realistic latency + 5% transient 503 fault injection
  const simServer = {
    poolCap: 60,
    inFlight: 0,
    peakInFlight: 0,
    totalReq: 0,
    okReq: 0,
    err503Pool: 0,
    err503Injected: 0,
    bytesReceived: 0,
    bytesSent: 0,
    injectTransientFaultRate: 0.05,
    baseLatencyMs: 10,
    latencies: [] as number[],
    results: new Map<string, Record<string, unknown>>(),
    questions: new Map<string, { id: string; correct_answer: string; points: number; q_type: string }>(),
  };

  g.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const bodyStr = typeof init?.body === 'string' ? init.body : '';
    const reqBytes = Buffer.byteLength(bodyStr);
    simServer.bytesReceived += reqBytes;
    simServer.totalReq++;
    simServer.inFlight++;
    if (simServer.inFlight > simServer.peakInFlight) simServer.peakInFlight = simServer.inFlight;
    const t0 = performance.now();

    try {
      if (simServer.inFlight > simServer.poolCap) {
        simServer.err503Pool++;
        await new Promise((r) => setTimeout(r, 15));
        return new Response(JSON.stringify({ message: '503 Service Unavailable: Connection pool exhausted' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (simServer.injectTransientFaultRate > 0 && Math.random() < simServer.injectTransientFaultRate) {
        simServer.err503Injected++;
        await new Promise((r) => setTimeout(r, 15));
        return new Response(JSON.stringify({ message: '503 Service Unavailable: Transient overload' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const delay = simServer.baseLatencyMs + Math.floor(simServer.inFlight * 0.9);
      await new Promise((r) => setTimeout(r, delay));

      const parsedUrl = new URL(urlStr);
      const p = parsedUrl.pathname;
      const args = bodyStr ? (JSON.parse(bodyStr) as Record<string, unknown>) : {};

      if (p.includes('/rest/v1/rpc/get_server_time')) {
        const respBody = JSON.stringify(new Date().toISOString());
        simServer.bytesSent += Buffer.byteLength(respBody);
        simServer.okReq++;
        simServer.latencies.push(performance.now() - t0);
        return new Response(respBody, { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (p.includes('/rest/v1/rpc/upsert_exam_progress')) {
        const pNum = String(args.p_participant_number || '').trim().toUpperCase();
        const examId = String(args.p_exam_id || '');
        const key = `${pNum}::${examId}`;
        const existing = simServer.results.get(key);
        if (existing && (existing.status !== 'in_progress' || existing.submitted_at !== null)) {
          const respBody = JSON.stringify([{ applied: false, current_status: existing.status, submitted_at: existing.submitted_at }]);
          simServer.bytesSent += Buffer.byteLength(respBody);
          simServer.okReq++;
          simServer.latencies.push(performance.now() - t0);
          return new Response(respBody, { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        simServer.results.set(key, {
          id: existing?.id || args.p_result_id,
          participant_id: args.p_participant_id,
          participant_number: pNum,
          student_name: args.p_student_name,
          class_name: args.p_class_name,
          exam_id: examId,
          exam_title: args.p_exam_title,
          subject: args.p_subject,
          answers: args.p_answers || {},
          flagged_questions: args.p_flagged_questions || [],
          question_ids: existing?.question_ids || args.p_question_ids || null,
          correct_count: 0,
          total_questions: args.p_total_questions || 40,
          score: 0,
          tab_switch_count: Math.max(Number(existing?.tab_switch_count || 0), Number(args.p_tab_switch_count || 0)),
          status: 'in_progress',
          started_at: existing?.started_at || args.p_started_at || new Date().toISOString(),
          submitted_at: null,
          updated_at: new Date().toISOString(),
        });
        const respBody = JSON.stringify([{ applied: true, current_status: 'in_progress', submitted_at: null }]);
        simServer.bytesSent += Buffer.byteLength(respBody);
        simServer.okReq++;
        simServer.latencies.push(performance.now() - t0);
        return new Response(respBody, { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (p.includes('/rest/v1/rpc/submit_exam_and_score')) {
        const pNum = String(args.p_participant_number || '').trim().toUpperCase();
        const examId = String(args.p_exam_id || '');
        const key = `${pNum}::${examId}`;
        const existing = simServer.results.get(key);
        if (existing && (existing.status !== 'in_progress' || existing.submitted_at !== null)) {
          const respBody = JSON.stringify([{
            correct_count: existing.correct_count,
            total_questions: existing.total_questions,
            score: existing.score,
          }]);
          simServer.bytesSent += Buffer.byteLength(respBody);
          simServer.okReq++;
          simServer.latencies.push(performance.now() - t0);
          return new Response(respBody, { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        const ans = (args.p_answers as Record<string, unknown>) || {};
        let correct = 0;
        let totalQ = 0;
        for (const q of simServer.questions.values()) {
          totalQ++;
          if (ans[q.id] === q.correct_answer) correct++;
        }
        const score = totalQ > 0 ? Math.round((correct / totalQ) * 10000) / 100 : 0;
        simServer.results.set(key, {
          id: existing?.id || args.p_result_id,
          participant_id: args.p_participant_id,
          participant_number: pNum,
          student_name: args.p_student_name,
          class_name: args.p_class_name,
          exam_id: examId,
          exam_title: args.p_exam_title,
          subject: args.p_subject,
          answers: ans,
          flagged_questions: args.p_flagged_questions || [],
          question_ids: existing?.question_ids || args.p_question_ids || null,
          correct_count: correct,
          total_questions: totalQ,
          score,
          tab_switch_count: Number(args.p_tab_switch_count || 0),
          status: 'submitted',
          started_at: existing?.started_at || args.p_started_at || new Date().toISOString(),
          submitted_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        const respBody = JSON.stringify([{ correct_count: correct, total_questions: totalQ, score }]);
        simServer.bytesSent += Buffer.byteLength(respBody);
        simServer.okReq++;
        simServer.latencies.push(performance.now() - t0);
        return new Response(respBody, { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      simServer.okReq++;
      simServer.latencies.push(performance.now() - t0);
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    } finally {
      simServer.inFlight--;
    }
  };

  const dataStore = await import('../src/lib/dataStore.ts');
  const { saveSupabaseConfig } = await import('../src/lib/supabase.ts');
  const { ALL_CLASSES } = await import('../src/types/cbt.ts');
  type ActiveExamSession = import('../src/types/cbt.ts').ActiveExamSession;
  type ExamSchedule = import('../src/types/cbt.ts').ExamSchedule;
  type StudentQuestion = import('../src/types/cbt.ts').StudentQuestion;
  type Participant = import('../src/types/cbt.ts').Participant;
  type ExamResult = import('../src/types/cbt.ts').ExamResult;

  saveSupabaseConfig(
    'https://loadtest-local.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsInJlZiI6ImxvYWR0ZXN0In0.sim'
  );
  await dataStore.ensureInitialized();

  const schedule: ExamSchedule = {
    id: 'sched-mass-1000',
    title: 'Ujian Massal 1.000 Peserta',
    subject: 'Matematika',
    kkm: 75,
    durationMinutes: 60,
    targetClasses: [...ALL_CLASSES],
    isActive: true,
    randomizeQuestions: true,
    maxTabSwitches: 3,
    createdAt: new Date().toISOString(),
  };
  await dataStore.upsertExamSchedule(schedule);

  const mcQuestions: StudentQuestion[] = [];
  for (let i = 1; i <= 40; i++) {
    const id = `q-load-${String(i).padStart(3, '0')}`;
    simServer.questions.set(id, { id, correct_answer: 'A', points: 1, q_type: 'multiple_choice' });
    mcQuestions.push({
      id,
      subject: 'Matematika',
      targetClasses: [...ALL_CLASSES],
      questionType: 'multiple_choice',
      questionText: `Soal Matematika Uji Beban #${i}: Hitung nilai $\\frac{${i}x + 4}{2}$`,
      options: [
        { key: 'A', text: 'Jawaban A' },
        { key: 'B', text: 'Jawaban B' },
        { key: 'C', text: 'Jawaban C' },
        { key: 'D', text: 'Jawaban D' },
      ],
      points: 1,
      orderIndex: i,
    });
  }

  const STUDENT_COUNT = 1000;
  const tMass0 = performance.now();
  let submittedSynced = 0;
  let submittedPending = 0;
  let lastAnswerPreserved = 0;

  // Scaled 10x time compression (60s start wave -> 6000ms, 30s expiry jitter -> 3000ms)
  await Promise.all(
    Array.from({ length: STUDENT_COUNT }, async (_, idx) => {
      const cls = ALL_CLASSES[idx % ALL_CLASSES.length];
      const pNum = `MASS-${String(idx + 1).padStart(4, '0')}`;
      const now = Date.now();
      const sess: ActiveExamSession = {
        resultId: `res-${pNum}-${schedule.id}`,
        participant: {
          id: `part-${idx + 1}`,
          participantNumber: pNum,
          token: 'CBT2026',
          fullName: `Peserta Ujian Massal ${idx + 1}`,
          className: cls,
          isActive: true,
          createdAt: new Date(now).toISOString(),
        },
        schedule,
        questions: mcQuestions,
        answers: {},
        flaggedQuestions: [],
        currentIndex: 0,
        tabSwitchCount: 0,
        startedAt: new Date(now - 59 * 60 * 1000).toISOString(),
        endsAt: new Date(now + 60 * 1000).toISOString(),
      };

      // Wave A: Start wave (0..60s real -> 0..6000ms)
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 6000)));
      await dataStore.upsertExamProgress(sess, { includeQuestionIds: true });

      // Wave B: 2 autosave checkpoints (debounced)
      for (let q = 1; q <= 20; q++) sess.answers[`q-load-${String(q).padStart(3, '0')}`] = 'A';
      await new Promise((r) => setTimeout(r, 800 + Math.floor(Math.random() * 1400)));
      await dataStore.upsertExamProgress(sess, { includeQuestionIds: false });

      for (let q = 21; q <= 39; q++) sess.answers[`q-load-${String(q).padStart(3, '0')}`] = q % 5 === 0 ? 'B' : 'A';
      await new Promise((r) => setTimeout(r, 800 + Math.floor(Math.random() * 1400)));
      await dataStore.upsertExamProgress(sess, { includeQuestionIds: false });

      // Wave C: Simultaneous expiry + last-second answer Q40 + 2-30s jitter (200..3000ms)
      sess.answers['q-load-040'] = 'A';
      await dataStore.saveLocalResultProgressSnapshot(sess);
      await new Promise((r) => setTimeout(r, 200 + Math.floor(Math.random() * 2800)));

      const finalRes = await dataStore.submitFinalExam(sess, { skipInitialJitter: true });
      if (finalRes.syncStatus === 'synced') submittedSynced++;
      else submittedPending++;
      const row = simServer.results.get(`${pNum}::${schedule.id}`);
      if (row && (row.answers as Record<string, string>)['q-load-040'] === 'A') {
        lastAnswerPreserved++;
      }
    })
  );

  // Flush any pending queue items left over from injected 503 storms
  simServer.injectTransientFaultRate = 0;
  const flushedAfterStorm = await dataStore.flushPendingSyncQueue();
  let serverSubmittedFinal = 0;
  let serverQ40Final = 0;
  for (const row of simServer.results.values()) {
    if (row.status === 'submitted') serverSubmittedFinal++;
    if ((row.answers as Record<string, string>)['q-load-040'] === 'A') serverQ40Final++;
  }

  const massElapsed = performance.now() - tMass0;
  const rpcStats = summarizeLatencies(simServer.latencies);

  console.log(`  - Total Peserta Simulasi:            ${STUDENT_COUNT} siswa (27 kelas: 7A-9I)`);
  console.log(`  - Total Request RPC (Start+Save+Sub):${simServer.totalReq} (OK=${simServer.okReq}, 503-Injected=${simServer.err503Injected}, 503-Pool=${simServer.err503Pool})`);
  console.log(`  - Peak Concurrent DB Connections:    ${simServer.peakInFlight} / ${simServer.poolCap} pool cap`);
  console.log(`  - RPC Latency (simulasi pool 60):    p50=${rpcStats.p50.toFixed(1)}ms | p95=${rpcStats.p95.toFixed(1)}ms | p99=${rpcStats.p99.toFixed(1)}ms | max=${rpcStats.max.toFixed(1)}ms`);
  console.log(`  - Submitted langsung saat badai 503: ${submittedSynced}/${STUDENT_COUNT} (pending lokal=${submittedPending}, flushed ulang=${flushedAfterStorm})`);
  console.log(`  - Total Terkonfirmasi di DB Akhir:   ${serverSubmittedFinal}/${STUDENT_COUNT} (100% tanpa kehilangan data: ${serverSubmittedFinal === STUDENT_COUNT ? 'PASS' : 'FAIL'})`);
  console.log(`  - Jawaban Detik Akhir Q40 Terjaga:   ${serverQ40Final}/${STUDENT_COUNT} (${serverQ40Final === STUDENT_COUNT ? 'PASS' : 'FAIL'})`);
  console.log(`  - Total Payload Write (1.000 siswa): Upload=${formatMB(simServer.bytesReceived)} | Download=${formatMB(simServer.bytesSent)} (rata-rata ${(simServer.bytesReceived / STUDENT_COUNT / 1024).toFixed(2)} KB/siswa)`);
  console.log(`  - Durasi Total Simulasi (10x scale): ${(massElapsed / 1000).toFixed(2)}s`);

  // ==========================================================================
  // STAGE 4: HEAVY DATA VOLUME BENCHMARK (3,000 RESULTS + 1,000 PARTICIPANTS)
  // ==========================================================================
  console.log('\n========================================================================');
  console.log('STAGE 4: BENCHMARK VOLUME DATA BESAR (1.000 PESERTA & 3.000 HASIL UJIAN)');
  console.log('========================================================================');

  const memBefore = process.memoryUsage().heapUsed;

  // Generate 1,000 participants across 27 classes
  const tPart0 = performance.now();
  const participants: Participant[] = Array.from({ length: 1000 }, (_, i) => ({
    id: `vol-part-${i + 1}`,
    participantNumber: `2026-${String(i + 1).padStart(4, '0')}`,
    token: 'CBT2026',
    fullName: `Siswa Volume Test ${i + 1}`,
    className: ALL_CLASSES[i % ALL_CLASSES.length],
    isActive: true,
    createdAt: new Date().toISOString(),
  }));
  const partStore = sharedDb.stores.get('participants')!;
  partStore.clear();
  for (const p of participants) partStore.data.set(p.id, p);
  const tGetParts0 = performance.now();
  const loadedParts = await dataStore.getParticipants();
  const tGetPartsMs = performance.now() - tGetParts0;

  // Generate 3,000 exam results (1,000 students x 3 subjects, 40 answers each)
  const subjects = ['Matematika', 'IPA', 'Bahasa Indonesia'];
  const resStore = sharedDb.stores.get('exam_results')!;
  resStore.clear();
  const sampleAnswers: Record<string, string> = {};
  for (let q = 1; q <= 40; q++) sampleAnswers[`q-load-${String(q).padStart(3, '0')}`] = q % 4 === 0 ? 'B' : 'A';
  const sampleQIds = Object.keys(sampleAnswers);

  const syntheticResults: ExamResult[] = [];
  for (let sIdx = 0; sIdx < subjects.length; sIdx++) {
    for (let i = 0; i < 1000; i++) {
      const p = participants[i];
      const rec: ExamResult = {
        id: `res-vol-${sIdx}-${i}`,
        participantId: p.id,
        participantNumber: p.participantNumber,
        studentName: p.fullName,
        className: p.className,
        examId: `sched-vol-${sIdx}`,
        examTitle: `Ujian ${subjects[sIdx]}`,
        subject: subjects[sIdx],
        answers: { ...sampleAnswers },
        flaggedQuestions: [],
        questionIds: sampleQIds,
        correctCount: 30 + (i % 11),
        totalQuestions: 40,
        score: 75 + ((i % 11) * 2.5),
        tabSwitchCount: i % 15 === 0 ? 1 : 0,
        status: 'submitted',
        startedAt: new Date(Date.now() - 3600_000).toISOString(),
        submittedAt: new Date().toISOString(),
        syncStatus: 'synced',
      };
      syntheticResults.push(rec);
      resStore.data.set(rec.id, rec);
    }
  }

  // Force cold read of 3,000 exam_results
  await dataStore.forceDeleteExamResultForReset('NON_EXISTENT', 'NON_EXISTENT');
  const tColdRes0 = performance.now();
  const coldResults = await dataStore.getExamResults();
  const tColdResMs = performance.now() - tColdRes0;

  const tWarmRes0 = performance.now();
  const warmResults = await dataStore.getExamResults();
  const tWarmResMs = performance.now() - tWarmRes0;

  // Simulate Admin Recap aggregation (per-class stats, KKM pass rate, sorting 3,000 rows)
  const tRecap0 = performance.now();
  const byClass = new Map<string, { total: number; passed: number; sumScore: number }>();
  for (const r of warmResults) {
    const entry = byClass.get(r.className) || { total: 0, passed: 0, sumScore: 0 };
    entry.total++;
    if (r.score >= 75) entry.passed++;
    entry.sumScore += r.score;
    byClass.set(r.className, entry);
  }
  const ranked = [...warmResults].sort((a, b) => b.score - a.score || a.studentName.localeCompare(b.studentName));
  const tRecapMs = performance.now() - tRecap0;

  // Estimate JSON payload size of 3,000 exam_results if Admin pulls all at once
  const json3000Bytes = Buffer.byteLength(JSON.stringify(syntheticResults));
  const json3000GzipBytes = zlib.gzipSync(JSON.stringify(syntheticResults)).length;

  const memAfter = process.memoryUsage().heapUsed;

  console.log(`  - Peserta Dimuat (${loadedParts.length} baris):          ${tGetPartsMs.toFixed(1)} ms (gen=${(performance.now() - tPart0).toFixed(0)} ms)`);
  console.log(`  - exam_results Cold Read (${coldResults.length} baris):   ${tColdResMs.toFixed(1)} ms`);
  console.log(`  - exam_results Cached Read (${warmResults.length} baris): ${tWarmResMs.toFixed(3)} ms`);
  console.log(`  - Agregasi Rekap 27 Kelas + Sort 3.000: ${tRecapMs.toFixed(1)} ms (top score=${ranked[0]?.score})`);
  console.log(`  - Ukuran Payload 3.000 Hasil Ujian:     raw=${formatMB(json3000Bytes)} | gzip=${formatKB(json3000GzipBytes)}`);
  console.log(`  - Delta Memori Heap JS (3.000 baris):   ${formatMB(Math.max(0, memAfter - memBefore))}`);
}

async function main() {
  const tAll0 = performance.now();
  await runStage1WebsiteLoadTest();
  await runStage2LiveSupabaseAudit();
  await runStage3And4MassExamAndHeavyVolume();
  console.log(`\nSelesai seluruh rangkaian uji beban dalam ${((performance.now() - tAll0) / 1000).toFixed(2)} detik.\n`);
}

main().catch((err) => {
  console.error('Load test error:', err);
  process.exitCode = 1;
});
