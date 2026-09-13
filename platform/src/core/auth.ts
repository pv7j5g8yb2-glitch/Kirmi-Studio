import { randomBytes, scrypt as _scrypt, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import { query } from "../db/index.js";
import { forbidden, unauthorized } from "./errors.js";

const scrypt = promisify(_scrypt) as (p: string | Buffer, s: string | Buffer, k: number) => Promise<Buffer>;

const SCRYPT_KEYLEN = 64;
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

export type Role = "kirmi_admin" | "client_admin" | "client_operator";

export type Principal = {
  userId: string;
  email: string;
  name: string;
  role: Role;
  /** Tenants this principal may act on. Empty for kirmi_admin, who may act on all. */
  tenantIds: string[];
};

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hex] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hex) return false;
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hex, "hex");
  // Length check first: timingSafeEqual throws on a mismatch rather than returning false.
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(derived, expected);
}

/** Sessions are stored as a SHA-256 of the bearer token; the raw token exists only in the cookie. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1,$2,$3)`, [
    userId,
    hashToken(token),
    expiresAt,
  ]);
  return { token, expiresAt };
}

export async function destroySession(token: string): Promise<void> {
  await query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
}

export async function principalFromToken(token: string | undefined): Promise<Principal | null> {
  if (!token) return null;
  const { rows } = await query(
    `SELECT u.id, u.email, u.name, u.role, u.status,
            COALESCE(array_agg(m.tenant_id) FILTER (WHERE m.tenant_id IS NOT NULL), '{}') AS tenant_ids
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN memberships m ON m.user_id = u.id
      WHERE s.token_hash = $1 AND s.expires_at > now()
      GROUP BY u.id`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row || row.status !== "active") return null;
  return { userId: row.id, email: row.email, name: row.name, role: row.role, tenantIds: row.tenant_ids ?? [] };
}

export function requirePrincipal(p: Principal | null): Principal {
  if (!p) throw unauthorized();
  return p;
}

/** Throws unless the principal may act on this tenant. kirmi_admin may act on any. */
export function assertTenantAccess(p: Principal, tenantId: string): void {
  if (p.role === "kirmi_admin") return;
  if (!p.tenantIds.includes(tenantId)) throw forbidden("No access to this tenant");
}

export function assertRole(p: Principal, ...roles: Role[]): void {
  if (!roles.includes(p.role)) throw forbidden("Insufficient role");
}

export async function createUser(input: {
  email: string;
  name: string;
  password: string;
  role: Role;
  tenantIds?: string[];
}): Promise<string> {
  const hash = await hashPassword(input.password);
  const { rows } = await query(
    `INSERT INTO users (email, name, password_hash, role) VALUES ($1,$2,$3,$4)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [input.email.toLowerCase(), input.name, hash, input.role],
  );
  const userId = rows[0].id as string;
  for (const t of input.tenantIds ?? []) {
    await query(`INSERT INTO memberships (user_id, tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [userId, t]);
  }
  return userId;
}

export async function authenticate(email: string, password: string): Promise<Principal> {
  const { rows } = await query(`SELECT id, password_hash, status FROM users WHERE email = $1`, [email.toLowerCase()]);
  const row = rows[0];
  // Hash even on a miss so a missing account and a wrong password take the same time.
  const stored = row?.password_hash ?? "scrypt$00$00";
  const ok = await verifyPassword(password, stored);
  if (!row || !ok || row.status !== "active") throw unauthorized("Invalid email or password");
  const p = await principalFromUserId(row.id);
  if (!p) throw unauthorized("Invalid email or password");
  return p;
}

export async function principalFromUserId(userId: string): Promise<Principal | null> {
  const { rows } = await query(
    `SELECT u.id, u.email, u.name, u.role,
            COALESCE(array_agg(m.tenant_id) FILTER (WHERE m.tenant_id IS NOT NULL), '{}') AS tenant_ids
       FROM users u LEFT JOIN memberships m ON m.user_id = u.id
      WHERE u.id = $1 GROUP BY u.id`,
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  return { userId: row.id, email: row.email, name: row.name, role: row.role, tenantIds: row.tenant_ids ?? [] };
}
