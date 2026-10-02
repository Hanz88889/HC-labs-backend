import test from 'node:test';
import assert from 'node:assert/strict';
import { licenseEntryToRow, rowToLicenseEntry } from '../d1-store.js';

test('maps legacy license entry into D1 row', () => {
  const row = licenseEntryToRow('HC-001', {
    email: 'owner@example.com',
    tier: 'PRO',
    status: 'active',
    credits: { image: 8, video: 3 },
    limit: 30,
    reset_date: '2026-11-01',
    premiumUsage: { t2i: 2, i2i: 1, t2v: 4, i2v: 0 },
  });
  assert.deepEqual({
    license_key: row.license_key,
    email: row.email,
    tier: row.tier,
    credits_image: row.credits_image,
    credits_video: row.credits_video,
    premium_t2v: row.premium_t2v,
  }, {
    license_key: 'HC-001',
    email: 'owner@example.com',
    tier: 'PRO',
    credits_image: 8,
    credits_video: 3,
    premium_t2v: 4,
  });
});

test('maps D1 license row back to legacy-compatible entry', () => {
  const entry = rowToLicenseEntry({
    email: 'owner@example.com', tier: 'STD', status: 'active',
    credits_image: 2, credits_video: 1, limit_value: 10, reset_date: null,
    premium_t2i: 1, premium_i2i: 0, premium_t2v: 0, premium_i2v: 0,
    bound_at: null,
  });
  assert.deepEqual(entry.credits, { image: 2, video: 1 });
  assert.equal(entry.limit, 10);
  assert.equal(entry.premiumUsage.t2i, 1);
});
