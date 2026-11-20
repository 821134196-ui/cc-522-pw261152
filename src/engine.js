// Feature computation for the offline batch side and the online serving side.
// Every inclusion/exclusion decision is recorded per source row, so a diff can
// be localized to a feature *and* the exact input records behind it.

import { parseIso, round, addMinutes } from './deterministic.js';
import { FEATURES, FEATURE_KEYS, TIER_WEIGHTS, BUNDLES, PRESETS, CAUSES } from './spec.js';

function asDate(value) {
  return value instanceof Date ? value : parseIso(value);
}

export function indexWorld(world) {
  const eventsByEntity = new Map();
  for (const event of world.events) {
    if (!eventsByEntity.has(event.entity_key_norm)) eventsByEntity.set(event.entity_key_norm, []);
    eventsByEntity.get(event.entity_key_norm).push(event);
  }
  const dimByCustomer = new Map();
  for (const row of world.dim) {
    if (!dimByCustomer.has(row.customer_id)) dimByCustomer.set(row.customer_id, []);
    dimByCustomer.get(row.customer_id).push(row);
  }
  return {
    eventsByEntity,
    dimByCustomer,
    fx: new Map(world.fx.map((r) => [r.currency, r.rate])),
    entities: new Map(world.entities.map((e) => [e.key, e])),
    entityKeys: world.entities.map((e) => e.key),
  };
}

function isWithin(dateStr, start, end, startInclusive, endInclusive) {
  const t = parseIso(dateStr).getTime();
  const s = start.getTime();
  const e = end.getTime();
  return (startInclusive ? t >= s : t > s) && (endInclusive ? t <= e : t < e);
}

export function dedupeKey(event, cfg) {
  if (cfg.dedupe_key === 'event_id') return event.event_id;
  // Weak online key: entity + minute of occurrence + amount. A corrected retry
  // carries a new amount and therefore escapes dedupe.
  return `${event.entity_key_norm}|${event.occurred_at.slice(0, 16)}|${event.amount}`;
}

export function watermarkFor(cfg, asOfValue, serveTime) {
  const asOf = asDate(asOfValue);
  if (cfg.watermark === 'current') return parseIso(serveTime);
  return addMinutes(asOf, -(cfg.batch_lag_minutes ?? 15));
}

function dimInfo(customerId, cfg, asOf, dimByCustomer) {
  const rows = dimByCustomer.get(customerId) || [];
  const active = rows.filter(
    (r) =>
      parseIso(r.effective_from) <= asOf &&
      parseIso(r.effective_to) >= asOf,
  );
  if (cfg.dim_join === 'latest') {
    const latest = active.reduce(
      (best, row) => (!best || parseIso(row.updated_at) > parseIso(best.updated_at) ? row : best),
      null,
    );
    return { multiplicity: 1, tier: latest ? latest.tier : null, missing: !latest, fanout: false };
  }
  return {
    multiplicity: active.length,
    tier: active.length ? active[0].tier : null,
    missing: active.length === 0,
    fanout: active.length > 1,
  };
}

