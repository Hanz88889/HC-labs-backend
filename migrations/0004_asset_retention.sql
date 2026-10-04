PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS generation_assets (
  asset_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  attempt_id TEXT,
  storage_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES generation_jobs(job_id),
  FOREIGN KEY (attempt_id) REFERENCES generation_attempts(attempt_id)
);

CREATE INDEX IF NOT EXISTS idx_generation_assets_job
  ON generation_assets (job_id, created_at DESC);
