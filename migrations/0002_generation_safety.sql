PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS quota_balances (
  license_key TEXT NOT NULL,
  credit_type TEXT NOT NULL,
  available_units INTEGER NOT NULL DEFAULT 0 CHECK (available_units >= 0),
  reserved_units INTEGER NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  committed_units INTEGER NOT NULL DEFAULT 0 CHECK (committed_units >= 0),
  released_units INTEGER NOT NULL DEFAULT 0 CHECK (released_units >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (license_key, credit_type),
  FOREIGN KEY (license_key) REFERENCES licenses(license_key)
);

INSERT OR IGNORE INTO quota_balances (license_key, credit_type, available_units)
SELECT license_key, 'video', credits_video FROM licenses;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  idempotency_key TEXT PRIMARY KEY,
  license_key TEXT NOT NULL,
  job_id TEXT NOT NULL UNIQUE,
  request_hash TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (license_key) REFERENCES licenses(license_key),
  FOREIGN KEY (job_id) REFERENCES generation_jobs(job_id)
);

CREATE TABLE IF NOT EXISTS generation_events (
  event_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES generation_jobs(job_id)
);

CREATE TABLE IF NOT EXISTS validation_results (
  validation_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  attempt_id TEXT,
  validation_type TEXT NOT NULL,
  status TEXT NOT NULL,
  failure_code TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES generation_jobs(job_id),
  FOREIGN KEY (attempt_id) REFERENCES generation_attempts(attempt_id)
);

ALTER TABLE generation_attempts ADD COLUMN input_duration_seconds INTEGER;
ALTER TABLE generation_attempts ADD COLUMN output_duration_seconds REAL;
ALTER TABLE generation_attempts ADD COLUMN resolution TEXT;
ALTER TABLE generation_attempts ADD COLUMN estimated_cost_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE generation_attempts ADD COLUMN actual_cost_usd REAL;
ALTER TABLE generation_attempts ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE generation_attempts ADD COLUMN metadata_json TEXT;

CREATE INDEX IF NOT EXISTS idx_quota_balances_license
  ON quota_balances (license_key, credit_type);
CREATE INDEX IF NOT EXISTS idx_idempotency_license
  ON idempotency_keys (license_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generation_events_job_created
  ON generation_events (job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_validation_results_job_created
  ON validation_results (job_id, created_at DESC);