// Resolve visibility for every raw row for one entity and one side.
export function evaluateRows(worldIdx, cfg, entityKey, asOfValue, serveTime) {
  const asOf = asDate(asOfValue);
  const events = worldIdx.eventsByEntity.get(entityKey) || [];
  const watermark = watermarkFor(cfg, asOf, serveTime);
  const prepare = [];

  for (const event of events) {
    const keyVariant = cfg.key_normalize ? false : event.raw_key !== entityKey;
    const late = parseIso(event.ingested_at) > watermark;
    const dim = dimInfo(event.customer_id, cfg, asOf, worldIdx.dimByCustomer);
    const fxMissing = !worldIdx.fx.has(event.currency);
    const amount = event.amount === null || event.amount === undefined ? null : Number(event.amount);
    prepare.push({ event, keyVariant, late, dim, fxMissing, amount });
  }

  const groups = new Map();
  for (const row of prepare) {
    if (row.keyVariant || row.late) continue;
    const key = dedupeKey(row.event, cfg);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const keepRowId = new Map();
  for (const [key, group] of groups) {
    const ordered = [...group].sort(
      (a, b) =>
        parseIso(a.event.updated_at || a.event.ingested_at) -
          parseIso(b.event.updated_at || b.event.ingested_at) || a.event.row_id - b.event.row_id,
    );
    keepRowId.set(key, ordered[ordered.length - 1].event.row_id);
  }

  const rows = prepare.map(({ event, keyVariant, late, dim, fxMissing, amount }) => {
    const group = groups.get(dedupeKey(event, cfg)) || [];
    const superseded = !keyVariant && !late && group.length > 1 && keepRowId.get(dedupeKey(event, cfg)) !== event.row_id;
    const rate = worldIdx.fx.get(event.currency);
    let reason = 'included';
    if (keyVariant) reason = 'key_variant';
    else if (late) reason = 'late_not_ingested';
    else if (superseded) reason = 'duplicate_superseded';
    else if (dim.multiplicity === 0) reason = 'dim_missing';
    else if (fxMissing && cfg.fx_missing === 'skip') reason = 'fx_missing';
    else if (amount === null && cfg.null_amount === 'skip') reason = 'null_amount';

    const eligible = reason === 'included';
    return {
      row_id: event.row_id,
      event_id: event.event_id,
      raw_key: event.raw_key,
      customer_id: event.customer_id,
      type: event.type,
      amount,
      currency: event.currency,
      rate: fxMissing ? null : rate,
      converted_amount:
        amount === null ? (cfg.null_amount === 'fill_zero' ? 0 : null) : round(amount * (fxMissing ? 1 : rate), 4),
      occurred_at: event.occurred_at,
      ingested_at: event.ingested_at,
      updated_at: event.updated_at,
      multiplicity: eligible ? dim.multiplicity : 0,
      eligible,
      reason,
      tier: dim.tier,
      flags: {
        late,
        key_variant: keyVariant,
        duplicate: superseded,
        duplicate_group_size: group.length,
        dim_missing: dim.missing,
        dim_fanout: dim.fanout,
        fx_missing: fxMissing,
        null_amount: amount === null,
      },
    };
  });

  rows.sort((a, b) => parseIso(a.occurred_at) - parseIso(b.occurred_at) || a.row_id - b.row_id);
  return { rows, watermark: watermark.toISOString() };
}

export function windowFor(featureKey, asOfValue) {
  const f = FEATURES[featureKey];
  const asOf = asDate(asOfValue);
  return { start: addMinutes(asOf, -60 * f.window_hours), end: asOf };
}

function inFeatureWindow(row, cfg, window) {
  return isWithin(
    row.occurred_at,
    window.start,
    window.end,
    cfg.window_start_inclusive,
    cfg.window_end_inclusive,
  );
}

function riskScore(features, tier, bundleVersion) {
  const params = (BUNDLES[bundleVersion] || BUNDLES['3.2.0']).risk;
  const spend = features.spend_7d;
  const ratio = features.refund_ratio_7d;
  if (spend === null || ratio === null) return null;
  const spendTerm = Math.min(spend, params.spend_cap) / params.spend_cap;
  const raw =
    spendTerm * params.spend_weight +
    (TIER_WEIGHTS[tier] ?? 0) * params.tier_weight +
    ratio * params.refund_weight;
  return round(Math.max(0, Math.min(1, raw)), 6);
}

function collectFlags(rows, featureKey, cfg, asOf, otherRows, otherCfg) {
  const window = windowFor(featureKey, asOf);
  const startMs = window.start.getTime();
  const endMs = window.end.getTime();
  const within = (row) => {
    const t = parseIso(row.occurred_at).getTime();
    return t >= startMs && t <= endMs;
  };
  const flags = new Set();
  const addRowFlags = (row) => {
    const t = parseIso(row.occurred_at).getTime();
    if (t === startMs) flags.add('boundary_start');
    if (t === endMs) flags.add('boundary_end');
    if (row.flags.late) flags.add('late');
    if (row.flags.key_variant) flags.add('key_variant');
    if (row.flags.dim_missing) flags.add('dim_missing');
    if (row.flags.dim_fanout) flags.add('dim_fanout');
    if (row.flags.fx_missing) flags.add('fx_missing');
    if (row.flags.null_amount) flags.add('null_amount');
    if (row.flags.duplicate || row.flags.duplicate_group_size > 1) flags.add('duplicate');
  };
  for (const row of rows) if (within(row)) addRowFlags(row);
  for (const row of otherRows || []) if (within(row)) addRowFlags(row);

  const purchases = rows.filter((r) => r.eligible && r.type === 'purchase' && inFeatureWindow(r, cfg, window));
  const otherPurchases = (otherRows || []).filter(
    (r) => r.eligible && r.type === 'purchase' && inFeatureWindow(r, otherCfg, window),
  );
  if (purchases.length === 0 && otherPurchases.length === 0) flags.add('empty');
  return { flags: [...flags], window };
}

export function computeEntity(worldIdx, cfg, entityKey, asOf, serveTime) {
  const { rows, watermark } = evaluateRows(worldIdx, cfg, entityKey, asOf, serveTime);
  const features = {};
  const flags = {};

  for (const featureKey of FEATURE_KEYS) {
    if (featureKey === 'risk_score') continue;
    const feature = FEATURES[featureKey];
    const window = windowFor(featureKey, asOf);
    const inWindow = rows.filter((r) => r.eligible && inFeatureWindow(r, cfg, window));
    const purchases = inWindow.filter((r) => r.type === 'purchase');
    const refunds = inWindow.filter((r) => r.type === 'refund');
    const emptyMode = cfg.fill_missing === 'null';
    const weighted = (list) => list.reduce((sum, r) => sum + (r.converted_amount ?? 0) * r.multiplicity, 0);

    let value;
    if (feature.kind === 'sum_purchase') {
      value = purchases.length === 0 && emptyMode ? null : round(weighted(purchases), 2);
    } else if (feature.kind === 'count_purchase') {
      value = purchases.length === 0 && emptyMode ? null : purchases.reduce((s, r) => s + r.multiplicity, 0);
    } else if (feature.kind === 'refund_ratio') {
      const purchaseAmount = weighted(purchases);
      value =
        purchaseAmount <= 0
          ? emptyMode
            ? null
            : 0
          : round(weighted(refunds) / purchaseAmount, 4);
    } else {
      value = null;
    }
    features[featureKey] = value;
    flags[featureKey] = collectFlags(rows, featureKey, cfg, asOf, null, cfg).flags;
  }

  const tier = rows.find((r) => r.tier)?.tier ?? null;
  features.risk_score = riskScore(features, tier, cfg.bundle_version);
  flags.risk_score = collectFlags(rows, 'risk_score', cfg, asOf, null, cfg).flags;

  return { features, flags, rows, watermark, entityKey, tier };
}

export function compareFeature(a, b, featureKey) {
  const feature = FEATURES[featureKey];
  const tol = 10 ** -(feature.precision + 2);
  if (a === null && b === null) return { match: true, delta: 0 };
  if (a === null || b === null) return { match: false, delta: null };
  return { match: Math.abs(b - a) <= tol, delta: round(b - a, Math.max(feature.precision, 4)) };
}

function severityOf(a, b) {
  if (a === null || b === null) return 'high';
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  const rel = Math.abs(b - a) / denom;
  if (rel >= 0.5) return 'high';
  if (rel >= 0.1) return 'medium';
  return 'low';
}

export const CAUSE_FLAGS = {
  window_boundary: ['boundary_start', 'boundary_end'],
  late_event: ['late'],
  duplicate_event: ['duplicate'],
  key_mismatch: ['key_variant'],
  dim_fanout: ['dim_fanout'],
  dim_missing: ['dim_missing'],
  fx_unknown: ['fx_missing'],
  missing_value: ['null_amount'],
  missing_fill: ['empty'],
  version_mismatch: [],
  transform_drift: [],
};

const CAUSE_PRESET = {
  window_boundary: 'window_half_open',
  late_event: 'fresh_watermark',
  duplicate_event: 'dedupe_event_id',
  key_mismatch: 'normalize_keys',
  dim_fanout: 'dim_latest',
  dim_missing: 'dim_latest',
  fx_unknown: 'fx_strict',
  missing_value: 'null_fill_policy',
  missing_fill: 'null_fill_policy',
};

export function causePreset(cause) {
  return CAUSE_PRESET[cause] || null;
}

export function applyPreset(configs, presetKey) {
  const preset = PRESETS[presetKey];
  if (!preset) throw new Error(`unknown preset ${presetKey}`);
  const next = { offline: { ...configs.offline }, online: { ...configs.online } };
  for (const side of preset.sides) Object.assign(next[side], preset.params);
  return next;
}

function configsForCause(configs, cause) {
  if (cause === 'version_mismatch') {
    return {
      offline: { ...configs.offline },
      online: { ...configs.online, bundle_version: configs.offline.bundle_version },
    };
  }
  const preset = causePreset(cause);
  return preset ? applyPreset(configs, preset) : configs;
}

export function diffEntity(worldIdx, configs, entityKey, asOf, serveTime) {
  const offline = computeEntity(worldIdx, configs.offline, entityKey, asOf, serveTime);
  const online = computeEntity(worldIdx, configs.online, entityKey, asOf, serveTime);
  const diffs = [];
  for (const featureKey of FEATURE_KEYS) {
    const cmp = compareFeature(offline.features[featureKey], online.features[featureKey], featureKey);
    if (cmp.match) continue;
    const flags = new Set([...offline.flags[featureKey], ...online.flags[featureKey]]);
    diffs.push({
      entity_key: entityKey,
      feature_key: featureKey,
      offline_value: offline.features[featureKey],
      online_value: online.features[featureKey],
      delta: cmp.delta,
      severity: severityOf(offline.features[featureKey], online.features[featureKey]),
      flags: [...flags],
      offline,
      online,
    });
  }
  return { offline, online, diffs };
}

function magnitude(a, b) {
  if (a === null || b === null) return a === b ? 0 : 1;
  return Math.abs(b - a);
}

// Counterfactual attribution: for each cause whose evidence appears in the
// input records, apply only that cause's repair and measure how much of the
// delta disappears. Ranking is computed, never hardcoded.
function rawHasRows(worldIdx, entityKey, featureKey, asOf) {
  const window = windowFor(featureKey, asOf);
  const start = window.start.getTime();
  const end = window.end.getTime();
  return (worldIdx.eventsByEntity.get(entityKey) || []).some((event) => {
    const t = parseIso(event.occurred_at).getTime();
    return t >= start && t <= end;
  });
}

export function attributeDiff(worldIdx, configs, entityKey, featureKey, asOf, serveTime, base) {
  const allFlags = new Set(base.flags || []);
  const hasRawRows = rawHasRows(worldIdx, entityKey, featureKey, asOf);
  const candidates = [];
  for (const cause of Object.keys(CAUSES)) {
    if (cause === 'transform_drift') continue;
    let eligible;
    if (cause === 'version_mismatch') {
      eligible = configs.offline.bundle_version !== configs.online.bundle_version;
    } else if (cause === 'missing_fill') {
      // Only when the source itself has no rows in the window — an "empty" flag
      // produced by another exclusion (dim join, key variant, …) is that cause's
      // symptom, not a separate fill-policy defect.
      eligible = !hasRawRows;
    } else {
      eligible = (CAUSE_FLAGS[cause] || []).some((flag) => allFlags.has(flag));
    }
    if (!eligible) continue;
    const cf = configsForCause(configs, cause);
    const offline = computeEntity(worldIdx, cf.offline, entityKey, asOf, serveTime);
    const online = computeEntity(worldIdx, cf.online, entityKey, asOf, serveTime);
    const cmp = compareFeature(offline.features[featureKey], online.features[featureKey], featureKey);
    const before = magnitude(base.offline_value, base.online_value);
    const after = cmp.match ? 0 : magnitude(offline.features[featureKey], online.features[featureKey]);
    const reduction = before - after;
    if (reduction <= Math.max(before * 0.02, 1e-9)) continue;
    candidates.push({
      cause,
      reduction,
      residual: after,
      resolved: cmp.match,
      offline_value: offline.features[featureKey],
      online_value: online.features[featureKey],
      preset: causePreset(cause),
    });
  }
  candidates.sort((a, b) => b.reduction - a.reduction);
  const total = candidates.reduce((sum, c) => sum + c.reduction, 0) || 1;
  return candidates.map((c, index) => ({
    ...c,
    primary: index === 0,
    contribution: round(c.reduction / total, 3),
  }));
}

// Evidence rows: only the rows that actually behave differently between sides
// (or that carry a flag explaining the delta).
export function evidenceRows(offline, online, featureKey) {
  const rowIds = new Set([...offline.rows.map((r) => r.row_id), ...online.rows.map((r) => r.row_id)]);
  const merged = [];
  for (const rowId of rowIds) {
    const a = offline.rows.find((r) => r.row_id === rowId);
    const b = online.rows.find((r) => r.row_id === rowId);
    const base = a || b;
    const diff = !a || !b || a.eligible !== b.eligible || a.reason !== b.reason || a.multiplicity !== b.multiplicity;
    if (!diff) continue;
    merged.push({
      row_id: rowId,
      event_id: base.event_id,
      raw_key: base.raw_key,
      customer_id: base.customer_id,
      type: base.type,
      amount: base.amount,
      currency: base.currency,
      rate: base.rate,
      occurred_at: base.occurred_at,
      ingested_at: base.ingested_at,
      updated_at: base.updated_at,
      offline: a ? { included: a.eligible, reason: a.reason, value: a.converted_amount, multiplicity: a.multiplicity } : null,
      online: b ? { included: b.eligible, reason: b.reason, value: b.converted_amount, multiplicity: b.multiplicity } : null,
    });
  }
  return merged;
}

export function qualityInventory(world, configs, asOf, serveTime) {
  const watermark = watermarkFor(configs.offline, asOf, serveTime);
  const grouped = new Map();
  for (const event of world.events) {
    if (!grouped.has(event.event_id)) grouped.set(event.event_id, []);
    grouped.get(event.event_id).push(event);
  }
  const late = [];
  for (const event of world.events) {
    if (parseIso(event.ingested_at) > watermark) {
      late.push({
        entity_key: event.entity_key_norm,
        event_id: event.event_id,
        occurred_at: event.occurred_at,
        ingested_at: event.ingested_at,
        watermark: watermark.toISOString(),
        minutes_late: Math.round((parseIso(event.ingested_at) - watermark) / 60000),
      });
    }
  }
  const duplicates = [];
  for (const [eventId, rows] of grouped) {
    if (rows.length > 1) {
      duplicates.push({
        entity_key: rows[0].entity_key_norm,
        event_id: eventId,
        rows: rows.map((r) => ({ row_id: r.row_id, amount: r.amount, ingested_at: r.ingested_at, updated_at: r.updated_at })),
      });
    }
  }
  late.sort((a, b) => a.entity_key.localeCompare(b.entity_key) || a.occurred_at.localeCompare(b.occurred_at));
  duplicates.sort((a, b) => a.entity_key.localeCompare(b.entity_key));
  return {
    watermark: watermark.toISOString(),
    late,
    duplicates,
    late_entities: [...new Set(late.map((r) => r.entity_key))].sort(),
    duplicate_entities: [...new Set(duplicates.map((r) => r.entity_key))].sort(),
  };
}

// Entities whose materialized vectors would change if the config moved from
// `fromConfigs` to `toConfigs` for either side. This is the ground truth for
// repair scope: it catches entities affected through side effects (e.g. a late
// row that also sits on a window boundary) that a cause-flag heuristic misses.
export function entitiesWhoseVectorsChange(worldIdx, fromConfigs, toConfigs, entityKeys, asOf, serveTime) {
  const changed = [];
  for (const entityKey of entityKeys) {
    for (const side of ['offline', 'online']) {
      const a = computeEntity(worldIdx, fromConfigs[side], entityKey, asOf, serveTime);
      const b = computeEntity(worldIdx, toConfigs[side], entityKey, asOf, serveTime);
      const digest = (result) =>
        result.rows
          .filter((r) => r.eligible)
          .map((r) => `${r.row_id}:${r.multiplicity}:${r.converted_amount}`)
          .join('|') + `#${JSON.stringify(result.features)}`;
      if (digest(a) !== digest(b)) {
        changed.push({ entity_key: entityKey, side });
        break;
      }
    }
  }
  return changed.map((c) => c.entity_key);
}

export function affectedEntitiesForCauses(worldIdx, configs, causes, asOf, serveTime) {
  const wanted = new Set();
  for (const cause of causes) for (const flag of CAUSE_FLAGS[cause] || []) wanted.add(flag);
  if (wanted.size === 0) return [];
  const affected = [];
  for (const entityKey of worldIdx.entityKeys) {
    const offline = computeEntity(worldIdx, configs.offline, entityKey, asOf, serveTime);
    const online = computeEntity(worldIdx, configs.online, entityKey, asOf, serveTime);
    const entityFlags = new Set();
    for (const featureKey of FEATURE_KEYS) {
      for (const f of offline.flags[featureKey]) entityFlags.add(f);
      for (const f of online.flags[featureKey]) entityFlags.add(f);
    }
    if ([...wanted].some((f) => entityFlags.has(f))) affected.push(entityKey);
  }
  return affected.sort();
}

// Raw source rows in the feature's window, with each side's decision attached.
export function rawRowsFor(worldIdx, entityKey, featureKey, asOf) {
  const window = windowFor(featureKey, asOf);
  const start = window.start.getTime();
  const end = window.end.getTime();
  const rows = worldIdx.eventsByEntity.get(entityKey) || [];
  return rows
    .filter((event) => {
      const t = parseIso(event.occurred_at).getTime();
      return t >= start && t <= end;
    })
    .sort((a, b) => parseIso(a.occurred_at) - parseIso(b.occurred_at) || a.row_id - b.row_id)
    .map((event) => ({
      row_id: event.row_id,
      event_id: event.event_id,
      raw_key: event.raw_key,
      customer_id: event.customer_id,
      type: event.type,
      amount: event.amount,
      currency: event.currency,
      occurred_at: event.occurred_at,
      ingested_at: event.ingested_at,
      updated_at: event.updated_at,
    }));
}
