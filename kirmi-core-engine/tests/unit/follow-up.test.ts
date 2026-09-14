import { describe, expect, it } from "vitest";
import {
  channelHasServiceWindow,
  isWithinServiceWindow,
  minutesLeftInWindow,
  requiresTemplate,
} from "../../src/channels/messaging-window.js";
import { composeFollowUp, nextAllowedTime } from "../../src/services/follow-up.service.js";
import { tenantFixture } from "../helpers/fixtures.js";

/**
 * The 24 hour window and the quiet hours rule.
 *
 * Both are pure functions over timestamps, and both fail silently in
 * production when they are wrong: a window miscalculation means Meta refuses
 * the send and the follow up simply never happens, which looks identical to
 * having no follow ups at all. So they are tested directly here rather than
 * inferred from whatever the carrier accepted on the day.
 */

const HOUR = 60 * 60 * 1000;
const now = new Date("2026-09-14T12:00:00Z");

describe("the 24 hour service window", () => {
  it("allows a free form reply shortly after the customer wrote", () => {
    expect(isWithinServiceWindow(new Date(now.getTime() - 2 * HOUR), now)).toBe(true);
    expect(requiresTemplate("WHATSAPP", new Date(now.getTime() - 2 * HOUR), now)).toBe(false);
  });

  it("requires a template once 24 hours have passed", () => {
    expect(isWithinServiceWindow(new Date(now.getTime() - 25 * HOUR), now)).toBe(false);
    expect(requiresTemplate("WHATSAPP", new Date(now.getTime() - 25 * HOUR), now)).toBe(true);
  });

  it("treats the last ten minutes as already closed", () => {
    // Meta's clock closes the window, not ours. A send that leaves at 23h59m
    // can land after it has shut, and a refused follow up is worse than a
    // slightly more formal one.
    const almost = new Date(now.getTime() - (24 * HOUR - 5 * 60_000));
    expect(isWithinServiceWindow(almost, now)).toBe(false);
  });

  it("has no window at all when the customer has never written", () => {
    // The missed call case: they rang, never messaged, so a template is the
    // only way to reach them on WhatsApp.
    expect(isWithinServiceWindow(null, now)).toBe(false);
    expect(requiresTemplate("WHATSAPP", null, now)).toBe(true);
  });

  it("does not gate SMS or telephony, which are not Meta's to gate", () => {
    expect(channelHasServiceWindow("SMS")).toBe(false);
    expect(requiresTemplate("SMS", null, now)).toBe(false);
    expect(requiresTemplate("WEB", null, now)).toBe(false);
  });

  it("reports the time a human has left to answer freely", () => {
    expect(minutesLeftInWindow(new Date(now.getTime() - 23 * HOUR), now)).toBe(60);
    expect(minutesLeftInWindow(new Date(now.getTime() - 30 * HOUR), now)).toBe(0);
  });
});

describe("composing a follow up", () => {
  const profile = tenantFixture();

  it("prefers plain wording while the window is open", () => {
    const composed = composeFollowUp(
      profile,
      "QUOTE_NO_REPLY",
      "WHATSAPP",
      new Date(now.getTime() - 1 * HOUR),
      now,
      { customerName: "Rashid", vehicleName: "Urus" },
    );
    expect(composed?.template).toBeUndefined();
    expect(composed?.body).toContain("Urus");
  });

  it("switches to the approved template once the window has shut", () => {
    const composed = composeFollowUp(
      profile,
      "QUOTE_NO_REPLY",
      "WHATSAPP",
      new Date(now.getTime() - 40 * HOUR),
      now,
      { customerName: "Rashid", vehicleName: "Urus" },
    );
    expect(composed?.template?.name).toBe("quote_follow_up");
    expect(composed?.template?.bodyParams).toEqual(["Rashid", "Urus"]);
  });

  it("refuses to send a template whose placeholders would render blank", () => {
    // WhatsApp renders a missing parameter as an empty string, so this would
    // reach the customer as "Your  is still available".
    const composed = composeFollowUp(
      profile,
      "QUOTE_NO_REPLY",
      "WHATSAPP",
      new Date(now.getTime() - 40 * HOUR),
      now,
      { customerName: "Rashid" },
    );
    expect(composed).toBeNull();
  });

  it("returns nothing when no template is configured for the kind", () => {
    const composed = composeFollowUp(profile, "REACTIVATION", "WHATSAPP", null, now, {});
    expect(composed).toBeNull();
  });
});

describe("quiet hours", () => {
  // The fixture is Asia/Dubai, quiet from 21:30 to 08:30 local.
  const profile = tenantFixture();

  it("leaves a daytime send alone", () => {
    const noonDubai = new Date("2026-09-14T08:00:00Z"); // 12:00 in Dubai
    expect(nextAllowedTime(noonDubai, profile).toISOString()).toBe(noonDubai.toISOString());
  });

  it("defers a late night send to the morning rather than dropping it", () => {
    const threeAmDubai = new Date("2026-09-14T23:18:00Z"); // 03:18 next day in Dubai
    const moved = nextAllowedTime(threeAmDubai, profile);
    expect(moved.getTime()).toBeGreaterThan(threeAmDubai.getTime());
    const dubaiHour = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Dubai",
      hour: "2-digit",
      hour12: false,
    }).format(moved);
    expect(dubaiHour).toBe("08");
  });

  it("handles the window that wraps midnight in both halves", () => {
    const justBefore = new Date("2026-09-14T17:45:00Z"); // 21:45 Dubai, inside quiet
    const justAfter = new Date("2026-09-14T05:00:00Z"); // 09:00 Dubai, outside
    expect(nextAllowedTime(justBefore, profile).getTime()).toBeGreaterThan(justBefore.getTime());
    expect(nextAllowedTime(justAfter, profile).getTime()).toBe(justAfter.getTime());
  });
});
