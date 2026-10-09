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

const SYSTEM_PROMPT = `You are running a short product-market-fit research survey for
a founder validating pain before building anything. The respondent has just answered a
batch of baseline questions, the same ones every respondent in this niche gets. Your job
is to decide whether one more focused follow-up question would get real signal on pain,
frequency, cost, or willingness to pay, and if so, write that one question.

Rules:
- Dig into whichever baseline answer was vaguest or most promising, do not repeat a question already asked, including asking for the same fact in different words.
- If the last one or two answers dodged a direct ask (no real number, no real specifics), that approach is not working, switch to a different angle or a different signal entirely rather than re-asking for the same thing another way.
- Ask exactly one question at a time, plain and specific, never multiple questions in one.
- Stop as soon as pain, frequency, cost, and willingness to pay are all reasonably clear, do not pad the survey out for its own sake.
- Never pitch, describe, or mention any product or company. This is research only.
- Never suggest a specific price or number when asking about willingness to pay, let them state their own. Naming a figure anchors their answer and corrupts the signal.
- Never use em dashes or en dashes in the question text.`;

const GROQ_JSON_INSTRUCTION = `\n\nRespond with only a JSON object of exactly this shape, no other text before or after it:
{"continue": true or false, "question": "the exact follow-up question text" or null}`;

function buildTranscriptText(niche, transcript) {
  const lines = transcript.map((t) => `Q${t.number}: ${t.text}\nA${t.number}: ${t.answer}`);
  return `Niche: ${niche}\n\n${lines.join("\n\n")}`;
}

function buildUserMessage(segment, transcript, remaining) {
  return `${buildTranscriptText(segment.niche, transcript)}\n\nYou have at most ${remaining} more question(s) left in this survey, including this one if you ask it. Decide now.`;
}

async function decideWithAnthropic({ segment, transcript, remaining }) {
  const result = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserMessage(segment, transcript, remaining) }],
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

async function decideWithGroq({ segment, transcript, remaining }) {
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
        { role: "user", content: buildUserMessage(segment, transcript, remaining) },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Groq API error ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const parsed = JSON.parse(data.choices[0].message.content);
  return { continue: Boolean(parsed.continue), question: parsed.question ?? null };
}

function decideDeterministic({ transcript }) {
  const followupsAsked = transcript.filter((t) => t.kind === "followup").length;
  if (followupsAsked >= DETERMINISTIC_FOLLOWUPS.length) return { continue: false, question: null };
  return { continue: true, question: DETERMINISTIC_FOLLOWUPS[followupsAsked] };
}

export async function decideNextQuestion({ segment, transcript, remaining }) {
  if (remaining <= 0) return { continue: false, question: null };

  if (PROVIDER === "groq") {
    try {
      return await decideWithGroq({ segment, transcript, remaining });
    } catch (err) {
      console.error("Groq follow-up decision failed, falling back to the fixed follow-ups for this turn:", err.message);
      return decideDeterministic({ transcript });
    }
  }

  if (PROVIDER === "anthropic") return decideWithAnthropic({ segment, transcript, remaining });
  return decideDeterministic({ transcript });
}

export const followupProvider = PROVIDER;
