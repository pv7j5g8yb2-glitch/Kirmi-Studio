import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { run, get, all } from "./db.js";
import { getSegment, listSegments, QUESTION_CAP, BASELINE_COUNT, ROLE_LABELS } from "./segments.js";
import { decideNextQuestion } from "./followup.js";
import { translateFromEnglish, translateToEnglish } from "./translate.js";
import { getBundle } from "./i18n.js";
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
    `SELECT question_number as number, question_kind as kind, question_text as text,
            question_text_localized as localizedText, answer_text as answer, answer_text_original as answerOriginal
     FROM answers WHERE response_id = ? ORDER BY question_number ASC`,
    [responseId]
  );
}

// Baseline questions are translated once and cached as part of the static bundle (see
// i18n.js); an adaptive follow-up is unique to this response, so it is translated on the
// spot, right after the English master is decided by the completely untouched logic in
// followup.js. Returns the same text back when the language is English or unset.
async function localizeQuestion(segment, slug, language, questionNumber, englishText) {
  if (!language || language === "English") return englishText;
  if (questionNumber <= BASELINE_COUNT) {
    const bundle = await getBundle(language);
    return bundle.segments[slug]?.baseline?.[questionNumber - 1] || englishText;
  }
  return translateFromEnglish(englishText, language);
}

app.get("/healthz", async () => ({ ok: true }));

