import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Service, ACTIVE_VERSION } from '../src/service.js';
import { INJECTED } from '../src/seed.js';
import { FEATURE_KEYS } from '../src/spec.js';

let service;

before(() => {
  const store = new Store(':memory:');
  service = new Service(store);
  service.ensureInitialized();
});

after(() => {
  service.store.close();
});

test('baseline comparison covers every feature for every entity', () => {
  const summary = service.diffSummary();
  assert.equal(summary.totals.entities, 48);
  assert.equal(summary.totals.features_compared, 48 * FEATURE_KEYS.length);
  assert.ok(summary.totals.diffs > 0, 'baseline should contain known divergences');
  assert.ok(summary.totals.entities_with_diffs < 48, 'most entities must agree');
});

test('each diff is localized to an entity and a feature, never a bare count', () => {
  for (const diff of service.compareAll()) {
    assert.match(diff.entity_key, /^ACC-\d{4}$/);
    assert.ok(FEATURE_KEYS.includes(diff.feature_key));
    assert.ok(['high', 'medium', 'low'].includes(diff.severity));
    assert.ok(diff.causes.length > 0, 'every diff carries an attribution');
  }
});

test('window boundary diffs are attributed to window_boundary', () => {
  const items = service.compareAll();
  const start = items.find((i) => i.entity_key === 'ACC-2041' && i.feature_key === 'spend_24h');
  assert.ok(start, 'ACC-2041 should differ on spend_24h');
  assert.equal(start.primary_cause, 'window_boundary');
  assert.equal(start.delta, -320);
});

test('late events are attributed, not guessed', () => {
  const item = service.compareAll().find((i) => i.entity_key === 'ACC-2043' && i.feature_key === 'spend_24h');
  assert.equal(item.primary_cause, 'late_event');
  const sample = service.sample('ACC-2043', 'spend_24h');
  const late = sample.flagged_rows.find((r) => r.event_id === 'EV-ACC-2043-LATE');
  assert.ok(late, 'the late raw row must appear in the evidence');
  assert.equal(late.after_offline_watermark, true);
  assert.equal(late.offline_decision.eligible, false);
  assert.equal(late.online_decision.eligible, true);
});

test('characters in a key variant are localized to that entity', () => {
  const item = service.compareAll().find((i) => i.entity_key === 'ACC-2056' && i.feature_key === 'spend_24h');
  assert.equal(item.primary_cause, 'key_mismatch');
  const sample = service.sample('ACC-2056', 'spend_24h');
  assert.ok(sample.flagged_rows.every((r) => r.raw_key !== 'ACC-2056'));
  assert.ok(sample.flagged_rows.some((r) => r.raw_key.trim().toLowerCase() === 'acc-2056'));
});

test('duplicate delivery is visible on the record, with both sides keeping it', () => {
  const sample = service.sample('ACC-2046', 'spend_24h');
  const dup = sample.flagged_rows.filter((r) => r.duplicate_group);
  assert.equal(dup.length, 2, 'both deliveries of the duplicate must be shown');
  assert.ok(dup.some((r) => r.offline_decision.reason === 'duplicate_superseded'));
  assert.ok(dup.every((r) => r.online_decision.eligible), 'online dedupe keeps both rows');
});

test('quality inventory lists late and duplicate inputs', () => {
  const quality = service.quality();
  assert.deepEqual(quality.late_entities, ['ACC-2042', 'ACC-2043', 'ACC-2044', 'ACC-2050', 'ACC-2051']);
  assert.deepEqual(quality.duplicate_entities, ['ACC-2046', 'ACC-2049']);
  for (const row of quality.late) assert.ok(row.minutes_late > 0);
});

test('repair scope is derived from vector changes, not only cause matches', () => {
  const store = new Store(':memory:');
  const svc = new Service(store);
  svc.ensureInitialized();
  const before = svc.diffSummary().totals.diffs;
  const result = svc.applyRepair({ causes: ['late_event'] });
  assert.equal(result.job.verified.drifted.length, 0, 'no entity outside scope may drift');
  assert.ok(result.job.recomputed.includes('ACC-2042'), 'late rows on a window edge are also affected');
  assert.ok(result.after.diffs < before);
  assert.equal(result.job.idempotent, true);
  store.close();
});

test('only scoped entities are recomputed; everything else is reused', () => {
  const store = new Store(':memory:');
  const svc = new Service(store);
  svc.ensureInitialized();
  const result = svc.applyRepair({ causes: ['duplicate_event'] });
  assert.deepEqual(result.job.recomputed, ['ACC-2046', 'ACC-2049']);
  assert.equal(result.job.reused, 46);
  assert.equal(result.after.diffs, result.before.diffs - 9);
  store.close();
});

test('applying the same repair twice is a no-op', () => {
  const store = new Store(':memory:');
  const svc = new Service(store);
  svc.ensureInitialized();
  svc.applyRepair({ causes: ['duplicate_event'] });
  const second = svc.applyRepair({ causes: ['duplicate_event'] });
  assert.equal(second.job.recomputed.length, 0);
  assert.equal(second.before.diffs, second.after.diffs);
  store.close();
});

test('repairing every repairable cause converges to zero diffs', () => {
  const store = new Store(':memory:');
  const svc = new Service(store);
  svc.ensureInitialized();
  for (const cause of [
    'late_event',
    'window_boundary',
    'duplicate_event',
    'dim_missing',
    'dim_fanout',
    'fx_unknown',
    'key_mismatch',
    'missing_fill',
    'missing_value',
  ]) {
    svc.applyRepair({ causes: [cause] });
  }
  assert.equal(svc.diffSummary().totals.diffs, 0);
  store.close();
});

