import { createClient } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const url = process.env.DATABASE_URL || "file:./data/survey.db";
if (url.startsWith("file:")) mkdirSync(dirname(url.slice("file:".length)), { recursive: true });

export const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN });

await client.executeMultiple(`
  CREATE TABLE IF NOT EXISTS responses (
    id TEXT PRIMARY KEY,
    segment_slug TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'in_progress',
    current_question_number INTEGER NOT NULL,
    current_question_text TEXT NOT NULL,
    source_ref TEXT,
    respondent_name TEXT,
    contact_phone TEXT,
    contact_email TEXT
  );

  CREATE TABLE IF NOT EXISTS answers (
    id TEXT PRIMARY KEY,
    response_id TEXT NOT NULL REFERENCES responses(id),
    question_number INTEGER NOT NULL,
    question_kind TEXT NOT NULL,
    question_text TEXT NOT NULL,
    answer_text TEXT NOT NULL,
    answered_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS answers_response_idx ON answers(response_id);
`);

export async function run(sql, args = []) {
  return client.execute({ sql, args });
}

export async function get(sql, args = []) {
  const res = await client.execute({ sql, args });
  return res.rows[0] ?? null;
}

export async function all(sql, args = []) {
  const res = await client.execute({ sql, args });
  return res.rows;
}
