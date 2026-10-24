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

CREATE TABLE IF NOT EXISTS early_access (
  id INTEGER PRIMARY KEY,
  name TEXT, business TEXT, vendor_type TEXT, enquiries_per_week TEXT,
  email TEXT, whatsapp TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

let instance: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (instance) return instance;
  const dir = process.env.DATA_DIR || path.join(process.cwd(), "data");
  mkdirSync(dir, { recursive: true });
  const file = process.env.MATCHIRE_DB || path.join(dir, "matchire.db");
  const conn = new DatabaseSync(file);
  conn.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  conn.exec(SCHEMA);
  instance = conn;
  return conn;
}

type Param = string | number | bigint | null | Uint8Array;

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
