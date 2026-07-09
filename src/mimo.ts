import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, platform, arch } from 'node:os';
import { join } from 'node:path';
import {
  JWT_REFRESH_BUFFER_MS,
  MIMOCODE_SYSTEM_PROMPT,
  MIMO_BOOTSTRAP_URL,
  MIMO_CHAT_URL,
  MIMO_MODEL_ID,
  MIMO_TRACKING_URL,
  MIMO_USER_AGENT,
  MAX_FINGERPRINTS,
  FP_COOLDOWN_MS,
  MAX_429_RETRIES,
  ENABLE_IP_ROTATION,
  PROXY_LIST_URL,
  PROXY_LIST_FILE,
  MAX_PROXIES,
  PROXY_COOLDOWN_MS,
  PROXY_TEST_TIMEOUT_MS,
  PROXY_LIST_MAX_AGE_MS,
  MAX_PROXY_RETRIES,
} from './constants.js';
import type { ChatCompletionRequest, ChatMessage, JwtState } from './types.js';

const DATA_DIR = join(homedir(), '.mimo-free');

// ---------------------------------------------------------------------------
// Crypto helpers (Web Crypto + base64, all available in Node >=20 globals)
// ---------------------------------------------------------------------------

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function base64UrlDecode(input: string): string {
  let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return Buffer.from(base64, 'base64').toString('binary');
}

const POOL_FILE = join(DATA_DIR, 'fingerprints.json');

// --- Fingerprint pool ---
interface Fingerprint {
  fp: string;
  cooldownUntil: number; // epoch ms; <= now means available
}

let pool: Fingerprint[] | null = null;
let activeIdx = 0;

async function generateFingerprint(): Promise<string> {
  const seed = [platform(), arch(), crypto.randomUUID()].join('|');
  return await sha256Hex(seed);
}

async function savePool(): Promise<void> {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(POOL_FILE, JSON.stringify(pool));
  } catch {
    // best-effort persistence
  }
}

async function loadPool(): Promise<Fingerprint[]> {
  if (pool) return pool;
  // Existing pool file wins.
  try {
    const parsed = JSON.parse(await readFile(POOL_FILE, 'utf-8'));
    if (Array.isArray(parsed) && parsed.length) {
      pool = parsed as Fingerprint[];
      return pool;
    }
  } catch {
    // nope
  }
  // Migrate legacy single-fingerprint file.
  let seedFp: string | undefined;
  try {
    const legacy = (await readFile(join(DATA_DIR, 'client-fingerprint'), 'utf-8')).trim();
    if (legacy) seedFp = legacy;
  } catch {
    // no legacy either
  }
  seedFp ??= await generateFingerprint();
  pool = [{ fp: seedFp, cooldownUntil: 0 }];
  await savePool();
  return pool;
}

export async function getClientFingerprint(): Promise<string> {
  const p = await loadPool();
  return p[activeIdx]?.fp ?? p[0].fp;
}

async function rotateFingerprint(): Promise<string> {
  const p = await loadPool();
  const now = Date.now();
  if (p[activeIdx]) p[activeIdx].cooldownUntil = now + FP_COOLDOWN_MS;

  let pick = p.findIndex((f, i) => i !== activeIdx && f.cooldownUntil <= now);
  if (pick === -1 && p.length < MAX_FINGERPRINTS) {
    p.push({ fp: await generateFingerprint(), cooldownUntil: 0 });
    pick = p.length - 1;
  }
  if (pick === -1) {
    pick = p.reduce(
      (best, _f, i) => (p[i].cooldownUntil < p[best].cooldownUntil ? i : best),
      0,
    );
  }
  activeIdx = pick;
  await savePool();
  return p[activeIdx].fp;
}

// --- IP Rotation Proxy Pool ---
interface ProxyEntry {
  url: string; // "http://host:port"
  cooldownUntil: number;
}

let proxyPool: ProxyEntry[] | null = null;
let activeProxyIdx = -1;
let proxyInitPromise: Promise<number> | null = null;

function parseProxyList(raw: string): { host: string; port: number }[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const idx = l.lastIndexOf(':');
      if (idx <= 0) return null;
      const host = l.substring(0, idx);
      const port = parseInt(l.substring(idx + 1));
      if (host && port > 0 && port < 65536) return { host, port };
      return null;
    })
    .filter((e): e is { host: string; port: number } => e !== null);
}

