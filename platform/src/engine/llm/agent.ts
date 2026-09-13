import Anthropic from "@anthropic-ai/sdk";
import type { ToolContext } from "../tools.js";
import { TOOL_SCHEMAS, dispatchTool } from "./tools.js";
import { verifyGrounding } from "./grounding.js";
import { env } from "../../config/env.js";

/**
 * The conversation layer. The model decides what to say; the tools decide what is true.
 *
 * Two things keep this safe enough to put in front of a paying client's customers:
 * the model can only learn facts by calling a tool, and every draft reply is checked
 * against those tool results before it is sent. A draft carrying a figure no tool
 * produced is discarded and the conversation goes to a person.
 */

const MAX_ITERATIONS = 8;

export type AgentTurn = { role: "customer" | "assistant"; text: string };

export type AgentResult = {
  reply: string | null;
  escalate: { reason: string } | null;
  toolsUsed: string[];
  /** True when a draft was thrown away because it stated something no tool returned. */
  groundingFailed: boolean;
  iterations: number;
};

export function systemPrompt(companyName: string, now: Date): string {
  return [
    `You are the assistant that answers inbound enquiries for ${companyName}, a car rental company in Dubai.`,
    `You answer on WhatsApp and Instagram, where customers write the way they speak.`,
    `The current date and time is ${now.toISOString()}. Resolve "tomorrow", "next Friday" and "the weekend" against it.`,
    ``,
    `WHAT YOU ARE FOR`,
    `Understand what the customer actually needs, recommend the right car, price it, and offer to hold it.`,
    `A customer who says "I don't know which one suits me" is the normal case, not an edge case. Ask what the`,
    `car is for and roughly their budget a day, then recommend two or three with a reason for each.`,
    ``,
    `HARD RULES, IN ORDER OF IMPORTANCE`,
    `1. Never state a price, deposit, fee, mileage allowance, availability, age limit, document requirement or`,
    `   any other policy unless a tool in this conversation returned it. You have no knowledge of this company`,
    `   beyond what the tools give you. If a tool does not have it, call escalate_to_human.`,
    `2. Never name a vehicle you have not seen in a search_vehicles or list_available result.`,
    `3. Never say a car is available without calling check_availability or list_available.`,
    `4. Never quote a price without calling quote.`,
    `5. If the customer complains about a past rental, asks for a corporate or custom rate, raises anything`,
    `   legal or insurance related, or is angry, call escalate_to_human immediately. Do not negotiate.`,
    `6. If a rule blocks the sale, say so plainly and offer what they can have instead. Do not sell them a car`,
    `   the rules do not allow.`,
    ``,
    `HOW TO WRITE`,
    `Reply in the customer's own language. If they wrote in Arabic, reply in Arabic. Use Western numerals`,
    `(1, 2, 3) in both languages.`,
    `Short. Usually one to three sentences, the length a person would actually type on WhatsApp.`,
    `Plain and human. No corporate phrasing, no "I hope this message finds you well", no exclamation marks.`,
    `Never use dashes as punctuation. Use a comma or a full stop.`,
    `Only use a list when you are showing more than one car, and keep each line to the car, the daily rate and`,
    `one short reason it might suit them.`,
    `End on the single next thing you need from them, phrased so they can answer in a few words.`,
  ].join("\n");
}

let cached: Anthropic | null = null;

/** Null when no key is configured, which is how the platform falls back to the deterministic engine. */
export function anthropicClient(): Anthropic | null {
  const cfg = env();
  if (cfg.LLM_PROVIDER !== "anthropic") return null;
  if (!cfg.ANTHROPIC_API_KEY) return null;
  if (!cached) cached = new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY });
  return cached;
}

/** Test seam: inject a stub client without touching the environment. */
export function setAnthropicClient(client: Anthropic | null): void {
  cached = client;
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text.trim())
    .join("\n")
    .trim();
}

export async function runAgent(
  client: Anthropic,
  ctx: ToolContext & { enquiryId: string | null },
  companyName: string,
  history: AgentTurn[],
): Promise<AgentResult> {
  const cfg = env();
  const now = ctx.now ?? new Date();
  const toolsUsed: string[] = [];
  const toolResults: unknown[] = [];
  const customerTexts = history.filter((h) => h.role === "customer").map((h) => h.text);

  const messages: Anthropic.MessageParam[] = history.map((h) => ({
    role: h.role === "customer" ? ("user" as const) : ("assistant" as const),
    content: h.text,
  }));

  let escalate: { reason: string } | null = null;
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const response = await client.messages.create({
      model: cfg.ANTHROPIC_MODEL,
      max_tokens: 2000,
      system: [{ type: "text", text: systemPrompt(companyName, now), cache_control: { type: "ephemeral" } }],
      tools: TOOL_SCHEMAS,
      messages,
    });

    if (response.stop_reason === "refusal") {
      return { reply: null, escalate: { reason: "model declined to answer" }, toolsUsed, groundingFailed: false, iterations };
    }

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

    if (!toolUses.length) {
      const draft = textOf(response);
      if (!draft) {
        return { reply: null, escalate: { reason: "model produced no reply" }, toolsUsed, groundingFailed: false, iterations };
      }
      const check = verifyGrounding(draft, toolResults, customerTexts);
      if (!check.grounded) {
        // The model stated a figure no tool produced. Never send it.
        return {
          reply: null,
          escalate: { reason: `ungrounded figures in draft: ${check.ungrounded.join(", ")}` },
          toolsUsed,
          groundingFailed: true,
          iterations,
        };
      }
      return { reply: draft, escalate, toolsUsed, groundingFailed: false, iterations };
    }

    messages.push({ role: "assistant", content: response.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of toolUses) {
      toolsUsed.push(call.name);
      const out = await dispatchTool(ctx, call.name, (call.input ?? {}) as Record<string, unknown>);
      if (out.escalate) escalate = { reason: out.escalate };
      toolResults.push(out.result);
      results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(out.result) });
    }
    // All results from one assistant turn go back in a single user message.
    messages.push({ role: "user", content: results });
  }

  return {
    reply: null,
    escalate: { reason: "conversation did not resolve within the tool budget" },
    toolsUsed,
    groundingFailed: false,
    iterations,
  };
}
