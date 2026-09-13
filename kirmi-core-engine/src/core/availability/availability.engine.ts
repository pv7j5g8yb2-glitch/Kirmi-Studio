import { windowsOverlap } from "../time.js";
import type { ExistingClaim, RentalWindow, VehicleSnapshot } from "../types.js";

/**
 * ===========================================================================
 * THE AVAILABILITY ENGINE (pure half)
 * ===========================================================================
 *
 * Deciding whether a car can be sold splits into two halves, and keeping them
 * apart is what makes the hard half testable.
 *
 * This file is the deterministic half: given a vehicle, the claims already on
 * it and a requested window, is it sellable. No database, no clock of its own,
 * no locks. Every branch is reachable from a plain object in a unit test.
 *
 * The other half lives in services/reservation.service.ts, where a pessimistic
 * row lock turns this verdict from "was true a moment ago" into "is true and
 * cannot change until I commit". This function on its own is an opinion. The
 * lock is what makes it a guarantee.
 */

export type UnavailabilityReason =
  | "VEHICLE_INACTIVE"
  | "VEHICLE_RETIRED"
  | "VEHICLE_IN_MAINTENANCE"
  | "VEHICLE_OFF_ROAD"
  | "WINDOW_IN_PAST"
  | "WINDOW_CONFLICT";

export interface AvailabilityVerdict {
  available: boolean;
  reasons: UnavailabilityReason[];
  /** The claims that actually clash, so a human or the reply can name dates. */
  conflicts: ExistingClaim[];
}

/** Claim statuses that occupy a car. A cancelled hold frees the window. */
const BLOCKING_STATUSES: ReadonlySet<ExistingClaim["status"]> = new Set(["HOLD", "CONFIRMED"]);

export function claimBlocks(claim: ExistingClaim): boolean {
  return BLOCKING_STATUSES.has(claim.status);
}

/**
 * Which existing claims clash with a requested window.
 * Half open comparison: a return at 10:00 and a collection at 10:00 is one
 * handover, not a double booking.
 */
export function findConflicts(claims: readonly ExistingClaim[], window: RentalWindow): ExistingClaim[] {
  return claims.filter(
    (claim) => claimBlocks(claim) && windowsOverlap(window.startAt, window.endAt, claim.startAt, claim.endAt),
  );
}

/**
 * The full verdict. Collects every reason rather than returning the first,
 * because a human in the inbox needs to know the car is both in maintenance and
 * already promised, not just the first fact the loop happened to hit.
 */
export function assessAvailability(
  vehicle: VehicleSnapshot,
  claims: readonly ExistingClaim[],
  window: RentalWindow,
  now: Date,
): AvailabilityVerdict {
  const reasons: UnavailabilityReason[] = [];

  if (!vehicle.active) reasons.push("VEHICLE_INACTIVE");
  if (vehicle.status === "RETIRED") reasons.push("VEHICLE_RETIRED");
  if (vehicle.status === "MAINTENANCE") reasons.push("VEHICLE_IN_MAINTENANCE");

  // A car booked back in for service partway through a requested hire is not
  // available for that hire, even though it is available today.
  if (vehicle.offRoadUntil !== null && vehicle.offRoadUntil.getTime() > window.startAt.getTime()) {
    reasons.push("VEHICLE_OFF_ROAD");
  }

  if (window.endAt.getTime() <= now.getTime()) reasons.push("WINDOW_IN_PAST");

  const conflicts = findConflicts(claims, window);
  if (conflicts.length > 0) reasons.push("WINDOW_CONFLICT");

  return { available: reasons.length === 0, reasons, conflicts };
}

/**
 * Human readable rendering of a verdict, for the escalation payload and for the
 * reply the agent is allowed to send. Deliberately plain: a customer told "this
 * one is out until the 14th" books something else, a customer told
 * "VEHICLE_OFF_ROAD" books with a competitor.
 */
export function explainVerdict(verdict: AvailabilityVerdict, vehicle: VehicleSnapshot): string {
  if (verdict.available) return `${vehicle.make} ${vehicle.model} is free for those dates.`;

  const parts: string[] = [];
  for (const reason of verdict.reasons) {
    switch (reason) {
      case "VEHICLE_INACTIVE":
      case "VEHICLE_RETIRED":
        parts.push("this car is no longer in the fleet");
        break;
      case "VEHICLE_IN_MAINTENANCE":
      case "VEHICLE_OFF_ROAD":
        parts.push("this car is off the road for servicing");
        break;
      case "WINDOW_IN_PAST":
        parts.push("those dates have already passed");
        break;
      case "WINDOW_CONFLICT":
        parts.push("it is already booked across those dates");
        break;
    }
  }
  return `${vehicle.make} ${vehicle.model}: ${[...new Set(parts)].join(", ")}.`;
}
