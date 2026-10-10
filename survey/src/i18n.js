import { get, run } from "./db.js";
import { segments } from "./segments.js";
import { translateBundle } from "./translate.js";

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// The single source of truth for every fixed string in the respondent-facing form:
// button labels, screen copy, error messages, and each niche's title/intro/baseline
// questions. English never goes through translation, it is this object, read directly.
// {placeholder} tokens are filled in client-side after translation, never touched by it.
export const SOURCE_BUNDLE = {
  ui: {
    before_you_start: "Before you start",
    start_button: "Start",
    name_progress: "Almost there",
    name_heading: "What should I call you?",
    name_placeholder: "First name",
    name_error: "Just your first name, go on.",
    continue_button: "Continue",
    hello_greeting: "Hello, {name}",
    question_progress: "Question {number} of up to {cap}",
    review_progress: "Question {number}",
    review_note: "Reviewing an earlier answer, save to go back to where you were.",
    answer_placeholder: "Type your answer here",
    answer_error_empty: "Go on, give it a line or two.",
    next_button: "Next",
    save_button: "Save",
    back_button: "Back",
    done_heading_default: "Thanks, genuinely.",
    done_heading_named: "Thanks, {name}.",
    done_body: "That’s everything. This goes straight into research, nothing else happens with it.",
    contact_progress: "Totally optional",
    contact_intro:
      "If this turns into something worth telling you about, can I follow up? Leave this blank and skip it if you would rather not.",
    contact_phone_placeholder: "Phone (optional)",
    contact_email_placeholder: "Email (optional)",
    contact_send_button: "Send",
    contact_skip_button: "Skip",
    contact_done: "Got it, thanks.",
    missing_heading: "That link isn’t quite right",
    missing_body: "This survey couldn’t be found.",
    generic_error: "Something went wrong, try again.",
  },
  segments: Object.fromEntries(
    Object.entries(segments).map(([slug, segment]) => [
      slug,
      { title: capitalize(segment.niche), intro: segment.intro, baseline: segment.baseline },
    ])
  ),
};

// Static content (UI chrome plus each niche's title, intro, and baseline questions) is
// translated once per language and cached, rather than re-translated on every request:
// it never changes, so every respondent in the same language sees identical, reviewable
// wording, and there is no per-visit translation latency or cost.
export async function getBundle(language) {
  if (!language || language === "English") return SOURCE_BUNDLE;

  const cached = await get(`SELECT bundle FROM translation_bundles WHERE language = ?`, [language]);
  if (cached) {
    try {
      return JSON.parse(cached.bundle);
    } catch {
      // Fall through and regenerate if the cached row is somehow corrupt.
    }
  }

  const translated = await translateBundle(SOURCE_BUNDLE, language);
  if (!translated || !translated.ui || !translated.segments) {
    console.error(`Static bundle translation to ${language} produced nothing usable, serving English instead.`);
    return SOURCE_BUNDLE;
  }

  // Fill in anything the model dropped from English rather than shipping a page with
  // blank buttons. Shallow per-section merge: ui and each segment are flat key/value
  // string maps (segment.baseline is translated as a whole array value, not merged key
  // by key), so this never silently keeps an English string next to its translated
  // siblings within the same array.
  const merged = {
    ui: { ...SOURCE_BUNDLE.ui, ...translated.ui },
    segments: Object.fromEntries(
      Object.entries(SOURCE_BUNDLE.segments).map(([slug, source]) => [
        slug,
        { ...source, ...(translated.segments[slug] || {}) },
      ])
    ),
  };

  try {
    await run(`INSERT OR REPLACE INTO translation_bundles (language, bundle, created_at) VALUES (?, ?, ?)`, [
      language,
      JSON.stringify(merged),
      new Date().toISOString(),
    ]);
  } catch (err) {
    console.error(`Failed to cache the ${language} bundle, it will be regenerated next request:`, err.message);
  }

  return merged;
}
