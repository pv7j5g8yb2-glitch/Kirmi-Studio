import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { run, get, all } from "./db.js";
import { getSegment, listSegments, QUESTION_CAP, BASELINE_COUNT } from "./segments.js";
import { decideNextQuestion } from "./followup.js";
import { checkPassword, requireAdmin, setAdminCookie, clearAdminCookie } from "./admin-auth.js";
import { toCsv } from "./csv.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");

const COOKIE_SECRET = process.env.COOKIE_SECRET;
if (!COOKIE_SECRET) throw new Error("COOKIE_SECRET is not set");
if (!process.env.ADMIN_PASSWORD) throw new Error("ADMIN_PASSWORD is not set");

const formHtml = readFileSync(join(WEB_DIR, "form.html"), "utf8");
const adminHtml = readFileSync(join(WEB_DIR, "admin.html"), "utf8");
const adminLoginHtml = readFileSync(join(WEB_DIR, "admin-login.html"), "utf8");

const app = Fastify({ logger: true });
await app.register(cookie, { secret: COOKIE_SECRET });

function nowIso() {
  return new Date().toISOString();
}

async function loadTranscript(responseId) {
  return all(
    `SELECT question_number as number, question_kind as kind, question_text as text, answer_text as answer
     FROM answers WHERE response_id = ? ORDER BY question_number ASC`,
    [responseId]
  );
}

app.get("/healthz", async () => ({ ok: true }));

app.get("/", async (request, reply) => {
  const links = listSegments()
    .map((s) => `<li><a href="/s/${s.slug}">/s/${s.slug}</a> — ${s.niche}</li>`)
    .join("");
  reply.type("text/html").send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kirmi Survey</title>
<style>body{font-family:-apple-system,sans-serif;max-width:480px;margin:60px auto;padding:0 20px;color:#1a1a1a}
a{color:#1a1a1a}li{margin:8px 0}</style></head>
<body><h1>Kirmi Survey</h1><p>This isn't a page for visitors, it's the survey tool itself. Live surveys:</p>
<ul>${links}</ul><p><a href="/admin/login">Admin login</a></p></body></html>`);
});

// ---- respondent-facing survey ----

app.get("/s/:slug", async (request, reply) => {
  const segment = getSegment(request.params.slug);
  if (!segment) return reply.code(404).send("Not found");
  reply.type("text/html").send(formHtml);
});

app.get("/api/s/:slug", async (request, reply) => {
  const segment = getSegment(request.params.slug);
  if (!segment) return reply.code(404).send({ error: "unknown survey" });
  return { niche: segment.niche, intro: segment.intro, cap: QUESTION_CAP };
});

app.post("/api/s/:slug/start", async (request, reply) => {
  const segment = getSegment(request.params.slug);
  if (!segment) return reply.code(404).send({ error: "unknown survey" });

  const id = randomUUID();
  const firstQuestion = { number: 1, text: segment.baseline[0] };
  const ref = typeof request.body?.ref === "string" ? request.body.ref.slice(0, 200) : null;
  const name = typeof request.body?.name === "string" && request.body.name.trim() ? request.body.name.trim().slice(0, 60) : null;

  await run(
    `INSERT INTO responses (id, segment_slug, started_at, status, current_question_number, current_question_text, source_ref, respondent_name)
     VALUES (?, ?, ?, 'in_progress', ?, ?, ?, ?)`,
    [id, request.params.slug, nowIso(), firstQuestion.number, firstQuestion.text, ref, name]
  );

  return { responseId: id, question: firstQuestion, cap: QUESTION_CAP };
});

app.post("/api/s/:slug/answer", async (request, reply) => {
  const segment = getSegment(request.params.slug);
  if (!segment) return reply.code(404).send({ error: "unknown survey" });

  const { responseId, questionNumber, questionText, answer } = request.body ?? {};
  if (!responseId || !Number.isInteger(questionNumber) || !questionText || typeof answer !== "string" || !answer.trim()) {
    return reply.code(400).send({ error: "responseId, questionNumber, questionText and a non-empty answer are required" });
  }

  const response = await get(`SELECT * FROM responses WHERE id = ? AND segment_slug = ?`, [responseId, request.params.slug]);
  if (!response) return reply.code(404).send({ error: "unknown response" });
  if (response.status !== "in_progress") return reply.code(409).send({ error: "response already finished" });

  // Editing an answer to a question already behind the current one: update it in place
  // and send them back to wherever they actually are. This never touches anything asked
  // after it, so an already-generated adaptive question is left exactly as it was, the
  // worst case is a later question reads slightly stale, never a broken or duplicated one.
  if (questionNumber < response.current_question_number) {
    const existing = await get(`SELECT id FROM answers WHERE response_id = ? AND question_number = ?`, [responseId, questionNumber]);
    if (!existing) return reply.code(404).send({ error: "no earlier answer at that question number" });
    await run(`UPDATE answers SET answer_text = ?, answered_at = ? WHERE id = ?`, [answer.trim(), nowIso(), existing.id]);
    return { done: false, question: { number: response.current_question_number, text: response.current_question_text } };
  }

  if (response.current_question_number !== questionNumber) {
    return reply.code(409).send({ error: "question number does not match what this response is currently on" });
  }

  const kind = questionNumber <= BASELINE_COUNT ? "baseline" : "followup";
  await run(
    `INSERT INTO answers (id, response_id, question_number, question_kind, question_text, answer_text, answered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), responseId, questionNumber, kind, questionText, answer.trim(), nowIso()]
  );

  if (questionNumber < BASELINE_COUNT) {
    const nextNumber = questionNumber + 1;
    const nextQuestion = { number: nextNumber, text: segment.baseline[nextNumber - 1] };
    await run(`UPDATE responses SET current_question_number = ?, current_question_text = ? WHERE id = ?`, [
      nextQuestion.number,
      nextQuestion.text,
      responseId,
    ]);
    return { done: false, question: nextQuestion };
  }

  const remaining = QUESTION_CAP - questionNumber;
  const transcript = await loadTranscript(responseId);
  const decision = await decideNextQuestion({ segment, transcript, remaining });

  if (decision.continue && decision.question && questionNumber < QUESTION_CAP) {
    const nextQuestion = { number: questionNumber + 1, text: decision.question };
    await run(`UPDATE responses SET current_question_number = ?, current_question_text = ? WHERE id = ?`, [
      nextQuestion.number,
      nextQuestion.text,
      responseId,
    ]);
    return { done: false, question: nextQuestion };
  }

  await run(`UPDATE responses SET status = 'completed', finished_at = ? WHERE id = ?`, [nowIso(), responseId]);
  return { done: true };
});

