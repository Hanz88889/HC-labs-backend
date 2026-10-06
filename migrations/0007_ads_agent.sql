CREATE TABLE IF NOT EXISTS ads_meta_connections (
  connection_id TEXT PRIMARY KEY,
  license_key TEXT NOT NULL,
  ad_account_id TEXT NOT NULL,
  account_name TEXT,
  token_ciphertext TEXT,
  token_expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ads_meta_connections_license ON ads_meta_connections(license_key);

CREATE TABLE IF NOT EXISTS ads_campaign_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  license_key TEXT NOT NULL,
  ad_account_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ads_snapshots_lookup ON ads_campaign_snapshots(license_key, ad_account_id, period_end);

CREATE TABLE IF NOT EXISTS ads_business_rules (
  rule_id TEXT PRIMARY KEY,
  license_key TEXT NOT NULL,
  rule_key TEXT NOT NULL,
  rule_value TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(license_key, rule_key)
);

CREATE TABLE IF NOT EXISTS ads_action_proposals (
  proposal_id TEXT PRIMARY KEY,
  license_key TEXT NOT NULL,
  action_type TEXT NOT NULL,
  target_id TEXT,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
  requested_by TEXT,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ads_proposals_queue ON ads_action_proposals(license_key, status, created_at);

CREATE TABLE IF NOT EXISTS ads_audit_logs (
  audit_id TEXT PRIMARY KEY,
  license_key TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  old_value_json TEXT,
  new_value_json TEXT,
  reason TEXT,
  approval TEXT,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ads_audit_license ON ads_audit_logs(license_key, created_at);
