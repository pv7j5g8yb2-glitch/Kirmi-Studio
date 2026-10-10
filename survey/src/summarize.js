import { callProvider, translateProvider, translateFromEnglish } from "./translate.js";

// Picks the one problem worth referencing back to the respondent on the thanks screen,
// so the waitlist ask ("if we ever solve X, want to know?") names something real instead
// of being generic. "Worth referencing" specifically means the problem with a real
// willingness-to-pay figure attached, not just whichever one got the most words: the
// adaptive follow-up engine (see followup.js) already treats a second, bigger problem as
// the real one once it finds it, and is instructed to get a value for it before stopping,
// so by the end of the conversation the transcript itself reflects which problem actually
// matters for this. A plain "most discussed" fallback only kicks in if nothing in the
// conversation ever got a clear figure attached.
const SYSTEM_PROMPT = `You read a short business research conversation (baseline questions
every respondent in this niche gets, plus follow-ups adapted to this specific respondent)
and identify the single problem worth referencing back to them in one short phrase.

Priority order:
1. The problem that has a clear willingness-to-pay figure attached, meaning the respondent
   stated or clearly implied what they would pay per month to have it fixed. If the
   conversation moved on from an original problem to a second, bigger one and got a value
   for that second one, use the second one, not the first.
2. If no problem in the conversation has a clear value attached, use whichever problem the
   respondent actually spent the most of the conversation describing.

Condense that one problem into a short, natural phrase of 3 to 8 words that fits
grammatically into this exact sentence, filling the blank: "If we ever launch a product
that solves ___, would you like us to let you know?" Use plain lowercase words, no
trailing punctuation, no quotation marks, no the-respondent's-name, just the problem
itself (for example: "late bank reconciliation every month", "slow after-hours enquiry
follow-up").

If you genuinely cannot identify any usable problem from the conversation, respond with
exactly: NONE

Output ONLY the phrase itself, or exactly NONE. Nothing else, no explanation.`;

function buildTranscriptText(niche, transcript) {
  const lines = transcript.map((t) => `Q${t.number}: ${t.text}\nA${t.number}: ${t.answer}`);
  return `Niche: ${niche}\n\n${lines.join("\n\n")}`;
}

// Never throws: a failed or missing summary just means the waitlist question falls back
// to a generic phrasing client-side, the same resilience every other AI-dependent piece
// of this survey already relies on. Returns { en, localized } with both null on failure.
export async function summarizePainPoint({ segment, transcript, language }) {
  if (translateProvider === "none" || !transcript.length) return { en: null, localized: null };

  try {
    const out = await callProvider(SYSTEM_PROMPT, buildTranscriptText(segment.niche, transcript), { json: false });
    const phrase = out?.trim();
    if (!phrase || /^none\.?$/i.test(phrase)) return { en: null, localized: null };

    const localized = await translateFromEnglish(phrase, language);
    return { en: phrase, localized };
  } catch (err) {
    console.error("Pain-point summarization failed, the waitlist question will use a generic fallback:", err.message);
    return { en: null, localized: null };
  }
}
