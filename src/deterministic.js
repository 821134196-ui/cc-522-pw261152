// Deterministic helpers shared by seeds, engines and the API.

export function hashString(str) {
  // FNV-1a 32 bit — stable across runs and platforms.
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function bucketOf(key, salt) {
  return hashString(`${salt}:${key}`) % 100;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function round(value, digits = 4) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function isoMinute(date) {
  return date.toISOString().slice(0, 16) + 'Z';
}

export function parseIso(s) {
  return new Date(s.endsWith('Z') ? s : s + 'Z');
}

export function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

export function ymd(date) {
  return date.toISOString().slice(0, 10);
}

export const FEATURE_ORDER = [
  'spend_24h',
  'spend_7d',
  'txn_count_24h',
  'refund_ratio_7d',
  'risk_score',
];

export function rankOf(value, population) {
  // Percentile rank 0..1 of `value` inside an ascending population.
  if (population.length === 0) return null;
  let lo = 0;
  let hi = 0;
  for (const v of population) {
    if (v < value) lo++;
    else if (v === value) hi++;
  }
  return round((lo + hi / 2) / population.length, 6);
}

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function quantile(values, q) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return s[base + 1] !== undefined ? s[base] + rest * (s[base + 1] - s[base]) : s[base];
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}
