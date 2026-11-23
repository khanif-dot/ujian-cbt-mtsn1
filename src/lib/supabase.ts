import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Konfigurasi Supabase tertanam permanen (hardcoded/default)
 * agar seluruh perangkat client langsung terhubung otomatis tanpa konfigurasi manual.
 * Ganti nilai default ini dengan Project URL & Anon Key Supabase sekolah Anda saat produksi.
 */
export const DEFAULT_SUPABASE_URL = 'https://mvymlqexsaykuciujdkq.supabase.co';
export const DEFAULT_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im12eW1scWV4c2F5a3VjaXVqZGtxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ3NjU3MTUsImV4cCI6MjExMDM0MTcxNX0.E3J3gT2Q62Q5ESlIojAcUi9Zw7do4WHmai_S3YCckHw';

const RUNTIME_CONFIG_KEY = 'cbt_supabase_runtime_config_v1';

export interface SupabaseRuntimeConfig {
  url: string;
  anonKey: string;
  serviceRoleKey?: string;
  schema?: string;
  autoSyncIntervalSec?: number;
  enableRealtime?: boolean;
}

export type SupabaseConfigSource = 'runtime' | 'env' | 'default';

export interface DecodedJwtInfo {
  valid: boolean;
  role?: string;
  ref?: string;
  expIso?: string;
  expired?: boolean;
}

export function extractProjectRef(url: string): string {
  try {
    const parsed = new URL(url.trim());
    const host = parsed.hostname;
    if (host.endsWith('.supabase.co')) {
      return host.replace('.supabase.co', '');
    }
    return host.split('.')[0] || '';
  } catch {
    return '';
  }
}

export function decodeJwtPayload(token: string): DecodedJwtInfo {
  const trimmed = token.trim();
  if (!trimmed) return { valid: false };
  const parts = trimmed.split('.');
  if (parts.length !== 3) {
    // Supabase newer keys can also be sb_publishable_... / sb_secret_...
    if (trimmed.startsWith('sb_publishable_')) {
      return { valid: true, role: 'anon (publishable)' };
    }
    if (trimmed.startsWith('sb_secret_')) {
      return { valid: true, role: 'service_role (secret)' };
    }
    return { valid: false };
  }
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const json = atob(padded);
    const payload = JSON.parse(json) as {
      role?: string;
      ref?: string;
      exp?: number;
      iss?: string;
    };
    const expIso = payload.exp ? new Date(payload.exp * 1000).toISOString() : undefined;
    const expired = payload.exp ? payload.exp * 1000 < Date.now() : false;
    return {
      valid: true,
      role: payload.role,
      ref: payload.ref,
      expIso,
      expired,
    };
  } catch {
    return { valid: false };
  }
}

export interface ServiceRoleKeyValidation {
  hasKey: boolean;
  valid: boolean;
  role?: string;
  ref?: string;
  isSecretFormat?: boolean;
  reason?: string;
}

export function sanitizeApiKeyInput(raw: string): string {
  return raw.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
}

export function validateServiceRoleKey(
  rawKey: string | undefined,
  projectUrl?: string
): ServiceRoleKeyValidation {
  const key = sanitizeApiKeyInput(rawKey || '');
  if (!key) {
    return { hasKey: false, valid: false };
  }

  const info = decodeJwtPayload(key);
  if (!info.valid) {
    return {
      hasKey: true,
      valid: false,
      reason:
        'Format Service Role Key tidak valid. Gunakan token JWT role "service_role" (diawali eyJ...) dari Supabase Project Settings → API Keys.',
    };
  }

  const roleLower = (info.role || '').toLowerCase();
  if (
    roleLower === 'anon' ||
    roleLower === 'anon (publishable)' ||
    roleLower === 'authenticated'
  ) {
    return {
      hasKey: true,
      valid: false,
      role: info.role,
      ref: info.ref,
      reason: `Key yang dimasukkan ber-role "${info.role}", BUKAN "service_role". Pastikan Anda menyalin "service_role" secret key (bukan anon public key).`,
    };
  }

  if (info.expired) {
    return {
      hasKey: true,
      valid: false,
      role: info.role,
      ref: info.ref,
      reason: 'Service Role Key sudah kedaluwarsa (expired). Buat atau salin key yang masih aktif di dashboard Supabase.',
    };
  }

  const urlRef = projectUrl ? extractProjectRef(projectUrl) : '';
  if (urlRef && info.ref && info.ref !== urlRef) {
    return {
      hasKey: true,
      valid: false,
      role: info.role,
      ref: info.ref,
      reason: `Project Ref pada Service Role Key (${info.ref}) tidak cocok dengan Project URL (${urlRef}).`,
    };
  }

  if (
    roleLower &&
    roleLower !== 'service_role' &&
    roleLower !== 'service_role (secret)'
  ) {
    return {
      hasKey: true,
      valid: false,
      role: info.role,
      ref: info.ref,
      reason: `Role token "${info.role}" bukan "service_role".`,
    };
  }

  return {
    hasKey: true,
    valid: true,
    role: info.role || 'service_role',
    ref: info.ref,
    isSecretFormat: key.startsWith('sb_secret_'),
  };
}

