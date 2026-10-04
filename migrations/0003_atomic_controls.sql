PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS operation_locks (
  lock_key TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  expires_at_epoch INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_operation_locks_expiry
  ON operation_locks (expires_at_epoch);

CREATE TABLE IF NOT EXISTS spend_counters (
  day_key TEXT PRIMARY KEY,
  spent_usd REAL NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  cap_usd REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS spend_reservations (
  reservation_id TEXT PRIMARY KEY,
  day_key TEXT NOT NULL,
  amount_usd REAL NOT NULL CHECK (amount_usd > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (day_key) REFERENCES spend_counters(day_key)
);

CREATE INDEX IF NOT EXISTS idx_spend_reservations_day
  ON spend_reservations (day_key, created_at DESC);
