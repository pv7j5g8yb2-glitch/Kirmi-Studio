import type { FollowUpKind } from "@prisma/client";
import type { FollowUpRule, MessageTemplate } from "../config/tenant-schema.js";
import { requiresTemplate } from "../channels/messaging-window.js";
import type { Logger } from "../core/logger.js";
import type { TenantProfile } from "../core/types.js";
import type { TenantDatabase, TenantTx } from "../db/tenant-context.js";

/**
 * ===========================================================================
 * FOLLOW UPS
 * ===========================================================================
 *
 * The single feature that makes this engine beat a room full of people.
 *
 * A rental desk converts roughly half its enquiries. The other half are not
 * lost because the price was wrong, they are lost because a quote went out on
 * Tuesday and nobody chased it on Thursday. Humans forget; they are busy, or
 * they are with a walk in, or the message scrolled off the screen. A row with
 * a due date does not forget, and it does not care that it is Friday night.
 *
 * Three rules keep this from becoming spam, which is the failure mode that
 * would get a client's number blocked by Meta and end the engagement:
 *
 *   1. Any inbound message from the customer cancels every pending follow up
 *      on that conversation, immediately. The point is to restart a stalled
 *      conversation, never to talk over a live one.
 *   2. A human taking the conversation over cancels them too. If someone is
 *      handling it, the machine is not also chasing in the background.
 *   3. Quiet hours. Answering at 03:18 is the product; ringing someone's phone
 *      at 03:18 to say a quote is still available is a complaint.
 */

export interface ScheduleRequest {
  clientId: string;
  conversationId: string;
  kind: FollowUpKind;
  /** Anchor for the delay. The quote's creation, the call's arrival. */
  from: Date;
  quoteId?: string;
  reservationId?: string;
  attempt?: number;
}

export class FollowUpService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly log: Logger,
  ) {}

  /**
   * Book a future attempt.
   *
   * Idempotent per conversation and kind: scheduling a quote chase twice for
   * one conversation leaves one row, because the pipeline can legitimately run
   * twice for the same message after a retry and the customer must not be
   * messaged twice for it.
   */
  async schedule(profile: TenantProfile, req: ScheduleRequest): Promise<string | null> {
    const rule = findRule(profile, req.kind);
    if (!rule) return null;

    const attempt = req.attempt ?? 1;
    if (attempt > rule.maxAttempts) return null;

    const delayMinutes =
      attempt === 1 ? rule.delayMinutes : (rule.repeatAfterMinutes ?? rule.delayMinutes);
    const dueAt = nextAllowedTime(
      new Date(req.from.getTime() + delayMinutes * 60_000),
      profile,
    );

    return this.db.withTenant(req.clientId, async (tx: TenantTx) => {
      const existing = await tx.followUp.findFirst({
        where: { clientId: req.clientId, conversationId: req.conversationId, kind: req.kind, status: "SCHEDULED" },
        select: { id: true },
      });
      if (existing) return existing.id;

      const row = await tx.followUp.create({
        data: {
          clientId: req.clientId,
          conversationId: req.conversationId,
          kind: req.kind,
          attempt,
          dueAt,
          ...(req.quoteId ? { quoteId: req.quoteId } : {}),
          ...(req.reservationId ? { reservationId: req.reservationId } : {}),
        },
        select: { id: true },
      });
      this.log.debug(
        { clientId: req.clientId, conversationId: req.conversationId, kind: req.kind, dueAt, attempt },
        "follow up scheduled",
      );
      return row.id;
    });
  }

  /**
   * Stop chasing.
   *
   * Called on every inbound message and on every human takeover. Cheap enough
   * to run unconditionally, and running it unconditionally is what guarantees
   * a customer who has just replied never receives a chase a second later.
   */
  async cancelFor(clientId: string, conversationId: string, reason: string): Promise<number> {
    return this.db.withTenant(clientId, async (tx: TenantTx) => {
      const result = await tx.followUp.updateMany({
        where: { clientId, conversationId, status: "SCHEDULED" },
        data: { status: "CANCELLED", cancelledReason: reason },
      });
      return result.count;
    });
  }

  /** Everything owed to customers right now, oldest first. */
  async due(clientId: string, now: Date, limit = 50): Promise<
    Array<{
      id: string;
      conversationId: string;
      kind: FollowUpKind;
      attempt: number;
      quoteId: string | null;
      reservationId: string | null;
    }>
  > {
    return this.db.withTenant(clientId, async (tx: TenantTx) =>
      tx.followUp.findMany({
        where: { clientId, status: "SCHEDULED", dueAt: { lte: now } },
        orderBy: { dueAt: "asc" },
        take: limit,
        select: { id: true, conversationId: true, kind: true, attempt: true, quoteId: true, reservationId: true },
      }),
    );
  }

  async markSent(clientId: string, id: string, templateName: string | null, messageId: string): Promise<void> {
    await this.db.withTenant(clientId, async (tx: TenantTx) => {
      await tx.followUp.update({
        where: { id },
        data: {
          status: "SENT",
          sentAt: new Date(),
          sentMessageId: messageId,
          ...(templateName ? { templateName } : {}),
        },
      });
    });
  }

  async markFailed(clientId: string, id: string, error: string): Promise<void> {
    await this.db.withTenant(clientId, async (tx: TenantTx) => {
      await tx.followUp.update({ where: { id }, data: { status: "FAILED", lastError: error.slice(0, 500) } });
    });
  }

  /** Push a due row out to the end of quiet hours rather than dropping it. */
  async defer(clientId: string, id: string, until: Date): Promise<void> {
    await this.db.withTenant(clientId, async (tx: TenantTx) => {
      await tx.followUp.update({ where: { id }, data: { dueAt: until } });
    });
  }
}