app.post("/api/s/:slug/contact", async (request, reply) => {
  const { responseId, phone, email } = request.body ?? {};
  if (!responseId) return reply.code(400).send({ error: "responseId is required" });

  const response = await get(`SELECT * FROM responses WHERE id = ? AND segment_slug = ?`, [responseId, request.params.slug]);
  if (!response) return reply.code(404).send({ error: "unknown response" });
  if (response.status !== "completed") return reply.code(409).send({ error: "only offered after the survey is finished" });

  await run(`UPDATE responses SET contact_phone = ?, contact_email = ? WHERE id = ?`, [
    typeof phone === "string" && phone.trim() ? phone.trim().slice(0, 100) : null,
    typeof email === "string" && email.trim() ? email.trim().slice(0, 200) : null,
    responseId,
  ]);
  return { ok: true };
});

// ---- admin ----

app.get("/admin/login", async (request, reply) => {
  reply.type("text/html").send(adminLoginHtml);
});

app.post("/admin/login", async (request, reply) => {
  const { password } = request.body ?? {};
  if (!checkPassword(password)) return reply.code(401).send({ error: "wrong password" });
  setAdminCookie(reply);
  return { ok: true };
});

app.post("/admin/logout", async (request, reply) => {
  clearAdminCookie(reply);
  return { ok: true };
});

app.get("/admin", { preHandler: requireAdmin }, async (request, reply) => {
  reply.type("text/html").send(adminHtml);
});

app.get("/api/admin/segments", { preHandler: requireAdmin }, async () => {
  return { segments: listSegments() };
});

app.get("/api/admin/responses", { preHandler: requireAdmin }, async () => {
  const responses = await all(
    `SELECT r.id, r.segment_slug, r.started_at, r.finished_at, r.status,
            r.current_question_number, r.current_question_text,
            r.source_ref, r.respondent_name, r.contact_phone, r.contact_email,
            (SELECT COUNT(*) FROM answers a WHERE a.response_id = r.id) as answer_count
     FROM responses r ORDER BY r.started_at DESC`
  );
  return { responses };
});

app.get("/api/admin/responses/:id", { preHandler: requireAdmin }, async (request, reply) => {
  const response = await get(`SELECT * FROM responses WHERE id = ?`, [request.params.id]);
  if (!response) return reply.code(404).send({ error: "unknown response" });
  const answers = await loadTranscript(request.params.id);
  return { response, answers };
});

app.get("/api/admin/export.csv", { preHandler: requireAdmin }, async (request, reply) => {
  const rows = await all(
    `SELECT r.id as response_id, r.segment_slug, r.started_at, r.finished_at, r.status,
            r.source_ref, r.respondent_name, r.contact_phone, r.contact_email,
            a.question_number, a.question_kind, a.question_text, a.answer_text
     FROM responses r
     LEFT JOIN answers a ON a.response_id = r.id
     ORDER BY r.started_at ASC, a.question_number ASC`
  );

  const csv = toCsv(
    [
      "response_id", "segment_slug", "started_at", "finished_at", "status", "source_ref", "respondent_name",
      "contact_phone", "contact_email", "question_number", "question_kind", "question_text", "answer_text",
    ],
    rows
  );
  reply.header("Content-Type", "text/csv").header("Content-Disposition", "attachment; filename=survey-export.csv").send(csv);
});

const port = Number(process.env.PORT || 3100);
app.listen({ port, host: "0.0.0.0" }).then(() => {
  app.log.info(`survey tool listening on :${port}`);
});
