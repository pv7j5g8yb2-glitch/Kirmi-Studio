import { env } from "../config/env.js";
import type { Logger } from "../core/logger.js";
import type { TenantProfile } from "../core/types.js";
import { AGENT_TOOLS, SYSTEM_GUARDRAILS, type ToolSchema } from "./tools.schema.js";

/**
 * The LLM boundary.
 *
 * Narrow on purpose. The orchestrator depends on this interface, not on any
 * vendor SDK, which means the pipeline can be tested end to end with a scripted
 * model and no network, and the SLA tests can measure the engine's own latency
 * rather than a provider's.
 */

export interface LlmTurn {
  role: "user" | "assistant";
  content: string;
}

export interface LlmToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LlmResponse {
  /** Text to send, when the model is answering rather than calling a tool. */
  text: string | null;
  toolCalls: LlmToolCall[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "error";
}

export interface LlmRequest {
  system: string;
  turns: LlmTurn[];
  tools: ToolSchema[];
  /** Results of tools already executed this turn, fed back for the final reply. */
  toolResults?: Array<{ toolCallId: string; content: string; isError?: boolean }>;
}

export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/**
 * Build the system prompt for a tenant.
 *
 * Guardrails first, client personality second. Order matters: the client's own
 * tone notes should shape how the agent sounds, never what it is permitted to
 * do, and a prompt that opens with personality invites the model to weigh the
 * two against each other.
 */
export function buildSystemPrompt(tenant: TenantProfile, now: Date): string {
  const sections = [
    SYSTEM_GUARDRAILS,
    "",
    `Business: ${tenant.tradingName}.`,
    `Timezone: ${tenant.timezone}. Current time there: ${new Intl.DateTimeFormat("en-GB", {
      timeZone: tenant.timezone,
      dateStyle: "full",
      timeStyle: "short",
    }).format(now)}.`,
    `Currency: ${tenant.currency}. Languages you may reply in: ${tenant.languages.supported.join(", ")}.`,
    `Minimum driver age: ${tenant.qualification.minimumDriverAge}. Do not negotiate it, and do not quote a customer who is under it. Hand that conversation to a human.`,
  ];

  if (tenant.agent.displayName) sections.push(`You are ${tenant.agent.displayName}.`);
  if (tenant.agent.toneNotes) sections.push(`Tone: ${tenant.agent.toneNotes}`);
  if (tenant.agent.systemPromptExtra) sections.push(tenant.agent.systemPromptExtra);

  return sections.join("\n");
}

/**
 * The Anthropic backed client.
 *
 * Called through fetch rather than the SDK to keep the dependency surface of
 * this service small, and because the only shape needed is one non streaming
 * messages call with tools.
 */
export class AnthropicLlmClient implements LlmClient {
  constructor(private readonly log: Logger) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const config = env();
    const apiKey = config.ANTHROPIC_API_KEY;
    if (!apiKey) {
      this.log.error("ANTHROPIC_API_KEY is not configured");
      return { text: null, toolCalls: [], stopReason: "error" };
    }

    // A model call that outlives the reply budget is worse than no model call:
    // the customer is still waiting and the answer is going to be late anyway.
    const abort = AbortSignal.timeout(config.LLM_TIMEOUT_MS);

    const content: unknown[] = request.turns.map((t) => ({ role: t.role, content: t.content }));
    if (request.toolResults?.length) {
      content.push({
        role: "user",
        content: request.toolResults.map((r) => ({
          type: "tool_result",
          tool_use_id: r.toolCallId,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
        })),
      });
    }

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: abort,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: config.LLM_MODEL,
          max_tokens: 1024,
          system: request.system,
          tools: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema,
          })),
          messages: content,
        }),
      });

      if (!response.ok) {
        this.log.error({ status: response.status }, "LLM call failed");
        return { text: null, toolCalls: [], stopReason: "error" };
      }

      const body = (await response.json()) as {
        content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
        stop_reason?: string;
      };

      const text = (body.content ?? [])
        .filter((block) => block.type === "text" && block.text)
        .map((block) => block.text)
        .join("\n")
        .trim();

      const toolCalls: LlmToolCall[] = (body.content ?? [])
        .filter((block) => block.type === "tool_use" && block.id && block.name)
        .map((block) => ({ id: block.id as string, name: block.name as string, input: block.input ?? {} }));

      return {
        text: text.length > 0 ? text : null,
        toolCalls,
        stopReason: body.stop_reason === "tool_use" ? "tool_use" : "end_turn",
      };
    } catch (err) {
      this.log.error({ err }, "LLM call errored or timed out");
      return { text: null, toolCalls: [], stopReason: "error" };
    }
  }
}

export const DEFAULT_TOOLS = AGENT_TOOLS;
