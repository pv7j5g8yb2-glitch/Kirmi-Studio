import Anthropic from "@anthropic-ai/sdk";

const PROVIDER =
  process.env.FOLLOWUP_PROVIDER ||
  (process.env.GROQ_API_KEY ? "groq" : process.env.ANTHROPIC_API_KEY ? "anthropic" : "deterministic");

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

const anthropic = PROVIDER === "anthropic" ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

const DETERMINISTIC_FOLLOWUPS = [
  "Can you put a number on how often that happens in a typical month?",
  "What have you already tried to fix that, and why did not it stick?",
  "If you did not have to deal with that at all, what would you do with the time instead?",
];

// A target, not a forced floor: push toward asking at least this many follow-ups when
// there is genuinely more worth asking, so a tidy-looking baseline still gets real depth.
// Never worth enforcing in code, since the only way to force a count past what the
// answers actually support is to repeat a question, which is worse than stopping short.
const MINIMUM_FOLLOWUPS = 3;

const SYSTEM_PROMPT = `You are running a short product-market-fit research survey for
a founder validating pain before building anything. The respondent has just answered a
batch of baseline questions, the same ones every respondent in this niche gets. Your job
is to decide whether one more focused follow-up question would get real signal on pain,
frequency, cost, or willingness to pay, and if so, write that one question.

Rules:
- People tend to name whatever is most annoying day to day, not whatever actually costs them the most, those are often different problems. Before you spend more than one or two follow-ups deepening only the problem they led with, check once for a second one: something that might be less naggingly frequent but larger overall, for example "Besides that, is there anything else in a typical week that eats real time or money, even if it is not the first thing that comes to mind?" If what comes back sounds bigger than the original answer by their own account of hours or cost, that is the real signal, and the original topic was a decoy. When this happens: do not stop yet even if you are at or past your usual target follow-up count, and do not go back to asking about the original topic, including its price. Treat the new problem as needing its own frequency, cost, and willingness to pay before the survey is actually done, the same bar the original topic had to clear, it has not cleared it yet just because it was mentioned once.
- Dig into whichever baseline answer was vaguest or most promising, do not repeat a question already asked, including asking for the same fact in different words.
- If the last one or two answers dodged a direct ask (no real number, no real specifics), that approach is not working, switch to a different angle or a different signal entirely rather than re-asking for the same thing another way.
- Once a signal (pain, frequency, cost, or willingness to pay) already has a clear, usable answer, leave it. Do not spend another question refining a number that is already good enough, spend it on whichever of the four signals is still unclear instead.
- If you cannot come up with a question that is genuinely different in substance from every question already in the transcript, below, baseline or follow-up, stop instead (continue: false). A respondent who has already dodged the same ask twice is not going to answer a third rephrasing of it, stopping cleanly beats repeating yourself.
- Ask exactly one question at a time, plain and specific, never multiple questions in one. Joining two asks with "and" is still two questions, split them and ask the more important half now, the other later if it is still needed.
- Stop as soon as pain, frequency, cost, and willingness to pay are all reasonably clear, do not pad the survey out for its own sake.
- Never pitch, describe, or mention any product or company. This is research only. This includes hypothetically: "if something fixed this properly" is fine, "a tool that automatically collects X and eliminates Y" is not, that is describing a product's features. A question that describes what a solution would do is a pitch wearing a question mark.
- Never suggest a specific price or number when asking about willingness to pay, let them state their own. Naming a figure anchors their answer and corrupts the signal.
- Never use em dashes or en dashes in the question text.`;

const GROQ_JSON_INSTRUCTION = `\n\nRespond with only a JSON object of exactly this shape, no other text before or after it:
{"continue": true or false, "question": "the exact follow-up question text" or null}`;

// Hard backstop, independent of whatever the prompt says: a model can ignore an
// instruction, this cannot. If a generated question suggests any figure near money or
// a billing period, it never reaches a respondent, no matter which provider produced it.
const PRICE_PATTERN =
  /[$€£¥]\s?\d|\d+\s*(?:dollars?|euros?|pounds?|usd|eur|gbp|bucks)\b|\b\d[\d,]*\s*(?:\/|\s+per\s+|\s+a\s+)\s*(?:month|mo\b|year|yr\b)/i;

function suggestsAPrice(question) {
  return typeof question === "string" && PRICE_PATTERN.test(question);
}

// Same idea as the price guard: a question that describes what a hypothetical solution
// does ("a tool that automatically collects...") is a pitch, not research. "If a tool
// could save you time, what would you pay" is fine, it never describes a feature, so this
// only matches the "noun + that/which + verb" shape that actually spells one out.
const PRODUCT_DESCRIPTION_PATTERN =
  /\b(?:a|an)\s+(?:solution|tool|product|service|app|platform|system)\s+(?:that|which)\b|\b(?:adopt|use|try|pay for)\s+(?:a|an)\s+(?:solution|tool|product|service|app|platform|system)\b/i;

