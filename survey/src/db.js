import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DATABASE_FILE || "./data/survey.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS responses (
    id TEXT PRIMARY KEY,
    segment_slug TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'in_progress',
    current_question_number INTEGER NOT NULL,
    current_question_text TEXT NOT NULL
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
