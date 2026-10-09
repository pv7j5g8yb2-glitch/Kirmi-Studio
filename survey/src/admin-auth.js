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

// 400 days is the longest a cookie is actually honoured; Chrome and Safari both cap
// Set-Cookie max-age there regardless of what a server asks for, so this is as close
// to "stay signed in" as a cookie can get. You will need to log back in about once a year.
const MAX_COOKIE_AGE_SECONDS = 400 * 24 * 60 * 60;

export function setAdminCookie(reply) {
  reply.setCookie(COOKIE_NAME, "ok", {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    signed: true,
    maxAge: MAX_COOKIE_AGE_SECONDS,
  });
}

export function clearAdminCookie(reply) {
  reply.clearCookie(COOKIE_NAME, { path: "/" });
}
