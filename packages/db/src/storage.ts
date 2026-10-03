/**
 * StoragePort — object-storage contract for Phase 1 (source/artifact bytes).
 * $0 baseline: Supabase Storage behind this port (Worker-safe fetch REST).
 * Optional future production provider: Cloudflare R2 (S3-compatible) behind
 * the same port. Dev: filesystem adapter below implementing the same
 * interface. No behavior change, only backend.
 *
 * Worker rule (locked $0 architecture): the local filesystem does NOT exist
 * inside Cloudflare Workers. Workers MUST use a configured StoragePort
 * backend — Supabase Storage ($0 staging) or the optional R2 binding; the
 * filesystem adapter is local-dev only and throws when constructed without
 * Node.js runtime.
 *
 * This module has NO static `node:*` imports so it stays importable inside
 * a Cloudflare Worker bundle. Node-only modules are loaded lazily inside
 * `LocalStorageAdapter` methods (local dev only).
 */
export interface StoragePort {
  put: (key: string, bytes: Uint8Array | string, contentType?: string) => Promise<void>;
  get: (key: string) => Promise<Uint8Array | null>;
}

/** Minimal Cloudflare R2 bucket shape (only what the port needs). */
export interface R2BucketLike {
  put: (key: string, value: Uint8Array | string, options?: { httpMetadata?: { contentType?: string } }) => Promise<unknown>;
  get: (key: string) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> } | null>;
}

/** Optional future production backend: Cloudflare R2 bucket binding. */
export class R2StorageAdapter implements StoragePort {
  constructor(private bucket: R2BucketLike) {
    if (!bucket || typeof bucket.put !== 'function' || typeof bucket.get !== 'function') {
      throw new Error('R2 bucket binding required (production StoragePort)');
    }
  }
  async put(key: string, bytes: Uint8Array | string, contentType?: string): Promise<void> {
    const value = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
    await this.bucket.put(key, value, { httpMetadata: { contentType: contentType ?? 'application/octet-stream' } });
  }
  async get(key: string): Promise<Uint8Array | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    const buf = await obj.arrayBuffer();
    return new Uint8Array(buf);
  }
}

/**
 * $0 staging backend: Supabase Storage behind the same StoragePort.
 *
 * - Uses the plain Storage REST API over global `fetch` (no dependencies,
 *   Worker-safe: no `node:*`, no S3 SDK, no crypto signing).
 * - Bucket stays PRIVATE: every request carries the server-side
 *   `service_role` key (`apikey` + `Authorization: Bearer`), which works on
 *   private buckets. Never expose that key to the browser.
 * - Uploads send `x-upsert: true` so `put` overwrites like R2/File backends.
 * - The application only sees `put`/`get` and cannot distinguish this from R2.
 */
export interface SupabaseStorageConfig {
  /** Project URL, e.g. `https://<ref>.supabase.co` (trailing slash tolerated). */
  url: string;
  /** Server-side `service_role` key (wrangler secret, never committed). */
  serviceKey: string;
  /** Storage bucket (private). Defaults to `bhasya-artifacts` at selection. */
  bucket: string;
  /** Injectable for tests; defaults to global `fetch` (Workers + Node 18+). */
  fetchFn?: typeof fetch;
}

