PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS licenses (
  license_key TEXT PRIMARY KEY,
  email TEXT,
  tier TEXT NOT NULL DEFAULT 'STD',
  status TEXT NOT NULL DEFAULT 'active',
  credits_image INTEGER NOT NULL DEFAULT 0,
  credits_video INTEGER NOT NULL DEFAULT 0,
  limit_value INTEGER NOT NULL DEFAULT 0,
  reset_date TEXT,
  premium_t2i INTEGER NOT NULL DEFAULT 0,
  premium_i2i INTEGER NOT NULL DEFAULT 0,
  premium_t2v INTEGER NOT NULL DEFAULT 0,
  premium_i2v INTEGER NOT NULL DEFAULT 0,
  bound_at TEXT,
  source_updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS generation_jobs (
  job_id TEXT PRIMARY KEY,
  license_key TEXT NOT NULL,
  flow TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT,
  model_id TEXT,
  request_id TEXT,
  task_id TEXT,
  prompt_hash TEXT,
  duration_seconds INTEGER,
  aspect_ratio TEXT,
  reference_count INTEGER NOT NULL DEFAULT 0,
  reference_strategy TEXT,
  result_url TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  FOREIGN KEY (license_key) REFERENCES licenses(license_key)
);

CREATE TABLE IF NOT EXISTS generation_attempts (
  attempt_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  status TEXT NOT NULL,
  provider TEXT,
  model_id TEXT,
  request_id TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  FOREIGN KEY (job_id) REFERENCES generation_jobs(job_id)
);

CREATE TABLE IF NOT EXISTS quota_ledger (
  ledger_id TEXT PRIMARY KEY,
  license_key TEXT NOT NULL,
  job_id TEXT,
  event_type TEXT NOT NULL,
  credit_type TEXT,
  units INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL UNIQUE,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (license_key) REFERENCES licenses(license_key),
  FOREIGN KEY (job_id) REFERENCES generation_jobs(job_id)
);

CREATE INDEX IF NOT EXISTS idx_generation_jobs_license_created
  ON generation_jobs (license_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_request
  ON generation_jobs (request_id);
CREATE INDEX IF NOT EXISTS idx_generation_attempts_job
  ON generation_attempts (job_id, attempt_no);
CREATE INDEX IF NOT EXISTS idx_quota_ledger_license_created
  ON quota_ledger (license_key, created_at DESC);
