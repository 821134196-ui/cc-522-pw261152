import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
import { FEATURE_KEYS, FEATURES } from '../src/spec.js';

function fresh() {
  const store = new Store(':memory:');
  const service = new Service(store);
  service.ensureInitialized();
  return { store, service };
}

test('materialization is keyed by side, entity and config hash', () => {
  const { store, service } = fresh();
  const cfg = { ...service.pipelines().offline, window_start_inclusive: false };
  service.materializeEntity('offline', 'ACC-2041', cfg);
  const rows = store.db
    .prepare(
      'SELECT config_hash, features FROM materializations WHERE side = ? AND entity_key = ? ORDER BY computed_at DESC',
    )
    .all('offline', 'ACC-2041');
  assert.equal(rows.length, 2, 'the variant config is stored alongside the current one');
  assert.notEqual(rows[0].config_hash, rows[1].config_hash);
  // The latest row (the variant) recomputes the boundary row; the earlier does not.
  assert.notEqual(JSON.parse(rows[0].features).spend_24h, JSON.parse(rows[1].features).spend_24h);
  assert.equal(store.getMaterialization('offline', 'ACC-2041').config_hash, rows[0].config_hash);
  store.close();
});

test('a config change marks untouched materializations stale until recomputed', () => {
  const { store, service } = fresh();
  assert.equal(service.materializedDiff('ACC-2041').every((d) => !d.offline_stale && !d.online_stale), true);
  const next = service.planRepair({ causes: ['window_boundary'] }).next_configs;
  store.setPipelines(next, '2026-11-20T00:00:00Z');
  service._digestCache.clear();
  const stale = service.materializedDiff('ACC-2041');
  assert.ok(stale.some((d) => d.offline_stale || d.online_stale), 'old vectors must be flagged as stale');
  service.recomputeScope(['ACC-2041'], { trigger: 'test', scope: { kind: 'manual' }, at: '2026-11-20T00:00:00Z' });
  assert.equal(service.materializedDiff('ACC-2041').every((d) => !d.offline_stale && !d.online_stale), true);
  store.close();
});

test('every materialized vector has all features at the declared precision', () => {
  const { store, service } = fresh();
  for (const entityKey of service.index.entityKeys) {
    for (const side of ['offline', 'online']) {
      const mat = store.getMaterialization(side, entityKey);
      assert.ok(mat, `${side}:${entityKey} materialized`);
      assert.equal(mat.input_digest.length, 16);
      for (const key of FEATURE_KEYS) {
        const value = mat.features[key];
        if (value === null) continue;
        assert.equal(typeof value, 'number');
        const digits = (String(value).split('.')[1] || '').length;
        assert.ok(digits <= FEATURES[key].precision, `${side}:${entityKey}:${key} over-precise (${value})`);
      }
    }
  }
  store.close();
});

test('sample evidence points at the exact boundary row', () => {
  const { service } = fresh();
  const sample = service.sample('ACC-2041', 'spend_24h');
  assert.equal(sample.window.start, '2026-11-18T06:00:00.000Z');
  assert.equal(sample.window.end, '2026-11-19T06:00:00.000Z');
  assert.equal(sample.window.offline.start_inclusive, true);
  assert.equal(sample.window.online.start_inclusive, false);
  const row = sample.flagged_rows.find((r) => r.at_start);
  assert.ok(row, 'the row on the window start must be flagged');
  assert.equal(row.offline_decision.eligible, true);
  assert.equal(row.online_decision.eligible, false);
  assert.equal(row.diverges, true);
  assert.equal(row.amount, 320);
});

test('sample for an entity with no rows still explains the fill policy', () => {
  const { service } = fresh();
  const sample = service.sample('ACC-2059', 'spend_24h');
  assert.equal(sample.offline_value, 0);
  assert.equal(sample.online_value, null);
  assert.deepEqual(sample.raw_rows, []);
  assert.equal(sample.attribution[0].cause, 'missing_fill');
});

test('unknown feature and unknown diff are rejected with 404', () => {
  const { service } = fresh();
  assert.throws(() => service.sample('ACC-2041', 'nope'), (err) => err.status === 404);
  assert.throws(() => service.sample('ACC-2070', 'spend_24h'), (err) => err.status === 404);
});

test('validateNow checks window, watermark, dedupe, fill and idempotency', () => {
  const { service } = fresh();
  const report = service.validateNow({ label: 'test' });
  assert.deepEqual(
    report.checks.map((c) => c.key),
    ['window', 'watermark', 'dedupe', 'fill', 'version', 'idempotent'],
  );
  assert.equal(report.checks.find((c) => c.key === 'idempotent').status, 'pass');
  assert.equal(report.checks.find((c) => c.key === 'window').status, 'fail');
  assert.equal(report.status, 'fail');
  // The snapshot is surfaced back on state so the UI can show the last result.
  assert.equal(service.state().validation.status, 'fail');
});

test('quality inventory reflects the configured offline watermark', () => {
  const { service } = fresh();
  const quality = service.quality();
  assert.equal(quality.watermark, '2026-11-19T05:45:00.000Z');
  assert.equal(quality.late.length, 5);
  assert.equal(quality.duplicates.length, 3, 'ACC-2046 and both ACC-2049 payloads');
  for (const group of quality.duplicates) assert.equal(group.rows.length, 2);
  assert.equal(quality.policy.offline_dedupe, 'event_id');
  assert.equal(quality.policy.online_dedupe, 'entity_minute_amount');
});

test('the service is deterministic across instances', () => {
  const a = fresh();
  const b = fresh();
  assert.deepEqual(
    a.service.compareAll().map((i) => [i.entity_key, i.feature_key, i.delta]),
    b.service.compareAll().map((i) => [i.entity_key, i.feature_key, i.delta]),
  );
  assert.deepEqual(a.service.diffSummary().totals, b.service.diffSummary().totals);
  a.store.close();
  b.store.close();
});

test('reset returns the app to the same baseline', () => {
  const { store, service } = fresh();
  const baseline = service.diffSummary().totals.diffs;
  service.applyRepair({ causes: ['duplicate_event'] });
  assert.ok(service.diffSummary().totals.diffs < baseline);
  service.reset();
  assert.equal(service.diffSummary().totals.diffs, baseline);
  assert.equal(service.repairs().length, 0);
  assert.equal(service.releases().length, 0);
  store.close();
});

test('state payload carries everything the console renders', () => {
  const { store, service } = fresh();
  const state = service.state();
  for (const key of ['summary', 'diffs', 'releases', 'cohort', 'bundles', 'causes', 'repairs', 'jobs', 'quality']) {
    assert.ok(key in state, `state.${key}`);
  }
  assert.equal(state.as_of, '2026-11-19T06:00:00Z');
  assert.equal(state.active_version, '3.2.0');
  assert.ok(state.summary.entities.length > 0);
  assert.ok(state.summary.events.length > 0);
  store.close();
});
