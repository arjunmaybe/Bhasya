/**
 * Secure intake (SSRF guard + decoding). Worker-safe: no `node:*` imports.
 * DNS resolution defaults to Node's resolver when available (lazy dynamic
 * import) and falls back to DNS-over-HTTPS (Cloudflare 1.1.1.1) inside
 * Cloudflare Workers. Callers may always inject `dnsResolve` (tests do).
 */

export const SSRF_LIMITS = {
  maxRedirects: 3,
  maxBytes: 2_000_000,
  timeoutMs: 12_000,
  allowedContentTypes: ['text/html', 'text/plain'],
};

function isIPv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

function isIPv6(host: string): boolean {
  if (!host.includes(':')) return false;
  // Strict-enough check: hex groups + colons (covers :: compression).
  if (!/^[0-9a-fA-F:.]+$/.test(host)) return false;
  // Must contain at least two colons or be a valid compressed form.
  try {
    // Expand via URL parser: `[host]` must parse as IPv6 literal.
    const u = new URL(`http://[${host}]/`);
    return u.hostname === host.toLowerCase() || u.hostname === `[${host.toLowerCase()}]`;
  } catch {
    return host.split(':').length >= 3;
  }
}

function isIP(host: string): 0 | 4 | 6 {
  if (isIPv4(host)) return 4;
  if (isIPv6(host)) return 6;
  return 0;
}

function isPrivateIp(ip: string): boolean {
  if (ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  if (isIP(ip) === 4) {
    const o = ip.split('.').map(Number);
    if (o[0] === 10) return true;
    if (o[0] === 127) return true;
    if (o[0] === 169 && o[1] === 254) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 0 || o[0] >= 224) return true;
  } else if (isIP(ip) === 6) {
    const l = ip.toLowerCase();
    if (l === '::1' || l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd') || l === '::') return true;
  }
  return false;
}

async function defaultDnsResolve(hostname: string): Promise<string[]> {
  // Node: use the system resolver (lazy so Workers never import node:dns).
  try {
    const mod = await import('node:dns/promises');
    const recs = await (mod as { lookup: (h: string, o: unknown) => Promise<Array<{ address: string }>> }).lookup(hostname, { all: true });
    return recs.map((r) => r.address);
  } catch {
    // Workers (no node:dns): DNS-over-HTTPS via Cloudflare.
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
      headers: { accept: 'application/dns-json' },
    });
    if (!res.ok) throw new Error('DNS resolution failed');
    const json = (await res.json()) as { Answer?: Array<{ data?: string }> };
    const addrs = (json.Answer ?? []).map((a) => String(a.data ?? '')).filter((s) => isIPv4(s));
    if (addrs.length === 0) throw new Error('DNS resolution failed');
    return addrs;
  }
}

/** Validate URL shape: http/https only, no credentials, no private hosts by literal. */
export function validateUrlShape(raw: string): URL {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new Error('malformed URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http/https URLs are allowed');
  if (u.username || u.password) throw new Error('URLs with credentials are rejected');
  if (!u.hostname) throw new Error('malformed URL');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error('private destination blocked');
  }
  if (isIP(host) && isPrivateIp(host)) throw new Error('private destination blocked');
  return u;
}

/** DNS-target validation: resolve hostname and reject private/link-local/loopback. */
export async function assertPublicDnsTarget(
  hostname: string,
  resolve: (h: string) => Promise<string[]> = defaultDnsResolve,
): Promise<void> {
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('private destination blocked');
    return;
  }
  const addrs = await resolve(hostname);
  if (addrs.length === 0) throw new Error('DNS resolution failed');
  for (const a of addrs) {
    if (isPrivateIp(a)) throw new Error('private destination blocked');
  }
}

export type SecureFetchResult = { finalUrl: string; contentType: string; html: string };

/** Extract a charset label from an HTTP Content-Type header value (if present). */
export function charsetFromContentType(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = header.match(/charset\s*=\s*"?([^";\s]+)"?/i);
  return m ? m[1].trim().toLowerCase() : null;
}

function latin1Decode(buf: Uint8Array): string {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    out += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return out;
}

/**
 * Prescan the first bytes for an in-document encoding declaration:
 * `<meta charset="...">`, `<meta http-equiv="content-type" content="...; charset=...">`,
 * or `<?xml ... encoding="...">`. Decoded byte-preserving (latin1) so the scan
 * itself never depends on the document encoding.
 */
