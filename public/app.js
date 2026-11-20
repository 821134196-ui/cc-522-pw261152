// Console shell: navigation, data loading, and the views. Views are plain
// render functions over a single app state object; every mutation refetches
// /api/state so all panels agree on the same numbers.

import { h, clear } from './dom.js';
import {
  FEATURE_KEYS,
  featureMeta,
  registerCauses,
  causeLabel,
  causeTone,
  causeColor,
  formatNumber,
  formatFeature,
  formatDelta,
  formatPercent,
  formatClock,
  formatDateTime,
  severityLabel,
  severityIcon,
  checkIcon,
  checkStatusLabel,
  toneForStatus,
  reasonLabel,
  windowLabel,
  windowGeometry,
  scaleBar,
} from './format.js';

const state = {
  data: null,
  diffs: [],
  filters: { feature: '', cause: '', severity: '', release: '' },
  selection: null,
  drawer: null,
  view: 'overview',
  busy: false,
  repairSelection: new Set(),
  lastRepair: null,
  lastReleaseReport: null,
};

const root = document.getElementById('app');
const toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
document.body.append(toastEl);

let toastTimer = null;
function toast(message, { bad = false } = {}) {
  toastEl.textContent = message;
  toastEl.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.className = 'toast';
  }, 3600);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `${res.status} ${res.statusText}`);
  return payload;
}

async function refresh({ keepDrawer = true } = {}) {
  const [data, diffs] = await Promise.all([
    api('/api/state'),
    api(`/api/diffs${queryFor(state.filters)}`),
  ]);
  state.data = data;
  state.diffs = diffs.items;
  registerCauses(data.causes);
  if (!keepDrawer) closeDrawer();
  render();
}

