import type { ChatMessage } from '../domain/narration';
import type { privacyLog as PrivacyLogType } from '../services/privacy-log';

export type CompletionOpts = {
  max_tokens?: number;
  temperature?: number;
  /** Stop tokens. Model halts generation as soon as any is produced. */
  stop?: string | string[];
};

/** Per-turn inference timing, populated after each completion finishes. */
export type LLMStats = {
  prefill_tokens: number;
  decode_tokens: number;
  prefill_tokps: number;
  decode_tokps: number;
  /** Raw WebLLM runtimeStatsText() output for debugging. */
  raw: string;
};

export interface LLMAdapter {
  readonly ready: boolean;
  load(onProgress: (msg: string) => void): Promise<void>;
  probeWebGPU(): Promise<{ ok: boolean; info: string }>;
  completion(messages: ChatMessage[], opts?: CompletionOpts): AsyncIterable<string>;
  /** Stats from the most recent completion, or null before any have run. */
  getLastStats(): LLMStats | null;
}

export class WebLLMGraniteAdapter implements LLMAdapter {
  private engine: unknown = null;
  private _ready = false;
  private _lastStats: LLMStats | null = null;

  constructor(private log: typeof PrivacyLogType) {}

  get ready(): boolean { return this._ready; }

  getLastStats(): LLMStats | null { return this._lastStats; }

  async probeWebGPU(): Promise<{ ok: boolean; info: string }> {
    if (!('gpu' in navigator)) return { ok: false, info: 'no navigator.gpu. Use Chrome or Edge' };
    try {
      const gpu = (navigator as unknown as { gpu: { requestAdapter(): Promise<{ limits?: { maxStorageBuffersPerShaderStage?: number } } | null> } }).gpu;
      const adapter = await gpu.requestAdapter();
      if (!adapter) return { ok: false, info: 'no WebGPU adapter' };
      const limit = adapter.limits?.maxStorageBuffersPerShaderStage ?? 8;
      if (limit < 10) return { ok: false, info: `WebGPU: ${limit}/10 storage buffers. Need Chrome/Edge` };
      return { ok: true, info: `WebGPU ok (${limit} buffers)` };
    } catch (e) {
      return { ok: false, info: 'WebGPU probe failed: ' + (e as Error).message };
    }
  }

  async load(onProgress: (msg: string) => void): Promise<void> {
    const webllm = await import('@mlc-ai/web-llm');
    const modelId = 'Granite-4.0-1b-q4f32_1-LOCAL';

    // Dev: Vite plugin serves shards from local disk at /granite-1b/
    // Prod: shards are hosted in the HF model repo and fetched once, cached in IndexedDB
    const HF_MODEL_BASE = 'https://huggingface.co/msradam/Granite-4.0-1b-q4f32_1-MLC/resolve/main/';
    const origin = window.location.origin;
    const modelUrl = import.meta.env.PROD ? HF_MODEL_BASE : `${origin}/granite-1b/`;
    const modelLib = import.meta.env.PROD
      ? `${HF_MODEL_BASE}granite-4_0-1b-q4f32_1-webgpu.wasm`
      : `${origin}/granite-1b/granite-4_0-1b-q4f32_1-webgpu.wasm`;

    this.log.z3(modelUrl, 'Granite 4.0 1B model weights (WebGPU, cached in IndexedDB)');

    const localModels = {
      [modelId]: {
        model: modelUrl,
        model_id: modelId,
        model_lib: modelLib,
        vram_required_MB: 1800,
        low_resource_required: false,
        // Tuned for Ariadne's two-turn pattern:
        //   Turn 1 (tool extraction): system prompt ~1.1k tokens + user ~30 tokens
        //   Turn 2 (grounded summary): grounding docs ~500 tokens + user ~30 tokens
        // Both fit well under 2048. Prefill_chunk_size MUST equal context_window_size
        // to avoid the mlc-llm #3057 infinite-loop bug. Larger chunk = fewer WebGPU
        // dispatches = less overhead on mobile where dispatch dominates.
        overrides: {
          context_window_size: 2048,
          prefill_chunk_size: 2048,
        },
      },
    };
    const prebuilt = webllm.prebuiltAppConfig;
    this.engine = await webllm.CreateMLCEngine(modelId, {
      appConfig: {
        ...prebuilt,
        useIndexedDBCache: true,
        model_list: [localModels[modelId], ...prebuilt.model_list],
      },
      initProgressCallback: (r: { text?: string; progress?: number }) =>
        onProgress(r.text || `${Math.round((r.progress || 0) * 100)}%`),
    });
    this._ready = true;
  }

  async *completion(
    messages: ChatMessage[],
    opts?: CompletionOpts,
  ): AsyncIterable<string> {
    if (!this.engine) throw new Error('LLM not loaded');
    const eng = this.engine as {
      chat: { completions: { create(o: unknown): Promise<AsyncIterable<{ choices: Array<{ delta: { content?: string } }> }>> } };
      runtimeStatsText?(): Promise<string>;
    };
    const stream = await eng.chat.completions.create({
      messages,
      stream: true,
      max_tokens: opts?.max_tokens ?? 256,
      temperature: opts?.temperature ?? 0,
      ...(opts?.stop ? { stop: opts.stop } : {}),
    });
    for await (const chunk of stream) {
      yield chunk.choices?.[0]?.delta?.content ?? '';
    }

    // Capture runtime stats after the stream finishes. Surfaces tokens-per-second
    // for both prefill and decode phases. Needed to know whether mobile slowness
    // is prefill-bound (system-prompt cost) or decode-bound (output length).
    try {
      const raw = await eng.runtimeStatsText?.();
      if (raw) {
        this._lastStats = parseRuntimeStats(raw);
        // Console for live debugging; UI consumers read getLastStats().
        // eslint-disable-next-line no-console
        console.info('[WebLLM]', raw);
      }
    } catch { /* stats are best-effort */ }
  }
}

/**
 * Parse WebLLM's runtimeStatsText() output. Format (as of @mlc-ai/web-llm 0.2):
 *   "prefill: 123.4 tokens/sec, decode: 56.7 tokens/sec"
 * sometimes with explicit token counts:
 *   "prefill: 100 tok / 0.81 s = 123.4 tok/s, decode: ..."
 * We tolerate both shapes.
 */
function parseRuntimeStats(raw: string): LLMStats {
  const num = (rx: RegExp): number => {
    const m = raw.match(rx);
    return m ? parseFloat(m[1]) : 0;
  };
  return {
    prefill_tokens: num(/prefill:\s*(\d+(?:\.\d+)?)\s*tok\b/i),
    decode_tokens:  num(/decode:\s*(\d+(?:\.\d+)?)\s*tok\b/i),
    prefill_tokps:  num(/prefill:[^,]*?(\d+(?:\.\d+)?)\s*tok(?:ens)?\/s/i),
    decode_tokps:   num(/decode:[^,]*?(\d+(?:\.\d+)?)\s*tok(?:ens)?\/s/i),
    raw,
  };
}
