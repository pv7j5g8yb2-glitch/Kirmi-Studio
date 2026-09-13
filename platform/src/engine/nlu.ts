/**
 * Domain NLU for car-rental enquiries.
 *
 * This is deliberately deterministic rather than model-driven. A rental enquiry is a
 * narrow slot-filling problem — which car, which dates, how long — and a rule-based
 * extractor is testable, free, instant, and cannot hallucinate a price. The LLM layer
 * sits above this and is used for phrasing and for messages this cannot parse.
 *
 * Handles English and Arabic, because DEIZ's customers write in both.
 */

export type Intent =
  | "enquiry" | "price_request" | "availability" | "booking_intent"
  | "document_question" | "greeting" | "handover_request" | "unknown";

export type Extracted = {
  intent: Intent;
  vehicleHint: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  days: number | null;
  delivery: boolean | null;
  locale: "en" | "ar";
};

const AR_INDIC = /[٠-٩]/g;
const AR_INDIC_MAP: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
};

export function normaliseDigits(s: string): string {
  return s.replace(AR_INDIC, (d) => AR_INDIC_MAP[d] ?? d);
}

export function detectLocale(text: string): "en" | "ar" {
  // Arabic block; a single Arabic word is enough to switch, since English words are
  // common inside Arabic messages but not the reverse.
  return /[؀-ۿ]/.test(text) ? "ar" : "en";
}

const GREETING = /\b(hi|hello|hey|good\s*(morning|evening|afternoon)|salam|salaam)\b|مرحبا|السلام|اهلا|أهلا/i;
const HANDOVER = /\b(human|agent|person|manager|speak to someone|real person|call me)\b|موظف|شخص|اتصل/i;
const PRICE = /\b(price|cost|rate|how much|quote|charge|per day|daily)\b|سعر|كم|بكم|تكلفة|يوم/i;
const AVAILABILITY = /\b(available|availability|free|book|reserve|booking)\b|متاح|متوفر|حجز|احجز/i;
const BOOKING = /\b(book it|i'll take|lets do it|let's do it|confirm|go ahead|yes book)\b|احجزها|موافق|تمام احجز/i;
const DOCS = /\b(documents?|paperwork|passports?|licen[cs]es?|permits?|visas?|emirates\s*id)\b|جواز|رخصة|أوراق|اوراق|وثائق|مستندات/i;
const DELIVERY = /\b(deliver|delivery|drop it|bring it|to my hotel|to the airport)\b|توصيل|يوصل|وصل/i;

/** Matches "3 days", "a week", "the weekend" — customers rarely write a digit for one unit. */
const DURATION =
  /\b(\d{1,3}|a|an|one)\s*(days?|nights?|weeks?|months?)\b|(\d{1,3}|يوم|اسبوع|أسبوع|شهر)\s*(يوم|يوما|يوماً|ايام|أيام|اسبوع|أسبوع|اسابiع|اسابيع|أسابيع|شهر|شهور|أشهر)/i;

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};

function atNoon(d: Date): Date {
  const c = new Date(d);
  c.setUTCHours(10, 0, 0, 0);
  return c;
}

function nextWeekday(from: Date, target: number): Date {
  const d = new Date(from);
  const delta = (target - d.getUTCDay() + 7) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return atNoon(d);
}

/** Parses the date expressions real customers actually send. */
export function extractDates(text: string, now = new Date()): { startsAt: Date | null; days: number | null } {
  const t = normaliseDigits(text.toLowerCase());
  let startsAt: Date | null = null;

  if (/\btomorrow\b|غدا|بكرة|غداً/.test(t)) {
    const d = new Date(now); d.setUTCDate(d.getUTCDate() + 1); startsAt = atNoon(d);
  } else if (/\btoday\b|اليوم/.test(t)) {
    startsAt = atNoon(now);
  } else if (/\b(this|next)\s+weekend\b|نهاية الاسبوع|نهاية الأسبوع/.test(t)) {
    startsAt = nextWeekday(now, 5); // Friday
  }

  if (!startsAt) {
    const wd = t.match(/\b(next\s+)?(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thu|friday|fri|saturday|sat)\b/);
    if (wd?.[2]) {
      const target = WEEKDAYS[wd[2]];
      if (target !== undefined) startsAt = nextWeekday(now, target);
    }
  }

  if (!startsAt) {
    // "12 March", "March 12", "12/03", "2026-03-12"
    const iso = t.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
    const dm = t.match(/\b(\d{1,2})\s*[/.-]\s*(\d{1,2})(?:\s*[/.-]\s*(\d{2,4}))?\b/);
    const dMon = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\b/);
    const monD = t.match(/\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
    if (iso) {
      startsAt = atNoon(new Date(Date.UTC(+iso[1]!, +iso[2]! - 1, +iso[3]!)));
    } else if (dMon && MONTHS[dMon[2]!] !== undefined) {
      const y = now.getUTCFullYear();
      let d = new Date(Date.UTC(y, MONTHS[dMon[2]!]!, +dMon[1]!));
      if (d < now) d = new Date(Date.UTC(y + 1, MONTHS[dMon[2]!]!, +dMon[1]!));
      startsAt = atNoon(d);
    } else if (monD && MONTHS[monD[1]!] !== undefined) {
      const y = now.getUTCFullYear();
      let d = new Date(Date.UTC(y, MONTHS[monD[1]!]!, +monD[2]!));
      if (d < now) d = new Date(Date.UTC(y + 1, MONTHS[monD[1]!]!, +monD[2]!));
      startsAt = atNoon(d);
    } else if (dm) {
      // Day-first: UAE convention.
      const y = dm[3] ? (dm[3].length === 2 ? 2000 + +dm[3] : +dm[3]) : now.getUTCFullYear();
      let d = new Date(Date.UTC(y, +dm[2]! - 1, +dm[1]!));
      if (!dm[3] && d < now) d = new Date(Date.UTC(y + 1, +dm[2]! - 1, +dm[1]!));
      startsAt = atNoon(d);
    }
  }

  let days: number | null = null;
  const dur = t.match(DURATION);
  if (dur) {
    const rawCount = (dur[1] ?? dur[3] ?? "1").toLowerCase();
    // "a week" and the bare Arabic unit both mean one of that unit.
    const n = /^\d+$/.test(rawCount) ? Number(rawCount) : 1;
    const unit = (dur[2] ?? dur[4] ?? "day").toLowerCase();
    if (Number.isFinite(n) && n > 0) {
      if (/week|اسبوع|أسبوع|اسابيع|أسابيع/.test(unit)) days = n * 7;
      else if (/month|شهر|شهور|أشهر/.test(unit)) days = n * 30;
      else days = n;
    }
  } else if (/\bweekend\b|نهاية الاسبوع|نهاية الأسبوع/.test(t)) {
    days = 2;
  }

  return { startsAt, days };
}