function describesAProduct(question) {
  return typeof question === "string" && PRODUCT_DESCRIPTION_PATTERN.test(question);
}

function buildTranscriptText(niche, transcript) {
  const lines = transcript.map((t) => `Q${t.number}: ${t.text}\nA${t.number}: ${t.answer}`);
  return `Niche: ${niche}\n\n${lines.join("\n\n")}`;
}

function buildUserMessage(segment, transcript, remaining, followupsAsked) {
  const base = `${buildTranscriptText(segment.niche, transcript)}\n\nYou have at most ${remaining} more question(s) left in this survey, including this one if you ask it.`;
  if (followupsAsked < MINIMUM_FOLLOWUPS) {
    return `${base} You have only asked ${followupsAsked} follow-up question(s) so far, aim for at least ${MINIMUM_FOLLOWUPS}. The four core signals already looking reasonably clear is not by itself a reason to stop this early, there is almost always more worth learning, for example: how this affects their capacity to take on more clients or deals, a specific recent incident and what it cost them, or how this compares at their busiest moments versus normal. Make a real attempt at one of these before concluding there is nothing left, but never by describing what a future solution would do, see the rule on that above. Only stop below the target (continue: false) if, after genuinely trying, you truly cannot think of a question that is substantively different from everything already asked, below. A repeated question, reworded or not, is worse than a short survey, and so is one that describes a product.`;
  }
  return `${base} You have reached the usual target of ${MINIMUM_FOLLOWUPS} follow-ups, so stopping now is a real option if nothing left would add genuine signal. Decide now.`;
}

async function decideWithAnthropic({ segment, transcript, remaining, followupsAsked }) {
  const result = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserMessage(segment, transcript, remaining, followupsAsked) }],
    tools: [
      {
        name: "decide_next_question",
        description: "Decide whether to continue the survey and what to ask next.",
        input_schema: {
          type: "object",
          properties: {
            continue: { type: "boolean" },
            question: { type: ["string", "null"] },
          },
          required: ["continue", "question"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "decide_next_question" },
  });

  const toolUse = result.content.find((block) => block.type === "tool_use");
  if (!toolUse) return { continue: false, question: null };
  return { continue: Boolean(toolUse.input.continue), question: toolUse.input.question ?? null };
}

async function decideWithGroq({ segment, transcript, remaining, followupsAsked }) {
  const res = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT + GROQ_JSON_INSTRUCTION },
        { role: "user", content: buildUserMessage(segment, transcript, remaining, followupsAsked) },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Groq API error ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const parsed = JSON.parse(data.choices[0].message.content);
  return { continue: Boolean(parsed.continue), question: parsed.question ?? null };
}

function countFollowupsAsked(transcript) {
  return transcript.filter((t) => t.kind === "followup").length;
}

function decideDeterministic({ transcript }) {
  const followupsAsked = countFollowupsAsked(transcript);
  if (followupsAsked >= DETERMINISTIC_FOLLOWUPS.length) return { continue: false, question: null };
  return { continue: true, question: DETERMINISTIC_FOLLOWUPS[followupsAsked] };
}

async function decideWithProvider({ segment, transcript, remaining, followupsAsked }) {
  if (PROVIDER === "groq") {
    try {
      return await decideWithGroq({ segment, transcript, remaining, followupsAsked });
    } catch (err) {
      console.error("Groq follow-up decision failed, falling back to the fixed follow-ups for this turn:", err.message);
      return decideDeterministic({ transcript });
    }
  }
  if (PROVIDER === "anthropic") return decideWithAnthropic({ segment, transcript, remaining, followupsAsked });
  return decideDeterministic({ transcript });
}

export async function decideNextQuestion({ segment, transcript, remaining }) {
  if (remaining <= 0) return { continue: false, question: null };

  const followupsAsked = countFollowupsAsked(transcript);
  const decision = await decideWithProvider({ segment, transcript, remaining, followupsAsked });

  if (decision.question && suggestsAPrice(decision.question)) {
    console.error("Blocked a generated follow-up that suggested a price, falling back for this turn:", decision.question);
    return decideDeterministic({ transcript });
  }

  if (decision.question && describesAProduct(decision.question)) {
    console.error("Blocked a generated follow-up that described a hypothetical product, falling back for this turn:", decision.question);
    return decideDeterministic({ transcript });
  }

  // No code-level floor here on purpose. Forcing a question when the model has already
  // said it has nothing substantively new to ask would mean injecting one of the fixed
  // fallback questions, which can itself repeat something already covered, the exact
  // failure this is meant to avoid. Stopping early and honestly beats padding.
  return decision;
}

export const followupProvider = PROVIDER;
