// HTTP surface: every route the console calls is exercised over a real socket,
// including the write paths (release, ramp, rollback, repair, reset).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

let server;
let base;

before(async () => {
  ({ server } = createApp({ dbPath: ':memory:' }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function call(path, method = 'GET', body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json();
  return { status: res.status, payload };
}

test('static shell is served at / with no-store', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(await res.text(), /<div id="app">/);
});

test('path traversal outside public/ is refused', async () => {
  const res = await fetch(base + '/../src/service.js');
  const body = await res.text();
  assert.ok(!body.includes('class Service'), 'source files must not be served');
});

test('GET /api/state carries the summary and the diff list', async () => {
  const { status, payload } = await call('/api/state');
  assert.equal(status, 200);
  assert.equal(payload.summary.totals.entities, 48);
  assert.ok(payload.diffs.length > 0);
  assert.equal(payload.summary.totals.diffs, payload.diffs.length, 'summary and list agree');
  assert.equal(payload.active_version, '3.2.0');
});

test('GET /api/diffs filters by cause, feature and severity', async () => {
  const all = (await call('/api/diffs')).payload;
  const late = (await call('/api/diffs?cause=late_event')).payload;
  assert.ok(late.filtered > 0 && late.filtered < all.total);
  assert.ok(late.items.every((i) => i.causes.includes('late_event')));
  const spend = (await call('/api/diffs?feature=spend_24h')).payload;
  assert.ok(spend.items.every((i) => i.feature_key === 'spend_24h'));
  const high = (await call('/api/diffs?severity=high')).payload;
  assert.ok(high.items.every((i) => i.severity === 'high'));
  const none = (await call('/api/diffs?release=canary')).payload;
  assert.equal(none.filtered, 0, 'nothing is canaried before a release exists');
});

test('GET /api/sample returns the flagged input rows', async () => {
  const { status, payload } = await call('/api/sample/ACC-2043/spend_24h');
  assert.equal(status, 200);
  assert.equal(payload.entity_key, 'ACC-2043');
  assert.ok(payload.flagged_rows.some((r) => r.after_offline_watermark));
  assert.ok(payload.raw_rows.length >= payload.flagged_rows.length);
});

test('unknown route and unknown sample are JSON errors with a status', async () => {
  assert.equal((await call('/api/nope')).status, 404);
  const bad = await call('/api/sample/ACC-2041/not_a_feature');
  assert.equal(bad.status, 404);
  assert.ok(bad.payload.error);
});

test('POST /api/repairs/plan previews without writing', async () => {
  const before = (await call('/api/state')).payload.summary.totals.diffs;
  const { status, payload } = await call('/api/repairs/plan', 'POST', { causes: ['duplicate_event'] });
  assert.equal(status, 200);
  assert.deepEqual(payload.affected_entities, ['ACC-2046', 'ACC-2049']);
  assert.equal((await call('/api/state')).payload.summary.totals.diffs, before, 'plan is read-only');
});

test('POST /api/repairs applies the scoped recompute', async () => {
  const { status, payload } = await call('/api/repairs', 'POST', { causes: ['duplicate_event'] });
  assert.equal(status, 200);
  assert.deepEqual(payload.job.recomputed, ['ACC-2046', 'ACC-2049']);
  assert.equal(payload.job.reused, 46);
  assert.equal(payload.job.verified.drifted.length, 0);
  assert.equal(payload.job.idempotent, true);
  assert.ok(payload.after.diffs < payload.before.diffs);
});

test('the whole canary loop goes through HTTP', async () => {
  const created = await call('/api/releases', 'POST', { version: '4.0.0', percent: 20 });
  assert.equal(created.status, 200);
  const id = created.payload.release.id;
  assert.ok(created.payload.job.recomputed.length > 0);

  const ramped = await call(`/api/releases/${id}/ramp`, 'POST', { percent: 60 });
  assert.equal(ramped.status, 200);
  assert.equal(ramped.payload.release.percent, 60);
  assert.ok(ramped.payload.added.length > 0);

  const validated = await call(`/api/releases/${id}/validate`, 'POST');
  assert.equal(validated.status, 200);
  assert.equal(validated.payload.status, 'pass');
  assert.equal(validated.payload.unexplained.length, 0);

  const releases = (await call('/api/releases')).payload;
  assert.equal(releases.current.id, id);
  assert.equal(releases.validation.status, 'pass', 'validation summary is surfaced');
  assert.equal(releases.cohort.length, validated.payload.cohort_size);

  const stateAfter = (await call('/api/state')).payload;
  assert.equal(stateAfter.cohort.length, validated.payload.cohort_size);
  const canaryDiffs = (await call('/api/diffs?release=canary')).payload;
  assert.equal(canaryDiffs.items.length, validated.payload.diffs_in_cohort);

  const rolled = await call(`/api/releases/${id}/rollback`, 'POST', { reason: 'test' });
  assert.equal(rolled.status, 200);
  assert.equal(rolled.payload.release.status, 'rolled_back');
  assert.equal(rolled.payload.validation.status, 'rolled_back');
  assert.equal((await call('/api/state')).payload.summary.release, null);
});

test('creating a release while one is in flight is a conflict', async () => {
  const first = await call('/api/releases', 'POST', { version: '4.0.0', percent: 10 });
  const second = await call('/api/releases', 'POST', { version: '4.0.0', percent: 10 });
  assert.equal(second.status, 409);
  await call(`/api/releases/${first.payload.release.id}/rollback`, 'POST', {});
});

test('unknown release version is rejected', async () => {
  const { status, payload } = await call('/api/releases', 'POST', { version: '9.9.9', percent: 10 });
  assert.equal(status, 400);
  assert.match(payload.error, /未知版本/);
});

test('invalid JSON body is a 400, not a crash', async () => {
  const res = await fetch(base + '/api/repairs/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  assert.ok(server.listening, 'server survives a bad body');
});

test('POST /api/validate records a snapshot the state exposes', async () => {
  const { status, payload } = await call('/api/validate', 'POST');
  assert.equal(status, 200);
  assert.ok(payload.checks.length >= 5);
  const state = (await call('/api/state')).payload;
  assert.equal(state.validation.status, payload.status);
});

test('POST /api/reset returns to the baseline', async () => {
  const { status, payload } = await call('/api/reset', 'POST');
  assert.equal(status, 200);
  assert.equal(payload.summary.totals.diffs, 60);
  assert.equal(payload.summary.release, null);
  assert.equal(payload.repairs.length, 0);
});