function queryFor(filters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

async function mutate(fn, message) {
  if (state.busy) return;
  state.busy = true;
  document.body.style.cursor = 'progress';
  try {
    const result = await fn();
    await refresh();
    if (message) toast(typeof message === 'function' ? message(result) : message);
    return result;
  } catch (err) {
    toast(err.message, { bad: true });
    throw err;
  } finally {
    state.busy = false;
    document.body.style.cursor = '';
  }
}

// ------------------------------------------------------------------- layout

function render() {
  clear(root);
  root.append(
    h('div', { class: 'app' },
      sidebar(),
      h('main', { class: 'main' },
        topbar(),
        overviewView(),
        diffsView(),
        repairView(),
        releaseView(),
        qualityView(),
      ),
    ),
  );
  if (state.drawer) renderDrawer();
}

const NAV = [
  ['overview', '总览'],
  ['diffs', '差异样本'],
  ['repair', '修复与重算'],
  ['release', '发布与灰度'],
  ['quality', '迟到与重复'],
];

function sidebar() {
  const summary = state.data?.summary;
  const counts = {
    diffs: summary?.totals?.diffs ?? 0,
    release: summary?.release ? 1 : 0,
    quality: (summary?.quality?.late_rows ?? 0) + (summary?.quality?.duplicate_rows ?? 0),
  };
  return h('aside', { class: 'sidebar' },
    h('div', { class: 'brand' },
      h('div', { class: 'brand-mark', text: 'FC' }),
      h('div', {},
        h('h1', { text: '特征一致性' }),
        h('p', { text: 'Offline ⇄ Online' }),
      ),
    ),
    h('nav', { class: 'nav' },
      NAV.map(([key, label]) =>
        h('a', {
          href: `#${key}`,
          class: state.view === key ? 'active' : '',
          onClick: (e) => {
            e.preventDefault();
            state.view = key;
            history.replaceState(null, '', `#${key}`);
            render();
            document.getElementById(key)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          },
        }, h('span', { text: label }),
          counts[key] ? h('span', { class: 'count', text: String(counts[key]) }) : null),
      ),
    ),
    h('div', { class: 'sidebar-foot' },
      h('div', { text: `离线 as_of ${formatClock(state.data?.as_of)}` }),
      h('div', { text: `在线 serve ${formatClock(state.data?.serve_time)}` }),
      h('div', {},
        h('code', { text: `v${state.data?.active_version ?? '—'}` }),
        state.data?.summary?.release
          ? h('span', { text: ` · 灰度 ${state.data.summary.release.version} ${state.data.summary.release.percent}%` })
          : null,
      ),
      h('button', {
        class: 'sm',
        onClick: () => mutate(() => api('/api/reset', { method: 'POST' }), '已重置到基线'),
        title: '清空修复记录、发布与重算历史，回到初始基线',
      }, '重置演示数据'),
    ),
  );
}

function topbar() {
  const summary = state.data?.summary;
  const totals = summary?.totals || {};
  const release = summary?.release;
  return h('header', { class: 'topbar' },
    h('div', {},
      h('h2', { text: NAV.find(([k]) => k === state.view)?.[1] || '总览' }),
      h('div', { class: 'sub' },
        h('span', {}, '特征 ', h('b', { text: '5' }), ' · 实体 ', h('b', { text: String(totals.entities ?? '—') })),
        h('span', {}, '比对 ', h('b', { text: String(totals.features_compared ?? '—') }), ' 个特征值'),
        h('span', {}, '窗口 as_of ', h('code', { text: formatClock(state.data?.as_of) })),
      ),
    ),
    h('div', { class: 'topbar-actions' },
      release
        ? h('span', { class: 'chip canary' }, h('span', { class: 'dot' }), `${release.version} · ${release.percent}%`)
        : h('span', { class: 'chip good' }, h('span', { class: 'dot' }), `全量 ${state.data?.active_version ?? ''}`),
      h('button', {
        onClick: () => toggleTheme(),
        title: '切换明暗主题',
        'aria-label': '切换主题',
      }, themeIcon()),
      h('button', {
        onClick: () => mutate(() => api('/api/validate', { method: 'POST' }), (r) => `验证完成：${checkStatusLabel(r.status)}`),
      }, '运行一致性验证'),
      h('button', {
        class: 'primary',
        onClick: () => {
          state.view = 'diffs';
          render();
          document.getElementById('diffs')?.scrollIntoView({ behavior: 'smooth' });
        },
      }, '查看差异样本'),
    ),
  );
}

function themeIcon() {
  return document.documentElement.dataset.theme === 'dark' ? '☀' : '☾';
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme;
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('fcx-theme', next);
  render();
}

// ----------------------------------------------------------------- overview

function section(id, title, sub, ...children) {
  return h('section', { class: 'section', id },
    h('div', { class: 'section-head' },
      h('h3', { text: title }),
      sub ? h('p', { text: sub }) : null,
    ),
    ...children,
  );
}

function overviewView() {
  const s = state.data?.summary;
  const totals = s?.totals || {};
  return section('overview', '一致性总览', '离线批处理 vs 在线服务，按 as_of 同一时间切片比对',
    h('div', { class: 'kpis' },
      kpi('实体一致率', formatPercent(totals.consistency, 1),
        `${totals.entities_with_diffs ?? 0} / ${totals.entities ?? 0} 个实体存在差异`,
        (totals.consistency ?? 0) >= 0.9 ? 'pos' : ''),
      kpi('差异特征值', formatNumber(totals.diffs ?? 0, 0),
        `覆盖 ${featureCount()} / 5 个特征 · ${totals.by_severity?.high ?? 0} 项高严重度`),
      kpi('迟到事件', formatNumber(s?.quality?.late_rows ?? 0, 0),
        `${s?.quality?.late_entities?.length ?? 0} 个实体 · 水位 ${formatClock(s?.quality?.watermark)}`),
      kpi('重复计算', formatNumber(s?.quality?.duplicate_rows ?? 0, 0),
        `${s?.quality?.duplicate_entities?.length ?? 0} 个实体命中重复组`),
      kpi('灰度范围', s?.release ? `${s.release.percent}%` : '0%',
        s?.release ? `${s.release.version} · ${totals.canary_entities ?? 0} 个实体` : '当前无进行中的发布'),
    ),
    h('div', { class: 'grid-2', style: { 'margin-top': '12px' } },
      causeCard(s),
      h('div', { class: 'card chart-card', style: { padding: '16px' } }, timelineCard(s)),
    ),
    h('div', { class: 'grid-2', style: { 'margin-top': '12px' } },
      featureCard(s),
      entityCard(s),
    ),
  );
}

function kpi(label, value, meta, metaClass = '') {
  return h('div', { class: 'card kpi' },
    h('div', { class: 'label', text: label }),
    h('div', { class: 'value', text: value }),
    h('div', { class: `meta ${metaClass}`, text: meta }),
  );
}

function featureCount() {
  return new Set((state.data?.summary?.features || []).filter((f) => f.count > 0).map((f) => f.feature_key)).size;
}

function bars(rows, { colorFor, labelWidth = '116px' } = {}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return h('div', { class: 'bars' },
    rows.map((row) =>
      h('div', {
        class: 'bar-row',
        title: `${row.label}: ${row.value}${row.meta ? ` · ${row.meta}` : ''}`,
        style: { 'grid-template-columns': `${labelWidth} minmax(0,1fr) 54px` },
      },
        h('span', { class: 'name', text: row.label }),
        h('span', { class: 'bar-track', role: 'img', 'aria-label': `${row.label} ${row.value}` },
          h('span', {
            class: 'bar-fill',
            style: { width: `${scaleBar(row.value, max) * 100}%`, background: colorFor ? colorFor(row) : 'var(--series-1)' },
          }),
        ),
        h('span', { class: 'num', text: String(row.value) }),
      ),
    ),
  );
}

function causeCard(s) {
  const causes = s?.causes || [];
  const rows = causes.map((c) => ({
    key: c.cause,
    label: causeLabel(c.cause),
    value: c.count,
    meta: Object.entries(c.features).map(([f, n]) => `${featureMeta(f).label} ${n}`).join('，'),
  }));
  return h('div', { class: 'card', style: { padding: '16px' } },
    h('p', { class: 'chart-title', text: '差异原因分布' }),
    h('p', { class: 'chart-note', text: '每个差异特征值只归因到一个主要原因（反事实修复后差异下降最多者）' }),
    rows.length
      ? bars(rows, { colorFor: (row) => causeColor(row.key), labelWidth: '104px' })
      : h('div', { class: 'empty', text: '当前没有差异' }),
    h('div', { class: 'legend' },
      rows.map((row) => h('span', { class: 'item' },
        h('span', { class: 'swatch', style: { background: causeColor(row.key) } }),
        h('span', { text: causeLabel(row.key) }),
      )),
    ),
  );
}

function featureCard(s) {
  const features = s?.features || [];
  const rows = features.map((f) => ({
    key: f.feature_key,
    label: featureMeta(f.feature_key).label,
    value: f.count,
    meta: `${f.entities} 个实体 · ${f.high} 项高严重度`,
  }));
  return h('div', { class: 'card', style: { padding: '16px' } },
    h('p', { class: 'chart-title', text: '按特征分布' }),
    h('p', { class: 'chart-note', text: '差异定位到具体特征，点击下方样本可下钻到输入记录' }),
    bars(rows, { labelWidth: '88px' }),
  );
}

function entityCard(s) {
  const entities = (s?.entities || []).slice(0, 8);
  return h('div', { class: 'card', style: { padding: '16px' } },
    h('div', { class: 'section-head', style: { 'margin-bottom': '4px' } },
      h('p', { class: 'chart-title', text: '差异实体 Top 8' }),
      h('span', { class: 'spacer' }),
      h('small', { class: 'muted', text: `共 ${s?.entities?.length ?? 0} 个` }),
    ),
    h('p', { class: 'chart-note', text: '按差异特征数排序，点行查看样本' }),
    h('div', { class: 'table-wrap', style: { 'max-height': '280px' } },
      h('table', { class: 'data' },
        h('thead', {}, h('tr', {},
          h('th', { text: '实体' }), h('th', { text: '版本' }),
          h('th', { style: { 'text-align': 'right' }, text: '差异数' }), h('th', { text: '主要原因' }),
        )),
        h('tbody', {},
          entities.map((e) => h('tr', {
            onClick: () => openEntity(e.entity_key),
          },
            h('td', { class: 'mono', text: e.entity_key }),
            h('td', {},
              e.cohort?.inCanary
                ? h('span', { class: 'chip canary' }, h('span', { class: 'dot' }), e.cohort.version)
                : h('span', { class: 'muted', text: state.data.active_version }),
            ),
            h('td', { class: 'num', text: String(e.count) }),
            h('td', {}, e.causes.slice(0, 2).map((c) => causeChip(c))),
          )),
          entities.length === 0 ? h('tr', { class: 'no-hover' }, h('td', { colspan: 4, class: 'empty', text: '没有差异实体' })) : null,
        ),
      ),
    ),
  );
}

function timelineCard(s) {
  const events = s?.events || [];
  return h('div', {},
    h('p', { class: 'chart-title', text: '验证与发布状态' }),
    h('p', { class: 'chart-note', text: '工作台事件流：基线、修复、验证、灰度与回滚' }),
    events.length
      ? h('div', { class: 'timeline' },
          events.map((e) => h('div', { class: 'tl-item' },
            h('span', { class: `tl-dot ${toneForStatus(statusForEvent(e.kind, e.detail))}` }),
            h('div', { class: 'tl-body' },
              h('div', { class: 'tl-title', text: e.title }),
              h('div', { class: 'tl-meta', text: formatDateTime(e.at) }),
              e.kind === 'validation' && e.detail?.checks
                ? h('div', { class: 'tl-detail' },
                    h('span', { text: e.detail.checks.map((c) => `${checkIcon(c.status)} ${c.label}`).join(' · ') }))
                : null,
            ),
          )),
        )
      : h('div', { class: 'empty', text: '暂无事件' }),
  );
}

function statusForEvent(kind, detail) {
  if (kind === 'validation') return detail?.status || 'pass';
  if (kind === 'rollback') return 'critical';
  if (kind === 'repair') return 'info';
  if (kind === 'release') return 'warning';
  return 'info';
}

// -------------------------------------------------------------------- diffs

function diffsView() {
  const releases = state.data?.releases || [];
  const causes = Object.keys(state.data?.causes || {});
  const items = state.diffs;
  return section('diffs', '差异样本', `共 ${state.data?.summary?.totals?.diffs ?? 0} 项差异，已筛选 ${items.length} 项`,
    h('div', { class: 'card', style: { overflow: 'hidden' } },
      h('div', { class: 'toolbar' },
        h('span', { class: 'lbl', text: '特征' }),
        selectControl('feature', [['', '全部'], ...FEATURE_KEYS.map((k) => [k, featureMeta(k).label])]),
        h('span', { class: 'lbl', text: '原因' }),
        selectControl('cause', [['', '全部'], ...causes.map((c) => [c, causeLabel(c)])]),
        h('span', { class: 'lbl', text: '严重度' }),
        h('div', { class: 'pill-group' },
          [['', '全部'], ['high', '高'], ['medium', '中'], ['low', '低']].map(([value, label]) =>
            h('button', {
              class: state.filters.severity === value ? 'on' : '',
              onClick: () => { state.filters.severity = value; refresh(); },
            }, label),
          ),
        ),
        releases.length
          ? h('div', { class: 'pill-group', style: { 'margin-left': '4px' } },
              [['', '全部'], ['canary', '灰度内'], ['outside', '灰度外']].map(([value, label]) =>
                h('button', {
                  class: state.filters.release === value ? 'on' : '',
                  onClick: () => { state.filters.release = value; refresh(); },
                }, label),
              ),
            )
          : null,
        h('span', { class: 'spacer' }),
        h('button', {
          class: 'sm',
          onClick: () => openRepairWith(
            [...new Set(items.map((i) => i.primary_cause))],
            [...new Set(items.map((i) => i.entity_key))],
          ),
          disabled: items.length === 0,
        }, '修复当前筛选'),
      ),
      h('div', { class: 'table-wrap', style: { 'max-height': '620px' } },
        diffsTable(items),
      ),
    ),
  );
}

function selectControl(key, options) {
  return h('select', {
    onChange: (e) => { state.filters[key] = e.target.value; refresh(); },
  }, options.map(([value, label]) => h('option', { value, selected: state.filters[key] === value }, label)));
}

function diffsTable(items) {
  if (!items.length) return h('div', { class: 'empty', text: '没有匹配的差异样本' });
  return h('table', { class: 'data' },
    h('thead', {}, h('tr', {},
      h('th', { text: '实体' }),
      h('th', { text: '版本' }),
      h('th', { text: '特征' }),
      h('th', { style: { 'text-align': 'right' }, text: '离线值' }),
      h('th', { style: { 'text-align': 'right' }, text: '在线值' }),
      h('th', { style: { 'text-align': 'right' }, text: '差值' }),
      h('th', { text: '严重度' }),
      h('th', { text: '主要原因' }),
    )),
    h('tbody', {},
      items.map((item) => h('tr', {
        class: state.selection?.entity_key === item.entity_key && state.selection?.feature_key === item.feature_key ? 'selected' : '',
        onClick: () => openSample(item.entity_key, item.feature_key),
      },
        h('td', { class: 'mono', text: item.entity_key }),
        h('td', {}, versionCell(item)),
        h('td', {}, h('span', { text: featureMeta(item.feature_key).label }),
          h('div', { class: 'mono muted', style: { 'font-size': '10.5px' }, text: item.feature_key })),
        h('td', { class: 'num', text: formatFeature(item.feature_key, item.offline_value) }),
        h('td', { class: 'num', text: formatFeature(item.feature_key, item.online_value) }),
        h('td', { class: 'num', text: formatDelta(item.feature_key, item.delta) }),
        h('td', {}, h('span', { class: `sev ${item.severity}` },
          h('span', { class: 'ico', text: severityIcon(item.severity) }), severityLabel(item.severity))),
        h('td', {}, item.causes.slice(0, 2).map((c) => causeChip(c)),
          item.causes.length > 2 ? h('span', { class: 'muted', text: ` +${item.causes.length - 2}` }) : null),
      )),
    ),
  );
}

function versionCell(item) {
  if (item.cohort?.inCanary) {
    return h('span', { class: 'chip canary' }, h('span', { class: 'dot' }), `${item.cohort.version} 灰度`);
  }
  return h('span', { class: 'muted', style: { 'font-size': '11.5px' }, text: state.data.active_version });
}

function causeChip(cause) {
  return h('span', { class: `chip ${causeTone(cause)}` },
    h('span', { class: 'dot' }),
    h('span', { text: causeLabel(cause) }),
  );
}

// ------------------------------------------------------------------- repair

function repairView() {
  const causes = state.data?.summary?.causes || [];
  const lastRepair = state.lastRepair || (state.data?.repairs || [])[0] || null;
  const selected = state.repairSelection;
  return section('repair', '修复与定向重算', '选择原因 → 应用口径修复 → 仅重算受影响实体',
    h('div', { class: 'grid-2' },
      h('div', { class: 'card panel' },
        h('p', { class: 'chart-title', text: '1. 选择要修复的原因' }),
        h('p', { class: 'chart-note', text: '每个原因带有确定性的口径预设，修复两侧配置后只重算被归因到的实体' }),
        h('div', { class: 'option-list' },
          causes.map((c) => {
            const on = selected.has(c.cause);
            const affected = state.data?.summary?.entities?.filter((e) => e.causes.includes(c.cause)).length ?? 0;
            return h('label', { class: `option ${on ? 'on' : ''}` },
              h('input', {
                type: 'checkbox',
                checked: on,
                onChange: (e) => {
                  if (e.target.checked) selected.add(c.cause);
                  else selected.delete(c.cause);
                  render();
                },
              }),
              h('div', {},
                h('div', { class: 't', text: causeLabel(c.cause) }),
                h('div', { class: 'd', text: state.data.causes[c.cause]?.summary || '' }),
              ),
              h('div', { class: 'n', text: `${c.count} 项 / ${affected} 实体` }),
            );
          }),
          causes.length === 0 ? h('div', { class: 'empty', text: '没有可修复的差异' }) : null,
        ),
        h('div', { class: 'field-row', style: { 'margin-top': '14px' } },
          h('button', {
            class: 'primary',
            disabled: selected.size === 0,
            onClick: () => runRepair(),
          }, '应用修复并仅重算受影响实体'),
          h('button', {
            disabled: selected.size === 0,
            onClick: () => previewRepair(),
          }, '预览影响范围'),
          h('button', {
            disabled: selected.size === 0,
            onClick: () => { selected.clear(); render(); },
          }, '清空选择'),
        ),
      ),
      h('div', { class: 'card panel' },
        h('p', { class: 'chart-title', text: '2. 重算范围' }),
        h('p', { class: 'chart-note', text: '只重算受影响实体，其余实体沿用已物化的特征向量（reused）' }),
        repairScopePanel(selected),
        lastRepair ? repairReport(lastRepair) : h('div', { class: 'empty', text: '尚无修复记录' }),
      ),
    ),
  );
}

function repairScopePanel(selected) {
  const entities = state.data?.summary?.entities || [];
  const scoped = entities.filter((e) => e.causes.some((c) => selected.has(c)));
  const total = state.data?.summary?.totals?.entities ?? 0;
  return h('div', {},
    h('div', { class: 'stat-row', style: { 'margin-bottom': '10px' } },
      h('span', {}, '受影响实体 ', h('b', { text: String(scoped.length) })),
      h('span', {}, '复用实体 ', h('b', { text: String(total - scoped.length) })),
      h('span', {}, '修复预设 ', h('b', { text: String(selected.size) })),
    ),
    h('div', { class: 'cohort-wrap' },
      scoped.length
        ? scoped.map((e) => h('span', {
            class: 'cohort-chip',
            title: e.causes.map(causeLabel).join(' / '),
            text: e.entity_key,
            onClick: () => openEntity(e.entity_key),
            style: { cursor: 'pointer' },
          }))
        : h('span', { class: 'muted', text: '勾选原因后显示受影响实体' }),
    ),
  );
}

async function previewRepair() {
  const plan = await api('/api/repairs/plan', {
    method: 'POST',
    body: { causes: [...state.repairSelection] },
  });
  toast(`将修复 ${plan.affected_entities.length} 个实体：${plan.affected_entities.slice(0, 6).join(', ')}${plan.affected_entities.length > 6 ? '…' : ''}`);
}

async function runRepair() {
  const causes = [...state.repairSelection];
  const result = await mutate(
    () => api('/api/repairs', { method: 'POST', body: { causes } }),
    null,
  );
  state.lastRepair = {
    id: result.repair_id,
    causes: result.plan.causes,
    presets: result.plan.presets,
    report: {
      before: result.before,
      after: result.after,
      idempotent: result.job.idempotent,
      duration_ms: result.job.duration_ms,
      repaired_entities: result.plan.affected_entities,
    },
    scope: {
      entities: result.plan.affected_entities,
      side_effect: result.plan.side_effect_entities,
      reused: result.job.reused,
      recomputed: result.job.recomputed,
    },
    created_at: result.job.at,
  };
  state.repairSelection.clear();
  await refresh();
  toast(
    result.job.recomputed.length === 0
      ? `该原因已无可修复差异（当前 ${result.after.diffs} 项）`
      : `已重算 ${result.job.recomputed.length} 个实体，差异 ${result.before.diffs} → ${result.after.diffs}`,
  );
}

function repairReport(repair) {
  const report = repair.report;
  const before = report.before;
  const after = report.after;
  const reduced = before.diffs - after.diffs;
  return h('div', { class: 'report', style: { 'margin-top': '14px' } },
    h('div', { class: 'callout good' },
      h('b', { text: '修复已完成' }),
      ` · ${(repair.causes || []).map(causeLabel).join(' / ')} · ${formatDateTime(repair.created_at)}`,
    ),
    h('div', { class: 'report' },
      h('div', { class: 'line' },
        h('span', { class: 'k', text: '差异项' }),
        h('span', { text: `${before.diffs} → ${after.diffs}` }),
        h('span', { class: reduced >= 0 ? 'delta-good' : 'delta-bad', text: reduced >= 0 ? `减少 ${reduced}` : `增加 ${-reduced}` }),
      ),
      h('div', { class: 'line' },
        h('span', { class: 'k', text: '差异实体' }),
        h('span', { text: `${before.entities_with_diffs} → ${after.entities_with_diffs}` }),
      ),
      h('div', { class: 'line' },
        h('span', { class: 'k', text: '重算范围' }),
        h('span', { text: `${(repair.scope?.recomputed || []).length} 个重算 · ${repair.scope?.reused ?? 0} 个复用` }),
      ),
      repair.scope?.side_effect?.length
        ? h('div', { class: 'line' },
            h('span', { class: 'k', text: '连带重算' }),
            h('span', { text: `${repair.scope.side_effect.length} 个实体受连带影响：${repair.scope.side_effect.join('、')}` }),
          )
        : null,
      h('div', { class: 'line' },
        h('span', { class: 'k', text: '重复计算幂等' }),
        h('span', { class: report.idempotent ? 'delta-good' : 'delta-bad', text: report.idempotent ? '是（二次重算摘要一致）' : '否' }),
      ),
      h('div', { class: 'line' },
        h('span', { class: 'k', text: '耗时' }),
        h('span', { text: `${report.duration_ms} ms` }),
      ),
      h('div', { class: 'line' },
        h('span', { class: 'k', text: '预设' }),
        h('span', {}, (repair.presets || []).map((p) => h('span', { class: 'chip plain', text: state.data.presets?.[p]?.label || p }))),
      ),
    ),
    h('div', { class: 'cohort-wrap', style: { 'margin-top': '8px' } },
      (repair.scope?.recomputed || []).map((k) => h('span', { class: 'cohort-chip', text: k })),
    ),
  );
}

// ------------------------------------------------------------------ release

function releaseView() {
  const releases = state.data?.releases || [];
  const current = state.data?.summary?.release;
  const validation = state.lastReleaseReport || state.data?.validation;
  const versions = Object.entries(state.data?.bundles || {}).filter(([v]) => v !== state.data.active_version);
  return section('release', '发布与灰度', '新版本灰度发布、验证与回滚；灰度按实体哈希分桶，保证同实体稳定命中',
    h('div', { class: 'grid-2' },
      h('div', { class: 'card panel' },
        h('p', { class: 'chart-title', text: current ? '进行中的发布' : '创建灰度发布' }),
        current
          ? currentReleasePanel(current, validation)
          : createReleaseForm(versions),
        h('div', { style: { 'margin-top': '16px' } },
          h('p', { class: 'chart-title', text: '版本历史' }),
          releaseHistory(releases),
        ),
      ),
      h('div', { class: 'card panel' },
        h('p', { class: 'chart-title', text: '验证结果' }),
        validation ? validationPanel(validation) : h('div', { class: 'empty', text: '尚无验证结果，创建发布或运行一致性验证' }),
        state.data?.summary?.totals
          ? h('div', { class: 'stat-row', style: { 'margin-top': '14px' } },
              h('span', {}, '全量差异 ', h('b', { text: String(state.data.summary.totals.diffs) })),
              h('span', {}, '灰度内实体 ', h('b', { text: String(state.data.summary.totals.canary_entities) })),
              h('span', {}, '一致率 ', h('b', { text: formatPercent(state.data.summary.totals.consistency, 1) })),
            )
          : null,
      ),
    ),
  );
}

function createReleaseForm(versions) {
  const select = h('select', {},
    versions.map(([version, meta]) =>
      h('option', { value: version }, `${version} — ${meta.notes}`)),
  );
  const percent = h('input', { type: 'number', min: '0', max: '100', step: '5', value: '20' });
  return h('div', {},
    h('p', { class: 'chart-note', text: '灰度只重算进入桶的实体，其余实体保持在产版本，可随时回滚' }),
    h('div', { class: 'field-row' },
      h('label', { class: 'field' }, h('span', { text: '目标版本' }), select),
      h('label', { class: 'field' }, h('span', { text: '灰度比例 %' }), percent),
      h('button', {
        class: 'primary',
        onClick: () => mutate(
          () => api('/api/releases', { method: 'POST', body: { version: select.value, percent: Number(percent.value) } }),
          (r) => `已创建 ${r.release.version} 灰度 ${r.release.percent}%`,
        ),
      }, '创建灰度'),
    ),
    h('div', { class: 'callout', style: { 'margin-top': '12px' } },
      h('b', { text: '示例：' }),
      '4.0.0 为口径变更（风险分 ±0.10 的声明影响面），验证应通过；4.1.0 权重录错，验证应失败并可一键回滚。'),
  );
}

function currentReleasePanel(release, validation) {
  const cohort = state.data?.cohort || [];
  const totals = state.data?.summary?.totals || {};
  const bump = h('input', { type: 'number', min: '0', max: '100', step: '5', value: String(Math.min(100, release.percent + 20)) });
  return h('div', { class: 'release-card' },
    h('div', { class: 'stat-row' },
      h('span', {}, '版本 ', h('b', { text: release.version })),
      h('span', {}, '灰度 ', h('b', { text: `${release.percent}%` })),
      h('span', {}, '实体 ', h('b', { text: String(totals.canary_entities ?? cohort.length) })),
      h('span', {}, '状态 ', h('b', { text: release.status })),
    ),
    h('div', { class: 'progress' }, h('div', { style: { width: `${release.percent}%` } })),
    h('div', { class: 'field-row' },
      h('label', { class: 'field' }, h('span', { text: '放量到 %' }), bump),
      h('button', {
        onClick: () => mutate(
          () => api(`/api/releases/${release.id}/ramp`, { method: 'POST', body: { percent: Number(bump.value) } }),
          (r) => `已放量到 ${r.release.percent}%，新增重算 ${r.job.recomputed.length} 个实体`,
        ),
      }, '放量'),
      h('button', {
        class: 'primary',
        onClick: () => mutate(
          () => api(`/api/releases/${release.id}/validate`, { method: 'POST' }),
          (r) => `验证：${checkStatusLabel(r.status)}`,
        ).then((r) => {
          state.lastReleaseReport = r;
          render();
        }).catch(() => {}),
      }, '验证灰度'),
      h('button', {
        class: 'danger',
        onClick: () => mutate(
          () => api(`/api/releases/${release.id}/rollback`, { method: 'POST', body: { reason: '一致性验证未通过' } }),
          (r) => `已回滚到 ${state.data.active_version}，重算 ${r.job.recomputed.length} 个实体`,
        ),
      }, '回滚'),
    ),
    h('div', {},
      h('p', { class: 'chart-note', style: { 'margin-bottom': '6px' }, text: `灰度桶（salt: ${release.salt}，按实体稳定哈希）` }),
      h('div', { class: 'cohort-wrap' },
        cohort.map((c) => h('span', { class: 'cohort-chip', title: `bucket ${c.bucket}`, text: c.entity_key })),
      ),
    ),
  );
}

function releaseHistory(releases) {
  if (!releases.length) return h('div', { class: 'empty', text: '尚无发布记录' });
  return h('div', { class: 'timeline' },
    releases.map((r) => h('div', { class: 'tl-item' },
      h('span', { class: `tl-dot ${r.status === 'rolled_back' ? 'critical' : r.status === 'full' ? 'good' : 'warning'}` }),
      h('div', { class: 'tl-body' },
        h('div', { class: 'tl-title' },
          `${r.version} · ${r.percent}% · `,
          h('span', { class: `chip ${r.status === 'rolled_back' ? 'critical' : r.status === 'full' ? 'good' : 'warning'}` },
            h('span', { class: 'dot' }), r.status),
        ),
        h('div', { class: 'tl-meta', text: formatDateTime(r.updated_at) }),
        r.note ? h('div', { class: 'tl-detail', text: r.note }) : null,
      ),
    )),
  );
}

function validationPanel(validation) {
  return h('div', {},
    h('div', { class: `callout ${validation.status === 'pass' ? 'good' : validation.status === 'fail' ? 'bad' : 'warn'}`, style: { 'margin-bottom': '10px' } },
      h('b', { text: validation.status === 'pass' ? '验证通过' : validation.status === 'fail' ? '验证失败' : '验证有警告' }),
      validation.version ? ` · ${validation.label || `灰度 ${validation.version} @ ${validation.percent}%`}` : '',
      ` · ${formatDateTime(validation.at)}`,
    ),
    h('div', { class: 'check-list' },
      (validation.checks || []).map((c) => h('div', { class: `check ${c.status}` },
        h('span', { class: 'ico', text: checkIcon(c.status) }),
        h('div', {},
          h('div', { class: 't' },
            h('span', { text: c.label }),
            h('span', { class: `chip ${toneForStatus(c.status)}` }, h('span', { class: 'dot' }), checkStatusLabel(c.status)),
          ),
          h('div', { class: 'd', text: c.detail }),
        ),
      )),
    ),
    validation.unexplained?.length
      ? h('div', { class: 'cohort-wrap', style: { 'margin-top': '10px' } },
          validation.unexplained.map((k) => h('span', { class: 'cohort-chip', text: k, style: { borderColor: 'var(--status-critical)' } })))
      : null,
  );
}

// ------------------------------------------------------------------ quality

function qualityView() {
  const q = state.data?.quality || { late: [], duplicates: [] };
  return section('quality', '迟到事件与重复计算', '数据质量清单：哪些输入记录导致了不一致，以及离线/在线各自如何处理',
    h('div', { class: 'grid-2' },
      h('div', { class: 'card', style: { overflow: 'hidden' } },
        h('div', { class: 'panel' },
          h('p', { class: 'chart-title', text: `迟到事件 · ${q.late?.length ?? 0} 行` }),
          h('p', { class: 'chart-note', text: `离线批次水位 ${formatClock(q.watermark)}，晚于水位摄取的事件离线不可见` }),
          h('div', { class: 'stat-row' },
            h('span', {}, '实体 ', h('b', { text: String(q.late_entities?.length ?? 0) })),
            h('span', {}, '离线水位 ', h('b', { class: 'mono', style: { 'font-size': '11px' }, text: formatClock(q.watermark) })),
            h('span', {}, '在线 serve ', h('b', { class: 'mono', style: { 'font-size': '11px' }, text: formatClock(state.data?.serve_time) })),
          ),
        ),
        h('div', { class: 'table-wrap', style: { 'max-height': '360px' } },
          h('table', { class: 'data' },
            h('thead', {}, h('tr', {},
              h('th', { text: '实体' }), h('th', { text: '事件' }),
              h('th', { text: '发生时间' }), h('th', { text: '摄取时间' }), h('th', { style: { 'text-align': 'right' }, text: '晚于水位' }),
            )),
            h('tbody', {},
              (q.late || []).map((r) => h('tr', { onClick: () => openEntity(r.entity_key) },
                h('td', { class: 'mono', text: r.entity_key }),
                h('td', { class: 'mono', text: r.event_id }),
                h('td', { class: 'mono', text: formatClock(r.occurred_at) }),
                h('td', { class: 'mono', text: formatClock(r.ingested_at) }),
                h('td', { class: 'num', text: `+${r.minutes_late} 分` }),
              )),
              (q.late || []).length === 0 ? h('tr', { class: 'no-hover' }, h('td', { colspan: 5, class: 'empty', text: '没有迟到事件' })) : null,
            ),
          ),
        ),
      ),
      h('div', { class: 'card', style: { overflow: 'hidden' } },
        h('div', { class: 'panel' },
          h('p', { class: 'chart-title', text: `重复计算 · ${q.duplicates?.length ?? 0} 组` }),
          h('p', { class: 'chart-note', text: '同一 event_id 多次投递且载荷被修正；两侧去重键不同导致结果分叉' }),
          h('div', { class: 'stat-row' },
            h('span', {}, '实体 ', h('b', { text: String(q.duplicate_entities?.length ?? 0) })),
            h('span', {}, '离线键 ', h('b', { class: 'mono', style: { 'font-size': '11px' }, text: q.policy?.offline_dedupe ?? '—' })),
            h('span', {}, '在线键 ', h('b', { class: 'mono', style: { 'font-size': '11px' }, text: q.policy?.online_dedupe ?? '—' })),
          ),
        ),
        h('div', { class: 'table-wrap', style: { 'max-height': '360px' } },
          h('table', { class: 'data' },
            h('thead', {}, h('tr', {},
              h('th', { text: '实体' }), h('th', { text: 'event_id' }),
              h('th', { text: '投递行' }), h('th', { text: '离线 / 在线' }),
            )),
            h('tbody', {},
              (q.duplicates || []).map((d) => h('tr', { onClick: () => openEntity(d.entity_key) },
                h('td', { class: 'mono', text: d.entity_key }),
                h('td', { class: 'mono', text: d.event_id }),
                h('td', { class: 'mono', text: d.rows.map((r) => `¥${r.amount}`).join(' / ') }),
                h('td', { style: { 'font-size': '11.5px', color: 'var(--text-secondary)' }, text: `${d.offline_effect}；${d.online_effect}` }),
              )),
              (q.duplicates || []).length === 0 ? h('tr', { class: 'no-hover' }, h('td', { colspan: 4, class: 'empty', text: '没有重复事件' })) : null,
            ),
          ),
        ),
      ),
    ),
    h('div', { class: 'grid-2', style: { 'margin-top': '12px' } },
      h('div', { class: 'card panel' },
        h('p', { class: 'chart-title', text: '重算作业历史' }),
        h('p', { class: 'chart-note', text: '每次修复/发布只重算作用域内实体，reused 表示沿用物化结果的实体数' }),
        jobTable(state.data?.jobs || []),
      ),
      h('div', { class: 'card panel' },
        h('p', { class: 'chart-title', text: '当前口径配置' }),
        h('p', { class: 'chart-note', text: '离线与在线逐项对照；红色为该侧造成差异的配置' }),
        configTable(state.data?.summary?.configs),
      ),
    ),
  );
}

function jobTable(jobs) {
  if (!jobs.length) return h('div', { class: 'empty', text: '尚无重算作业' });
  return h('div', { class: 'table-wrap', style: { 'max-height': '340px' } },
    h('table', { class: 'data' },
      h('thead', {}, h('tr', {},
        h('th', { text: '时间' }), h('th', { text: '触发' }),
        h('th', { style: { 'text-align': 'right' }, text: '重算' }),
        h('th', { style: { 'text-align': 'right' }, text: '复用' }),
        h('th', { text: '幂等' }), h('th', { text: '范围外校验' }),
        h('th', { style: { 'text-align': 'right' }, text: '耗时' }),
      )),
      h('tbody', {},
        jobs.map((j) => h('tr', { class: 'no-hover' },
          h('td', { class: 'mono', text: formatDateTime(j.at) }),
          h('td', {}, h('span', { class: 'chip plain', text: j.trigger })),
          h('td', { class: 'num', text: String(j.recomputed.length) }),
          h('td', { class: 'num', text: String(j.reused) }),
          h('td', {}, j.idempotent
            ? h('span', { class: 'chip good' }, h('span', { class: 'dot' }), '是')
            : h('span', { class: 'muted', text: '—' })),
          h('td', {},
            j.verified?.drifted?.length
              ? h('span', { class: 'chip critical' }, h('span', { class: 'dot' }), `漂移 ${j.verified.drifted.length}`)
              : h('span', { class: 'chip good' }, h('span', { class: 'dot' }), `一致 ${j.verified?.checked ?? 0}`)),
          h('td', { class: 'num', text: `${j.duration_ms} ms` }),
        )),
      ),
    ),
  );
}

const CONFIG_ROWS = [
  ['bundle_version', '版本'],
  ['window', '时间窗口'],
  ['dedupe_key', '去重键'],
  ['key_normalize', '键规范化'],
  ['watermark', '水位策略'],
  ['batch_lag_minutes', '批次滞后(分)'],
  ['dim_join', '维表连接'],
  ['fx_missing', '汇率缺失'],
  ['null_amount', '空金额'],
  ['fill_missing', '无样本填充'],
];

function configTable(configs) {
  if (!configs) return h('div', { class: 'empty', text: '—' });
  const off = normalizeConfig(configs.offline);
  const on = normalizeConfig(configs.online);
  return h('div', { class: 'config-grid' },
    h('div', { class: 'h', text: '配置项' }),
    h('div', { class: 'h', text: '离线批处理' }),
    h('div', { class: 'h', text: '在线服务' }),
    CONFIG_ROWS.map(([key, label]) => {
      const a = off[key];
      const b = on[key];
      const same = JSON.stringify(a) === JSON.stringify(b);
      return [
        h('div', { class: 'k', text: label }),
        h('div', { class: `v ${same ? 'same' : 'diff'}`, text: String(a) }),
        h('div', { class: `v ${same ? 'same' : 'diff'}`, text: String(b) }),
      ];
    }),
  );
}

function normalizeConfig(cfg) {
  return {
    bundle_version: cfg.bundle_version,
    window: windowLabel({ start_inclusive: cfg.window_start_inclusive, end_inclusive: cfg.window_end_inclusive }),
    dedupe_key: cfg.dedupe_key,
    key_normalize: cfg.key_normalize,
    watermark: cfg.watermark === 'current' ? '实时' : `批次 -${cfg.batch_lag_minutes}m`,
    batch_lag_minutes: cfg.batch_lag_minutes,
    dim_join: cfg.dim_join,
    fx_missing: cfg.fx_missing,
    null_amount: cfg.null_amount,
    fill_missing: cfg.fill_missing,
  };
}

// ------------------------------------------------------------------- drawer

function openDrawer(sample) {
  state.drawer = sample;
  renderDrawer();
}

function closeDrawer() {
  state.drawer = null;
  document.querySelectorAll('.drawer, .drawer-backdrop').forEach((n) => n.remove());
}

function renderDrawer() {
  document.querySelectorAll('.drawer, .drawer-backdrop').forEach((n) => n.remove());
  const sample = state.drawer;
  if (!sample) return;
  const backdrop = h('div', { class: 'drawer-backdrop open', onClick: closeDrawer });
  const drawer = h('div', { class: 'drawer open', role: 'dialog', 'aria-modal': 'true', 'aria-label': '差异样本详情' },
    h('div', { class: 'drawer-head' },
      h('div', {},
        h('h3', { text: `${sample.entity_key} · ${sample.feature.label}` }),
        h('div', { class: 'sub' },
          h('span', { class: 'mono', text: sample.feature_key }),
          ' · ',
          h('span', { class: `sev ${sample.severity}` }, h('span', { class: 'ico', text: severityIcon(sample.severity) }), severityLabel(sample.severity)),
          ' · ',
          sample.attribution?.length
            ? `${causeLabel(sample.attribution[0].cause)}（贡献 ${formatPercent(sample.attribution[0].contribution, 0)}）`
            : '未归因',
        ),
      ),
      h('button', { class: 'close sm', onClick: closeDrawer, 'aria-label': '关闭' }, '✕'),
    ),
    h('div', { class: 'drawer-body' }, drawerBody(sample)),
    h('div', { class: 'drawer-foot' },
      h('button', {
        class: 'primary',
        onClick: () => openRepairWith([sample.attribution?.[0]?.cause].filter(Boolean), [sample.entity_key]),
      }, '修复此原因并重算该实体'),
      h('button', { onClick: closeDrawer }, '关闭'),
    ),
  );
  document.body.append(backdrop, drawer);
}

function drawerBody(sample) {
  return [
    h('div', { class: 'block' },
      h('div', { class: 'value-pair' },
        h('div', { class: 'cell' },
          h('div', { class: 'k', text: '离线批处理' }),
          h('div', { class: `v ${sample.offline_value === null ? 'null' : ''}`, text: formatFeature(sample.feature_key, sample.offline_value) }),
          h('div', { class: 'k', text: `v${sample.configs.offline.bundle_version} · ${windowLabel({ start_inclusive: sample.window.offline.start_inclusive, end_inclusive: sample.window.offline.end_inclusive })}` }),
        ),
        h('div', { class: 'cell' },
          h('div', { class: 'k', text: '在线服务' }),
          h('div', { class: `v ${sample.online_value === null ? 'null' : ''}`, text: formatFeature(sample.feature_key, sample.online_value) }),
          h('div', { class: 'k', text: `v${sample.configs.online.bundle_version} · ${windowLabel({ start_inclusive: sample.window.online.start_inclusive, end_inclusive: sample.window.online.end_inclusive })}` }),
        ),
        h('div', { class: 'cell' },
          h('div', { class: 'k', text: '差值（在线 − 离线）' }),
          h('div', { class: 'v', text: formatDelta(sample.feature_key, sample.delta) }),
          h('div', { class: 'k', text: `窗口 ${sample.feature.window_hours}h` }),
        ),
      ),
    ),
    h('div', { class: 'block' },
      h('h4', { text: '时间窗口与边界' }),
      windowDiagram(sample),
    ),
    h('div', { class: 'block' },
      h('h4', { text: '差异归因（反事实修复）' }),
      h('p', { class: 'hint', text: '对每个候选原因单独应用修复后重新计算，按剩余差异的下降幅度排序' }),
      sample.attribution?.length
        ? h('div', { class: 'attr-list' },
            sample.attribution.map((a) => h('div', { class: `attr-row ${a.primary ? 'primary' : ''}` },
              h('span', { class: 'name', text: causeLabel(a.cause) }),
              h('span', { class: 'attr-track' }, h('span', { class: 'attr-fill', style: { width: `${a.contribution * 100}%`, background: causeColor(a.cause) } })),
              h('span', { class: 'val', text: `${formatPercent(a.contribution, 0)} · ${a.resolved ? '可消除' : '有残差'}` }),
            )),
          )
        : h('div', { class: 'empty', text: '未找到可解释的单一原因，可能为转换实现差异' }),
    ),
    h('div', { class: 'block' },
      h('h4', { text: `输入记录 · 窗口内 ${sample.raw_rows.length} 行，标记 ${sample.flagged_rows.length} 行` }),
      h('p', { class: 'hint', text: '两侧对同一行的取舍；判断依据来自各自的窗口开闭、水位与键规范化配置' }),
      rawRowsTable(sample),
    ),
    h('div', { class: 'block' },
      h('details', { class: 'config' },
        h('summary', { text: '两侧口径配置对照' }),
        configTable(sample.configs),
      ),
    ),
  ];
}

function windowDiagram(sample) {
  const { start, end } = sample.window;
  const geo = windowGeometry(start, end);
  const W = 660;
  const pad = 14;
  const innerW = W - pad * 2;
  const x = (iso) => pad + ((new Date(iso).getTime() - geo.min) / (geo.max - geo.min)) * innerW;
  const xStart = x(start);
  const xEnd = x(end);
  const rows = sample.raw_rows || [];
  const yOff = (r) => x(r.occurred_at);

  return h('div', { class: 'window-panel' },
    h('div', { class: 'window-legend' },
      h('span', { class: 'item' }, h('span', { class: 'swatch off' }), `离线 ${windowLabel({ start_inclusive: sample.window.offline.start_inclusive, end_inclusive: sample.window.offline.end_inclusive })} 计数`),
      h('span', { class: 'item' }, h('span', { class: 'swatch on' }), `在线 ${windowLabel({ start_inclusive: sample.window.online.start_inclusive, end_inclusive: sample.window.online.end_inclusive })} 计数`),
      h('span', { class: 'item' }, h('span', { class: 'swatch', style: { background: 'var(--status-critical)', height: '2px' } }), '离线水位'),
    ),
    svgDiagram(sample, { W, pad, innerW, xStart, xEnd, x, yOff, geo }),
    h('div', { class: 'window-meta' },
      h('div', {}, '窗口 ', h('code', { text: `${formatClock(start)} → ${formatClock(end)}` })),
      h('div', {}, '离线水位 ', h('code', { text: formatClock(sample.window.offline.watermark) })),
      h('div', {}, '在线水位 ', h('code', { text: formatClock(sample.window.online.watermark) })),
      h('div', {}, '边界事件 ', h('code', { text: `${rows.filter((r) => r.at_start).length} 行 @start · ${rows.filter((r) => r.at_end).length} 行 @end` })),
    ),
  );
}

function svgDiagram(sample, { W, pad, xStart, xEnd, x, yOff, geo }) {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, text) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const height = 128;
  const axisY = 74;
  const rows = sample.raw_rows || [];

  const svgEl = el('svg', {
    viewBox: `0 0 ${W} ${height}`,
    width: '100%',
    height,
    role: 'img',
    'aria-label': '时间窗口与输入事件位置',
  });

  // window bands
  svgEl.append(el('rect', { x: xStart, y: 26, width: Math.max(0, xEnd - xStart), height: 34, rx: 4, fill: 'var(--series-1)', opacity: 0.12 }));
  svgEl.append(el('line', { x1: xStart, y1: 20, x2: xStart, y2: 66, stroke: 'var(--series-1)', 'stroke-width': 2 }));
  svgEl.append(el('line', { x1: xEnd, y1: 20, x2: xEnd, y2: 66, stroke: 'var(--series-1)', 'stroke-width': 2 }));
  svgEl.append(el('text', { x: xStart, y: 15, 'text-anchor': 'start', fill: 'var(--text-secondary)', 'font-size': 10.5 }, '窗口起点'));
  svgEl.append(el('text', { x: xEnd, y: 15, 'text-anchor': 'end', fill: 'var(--text-secondary)', 'font-size': 10.5 }, 'as_of'));

  // offline watermark
  if (sample.window.offline.watermark) {
    const wx = Math.min(W - pad, Math.max(pad, x(sample.window.offline.watermark)));
    svgEl.append(el('line', { x1: wx, y1: 70, x2: wx, y2: 118, stroke: 'var(--status-critical)', 'stroke-width': 1.5, 'stroke-dasharray': '3 3' }));
    svgEl.append(el('text', { x: wx + 4, y: 116, fill: 'var(--status-critical)', 'font-size': 10 }, '离线水位'));
  }

  // axis
  svgEl.append(el('line', { x1: pad, y1: axisY, x2: W - pad, y2: axisY, stroke: 'var(--baseline)', 'stroke-width': 1 }));
  svgEl.append(el('text', { x: pad, y: height - 2, fill: 'var(--text-muted)', 'font-size': 9.5 }, formatClock(geo.start)));
  svgEl.append(el('text', { x: W - pad, y: height - 2, 'text-anchor': 'end', fill: 'var(--text-muted)', 'font-size': 9.5 }, formatClock(geo.end)));

  // marks: one dot per row, staggered; shape encodes whether both sides agree
  const sorted = [...rows].sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
  sorted.forEach((row, i) => {
    const cx = yOff(row);
    const cy = axisY - 10 - (i % 3) * 11;
    const inOff = row.offline_decision ? row.offline_decision.eligible : row.offline_window;
    const inOn = row.online_decision ? row.online_decision.eligible : row.online_window;
    let fill = 'var(--series-1)';
    let stroke = 'var(--surface-1)';
    if (inOff && inOn) fill = 'var(--series-3)';
    else if (inOff && !inOn) fill = 'var(--series-1)';
    else if (!inOff && inOn) fill = 'var(--series-2)';
    else fill = 'var(--text-muted)';
    if (row.at_start || row.at_end) stroke = 'var(--status-critical)';
    const dot = el('circle', {
      cx, cy, r: 5, fill, stroke, 'stroke-width': 2,
      tabindex: '0',
      role: 'img',
      'aria-label': `${row.event_id} ${row.occurred_at} 离线${inOff ? '计入' : '不计入'} 在线${inOn ? '计入' : '不计入'}`,
    });
    const title = el('title', {}, [
      row.event_id,
      row.occurred_at,
      `离线: ${inOff ? '计入' : '排除'} (${reasonLabel(row.offline_decision?.reason || 'included')})`,
      `在线: ${inOn ? '计入' : '排除'} (${reasonLabel(row.online_decision?.reason || 'included')})`,
      row.at_start ? '位于窗口起点边界' : '',
      row.at_end ? '位于窗口终点边界' : '',
      row.after_offline_watermark ? '晚于离线水位' : '',
      row.duplicate_group ? '存在重复投递' : '',
    ].filter(Boolean).join('\n'));
    dot.append(title);
    svgEl.append(dot);
  });

  return svgEl;
}

