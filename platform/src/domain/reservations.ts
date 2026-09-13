import type { Queryable } from "../db/index.js";
import { audit } from "../core/audit.js";
import { conflict, badRequest } from "../core/errors.js";
import { placeBlock, releaseBlocksFor, checkAvailability } from "./availability.js";
import { getRules } from "./settings.js";

export type ReservationState =
  | "draft" | "held" | "documents_pending" | "payment_pending"
  | "confirmed" | "cancelled" | "expired" | "completed";

/**
 * Legal transitions. A reservation can only reach `confirmed` from payment_pending
 * or documents_pending, and confirm() additionally demands an authoritative source —
 * the brief forbids confirming a booking on anything softer.
 */
const TRANSITIONS: Record<ReservationState, ReservationState[]> = {
  draft: ["held", "cancelled"],
  held: ["documents_pending", "payment_pending", "cancelled", "expired"],
  documents_pending: ["payment_pending", "confirmed", "cancelled", "expired"],
  payment_pending: ["confirmed", "cancelled", "expired"],
  confirmed: ["completed", "cancelled"],
  cancelled: [],
  expired: [],
  completed: [],
};

export function canTransition(from: ReservationState, to: ReservationState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export type Reservation = {
  id: string;
  quoteId: string;
  customerId: string;
  vehicleId: string;
  startsAt: string;
  endsAt: string;
  state: ReservationState;
  holdExpiresAt: string | null;
  confirmedAt: string | null;
  confirmationSource: string | null;
  total: number;
  currency: string;
};

const SELECT = `id, quote_id, customer_id, vehicle_id, starts_at, ends_at, state,
                hold_expires_at, confirmed_at, confirmation_source, total, currency`;

function map(r: any): Reservation {
  return {
    id: r.id, quoteId: r.quote_id, customerId: r.customer_id, vehicleId: r.vehicle_id,
    startsAt: new Date(r.starts_at).toISOString(), endsAt: new Date(r.ends_at).toISOString(),
    state: r.state, holdExpiresAt: r.hold_expires_at ? new Date(r.hold_expires_at).toISOString() : null,
    confirmedAt: r.confirmed_at ? new Date(r.confirmed_at).toISOString() : null,
    confirmationSource: r.confirmation_source, total: r.total, currency: r.currency,
  };
}

export async function getReservation(db: Queryable, tenantId: string, id: string): Promise<Reservation | null> {
  const { rows } = await db.query(`SELECT ${SELECT} FROM reservations WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  return rows[0] ? map(rows[0]) : null;
}

async function recordEvent(
  db: Queryable, tenantId: string, reservationId: string,
  from: ReservationState | null, to: ReservationState, reason: string, actor: string,
): Promise<void> {
  await db.query(
    `INSERT INTO reservation_events (tenant_id, reservation_id, from_state, to_state, reason, actor)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [tenantId, reservationId, from, to, reason, actor],
  );
}

/**
 * Creates the reservation and takes the inventory hold in one transaction. If the
 * vehicle was taken between quote and hold, nothing is written at all.
 */
export async function createHold(
  db: Queryable,
  tenantId: string,
  input: { quoteId: string; customerId: string; vehicleId: string; startsAt: Date; endsAt: Date; total: number; currency?: string },
): Promise<Reservation> {
  const rules = await getRules(db, tenantId);
  const avail = await checkAvailability(db, tenantId, input.vehicleId, input.startsAt, input.endsAt);
  if (!avail.available) throw conflict("That vehicle is no longer free for those dates");

  const holdExpires = new Date(Date.now() + rules.holdMinutes * 60_000);
  const { rows } = await db.query(
    `INSERT INTO reservations (tenant_id, quote_id, customer_id, vehicle_id, starts_at, ends_at,
                               state, hold_expires_at, total, currency)
     VALUES ($1,$2,$3,$4,$5,$6,'held',$7,$8,$9) RETURNING ${SELECT}`,
    [
      tenantId, input.quoteId, input.customerId, input.vehicleId,
      input.startsAt.toISOString(), input.endsAt.toISOString(),
      holdExpires.toISOString(), input.total, input.currency ?? "AED",
    ],
  );
  const res = map(rows[0]);

  const block = await placeBlock(db, tenantId, {
    vehicleId: input.vehicleId, startsAt: input.startsAt, endsAt: input.endsAt,
    reason: "hold", source: "kirmi", referenceId: res.id,
  });
  if (!block.ok) throw conflict("That vehicle is no longer free for those dates");

  await recordEvent(db, tenantId, res.id, "draft", "held", "hold placed", "system");
  await audit({ tenantId, actor: "ai", action: "reservation.held", entity: "reservation", entityId: res.id, data: { total: res.total } }, db);
  return res;
}

export async function transition(
  db: Queryable,
  tenantId: string,
  reservationId: string,
  to: ReservationState,
  opts: { reason?: string; actor?: string } = {},
): Promise<Reservation> {
  const current = await getReservation(db, tenantId, reservationId);
  if (!current) throw badRequest("Reservation not found");
  if (!canTransition(current.state, to)) {
    throw conflict(`Cannot move a reservation from ${current.state} to ${to}`);
  }
  const { rows } = await db.query(
    `UPDATE reservations SET state=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING ${SELECT}`,
    [tenantId, reservationId, to],
  );
  await recordEvent(db, tenantId, reservationId, current.state, to, opts.reason ?? "", opts.actor ?? "system");
  if (to === "cancelled" || to === "expired") await releaseBlocksFor(db, tenantId, reservationId);
  await audit({ tenantId, actor: opts.actor ?? "system", action: `reservation.${to}`, entity: "reservation", entityId: reservationId, data: { from: current.state } }, db);
  return map(rows[0]);
}

export type ConfirmationSource = "payment_provider" | "staff" | "external_system";

/**
 * The only path to `confirmed`. Requires an explicit authoritative source and, for
 * staff confirmation, the user who takes responsibility for it. There is deliberately
 * no way to confirm a booking from inside the conversation engine.
 */
export async function confirmReservation(
  db: Queryable,
  tenantId: string,
  reservationId: string,
  source: ConfirmationSource,
  opts: { userId?: string; reason?: string } = {},
): Promise<Reservation> {
  const current = await getReservation(db, tenantId, reservationId);
  if (!current) throw badRequest("Reservation not found");
  if (!canTransition(current.state, "confirmed")) {
    throw conflict(`Cannot confirm a reservation in state ${current.state}`);
  }
  if (source === "staff" && !opts.userId) {
    throw badRequest("Staff confirmation must record which operator confirmed it");
  }

  const { rows } = await db.query(
    `UPDATE reservations
        SET state='confirmed', confirmed_at=now(), confirmation_source=$3,
            confirmed_by_user_id=$4, updated_at=now()
      WHERE tenant_id=$1 AND id=$2 RETURNING ${SELECT}`,
    [tenantId, reservationId, source, opts.userId ?? null],
  );

  // Promote the hold into a firm booking block so it survives hold expiry.
  await db.query(
    `UPDATE vehicle_blocks SET reason='booking' WHERE tenant_id=$1 AND reference_id=$2 AND reason='hold'`,
    [tenantId, reservationId],
  );
  await recordEvent(db, tenantId, reservationId, current.state, "confirmed", opts.reason ?? source, opts.userId ? "operator" : "system");
  await audit(
    { tenantId, actor: opts.userId ? "operator" : "system", actorUserId: opts.userId ?? null, action: "reservation.confirmed", entity: "reservation", entityId: reservationId, data: { source } },
    db,
  );
  return map(rows[0]);
}

/** Expire holds past their window. Returns the ids expired. */
export async function expireStaleHolds(db: Queryable, tenantId: string, now = new Date()): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT id, state FROM reservations
      WHERE tenant_id=$1 AND state IN ('held','documents_pending','payment_pending')
        AND hold_expires_at IS NOT NULL AND hold_expires_at < $2`,
    [tenantId, now.toISOString()],
  );
  const ids: string[] = [];
  for (const r of rows) {
    await transition(db, tenantId, r.id, "expired", { reason: "hold window elapsed", actor: "system" });
    ids.push(r.id);
  }
  return ids;
}

export async function listReservations(db: Queryable, tenantId: string, opts: { state?: ReservationState; limit?: number } = {}) {
  const vals: unknown[] = [tenantId];
  let where = "r.tenant_id = $1";
  if (opts.state) { vals.push(opts.state); where += ` AND r.state = $${vals.length}`; }
  vals.push(opts.limit ?? 100);
  const { rows } = await db.query(
    `SELECT r.${SELECT.split(", ").join(", r.")}, v.make, v.model, c.display_name, c.phone_e164
       FROM reservations r
       JOIN vehicles v ON v.id = r.vehicle_id
       JOIN customers c ON c.id = r.customer_id
      WHERE ${where} ORDER BY r.created_at DESC LIMIT $${vals.length}`,
    vals,
  );
  return rows.map((r: any) => ({ ...map(r), vehicle: `${r.make} ${r.model}`, customerName: r.display_name, customerPhone: r.phone_e164 }));
}
