import type { Prisma } from "@prisma/client";
import { NotFoundError } from "../core/errors.js";
import type { ExistingClaim, VehicleSnapshot } from "../core/types.js";
import type { TenantTx } from "../db/tenant-context.js";

/**
 * Fleet reads.
 *
 * Everything here returns plain VehicleSnapshot objects rather than Prisma
 * rows, so the pricing and availability engines never see a database type and
 * can be unit tested with object literals.
 *
 * Note the absence of any clientId filter in the where clauses below. It is not
 * an oversight: row level security applies it underneath every one of these
 * queries. Writing it again by hand would imply the isolation depends on
 * remembering to, which is the property this architecture exists to remove.
 */

export interface VehicleSearchCriteria {
  categoryCode?: string;
  /** Inclusive bounds in minor units, matched against the daily rate. */
  maxDailyRateMinor?: number;
  minDailyRateMinor?: number;
  make?: string;
  limit?: number;
}

export class VehicleService {
  async search(tx: TenantTx, criteria: VehicleSearchCriteria): Promise<VehicleSnapshot[]> {
    const where: Prisma.VehicleWhereInput = {
      active: true,
      status: { in: ["AVAILABLE", "ON_HIRE", "RESERVED"] },
      ...(criteria.categoryCode ? { category: { code: criteria.categoryCode } } : {}),
      ...(criteria.make ? { make: { equals: criteria.make, mode: "insensitive" } } : {}),
      ...(criteria.minDailyRateMinor !== undefined || criteria.maxDailyRateMinor !== undefined
        ? {
            dailyRateMinor: {
              ...(criteria.minDailyRateMinor !== undefined ? { gte: criteria.minDailyRateMinor } : {}),
              ...(criteria.maxDailyRateMinor !== undefined ? { lte: criteria.maxDailyRateMinor } : {}),
            },
          }
        : {}),
    };

    const rows = await tx.vehicle.findMany({
      where,
      include: { category: { select: { code: true } } },
      orderBy: [{ dailyRateMinor: "asc" }, { make: "asc" }],
      take: Math.min(criteria.limit ?? 20, 50),
    });

    return rows.map(toSnapshot);
  }

  async getSnapshot(tx: TenantTx, vehicleId: string): Promise<VehicleSnapshot> {
    const row = await tx.vehicle.findUnique({
      where: { id: vehicleId },
      include: { category: { select: { code: true } } },
    });
    // Also the response when the vehicle belongs to another tenant: row level
    // security filters it out, so it is genuinely not found from here.
    if (!row) throw new NotFoundError("Vehicle not found", { vehicleId });
    return toSnapshot(row);
  }

  /**
   * Claims that could block a window. Deliberately a slightly wider net than
   * the requested window so the caller can explain what it clashes with, and so
   * the pure availability engine does the actual overlap decision.
   */
  async claimsFor(tx: TenantTx, vehicleId: string, startAt: Date, endAt: Date): Promise<ExistingClaim[]> {
    const rows = await tx.reservation.findMany({
      where: {
        vehicleId,
        status: { in: ["HOLD", "CONFIRMED"] },
        startAt: { lt: endAt },
        endAt: { gt: startAt },
      },
      select: { id: true, startAt: true, endAt: true, status: true },
      orderBy: { startAt: "asc" },
    });

    return rows.map((r) => ({
      reservationId: r.id,
      startAt: r.startAt,
      endAt: r.endAt,
      status: r.status,
    }));
  }
}

type VehicleRow = Prisma.VehicleGetPayload<{ include: { category: { select: { code: true } } } }>;

function toSnapshot(row: VehicleRow): VehicleSnapshot {
  return {
    id: row.id,
    categoryId: row.categoryId,
    categoryCode: row.category.code,
    make: row.make,
    model: row.model,
    year: row.year,
    plateNumber: row.plateNumber,
    dailyRateMinor: row.dailyRateMinor,
    weeklyRateMinor: row.weeklyRateMinor,
    monthlyRateMinor: row.monthlyRateMinor,
    depositMinor: row.depositMinor,
    status: row.status,
    active: row.active,
    offRoadUntil: row.offRoadUntil,
  };
}