app.get("/", async (request, reply) => {
  const links = listSegments()
    .map((s) => {
      const label = ROLE_LABELS[s.slug] || s.niche.charAt(0).toUpperCase() + s.niche.slice(1);
      return `<li><a href="/s/${s.slug}"><span>${label}</span><span class="arrow">&rsaquo;</span></a></li>`;
    })
    .join("");
  reply.type("text/html").send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Market Research</title>
<meta name="description" content="A short, anonymous survey from Kirmi Studio for bookkeepers and real estate professionals. Nothing to sign up for, nothing for sale, just research.">
<style>
  :root {
    color-scheme: light;
    --ink: #1a1a1a;
    --ink-soft: #52535a;
    --glass-bg: rgba(255, 255, 255, 0.72);
    --glass-border: rgba(255, 255, 255, 0.55);
    --glass-edge: rgba(255, 255, 255, 0.95);
    --radius-lg: 24px;
    --radius-md: 14px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 400 16px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
    font-optical-sizing: auto;
    color: var(--ink);
    display: flex;
    justify-content: center;
    padding: 60px 16px;
    min-height: 100vh;
    background:
      radial-gradient(1000px 600px at 8% -10%, rgba(255, 214, 196, 0.22), transparent 55%),
      radial-gradient(900px 700px at 108% 10%, rgba(196, 214, 255, 0.2), transparent 55%),
      radial-gradient(800px 600px at 50% 115%, rgba(205, 240, 222, 0.16), transparent 55%),
      #f5f4f1;
    background-attachment: fixed;
  }
  .card {
    width: 100%;
    max-width: 420px;
    height: fit-content;
    background: var(--glass-bg);
    backdrop-filter: blur(26px) saturate(180%);
    -webkit-backdrop-filter: blur(26px) saturate(180%);
    border-radius: var(--radius-lg);
    padding: 28px 24px;
    border: 1px solid var(--glass-border);
    border-top-color: var(--glass-edge);
    box-shadow: 0 20px 60px -24px rgba(20,20,30,0.28), 0 2px 10px rgba(20,20,30,0.06);
    animation: materialize 380ms cubic-bezier(0.2, 0.9, 0.3, 1) both;
  }
  h1 { font-size: 19px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 10px; }
  p.intro { color: var(--ink-soft); font-size: 14px; line-height: 1.55; margin: 0 0 18px; }
  ul.links { list-style: none; margin: 0; padding: 0; }
  ul.links li + li { margin-top: 8px; }
  ul.links a {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 12px 14px;
    border-radius: var(--radius-md);
    background: rgba(255, 255, 255, 0.78);
    border: 1px solid rgba(0, 0, 0, 0.08);
    color: var(--ink);
    text-decoration: none;
    font-size: 14px;
    font-weight: 500;
    transition: transform 140ms cubic-bezier(.2,.8,.3,1), background 140ms ease;
  }
  ul.links a:active { transform: scale(0.97); background: rgba(255, 255, 255, 0.95); }
  ul.links .arrow { color: var(--ink-soft); }
  .admin-link {
    display: block;
    margin-top: 18px;
    text-align: center;
    font-size: 13px;
    color: var(--ink-soft);
    text-decoration: none;
    padding: 8px;
  }
  .admin-link:active { color: var(--ink); }

  @keyframes materialize {
    from { opacity: 0; transform: translateY(6px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .card { animation: reduced-fade 160ms ease both; }
    @keyframes reduced-fade { from { opacity: 0; } to { opacity: 1; } }
    ul.links a { transition: opacity 120ms ease; }
    ul.links a:active { transform: none; }
  }
  @media (prefers-reduced-transparency: reduce) {
    body { background: #f5f4f1; }
    .card { background: #fff; backdrop-filter: none; -webkit-backdrop-filter: none; border-color: rgba(0,0,0,0.1); }
    ul.links a { background: #fff; }
  }
  @media (prefers-contrast: more) {
    .card { background: #fff; border: 1px solid #000; box-shadow: none; }
    ul.links a { background: #fff; border: 1px solid #000; }
  }
</style></head>
<body>
  <div class="card">
    <h1>Kirmi Studio</h1>
    <p class="intro">Quick industry survey. Are you a:</p>
    <ul class="links">${links}</ul>
    <a class="admin-link" href="/admin/login">Admin login</a>
  </div>
<script>document.body.addEventListener("touchstart", function () {}, { passive: true });</script>
</body></html>`);
});

// ---- respondent-facing survey ----

app.get("/s/:slug", async (request, reply) => {
  const segment = getSegment(request.params.slug);
  if (!segment) return reply.code(404).send("Not found");
  reply.type("text/html").send(formHtml);
});

// Serves the whole static bundle (fixed interface text plus every niche's title, intro,
// and baseline questions) for one language, generated once and cached from here on (see
// i18n.js). The client fetches this for every language, English included, so there is a
// single code path: for English it is just SOURCE_BUNDLE, returned instantly.
app.get("/api/i18n/:language", async (request, reply) => {
  const bundle = await getBundle(request.params.language);
  return { ui: bundle.ui, segments: bundle.segments, cap: QUESTION_CAP };
});

// Lets the form resume a response already in progress or completed, so a page refresh
// (or reopening the link) picks up exactly where the respondent left off instead of
// starting over. The responseId itself is the only credential, same trust model already
// used by /answer and /contact.
app.get("/api/s/:slug/response/:responseId", async (request, reply) => {
  const segment = getSegment(request.params.slug);
  if (!segment) return reply.code(404).send({ error: "unknown survey" });

  const response = await get(`SELECT * FROM responses WHERE id = ? AND segment_slug = ?`, [request.params.responseId, request.params.slug]);
  if (!response) return reply.code(404).send({ error: "unknown response" });

  const transcript = await loadTranscript(response.id);
  return {
    status: response.status,
    respondentName: response.respondent_name,
    respondentLanguage: response.respondent_language,
    cap: QUESTION_CAP,
    currentQuestion:
      response.status === "in_progress"
        ? {
            number: response.current_question_number,
            text: response.current_question_text,
            localizedText: response.current_question_text_localized || response.current_question_text,
          }
        : null,
    transcript: transcript.map((t) => ({
      number: t.number,
      text: t.text,
      localizedText: t.localizedText || t.text,
      answer: t.answerOriginal || t.answer,
    })),
  };
});

app.post("/api/s/:slug/start", async (request, reply) => {
  const segment = getSegment(request.params.slug);
  if (!segment) return reply.code(404).send({ error: "unknown survey" });

  const id = randomUUID();
  const ref = typeof request.body?.ref === "string" ? request.body.ref.slice(0, 200) : null;
  const name = typeof request.body?.name === "string" && request.body.name.trim() ? request.body.name.trim().slice(0, 60) : null;
  const language =
    typeof request.body?.language === "string" && request.body.language.trim() ? request.body.language.trim().slice(0, 40) : null;

  const firstQuestion = { number: 1, text: segment.baseline[0] };
  const localizedText = await localizeQuestion(segment, request.params.slug, language, firstQuestion.number, firstQuestion.text);

  await run(
    `INSERT INTO responses (id, segment_slug, started_at, status, current_question_number, current_question_text, current_question_text_localized, source_ref, respondent_name, respondent_language)
     VALUES (?, ?, ?, 'in_progress', ?, ?, ?, ?, ?, ?)`,
    [id, request.params.slug, nowIso(), firstQuestion.number, firstQuestion.text, localizedText, ref, name, language]
  );

  return { responseId: id, question: { ...firstQuestion, localizedText }, cap: QUESTION_CAP };
});

app.post("/api/s/:slug/answer", async (request, reply) => {
  const segment = getSegment(request.params.slug);
  if (!segment) return reply.code(404).send({ error: "unknown survey" });

  const { responseId, questionNumber, answer } = request.body ?? {};
  if (!responseId || !Number.isInteger(questionNumber) || typeof answer !== "string" || !answer.trim()) {
    return reply.code(400).send({ error: "responseId, questionNumber and a non-empty answer are required" });
  }

  const response = await get(`SELECT * FROM responses WHERE id = ? AND segment_slug = ?`, [responseId, request.params.slug]);
  if (!response) return reply.code(404).send({ error: "unknown response" });
  if (response.status !== "in_progress") return reply.code(409).send({ error: "response already finished" });

  // Editing an answer to a question already behind the current one: update it in place
  // and send them back to wherever they actually are. Already-answered questions after it
  // are left untouched, that is an honest record of what was asked and answered at the
  // time, only visible again if they explicitly review it. But the question they are
  // about to answer next might have been generated from the content they just changed,
  // if so it gets regenerated from the corrected transcript before they see it again,
  // so it never visibly references something they clearly just went back and edited.
  const language = response.respondent_language;
  // The decision engine in followup.js, including its price and product-pitch guardrails,
  // only ever reasons over English, exactly as proven before translation existed. A
  // non-English answer is translated to English here before it touches any of that, and
  // the respondent's own original wording is kept alongside it, untouched, only to be
  // shown back to them.
  const answerOriginal = answer.trim();
  const answerEnglish = await translateToEnglish(answerOriginal, language);

  if (questionNumber < response.current_question_number) {
    const existing = await get(`SELECT id FROM answers WHERE response_id = ? AND question_number = ?`, [responseId, questionNumber]);
    if (!existing) return reply.code(404).send({ error: "no earlier answer at that question number" });
    await run(`UPDATE answers SET answer_text = ?, answer_text_original = ?, answered_at = ? WHERE id = ?`, [
      answerEnglish,
      answerOriginal,
      nowIso(),
      existing.id,
    ]);

    const pendingNumber = response.current_question_number;
    if (pendingNumber <= BASELINE_COUNT) {
      // Baseline questions are fixed text for everyone, nothing to regenerate.
      return {
        done: false,
        question: { number: pendingNumber, text: response.current_question_text, localizedText: response.current_question_text_localized },
      };
    }

    const remaining = QUESTION_CAP - (pendingNumber - 1);
    const transcript = await loadTranscript(responseId);
    const decision = await decideNextQuestion({ segment, transcript, remaining });

    if (decision.continue && decision.question) {
      const localizedText = await localizeQuestion(segment, request.params.slug, language, pendingNumber, decision.question);
      await run(`UPDATE responses SET current_question_text = ?, current_question_text_localized = ? WHERE id = ?`, [
        decision.question,
        localizedText,
        responseId,
      ]);
      return { done: false, question: { number: pendingNumber, text: decision.question, localizedText } };
    }

    await run(`UPDATE responses SET status = 'completed', finished_at = ? WHERE id = ?`, [nowIso(), responseId]);
    return { done: true };
  }

  if (response.current_question_number !== questionNumber) {
    return reply.code(409).send({ error: "question number does not match what this response is currently on" });
  }

  // The question text is never trusted from the client: a baseline question's text is
  // fixed for the niche, and a follow-up's text is whatever was actually generated and
  // shown to this respondent, already stored on the response row for that reason.
  const kind = questionNumber <= BASELINE_COUNT ? "baseline" : "followup";
  const questionText = kind === "baseline" ? segment.baseline[questionNumber - 1] : response.current_question_text;
  const questionTextLocalized = response.current_question_text_localized;
  await run(
    `INSERT INTO answers (id, response_id, question_number, question_kind, question_text, question_text_localized, answer_text, answer_text_original, answered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), responseId, questionNumber, kind, questionText, questionTextLocalized, answerEnglish, answerOriginal, nowIso()]
  );

  if (questionNumber < BASELINE_COUNT) {
    const nextNumber = questionNumber + 1;
    const nextText = segment.baseline[nextNumber - 1];
    const localizedText = await localizeQuestion(segment, request.params.slug, language, nextNumber, nextText);
    const nextQuestion = { number: nextNumber, text: nextText, localizedText };
    await run(`UPDATE responses SET current_question_number = ?, current_question_text = ?, current_question_text_localized = ? WHERE id = ?`, [
      nextQuestion.number,
      nextQuestion.text,
      localizedText,
      responseId,
    ]);
    return { done: false, question: nextQuestion };
  }

  const remaining = QUESTION_CAP - questionNumber;
  const transcript = await loadTranscript(responseId);
  const decision = await decideNextQuestion({ segment, transcript, remaining });

  if (decision.continue && decision.question && questionNumber < QUESTION_CAP) {
    const nextNumber = questionNumber + 1;
    const localizedText = await localizeQuestion(segment, request.params.slug, language, nextNumber, decision.question);
    const nextQuestion = { number: nextNumber, text: decision.question, localizedText };
    await run(`UPDATE responses SET current_question_number = ?, current_question_text = ?, current_question_text_localized = ? WHERE id = ?`, [
      nextQuestion.number,
      nextQuestion.text,
      localizedText,
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
            r.source_ref, r.respondent_name, r.respondent_language, r.contact_phone, r.contact_email,
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

app.delete("/api/admin/responses/:id", { preHandler: requireAdmin }, async (request, reply) => {
  const response = await get(`SELECT id FROM responses WHERE id = ?`, [request.params.id]);
  if (!response) return reply.code(404).send({ error: "unknown response" });
  await run(`DELETE FROM answers WHERE response_id = ?`, [request.params.id]);
  await run(`DELETE FROM responses WHERE id = ?`, [request.params.id]);
  return { ok: true };
});

app.get("/api/admin/export.csv", { preHandler: requireAdmin }, async (request, reply) => {
  const rows = await all(
    `SELECT r.id as response_id, r.segment_slug, r.started_at, r.finished_at, r.status,
            r.source_ref, r.respondent_name, r.respondent_language, r.contact_phone, r.contact_email,
            a.question_number, a.question_kind, a.question_text, a.answer_text
     FROM responses r
     LEFT JOIN answers a ON a.response_id = r.id
     ORDER BY r.started_at ASC, a.question_number ASC`
  );

  const csv = toCsv(
    [
      "response_id", "segment_slug", "started_at", "finished_at", "status", "source_ref", "respondent_name",
      "respondent_language", "contact_phone", "contact_email", "question_number", "question_kind", "question_text", "answer_text",
    ],
    rows
  );
  reply.header("Content-Type", "text/csv").header("Content-Disposition", "attachment; filename=survey-export.csv").send(csv);
});

const port = Number(process.env.PORT || 3100);
app.listen({ port, host: "0.0.0.0" }).then(() => {
  app.log.info(`survey tool listening on :${port}`);
});
