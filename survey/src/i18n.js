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
    waitlist_question: "If we ever launch a product that solves {problem}, would you like us to let you know?",
    problem_fallback: "this",
    waitlist_yes_button: "Yes",
    waitlist_no_button: "No",
    channel_question: "What’s the best way to reach you?",
    channel_email_button: "Email",
    channel_phone_button: "Phone",
    email_placeholder: "Email address",
    phone_country_placeholder: "Select a country",
    phone_number_placeholder: "Phone number",
    send_button: "Send",
    final_thanks: "Got it, thanks.",
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

// True once every key SOURCE_BUNDLE currently defines is present in a cached bundle. A
// cached bundle predating a later addition to SOURCE_BUNDLE.ui (a new button, a new
// screen) is missing that key, and would otherwise silently serve English for just that
// one string forever, the cache never knowing SOURCE_BUNDLE grew. Treating that as stale
// and regenerating is the only way a cached bundle keeps up with new UI without a manual
// cache-clearing step every time a string gets added.
function isStale(parsed) {
  if (!parsed || !parsed.ui || !parsed.segments) return true;
  return Object.keys(SOURCE_BUNDLE.ui).some((key) => !(key in parsed.ui));
}

// Static content (UI chrome plus each niche's title, intro, and baseline questions) is
// translated once per language and cached, rather than re-translated on every request:
// it never changes, so every respondent in the same language sees identical, reviewable
// wording, and there is no per-visit translation latency or cost.
export async function getBundle(language) {
  if (!language || language === "English") return SOURCE_BUNDLE;

  const cached = await get(`SELECT bundle FROM translation_bundles WHERE language = ?`, [language]);
  if (cached) {
    try {
      const parsed = JSON.parse(cached.bundle);
      if (!isStale(parsed)) return parsed;
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
