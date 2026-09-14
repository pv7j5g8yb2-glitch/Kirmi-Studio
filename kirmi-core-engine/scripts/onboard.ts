import { readFileSync } from "node:fs";
import { z } from "zod";
import { BASIS_POINTS_SCALE } from "../src/config/constants.js";
import { disconnectRedis } from "../src/cache/redis.js";
import { formatMoney } from "../src/core/money.js";
import { disconnectPrisma } from "../src/db/prisma.js";
import { withTenant } from "../src/db/tenant-context.js";

/**
 * ===========================================================================
 * ONBOARD A CLIENT FROM A FILE
 * ===========================================================================
 *
 *   npm run onboard -- onboarding/deiz.json
 *   npm run onboard -- onboarding/deiz.json --dry-run
 *
 * Adding a client should not require editing TypeScript. It requires knowing
 * the client's rates and opening hours, which is a commercial question, not an
 * engineering one, and the person who knows the answer is usually not the
 * person who can safely edit a seed file.
 *
 * So the input is one JSON file in plain business language: percentages rather
 * than basis points, "per day" rather than PER_DAY, hours rather than minutes.
 * This script does the translation, and does it in one place that is read once
 * and reviewed, instead of in whatever the person typing happened to assume.
 *
 * Money is the exception and is deliberately NOT translated. Every figure is
 * in fils, spelled out in the field name, because a helpful "just type
 * dirhams" conversion is one rounding rule away from a rental priced at a
 * hundredth of its rate. Run `npm run price-check` afterwards and read the
 * table; that is the real safety net.
 *
 * Re-running with the same slug updates rather than duplicates, so fixing a
 * typo is editing the file and running it again.
 */

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM, 24 hour");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const window = z.object({ open: timeOfDay, close: timeOfDay });

const fileSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/, "lowercase letters, numbers and hyphens only"),
  legalName: z.string().min(1),
  tradingName: z.string().min(1),
  tradeLicenceNumber: z.string().min(1),
  currency: z.string().length(3).default("AED"),
  timezone: z.string().min(1).default("Asia/Dubai"),

  languages: z.array(z.string()).min(1).default(["en"]),
  defaultLanguage: z.string().default("en"),

  rules: z
    .object({
      minimumDriverAge: z.number().int().min(16).max(99).default(25),
      minimumLicenceYears: z.number().int().min(0).max(20).default(1),
      requiredDocuments: z.array(z.string()).default(["passport", "driving_licence"]),
      strictAgeByCategory: z.record(z.string(), z.number().int().min(16).max(99)).default({}),
    })
    .default({}),

  pricing: z
    .object({
      vatPercent: z.number().min(0).max(100).default(5),
      weeklyRateFromDays: z.number().int().min(1).default(7),
      monthlyRateFromDays: z.number().int().min(1).default(28),
      deliveryFeeFils: z.number().int().min(0).default(0),
      freeDeliveryFromDays: z.number().int().min(1).nullable().default(null),
      defaultDepositFils: z.number().int().min(0).default(0),
      quoteValidMinutes: z.number().int().min(5).default(120),
      holdMinutes: z.number().int().min(5).default(30),
      /** The car must stay held long enough for the customer to actually pay.
       *  Thirty minutes is right for "let me think", and badly wrong for a
       *  link sent at 11pm. */
      paymentHoldMinutes: z.number().int().min(30).default(240),
    })
    .default({}),

  payments: z
    .object({
      provider: z.enum(["stripe", "manual"]).default("manual"),
      captureUpfrontPercent: z.number().min(0).max(100).default(100),
    })
    .default({}),

  seasons: z
    .array(
      z.object({
        code: z.string().min(1),
        label: z.string().optional(),
        from: isoDate,
        to: isoDate,
        /** +30 means thirty percent dearer, -15 means fifteen percent cheaper. */
        changePercent: z.number().min(-90).max(400),
        categories: z.array(z.string()).default([]),
      }),
    )
    .default([]),

  addOns: z
    .array(
      z.object({
        code: z.string().min(1),
        label: z.string().min(1),
        per: z.enum(["day", "rental"]).default("rental"),
        priceFils: z.number().int().min(0),
        mandatoryForCategories: z.array(z.string()).default([]),
      }),
    )
    .default([]),

  openingHours: z
    .object({
      mon: z.array(window).default([]),
      tue: z.array(window).default([]),
      wed: z.array(window).default([]),
      thu: z.array(window).default([]),
      fri: z.array(window).default([]),
      sat: z.array(window).default([]),
      sun: z.array(window).default([]),
    })
    .default({}),

  categories: z.array(z.object({ code: z.string().min(1), name: z.string().min(1) })).min(1),

  vehicles: z
    .array(
      z.object({
        category: z.string().min(1),
        make: z.string().min(1),
        model: z.string().min(1),
        year: z.number().int().min(1950).max(2100),
        colour: z.string().optional(),
        plate: z.string().min(1),
        dailyFils: z.number().int().min(1),
        weeklyFils: z.number().int().min(1).nullable().default(null),
        monthlyFils: z.number().int().min(1).nullable().default(null),
        depositFils: z.number().int().min(0).nullable().default(null),
        includedKmPerDay: z.number().int().min(0).nullable().default(null),
        extraKmFils: z.number().int().min(0).nullable().default(null),
        photos: z.array(z.string().url()).default([]),
      }),
    )
    .default([]),

  agent: z
    .object({
      displayName: z.string().nullable().default(null),
      toneNotes: z.string().nullable().default(null),
      extraInstructions: z.string().nullable().default(null),
    })
    .default({}),

  followUps: z
    .object({
      quietHoursFrom: timeOfDay.nullable().default("21:30"),
      quietHoursTo: timeOfDay.nullable().default("08:30"),
      chaseQuoteAfterHours: z.number().min(0.1).default(24),
      chaseQuoteAttempts: z.number().int().min(1).max(3).default(2),
      chaseAgainAfterHours: z.number().min(1).default(48),
    })
    .default({}),

  templates: z
    .array(
      z.object({
        for: z.enum(["QUOTE_NO_REPLY", "HOLD_EXPIRING", "MISSED_CALL", "REACTIVATION"]),
        metaTemplateName: z.string().min(1),
        language: z.string().min(2).default("en"),
        placeholders: z
          .array(z.enum(["customerName", "businessName", "vehicleName", "quoteTotal", "reference", "holdExpiry", "startDate"]))
          .default([]),
        wordingInsideTheWindow: z.string().optional(),
      }),
    )
    .default([]),

  kirmiTerms: z
    .object({
      feeModel: z.enum(["RETAINER", "COMMISSION", "HYBRID"]).default("COMMISSION"),
      monthlyRetainerFils: z.number().int().min(0).default(0),
      commissionPercent: z.number().min(0).max(100).default(10),
    })
    .default({}),

  options: z
    .object({
      smsFallback: z.boolean().default(false),
      sendVehiclePhotos: z.boolean().default(true),
    })
    .default({}),
});

type ClientFile = z.infer<typeof fileSchema>;

async function main(): Promise<void> {
  const path = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");

  if (!path) {
    process.stdout.write("\nUsage: npm run onboard -- onboarding/<file>.json [--dry-run]\n\n");
    process.exitCode = 1;
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    process.stdout.write(`\nCould not read ${path}: ${err instanceof Error ? err.message : String(err)}\n\n`);
    process.exitCode = 1;
    return;
  }

  // Strip the comment block the template carries, so it is not a validation error.
  if (raw && typeof raw === "object") delete (raw as Record<string, unknown>)["_readme"];

  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    process.stdout.write(`\n${path} has problems:\n\n`);
    for (const issue of parsed.error.issues) {
      process.stdout.write(`  ${issue.path.join(".") || "(root)"}: ${issue.message}\n`);
    }
    process.stdout.write("\nNothing was written.\n\n");
    process.exitCode = 1;
    return;
  }

  const file = parsed.data;
  const problems = crossCheck(file);
  if (problems.length > 0) {
    process.stdout.write(`\n${path} is valid JSON but does not hang together:\n\n`);
    for (const p of problems) process.stdout.write(`  ${p}\n`);
    process.stdout.write("\nNothing was written.\n\n");
    process.exitCode = 1;
    return;
  }

  summarise(file);

  if (dryRun) {
    process.stdout.write("Dry run, so nothing was written. Drop --dry-run to apply it.\n\n");
    return;
  }

  const { clientId, created } = await apply(file);
  process.stdout.write(`${created ? "Created" : "Updated"} ${file.tradingName}.\n`);
  process.stdout.write(`  clientId  ${clientId}\n\n`);
  process.stdout.write("Next:\n");
  process.stdout.write(`  npm run price-check -- ${file.slug}     check the rates against their price list\n`);
  process.stdout.write(`  npm run db:issue-key ${file.slug}       a key for the inbox\n`);
  process.stdout.write(`  npm run doctor                          confirm it is ready to take an enquiry\n\n`);
}

