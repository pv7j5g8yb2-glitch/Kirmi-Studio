import type { LlmClient, LlmRequest, LlmResponse } from "../../src/orchestrator/llm.client.js";

/**
 * A scripted model.
 *
 * Two reasons the SLA tests use this rather than a real API call. It makes the
 * measurement reproducible, and it measures what is actually ours: if a reply
 * takes eleven seconds because a provider was slow, that is worth knowing but
 * it is not a regression in this codebase. The configured delay stands in for
 * the provider so the rest of the pipeline is measured honestly against the
 * remaining budget.
 */
export class ScriptedLlm implements LlmClient {
  public readonly calls: LlmRequest[] = [];

  constructor(
    private readonly script: LlmResponse[],
    /** Simulated provider latency per call, in ms. */
    private readonly delayMs = 0,
  ) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.calls.push(request);
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));

    const next = this.script[Math.min(this.calls.length - 1, this.script.length - 1)];
    return next ?? { text: null, toolCalls: [], stopReason: "error" };
  }
}

export const plainReply = (text: string): LlmResponse => ({ text, toolCalls: [], stopReason: "end_turn" });

export const toolCall = (name: string, input: Record<string, unknown>): LlmResponse => ({
  text: null,
  toolCalls: [{ id: `call_${name}`, name, input }],
  stopReason: "tool_use",
});
