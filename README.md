# mimo-free

An [OpenCode](https://opencode.ai) provider plugin for Xiaomi MiMo Code's free
`mimo-auto` model. It handles the anonymous bootstrap/JWT auth that the
[MiMo Code](https://github.com/XiaomiMiMo/MiMo-Code) CLI does internally, so you
get the free model inside OpenCode **without a MiMo account, an API key, or
running a separate proxy server**.

Modeled on [`opencode-omniroute-auth`](https://github.com/Alph4d0g/opencode-omniroute-auth),
but keyless — MiMo's free tier authenticates anonymously.

## How it differs from a proxy

Instead of pointing OpenCode at a local HTTP proxy, the plugin registers a
`mimo-free` provider whose **custom `fetch`** does everything inline:

1. Keeps a pool of anonymous fingerprints, persisted to `~/.mimo-free/fingerprints.json` (migrates the legacy `client-fingerprint` file).
2. Exchanges the active fingerprint for a short-lived anonymous JWT via `POST /api/free-ai/bootstrap`.
3. Rewrites the SDK's `…/chat/completions` call to MiMo's real `…/chat` endpoint.
4. Forces `model: "mimo-auto"`, prepends the required `MiMoCode` system prompt,
   and attaches the JWT + CLI headers.
5. Refreshes the JWT ~5 min before expiry or on a `401`/`403`, retrying once.
6. On `429` (rate limit) parks the current fingerprint with a cooldown, rotates to another fingerprint (minting a fresh one if the pool has room), re-bootstraps, and retries — up to `MAX_429_RETRIES` times.
7. When `ENABLE_IP_ROTATION` is set (on by default), routes outbound requests through a rotating pool of public HTTP proxies so MiMo sees a different egress IP on each rotation. Proxies are auto-tested, cached, and parked on cooldown after errors.

## Install

Published to npm as [`mimo-free-opencode-plugin`](https://www.npmjs.com/package/mimo-free-opencode-plugin)
— public, installs anonymously, no token needed. Reference it from your
`opencode.json`:

```jsonc
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["mimo-free-opencode-plugin"]
}
```

Or load a local build directly:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./path/to/mimo-free-opencode-plugin/dist/index.js"]
}
```

Build the plugin first:

```bash
npm install
npm run build
```

## Use

After OpenCode loads the plugin, pick the **MiMo Auto (Free)** model
(`mimo-free/mimo-auto`) from the model list — that's it.

If your OpenCode version requires a provider to be "connected" before use, run:

```
/connect mimo-free
```

choose **Anonymous — no key needed**, and just press **Enter** at the key prompt.
The plugin ignores whatever you type and authenticates anonymously.

## Environment variables

- `MIMO_BASE_URL` — override the upstream base URL (default `https://api.xiaomimimo.com`).
- `MAX_FINGERPRINTS` — max fingerprints kept in the rotation pool (default `8`).
- `FP_COOLDOWN_MS` — how long a rate-limited fingerprint is parked before reuse (default `3600000`, 1h).
- `MAX_429_RETRIES` — rotation+retry attempts per request on `429` (default `3`).

**IP rotation** (plugin + proxy server; set `ENABLE_IP_ROTATION=0` to disable):

- `PROXY_LIST_URL` — URL to fetch HTTP proxy list from (default: SpeedX public list).
- `MAX_PROXIES` — max proxies in the rotation pool (default `10`).
- `PROXY_COOLDOWN_MS` — cooldown for a proxy that returned an error (default `60000`, 1 min).
- `PROXY_TEST_TIMEOUT_MS` — TCP connect timeout when testing proxies (default `3000`).
- `PROXY_LIST_MAX_AGE_MS` — cache duration for downloaded proxy list (default `21600000`, 6h).
- `MAX_PROXY_RETRIES` — proxy rotation retries per request (default `3`).

**Proxy server only** (for `deno run -A proxy/server.ts`):

- `PROXY_API_KEY` — if set, callers must send `Authorization: Bearer <key>`.
- `PORT` — listen port (default `3000`).

## Public API

```ts
import MimoFreePlugin from "mimo-free-opencode-plugin";
// or named:
import { MimoFreePlugin } from "mimo-free-opencode-plugin";
```

Reusable runtime helpers (the same logic the plugin uses):

```ts
import {
  bootstrap,
  getJwt,
  createMimoFetch,
  ensureMimoSystemPrompt,
  PROVIDER_ID,
  MIMO_MODEL_ID,
} from "mimo-free-opencode-plugin/runtime";
```

## Standalone proxy (optional)

The original OpenAI-compatible proxy server still lives at
[`proxy/server.ts`](./proxy/server.ts) for anyone who wants a plain HTTP proxy
instead of the plugin:

```bash
deno run -A proxy/server.ts
```

It serves `POST /v1/chat/completions`, `GET /v1/models`, and `GET /health` on
port `3000` (override with `PORT`). Set `PROXY_API_KEY` to require callers to
send `Authorization: Bearer <key>`.

The proxy server supports the same fingerprint pool and IP rotation features
as the plugin — all environment variables listed above apply.

## License

MIT — see [LICENSE](./LICENSE).