async function testProxy(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const { connect } = await import('node:net');
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host, port, timeout: timeoutMs });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

let _ProxyAgent: any = undefined;

async function getProxyAgentClass(): Promise<any> {
  if (_ProxyAgent) return _ProxyAgent;
  try {
    const undici = await import('undici');
    _ProxyAgent = undici.ProxyAgent;
    return _ProxyAgent;
  } catch {
    return undefined;
  }
}

async function fetchProxyList(): Promise<string> {
  // Try disk cache.
  try {
    const { stat, readFile: rf } = await import('node:fs/promises');
    const st = await stat(PROXY_LIST_FILE);
    const age = Date.now() - (st.mtime?.getTime() ?? 0);
    if (age < PROXY_LIST_MAX_AGE_MS) {
      const cached = await rf(PROXY_LIST_FILE, 'utf-8');
      if (cached.trim().length > 0) return cached;
    }
  } catch {
    // no cache
  }

  console.warn(`Fetching proxy list from ${PROXY_LIST_URL}...`);
  const res = await (globalThis as any).fetch(PROXY_LIST_URL);
  if (!res.ok) throw new Error(`Proxy list fetch failed: ${res.status}`);
  const raw = await res.text();
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(PROXY_LIST_FILE, raw);
  } catch {
    // cache not critical
  }
  return raw;
}

async function loadProxyPool(): Promise<number> {
  if (proxyPool) return proxyPool.length;

  try {
    const raw = await fetchProxyList();
    const candidates = parseProxyList(raw);
    console.warn(
      `Testing ${candidates.length} proxy candidates (connect timeout ${PROXY_TEST_TIMEOUT_MS}ms)...`,
    );

    const working: ProxyEntry[] = [];
    for (let i = 0; i < candidates.length && working.length < MAX_PROXIES; i += 10) {
      const batch = candidates.slice(i, i + 10);
      const results = await Promise.all(
        batch.map(async (c) => {
          const ok = await testProxy(c.host, c.port, PROXY_TEST_TIMEOUT_MS);
          return ok
            ? { url: `http://${c.host}:${c.port}`, cooldownUntil: 0 }
            : null;
        }),
      );
      for (const r of results) {
        if (r) working.push(r);
        if (working.length >= MAX_PROXIES) break;
      }
    }

    proxyPool = working;
    activeProxyIdx = working.length > 0 ? 0 : -1;
    console.warn(`Proxy pool ready: ${working.length} working proxies`);
    return working.length;
  } catch (err) {
    console.warn(`Proxy pool init failed: ${err instanceof Error ? err.message : err}`);
    proxyPool = [];
    activeProxyIdx = -1;
    return 0;
  }
}

async function getProxyDispatcher(): Promise<any | undefined> {
  if (!ENABLE_IP_ROTATION) return undefined;
  if (!proxyPool || proxyPool.length === 0 || activeProxyIdx < 0) return undefined;

  const Agent = await getProxyAgentClass();
  if (!Agent) return undefined;

  try {
    return new Agent({ uri: proxyPool[activeProxyIdx].url });
  } catch {
    return undefined;
  }
}

async function rotateProxy(): Promise<void> {
  const pool = proxyPool;
  if (!pool || pool.length === 0) return;
  const now = Date.now();

  if (activeProxyIdx >= 0 && pool[activeProxyIdx]) {
    pool[activeProxyIdx].cooldownUntil = now + PROXY_COOLDOWN_MS;
  }

  let pick = pool.findIndex(
    (p, i) => i !== activeProxyIdx && p.cooldownUntil <= now,
  );
  if (pick === -1) {
    pick = pool.reduce(
      (best, _p, i) =>
        pool[i].cooldownUntil < pool[best].cooldownUntil ? i : best,
      activeProxyIdx >= 0 ? activeProxyIdx : 0,
    );
  }
  activeProxyIdx = pick;
  console.warn(
    `Rotated to proxy ${activeProxyIdx + 1}/${pool.length}: ${pool[activeProxyIdx]?.url}`,
  );
}

// Kick off proxy pool loading in background (non-blocking).
if (ENABLE_IP_ROTATION) {
  proxyInitPromise = loadProxyPool();
  proxyInitPromise
    .then((n) => {
      if (n > 0) console.warn(`IP rotation ready: ${n} proxies available`);
    })
    .catch((err) => {
      console.warn(`IP rotation disabled: ${err instanceof Error ? err.message : err}`);
      proxyPool = [];
    });
}

