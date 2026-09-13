import type Anthropic from "@anthropic-ai/sdk";
import {
  toolSearchVehicles,
  toolCheckAvailability,
  toolQuote,
  toolRentalRules,
  toolAvailableOn,
  type ToolContext,
} from "../tools.js";
import { getSetting } from "../../domain/settings.js";

/**
 * The only doors the model has onto the client's data. Anything a customer could be
 * told about a car, a date, a price or a policy has to come through one of these.
 */

export const TOOL_SCHEMAS = [
  {
    name: "search_vehicles",
    description:
      "Find cars in the client's fleet by name, make, model or category (suv, sports, luxury, sedan). " +
      "Use it before naming any vehicle. Returns daily rate, deposit, minimum days and category.",
    input_schema: {
      type: "object" as const,
      properties: { term: { type: "string", description: "What the customer asked for, e.g. 'g63', 'suv', 'something for the desert'" } },
      required: ["term"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "list_available",
    description:
      "List the cars actually free between two dates. Use when the customer has given dates but no car, " +
      "or when they ask what is available.",
    input_schema: {
      type: "object" as const,
      properties: {
        starts_at: { type: "string", description: "ISO 8601 date-time" },
        ends_at: { type: "string", description: "ISO 8601 date-time" },
      },
      required: ["starts_at", "ends_at"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "check_availability",
    description: "Check whether one specific vehicle is free between two dates. Returns alternatives if it is not.",
    input_schema: {
      type: "object" as const,
      properties: {
        vehicle_id: { type: "string" },
        starts_at: { type: "string" },
        ends_at: { type: "string" },
      },
      required: ["vehicle_id", "starts_at", "ends_at"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "quote",
    description:
      "Price one vehicle for a date range. This is the ONLY source of a price. Returns the total including VAT, " +
      "the deposit, the rate tier applied and the included mileage. Never state a price without calling this.",
    input_schema: {
      type: "object" as const,
      properties: {
        vehicle_id: { type: "string" },
        starts_at: { type: "string" },
        ends_at: { type: "string" },
        delivery: { type: "boolean", description: "True if the customer wants it delivered" },
      },
      required: ["vehicle_id", "starts_at", "ends_at", "delivery"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "rental_rules",
    description:
      "The client's rental rules: minimum age, required documents, accepted payment methods, number of named " +
      "drivers, support hours, default deposit. Call before answering any question about requirements.",
    input_schema: { type: "object" as const, properties: {}, required: [], additionalProperties: false },
    strict: true,
  },
  {
    name: "policy_lookup",
    description:
      "Look up the client's written answer on a topic such as insurance, fuel, mileage, delivery, cancellation, " +
      "tolls, smoking, child seats, cross border travel, chauffeur. Returns nothing if the client has not " +
      "configured an answer, in which case escalate rather than inventing one.",
    input_schema: {
      type: "object" as const,
      properties: { topic: { type: "string", description: "A few words naming the topic" } },
      required: ["topic"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "escalate_to_human",
    description:
      "Hand the conversation to a member of the client's team. Use for complaints, corporate or custom rates, " +
      "legal or insurance disputes, anything about a past rental, and anything you cannot answer from a tool.",
    input_schema: {
      type: "object" as const,
      properties: { reason: { type: "string" } },
      required: ["reason"],
      additionalProperties: false,
    },
    strict: true,
  },
] satisfies Anthropic.Tool[];

export type PolicyEntry = { topic: string; keywords?: string[]; answer: string; answerAr?: string };

export type DispatchResult = { result: unknown; escalate: string | null };

function asDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Runs one tool call. Tool failures are returned as data, never thrown: the model
 * has to see "I could not get that" so it can escalate instead of stalling.
 */
export async function dispatchTool(
  ctx: ToolContext & { enquiryId: string | null },
  name: string,
  input: Record<string, unknown>,
): Promise<DispatchResult> {
  try {
    switch (name) {
      case "search_vehicles":
        return { result: await toolSearchVehicles(ctx, String(input.term ?? "")), escalate: null };

      case "list_available": {
        const s = asDate(input.starts_at), e = asDate(input.ends_at);
        if (!s || !e) return { result: { known: false, reason: "bad_dates" }, escalate: null };
        return { result: await toolAvailableOn(ctx, s, e), escalate: null };
      }

      case "check_availability":
        return {
          result: await toolCheckAvailability(ctx, {
            vehicleId: String(input.vehicle_id ?? ""),
            startsAt: asDate(input.starts_at),
            endsAt: asDate(input.ends_at),
          }),
          escalate: null,
        };

      case "quote":
        return {
          result: await toolQuote(ctx, {
            vehicleId: String(input.vehicle_id ?? ""),
            startsAt: asDate(input.starts_at),
            endsAt: asDate(input.ends_at),
            delivery: input.delivery === true,
            enquiryId: ctx.enquiryId,
            persist: Boolean(ctx.enquiryId),
          }),
          escalate: null,
        };

      case "rental_rules":
        return { result: await toolRentalRules(ctx), escalate: null };

      case "policy_lookup": {
        const topic = String(input.topic ?? "").toLowerCase();
        const stored = await getSetting<PolicyEntry[]>(ctx.db, ctx.tenantId, "policies");
        const entries = Array.isArray(stored?.value) ? stored!.value : [];
        const hit = entries.find((p) => {
          const hay = [p.topic, ...(p.keywords ?? [])].join(" ").toLowerCase();
          return topic.split(/\s+/).some((w) => w.length > 2 && hay.includes(w));
        });
        if (!hit) return { result: { known: false, reason: "not_configured", topic }, escalate: null };
        return {
          result: { known: true, topic: hit.topic, answer: hit.answer, answerAr: hit.answerAr ?? null, provenance: stored!.provenance },
          escalate: null,
        };
      }

      case "escalate_to_human":
        return { result: { known: true, handed_over: true }, escalate: String(input.reason ?? "model requested a person") };

      default:
        return { result: { known: false, reason: "unknown_tool", name }, escalate: null };
    }
  } catch (err) {
    return { result: { known: false, reason: "tool_failed", detail: (err as Error).message }, escalate: null };
  }
}
