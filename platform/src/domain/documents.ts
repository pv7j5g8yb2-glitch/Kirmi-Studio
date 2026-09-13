import type { Queryable } from "../db/index.js";
import { audit } from "../core/audit.js";
import { badRequest } from "../core/errors.js";
import { getRules } from "./settings.js";
import { getReservation, transition } from "./reservations.js";

export type DocumentKind = "passport" | "driving_licence" | "international_permit" | "visa" | "other";
export type DocumentStatus = "requested" | "received" | "verified" | "rejected";

/**
 * Kirmi collects documents but never decides eligibility: verification is an operator
 * action, recorded against the person who made it. The brief is explicit that final
 * legal/licensing determinations stay with the client.
 */
export async function requestDocuments(db: Queryable, tenantId: string, reservationId: string): Promise<string[]> {
  const reservation = await getReservation(db, tenantId, reservationId);
  if (!reservation) throw badRequest("Reservation not found");
  const rules = await getRules(db, tenantId);
  const ids: string[] = [];
  for (const kind of rules.requiredDocuments) {
    const { rows } = await db.query(
      `INSERT INTO documents (tenant_id, reservation_id, kind, status)
       VALUES ($1,$2,$3,'requested') RETURNING id`,
      [tenantId, reservationId, kind],
    );
    ids.push(rows[0].id);
  }
  if (reservation.state === "held") {
    await transition(db, tenantId, reservationId, "documents_pending", { reason: "documents requested" });
  }
  await audit({ tenantId, actor: "ai", action: "documents.requested", entity: "reservation", entityId: reservationId, data: { kinds: rules.requiredDocuments } }, db);
  return ids;
}

export async function attachDocument(
  db: Queryable, tenantId: string, documentId: string, mediaRef: string,
): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE documents SET status='received', media_ref=$3, updated_at=now()
      WHERE tenant_id=$1 AND id=$2 AND status IN ('requested','rejected')`,
    [tenantId, documentId, mediaRef],
  );
  if (!rowCount) throw badRequest("Document not found or already handled");
  await audit({ tenantId, actor: "customer", action: "document.received", entity: "document", entityId: documentId }, db);
}

export async function reviewDocument(
  db: Queryable, tenantId: string, documentId: string, userId: string,
  decision: "verified" | "rejected", note?: string,
): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE documents SET status=$4, reviewed_by_user_id=$3, note=$5, updated_at=now()
      WHERE tenant_id=$1 AND id=$2`,
    [tenantId, documentId, userId, decision, note ?? null],
  );
  if (!rowCount) throw badRequest("Document not found");
  await audit({ tenantId, actor: "operator", actorUserId: userId, action: `document.${decision}`, entity: "document", entityId: documentId, data: { note } }, db);
}

export async function documentsFor(db: Queryable, tenantId: string, reservationId: string) {
  const { rows } = await db.query(
    `SELECT id, kind, status, media_ref, note, updated_at FROM documents
      WHERE tenant_id=$1 AND reservation_id=$2 ORDER BY created_at`,
    [tenantId, reservationId],
  );
  return rows.map((r: any) => ({
    id: r.id, kind: r.kind, status: r.status, mediaRef: r.media_ref,
    note: r.note, updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

export async function allDocumentsVerified(db: Queryable, tenantId: string, reservationId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT count(*) FILTER (WHERE status <> 'verified')::int AS outstanding
       FROM documents WHERE tenant_id=$1 AND reservation_id=$2`,
    [tenantId, reservationId],
  );
  return (rows[0]?.outstanding ?? 0) === 0;
}