// ---------------------------------------------------------------------------
// Anonymous JWT bootstrap + cache
// ---------------------------------------------------------------------------

let jwtCache: JwtState | null = null;
let bootstrapInflight: Promise<JwtState> | null = null;

function parseJwtExpiry(jwt: string): number {
  try {
    const payload = JSON.parse(base64UrlDecode(jwt.split('.')[1] ?? ''));
    if (typeof payload.exp === 'number') return payload.exp * 1000;
  } catch {
    // Unparseable token: assume a conservative ~50 min lifetime.
  }
  return Date.now() + 50 * 60_000;
}

export async function bootstrap(): Promise<JwtState> {
  const client = await getClientFingerprint();
  const proxyDispatcher = await getProxyDispatcher();
  const res = await fetch(MIMO_BOOTSTRAP_URL, {
    method: 'POST',
    ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'mimocode/0.1.0',
    },
    body: JSON.stringify({ client }),
  });
  if (!res.ok) {
    throw new Error(`mimo bootstrap failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { jwt?: string };
  if (!data.jwt) throw new Error('mimo bootstrap response missing jwt');
  return { jwt: data.jwt, exp: parseJwtExpiry(data.jwt) };
}

export async function getJwt(forceRefresh = false): Promise<string> {
  if (!forceRefresh && jwtCache && jwtCache.exp - Date.now() > JWT_REFRESH_BUFFER_MS) {
    return jwtCache.jwt;
  }
  if (bootstrapInflight) return (await bootstrapInflight).jwt;
  jwtCache = null;
  bootstrapInflight = bootstrap();
  try {
    jwtCache = await bootstrapInflight;
    return jwtCache.jwt;
  } finally {
    bootstrapInflight = null;
  }
}

/** Drop the cached JWT (e.g. for tests or a forced re-auth). */
export function clearJwtCache(): void {
  jwtCache = null;
}

async function rotateAndRefreshJwt(): Promise<string> {
  await rotateFingerprint();
  jwtCache = null;
  bootstrapInflight = null;
  return await getJwt(true);
}

// ---------------------------------------------------------------------------
// Request shaping
// ---------------------------------------------------------------------------

/**
 * Derive a stable session id from the first couple of messages so repeated
 * turns of the same conversation reuse MiMo's server-side prompt cache.
 */
async function deriveSessionId(messages: ChatMessage[]): Promise<string> {
  const seed = JSON.stringify(messages.slice(0, 2));
  return 'ses_' + (await sha256Hex(seed)).slice(0, 24);
}

/**
 * Ensure the first message is a system message containing the MiMo identity
 * string. Without it the free-tier endpoint returns 403 `illegal_access`.
 */
export function ensureMimoSystemPrompt(messages: ChatMessage[]): ChatMessage[] {
  const first = messages[0];
  if (
    first?.role === 'system' &&
    typeof first.content === 'string' &&
    first.content.includes('MiMo')
  ) {
    return messages;
  }
  return [{ role: 'system', content: MIMOCODE_SYSTEM_PROMPT }, ...messages];
}

/** Fire-and-forget usage event, mirroring the official CLI's tracking call. */
function sendTrackingEvent(sessionId: string, model: string, messages: ChatMessage[]): void {
  const trackingBody = [
    {
      H: {
        event: 'model_call',
        app_id: '31000402765',
        instance_id: crypto.randomUUID(),
        instance_id_type: 'uuid',
        e_ts: Date.now(),
        uid: sessionId,
        uid_type: 'session_id',
      },
      B: {
        finish_reason: 'stop',
        ttft_ms: 0,
        latency_ms: Date.now(),
        cached_read_tokens: 0,
        model_id: model,
        provider: 'mimo',
        total_tokens_in: messages.reduce(
          (acc, m) => acc + (typeof m.content === 'string' ? m.content.length : 0),
          0,
        ),
        total_tokens_out: 0,
      },
    },
  ];

  fetch(MIMO_TRACKING_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'mimocode/0.1.0' },
    body: JSON.stringify(trackingBody),
  }).catch(() => {});
}

async function callMimo(jwt: string, mimoBody: unknown, sessionId: string): Promise<Response> {
  const proxyDispatcher = await getProxyDispatcher();
  return fetch(MIMO_CHAT_URL, {
    method: 'POST',
    ...(proxyDispatcher ? { dispatcher: proxyDispatcher } : {}),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
      'User-Agent': MIMO_USER_AGENT,
      'X-Mimo-Source': 'mimocode-cli',
      'x-session-affinity': sessionId,
    },
    body: JSON.stringify(mimoBody),
  });
}

async function readRequestBody(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<string | undefined> {
  if (typeof init?.body === 'string') return init.body;
  if (init?.body instanceof Uint8Array) return new TextDecoder().decode(init.body);
  if (input instanceof Request && init?.body === undefined) {
    try {
      return await input.clone().text();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Fetch interceptor
// ---------------------------------------------------------------------------

/**
 * Build the custom `fetch` that OpenCode / the AI SDK uses for the `mimo-free`
 * provider. It transparently:
 *   - rewrites `…/chat/completions` to MiMo's real `…/chat` endpoint,
 *   - forces `model: "mimo-auto"` and the MiMo system prompt,
 *   - bootstraps/attaches an anonymous JWT and the CLI headers,
 *   - retries with fresh JWT + fingerprint/proxy rotation on 401/403/429/502/503.
 * Any non-chat request passes through untouched.
 */
export function createMimoFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();

    // Only special-case the chat completions call; everything else passes through.
    if (!url.endsWith('/chat/completions')) {
      return fetch(input as Parameters<typeof fetch>[0], init);
    }

    const rawBody = await readRequestBody(input, init);
    let body: ChatCompletionRequest = {};
    if (rawBody) {
      try {
        body = JSON.parse(rawBody) as ChatCompletionRequest;
      } catch {
        // Non-JSON body we don't understand — pass through unmodified.
        return fetch(input as Parameters<typeof fetch>[0], init);
      }
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const sessionId = await deriveSessionId(messages);

    const {
      model: _model,
      max_tokens,
      temperature,
      stream,
      stream_options,
      ...rest
    } = body;

    const isStreaming = stream !== false;
    const mimoBody = {
      ...rest,
      model: MIMO_MODEL_ID,
      max_tokens: max_tokens || 128_000,
      temperature: temperature ?? 0.5,
      messages: ensureMimoSystemPrompt(messages),
      stream: isStreaming,
      ...(isStreaming ? { stream_options: stream_options || { include_usage: true } } : {}),
    };

    let jwt = await getJwt();
    let res = await callMimo(jwt, mimoBody, sessionId);

    // Unified retry/rotation loop for auth failures (401/403), rate limits (429),
    // and proxy errors (502/503) when IP rotation is active.
    const maxAttempts = MAX_PROXY_RETRIES + MAX_429_RETRIES;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const retryable =
        res.status === 401 || res.status === 403 ||
        res.status === 429 ||
        (ENABLE_IP_ROTATION && (res.status === 502 || res.status === 503));

      if (!retryable) break;

      await res.body?.cancel();

      if (res.status === 401 || res.status === 403) {
        console.warn(`Auth failure (${res.status}), refreshing JWT...`);
        jwt = await getJwt(true);
      } else if (res.status === 429) {
        console.warn(`429 rate limited, rotating fingerprint (attempt ${attempt + 1})`);
        jwt = await rotateAndRefreshJwt();
      } else {
        console.warn(`Proxy/upstream error (${res.status}), rotating...`);
      }

      // Rotate proxy on any retryable error when IP rotation is active.
      if (ENABLE_IP_ROTATION && proxyPool && proxyPool.length > 1) {
        await rotateProxy();
      }

      res = await callMimo(jwt, mimoBody, sessionId);
    }

    if (res.ok && isStreaming) {
      sendTrackingEvent(sessionId, MIMO_MODEL_ID, messages);
    }

    return res;
  }) as typeof fetch;
}

// Exported for testing only.
export const __test = {
  parseProxyList,
  _getPool: () => pool,
  _setPool: (p: Fingerprint[] | null) => { pool = p; },
  _getActiveIdx: () => activeIdx,
  _setActiveIdx: (i: number) => { activeIdx = i; },
  _getProxyPool: () => proxyPool,
  _setProxyPool: (p: ProxyEntry[] | null) => { proxyPool = p; },
  _getActiveProxyIdx: () => activeProxyIdx,
  _setActiveProxyIdx: (i: number) => { activeProxyIdx = i; },
  _reset: () => {
    pool = null;
    activeIdx = 0;
    proxyPool = null;
    activeProxyIdx = -1;
    jwtCache = null;
    bootstrapInflight = null;
  },
};
