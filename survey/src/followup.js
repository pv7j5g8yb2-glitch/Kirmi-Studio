import Anthropic from "@anthropic-ai/sdk";

const PROVIDER = process.env.FOLLOWUP_PROVIDER || (process.env.ANTHROPIC_API_KEY ? "anthropic" : "deterministic");
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

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
- Dig into whichever baseline answer was vaguest or most promising, do not repeat a question already asked.
- Ask exactly one question at a time, plain and specific, never multiple questions in one.
- Stop as soon as pain, frequency, cost, and willingness to pay are all reasonably clear, do not pad the survey out for its own sake.
- Never pitch, describe, or mention any product or company. This is research only.
- Never use em dashes or en dashes in the question text.`;

function buildTranscriptText(niche, transcript) {
  const lines = transcript.map((t) => `Q${t.number}: ${t.text}\nA${t.number}: ${t.answer}`);
  return `Niche: ${niche}\n\n${lines.join("\n\n")}`;
}

async function decideWithAnthropic({ segment, transcript, remaining }) {
  const result = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `${buildTranscriptText(segment.niche, transcript)}\n\nYou have at most ${remaining} more question(s) left in this survey, including this one if you ask it. Decide now.`,
      },
    ],
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

function decideDeterministic({ transcript }) {
  const followupsAsked = transcript.filter((t) => t.kind === "followup").length;
  if (followupsAsked >= DETERMINISTIC_FOLLOWUPS.length) return { continue: false, question: null };
  return { continue: true, question: DETERMINISTIC_FOLLOWUPS[followupsAsked] };
}

export async function decideNextQuestion({ segment, transcript, remaining }) {
  if (remaining <= 0) return { continue: false, question: null };
  if (PROVIDER === "anthropic") return decideWithAnthropic({ segment, transcript, remaining });
  return decideDeterministic({ transcript });
}

export const followupProvider = PROVIDER;
