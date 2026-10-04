PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS model_registry (
  model_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS model_capabilities (
  model_key TEXT NOT NULL,
  capability TEXT NOT NULL,
  supported INTEGER NOT NULL DEFAULT 1 CHECK (supported IN (0,1)),
  metadata_json TEXT,
  PRIMARY KEY (model_key, capability),
  FOREIGN KEY (model_key) REFERENCES model_registry(model_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS model_pricing (
  model_key TEXT NOT NULL,
  pricing_key TEXT NOT NULL,
  unit TEXT NOT NULL,
  amount_usd REAL NOT NULL CHECK (amount_usd >= 0),
  effective_from TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  effective_until TEXT,
  PRIMARY KEY (model_key, pricing_key, effective_from),
  FOREIGN KEY (model_key) REFERENCES model_registry(model_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cost_records (
  cost_record_id TEXT PRIMARY KEY,
  job_id TEXT,
  attempt_id TEXT,
  model_key TEXT,
  provider TEXT NOT NULL,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  actual_cost_usd REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  usage_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES generation_jobs(job_id),
  FOREIGN KEY (attempt_id) REFERENCES generation_attempts(attempt_id),
  FOREIGN KEY (model_key) REFERENCES model_registry(model_key)
);

CREATE INDEX IF NOT EXISTS idx_model_capabilities_capability
  ON model_capabilities (capability, supported);
CREATE INDEX IF NOT EXISTS idx_cost_records_job
  ON cost_records (job_id, created_at DESC);