export function getSupabaseConfigSource(): SupabaseConfigSource {
  try {
    const raw = localStorage.getItem(RUNTIME_CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SupabaseRuntimeConfig>;
      if (parsed.url && parsed.anonKey) {
        return 'runtime';
      }
    }
  } catch {
    // Ignore localStorage parse errors
  }
  const metaEnv = (import.meta as { env?: Record<string, string | undefined> }).env;
  const envUrl = metaEnv?.VITE_SUPABASE_URL;
  const envKey = metaEnv?.VITE_SUPABASE_ANON_KEY;
  if (envUrl?.trim() && envKey?.trim()) {
    return 'env';
  }
  return 'default';
}

let runtimeServiceRoleKey = '';

export function clearRuntimeServiceRoleKey(): void {
  runtimeServiceRoleKey = '';
  cachedAdminClient = null;
}

export function getSupabaseConfig(): SupabaseRuntimeConfig {
  const metaEnv = (import.meta as { env?: Record<string, string | undefined> }).env;
  const envUrl = metaEnv?.VITE_SUPABASE_URL;
  const envKey = metaEnv?.VITE_SUPABASE_ANON_KEY;

  try {
    const raw = localStorage.getItem(RUNTIME_CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SupabaseRuntimeConfig>;
      if (parsed.url && parsed.anonKey) {
        return {
          url: sanitizeApiKeyInput(parsed.url),
          anonKey: sanitizeApiKeyInput(parsed.anonKey),
          serviceRoleKey: runtimeServiceRoleKey,
          schema: parsed.schema?.trim() || 'public',
          autoSyncIntervalSec:
            typeof parsed.autoSyncIntervalSec === 'number' && parsed.autoSyncIntervalSec >= 5
              ? parsed.autoSyncIntervalSec
              : 25,
          enableRealtime: parsed.enableRealtime ?? true,
        };
      }
    }
  } catch {
    // Fallback to hardcoded/env configuration
  }

  return {
    url: sanitizeApiKeyInput((envUrl && envUrl.trim()) || DEFAULT_SUPABASE_URL),
    anonKey: sanitizeApiKeyInput((envKey && envKey.trim()) || DEFAULT_SUPABASE_ANON_KEY),
    serviceRoleKey: runtimeServiceRoleKey,
    schema: 'public',
    autoSyncIntervalSec: 25,
    enableRealtime: true,
  };
}

export function saveSupabaseConfig(
  url: string,
  anonKey: string,
  extra?: Partial<Omit<SupabaseRuntimeConfig, 'url' | 'anonKey'>>
): void {
  const current = getSupabaseConfig();
  if (extra?.serviceRoleKey !== undefined) {
    runtimeServiceRoleKey = sanitizeApiKeyInput(extra.serviceRoleKey);
  }
  const persistedConfig: Omit<SupabaseRuntimeConfig, 'serviceRoleKey'> = {
    url: sanitizeApiKeyInput(url),
    anonKey: sanitizeApiKeyInput(anonKey),
    schema: extra?.schema?.trim() || current.schema || 'public',
    autoSyncIntervalSec:
      extra?.autoSyncIntervalSec !== undefined && extra.autoSyncIntervalSec >= 5
        ? extra.autoSyncIntervalSec
        : current.autoSyncIntervalSec || 25,
    enableRealtime:
      extra?.enableRealtime !== undefined ? extra.enableRealtime : current.enableRealtime ?? true,
  };
  localStorage.setItem(RUNTIME_CONFIG_KEY, JSON.stringify(persistedConfig));
  cachedClient = null;
  cachedAdminClient = null;
}

export function resetSupabaseConfig(): void {
  localStorage.removeItem(RUNTIME_CONFIG_KEY);
  runtimeServiceRoleKey = '';
  cachedClient = null;
  cachedAdminClient = null;
}

export function isLiveSupabaseConfigured(): boolean {
  const { url, anonKey } = getSupabaseConfig();
  return (
    Boolean(url) &&
    Boolean(anonKey) &&
    url.startsWith('https://') &&
    !url.includes('nusantaracbt-default.supabase.co') &&
    !anonKey.includes('nusantara_cbt_default_anon_key')
  );
}

