/**
 * The guard that makes a language model safe to put in front of a client's customers.
 *
 * The model is told to state no figure it did not get from a tool. This verifies that
 * it obeyed, rather than trusting it. Every money-shaped figure in a draft reply must
 * appear either in a tool result from this turn or in something the customer said.
 * A draft that fails is never sent: the conversation escalates to a person instead.
 *
 * Deliberately narrow: small bare numbers (day counts, seat counts, ages) are allowed
 * through, because the damaging failure mode is an invented price or fee, and a check
 * that fires on every "3 days" would be turned off within a week.
 */

const NUM = /\d[\d,]*(?:\.\d+)?/g;

function normalise(raw: string): string {
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(n)) return raw;
  // 7875 and 7875.00 are the same claim.
  return String(Math.round(n * 100) / 100);
}

/** Every figure the model is allowed to repeat, from tool results and the customer. */
export function allowedFigures(toolResults: unknown[], customerTexts: string[]): Set<string> {
  const out = new Set<string>();
  const add = (raw: string) => {
    const v = normalise(raw);
    out.add(v);
    const n = Number(v);
    if (Number.isFinite(n)) {
      // Money is carried in minor units internally and quoted in major units.
      if (Number.isInteger(n) && Math.abs(n) >= 100) out.add(normalise(String(n / 100)));
      out.add(normalise(String(Math.round(n))));
    }
  };

  for (const r of toolResults) {
    const serialised = JSON.stringify(r) ?? "";
    for (const m of serialised.match(NUM) ?? []) add(m);
  }
  for (const t of customerTexts) {
    for (const m of t.match(NUM) ?? []) add(m);
  }
  return out;
}

const MONEY = /(?:AED|aed|AED\.|dhs|DHS|dirhams?|درهم)\s*(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*(?:AED|aed|dhs|DHS|dirhams?|درهم)/g;

/** Figures in a draft reply that carry a currency, plus any bare number of 100 or more. */
export function claimedFigures(reply: string): string[] {
  const claims = new Set<string>();
  for (const m of reply.matchAll(MONEY)) claims.add(normalise(m[1] ?? m[2] ?? ""));
  for (const m of reply.match(NUM) ?? []) {
    const v = normalise(m);
    if (Number(v) >= 100) claims.add(v);
  }
  return [...claims];
}

export type GroundingResult = { grounded: boolean; ungrounded: string[] };

export function verifyGrounding(
  reply: string,
  toolResults: unknown[],
  customerTexts: string[],
): GroundingResult {
  const allowed = allowedFigures(toolResults, customerTexts);
  const ungrounded = claimedFigures(reply).filter((c) => !allowed.has(c));
  return { grounded: ungrounded.length === 0, ungrounded };
}
