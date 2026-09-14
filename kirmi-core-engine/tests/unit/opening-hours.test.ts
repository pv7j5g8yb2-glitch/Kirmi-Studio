import { describe, expect, it } from "vitest";
import { isWithinOpeningHours, minutesOfDayInZone } from "../../src/core/time.js";

/**
 * Opening hours drive the "out of hours" figure on the client dashboard, which
 * is the number that answers "what are we paying you for". A client is invoiced
 * against it, so the edges are worth pinning down rather than assuming.
 */

const DUBAI = "Asia/Dubai"; // UTC+4, no daylight saving

const hours = {
  mon: [{ open: "09:00", close: "21:00" }],
  tue: [{ open: "09:00", close: "21:00" }],
  wed: [{ open: "09:00", close: "13:00" }, { open: "16:00", close: "21:00" }],
  thu: [{ open: "09:00", close: "21:00" }],
  fri: [{ open: "14:00", close: "22:00" }],
  sat: [{ open: "10:00", close: "22:00" }],
  sun: [],
  exceptions: [{ date: "2026-12-25", closed: true, windows: [] }],
};

describe("opening hours, in the client's own timezone", () => {
  it("counts a working hours enquiry as in hours", () => {
    // 2026-09-14 is a Monday. 10:00 UTC is 14:00 in Dubai.
    expect(isWithinOpeningHours(new Date("2026-09-14T10:00:00Z"), hours, DUBAI)).toBe(true);
  });

  it("counts the 3am enquiry as out of hours, which is the whole product", () => {
    // 23:18 UTC is 03:18 the next day in Dubai.
    expect(isWithinOpeningHours(new Date("2026-09-14T23:18:00Z"), hours, DUBAI)).toBe(false);
  });

  it("uses the client's timezone, not the server's", () => {
    // 22:00 UTC on Monday is 02:00 Tuesday in Dubai, which is shut. Comparing
    // in UTC would read this as Monday 22:00, also shut, but by luck rather
    // than correctness. 06:00 UTC is 10:00 Dubai, open; in UTC it would look
    // like an early morning and read as closed.
    expect(isWithinOpeningHours(new Date("2026-09-14T06:00:00Z"), hours, DUBAI)).toBe(true);
    expect(minutesOfDayInZone(new Date("2026-09-14T06:00:00Z"), DUBAI)).toBe(10 * 60);
  });

  it("handles a desk that shuts for the afternoon", () => {
    // Wednesday, closed 13:00 to 16:00 local.
    expect(isWithinOpeningHours(new Date("2026-09-16T06:00:00Z"), hours, DUBAI)).toBe(true); // 10:00
    expect(isWithinOpeningHours(new Date("2026-09-16T10:00:00Z"), hours, DUBAI)).toBe(false); // 14:00
    expect(isWithinOpeningHours(new Date("2026-09-16T14:00:00Z"), hours, DUBAI)).toBe(true); // 18:00
  });

  it("treats a day with no windows as closed all day", () => {
    // Sunday. An empty list means shut, not "unknown, assume open".
    expect(isWithinOpeningHours(new Date("2026-09-13T10:00:00Z"), hours, DUBAI)).toBe(false);
  });

  it("lets a dated exception beat the weekly pattern", () => {
    // 2026-12-25 is a Friday, normally open 14:00 to 22:00 local.
    // 12:00 UTC is 16:00 Dubai, inside those hours, but the desk is shut.
    expect(isWithinOpeningHours(new Date("2026-12-25T12:00:00Z"), hours, DUBAI)).toBe(false);
  });

  it("is exclusive at closing time", () => {
    // 17:00 UTC is 21:00 Dubai, the minute the desk shuts. Counting it as open
    // would quietly shave a booking off the out of hours figure every evening.
    expect(isWithinOpeningHours(new Date("2026-09-14T17:00:00Z"), hours, DUBAI)).toBe(false);
    expect(isWithinOpeningHours(new Date("2026-09-14T16:59:00Z"), hours, DUBAI)).toBe(true);
  });
});
