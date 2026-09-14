import { createContextCache } from "../src/cache/conversation-context.cache.js";
import { disconnectRedis } from "../src/cache/redis.js";
import { logger } from "../src/core/logger.js";
import { formatMoney } from "../src/core/money.js";
import { calculatePrice } from "../src/core/pricing/pricing.engine.js";
import type { VehicleSnapshot } from "../src/core/types.js";
import { disconnectPrisma, prisma } from "../src/db/prisma.js";
import { tenantDatabase, withTenant } from "../src/db/tenant-context.js";
import { ClientConfigService } from "../src/services/client-config.service.js";

/**
 * ===========================================================================
 * WHAT WOULD A CUSTOMER ACTUALLY BE CHARGED
 * ===========================================================================
 *
 *   npm run price-check -- <slug> [YYYY-MM-DD]
 *   npm run price-check -- deiz 2026-12-28
 *
 * Prints the real price for every car at 1, 3, 7 and 30 days, using the same
 * pricing engine that quotes a customer. Not a simulation of it: the same
 * function, the same config, the same rounding.
 *
 * This exists because of the single worst thing that can happen on a go-live
 * done by somebody who is not a developer. A seasonal modifier entered as
 * 1.25 instead of 12500 basis points, or a daily rate entered in dirhams
 * instead of fils, does not crash anything. It produces a confident, wrong
 * number, sends it to a real customer in writing, and the client finds out
 * when the car leaves the lot at a hundredth of its rate.
 *
 * So: run this, put it next to the client's own printed rate card, and read
 * across. Five minutes, and it is the difference between a pilot and an
 * apology.
 *
 * Pass a date to see the same fleet priced inside a seasonal window, which is
 * the other thing worth eyeballing before December arrives.
 */
