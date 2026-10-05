CREATE TABLE IF NOT EXISTS auth_attempts (
  scope_key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  window_start_epoch INTEGER NOT NULL,
  locked_until_epoch INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_auth_attempts_lock
  ON auth_attempts (locked_until_epoch);
