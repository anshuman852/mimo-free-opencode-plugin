/** A single chat message in an OpenAI-style request body. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  [key: string]: unknown;
}

/** OpenAI-style chat completion request body (only the fields we touch). */
export interface ChatCompletionRequest {
  model?: string;
  messages?: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  [key: string]: unknown;
}

/** Cached anonymous JWT plus its expiry (ms epoch). */
export interface JwtState {
  jwt: string;
  exp: number;
}

/**
 * Provider model entry as understood by OpenCode's `config.provider[id].models`.
 * This is a pragmatic subset — extra fields are accepted by OpenCode.
 */
export interface MimoProviderModel {
  id: string;
  name: string;
  release_date?: string;
  attachment?: boolean;
  reasoning?: boolean;
  temperature?: boolean;
  tool_call?: boolean;
  cost?: {
    input: number;
    output: number;
    cache?: { read: number; write: number };
  };
  limit?: {
    context: number;
    output: number;
  };
  options?: Record<string, unknown>;
}
