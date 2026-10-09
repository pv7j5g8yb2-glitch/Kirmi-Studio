import { timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "kirmi_survey_admin";

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function checkPassword(password) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) throw new Error("ADMIN_PASSWORD is not set");
  return typeof password === "string" && safeEqual(password, expected);
}

export function requireAdmin(request, reply, done) {
  const token = request.cookies[COOKIE_NAME];
  const unsigned = token ? request.unsignCookie(token) : null;
  if (!unsigned || !unsigned.valid || unsigned.value !== "ok") {
    reply.code(401).send({ error: "not authenticated" });
    return;
  }
  done();
}

export function setAdminCookie(reply) {
  reply.setCookie(COOKIE_NAME, "ok", {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    signed: true,
    maxAge: 60 * 60 * 12,
  });
}

export function clearAdminCookie(reply) {
  reply.clearCookie(COOKIE_NAME, { path: "/" });
}
