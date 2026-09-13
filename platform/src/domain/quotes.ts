import type { Queryable } from "../db/index.js";
import { getRules } from "./settings.js";
import { getVehicle } from "./vehicles.js";
import { checkAvailability } from "./availability.js";
import { computePrice, type PriceBreakdown } from "./pricing.js";
import { badRequest } from "../core/errors.js";
import { audit } from "../core/audit.js";

export type Quote = {
  id: string;
  enquiryId: string;
  vehicleId: string;
  startsAt: string;
  endsAt: string;
  breakdown: PriceBreakdown;
  /** false => the reply must say availability is subject to confirmation */
  availabilityConfirmed: boolean;
  expiresAt: string | null;
};

export async function createQuote(
  db: Queryable,
  tenantId: string,
  input: { enquiryId: string; vehicleId: string; startsAt: Date; endsAt: Date; delivery?: boolean; extras?: number },
): Promise<Quote> {
  const vehicle = await getVehicle(db, tenantId, input.vehicleId);
  if (!vehicle) throw badRequest("Unknown vehicle");
  const rules = await getRules(db, tenantId);
  const breakdown = computePrice({
    vehicle, startsAt: input.startsAt, endsAt: input.endsAt,
    delivery: input.delivery, extras: input.extras, rules,
  });
  if (breakdown.days < vehicle.minDays) {
    throw badRequest(`${vehicle.make} ${vehicle.model} has a ${vehicle.minDays}-day minimum`);
  }

  const avail = await checkAvailability(db, tenantId, input.vehicleId, input.startsAt, input.endsAt);
  // Only claim a confirmed slot when the tenant actually has an authoritative source.
  const availabilityConfirmed = avail.available && avail.authoritative;

  const expiresAt = new Date(Date.now() + rules.quoteValidHours * 3_600_000);
  const { rows } = await db.query(
    `INSERT INTO quotes (tenant_id, enquiry_id, vehicle_id, starts_at, ends_at, days, currency,
                         rate_applied, subtotal, delivery_fee, extras, vat, total, deposit,
                         availability_confirmed, breakdown, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id, enquiry_id, vehicle_id, starts_at, ends_at, availability_confirmed, breakdown, expires_at`,
    [
      tenantId, input.enquiryId, input.vehicleId,
      input.startsAt.toISOString(), input.endsAt.toISOString(), breakdown.days, breakdown.currency,
      breakdown.rateApplied, breakdown.subtotal, breakdown.deliveryFee, breakdown.extras,
      breakdown.vat, breakdown.total, breakdown.deposit, availabilityConfirmed,
      JSON.stringify(breakdown), expiresAt.toISOString(),
    ],
  );
  await db.query(`UPDATE enquiries SET status='quoted' WHERE tenant_id=$1 AND id=$2 AND status IN ('open','qualified')`, [
    tenantId, input.enquiryId,
  ]);
  const r = rows[0];
  await audit({ tenantId, actor: "ai", action: "quote.created", entity: "quote", entityId: r.id, data: { total: breakdown.total, vehicleId: input.vehicleId } }, db);
  return {
    id: r.id, enquiryId: r.enquiry_id, vehicleId: r.vehicle_id,
    startsAt: new Date(r.starts_at).toISOString(), endsAt: new Date(r.ends_at).toISOString(),
    breakdown: r.breakdown, availabilityConfirmed: r.availability_confirmed,
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
  };
}

export async function getQuote(db: Queryable, tenantId: string, id: string): Promise<Quote | null> {
  const { rows } = await db.query(
    `SELECT id, enquiry_id, vehicle_id, starts_at, ends_at, availability_confirmed, breakdown, expires_at
       FROM quotes WHERE tenant_id=$1 AND id=$2`,
    [tenantId, id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id, enquiryId: r.enquiry_id, vehicleId: r.vehicle_id,
    startsAt: new Date(r.starts_at).toISOString(), endsAt: new Date(r.ends_at).toISOString(),
    breakdown: r.breakdown, availabilityConfirmed: r.availability_confirmed,
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
  };
}

export async function createEnquiry(
  db: Queryable,
  tenantId: string,
  input: { conversationId?: string | null; customerId: string; channel: string; vehicleHint?: string | null; startsAt?: Date | null; endsAt?: Date | null; qualification?: Record<string, unknown> },
): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO enquiries (tenant_id, conversation_id, customer_id, channel, vehicle_hint, starts_at, ends_at, qualification)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      tenantId, input.conversationId ?? null, input.customerId, input.channel,
      input.vehicleHint ?? null, input.startsAt?.toISOString() ?? null, input.endsAt?.toISOString() ?? null,
      JSON.stringify(input.qualification ?? {}),
    ],
  );
  await audit({ tenantId, actor: "ai", action: "enquiry.created", entity: "enquiry", entityId: rows[0].id, data: { channel: input.channel } }, db);
  return rows[0].id;
}

export async function updateEnquiry(
  db: Queryable,
  tenantId: string,
  id: string,
  patch: { vehicleHint?: string | null; startsAt?: Date | null; endsAt?: Date | null; status?: string; qualification?: Record<string, unknown> },
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [tenantId, id];
  const push = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (patch.vehicleHint !== undefined) push("vehicle_hint", patch.vehicleHint);
  if (patch.startsAt !== undefined) push("starts_at", patch.startsAt ? patch.startsAt.toISOString() : null);
  if (patch.endsAt !== undefined) push("ends_at", patch.endsAt ? patch.endsAt.toISOString() : null);
  if (patch.status !== undefined) push("status", patch.status);
  if (patch.qualification !== undefined) push("qualification", JSON.stringify(patch.qualification));
  if (!sets.length) return;
  await db.query(`UPDATE enquiries SET ${sets.join(", ")} WHERE tenant_id=$1 AND id=$2`, vals);
}

export async function getEnquiry(db: Queryable, tenantId: string, id: string) {
  const { rows } = await db.query(
    `SELECT id, conversation_id, customer_id, channel, vehicle_hint, starts_at, ends_at, status, qualification
       FROM enquiries WHERE tenant_id=$1 AND id=$2`,
    [tenantId, id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id, conversationId: r.conversation_id, customerId: r.customer_id, channel: r.channel,
    vehicleHint: r.vehicle_hint,
    startsAt: r.starts_at ? new Date(r.starts_at).toISOString() : null,
    endsAt: r.ends_at ? new Date(r.ends_at).toISOString() : null,
    status: r.status, qualification: r.qualification ?? {},
  };
}

/** Most recent open enquiry for a conversation, so a follow-up message keeps context. */
export async function latestEnquiryForConversation(db: Queryable, tenantId: string, conversationId: string) {
  const { rows } = await db.query(
    `SELECT id FROM enquiries WHERE tenant_id=$1 AND conversation_id=$2 AND status <> 'lost'
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId, conversationId],
  );
  return rows[0] ? getEnquiry(db, tenantId, rows[0].id) : null;
}
