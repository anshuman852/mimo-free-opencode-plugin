import type { Plugin } from '@opencode-ai/plugin';
import {
  MIMO_OPENAI_BASE_URL,
  MIMO_PROVIDER_MODEL,
  MIMO_MODEL_ID,
  PROVIDER_ID,
  PROVIDER_NAME,
  PROVIDER_NPM,
} from './constants.js';
import { createMimoFetch } from './mimo.js';

// A placeholder credential. MiMo's free tier needs no real key — the actual
// (anonymous, short-lived) JWT is minted and attached inside createMimoFetch().
// But `@ai-sdk/openai-compatible` insists on *some* apiKey, and setting one here
// also lets OpenCode treat the provider as ready without a `/connect` step.
const PLACEHOLDER_API_KEY = 'mimo-free';

/**
 * OpenCode plugin that registers a keyless `mimo-free` provider exposing
 * Xiaomi MiMo Code's free `mimo-auto` model.
 *
 * Two registration paths are used so it works across OpenCode versions:
 *   1. `config` hook — declares the provider (npm, baseURL, placeholder key,
 *      custom fetch, model) so it shows up and is usable with zero config.
 *   2. `auth` hook  — a keyless loader that (re-)injects the bootstrap fetch
 *      for versions that resolve provider options through auth, and lets users
 *      `/connect mimo-free` (just press Enter at the key prompt) if needed.
 */
export const MimoFreePlugin: Plugin = async () => {
  return {
    config: async (config: Record<string, any>) => {
      const providers = config.provider ?? {};
      const existing = providers[PROVIDER_ID] ?? {};

      providers[PROVIDER_ID] = {
        ...existing,
        name: existing.name ?? PROVIDER_NAME,
        npm: existing.npm ?? PROVIDER_NPM,
        options: {
          ...(existing.options ?? {}),
          baseURL: MIMO_OPENAI_BASE_URL,
          apiKey: existing.options?.apiKey ?? PLACEHOLDER_API_KEY,
          // In-process function reference; survives because plugin config is
          // kept in memory rather than round-tripped through JSON.
          fetch: createMimoFetch(),
        },
        models: {
          ...(existing.models ?? {}),
          [MIMO_MODEL_ID]: {
            ...MIMO_PROVIDER_MODEL,
            ...(existing.models?.[MIMO_MODEL_ID] ?? {}),
          },
        },
      };

      config.provider = providers;
    },

    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: 'api',
          label: 'Anonymous — no key needed, just press Enter',
        },
      ],
      // Keyless on purpose: ignore whatever (if anything) the user typed and
      // always return the bootstrap-aware fetch.
      loader: async () => {
        return {
          apiKey: PLACEHOLDER_API_KEY,
          baseURL: MIMO_OPENAI_BASE_URL,
          fetch: createMimoFetch(),
        };
      },
    },
  } as any;
};
