// Pure formatting helpers — unit-testable without a DOM.

const FEATURE_META = {
  spend_24h: { label: '24h 消费额', unit: 'CNY', digits: 2, kind: 'money' },
  spend_7d: { label: '7d 消费额', unit: 'CNY', digits: 2, kind: 'money' },
  txn_count_24h: { label: '24h 交易笔数', unit: '笔', digits: 0, kind: 'count' },
  refund_ratio_7d: { label: '7d 退款率', unit: '', digits: 4, kind: 'ratio' },
  risk_score: { label: '风险分', unit: '', digits: 3, kind: 'score' },
};

export const FEATURE_KEYS = Object.keys(FEATURE_META);

export function featureMeta(key) {
  return FEATURE_META[key] || { label: key, unit: '', digits: 2, kind: 'count' };
}

const causeLabels = new Map();
export function registerCauses(causes) {
  for (const [key, meta] of Object.entries(causes || {})) {
    causeLabels.set(key, meta);
  }
}

export function causeLabel(key) {
  return causeLabels.get(key)?.label || key;
}

export function causeTone(key) {
  return causeLabels.get(key)?.tone || 'serious';
}

export function causeColor(key) {
  return causeLabels.get(key)?.color || 'var(--series-1)';
}

export function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'null';
  const fixed = Math.abs(value) >= 1000 && digits <= 2
    ? value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : value.toFixed(digits);
  return fixed;
}

export function formatFeature(key, value) {
  const meta = featureMeta(key);
  if (value === null || value === undefined) return 'null';
  if (meta.kind === 'money') return `¥${formatNumber(value, 2)}`;
  if (meta.kind === 'ratio') return `${(value * 100).toFixed(2)}%`;
  if (meta.kind === 'score') return value.toFixed(3);
  return formatNumber(value, 0);
}

export function formatDelta(key, delta) {
  if (delta === null || delta === undefined) return '—';
  const meta = featureMeta(key);
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±';
  const abs = Math.abs(delta);
  if (meta.kind === 'money') return `${sign}¥${formatNumber(abs, 2)}`;
  if (meta.kind === 'ratio') return `${sign}${(abs * 100).toFixed(2)}pp`;
  if (meta.kind === 'score') return `${sign}${abs.toFixed(3)}`;
  return `${sign}${formatNumber(abs, 0)}`;
}

export function formatPercent(value, digits = 1) {
  if (value === null || value === undefined) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatClock(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

export function severityLabel(severity) {
  return { high: '高', medium: '中', low: '低' }[severity] || severity;
}

export function severityIcon(severity) {
  // Icon + label pairing — status is never carried by color alone.
  return { high: '▲', medium: '◆', low: '●' }[severity] || '●';
}

export function checkIcon(status) {
  return { pass: '✓', warn: '!', fail: '✕' }[status] || '·';
}

export function checkStatusLabel(status) {
  return { pass: '通过', warn: '警告', fail: '失败' }[status] || status;
}

export function toneForStatus(status) {
  return { pass: 'good', warn: 'warning', fail: 'critical' }[status] || 'info';
}

const REASON_LABELS = {
  included: '计入',
  key_variant: '键变体未被离线识别',
  late_not_ingested: '晚于离线水位',
  duplicate_superseded: '重复投递被覆盖',
  dim_missing: '维表缺失',
  fx_missing: '无汇率',
  null_amount: '空金额',
  out_of_window: '不在该特征窗口',
  not_evaluated: '两侧均不可见',
};

export function reasonLabel(reason) {
  return REASON_LABELS[reason] || reason;
}

export function windowLabel(cfg) {
  if (!cfg) return '—';
  return `${cfg.start_inclusive ? '[' : '('}start, end${cfg.end_inclusive ? ']' : ')'}`;
}

// Fraction of a window where a mark's timestamp sits, clamped to 0..1.
export function positionInWindow(timestamp, startIso, endIso) {
  const t = new Date(timestamp).getTime();
  const s = new Date(startIso).getTime();
  const e = new Date(endIso).getTime();
  if (!Number.isFinite(t) || e === s) return 0;
  return Math.min(1, Math.max(0, (t - s) / (e - s)));
}

// The window drawn in the drawer is padded so boundary marks at 0 and 1 stay
// visible and the two half-open edges can be distinguished.
export function windowGeometry(startIso, endIso, padding = 0.06) {
  const s = new Date(startIso).getTime();
  const e = new Date(endIso).getTime();
  const span = e - s || 1;
  return { min: s - span * padding, max: e + span * padding, start: s, end: e };
}

export function scaleBar(value, max) {
  if (!max || max <= 0) return 0;
  return Math.max(0.002, Math.min(1, value / max));
}
