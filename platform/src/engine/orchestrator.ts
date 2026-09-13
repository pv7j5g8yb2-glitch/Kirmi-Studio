import type { Queryable } from "../db/index.js";
import { understand, type Extracted } from "./nlu.js";
import { toolSearchVehicles, toolCheckAvailability, toolQuote, toolRentalRules, toolAvailableOn, money } from "./tools.js";
import { getConversation, type Conversation } from "../domain/conversations.js";
import { createEnquiry, latestEnquiryForConversation, updateEnquiry } from "../domain/quotes.js";
import { getRules } from "../domain/settings.js";
import { rentalDays } from "../domain/availability.js";

export type EngineDecision = {
  /** Text to send. Null means say nothing (e.g. a human has the conversation). */
  reply: string | null;
  /** Set when the engine cannot answer truthfully and a person must step in. */
  escalate: { reason: string } | null;
  enquiryId: string | null;
  quoteId: string | null;
  /** Slot state after this turn, for the operator console and tests. */
  understood: Extracted;
  toolsUsed: string[];
};

type Ctx = { db: Queryable; tenantId: string; conversation: Conversation; now: Date };

const T = {
  en: {
    greeting: (co: string) => `Hello, thanks for messaging ${co}. Which car are you looking for, and which dates?`,
    needDates: (v: string) => `We have the ${v}. Which dates do you need it, and for how many days?`,
    needVehicle: `Which car would you like, and which dates?`,
    noMatch: (hint: string) => `I could not find "${hint}" in the fleet. Would you like me to send what is available for your dates?`,
    subjectToConfirm: `Availability is subject to confirmation with the team.`,
    handover: `Of course, I am passing you to a colleague now.`,
    docs: (docs: string[], age: number, drivers: number) =>
      `You will need your ${docs.join(" and ")}. Minimum age is ${age}, and up to ${drivers} named driver${drivers > 1 ? "s" : ""} can be on the contract.`,
    unavailable: (v: string, alts: string[]) =>
      alts.length
        ? `The ${v} is taken for those dates. I can offer the ${alts.join(" or the ")} instead — shall I price one of those?`
        : `The ${v} is not free for those dates. Would different dates work?`,
    escalated: `Let me check that with the team and come straight back to you.`,
  },
  ar: {
    greeting: (co: string) => `أهلاً بك، شكراً لتواصلك مع ${co}. أي سيارة تبحث عنها، وفي أي تواريخ؟`,
    needDates: (v: string) => `${v} متوفرة لدينا. ما التواريخ التي تحتاجها، وكم عدد الأيام؟`,
    needVehicle: `أي سيارة تفضل، وفي أي تواريخ؟`,
    noMatch: (hint: string) => `لم أجد "${hint}" ضمن الأسطول. هل تحب أن أرسل لك المتاح في تواريخك؟`,
    subjectToConfirm: `التوفر بحاجة إلى تأكيد من الفريق.`,
    handover: `بالتأكيد، سأحولك إلى أحد الزملاء الآن.`,
    docs: (docs: string[], age: number, drivers: number) =>
      `ستحتاج إلى ${docs.join(" و")}. الحد الأدنى للعمر ${age} سنة، ويمكن إضافة ${drivers} سائق على العقد.`,
    unavailable: (v: string, alts: string[]) =>
      alts.length
        ? `${v} محجوزة في تلك التواريخ. أستطيع أن أعرض عليك ${alts.join(" أو ")} بدلاً منها، هل أسعّر لك إحداها؟`
        : `${v} غير متاحة في تلك التواريخ. هل تناسبك تواريخ أخرى؟`,
    escalated: `سأتحقق من ذلك مع الفريق وأعود إليك فوراً.`,
  },
} as const;

