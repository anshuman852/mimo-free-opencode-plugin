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
} from './constants.js';
import type { ChatCompletionRequest, ChatMessage, JwtState } from './types.js';

const DATA_DIR = join(homedir(), '.mimo-free');
const FINGERPRINT_FILE = join(DATA_DIR, 'client-fingerprint');

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

// ---------------------------------------------------------------------------
// Per-install fingerprint
//
// MiMo's bootstrap binds the issued JWT to a per-install fingerprint. Persist
// it so we keep reusing the same identity across restarts instead of looking
// like a brand-new client on every run.
// ---------------------------------------------------------------------------

let fingerprintCache: string | undefined;

export async function getClientFingerprint(): Promise<string> {
  if (fingerprintCache) return fingerprintCache;
  try {
    const existing = (await readFile(FINGERPRINT_FILE, 'utf-8')).trim();
    if (existing) {
      fingerprintCache = existing;
      return existing;
    }
  } catch {
    // Missing/unreadable file: fall through and mint a new fingerprint.
  }
  const seed = [platform(), arch(), crypto.randomUUID()].join('|');
  const fingerprint = await sha256Hex(seed);
  fingerprintCache = fingerprint;
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(FINGERPRINT_FILE, fingerprint);
  } catch {
    // Persisting is best-effort; an in-memory fingerprint still works.
  }
  return fingerprint;
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
  const res = await fetch(MIMO_BOOTSTRAP_URL, {
    method: 'POST',
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
 * Ensure the first message is a system message containing the MiMoCode identity
 * string. Without it the free-tier endpoint returns 403 `illegal_access`.
 */
export function ensureMimoSystemPrompt(messages: ChatMessage[]): ChatMessage[] {
  const first = messages[0];
  if (
    first?.role === 'system' &&
    typeof first.content === 'string' &&
    first.content.includes('MiMoCode')
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

function callMimo(jwt: string, mimoBody: unknown, sessionId: string): Promise<Response> {
  return fetch(MIMO_CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
      'User-Agent': MIMO_USER_AGENT,
      'X-Mimo-Source': 'mimocode-cli-free',
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
 *   - forces `model: "mimo-auto"` and the MiMoCode system prompt,
 *   - bootstraps/attaches an anonymous JWT and the CLI headers,
 *   - retries once with a fresh JWT on 401/403.
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

    if (res.status === 401 || res.status === 403) {
      jwt = await getJwt(true);
      res = await callMimo(jwt, mimoBody, sessionId);
    }

    if (res.ok && isStreaming) {
      sendTrackingEvent(sessionId, MIMO_MODEL_ID, messages);
    }

    return res;
  }) as typeof fetch;
}