export function charsetFromDocumentHead(buf: Uint8Array): string | null {
  const head = latin1Decode(buf.subarray(0, 4096));
  const m = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([^"'\s/>;]+)/i)
    ?? head.match(/<\?xml[^>]+encoding\s*=\s*["']\s*([^"'\s]+)/i);
  return m ? m[1].trim().toLowerCase() : null;
}

/** Normalize a charset label to one TextDecoder accepts (WHATWG-compatible). */
function normalizeCharsetLabel(label: string): string {
  const l = label.trim().toLowerCase();
  if (l === 'iso-8859-1' || l === 'latin1' || l === 'latin-1') return 'windows-1252';
  if (l === 'utf8') return 'utf-8';
  if (l === 'utf16' || l === 'utf-16') return 'utf-16le';
  return l;
}

/**
 * WHATWG windows-1252 index for bytes 0x80–0x9F (bytes outside this range
 * decode identically to ISO-8859-1). Applied manually because some runtimes
 * map these bytes 1:1 instead of applying the WHATWG table
 * (e.g. 0x92 must become U+2019 RIGHT SINGLE QUOTATION MARK).
 */
const WINDOWS_1252_EXTRA: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};
const WINDOWS_1252_UNMAPPED = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);

function decodeWindows1252(buf: Uint8Array): string {
  return latin1Decode(buf).replace(/[\u0080-\u009f]/g, (ch) => {
    const b = ch.charCodeAt(0);
    if (WINDOWS_1252_UNMAPPED.has(b)) return '�';
    const mapped = WINDOWS_1252_EXTRA[b];
    return mapped === undefined ? ch : String.fromCharCode(mapped);
  });
}

function decodeWith(label: string, buf: Uint8Array): string | null {
  const normalized = normalizeCharsetLabel(label);
  // Per WHATWG, iso-8859-1/latin1 are aliases of windows-1252.
  if (normalized === 'windows-1252') return decodeWindows1252(buf);
  try {
    return new TextDecoder(normalized, { fatal: false }).decode(buf);
  } catch {
    return null;
  }
}

/**
 * Decode fetched response bytes to text.
 * Precedence: BOM → HTTP Content-Type charset → in-document declaration
 * (`<meta charset>` / XML `encoding`) → UTF-8 default (previous behavior).
 * Unknown labels fall back to UTF-8 so intake never hard-fails on decoding.
 */
export function decodeResponseBytes(buf: Uint8Array, contentTypeHeader: string | null | undefined): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buf.subarray(3));
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buf.subarray(2));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buf.subarray(2));
  }
  const headerCharset = charsetFromContentType(contentTypeHeader);
  if (headerCharset) {
    const text = decodeWith(headerCharset, buf);
    if (text !== null) return text;
  }
  const headCharset = charsetFromDocumentHead(buf);
  if (headCharset && headCharset !== headerCharset) {
    const text = decodeWith(headCharset, buf);
    if (text !== null) return text;
  }
  return new TextDecoder('utf-8').decode(buf);
}

/**
 * Secure intake fetch: constrained redirects, DNS validation per hop,
 * content-type + size limits, fetch timeout. Each redirect target re-validated.
 */
export async function secureFetchUrl(
  rawUrl: string,
  deps: {
    fetchFn?: typeof fetch;
    dnsResolve?: (h: string) => Promise<string[]>;
    maxBytes?: number;
    timeoutMs?: number;
  } = {},
): Promise<SecureFetchResult> {
  const maxBytes = deps.maxBytes ?? SSRF_LIMITS.maxBytes;
  const timeoutMs = deps.timeoutMs ?? SSRF_LIMITS.timeoutMs;
  const fetchFn = deps.fetchFn ?? fetch;
  let current = validateUrlShape(rawUrl).toString();

  for (let hop = 0; hop <= SSRF_LIMITS.maxRedirects; hop += 1) {
    const u = validateUrlShape(current);
    await assertPublicDnsTarget(u.hostname, deps.dnsResolve);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchFn(current, { redirect: 'manual', signal: ctrl.signal, headers: { 'user-agent': 'Bhasya/1.0 (+phase1)' } });
    } finally {
      clearTimeout(timer);
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (hop === SSRF_LIMITS.maxRedirects) throw new Error('too many redirects');
      const loc = res.headers.get('location');
      if (!loc) throw new Error('redirect without location');
      current = new URL(loc, current).toString();
      continue;
    }
    if (!res.ok) throw new Error(`fetch failed with status ${res.status}`);
    const rawCt = res.headers.get('content-type') ?? '';
    const ct = rawCt.split(';')[0].trim().toLowerCase();
    if (!SSRF_LIMITS.allowedContentTypes.some((a) => ct.startsWith(a))) {
      throw new Error(`unsupported content-type: ${ct || 'unknown'}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('response too large');
    if (buf.length === 0) throw new Error('empty response');
    return { finalUrl: current, contentType: ct || 'text/html', html: decodeResponseBytes(buf, rawCt) };
  }
  throw new Error('too many redirects');
}