function rawRowsTable(sample) {
  const rows = sample.raw_rows || [];
  if (!rows.length) return h('div', { class: 'empty', text: '窗口内没有输入记录（无样本）' });
  return h('div', { class: 'table-wrap', style: { 'max-height': '320px' } },
    h('table', { class: 'data' },
      h('thead', {}, h('tr', {},
        h('th', { text: 'row / event_id' }),
        h('th', { text: '类型' }),
        h('th', { style: { 'text-align': 'right' }, text: '金额' }),
        h('th', { text: '发生' }),
        h('th', { text: '摄取' }),
        h('th', { text: '离线' }),
        h('th', { text: '在线' }),
        h('th', { text: '标记' }),
      )),
      h('tbody', {},
        rows.map((row) => {
          const marks = [];
          if (row.at_start) marks.push('窗口起点');
          if (row.at_end) marks.push('窗口终点');
          if (row.after_offline_watermark) marks.push('迟到');
          if (row.raw_key !== sample.entity_key) marks.push(`键 "${row.raw_key}"`);
          if (row.duplicate_group) marks.push('重复投递');
          if (row.diverges) marks.push('两侧口径分叉');
          return h('tr', { class: 'no-hover' },
            h('td', { class: 'mono' },
              h('div', { text: row.event_id }),
              h('div', { class: 'muted', style: { 'font-size': '10px' }, text: `#${row.row_id} · ${row.customer_id}` }),
            ),
            h('td', { text: row.type === 'refund' ? '退款' : '消费' }),
            h('td', { class: 'num', text: `¥${formatNumber(row.amount ?? 0, 2)}${row.currency !== 'CNY' ? ` ${row.currency}` : ''}` }),
            h('td', { class: 'mono', text: formatClock(row.occurred_at) }),
            h('td', { class: 'mono', text: formatClock(row.ingested_at) }),
            h('td', {}, h('span', { class: `reason ${row.offline_decision?.eligible ? 'ok' : 'bad'}` }, row.offline_decision?.eligible ? '计入' : reasonLabel(row.offline_decision?.reason || 'excluded'))),
            h('td', {}, h('span', { class: `reason ${row.online_decision?.eligible ? 'ok' : 'bad'}` }, row.online_decision?.eligible ? '计入' : reasonLabel(row.online_decision?.reason || 'excluded'))),
            h('td', { style: { 'font-size': '11px', color: 'var(--text-muted)' }, text: marks.join(' · ') || '—' }),
          );
        }),
      ),
    ),
  );
}

