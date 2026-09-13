import { describe, expect, it } from "vitest";
import { assessAvailability, findConflicts } from "../../src/core/availability/availability.engine.js";
import type { ExistingClaim } from "../../src/core/types.js";
import { vehicleFixture, window } from "../helpers/fixtures.js";

const now = new Date("2026-03-01T00:00:00.000Z");

function claim(startIso: string, endIso: string, status: ExistingClaim["status"] = "CONFIRMED"): ExistingClaim {
  return { reservationId: `r-${startIso}`, startAt: new Date(startIso), endAt: new Date(endIso), status };
}

describe("availability engine", () => {
  const vehicle = vehicleFixture();

  it("sells a free car", () => {
    const verdict = assessAvailability(vehicle, [], window(3), now);
    expect(verdict.available).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it("blocks a window that overlaps a confirmed booking", () => {
    const claims = [claim("2026-03-11T00:00:00.000Z", "2026-03-14T00:00:00.000Z")];
    const verdict = assessAvailability(vehicle, claims, window(3), now);
    expect(verdict.available).toBe(false);
    expect(verdict.reasons).toContain("WINDOW_CONFLICT");
    expect(verdict.conflicts).toHaveLength(1);
  });

  it("treats a hold as blocking, exactly like a confirmed booking", () => {
    const claims = [claim("2026-03-11T00:00:00.000Z", "2026-03-14T00:00:00.000Z", "HOLD")];
    expect(assessAvailability(vehicle, claims, window(3), now).available).toBe(false);
  });

  it("frees the window once a claim is cancelled or expired", () => {
    for (const status of ["CANCELLED", "EXPIRED"] as const) {
      const claims = [claim("2026-03-11T00:00:00.000Z", "2026-03-14T00:00:00.000Z", status)];
      expect(assessAvailability(vehicle, claims, window(3), now).available).toBe(true);
    }
  });

  it("allows a same-instant handover: one car returned at 10:00 and collected at 10:00", () => {
    const claims = [claim("2026-03-07T08:00:00.000Z", "2026-03-10T08:00:00.000Z")];
    // window(3) starts at exactly 2026-03-10T08:00:00Z.
    expect(findConflicts(claims, window(3))).toHaveLength(0);
  });

  it("refuses a car that is retired, inactive or in maintenance", () => {
    expect(assessAvailability(vehicleFixture({ active: false }), [], window(2), now).reasons).toContain("VEHICLE_INACTIVE");
    expect(assessAvailability(vehicleFixture({ status: "RETIRED" }), [], window(2), now).reasons).toContain("VEHICLE_RETIRED");
    expect(assessAvailability(vehicleFixture({ status: "MAINTENANCE" }), [], window(2), now).reasons).toContain("VEHICLE_IN_MAINTENANCE");
  });

  it("refuses a car booked back in for service partway through the hire", () => {
    const offRoad = vehicleFixture({ offRoadUntil: new Date("2026-03-12T00:00:00.000Z") });
    expect(assessAvailability(offRoad, [], window(3), now).reasons).toContain("VEHICLE_OFF_ROAD");
  });

  it("refuses a window that has already passed", () => {
    const past = { startAt: new Date("2026-02-01T00:00:00.000Z"), endAt: new Date("2026-02-03T00:00:00.000Z") };
    expect(assessAvailability(vehicle, [], past, now).reasons).toContain("WINDOW_IN_PAST");
  });

  it("reports every reason, not just the first one it hits", () => {
    const broken = vehicleFixture({ active: false, status: "MAINTENANCE" });
    const claims = [claim("2026-03-11T00:00:00.000Z", "2026-03-14T00:00:00.000Z")];
    const verdict = assessAvailability(broken, claims, window(3), now);
    expect(verdict.reasons).toEqual(
      expect.arrayContaining(["VEHICLE_INACTIVE", "VEHICLE_IN_MAINTENANCE", "WINDOW_CONFLICT"]),
    );
  });
});
