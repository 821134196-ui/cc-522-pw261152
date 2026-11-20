// Headless render tests: the real app.js is imported against a minimal DOM shim
// and a live API server, so every view and the drill-down drawer are exercised
// as the browser would build them.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { installDom } from './dom-shim.js';
import { createApp } from '../src/server.js';
import { causeLabel } from '../public/format.js';

const { document } = installDom();

let server;
let baseUrl;
let app;

before(async () => {
  const created = createApp({ dbPath: ':memory:' });
  server = created.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (path, options) => nativeFetch(baseUrl + path, options);
  app = await import('../public/app.js');
  await app.refresh();
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const html = () => document.getElementById('app').outerHTML;
// The drawer is portalled to <body>, outside the app root.
const pageHtml = () => document.body.outerHTML;

test('overview renders the KPI row, cause breakdown and tables', () => {
  app.state.view = 'overview';
  app.render();
  const text = html();
  for (const label of ['实体一致率', '差异特征值', '迟到事件', '重复计算', '灰度范围']) {
    assert.ok(text.includes(label), `missing KPI ${label}`);
  }
  assert.ok(text.includes('差异原因分布'));
  assert.ok(text.includes('迟到事件'), 'cause legend names the late cause');
  assert.ok(text.includes('差异实体 Top 8'));
  assert.ok(text.includes('ACC-'), 'entity table is populated');
});

test('every diff cause has a label and a bar in the breakdown', () => {
  app.state.view = 'overview';
  app.render();
  const causes = app.state.data.summary.causes.map((c) => c.cause);
  const text = html();
  for (const cause of causes) {
    assert.ok(text.includes(`aria-label="${causeLabel(cause)} `), `no bar row for ${cause}`);
  }
});


test('diff table shows entity, feature, both values and version', () => {
  app.state.view = 'diffs';
  app.render();
  const text = html();
  const item = app.state.diffs[0];
  assert.ok(text.includes(item.entity_key));
  assert.ok(text.includes(item.feature_key));
  assert.ok(text.includes(app.state.data.active_version));
});

test('filters narrow the table and are reflected in the header count', async () => {
  app.state.filters = { feature: '', cause: 'late_event', severity: '', release: '' };
  await app.refresh();
  assert.ok(app.state.diffs.length > 0);
  assert.ok(app.state.diffs.every((d) => d.causes.includes('late_event')));
  app.state.view = 'diffs';
  app.render();
  assert.ok(html().includes(`已筛选 ${app.state.diffs.length} 项`));
  app.state.filters = { feature: 'spend_24h', cause: '', severity: '', release: '' };
  await app.refresh();
  assert.ok(app.state.diffs.every((d) => d.feature_key === 'spend_24h'));
  app.state.filters = { feature: '', cause: '', severity: '', release: '' };
  await app.refresh();
});

test('drawer opens on a duplicate entity and flags both deliveries', async () => {
  await app.openSample('ACC-2046', 'spend_24h');
  const text = pageHtml();
  assert.ok(text.includes('ACC-2046'));
  assert.ok(text.includes('输入记录 · 窗口内'));
  assert.ok(text.includes('重复投递'));
  assert.ok(text.includes('两侧口径分叉'));
  assert.ok(text.includes('差异归因'));
  const sample = app.state.drawer;
  assert.equal(sample.flagged_rows.length, 2);
});

test('drawer on a boundary entity names the window edge', async () => {
  await app.openSample('ACC-2041', 'spend_24h');
  const text = pageHtml();
  assert.ok(text.includes('窗口起点'));
  assert.ok(text.includes('2026-11-18T06:00:00Z') || text.includes('11-18 06:00'));
  const row = app.state.drawer.flagged_rows.find((r) => r.at_start);
  assert.equal(row.offline_decision.eligible, true);
  assert.equal(row.online_decision.eligible, false);
});

test('drawer on the empty entity explains the fill policy', async () => {
  await app.openSample('ACC-2059', 'spend_24h');
  const text = pageHtml();
  assert.ok(text.includes('缺失填充'));
  assert.ok(text.includes('窗口内没有输入记录'));
});

test('drawer on a key variant shows the raw key', async () => {
  await app.openSample('ACC-2056', 'spend_24h');
  const text = pageHtml();
  assert.ok(text.includes('acc-2056'), 'the raw key variant must be printed verbatim');
  assert.ok(app.state.drawer.raw_rows.every((r) => r.raw_key !== 'ACC-2056'));
});

test('repair view previews a scoped recompute', async () => {
  app.state.view = 'repair';
  app.render();
  const text = html();
  assert.ok(text.includes('修复与定向重算'));
  assert.ok(text.includes('仅重算受影响实体'));
});

test('release view renders the canary controls and version history', () => {
  app.state.view = 'release';
  app.render();
  const text = html();
  assert.ok(text.includes('发布与灰度'));
  assert.ok(text.includes('3.2.0'));
  assert.ok(text.includes('4.0.0'));
  assert.ok(text.includes('灰度'));
});

test('quality view lists late inputs and duplicate groups', () => {
  app.state.view = 'quality';
  app.render();
  const text = html();
  assert.ok(text.includes('迟到事件与重复计算'));
  assert.ok(text.includes('ACC-2043'));
  assert.ok(text.includes('ACC-2046'));
});

test('rendering is idempotent: a second render produces identical markup', () => {
  app.state.view = 'overview';
  app.render();
  const first = html();
  app.render();
  assert.equal(html(), first);
});
