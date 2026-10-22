import { mkdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

type Row = Record<string, unknown>;

interface Handle {
  query(text: string, params?: unknown[]): Promise<Row[]>;
}

const globalDb = globalThis as { baoDb?: Handle; baoReady?: Promise<void> };

export async function ready(): Promise<void> {
  if (!globalDb.baoReady) globalDb.baoReady = init();
  await globalDb.baoReady;
}

export async function query<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  await ready();
  const rows = await db().query(text, params);
  return rows as T[];
}

function db(): Handle {
  if (!globalDb.baoDb) throw new Error("database is not ready");
  return globalDb.baoDb;
}

async function init(): Promise<void> {
  globalDb.baoDb = await openHandle();
  for (const statement of SCHEMA) {
    await globalDb.baoDb.query(statement);
  }
}

async function openHandle(): Promise<Handle> {
  const url = process.env.DATABASE_URL;
  if (url && !localPostgres(url)) {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(url);
    return {
      async query(text, params = []) {
        const rows = await sql.query(text, params);
        return rows as Row[];
      },
    };
  }
  if (url) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    return {
      async query(text, params = []) {
        const result = await pool.query(text, params);
        return result.rows as Row[];
      },
    };
  }
  const dir = process.env.BAO_PG_DIR || path.join(process.cwd(), ".data", "pglite");
  mkdirSync(dir, { recursive: true });
  const pgLite = new PGlite(dir);
  return {
    async query(text, params = []) {
      const result = await pgLite.query<Row>(text, params);
      return result.rows;
    },
  };
}

function localPostgres(url: string): boolean {
  if (process.env.BAO_PG_DRIVER === "pg") return true;
  return /\/\/(?:[^@/]+@)?(localhost|127\.0\.0\.1)(?::|\/|$)/.test(url);
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id text PRIMARY KEY,
    email text UNIQUE NOT NULL,
    name text NOT NULL,
    verified boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS magic_links (
    token text PRIMARY KEY,
    email text NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz
  )`,
  `CREATE TABLE IF NOT EXISTS devices (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id),
    name text NOT NULL,
    token_hash text UNIQUE NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz
  )`,
  `ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_seen_at timestamptz`,
  `CREATE TABLE IF NOT EXISTS pair_codes (
    code text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id),
    expires_at timestamptz NOT NULL,
    used_at timestamptz
  )`,
  `CREATE TABLE IF NOT EXISTS workflows (
    id text PRIMARY KEY,
    owner_id text NOT NULL REFERENCES users(id),
    name text NOT NULL,
    summary text NOT NULL DEFAULT '',
    site text NOT NULL DEFAULT '',
    category text NOT NULL DEFAULT 'General',
    author_name text NOT NULL DEFAULT '',
    visibility text NOT NULL DEFAULT 'private',
    head_version int NOT NULL DEFAULT 0,
    published_version int,
    reviewed_hash text,
    last_green_at timestamptz,
    forked_from text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS workflow_versions (
    workflow_id text NOT NULL REFERENCES workflows(id),
    version int NOT NULL,
    document jsonb NOT NULL,
    heal jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    device_id text,
    PRIMARY KEY (workflow_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS workflow_shots (
    workflow_id text NOT NULL,
    version int NOT NULL,
    step_id text NOT NULL,
    blob_key text NOT NULL,
    PRIMARY KEY (workflow_id, version, step_id)
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
    id text PRIMARY KEY,
    workflow_id text NOT NULL REFERENCES workflows(id),
    device_id text,
    status text NOT NULL,
    at timestamptz NOT NULL,
    steps jsonb NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS run_shots (
    run_id text NOT NULL REFERENCES runs(id),
    step_id text NOT NULL,
    blob_key text NOT NULL,
    PRIMARY KEY (run_id, step_id)
  )`,
  `CREATE TABLE IF NOT EXISTS shares (
    token text PRIMARY KEY,
    workflow_id text NOT NULL REFERENCES workflows(id),
    permission text NOT NULL,
    document jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS grants (
    workflow_id text NOT NULL REFERENCES workflows(id),
    user_id text NOT NULL REFERENCES users(id),
    permission text NOT NULL,
    PRIMARY KEY (workflow_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS reports (
    id text PRIMARY KEY,
    workflow_id text NOT NULL REFERENCES workflows(id),
    reporter_id text NOT NULL REFERENCES users(id),
    reason text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS reviews (
    workflow_id text NOT NULL REFERENCES workflows(id),
    document_hash text NOT NULL,
    at timestamptz NOT NULL DEFAULT now(),
    samples jsonb,
    PRIMARY KEY (workflow_id, document_hash)
  )`,
  `ALTER TABLE reviews ADD COLUMN IF NOT EXISTS samples jsonb`,
  `ALTER TABLE workflows ADD COLUMN IF NOT EXISTS gate_step text`,
  `ALTER TABLE workflows ADD COLUMN IF NOT EXISTS gate_reason text`,
  `ALTER TABLE workflows ADD COLUMN IF NOT EXISTS ci_verified boolean DEFAULT false`,
];