/**
 * The checks zod cannot express: things that are individually valid but
 * contradict each other. Every one of these has a plausible customer facing
 * consequence, which is why they stop the write rather than warn.
 */
function crossCheck(file: ClientFile): string[] {
  const problems: string[] = [];
  const categoryCodes = new Set(file.categories.map((c) => c.code));

  for (const v of file.vehicles) {
    if (!categoryCodes.has(v.category)) {
      problems.push(`Vehicle ${v.make} ${v.model} is in category "${v.category}", which is not in the categories list.`);
    }
    if (v.weeklyFils && v.weeklyFils > v.dailyFils * 7) {
      problems.push(
        `${v.make} ${v.model}: the weekly rate is dearer than seven daily rates, so nobody would ever take it.`,
      );
    }
    if (v.monthlyFils && v.weeklyFils && v.monthlyFils > v.weeklyFils * 4) {
      problems.push(`${v.make} ${v.model}: the monthly rate is dearer than four weekly rates.`);
    }
    // The unit mistake, caught before it reaches a customer.
    if (v.dailyFils < 10_000) {
      problems.push(
        `${v.make} ${v.model}: a daily rate of ${v.dailyFils} fils is ${formatMoney(v.dailyFils, file.currency)}. ` +
          `Rates are in fils, so AED 1,800 a day is 180000.`,
      );
    }
  }

  const plates = file.vehicles.map((v) => v.plate);
  const duplicates = plates.filter((p, i) => plates.indexOf(p) !== i);
  if (duplicates.length > 0) problems.push(`Duplicate plate(s): ${[...new Set(duplicates)].join(", ")}`);

  for (const s of file.seasons) {
    if (s.from >= s.to) problems.push(`Season "${s.code}" ends on or before it starts.`);
    for (const c of s.categories) {
      if (!categoryCodes.has(c)) problems.push(`Season "${s.code}" names category "${c}", which does not exist.`);
    }
  }

  for (const c of Object.keys(file.rules.strictAgeByCategory)) {
    if (!categoryCodes.has(c)) problems.push(`A stricter age is set for category "${c}", which does not exist.`);
  }

  for (const a of file.addOns) {
    for (const c of a.mandatoryForCategories) {
      if (!categoryCodes.has(c)) problems.push(`Add-on "${a.code}" is mandatory for "${c}", which does not exist.`);
    }
  }

  // A template with placeholders but no wording renders as bare values, which
  // reads as broken to a customer.
  for (const t of file.templates) {
    if (t.placeholders.length > 0 && !t.wordingInsideTheWindow) {
      problems.push(
        `Template "${t.metaTemplateName}" has placeholders but no wordingInsideTheWindow, so a reply inside the ` +
          `24 hour window would be sent as raw values.`,
      );
    }
  }

  if (file.pricing.paymentHoldMinutes <= file.pricing.holdMinutes) {
    problems.push(
      `paymentHoldMinutes (${file.pricing.paymentHoldMinutes}) must be longer than holdMinutes ` +
        `(${file.pricing.holdMinutes}). Otherwise a car is released before the customer can pay for it, ` +
        `and the booking drops off the commission report.`,
    );
  }

  if (file.vehicles.length === 0) problems.push("No vehicles, so there is nothing to quote.");
  if (file.templates.length === 0) {
    problems.push("No templates, so no follow up could ever be sent and conversion stays where it is.");
  }

  return problems;
}

