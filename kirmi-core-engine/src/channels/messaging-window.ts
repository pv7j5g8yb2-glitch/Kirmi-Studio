import type { ChannelType } from "@prisma/client";

/**
 * ===========================================================================
 * THE 24 HOUR CUSTOMER SERVICE WINDOW
 * ===========================================================================
 *
 * Meta allows free form replies only within 24 hours of the customer's last
 * message. Outside it, the single permitted form is a template the business
 * registered and Meta approved in advance.
 *
 * This is the rule that decides whether the engine can do the one thing a
 * person reliably fails at: chase the quote that went quiet on Tuesday. Get it
 * wrong in the permissive direction and Meta rejects the send, the follow up
 * silently never happens, and the client's conversion looks exactly as it did
 * before. Get it wrong in the restrictive direction and a customer who is
 * actively typing receives a stilted template instead of an answer.
 *
 * So it lives here as a pure function over two timestamps, with no database
 * and no clock of its own, and it is tested directly rather than inferred from
 * whatever Meta happened to accept on the day.
 *
 * The margin is deliberate. The window closes on Meta's clock, not ours, and a
 * send that leaves here at 23h59m50s can arrive after it has shut. Treating the
 * last ten minutes as already closed costs a slightly more formal message and
 * buys a message that actually arrives.
 */

export const SERVICE_WINDOW_HOURS = 24;
const SERVICE_WINDOW_MS = SERVICE_WINDOW_HOURS * 60 * 60 * 1000;
export const WINDOW_SAFETY_MARGIN_MS = 10 * 60 * 1000;

/** Channels Meta gates behind the window. SMS, telephony and web are ours. */
const WINDOWED_CHANNELS: ReadonlySet<ChannelType> = new Set<ChannelType>(["WHATSAPP", "INSTAGRAM"]);

export function channelHasServiceWindow(channel: ChannelType): boolean {
  return WINDOWED_CHANNELS.has(channel);
}

/**
 * Is a free form message still allowed?
 *
 * A conversation that has never received an inbound message has no window at
 * all, which is the missed call case: the customer rang, never wrote, and the
 * only way to reach them on WhatsApp is a template.
 */
export function isWithinServiceWindow(
  lastInboundAt: Date | null | undefined,
  now: Date,
  marginMs: number = WINDOW_SAFETY_MARGIN_MS,
): boolean {
  if (!lastInboundAt) return false;
  const elapsed = now.getTime() - lastInboundAt.getTime();
  // A clock skew that puts the last inbound in the future is still "recent".
  if (elapsed < 0) return true;
  return elapsed < SERVICE_WINDOW_MS - marginMs;
}

/** True when this send must use an approved template or not go at all. */
export function requiresTemplate(
  channel: ChannelType,
  lastInboundAt: Date | null | undefined,
  now: Date,
): boolean {
  if (!channelHasServiceWindow(channel)) return false;
  return !isWithinServiceWindow(lastInboundAt, now);
}

/** Whole minutes until the window shuts, or 0 once it has. For the inbox, so a
 *  human can see they have forty minutes left to answer freely. */
export function minutesLeftInWindow(
  lastInboundAt: Date | null | undefined,
  now: Date,
): number {
  if (!lastInboundAt) return 0;
  const remaining = lastInboundAt.getTime() + SERVICE_WINDOW_MS - now.getTime();
  return remaining <= 0 ? 0 : Math.floor(remaining / 60_000);
}