/**
 * Removes the date and duration language so it cannot be mistaken for a car name.
 * "3 days from friday" must not leave "3" or "friday" in the vehicle hint.
 */
function stripTemporal(text: string): string {
  return normaliseDigits(text)
    .toLowerCase()
    .replace(DURATION, " ")
    .replace(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, " ")
    .replace(/\b\d{1,2}\s*[/.-]\s*\d{1,2}(\s*[/.-]\s*\d{2,4})?\b/g, " ")
    .replace(/\b(\d{1,2})(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/g, " ")
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2}(st|nd|rd|th)?\b/g, " ")
    .replace(/\b(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*\b/g, " ")
    .replace(/\b(today|tomorrow|tonight|weekend|next|this)\b/g, " ")
    .replace(/غدا|غداً|بكرة|اليوم|نهاية الاسبوع|نهاية الأسبوع|لمدة/g, " ");
}

const STOPWORDS_EN = new Set([
  "i", "want", "need", "a", "an", "the", "car", "cars", "vehicle", "for", "how", "much", "is", "are",
  "it", "to", "rent", "rental", "hire", "please", "do", "you", "have", "has", "can", "could", "would",
  "get", "me", "my", "we", "us", "price", "prices", "cost", "rate", "rates", "quote", "of", "on", "in",
  "at", "from", "available", "availability", "free", "booking", "book", "reserve", "with", "and", "or",
  "hi", "hello", "hey", "per", "any", "anything", "something", "some", "what", "whats", "which", "when",
  "there", "that", "this", "your", "am", "pm", "days", "day", "week", "weeks", "month", "months",
]);

const STOPWORDS_AR = new Set([
  "كم", "سعر", "السعر", "اريد", "أريد", "ابغى", "أبغى", "عندكم", "عندك", "متاح", "متاحة", "متوفر",
  "متوفرة", "حجز", "احجز", "أحجز", "سيارة", "سياره", "السيارة", "في", "من", "الى", "إلى", "على",
  "هل", "ما", "ماهو", "كيف", "لو", "سمحت", "مرحبا", "أهلا", "اهلا", "شكرا", "شكراً", "يوم", "ايام",
  "أيام", "اسبوع", "أسبوع", "شهر", "لمدة", "بكم", "تكلفة", "ايجار", "إيجار", "تأجير", "و", "مع",
]);

/**
 * Reduces a message to a plausible car name.
 *
 * Latin/numeric tokens win when present: even customers writing in Arabic type model
 * names in Latin script or digits ("الجي 63"), and those are what match the fleet.
 */
export function extractVehicleHint(text: string): string | null {
  const cleaned = stripTemporal(text)
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;

  const tokens = cleaned
    .split(" ")
    .filter((w) => w.length >= 2 && !STOPWORDS_EN.has(w) && !STOPWORDS_AR.has(w));
  if (!tokens.length) return null;

  const latin = tokens.filter((w) => /[a-z0-9]/.test(w));
  const chosen = latin.length ? latin : tokens;
  // Three tokens is enough for "mercedes g63 amg"; a whole sentence is not a hint.
  return chosen.slice(0, 3).join(" ");
}

export function classify(text: string): Intent {
  if (HANDOVER.test(text)) return "handover_request";
  if (BOOKING.test(text)) return "booking_intent";
  if (DOCS.test(text)) return "document_question";
  if (PRICE.test(text)) return "price_request";
  if (AVAILABILITY.test(text)) return "availability";
  if (GREETING.test(text) && text.trim().split(/\s+/).length <= 4) return "greeting";
  if (text.trim().length > 0) return "enquiry";
  return "unknown";
}

export function understand(text: string, now = new Date()): Extracted {
  const locale = detectLocale(text);
  const intent = classify(text);
  const { startsAt, days } = extractDates(text, now);
  const hint = extractVehicleHint(text);
  const endsAt = startsAt && days ? new Date(startsAt.getTime() + days * 86_400_000) : null;
  return {
    intent,
    vehicleHint: hint,
    startsAt,
    endsAt,
    days,
    delivery: DELIVERY.test(text) ? true : null,
    locale,
  };
}