const DOC_LABELS: Record<string, { en: string; ar: string }> = {
  passport: { en: "passport", ar: "جواز السفر" },
  driving_licence: { en: "driving licence", ar: "رخصة القيادة" },
  international_permit: { en: "international driving permit", ar: "رخصة القيادة الدولية" },
  visa: { en: "visa", ar: "التأشيرة" },
};

function quoteText(
  locale: "en" | "ar",
  q: Extract<Awaited<ReturnType<typeof toolQuote>>, { known: true }>,
  subjectToConfirmation: boolean,
): string {
  const label = `${q.vehicle.make} ${q.vehicle.model}`;
  const total = money(q.total, q.currency);
  const deposit = q.deposit > 0 ? money(q.deposit, q.currency) : null;
  const km = q.includedKmPerDay ? `${q.includedKmPerDay} km/day included` : null;
  const kmAr = q.includedKmPerDay ? `${q.includedKmPerDay} كم يومياً مشمولة` : null;

  if (locale === "ar") {
    const bits = [`${label} لمدة ${q.days} ${q.days === 1 ? "يوم" : "أيام"}: ${total} شامل الضريبة.`];
    if (deposit) bits.push(`التأمين ${deposit} يُحجز ويُعاد.`);
    if (kmAr) bits.push(kmAr + ".");
    if (subjectToConfirmation) bits.push(T.ar.subjectToConfirm);
    bits.push("هل أحجزها لك؟");
    return bits.join(" ");
  }
  const bits = [`${label} for ${q.days} day${q.days === 1 ? "" : "s"}: ${total} including VAT.`];
  if (deposit) bits.push(`Deposit ${deposit}, held and returned.`);
  if (km) bits.push(km + ".");
  if (subjectToConfirmation) bits.push(T.en.subjectToConfirm);
  bits.push("Shall I hold it for you?");
  return bits.join(" ");
}

/**
 * Decides the reply for one inbound message.
 *
 * Two rules dominate everything else: the engine never states availability or a price
 * it did not get from a tool, and any slot it cannot fill truthfully becomes an
 * escalation rather than a guess.
 */
