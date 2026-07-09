// Standalone Deno proxy (optional).
//
// This is the original OpenAI-compatible proxy server. You do NOT need it if you
// use the OpenCode plugin (see ../README.md) — the plugin performs the same
// anonymous bootstrap/JWT auth inline via a fetch interceptor. This file is kept
// for anyone who wants a plain HTTP proxy that any OpenAI-compatible client can
// point at.
//
//   deno run -A proxy/server.ts

const MIMO_BASE_URL =
  (Deno.env.get("MIMO_BASE_URL") || "https://api.xiaomimimo.com").replace(
    /\/+$/,
    "",
  );
const BOOTSTRAP_URL = `${MIMO_BASE_URL}/api/free-ai/bootstrap`;
const CHAT_URL = `${MIMO_BASE_URL}/api/free-ai/openai/chat`;
const TRACKING_URL = "https://tracking.miui.com/track/v4/o";
const USER_AGENT =
  "mimocode/0.1.0/cli";
const DEFAULT_PORT = 3000;

// Optional: require `Authorization: Bearer <PROXY_API_KEY>` from callers.
// Leave unset for unrestricted local use.
const PROXY_API_KEY = Deno.env.get("PROXY_API_KEY");

const DATA_DIR = `${Deno.env.get("HOME") ?? "."}/.mimo-proxy`;
const FINGERPRINT_FILE = `${DATA_DIR}/client-fingerprint`;
const POOL_FILE = `${DATA_DIR}/fingerprints.json`;

// On 429 the proxy rotates to a different anonymous fingerprint to get a fresh
// free-tier budget. Only helps if MiMo keys the limit on the fingerprint/identity
// rather than the egress IP. Tunables:
const MAX_FINGERPRINTS = Number(Deno.env.get("MAX_FINGERPRINTS") ?? 8);
const FP_COOLDOWN_MS = Number(Deno.env.get("FP_COOLDOWN_MS") ?? 60 * 60_000); // assumed window reset
const MAX_429_RETRIES = Number(Deno.env.get("MAX_429_RETRIES") ?? 3);

// IP rotation via external HTTP proxies. When ENABLE_IP_ROTATION=1, outbound
// requests to MiMo are tunnelled through a rotating pool of HTTP proxies so
// that MiMo sees a different egress IP on each rotation.
const ENABLE_IP_ROTATION = Deno.env.get("ENABLE_IP_ROTATION") !== "0" &&
  Deno.env.get("ENABLE_IP_ROTATION") !== "false";
const PROXY_LIST_URL =
  (Deno.env.get("PROXY_LIST_URL") ||
    "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/refs/heads/master/http.txt").trim();
const PROXY_LIST_FILE = `${DATA_DIR}/proxy-list.txt`;
const MAX_PROXIES = Number(Deno.env.get("MAX_PROXIES") ?? 10);
const PROXY_COOLDOWN_MS = Number(Deno.env.get("PROXY_COOLDOWN_MS") ?? 60_000);
const PROXY_TEST_TIMEOUT_MS = Number(Deno.env.get("PROXY_TEST_TIMEOUT_MS") ?? 3000);
const PROXY_LIST_MAX_AGE_MS = Number(Deno.env.get("PROXY_LIST_MAX_AGE_MS") ?? 6 * 60 * 60_000);
const MAX_PROXY_RETRIES = Number(Deno.env.get("MAX_PROXY_RETRIES") ?? 3);

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  [key: string]: unknown;
}

interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  [key: string]: unknown;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function jsonError(status: number, message: string, type: string): Response {
  return new Response(JSON.stringify({ error: { message, type } }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function base64UrlDecode(input: string): string {
  let base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  return atob(base64);
}

// MiMo's free-tier bootstrap binds the issued JWT to a per-install
// fingerprint. Persist it so we keep reusing the same identity across
// restarts instead of looking like a new client every time.
// Extended with a multi-fingerprint pool so 429 rate-limits trigger a
// rotation to a free-tier slot.

interface Fingerprint {
  fp: string;
  cooldownUntil: number; // epoch ms; <= now means available
}

let pool: Fingerprint[] | null = null;
let activeIdx = 0;

async function generateFingerprint(): Promise<string> {
  const seed = [Deno.build.os, Deno.build.arch, crypto.randomUUID()].join("|");
  return await sha256Hex(seed);
}

async function savePool(): Promise<void> {
  try {
    await Deno.mkdir(DATA_DIR, { recursive: true });
    await Deno.writeTextFile(POOL_FILE, JSON.stringify(pool));
  } catch {}
}

async function loadPool(): Promise<Fingerprint[]> {
  if (pool) return pool;
  // Existing pool file wins.
  try {
    const parsed = JSON.parse(await Deno.readTextFile(POOL_FILE));
    if (Array.isArray(parsed) && parsed.length) {
      pool = parsed as Fingerprint[];
      return pool;
    }
  } catch {}
  // Migrate the legacy single-fingerprint file if present.
  let seedFp: string | undefined;
  try {
    const legacy = (await Deno.readTextFile(FINGERPRINT_FILE)).trim();
    if (legacy) seedFp = legacy;
  } catch {}
  seedFp ??= await generateFingerprint();
  pool = [{ fp: seedFp, cooldownUntil: 0 }];
  await savePool();
  return pool;
}

async function getClientFingerprint(): Promise<string> {
  const p = await loadPool();
  return p[activeIdx]?.fp ?? p[0].fp;
}

// Park the current fingerprint with a cooldown and switch to the best
// alternative: the available one with the lowest cooldown, a freshly minted
// one if the pool has room, else the entry that frees up soonest.
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
    // All cooling down — take the one that recovers soonest.
    pick = p.reduce(
      (best, f, i) => (f.cooldownUntil < p[best].cooldownUntil ? i : best),
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
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const idx = l.lastIndexOf(":");
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
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const conn = await Deno.connect({
        hostname: host,
        port,
        signal: controller.signal,
      });
      conn.close();
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

async function fetchProxyList(): Promise<string> {
  // Try disk cache (within max age).
  try {
    const stat = await Deno.stat(PROXY_LIST_FILE);
    const age = Date.now() - (stat.mtime?.getTime() ?? 0);
    if (age < PROXY_LIST_MAX_AGE_MS) {
      const cached = await Deno.readTextFile(PROXY_LIST_FILE);
      if (cached.trim().length > 0) return cached;
    }
  } catch {
    // no cache
  }

  // Cache miss or stale — fetch fresh.
  console.warn(`Fetching proxy list from ${PROXY_LIST_URL}...`);
  const res = await fetch(PROXY_LIST_URL);
  if (!res.ok) {
    throw new Error(`Proxy list fetch failed: ${res.status}`);
  }
  const raw = await res.text();
  try {
    await Deno.mkdir(DATA_DIR, { recursive: true });
    await Deno.writeTextFile(PROXY_LIST_FILE, raw);
  } catch {
    // disk cache not critical
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

    // Test in parallel batches (10 at a time).
    const working: ProxyEntry[] = [];
    for (let i = 0; i < candidates.length && working.length < MAX_PROXIES; i += 10) {
      const batch = candidates.slice(i, i + 10);
      const results = await Promise.all(
        batch.map(async (c) => {
          const ok = await testProxy(c.host, c.port, PROXY_TEST_TIMEOUT_MS);
          return ok ? { url: `http://${c.host}:${c.port}`, cooldownUntil: 0 } : null;
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

function getProxyClient(): Deno.HttpClient | undefined {
  if (!ENABLE_IP_ROTATION) return undefined;
  if (!proxyPool || proxyPool.length === 0 || activeProxyIdx < 0) return undefined;
  return Deno.createHttpClient({
    proxy: {
      url: proxyPool[activeProxyIdx].url,
    },
  });
}

function closeActiveProxyClient(): void {
  // HttpClient.close is called by getProxyClient's callers after use.
  // No persistent clients to close — created per request.
}

async function rotateProxy(): Promise<void> {
  if (!proxyPool || proxyPool.length === 0) return;
  const now = Date.now();

  // Park current proxy.
  if (activeProxyIdx >= 0 && proxyPool[activeProxyIdx]) {
    proxyPool[activeProxyIdx].cooldownUntil = now + PROXY_COOLDOWN_MS;
  }

  // Find next available (not in cooldown, different index).
  let pick = proxyPool.findIndex(
    (p, i) => i !== activeProxyIdx && p.cooldownUntil <= now,
  );
  if (pick === -1) {
    // All cooling down — take the one that recovers soonest.
    pick = proxyPool.reduce(
      (best, _p, i) =>
        proxyPool[i].cooldownUntil < proxyPool[best].cooldownUntil ? i : best,
      activeProxyIdx >= 0 ? activeProxyIdx : 0,
    );
  }
  activeProxyIdx = pick;
  console.warn(`Rotated to proxy ${activeProxyIdx + 1}/${proxyPool.length}: ${proxyPool[activeProxyIdx]?.url}`);
}

interface JwtState {
  jwt: string;
  exp: number;
}

let jwtCache: JwtState | null = null;
let bootstrapInflight: Promise<JwtState> | null = null;

function parseJwtExpiry(jwt: string): number {
  try {
    const payload = JSON.parse(base64UrlDecode(jwt.split(".")[1] ?? ""));
    if (typeof payload.exp === "number") return payload.exp * 1000;
  } catch {}
  return Date.now() + 50 * 60_000;
}

async function bootstrap(): Promise<JwtState> {
  const client = await getClientFingerprint();
  const proxyClient = getProxyClient();
  const res = await fetch(BOOTSTRAP_URL, {
    ...(proxyClient ? { client: proxyClient } : {}),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "mimocode/0.1.0",
    },
    body: JSON.stringify({ client }),
  });
  if (!res.ok) {
    throw new Error(`bootstrap failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { jwt?: string };
  if (!data.jwt) throw new Error("bootstrap response missing jwt");
  return { jwt: data.jwt, exp: parseJwtExpiry(data.jwt) };
}

const JWT_REFRESH_BUFFER_MS = 5 * 60_000;

async function getJwt(forceRefresh = false): Promise<string> {
  if (
    !forceRefresh && jwtCache &&
    jwtCache.exp - Date.now() > JWT_REFRESH_BUFFER_MS
  ) {
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

// Rotate to a different fingerprint and force a fresh JWT under that identity.
async function rotateAndRefreshJwt(): Promise<string> {
  await rotateFingerprint();
  jwtCache = null;
  bootstrapInflight = null;
  return await getJwt(true);
}

// Derive a stable session id from the system + first user message so that
// repeated turns of the same conversation reuse MiMo's server-side prompt
// cache (visible as cached_read_tokens in their tracking payloads).
async function deriveSessionId(
  req: Request,
  messages: ChatMessage[],
): Promise<string> {
  const provided = req.headers.get("x-session-affinity");
  if (provided) return provided;
  const seed = JSON.stringify(messages.slice(0, 2));
  return "ses_" + (await sha256Hex(seed)).slice(0, 24);
}

// MiMo's free-tier chat endpoint rejects (403 illegal_access) any request
// whose first message isn't a system message containing the MiMo identity
// string - it's how they scope the free tier to their own CLI.
// Prepend it so requests from other agent apps still pass the check while
// keeping the caller's own system prompt intact.
const MIMOCODE_SYSTEM_PROMPT =
  "You are MiMo Code Agent, built by Xiaomi MiMo Team. You are an interactive agent that helps users with software engineering tasks.";

function ensureMimoSystemPrompt(messages: ChatMessage[]): ChatMessage[] {
  const first = messages[0];
  if (
    first?.role === "system" && typeof first.content === "string" &&
    first.content.includes("MiMo")
  ) {
    return messages;
  }
  return [{ role: "system", content: MIMOCODE_SYSTEM_PROMPT }, ...messages];
}

function callMimo(
  jwt: string,
  mimoBody: unknown,
  sessionId: string,
): Promise<Response> {
  const proxyClient = getProxyClient();
  return fetch(CHAT_URL, {
    ...(proxyClient ? { client: proxyClient } : {}),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
      "User-Agent": USER_AGENT,
      "X-Mimo-Source": "mimocode-cli",
      "x-session-affinity": sessionId,
    },
    body: JSON.stringify(mimoBody),
  });
}

function sendTrackingEvent(
  sessionId: string,
  model: string,
  messages: ChatMessage[],
): void {
  const trackingBody = [
    {
      H: {
        event: "model_call",
        app_id: "31000402765",
        instance_id: crypto.randomUUID(),
        instance_id_type: "uuid",
        e_ts: Date.now(),
        uid: sessionId,
        uid_type: "session_id",
      },
      B: {
        finish_reason: "stop",
        ttft_ms: 0,
        latency_ms: Date.now(),
        cached_read_tokens: 0,
        model_id: model,
        provider: "mimo",
        total_tokens_in: messages.reduce(
          (acc, m) =>
            acc + (typeof m.content === "string" ? m.content.length : 0),
          0,
        ),
        total_tokens_out: 0,
      },
    },
  ];

  fetch(TRACKING_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "mimocode/0.1.0",
    },
    body: JSON.stringify(trackingBody),
  }).catch(() => {});
}

async function handleChatCompletion(req: Request): Promise<Response> {
  if (PROXY_API_KEY) {
    const authHeader = req.headers.get("authorization") || "";
    if (authHeader !== `Bearer ${PROXY_API_KEY}`) {
      return jsonError(401, "Invalid proxy API key", "auth_error");
    }
  }

  let body: ChatCompletionRequest;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "Invalid JSON body", "invalid_request_error");
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonError(
      400,
      "messages is required and must be non-empty",
      "invalid_request_error",
    );
  }

  const sessionId = await deriveSessionId(req, body.messages);
  const {
    model: _model,
    max_tokens,
    temperature,
    stream,
    stream_options,
    ...rest
  } = body;

  const mimoBody = {
    ...rest,
    model: "mimo-auto",
    max_tokens: max_tokens || 128000,
    temperature: temperature ?? 0.5,
    messages: ensureMimoSystemPrompt(body.messages),
    stream: stream !== false,
    stream_options: stream_options || { include_usage: true },
  };

  let jwt = await getJwt();
  let mimoRes = await callMimo(jwt, mimoBody, sessionId);

  // Unified retry/rotation loop for auth failures (401/403), rate limits (429),
  // and proxy errors (502/503) when IP rotation is active.
  for (let attempt = 0; attempt < MAX_PROXY_RETRIES + MAX_429_RETRIES; attempt++) {
    const retryable =
      mimoRes.status === 401 || mimoRes.status === 403 ||
      mimoRes.status === 429 ||
      (ENABLE_IP_ROTATION && (mimoRes.status === 502 || mimoRes.status === 503));

    if (!retryable) break;

    await mimoRes.body?.cancel();

    if (mimoRes.status === 401 || mimoRes.status === 403) {
      console.warn(`Auth failure (${mimoRes.status}), refreshing JWT...`);
      jwt = await getJwt(true);
    } else if (mimoRes.status === 429) {
      console.warn(`429 rate limited, rotating fingerprint (attempt ${attempt + 1})`);
      jwt = await rotateAndRefreshJwt();
    } else {
      console.warn(`Proxy/upstream error (${mimoRes.status}), rotating...`);
    }

    // Rotate proxy on any retryable error when IP rotation is active.
    if (ENABLE_IP_ROTATION && proxyPool && proxyPool.length > 1) {
      await rotateProxy();
    }

    mimoRes = await callMimo(jwt, mimoBody, sessionId);
  }

  if (!mimoRes.ok) {
    const errorText = await mimoRes.text();
    return new Response(errorText, {
      status: mimoRes.status,
      headers: {
        "Content-Type": mimoRes.headers.get("content-type") ||
          "application/json",
        ...CORS_HEADERS,
      },
    });
  }

  if (!mimoBody.stream) {
    const fullText = await mimoRes.text();
    return new Response(fullText, {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  sendTrackingEvent(sessionId, mimoBody.model, body.messages);

  return new Response(mimoRes.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...CORS_HEADERS,
    },
  });
}

function handleModels(): Response {
  return new Response(
    JSON.stringify({
      object: "list",
      data: [
        {
          id: "mimo-auto",
          object: "model",
          created: Date.now(),
          owned_by: "xiaomi",
          permission: [],
          root: "mimo-auto",
          parent: null,
        },
      ],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    },
  );
}

function handleHealth(): Response {
  return new Response(JSON.stringify({ status: "ok", service: "mimo-proxy" }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// Kick off proxy pool loading in background (non-blocking).
if (ENABLE_IP_ROTATION) {
  proxyInitPromise = loadProxyPool();
  proxyInitPromise.then((n) => {
    if (n > 0) console.warn(`IP rotation ready: ${n} proxies available`);
  }).catch((err) => {
    console.warn(`IP rotation disabled: ${err instanceof Error ? err.message : err}`);
    proxyPool = [];
  });
}

const port = parseInt(Deno.env.get("PORT") || String(DEFAULT_PORT));

Deno.serve(
  {
    port,
    onListen: ({ port }) => {
      console.log(`MiMo Proxy running on http://localhost:${port}`);
      console.log(
        `  POST /v1/chat/completions  - OpenAI-compatible chat endpoint`,
      );
      console.log(`  GET  /v1/models            - List available models`);
      console.log(`  GET  /health               - Health check`);
    },
  },
  async (req) => {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (
      req.method === "GET" &&
      (url.pathname === "/health" || url.pathname === "/")
    ) {
      return handleHealth();
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      return handleModels();
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      return handleChatCompletion(req);
    }

    return jsonError(404, "Not found", "invalid_request_error");
  },
);