let cachedClient: SupabaseClient | null = null;
let cachedAdminClient: SupabaseClient | null = null;

/**
 * Fetch wrapper dengan batas waktu keras (AbortController) agar koneksi TCP yang menggantung
 * pada Wi-Fi padat atau server sibuk tidak pernah membuat tombol "Akhiri Ujian" freeze selamanya.
 */
function createTimeoutFetch(timeoutMs: number): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof AbortController === 'undefined') {
      return fetch(input, init);
    }
    const controller = new AbortController();
    const externalSignal = init?.signal;
    const onExternalAbort = () => controller.abort();

    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    const timer = globalThis.setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      return await fetch(input, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      globalThis.clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    }
  };
}

export function getSupabaseClient(): SupabaseClient {
  if (cachedClient) return cachedClient;
  const { url, anonKey, schema } = getSupabaseConfig();
  cachedClient = createClient(url, anonKey, {
    db: {
      schema: (schema || 'public') as 'public',
    },
    global: {
      fetch: createTimeoutFetch(25_000),
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    realtime: {
      params: {
        eventsPerSecond: 10,
      },
    },
  });
  return cachedClient;
}

/**
 * Opsional: Client khusus Admin menggunakan Service Role Key (bila diisi di pengaturan Admin).
 * Disimpan hanya di memori sesi browser (tidak persisten di localStorage).
 */
export function getSupabaseAdminClient(): SupabaseClient | null {
  if (!isLiveSupabaseConfigured()) return null;
  const { url, serviceRoleKey, schema } = getSupabaseConfig();
  const key = sanitizeApiKeyInput(serviceRoleKey || '');
  const validation = validateServiceRoleKey(key, url);
  if (!validation.valid) return null;
  if (cachedAdminClient) return cachedAdminClient;
  cachedAdminClient = createClient(url, key, {
    db: {
      schema: (schema || 'public') as 'public',
    },
    global: {
      fetch: createTimeoutFetch(35_000),
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return cachedAdminClient;
}

export function hasSupabaseServiceRoleKey(): boolean {
  const { url, serviceRoleKey } = getSupabaseConfig();
  return validateServiceRoleKey(serviceRoleKey, url).valid;
}

export const QUESTION_IMAGES_BUCKET = 'question-images';

function dataUrlToBlob(dataUrl: string): { blob: Blob; ext: string; mime: string } | null {
  try {
    const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) return null;
    const mime = match[1].toLowerCase();
    const b64 = match[2];
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const ext =
      mime === 'image/webp'
        ? 'webp'
        : mime === 'image/png'
          ? 'png'
          : mime === 'image/jpeg' || mime === 'image/jpg'
            ? 'jpg'
            : 'bin';
    return { blob: new Blob([bytes], { type: mime }), ext, mime };
  } catch {
    return null;
  }
}

/**
 * Mengunggah gambar soal/opsi terkompresi (data:image/...) ke Supabase Storage bucket
 * agar tabel `questions` hanya menyimpan URL CDN pendek (<100 byte) bukan Base64 puluhan KB.
 * Jika offline atau bucket belum tersedia, otomatis fallback ke dataUrl asli tanpa error.
 */
export async function uploadQuestionImageToStorage(
  dataUrl: string,
  prefix = 'q'
): Promise<string> {
  const trimmed = (dataUrl || '').trim();
  if (!trimmed || !trimmed.startsWith('data:image/')) {
    return trimmed;
  }
  if (!isLiveSupabaseConfigured()) {
    return trimmed;
  }

  const parsed = dataUrlToBlob(trimmed);
  if (!parsed) return trimmed;

  const client = getSupabaseAdminClient() || getSupabaseClient();
  const rand = Math.random().toString(36).slice(2, 8);
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '') || 'q';
  const filePath = `${safePrefix}/${Date.now()}-${rand}.${parsed.ext}`;

  try {
    const { error: uploadErr } = await client.storage
      .from(QUESTION_IMAGES_BUCKET)
      .upload(filePath, parsed.blob, {
        contentType: parsed.mime,
        cacheControl: '31536000',
        upsert: false,
      });
    if (uploadErr) {
      return trimmed;
    }
    const { data: pub } = client.storage
      .from(QUESTION_IMAGES_BUCKET)
      .getPublicUrl(filePath);
    if (pub?.publicUrl) {
      return pub.publicUrl;
    }
  } catch {
    // Graceful fallback to compressed data URL
  }
  return trimmed;
}