export function findRule(profile: TenantProfile, kind: FollowUpKind): FollowUpRule | null {
  const rule = profile.proactive.followUp.rules.find((r) => r.kind === kind);
  return rule?.enabled ? rule : null;
}

export function findTemplate(profile: TenantProfile, kind: FollowUpKind): MessageTemplate | null {
  return profile.proactive.templates.find((t) => t.kind === kind) ?? null;
}

/**
 * Compose what the customer will actually receive.
 *
 * Inside the service window a plain sentence reads far better than an approved
 * template, so the free form wording is preferred when one is configured.
 * Outside it, a template is the only legal option and its absence means the
 * follow up cannot be sent at all, which is worth an explicit null rather than
 * a send that Meta will silently refuse.
 */
export function composeFollowUp(
  profile: TenantProfile,
  kind: FollowUpKind,
  channel: TenantProfile["channels"] extends never ? never : Parameters<typeof requiresTemplate>[0],
  lastInboundAt: Date | null,
  now: Date,
  params: Partial<Record<string, string>>,
): { body: string; template?: { name: string; language: string; bodyParams: string[] } } | null {
  const template = findTemplate(profile, kind);
  const mustUseTemplate = requiresTemplate(channel, lastInboundAt, now);

  if (!mustUseTemplate && template?.freeFormBody) {
    return { body: fill(template.freeFormBody, params) };
  }
  if (!template) return null;

  const bodyParams = template.bodyParams.map((p) => params[p] ?? "");
  // A template whose placeholders resolve to blanks reads as broken to the
  // customer and is worse than not sending. Better to skip and say why.
  if (bodyParams.some((v) => v.length === 0)) return null;

  const rendered = template.freeFormBody
    ? fill(template.freeFormBody, params)
    : `${template.name}: ${bodyParams.join(", ")}`;

  return { body: rendered, template: { name: template.name, language: template.language, bodyParams } };
}

function fill(text: string, params: Partial<Record<string, string>>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => params[key] ?? "");
}

/**
 * Move a timestamp out of the client's quiet hours.
 *
 * Works in the client's own timezone, because 21:30 means 21:30 where the
 * customer is, and a fleet in Dubai serving a customer who is also in Dubai
 * should not be governed by whatever timezone the server happens to run in.
 */
export function nextAllowedTime(when: Date, profile: TenantProfile): Date {
  const quiet = profile.proactive.followUp.quietHours;
  if (!quiet) return when;

  const local = localHourMinute(when, profile.timezone);
  const minutes = local.hour * 60 + local.minute;
  const from = toMinutes(quiet.from);
  const to = toMinutes(quiet.to);

  // A window like 21:30 to 08:30 wraps midnight, so the test is an OR rather
  // than a range. Getting this backwards silences the entire daytime instead.
  const inQuiet = from > to ? minutes >= from || minutes < to : minutes >= from && minutes < to;
  if (!inQuiet) return when;

  const minutesUntilOpen = (to - minutes + 24 * 60) % (24 * 60);
  return new Date(when.getTime() + minutesUntilOpen * 60_000);
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

function localHourMinute(at: Date, timeZone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return { hour: hour === 24 ? 0 : hour, minute };
}
