import { describe, expect, it } from "vitest";
import { classify } from "../../src/services/attribution.service.js";

/**
 * The commission rule.
 *
 * This is the only code in the engine whose output is an invoice to a client,
 * so the boundary cases are the ones worth pinning down. Every case below is a
 * real argument somebody could have at the end of a month.
 */

const QUOTED = new Date("2026-09-14T10:00:00Z");
const conv = (takeoverAt: Date | null) => ({ takeoverAt });

describe("attributing a booking", () => {
  it("counts a conversation no human ever joined", () => {
    expect(classify({ conversationId: "c1", quote: { createdAt: QUOTED }, conversation: conv(null) })).toEqual({
      attributed: true,
    });
  });

  it("counts one where a human joined only after the price was given", () => {
    // The engine understood the request, checked real availability and put a
    // number in front of the customer. A salesperson closing it afterwards
    // does not erase that work.
    const after = new Date(QUOTED.getTime() + 60 * 60 * 1000);
    expect(classify({ conversationId: "c1", quote: { createdAt: QUOTED }, conversation: conv(after) })).toEqual({
      attributed: true,
    });
  });

  it("does not count one a human took over before any price was given", () => {
    const before = new Date(QUOTED.getTime() - 60 * 60 * 1000);
    const verdict = classify({ conversationId: "c1", quote: { createdAt: QUOTED }, conversation: conv(before) });
    expect(verdict.attributed).toBe(false);
  });

  it("treats a takeover at the exact moment of the quote as the human's", () => {
    // Ties go to the client. Arguing over a same-second timestamp is not worth
    // the goodwill, and being seen to round against yourself is cheap.
    const verdict = classify({ conversationId: "c1", quote: { createdAt: QUOTED }, conversation: conv(QUOTED) });
    expect(verdict.attributed).toBe(false);
  });

  it("does not count a walk in with no conversation at all", () => {
    const verdict = classify({ conversationId: null, quote: null, conversation: null });
    expect(verdict.attributed).toBe(false);
  });

  it("does not count a taken over conversation that never reached a quote", () => {
    const verdict = classify({ conversationId: "c1", quote: null, conversation: conv(QUOTED) });
    expect(verdict.attributed).toBe(false);
  });
});