export async function handleInbound(
  ctx: Ctx,
  text: string,
  companyName: string,
): Promise<EngineDecision> {
  const toolsUsed: string[] = [];
  const understood = understand(text, ctx.now);
  const L = understood.locale;
  const t = T[L];

  // A person holds this conversation: the AI stands down entirely.
  const fresh = await getConversation(ctx.db, ctx.tenantId, ctx.conversation.id);
  if (fresh?.state === "human_active") {
    return { reply: null, escalate: null, enquiryId: null, quoteId: null, understood, toolsUsed };
  }

  if (understood.intent === "handover_request") {
    return {
      reply: t.handover,
      escalate: { reason: "customer asked for a person" },
      enquiryId: null, quoteId: null, understood, toolsUsed,
    };
  }

  // Carry slots forward across turns: "the G63" then "3 days from Friday".
  let enquiry = await latestEnquiryForConversation(ctx.db, ctx.tenantId, ctx.conversation.id);
  if (!enquiry) {
    const id = await createEnquiry(ctx.db, ctx.tenantId, {
      conversationId: ctx.conversation.id,
      customerId: ctx.conversation.customerId,
      channel: ctx.conversation.channel,
      vehicleHint: understood.vehicleHint,
      startsAt: understood.startsAt,
      endsAt: understood.endsAt,
    });
    enquiry = await latestEnquiryForConversation(ctx.db, ctx.tenantId, ctx.conversation.id);
    void id;
  }
  const enquiryId = enquiry!.id;

  const hint = understood.vehicleHint ?? enquiry!.vehicleHint ?? null;
  const startsAt = understood.startsAt ?? (enquiry!.startsAt ? new Date(enquiry!.startsAt) : null);
  let endsAt = understood.endsAt ?? (enquiry!.endsAt ? new Date(enquiry!.endsAt) : null);
  if (startsAt && !endsAt && understood.days) endsAt = new Date(startsAt.getTime() + understood.days * 86_400_000);

  await updateEnquiry(ctx.db, ctx.tenantId, enquiryId, {
    vehicleHint: hint, startsAt, endsAt,
    status: startsAt && endsAt && hint ? "qualified" : "open",
  });

  if (understood.intent === "document_question") {
    const rules = await toolRentalRules(ctx);
    toolsUsed.push("rental_rules");
    const docs = rules.requiredDocuments.map((d) => DOC_LABELS[d]?.[L] ?? d);
    return {
      reply: t.docs(docs, rules.minAge, rules.maxDrivers),
      escalate: null, enquiryId, quoteId: null, understood, toolsUsed,
    };
  }

  if (understood.intent === "greeting" && !hint && !startsAt) {
    return { reply: t.greeting(companyName), escalate: null, enquiryId, quoteId: null, understood, toolsUsed };
  }

  // No car named yet: if we have dates, show what is actually free.
  if (!hint) {
    if (startsAt && endsAt) {
      const free = await toolAvailableOn(ctx, startsAt, endsAt);
      toolsUsed.push("available_on");
      if (free.vehicles.length) {
        const list = free.vehicles.map((v) => `${v.label} (${money(v.dailyRate)}/day)`).join(", ");
        const reply = L === "ar"
          ? `المتاح في تلك التواريخ: ${list}. أي واحدة تفضل؟`
          : `Available for those dates: ${list}. Which one would you like?`;
        return { reply, escalate: null, enquiryId, quoteId: null, understood, toolsUsed };
      }
      return {
        reply: t.escalated,
        escalate: { reason: "no vehicles free for the requested dates" },
        enquiryId, quoteId: null, understood, toolsUsed,
      };
    }
    return { reply: t.needVehicle, escalate: null, enquiryId, quoteId: null, understood, toolsUsed };
  }

  const search = await toolSearchVehicles(ctx, hint);
  toolsUsed.push("search_vehicles");
  const match = search.matches[0];
  if (!match) {
    return { reply: t.noMatch(hint), escalate: null, enquiryId, quoteId: null, understood, toolsUsed };
  }

  if (!startsAt || !endsAt) {
    return { reply: t.needDates(match.label), escalate: null, enquiryId, quoteId: null, understood, toolsUsed };
  }

  const avail = await toolCheckAvailability(ctx, { vehicleId: match.id, startsAt, endsAt });
  toolsUsed.push("check_availability");
  if (avail.known && !avail.available) {
    return {
      reply: t.unavailable(match.label, avail.alternatives.map((a) => a.label)),
      escalate: null, enquiryId, quoteId: null, understood, toolsUsed,
    };
  }

  const q = await toolQuote(ctx, {
    vehicleId: match.id, startsAt, endsAt, enquiryId,
    delivery: understood.delivery ?? false, persist: true,
  });
  toolsUsed.push("quote");

  if (!q.known) {
    if (q.reason === "below_minimum") {
      const rules = await getRules(ctx.db, ctx.tenantId);
      void rules;
      const reply = L === "ar"
        ? `${match.label} حدها الأدنى ${match.minDays} أيام. هل أسعّر لك ${match.minDays} أيام؟`
        : `The ${match.label} has a ${match.minDays}-day minimum. Shall I quote ${match.minDays} days?`;
      return { reply, escalate: null, enquiryId, quoteId: null, understood, toolsUsed };
    }
    return {
      reply: t.escalated,
      escalate: { reason: `cannot quote: ${q.reason}` },
      enquiryId, quoteId: null, understood, toolsUsed,
    };
  }

  // Availability we could not authoritatively verify is always disclosed as such.
  const subjectToConfirmation = !q.availabilityConfirmed;
  return {
    reply: quoteText(L, q, subjectToConfirmation),
    escalate: null,
    enquiryId,
    quoteId: q.quoteId,
    understood,
    toolsUsed,
  };
}

export { rentalDays };
