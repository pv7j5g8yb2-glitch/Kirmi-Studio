/**
 * ===========================================================================
 * AGENT TOOL SCHEMAS
 * ===========================================================================
 *
 * The complete set of things the language model is allowed to cause. There are
 * three, and the boundary they draw is the central design decision of this
 * engine:
 *
 *   THE MODEL PARSES. THE CODE DECIDES.
 *
 * The model reads "need something loud for the weekend, maybe Friday to Sunday,
 * can you drop it at the Marina" and turns it into structured arguments. That
 * is what language models are genuinely good at.
 *
 * It does not compute a price, because a plausible looking wrong number sent to
 * a customer in writing is a liability the client cannot walk back. It does not
 * decide what is available, because it has no way to know and will confidently
 * invent. It does not confirm a booking, because a hold is a lock on real
 * inventory and locks are not a thing to be hallucinated.
 *
 * Note what the schemas do NOT contain: no price field, no total field, no
 * "available" boolean the model can assert. There is no argument through which
 * a model could smuggle a number of its own invention into a customer's quote,
 * because the schema gives it nowhere to put one.
 *
 * Every tool returns figures produced by src/core/pricing and inventory state
 * read under a lock. The model's job after a tool call is to put those figures
 * into a sentence, unchanged.
 */

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

const ISO_DATETIME_NOTE =
  "ISO 8601 timestamp. If the customer gave a vague date, resolve it against the client's timezone and today's date, and if it is genuinely ambiguous, ask rather than guessing.";

export const SEARCH_VEHICLES: ToolSchema = {
  name: "SEARCH_VEHICLES",
  description:
    "Find cars in this client's fleet matching what the customer described. Returns real vehicles with real published rates. " +
    "Never describe a car that did not come back from this tool, and never quote a rate that is not in its response.",
  input_schema: {
    type: "object",
    properties: {
      categoryCode: {
        type: "string",
        description: "Fleet category code, e.g. SUPERCAR, SUV, LUXURY_SALOON. Omit if the customer has not narrowed it.",
      },
      make: { type: "string", description: "Manufacturer, if the customer named one." },
      maxDailyRateMinor: {
        type: "integer",
        description:
          "Budget ceiling as an integer count of minor units (fils for AED). Only set this when the customer stated a budget. Do not infer one.",
      },
      limit: { type: "integer", description: "How many to return, 1 to 10. Default 5." },
    },
    required: [],
    additionalProperties: false,
  },
};

export const CHECK_AVAILABILITY: ToolSchema = {
  name: "CHECK_AVAILABILITY",
  description:
    "Ask whether a specific vehicle is free for a specific window, and get the exact price if it is. " +
    "This is the ONLY source of both availability and price. Report the returned figures verbatim. " +
    "Do not add VAT, do not multiply a daily rate by the number of days, do not estimate, do not round.",
  input_schema: {
    type: "object",
    properties: {
      vehicleId: { type: "string", description: "Vehicle id exactly as returned by SEARCH_VEHICLES." },
      startAt: { type: "string", description: `Collection or delivery time. ${ISO_DATETIME_NOTE}` },
      endAt: { type: "string", description: `Return time. ${ISO_DATETIME_NOTE}` },
      deliveryRequested: {
        type: "boolean",
        description: "True only if the customer asked for the car to be delivered to them.",
      },
      addOnCodes: {
        type: "array",
        items: { type: "string" },
        description: "Add-on codes the customer explicitly asked for. Only codes from this client's catalogue.",
      },
    },
    required: ["vehicleId", "startAt", "endAt"],
    additionalProperties: false,
  },
};

export const CREATE_HOLD: ToolSchema = {
  name: "CREATE_HOLD",
  description:
    "Place a temporary hold on a vehicle after the customer has clearly agreed to a quoted price. " +
    "This takes a real lock on real inventory. It can fail because someone else booked the car a moment earlier, " +
    "and that is a normal outcome: if it does, say so plainly and offer an alternative. " +
    "A hold is not a confirmed booking. Never tell a customer they are booked until payment has been confirmed by the system.",
  input_schema: {
    type: "object",
    properties: {
      quoteId: { type: "string", description: "The quote the customer agreed to, from CHECK_AVAILABILITY." },
      confirmedByCustomer: {
        type: "boolean",
        description: "Set true only if the customer explicitly agreed. Enthusiasm about a car is not agreement.",
      },
    },
    required: ["quoteId", "confirmedByCustomer"],
    additionalProperties: false,
  },
};

export const SEND_VEHICLE_PHOTOS: ToolSchema = {
  name: "SEND_VEHICLE_PHOTOS",
  description:
    "Send the customer the client's own photographs of a specific vehicle. Use this when they ask to see the car, " +
    "or when they are choosing between two and a picture would settle it. " +
    "The photographs are the client's real stock images: you are not describing them, you are sending them, " +
    "so do not narrate what is in them and never claim a colour or a feature a photograph might not show.",
  input_schema: {
    type: "object",
    properties: {
      vehicleId: { type: "string", description: "Vehicle id exactly as returned by SEARCH_VEHICLES." },
      caption: {
        type: "string",
        description: "One short line to send with the first photograph. Optional, and shorter is better.",
      },
    },
    required: ["vehicleId"],
    additionalProperties: false,
  },
};

export const AGENT_TOOLS: ToolSchema[] = [SEARCH_VEHICLES, CHECK_AVAILABILITY, CREATE_HOLD, SEND_VEHICLE_PHOTOS];

/**
 * The guardrails, prepended to every client's own persona notes.
 *
 * Written as prohibitions with reasons rather than as a personality, because a
 * model that understands why it must not price is more reliable than one told
 * simply not to.
 */
export const SYSTEM_GUARDRAILS = [
  "You handle enquiries for a vehicle rental business. You are not the one who decides anything.",
  "",
  "Absolute rules:",
  "- Never calculate a price. Every figure comes from CHECK_AVAILABILITY, verbatim, including VAT.",
  "- Never state that a car is available unless CHECK_AVAILABILITY said so for those exact dates.",
  "- Never describe a vehicle that SEARCH_VEHICLES did not return. There is no such car.",
  "- Never confirm a booking. A hold is a hold. Payment confirmation comes from the system, not from you.",
  "- Never agree a discount, a custom rate, or a term that is not in the tool response. Hand those to a human.",
  "- If a tool fails or returns nothing, say so honestly. Do not fill the gap with something plausible.",
  "",
  "When you do not know something, ask one clear question. One question, answerable in a line.",
].join("\n");