function summarise(file: ClientFile): void {
  const money = (m: number): string => formatMoney(m, file.currency);
  process.stdout.write(`\n${file.tradingName}  (${file.slug})\n\n`);
  process.stdout.write(`  Timezone             ${file.timezone}\n`);
  process.stdout.write(`  Languages            ${file.languages.join(", ")}\n`);
  process.stdout.write(`  VAT                  ${file.pricing.vatPercent}%\n`);
  process.stdout.write(`  Delivery             ${money(file.pricing.deliveryFeeFils)}`);
  process.stdout.write(
    file.pricing.freeDeliveryFromDays ? `, free from ${file.pricing.freeDeliveryFromDays} days\n` : `\n`,
  );
  process.stdout.write(`  Minimum age          ${file.rules.minimumDriverAge}\n`);
  process.stdout.write(`  Categories           ${file.categories.map((c) => c.code).join(", ")}\n`);
  process.stdout.write(`  Vehicles             ${file.vehicles.length}\n`);
  process.stdout.write(
    `  Daily rates          ${money(Math.min(...file.vehicles.map((v) => v.dailyFils)))} to ` +
      `${money(Math.max(...file.vehicles.map((v) => v.dailyFils)))}\n`,
  );
  for (const s of file.seasons) {
    process.stdout.write(
      `  Season ${s.code.padEnd(14)}${s.changePercent > 0 ? "+" : ""}${s.changePercent}%  ${s.from} to ${s.to}\n`,
    );
  }
  process.stdout.write(`  Templates            ${file.templates.map((t) => t.metaTemplateName).join(", ") || "none"}\n`);
  process.stdout.write(
    `  Quiet hours          ${file.followUps.quietHoursFrom ?? "none"} to ${file.followUps.quietHoursTo ?? "none"}\n`,
  );
  process.stdout.write(
    `  Kirmi terms          ${file.kirmiTerms.feeModel}, ${file.kirmiTerms.commissionPercent}%` +
      `${file.kirmiTerms.monthlyRetainerFils > 0 ? `, retainer ${money(file.kirmiTerms.monthlyRetainerFils)}` : ""}\n\n`,
  );
}

