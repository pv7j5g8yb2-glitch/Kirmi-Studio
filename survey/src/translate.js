import Anthropic from "@anthropic-ai/sdk";

const PROVIDER =
  process.env.FOLLOWUP_PROVIDER ||
  (process.env.GROQ_API_KEY ? "groq" : process.env.ANTHROPIC_API_KEY ? "anthropic" : "none");

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

const anthropic = PROVIDER === "anthropic" ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

// Same provider as the adaptive follow-up questions themselves (see followup.js), reused
// here so translation is never a second thing that can be mis-set in production: whichever
// key is configured for one feature backs the other automatically.

const TRANSLATE_SYSTEM_PROMPT = `You are a professional translator working on a short
business research survey. Translate naturally and accurately, the way a fluent native
speaker would actually write or say it in a plain, professional register, never a literal
word-for-word rendering. Preserve the exact meaning, every number, frequency, and amount
mentioned, and the original tone and intent. Do not add, omit, soften, or explain anything.
Output ONLY the translated text and nothing else: no quotation marks around it, no notes,
no labels, no repeating the source text, no commentary.`;

const BUNDLE_SYSTEM_PROMPT = `You are a professional translator localizing a short
business research survey's fixed interface text and questions into another language, the
way a fluent native speaker would naturally write it, never literal word-for-word
translation. You will be given a JSON object. Translate every string value into the
requested target language, preserving meaning, tone, and any {placeholder} tokens exactly
as written (do not translate the text inside curly braces, keep the braces and the name
inside them character for character, e.g. {name} stays {name}). Keep the exact same JSON
key structure and nesting, translate only the values. Output ONLY a single valid JSON
object with that same structure, no other text before or after it, no markdown code
fences.`;

async function callGroq(systemPrompt, userPrompt, { json = false } = {}) {
  const res = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      ...(json ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Groq API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

async function callAnthropic(systemPrompt, userPrompt) {
  const result = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  const block = result.content.find((b) => b.type === "text");
  return block ? block.text : "";
}

async function callProvider(systemPrompt, userPrompt, opts) {
  if (PROVIDER === "groq") return callGroq(systemPrompt, userPrompt, opts);
  if (PROVIDER === "anthropic") return callAnthropic(systemPrompt, userPrompt);
  return null;
}

// Translates one piece of text. Never throws: translation failing should never break a
// respondent's survey or an admin's view, it should just fall back to the original text,
// exactly the same resilience the adaptive follow-up questions already rely on.
async function translate(text, instruction) {
  if (!text || !text.trim()) return text;
  if (PROVIDER === "none") return text;
  try {
    const out = await callProvider(TRANSLATE_SYSTEM_PROMPT, `${instruction}\n\nText:\n${text}`, { json: false });
    const trimmed = out?.trim();
    return trimmed || text;
  } catch (err) {
    console.error("Translation failed, falling back to the original text:", err.message);
    return text;
  }
}

export async function translateFromEnglish(text, targetLanguage) {
  if (!targetLanguage || targetLanguage === "English") return text;
  return translate(text, `Translate the following English text into natural, fluent ${targetLanguage}.`);
}

export async function translateToEnglish(text, sourceLanguage) {
  if (!sourceLanguage || sourceLanguage === "English") return text;
  return translate(
    text,
    `This is a survey respondent's own free-text answer, written in ${sourceLanguage}. Translate it into natural, ` +
      `first-person, conversational English exactly as they'd actually say it, preserving every number, frequency, and amount mentioned.`
  );
}

// Translates the whole static bundle (fixed UI strings plus each niche's title, intro, and
// baseline questions) into one language in a single call, so every string in that language
// reads consistently rather than being translated one at a time in isolation. Returns null
// on failure or when no provider is configured, so the caller can fall back to English.
export async function translateBundle(sourceBundle, targetLanguage) {
  if (PROVIDER === "none") return null;
  try {
    const out = await callProvider(
      BUNDLE_SYSTEM_PROMPT,
      `Target language: ${targetLanguage}\n\nJSON to translate:\n${JSON.stringify(sourceBundle)}`,
      { json: true }
    );
    const parsed = JSON.parse(out);
    return parsed;
  } catch (err) {
    console.error(`Bundle translation to ${targetLanguage} failed, falling back to English:`, err.message);
    return null;
  }
}

export const translateProvider = PROVIDER;
