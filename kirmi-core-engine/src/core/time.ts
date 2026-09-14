import { HOURS_PER_RENTAL_DAY } from "../config/constants.js";
import { ValidationError } from "./errors.js";

/**
 * Time handling for rentals.
 *
 * Two things make this less trivial than it looks. Rental days are billed as
 * whole days rounded up, so a 25 hour hire is two days, and every tenant has
 * its own timezone, so "which day is this" has to be asked in Dubai time for a
 * Dubai client and in Eastern time for a US one. Getting either wrong hands a
 * customer a car on the wrong date.
 */

export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Billable days for a window. Rounded up, minimum one: a four hour hire is a
 * day's hire, which is how every rental desk in the world bills it.
 */
export function rentalDays(startAt: Date, endAt: Date): number {
  const ms = endAt.getTime() - startAt.getTime();
  if (!Number.isFinite(ms)) throw new ValidationError("Rental window contains an invalid date");
  if (ms <= 0) throw new ValidationError("Rental must end after it starts");
  return Math.max(1, Math.ceil(ms / (HOURS_PER_RENTAL_DAY * MS_PER_HOUR)));
}

/** Half open overlap: a car returned at 10:00 and collected at 10:00 is fine. */
export function windowsOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

/**
 * The calendar date at an instant, in a named timezone, as YYYY-MM-DD.
 * Used to decide which seasonal window a rental start falls into, because
 * "starts 1 January" means 1 January where the client trades.
 */
export function isoDateInZone(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);

  const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const [year, month, day] = [pick("year"), pick("month"), pick("day")];
  if (!year || !month || !day) throw new ValidationError(`Unusable timezone: ${timezone}`);
  return `${year}-${month}-${day}`;
}

/** Short weekday key at an instant in a timezone, matching OpeningHours keys. */
export function weekdayInZone(at: Date, timezone: string): "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun" {
  const label = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short" })
    .format(at)
    .toLowerCase()
    .slice(0, 3);
  const map: Record<string, "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun"> = {
    mon: "mon", tue: "tue", wed: "wed", thu: "thu", fri: "fri", sat: "sat", sun: "sun",
  };
  const day = map[label];
  if (!day) throw new ValidationError(`Unusable timezone: ${timezone}`);
  return day;
}

export function minutesFromNow(minutes: number, from: Date = new Date()): Date {
  return new Date(from.getTime() + minutes * 60_000);
}

/** Monotonic elapsed milliseconds. Wall clock time can step; a latency number cannot. */
export function elapsedMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

export function startTimer(): bigint {
  return process.hrtime.bigint();
}

/**
 * Was this moment inside the client's opening hours?
 *
 * Used to answer the question a client actually asks at renewal: how many of
 * these enquiries would nobody have answered at all. That makes it a number
 * somebody is being invoiced against, so it is worth being exact about.
 *
 * Three things it gets right that a naive version does not. Dated exceptions
 * win over the weekly pattern, because a public holiday is precisely when the
 * desk is shut and the engine is most valuable. A day can hold several windows,
 * so a desk that shuts for lunch does not count the afternoon as closed. And
 * everything is evaluated in the CLIENT's timezone: a 02:00 Dubai enquiry is
 * the previous evening in UTC, and comparing in the wrong zone would quietly
 * move a fifth of the week's out-of-hours enquiries into working hours.
 *
 * A day with no windows configured is closed all day, which is the correct
 * reading of an empty list rather than an omission to be guessed at.
 */
export function isWithinOpeningHours(
  at: Date,
  hours: {
    mon: ReadonlyArray<{ open: string; close: string }>;
    tue: ReadonlyArray<{ open: string; close: string }>;
    wed: ReadonlyArray<{ open: string; close: string }>;
    thu: ReadonlyArray<{ open: string; close: string }>;
    fri: ReadonlyArray<{ open: string; close: string }>;
    sat: ReadonlyArray<{ open: string; close: string }>;
    sun: ReadonlyArray<{ open: string; close: string }>;
    exceptions: ReadonlyArray<{ date: string; closed: boolean; windows: ReadonlyArray<{ open: string; close: string }> }>;
  },
  timezone: string,
): boolean {
  const localDate = isoDateInZone(at, timezone);
  const minutes = minutesOfDayInZone(at, timezone);

  const exception = hours.exceptions.find((e) => e.date === localDate);
  if (exception) {
    if (exception.closed) return false;
    return exception.windows.some((w) => withinWindow(minutes, w));
  }

  const windows = hours[weekdayInZone(at, timezone)];
  return windows.some((w) => withinWindow(minutes, w));
}

function withinWindow(minutes: number, window: { open: string; close: string }): boolean {
  return minutes >= hhmmToMinutes(window.open) && minutes < hhmmToMinutes(window.close);
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/** Minutes since local midnight in the given zone. */
export function minutesOfDayInZone(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return (hour === 24 ? 0 : hour) * 60 + minute;
}