async function main(): Promise<void> {
  const slug = process.argv[2];
  const dateArg = process.argv[3];

  if (!slug) {
    process.stdout.write("\nUsage: npm run price-check -- <slug> [YYYY-MM-DD]\n\n");
    process.exitCode = 1;
    return;
  }

  const entry = await prisma().tenantDirectory.findUnique({ where: { slug } });
  if (!entry) {
    process.stdout.write(`\nNo client with slug "${slug}".\n\n`);
    process.exitCode = 1;
    return;
  }

  const config = new ClientConfigService(tenantDatabase, createContextCache(), logger());
  const tenant = await config.loadProfile(entry.clientId);

  const start = dateArg ? new Date(`${dateArg}T10:00:00Z`) : new Date(Date.now() + 24 * 60 * 60 * 1000);
  if (Number.isNaN(start.getTime())) {
    process.stdout.write(`\n"${dateArg}" is not a date I can read. Use YYYY-MM-DD.\n\n`);
    process.exitCode = 1;
    return;
  }

  const vehicles = await withTenant(entry.clientId, async (tx) => {
    const rows = await tx.vehicle.findMany({
      where: { clientId: entry.clientId, active: true },
      orderBy: [{ dailyRateMinor: "desc" }],
      include: { category: { select: { code: true } } },
    });
    return rows;
  });

  if (vehicles.length === 0) {
    process.stdout.write(`\nNo vehicles loaded for ${tenant.tradingName}.\n\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`\n${tenant.tradingName}  ·  prices a customer would be quoted\n`);
  process.stdout.write(`Collection ${start.toISOString().slice(0, 10)}  ·  VAT ${tenant.pricing.vatBasisPoints / 100}%`);
  process.stdout.write(`  ·  currency ${tenant.currency}\n\n`);

  const durations = [1, 3, 7, 30];
  const header = ["Vehicle", "Daily rate", ...durations.map((d) => `${d} day${d > 1 ? "s" : ""}`)];
  const rows: string[][] = [];
  const warnings: string[] = [];

  for (const v of vehicles) {
    const snapshot: VehicleSnapshot = {
      id: v.id,
      categoryId: v.categoryId,
      categoryCode: v.category.code,
      make: v.make,
      model: v.model,
      year: v.year,
      plateNumber: v.plateNumber,
      dailyRateMinor: v.dailyRateMinor,
      weeklyRateMinor: v.weeklyRateMinor,
      monthlyRateMinor: v.monthlyRateMinor,
      depositMinor: v.depositMinor,
      status: v.status,
      active: v.active,
      offRoadUntil: v.offRoadUntil,
    };

    const cells = durations.map((days) => {
      const price = calculatePrice({
        tenant,
        vehicle: snapshot,
        categoryCode: v.category.code,
        startAt: start,
        endAt: new Date(start.getTime() + days * 24 * 60 * 60 * 1000),
        deliveryRequested: false,
        addOns: [],
      });

      // The sanity checks that catch a unit mistake. A rate typed in dirhams
      // rather than fils makes a supercar cost less than a taxi, and nothing
      // in the system objects.
      const perDay = price.totalMinor / days;
      if (days === 1 && perDay < 10_000) {
        warnings.push(
          `${v.make} ${v.model} prices at ${formatMoney(price.totalMinor, tenant.currency)} for one day. ` +
            `That is suspiciously low: rates are stored in fils, so AED 1,800 a day is 180000, not 1800.`,
        );
      }
      if (days === 1 && perDay > 20_000_00) {
        warnings.push(
          `${v.make} ${v.model} prices at ${formatMoney(price.totalMinor, tenant.currency)} for one day, ` +
            `which looks like a rate entered a hundred times too high.`,
        );
      }
      if (price.seasonalBasisPoints !== 0 && (price.seasonalBasisPoints < 2_000 || price.seasonalBasisPoints > 40_000)) {
        warnings.push(
          `Seasonal window "${price.seasonalCode}" multiplies by ${price.seasonalBasisPoints} basis points. ` +
            `10000 means no change, 12500 means +25%. This looks like a decimal typed where basis points belong.`,
        );
      }

      return formatMoney(price.totalMinor, tenant.currency);
    });

    rows.push([`${v.year} ${v.make} ${v.model}`, formatMoney(v.dailyRateMinor, tenant.currency), ...cells]);
  }

  printTable(header, rows);

  // One fully itemised example, because a total is not checkable but a
  // derivation is.
  const sample = vehicles[0];
  if (sample) {
    const price = calculatePrice({
      tenant,
      vehicle: {
        id: sample.id, categoryId: sample.categoryId, categoryCode: sample.category.code,
        make: sample.make, model: sample.model, year: sample.year, plateNumber: sample.plateNumber,
        dailyRateMinor: sample.dailyRateMinor, weeklyRateMinor: sample.weeklyRateMinor,
        monthlyRateMinor: sample.monthlyRateMinor, depositMinor: sample.depositMinor,
        status: sample.status, active: sample.active, offRoadUntil: sample.offRoadUntil,
      },
      categoryCode: sample.category.code,
      startAt: start,
      endAt: new Date(start.getTime() + 3 * 24 * 60 * 60 * 1000),
      deliveryRequested: true,
      addOns: [],
    });

    const money = (m: number): string => formatMoney(m, tenant.currency);
    process.stdout.write(`\nFull breakdown  ·  ${sample.make} ${sample.model}, 3 days, with delivery\n\n`);
    process.stdout.write(`  Bracket used            ${price.rateBracket} at ${money(price.unitRateMinor)} x ${price.units}\n`);
    if (price.remainderDays > 0) {
      process.stdout.write(`  Remainder               ${price.remainderDays} day(s) at ${money(price.remainderRateMinor)}\n`);
    }
    process.stdout.write(`  Base fare               ${money(price.baseFareMinor)}\n`);
    process.stdout.write(
      `  Seasonal                ${price.seasonalCode ?? "none"}` +
        `${price.seasonalCode ? ` (${price.seasonalBasisPoints} bp, ${money(price.seasonalAdjustmentMinor)})` : ""}\n`,
    );
    process.stdout.write(`  Delivery                ${price.deliveryWaived ? "waived" : money(price.deliveryFeeMinor)}\n`);
    process.stdout.write(`  Subtotal                ${money(price.subtotalMinor)}\n`);
    process.stdout.write(`  VAT at ${price.vatBasisPoints / 100}%              ${money(price.vatMinor)}\n`);
    process.stdout.write(`  Total                   ${money(price.totalMinor)}\n`);
    process.stdout.write(`  Refundable deposit      ${money(price.depositMinor)}\n`);
  }

  const unique = [...new Set(warnings)];
  if (unique.length > 0) {
    process.stdout.write(`\nWorth a second look before go-live:\n\n`);
    for (const w of unique) process.stdout.write(`  - ${w}\n`);
    process.stdout.write("\n");
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`\nNothing here looks mistyped. Compare the table against the client's own rate card.\n\n`);
}

function printTable(header: string[], rows: string[][]): void {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]): string =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0))).join("   ");

  process.stdout.write(`  ${line(header)}\n`);
  process.stdout.write(`  ${widths.map((w) => "-".repeat(w)).join("   ")}\n`);
  for (const r of rows) process.stdout.write(`  ${line(r)}\n`);
}

main()
  .catch((err: unknown) => {
    process.stdout.write(`\nCould not price the fleet: ${err instanceof Error ? err.message : String(err)}\n\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectPrisma().catch(() => undefined);
    await disconnectRedis().catch(() => undefined);
  });
