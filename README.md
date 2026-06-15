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

1. Generates a per-install fingerprint, persisted to `~/.mimo-free/client-fingerprint`.
2. Exchanges it for a short-lived anonymous JWT via `POST /api/free-ai/bootstrap`.
3. Rewrites the SDK's `…/chat/completions` call to MiMo's real `…/chat` endpoint.
4. Forces `model: "mimo-auto"`, prepends the required `MiMoCode` system prompt,
   and attaches the JWT + CLI headers.
5. Refreshes the JWT ~5 min before expiry or on a `401`/`403`, retrying once.

## Install

From npm (once published):

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
  "plugin": ["./path/to/mimo-free/dist/index.js"]
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

## License

MIT — see [LICENSE](./LICENSE).
