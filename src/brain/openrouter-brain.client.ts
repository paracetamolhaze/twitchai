import { Logger } from '../logger';
import {
  BrainInteractionClient,
  BrainInteractionRequest,
  BrainInteractionResponse,
} from './gemini-brain.service';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
}

interface ChatCompletionResponse {
  id?: string;
  error?: { message?: string; code?: number; metadata?: { raw?: string; provider_name?: string } };
  choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

export interface OpenRouterBrainClientOptions {
  apiKey: string;
  logger: Logger;
  /** Sent to OpenRouter for attribution; both are optional and purely cosmetic. */
  appUrl?: string;
  appName?: string;
  /** Conversations retained locally. Only the newest chain is ever continued. */
  maxRetainedChains?: number;
  fetchImpl?: typeof fetch;
}

/**
 * The stateful Brain over an API that has no state.
 *
 * Gemini's Interactions API keeps the conversation on Google's side and takes only the new turn,
 * which is why the service passes an opaque id around. Chat Completions has no such thing, so the
 * conversation is rebuilt here and the same contract is kept: an id goes out, and quoting it back
 * continues that exact conversation. Nothing above this file knows the difference.
 *
 * The persona block sent at bootstrap is the one part that never changes for the whole stream, so
 * it carries the cache breakpoint. Reading it back costs a tenth of writing it, which is what
 * makes a per-event decision affordable at all.
 */
export class OpenRouterBrainClient implements BrainInteractionClient {
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetainedChains: number;
  /** Conversation as it stood after the interaction of that id. */
  private readonly chains = new Map<string, ChatMessage[]>();

  constructor(private readonly options: OpenRouterBrainClientOptions) {
    this.logger = options.logger.child('BRAIN');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetainedChains = options.maxRetainedChains ?? 40;
  }

  async create(request: BrainInteractionRequest): Promise<BrainInteractionResponse> {
    const messages = this.buildMessages(request);
    const response = await this.fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json',
        ...(this.options.appUrl ? { 'HTTP-Referer': this.options.appUrl } : {}),
        ...(this.options.appName ? { 'X-Title': this.options.appName } : {}),
      },
      body: JSON.stringify({
        model: request.model,
        messages,
        response_format: {
          type: 'json_schema',
          json_schema: { name: request.kind, strict: true, schema: request.responseSchema },
        },
        reasoning: { effort: request.thinkingLevel },
        max_tokens: request.maxOutputTokens,
        // Routing only to endpoints that actually enforce the schema. Without this the request can
        // land somewhere that treats it as a suggestion, and a decision that does not parse is a
        // decision lost after it was paid for.
        provider: { require_parameters: true },
      }),
    });

    const body = await response.json() as ChatCompletionResponse;
    if (!response.ok || body.error) {
      // Kept in the shape the service already recognises: it tells a rate limit, an empty balance
      // and a refused prompt apart by reading the message, and each has its own handling. The
      // provider's own words are appended because the gateway's are generic to the point of
      // useless — "400 Provider returned error" was the only thing reported while every decision
      // on a live stream failed, and the reason it hid was a single unsupported keyword.
      throw new Error(`${response.status} ${body.error?.message ?? response.statusText}${providerDetail(body)}`);
    }
    const choice = body.choices?.[0];
    const outputText = choice?.message?.content ?? undefined;
    const id = body.id ?? `local-${Date.now()}`;
    if (outputText) this.remember(id, messages, outputText);

    const usage = body.usage;
    const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    return {
      id,
      // The service treats anything other than 'completed' as unusable, and a truncated answer is
      // exactly that: valid JSON is impossible once the model was cut off mid-object.
      status: choice?.finish_reason === 'length' ? 'incomplete' : 'completed',
      ...(outputText !== undefined ? { outputText } : {}),
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        cachedInputTokens: cached,
        outputTokens: Math.max(0, (usage?.completion_tokens ?? 0) - reasoning),
        thoughtTokens: reasoning,
        totalTokens: usage?.total_tokens ?? 0,
        ...(typeof usage?.cost === 'number' ? { costUsd: usage.cost } : {}),
      },
    };
  }

  private buildMessages(request: BrainInteractionRequest): ChatMessage[] {
    const previous = request.previousInteractionId
      ? this.chains.get(request.previousInteractionId)
      : undefined;
    if (request.previousInteractionId && !previous) {
      // The service already knows how to recover from a chain it cannot continue: it rebuilds the
      // session. Saying so plainly beats silently answering with no memory of the stream.
      this.logger.warn('Brain conversation is no longer retained; the session will be rebuilt', {
        previousInteractionId: request.previousInteractionId,
      });
      throw new Error('previous interaction not found');
    }
    if (previous) return [...previous, { role: 'user', content: request.input }];

    return [
      { role: 'system', content: request.systemInstruction },
      {
        role: 'user',
        // The breakpoint sits on the opening turn because that is the only content guaranteed
        // identical for the rest of the stream — every later turn differs by definition.
        content: [{ type: 'text', text: request.input, cache_control: { type: 'ephemeral' } }],
      },
    ];
  }

  private remember(id: string, messages: ChatMessage[], outputText: string): void {
    this.chains.set(id, [...messages, { role: 'assistant', content: outputText }]);
    while (this.chains.size > this.maxRetainedChains) {
      const oldest = this.chains.keys().next().value;
      if (oldest === undefined) break;
      this.chains.delete(oldest);
    }
  }
}

/** The upstream error text OpenRouter wraps, unwrapped far enough to name the actual problem. */
function providerDetail(body: ChatCompletionResponse): string {
  const raw = body.error?.metadata?.raw;
  if (!raw) return '';
  let detail = raw;
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    detail = parsed.error?.message ?? raw;
  } catch { /* not JSON; the text itself is the detail */ }
  const provider = body.error?.metadata?.provider_name;
  return ` — ${provider ? `${provider}: ` : ''}${detail.slice(0, 300)}`;
}