// ------------------------------------------------------------------- actions

async function openSample(entityKey, featureKey) {
  state.selection = { entity_key: entityKey, feature_key: featureKey };
  render();
  try {
    const sample = await api(`/api/sample/${encodeURIComponent(entityKey)}/${encodeURIComponent(featureKey)}`);
    openDrawer(sample);
  } catch (err) {
    toast(err.message, { bad: true });
  }
}

async function openEntity(entityKey) {
  const item = state.diffs.find((d) => d.entity_key === entityKey);
  if (item) {
    openSample(item.entity_key, item.feature_key);
    return;
  }
  const s = state.data?.summary;
  const entity = s?.entities?.find((e) => e.entity_key === entityKey);
  if (entity?.features?.length) {
    openSample(entityKey, entity.features[0]);
  } else {
    toast(`${entityKey} 当前没有差异`);
  }
}

function openRepairWith(causes, entityKeys) {
  closeDrawer();
  state.repairSelection = new Set(causes.filter(Boolean));
  state.view = 'repair';
  render();
  document.getElementById('repair')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (entityKeys?.length) {
    toast(`已选择 ${causes.length} 个原因，影响 ${entityKeys.length} 个实体`);
  }
}

// --------------------------------------------------------------------- boot

const savedTheme = localStorage.getItem('fcx-theme');
if (savedTheme) document.documentElement.dataset.theme = savedTheme;

const hash = location.hash.replace('#', '');
if (NAV.some(([k]) => k === hash)) state.view = hash;

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.drawer) closeDrawer();
});

refresh().catch((err) => {
  root.append(h('div', { class: 'empty', text: `加载失败：${err.message}` }));
});

// Exported for the headless render tests; the browser entry point ignores these.
export { state, render, refresh, openSample, openEntity };

