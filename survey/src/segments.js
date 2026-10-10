export const QUESTION_CAP = 10;
export const BASELINE_COUNT = 5;

export const segments = {
  bookkeepers: {
    niche: "bookkeepers",
    intro:
      "Quick survey, nothing more, about how bookkeeping work actually goes for you day to day. There’s nothing to sign up for and nothing being offered to you, this is pure research data.",
    baseline: [
      "What is the part of a typical client’s bookkeeping that eats the most of your time, and shouldn’t?",
      "Take me through exactly how you handle that today, step by step.",
      "Does that happen on every client, every month, or mostly around certain deadlines like VAT returns or year end?",
      "What is that actually costing you: in hours each week, in late nights, or in clients you have had to turn down?",
      "If something fixed that properly, what would it be worth to you, per month, per client?",
    ],
  },
  "real-estate-agents": {
    niche: "real estate agents and brokers",
    intro:
      "Quick survey, nothing more, about how handling listings and enquiries actually goes for you day to day. There’s nothing to sign up for and nothing being sold here, this is pure research data.",
    baseline: [
      "What is the part of handling a listing or a client enquiry that eats the most of your time, and shouldn’t?",
      "Take me through exactly how you handle that today, step by step.",
      "Does that happen on every enquiry, every listing, or mostly at certain points, like after hours or around viewings?",
      "What is that actually costing you: in hours each week, in missed enquiries, or in deals that went cold?",
      "If something fixed that properly, what would it be worth to you, per month?",
    ],
  },
};

// A singular, personal label for a respondent in this niche, used on the homepage's "Are
// you a:" links, where the page is addressing them directly rather than describing the
// niche as a category. Falls back to the plural category name for any future niche added
// here without a custom label of its own.
export const ROLE_LABELS = {
  bookkeepers: "Bookkeeper",
  "real-estate-agents": "Real estate agent, broker, or realtor",
};

export function getSegment(slug) {
  return segments[slug] ?? null;
}

export function listSegments() {
  return Object.entries(segments).map(([slug, segment]) => ({ slug, niche: segment.niche }));
}
