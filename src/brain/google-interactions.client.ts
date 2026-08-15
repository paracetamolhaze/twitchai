import { GoogleGenAI } from '@google/genai';
import {
  BrainInteractionClient,
  BrainInteractionRequest,
  BrainInteractionResponse,
} from './gemini-brain.service';

/** Production adapter for Gemini's stateful Interactions API. */
export class GoogleInteractionsClient implements BrainInteractionClient {
  private readonly ai: GoogleGenAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async create(request: BrainInteractionRequest): Promise<BrainInteractionResponse> {
    const response = await this.ai.interactions.create({
      model: request.model,
      input: request.input,
      ...(request.previousInteractionId ? { previous_interaction_id: request.previousInteractionId } : {}),
      system_instruction: request.systemInstruction,
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema: request.responseSchema,
      },
      generation_config: {
        thinking_level: request.thinkingLevel,
        max_output_tokens: request.maxOutputTokens,
      },
      store: request.store,
    });
    const usage = response.usage;
    return {
      id: response.id,
      status: response.status,
      outputText: response.output_text,
      usage: {
        inputTokens: usage?.total_input_tokens ?? 0,
        cachedInputTokens: usage?.total_cached_tokens ?? 0,
        outputTokens: usage?.total_output_tokens ?? 0,
        thoughtTokens: usage?.total_thought_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? 0,
      },
    };
  }
}
