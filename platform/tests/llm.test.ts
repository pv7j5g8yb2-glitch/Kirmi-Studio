import { describe, it, expect, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { verifyGrounding, allowedFigures, claimedFigures } from "../src/engine/llm/grounding.js";
import { runAgent, systemPrompt, type AgentTurn } from "../src/engine/llm/agent.js";
import { TOOL_SCHEMAS } from "../src/engine/llm/tools.js";
import { resetEnvCache } from "../src/config/env.js";

/**
 * These cover the two things that decide whether a model is safe in front of a
 * client's customers: it cannot state a figure no tool produced, and a provider
 * failure cannot take the inbox down.
 */

beforeEach(() => {
  process.env.DATABASE_URL ??= "postgres://unused/unused";
  process.env.LLM_PROVIDER = "anthropic";
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.ANTHROPIC_MODEL = "claude-opus-5";
  resetEnvCache();
});

describe("grounding", () => {
  const quote = { known: true, total: 787_500, deposit: 500_000, days: 3, includedKmPerDay: 250, currency: "AED" };

  it("accepts a price that came from a tool, in major units", () => {
    const reply = "Mercedes-Benz G63 AMG for 3 days: AED 7,875 including VAT. Deposit AED 5,000, 250 km a day.";
    expect(verifyGrounding(reply, [quote], ["how much is the g63 for 3 days"]).grounded).toBe(true);
  });

  it("rejects a price no tool returned", () => {
    const reply = "The G63 is AED 6,200 for 3 days.";
    const check = verifyGrounding(reply, [quote], ["how much is the g63 for 3 days"]);
    expect(check.grounded).toBe(false);
    expect(check.ungrounded).toContain("6200");
  });

  it("rejects an invented fee even when the rest of the reply is true", () => {
    const reply = "AED 7,875 including VAT, plus an AED 350 cleaning charge.";
    expect(verifyGrounding(reply, [quote], []).grounded).toBe(false);
  });

  it("allows a figure the customer supplied", () => {
    const reply = "Nothing under AED 1,000 a day in that category.";
    expect(verifyGrounding(reply, [], ["my budget is 1000 a day"]).grounded).toBe(true);
  });

  it("does not fire on small bare numbers like day and seat counts", () => {
    const reply = "It seats 7 and goes out for 2 days minimum.";
    expect(verifyGrounding(reply, [], []).grounded).toBe(true);
  });

  it("reads figures out of tool result strings, not just numeric fields", () => {
    const search = { known: true, matches: [{ label: "Mercedes-Benz G63 AMG 2024" }] };
    expect(verifyGrounding("We have the G63 AMG 2024.", [search], []).grounded).toBe(true);
  });

  it("treats 7875 and 7,875.00 as the same claim", () => {
    expect(allowedFigures([{ total: 787_500 }], []).has("7875")).toBe(true);
    expect(claimedFigures("AED 7,875.00 total")).toContain("7875");
  });
});

/** A stub standing in for the Messages API, so no test ever reaches the network. */
function stubClient(script: Array<Partial<Anthropic.Message>>): Anthropic {
  let n = 0;
  return {
    messages: {
      create: async () => {
        const next = script[n] ?? script[script.length - 1];
        n++;
        return { stop_reason: "end_turn", content: [], ...next } as Anthropic.Message;
      },
    },
  } as unknown as Anthropic;
}

const ctx = { db: null as never, tenantId: "t1", now: new Date("2026-09-13T10:00:00Z"), enquiryId: null };
const history: AgentTurn[] = [{ role: "customer", text: "how much is the g63 for 3 days from tomorrow" }];

describe("agent", () => {
  it("sends a reply the model grounded in tool results", async () => {
    const client = stubClient([
      { stop_reason: "end_turn", content: [{ type: "text", text: "Hello, which car are you after?", citations: null } as never] },
    ]);
    const out = await runAgent(client, ctx, "DEIZ Rental", history);
    expect(out.reply).toBe("Hello, which car are you after?");
    expect(out.groundingFailed).toBe(false);
  });

  it("refuses to send a draft carrying an invented price, and escalates instead", async () => {
    const client = stubClient([
      { stop_reason: "end_turn", content: [{ type: "text", text: "That is AED 6,200 for 3 days.", citations: null } as never] },
    ]);
    const out = await runAgent(client, ctx, "DEIZ Rental", history);
    expect(out.reply).toBeNull();
    expect(out.groundingFailed).toBe(true);
    expect(out.escalate?.reason).toMatch(/ungrounded/);
  });

  it("escalates when the model declines", async () => {
    const client = stubClient([{ stop_reason: "refusal", content: [] }]);
    const out = await runAgent(client, ctx, "DEIZ Rental", history);
    expect(out.reply).toBeNull();
    expect(out.escalate?.reason).toMatch(/declined/);
  });

  it("stops rather than looping forever when the model keeps calling tools", async () => {
    const client = stubClient([
      {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t", name: "rental_rules", input: {} } as never],
      },
    ]);
    const out = await runAgent(client, { ...ctx, db: { query: async () => ({ rows: [] }) } as never }, "DEIZ Rental", history);
    expect(out.reply).toBeNull();
    expect(out.iterations).toBe(8);
    expect(out.escalate?.reason).toMatch(/tool budget/);
  });
});

describe("prompt and tool surface", () => {
  it("forbids stating anything a tool did not return", () => {
    const p = systemPrompt("DEIZ Rental", new Date("2026-09-13T10:00:00Z"));
    expect(p).toMatch(/Never state a price/);
    expect(p).toMatch(/escalate_to_human/);
    expect(p).toMatch(/DEIZ Rental/);
  });

  it("gives the model no way to learn a price except the quote tool", () => {
    const names = TOOL_SCHEMAS.map((t) => t.name);
    expect(names).toContain("quote");
    expect(names).toContain("escalate_to_human");
    // Every tool is read-only or an escalation. Nothing here can charge a customer.
    expect(names).not.toContain("take_payment");
    expect(names).not.toContain("confirm_reservation");
  });
});
