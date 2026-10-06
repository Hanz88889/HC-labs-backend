import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);

function declaredBindings() {
  const toml = readFileSync(new URL('wrangler.toml', root), 'utf8');
  return new Set([...toml.matchAll(/^\s*binding\s*=\s*"([^"]+)"/gm)].map((m) => m[1]));
}

function usedBindings() {
  const used = new Set();
  for (const file of readdirSync(root)) {
    if (!file.endsWith('.js')) continue;
    const source = readFileSync(new URL(file, root), 'utf8');
    for (const match of source.matchAll(/\benv\.((?:HC_|hc_)[A-Za-z0-9_]*)/g)) used.add(match[1]);
  }
  return used;
}

function effectiveBindings() {
  const declared = declaredBindings();
  if (declared.has('LICENSE_KV')) declared.add('hc_kv');
  return declared;
}

test('every binding the code reads is declared in wrangler.toml', () => {
  const declared = effectiveBindings();
  const missing = [...usedBindings()].filter((name) => !declared.has(name));
  assert.deepEqual(missing, []);
});

test('wrangler.toml declares a KV binding (hc_kv or LICENSE_KV), D1 and R2', () => {
  const declared = declaredBindings();
  assert.ok(declared.has('hc_kv') || declared.has('LICENSE_KV'), 'binding KV hilang');
  for (const name of ['HC_DB', 'HC_ASSETS']) assert.ok(declared.has(name), `binding ${name} hilang`);
});
