import type { MimoProviderModel } from './types.js';

/** OpenCode provider id. Used as the key in `config.provider` and `auth.provider`. */
export const PROVIDER_ID = 'mimo-free';

/** Display name shown in the OpenCode model picker. */
export const PROVIDER_NAME = 'MiMo (Free)';

/** AI SDK package OpenCode uses to talk to the (OpenAI-compatible) endpoint. */
export const PROVIDER_NPM = '@ai-sdk/openai-compatible';

/**
 * Upstream MiMo base host. Override with the `MIMO_BASE_URL` env var.
 * Trailing slashes are stripped so path joins stay clean.
 */
export const MIMO_BASE_URL = (process.env.MIMO_BASE_URL || 'https://api.xiaomimimo.com').replace(
  /\/+$/,
  '',
);

/**
 * baseURL handed to `@ai-sdk/openai-compatible`. The SDK appends
 * `/chat/completions`, producing `${MIMO_OPENAI_BASE_URL}/chat/completions`,
 * which the fetch interceptor rewrites to MiMo's real `/chat` endpoint.
 */
export const MIMO_OPENAI_BASE_URL = `${MIMO_BASE_URL}/api/free-ai/openai`;

/** Anonymous bootstrap endpoint that mints short-lived JWTs. */
export const MIMO_BOOTSTRAP_URL = `${MIMO_BASE_URL}/api/free-ai/bootstrap`;

/** MiMo's real chat endpoint (NOT `/chat/completions`). */
export const MIMO_CHAT_URL = `${MIMO_OPENAI_BASE_URL}/chat`;

/** Best-effort usage tracking endpoint used by the official CLI. */
export const MIMO_TRACKING_URL = 'https://tracking.miui.com/track/v4/o';

/** Mirrors the official MiMoCode CLI user agent. */
export const MIMO_USER_AGENT =
  'mimocode/0.1.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14';

/** The only model the free tier exposes. */
export const MIMO_MODEL_ID = 'mimo-auto';

export const DEFAULT_CONTEXT_LIMIT = 128_000;
export const DEFAULT_OUTPUT_LIMIT = 128_000;

/** Refresh the JWT this far before its expiry. */
export const JWT_REFRESH_BUFFER_MS = 5 * 60_000;

/**
 * The MiMo free-tier `/chat` endpoint returns 403 `illegal_access` unless the
 * first message is a system message containing this identity string — it's how
 * MiMo scopes the free tier to its own CLI. The interceptor prepends it.
 */
export const MIMOCODE_SYSTEM_PROMPT =
  'You are MiMoCode, an interactive CLI tool that helps users with software engineering tasks.';

/**
 * Provider model entry registered with OpenCode for `mimo-auto`.
 * mimo-auto routes to MiMo's best available model; it supports tools and
 * streaming. Reasoning/vision are left off since the router decides per-turn.
 */
export const MIMO_PROVIDER_MODEL: MimoProviderModel = {
  id: MIMO_MODEL_ID,
  name: 'MiMo Auto (Free)',
  release_date: '',
  attachment: false,
  reasoning: false,
  temperature: true,
  tool_call: true,
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: DEFAULT_CONTEXT_LIMIT, output: DEFAULT_OUTPUT_LIMIT },
  options: {},
};
