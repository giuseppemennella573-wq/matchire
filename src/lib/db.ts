import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

// One SQLite file per deployment. node:sqlite is synchronous, which keeps the
// engine simple: every request reads and writes in a single, consistent pass.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  tone TEXT NOT NULL DEFAULT 'Warm, friendly and concise. Light emoji is fine.',
  signoff TEXT NOT NULL DEFAULT '',
  capacity INTEGER,
  jobs_per_day INTEGER NOT NULL DEFAULT 1,
  min_spend REAL NOT NULL DEFAULT 0,
  offpeak_discount REAL NOT NULL DEFAULT 0,
  auto_send INTEGER NOT NULL DEFAULT 0,
  hold_hours INTEGER NOT NULL DEFAULT 48,
  followup_days INTEGER NOT NULL DEFAULT 2,
  bundle_suggestions INTEGER NOT NULL DEFAULT 1,
  referral_fee_pct REAL NOT NULL DEFAULT 10,
  deposit_note TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  wa_phone_number_id TEXT,
  wa_token TEXT,
  inbound_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('package','addon')),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  pricing TEXT NOT NULL CHECK (pricing IN ('flat','per_hour','per_pax')),
  price REAL NOT NULL,
  included_hours REAL,
  extra_hour_price REAL,
  min_pax INTEGER,
  max_pax INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS enquiries (
  id INTEGER PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  contact_name TEXT,
  contact_handle TEXT,
  contact_email TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  lead TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  quote TEXT,
  owner_reason TEXT,
  event_date TEXT,
  first_response_at TEXT,
  last_inbound_at TEXT,
  last_outbound_at TEXT,
  followup_stage INTEGER NOT NULL DEFAULT 0,
  next_followup_at TEXT,
  won_value REAL,
  referred_from INTEGER REFERENCES vendors(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS enquiries_vendor ON enquiries(vendor_id, status);
CREATE INDEX IF NOT EXISTS enquiries_contact ON enquiries(vendor_id, contact_handle);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  enquiry_id INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('in','out','note')),
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  purpose TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS messages_enquiry ON messages(enquiry_id);

CREATE TABLE IF NOT EXISTS holds (
  id INTEGER PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  enquiry_id INTEGER REFERENCES enquiries(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('hold','booking','block')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','expired')),
  note TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS holds_vendor_date ON holds(vendor_id, date, status);

CREATE TABLE IF NOT EXISTS partnerships (
  id INTEGER PRIMARY KEY,
  requester_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  partner_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (requester_id, partner_id)
);

CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY,
  from_vendor INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  to_vendor INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  source_enquiry INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
  target_enquiry INTEGER NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
  fee_pct REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost')),
  fee_amount REAL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY,
  file TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  reason TEXT NOT NULL,
  sg_date TEXT NOT NULL,
  emailed_at TEXT,
  email_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id);

CREATE TABLE IF NOT EXISTS early_access (
  id INTEGER PRIMARY KEY,
  name TEXT, business TEXT, vendor_type TEXT, enquiries_per_week TEXT,
  email TEXT, whatsapp TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

let instance: DatabaseSync | null = null;

/** Where the database file lives. Backups go in a "backups" folder beside it. */
export function dbPath(): string {
  return process.env.MATCHIRE_DB || path.join(process.env.DATA_DIR || path.join(process.cwd(), "data"), "matchire.db");
}

export function db(): DatabaseSync {
  if (instance) return instance;
  const file = dbPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const conn = new DatabaseSync(file);
  conn.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  conn.exec(SCHEMA);
  migrate(conn);
  instance = conn;
  return conn;
}

// Columns added after launch. CREATE TABLE IF NOT EXISTS leaves existing tables
// alone, so new columns are added here for databases created before them.
const COLUMNS: [table: string, column: string, definition: string][] = [
  ["early_access", "notified_at", "TEXT"],
  ["early_access", "notify_error", "TEXT"],
  ["early_access", "contacted_at", "TEXT"],
  ["vendors", "wa_templates_approved", "INTEGER NOT NULL DEFAULT 0"],
  ["messages", "template", "TEXT"],
  ["vendors", "share_from_price", "INTEGER NOT NULL DEFAULT 0"],
  ["users", "admin_contacted_at", "TEXT"],
];

function migrate(conn: DatabaseSync) {
  for (const [table, column, definition] of COLUMNS) {
    const cols = conn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

type Param =string | number | bigint | null | Uint8Array;

export function all<T>(sql: string, ...params: Param[]): T[] {
  return db().prepare(sql).all(...params) as T[];
}

export function get<T>(sql: string, ...params: Param[]): T | undefined {
  return db().prepare(sql).get(...params) as T | undefined;
}

export function run(sql: string, ...params: Param[]): number {
  const r = db().prepare(sql).run(...params);
  return Number(r.lastInsertRowid);
}

export function tx<T>(fn: () => T): T {
  const conn = db();
  conn.exec("BEGIN");
  try {
    const out = fn();
    conn.exec("COMMIT");
    return out;
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}

export const nowIso = () => new Date().toISOString();