test('canary cohort is deterministic and stable per entity', () => {
  const store = new Store(':memory:');
  const svc = new Service(store);
  svc.ensureInitialized();
  const release = svc.createRelease({ version: '4.0.0', percent: 20 }).release;
  const first = svc.cohortFor(release);
  const second = svc.cohortFor(release);
  assert.deepEqual(first, second);
  assert.ok(first.length > 0 && first.length < 48);
  store.close();
});

test('a release only recomputes its cohort and is explainable within its declared impact', () => {
  const store = new Store(':memory:');
  const svc = new Service(store);
  svc.ensureInitialized();
  const before = svc.diffSummary().totals.diffs;
  const { release, job } = svc.createRelease({ version: '4.0.0', percent: 20 });
  const cohort = svc.cohortFor(release);
  assert.deepEqual(job.recomputed, [...cohort].sort());
  assert.equal(job.reused, 48 - cohort.length);
  const validation = svc.validateRelease(release.id);
  assert.equal(validation.status, 'pass');
  assert.equal(validation.unexplained.length, 0);
  assert.equal(validation.checks.find((c) => c.key === 'blast_radius').status, 'pass');
  // Non-cohort entities keep their old vectors.
  assert.equal(svc.diffSummary().totals.canary_entities, cohort.length);
  assert.ok(svc.diffSummary().totals.diffs > before);
  store.close();
});

test('a bundle whose actual impact exceeds its declared radius fails validation', () => {
  const store = new Store(':memory:');
  const svc = new Service(store);
  svc.ensureInitialized();
  const { release } = svc.createRelease({ version: '4.1.0', percent: 20 });
  const validation = svc.validateRelease(release.id);
  assert.equal(validation.status, 'fail');
  assert.ok(validation.unexplained.length > 0);
  assert.equal(validation.unexplained.every((k) => k.endsWith(':risk_score')), true);
  store.close();
});

test('ramp only recomputes entities entering the cohort', () => {
  const store = new Store(':memory:');
  const svc = new Service(store);
  svc.ensureInitialized();
  const { release } = svc.createRelease({ version: '4.0.0', percent: 20 });
  const before = new Set(svc.cohortFor(release));
  const ramp = svc.rampRelease(release.id, 50);
  const after = new Set(svc.cohortFor(ramp.release));
  const added = [...after].filter((k) => !before.has(k));
  assert.deepEqual(ramp.job.recomputed, [...added].sort());
  assert.equal(ramp.job.reused, 48 - added.length);
  store.close();
});

test('rollback restores the baseline exactly and only recomputes the cohort', () => {
  const store = new Store(':memory:');
  const svc = new Service(store);
  svc.ensureInitialized();
  const baseline = svc.diffSummary().totals.diffs;
  const { release } = svc.createRelease({ version: '4.0.0', percent: 25 });
  const cohort = svc.cohortFor(release);
  const rollback = svc.rollbackRelease(release.id);
  assert.equal(rollback.release.status, 'rolled_back');
  assert.equal(rollback.release.percent, 0);
  assert.deepEqual(rollback.job.recomputed, [...cohort].sort());
  assert.equal(svc.diffSummary().totals.diffs, baseline);
  assert.equal(svc.diffSummary().totals.canary_entities, 0);
  assert.equal(rollback.job.idempotent, true);
  store.close();
});

test('active version applies to entities outside the canary cohort', () => {
  const store = new Store(':memory:');
  const svc = new Service(store);
  svc.ensureInitialized();
  const { release } = svc.createRelease({ version: '4.0.0', percent: 20 });
  const cohort = new Set(svc.cohortFor(release));
  for (const key of svc.index.entityKeys) {
    assert.equal(svc.effectiveVersion(key), cohort.has(key) ? '4.0.0' : ACTIVE_VERSION);
  }
  store.close();
});

test('a partial recompute matches a full recompute exactly', () => {
  const partial = new Service(new Store(':memory:'));
  partial.ensureInitialized();
  partial.recomputeScope(['ACC-2046'], {
    trigger: 'test',
    scope: { kind: 'manual' },
    at: '2026-11-20T00:00:00Z',
    idempotency_probe: true,
  });
  const full = new Service(new Store(':memory:'));
  full.ensureInitialized();
  for (const side of ['offline', 'online']) {
    const a = partial.materialized(side, 'ACC-2046');
    const b = full.materialized(side, 'ACC-2046');
    assert.equal(a.input_digest, b.input_digest);
    assert.deepEqual(a.features, b.features);
  }
  partial.store.close();
  full.store.close();
});

test('ground truth injection list matches what the engine attributes', () => {
  const items = service.compareAll();
  for (const [entityKey, entries] of Object.entries(INJECTED)) {
    for (const entry of entries) {
      const item = items.find((i) => i.entity_key === entityKey && i.feature_key === entry.feature);
      assert.ok(item, `${entityKey}/${entry.feature} should be a visible diff`);
      assert.ok(
        item.causes.includes(entry.cause),
        `${entityKey}/${entry.feature}: expected ${entry.cause}, got ${item.causes.join(',')}`,
      );
      assert.equal(item.primary_cause, entry.cause, `${entityKey}/${entry.feature} primary cause`);
    }
  }
});