/** Translate the business language into what the engine stores. */
async function apply(file: ClientFile): Promise<{ clientId: string; created: boolean }> {
  const { prisma } = await import("../src/db/prisma.js");
  const existing = await prisma().tenantDirectory.findUnique({ where: { slug: file.slug } });
  const clientId = existing?.clientId ?? crypto.randomUUID();
  const created = !existing;

  const pct = (percent: number): number => Math.round(BASIS_POINTS_SCALE * (1 + percent / 100));

  await withTenant(clientId, async (tx) => {
    await tx.client.upsert({
      where: { id: clientId },
      create: {
        id: clientId,
        slug: file.slug,
        legalName: file.legalName,
        tradingName: file.tradingName,
        tradeLicenceNumber: file.tradeLicenceNumber,
        currency: file.currency,
        timezone: file.timezone,
        status: "ACTIVE",
      },
      update: {
        legalName: file.legalName,
        tradingName: file.tradingName,
        tradeLicenceNumber: file.tradeLicenceNumber,
        currency: file.currency,
        timezone: file.timezone,
      },
    });

    const config = {
      openingHours: { ...file.openingHours, exceptions: [] },
      supportedLanguages: file.languages,
      defaultLanguage: file.defaultLanguage,
      minimumDriverAge: file.rules.minimumDriverAge,
      minimumLicenceYears: file.rules.minimumLicenceYears,
      requiredDocuments: file.rules.requiredDocuments,
      categoryAgeOverrides: file.rules.strictAgeByCategory,
      vatBasisPoints: Math.round(file.pricing.vatPercent * 100),
      weeklyThresholdDays: file.pricing.weeklyRateFromDays,
      monthlyThresholdDays: file.pricing.monthlyRateFromDays,
      deliveryFeeMinor: file.pricing.deliveryFeeFils,
      freeDeliveryThresholdDays: file.pricing.freeDeliveryFromDays,
      defaultDepositMinor: file.pricing.defaultDepositFils,
      quoteValidMinutes: file.pricing.quoteValidMinutes,
      holdTtlMinutes: file.pricing.holdMinutes,
      paymentHoldMinutes: file.pricing.paymentHoldMinutes,
      // Only the provider choice and capture rate. The secret keys are set
      // separately so re-running this file can never wipe a credential.
      paymentAccessKeys: {
        provider: file.payments.provider,
        depositCaptureBasisPoints: Math.round(file.payments.captureUpfrontPercent * 100),
      },
      seasonalModifiers: file.seasons.map((s) => ({
        code: s.code,
        ...(s.label ? { label: s.label } : {}),
        startsOn: s.from,
        endsOn: s.to,
        multiplierBasisPoints: pct(s.changePercent),
        categoryCodes: s.categories,
      })),
      addOnCatalogue: file.addOns.map((a) => ({
        code: a.code,
        label: a.label,
        unit: a.per === "day" ? "PER_DAY" : "PER_RENTAL",
        priceMinor: a.priceFils,
        mandatoryForCategoryCodes: a.mandatoryForCategories,
      })),
      messageTemplates: file.templates.map((t) => ({
        kind: t.for,
        name: t.metaTemplateName,
        language: t.language,
        bodyParams: t.placeholders,
        ...(t.wordingInsideTheWindow ? { freeFormBody: t.wordingInsideTheWindow } : {}),
      })),
      followUpPolicy: {
        rules: [
          {
            kind: "QUOTE_NO_REPLY",
            enabled: true,
            delayMinutes: Math.round(file.followUps.chaseQuoteAfterHours * 60),
            maxAttempts: file.followUps.chaseQuoteAttempts,
            repeatAfterMinutes: Math.round(file.followUps.chaseAgainAfterHours * 60),
          },
          { kind: "HOLD_EXPIRING", enabled: true, delayMinutes: 15, maxAttempts: 1 },
          { kind: "MISSED_CALL", enabled: true, delayMinutes: 1, maxAttempts: 1 },
        ],
        quietHours:
          file.followUps.quietHoursFrom && file.followUps.quietHoursTo
            ? { from: file.followUps.quietHoursFrom, to: file.followUps.quietHoursTo }
            : null,
      },
      smsFallbackEnabled: file.options.smsFallback,
      vehiclePhotosEnabled: file.options.sendVehiclePhotos,
      escalationTargets: [],
      escalationRules: {},
      agentDisplayName: file.agent.displayName,
      agentToneNotes: file.agent.toneNotes,
      systemPromptExtra: file.agent.extraInstructions,
      feeModel: file.kirmiTerms.feeModel,
      retainerMinor: file.kirmiTerms.monthlyRetainerFils,
      commissionBasisPoints: Math.round(file.kirmiTerms.commissionPercent * 100),
    };

    await tx.clientConfiguration.upsert({
      where: { clientId },
      create: { clientId, ...config },
      // Credentials are deliberately absent from both branches: a re-run to fix
      // a rate must never wipe the Meta token somebody set separately.
      update: config,
    });

    const categoryIds = new Map<string, string>();
    for (const [index, c] of file.categories.entries()) {
      const row = await tx.vehicleCategory.upsert({
        where: { clientId_code: { clientId, code: c.code } },
        create: { clientId, code: c.code, name: c.name, sortOrder: index },
        update: { name: c.name, sortOrder: index },
      });
      categoryIds.set(c.code, row.id);
    }

    for (const v of file.vehicles) {
      const categoryId = categoryIds.get(v.category);
      if (!categoryId) continue;
      const data = {
        categoryId,
        make: v.make,
        model: v.model,
        year: v.year,
        colour: v.colour ?? null,
        dailyRateMinor: v.dailyFils,
        weeklyRateMinor: v.weeklyFils,
        monthlyRateMinor: v.monthlyFils,
        depositMinor: v.depositFils,
        includedKmPerDay: v.includedKmPerDay,
        extraKmRateMinor: v.extraKmFils,
        imageUrls: v.photos,
        active: true,
      };
      await tx.vehicle.upsert({
        where: { clientId_plateNumber: { clientId, plateNumber: v.plate } },
        create: { clientId, plateNumber: v.plate, status: "AVAILABLE", ...data },
        update: data,
      });
    }
  });

  return { clientId, created };
}

main()
  .catch((err: unknown) => {
    process.stdout.write(`\nOnboarding failed: ${err instanceof Error ? err.message : String(err)}\n\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectPrisma().catch(() => undefined);
    await disconnectRedis().catch(() => undefined);
  });