export class SupabaseStorageAdapter implements StoragePort {
  private readonly baseUrl: string;
  private readonly serviceKey: string;
  private readonly bucket: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: SupabaseStorageConfig) {
    const url = config?.url?.trim().replace(/\/+$/, '');
    const serviceKey = config?.serviceKey?.trim();
    const bucket = config?.bucket?.trim();
    if (!url || !serviceKey || !bucket) {
      throw new Error(
        'SupabaseStorageAdapter requires url + serviceKey + bucket ' +
        '(SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_STORAGE_BUCKET).',
      );
    }
    this.baseUrl = url;
    this.serviceKey = serviceKey;
    this.bucket = bucket;
    // Workerd-safe default: bare `fetch` called detached throws
    // "Illegal invocation" inside Cloudflare Workers (Node tolerates it).
    this.fetchFn = config.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input as RequestInfo, init));
  }

  private objectUrl(key: string): string {
    const encoded = key.split('/').map((seg) => encodeURIComponent(seg)).join('/');
    return `${this.baseUrl}/storage/v1/object/${encodeURIComponent(this.bucket)}/${encoded}`;
  }

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      apikey: this.serviceKey,
      Authorization: `Bearer ${this.serviceKey}`,
      ...(extra ?? {}),
    };
  }

  async put(key: string, bytes: Uint8Array | string, contentType?: string): Promise<void> {
    const body = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
    const res = await this.fetchFn(this.objectUrl(key), {
      method: 'POST',
      headers: this.authHeaders({
        'Content-Type': contentType ?? 'application/octet-stream',
        'x-upsert': 'true',
      }),
      body: body as unknown as BodyInit,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Supabase Storage upload failed (${res.status} ${key}): ${detail.slice(0, 200)}`);
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    const res = await this.fetchFn(this.objectUrl(key), {
      method: 'GET',
      headers: this.authHeaders(),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // Supabase reports a missing private-bucket object as 400 "Not found".
      if (res.status === 400 && /not found/i.test(detail)) return null;
      throw new Error(`Supabase Storage download failed (${res.status} ${key}): ${detail.slice(0, 200)}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }
}

/** In-memory backend: tests + Worker-runtime verification (no filesystem). */
export class MemoryStorageAdapter implements StoragePort {
  private store = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array | string): Promise<void> {
    this.store.set(key, typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes));
  }
  async get(key: string): Promise<Uint8Array | null> {
    return this.store.get(key) ?? null;
  }
}

function hasNodeRuntime(): boolean {
  try {
    const proc = (globalThis as { process?: { versions?: Record<string, string> } }).process;
    return !!proc?.versions?.node;
  } catch {
    return false;
  }
}

function defaultBaseDir(): string {
  try {
    const cwd = (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.();
    if (cwd) return `${cwd}/.bhasya-objects`;
  } catch { /* ignore */ }
  return '.bhasya-objects';
}

/** Local-dev backend only. Throws when constructed outside Node.js. */
export class LocalStorageAdapter implements StoragePort {
  private baseDir: string;

  constructor(baseDir?: string) {
    if (!hasNodeRuntime()) {
      throw new Error(
        'LocalStorageAdapter requires Node.js filesystem (local dev only). ' +
        'In Cloudflare Workers use Supabase Storage ($0 staging, SupabaseStorageAdapter) ' +
        'or the optional R2 bucket binding (R2StorageAdapter).',
      );
    }
    this.baseDir = baseDir ?? defaultBaseDir();
  }

  private resolvePath(key: string): { full: string; dir: string } {
    const safe = key.replace(/[^a-zA-Z0-9/_.-]/g, '_').replace(/(^|\/)\.\.(\/|$)/g, '$1_$2');
    const full = `${this.baseDir}/${safe}`;
    const dir = full.slice(0, full.lastIndexOf('/'));
    return { full, dir };
  }

  private async nodeModules(): Promise<{ fs: typeof import('node:fs'); path: typeof import('node:path') }> {
    // Lazy so Workers can import this module without `node:fs` failing at load.
    const [fs, path] = await Promise.all([import('node:fs'), import('node:path')]);
    return { fs, path };
  }

  async put(key: string, bytes: Uint8Array | string, _ct?: string): Promise<void> {
    const { fs, path } = await this.nodeModules();
    if (!hasNodeRuntime()) throw new Error('LocalStorageAdapter requires Node.js filesystem (local dev only).');
    const { full, dir } = this.resolvePath(key);
    const normalizedDir = path.dirname(path.normalize(full));
    void dir;
    fs.mkdirSync(normalizedDir, { recursive: true });
    const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
    fs.writeFileSync(full, data);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const { fs, path } = await this.nodeModules();
    if (!hasNodeRuntime()) throw new Error('LocalStorageAdapter requires Node.js filesystem (local dev only).');
    const { full } = this.resolvePath(key);
    const normalized = path.normalize(full);
    if (!fs.existsSync(normalized)) return null;
    return new Uint8Array(fs.readFileSync(normalized));
  }
}
