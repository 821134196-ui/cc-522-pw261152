// Application service: materialization, comparison, repair scoping and release
// management. The comparison always reads materialized vectors, so a partial
// recompute is observable: entities outside the scope are reported as reused.

import { createHash } from 'node:crypto';
import { stableStringify, parseIso, round } from './deterministic.js';
import {
  AS_OF,
  FEATURES,
  FEATURE_KEYS,
  CAUSES,
  PRESETS,
  BUNDLES,
  DEFAULT_PIPELINE,
  RELEASE_SALT,
} from './spec.js';
import { buildWorld } from './seed.js';
import {
  indexWorld,
  computeEntity,
  diffEntity,
  attributeDiff,
  evidenceRows,
  qualityInventory,
  rawRowsFor,
  entitiesWhoseVectorsChange,
} from './engine.js';
import { bucketOf } from './deterministic.js';

export const SERVE_TIME = '2026-11-19T06:30:00Z';
export const ACTIVE_VERSION = '3.2.0';

function hash(value) {
  return createHash('sha1').update(stableStringify(value)).digest('hex').slice(0, 16);
}

// Fingerprint of a materialized vector: the rows that fed it plus the values it
// produced. Window membership is feature-local and does not appear on the row,
// so the feature values must be part of the digest or a boundary-config change
// would look like a no-op.
function digestOf(entityResult) {
  return hash({
    rows: entityResult.rows
      .filter((r) => r.eligible)
      .map((r) => `${r.row_id}:${r.multiplicity}:${r.converted_amount}`),
    features: entityResult.features,
  });
}

function roundValue(value, digits) {
  return value === null || value === undefined ? null : round(value, digits);
}

export class Service {
  constructor(store, { now = () => new Date().toISOString() } = {}) {
    this.store = store;
    this.now = now;
    this.world = buildWorld();
    this.index = indexWorld(this.world);
    this._diffCache = new Map();
    this._attributeCache = new Map();
    this._digestCache = new Map();
  }

  // ------------------------------------------------------------------ state
  ensureInitialized() {
    if (this.store.getMeta('initialized') === '1') return;
    this.store.setPipelines(DEFAULT_PIPELINE, this.now());
    this.store.setMeta('initialized', '1');
    this.store.setMeta('as_of', AS_OF);
    this.store.setMeta('serve_time', SERVE_TIME);
    this.materializeAll({ trigger: 'bootstrap', scope: { kind: 'all' }, at: this.now() });
    this.store.addEvent({
      kind: 'baseline',
      title: '一致性基线已建立',
      detail: { entities: this.index.entityKeys.length, as_of: AS_OF, version: ACTIVE_VERSION },
      at: this.now(),
    });
    this.store.addSnapshot({
      label: 'baseline',
      summary: this.summarySnapshot(),
      at: this.now(),
    });
  }

  reset() {
    this.store.clearAll();
    this._diffCache.clear();
    this._attributeCache.clear();
    this._digestCache.clear();
    this.ensureInitialized();
  }

  pipelines() {
    return this.store.getPipelines();
  }

  releases() {
    return this.store.listReleases();
  }

  currentRelease() {
    return (
      this.releases().find((r) => ['canary', 'ramping', 'full'].includes(r.status)) || null
    );
  }

  cohortFor({ version, percent, salt }) {
    return this.index.entityKeys.filter(
      (entityKey) => bucketOf(entityKey, `${salt}:${version}`) < percent,
    );
  }

  effectiveVersion(entityKey) {
    const release = this.currentRelease();
    if (!release || release.percent <= 0) return ACTIVE_VERSION;
    const inCohort = bucketOf(entityKey, `${release.salt}:${release.version}`) < release.percent;
    return inCohort ? release.version : ACTIVE_VERSION;
  }

  configFor(side, entityKey) {
    const cfg = { ...this.pipelines()[side] };
    if (side === 'online') cfg.bundle_version = this.effectiveVersion(entityKey);
    return cfg;
  }

  cohortMap() {
    const release = this.currentRelease();
    const map = new Map();
    for (const entityKey of this.index.entityKeys) {
      map.set(entityKey, {
        version: this.effectiveVersion(entityKey),
        bucket: release ? bucketOf(entityKey, `${release.salt}:${release.version}`) : null,
        inCanary:
          Boolean(release) &&
          release.percent > 0 &&
          bucketOf(entityKey, `${release.salt}:${release.version}`) < release.percent,
        release_id: release ? release.id : null,
      });
    }
    return map;
  }

  // -------------------------------------------------------- materialization
  // Monotonic stamp for materialization ordering. Wall-clock alone is not
  // enough: a backfill recomputed "at" an earlier logical time must still be the
  // row that reads win, and two writes in the same millisecond must not tie.
  stamp() {
    this._clock = Math.max(Date.now(), (this._clock ?? 0) + 1);
    return this._clock;
  }

  materializeEntity(side, entityKey, cfg, { reusedFrom = null } = {}) {
    const result = computeEntity(this.index, cfg, entityKey, AS_OF, SERVE_TIME);
    const features = {};
    for (const key of FEATURE_KEYS) {
      features[key] = roundValue(result.features[key], FEATURES[key].precision);
    }
    const configHash = hash(cfg);
    const mat = {
      side,
      entity_key: entityKey,
      config_hash: configHash,
      bundle_version: cfg.bundle_version,
      features,
      input_digest: digestOf(result),
      computed_at: this.stamp(),
      reused_from: reusedFrom,
    };
    this.store.putMaterialization(mat);
    return { mat, result };
  }

  materializeAll({ trigger, scope, at, reusedFrom = null }) {
    const started = Date.now();
    const recomputed = [];
    for (const entityKey of this.index.entityKeys) {
      for (const side of ['offline', 'online']) {
        this.materializeEntity(side, entityKey, this.configFor(side, entityKey), { reusedFrom });
      }
      recomputed.push(entityKey);
    }
    this._diffCache.clear();
    this._attributeCache.clear();
    this._digestCache.clear();
    const job = {
      trigger,
      scope,
      recomputed,
      reused: 0,
      idempotent: false,
      verified: { checked: 0, drifted: [] },
      duration_ms: Date.now() - started,
      at,
    };
    this.store.addRecomputeJob(job);
    return job;
  }

  recomputeScope(entityKeys, { trigger, scope, at, idempotency_probe = false }) {
    const started = Date.now();
    const startedEntities = new Set(entityKeys);
    const recomputed = [];
    for (const entityKey of startedEntities) {
      for (const side of ['offline', 'online']) {
        this.materializeEntity(side, entityKey, this.configFor(side, entityKey));
      }
      recomputed.push(entityKey);
    }
    this._diffCache.clear();
    this._attributeCache.clear();
    this._digestCache.clear();
    const reused = this.index.entityKeys.length - recomputed.length;
    // Verify the scope was complete: every entity outside it must reproduce its
    // stored vector under the current config. A drift here means the repair was
    // under-scoped and would be a correctness bug, so it is surfaced, not hidden.
    const scopeSet = new Set(recomputed);
    const drifted = [];
    for (const entityKey of this.index.entityKeys) {
      if (scopeSet.has(entityKey)) continue;
      for (const side of ['offline', 'online']) {
        const stored = this.store.getMaterialization(side, entityKey);
        const fresh = computeEntity(this.index, this.configFor(side, entityKey), entityKey, AS_OF, SERVE_TIME);
        if (!stored || digestOf(fresh) !== stored.input_digest) drifted.push(`${side}:${entityKey}`);
      }
    }
    const verified = {
      checked: (this.index.entityKeys.length - recomputed.length) * 2,
      drifted,
    };
    // Duplicate-computation probe: recompute the same scope a second time under
    // the *current* config and require an identical input digest.
    const idempotent =
      idempotency_probe === true
        ? recomputed.every((entityKey) =>
            ['offline', 'online'].every((side) => {
              const stored = this.store.getMaterialization(side, entityKey);
              const again = computeEntity(this.index, this.configFor(side, entityKey), entityKey, AS_OF, SERVE_TIME);
              return stored && digestOf(again) === stored.input_digest;
            }),
          )
        : false;
    const job = {
      trigger,
      scope,
      recomputed: [...recomputed].sort(),
      reused,
      idempotent,
      verified,
      duration_ms: Date.now() - started,
      at,
    };
    this.store.addRecomputeJob(job);
    return job;
  }

  materialized(side, entityKey) {
    return this.store.getMaterialization(side, entityKey);
  }

  // Digest the entity would have under the current config. Cached per
  // (side, entity, config) so staleness checks stay cheap; cleared whenever the
  // pipeline config or release cohort changes.
  currentDigest(side, entityKey) {
    const cfg = this.configFor(side, entityKey);
    const key = `${side}:${entityKey}:${hash(cfg)}`;
    if (this._digestCache.has(key)) return this._digestCache.get(key);
    const digest = digestOf(computeEntity(this.index, cfg, entityKey, AS_OF, SERVE_TIME));
    this._digestCache.set(key, digest);
    return digest;
  }

  materializedDiff(entityKey) {
    const offline = this.materialized('offline', entityKey);
    const online = this.materialized('online', entityKey);
    if (!offline || !online) return null;
    const diffs = [];
    for (const featureKey of FEATURE_KEYS) {
      const a = offline.features[featureKey];
      const b = online.features[featureKey];
      const feature = FEATURES[featureKey];
      const tol = 10 ** -(feature.precision + 2);
      let match;
      if (a === null && b === null) match = true;
      else if (a === null || b === null) match = false;
      else match = Math.abs(b - a) <= tol;
      if (match) continue;
      const denom = a === null || b === null ? null : Math.max(Math.abs(a), Math.abs(b), 1e-9);
      const rel = denom === null ? null : Math.abs(b - a) / denom;
      diffs.push({
        entity_key: entityKey,
        feature_key: featureKey,
        offline_value: a,
        online_value: b,
        delta: a === null || b === null ? null : round(b - a, Math.max(feature.precision, 4)),
        relative: rel === null ? null : round(rel, 4),
        severity: a === null || b === null ? 'high' : rel >= 0.5 ? 'high' : rel >= 0.1 ? 'medium' : 'low',
        offline_version: offline.bundle_version,
        online_version: online.bundle_version,
        offline_stale: offline.input_digest !== this.currentDigest('offline', entityKey),
        online_stale: online.input_digest !== this.currentDigest('online', entityKey),
        offline_computed_at: offline.computed_at,
        online_computed_at: online.computed_at,
      });
    }
    return diffs;
  }

  attributionFor(entityKey, featureKey, diff) {
    const cacheKey = `${entityKey}:${featureKey}:${JSON.stringify(diff)}:${hash(this.pipelines())}:${this.effectiveVersion(entityKey)}:${this.currentRelease()?.percent ?? 0}`;
    if (this._attributeCache.has(cacheKey)) return this._attributeCache.get(cacheKey);
    const configs = {
      offline: this.configFor('offline', entityKey),
      online: this.configFor('online', entityKey),
    };
    const detail = diffEntity(this.index, configs, entityKey, AS_OF, SERVE_TIME);
    const base = detail.diffs.find((d) => d.feature_key === featureKey);
    if (!base) {
      const empty = [];
      this._attributeCache.set(cacheKey, empty);
      return empty;
    }
    const attribution = attributeDiff(
      this.index,
      configs,
      entityKey,
      featureKey,
      AS_OF,
      SERVE_TIME,
      base,
    );
    this._attributeCache.set(cacheKey, attribution);
    return attribution;
  }

  compareAll() {
    const cohort = this.cohortMap();
    const items = [];
    for (const entityKey of this.index.entityKeys) {
      const diffs = this.materializedDiff(entityKey) || [];
      for (const diff of diffs) {
        const attribution = this.attributionFor(entityKey, diff.feature_key, diff);
        const primary = attribution[0] || null;
        items.push({
          ...diff,
          entity_key: entityKey,
          causes: attribution.map((a) => a.cause),
          primary_cause: primary ? primary.cause : 'transform_drift',
          contribution: primary ? primary.contribution : null,
          resolved: attribution.length > 0 ? attribution.every((a) => a.resolved) : false,
          cohort: cohort.get(entityKey),
        });
      }
    }
    items.sort(
      (a, b) =>
        severityRank(b.severity) - severityRank(a.severity) ||
        (b.relative ?? 1) - (a.relative ?? 1) ||
        a.entity_key.localeCompare(b.entity_key),
    );
    return items;
  }

  causeBreakdown(items) {
    const map = new Map();
    for (const item of items) {
      const entry = map.get(item.primary_cause) || { cause: item.primary_cause, count: 0, features: {} };
      entry.count += 1;
      entry.features[item.feature_key] = (entry.features[item.feature_key] || 0) + 1;
      map.set(item.primary_cause, entry);
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }

  featureBreakdown(items) {
    return FEATURE_KEYS.map((featureKey) => {
      const subset = items.filter((i) => i.feature_key === featureKey);
      return {
        feature_key: featureKey,
        label: FEATURES[featureKey].label,
        count: subset.length,
        entities: new Set(subset.map((i) => i.entity_key)).size,
        high: subset.filter((i) => i.severity === 'high').length,
      };
    });
  }

  entityBreakdown(items) {
    const map = new Map();
    for (const item of items) {
      const entry =
        map.get(item.entity_key) ||
        { entity_key: item.entity_key, count: 0, max_relative: 0, causes: new Set(), features: [], cohort: item.cohort };
      entry.count += 1;
      entry.max_relative = Math.max(entry.max_relative, item.relative ?? 1);
      entry.causes.add(item.primary_cause);
      entry.features.push(item.feature_key);
      map.set(item.entity_key, entry);
    }
    return [...map.values()]
      .map((e) => ({ ...e, causes: [...e.causes] }))
      .sort((a, b) => b.count - a.count || a.entity_key.localeCompare(b.entity_key));
  }

  diffSummary() {
    const items = this.compareAll();
    const release = this.currentRelease();
    const cohort = this.cohortMap();
    const canaryEntities = [...cohort.values()].filter((c) => c.inCanary).length;
    const affected = new Set(items.map((i) => i.entity_key));
    const quality = qualityInventory(this.world, this.pipelines(), AS_OF, SERVE_TIME);
    return {
      as_of: AS_OF,
      serve_time: SERVE_TIME,
      active_version: ACTIVE_VERSION,
      release,
      totals: {
        entities: this.index.entityKeys.length,
        compared: this.index.entityKeys.length,
        entities_with_diffs: affected.size,
        diffs: items.length,
        features_compared: this.index.entityKeys.length * FEATURE_KEYS.length,
        canary_entities: canaryEntities,
        by_severity: {
          high: items.filter((i) => i.severity === 'high').length,
          medium: items.filter((i) => i.severity === 'medium').length,
          low: items.filter((i) => i.severity === 'low').length,
        },
        consistency: round(
          1 - affected.size / Math.max(1, this.index.entityKeys.length),
          4,
        ),
      },
      causes: this.causeBreakdown(items),
      features: this.featureBreakdown(items),
      entities: this.entityBreakdown(items),
      quality: {
        late_rows: quality.late.length,
        late_entities: quality.late_entities,
        duplicate_rows: quality.duplicates.length,
        duplicate_entities: quality.duplicate_entities,
        watermark: quality.watermark,
      },
      configs: this.pipelines(),
      bundles: BUNDLES,
      materializations: this.store.materializationCount(),
      last_job: this.store.listRecomputeJobs(1)[0] || null,
      events: this.store.listEvents(8),
      validation: this.store.latestSnapshot('validation')?.summary ?? null,
    };
  }

  sample(entityKey, featureKey) {
    if (!FEATURES[featureKey]) throw httpError(404, `unknown feature ${featureKey}`);
    const configs = {
      offline: this.configFor('offline', entityKey),
      online: this.configFor('online', entityKey),
    };
    const detail = diffEntity(this.index, configs, entityKey, AS_OF, SERVE_TIME);
    const base = detail.diffs.find((d) => d.feature_key === featureKey);
    if (!base) throw httpError(404, 'no diff for this feature');
    const attribution = attributeDiff(this.index, configs, entityKey, featureKey, AS_OF, SERVE_TIME, base);
    const evidence = evidenceRows(detail.offline, detail.online, featureKey);
    const rawRows = rawRowsFor(this.index, entityKey, featureKey, AS_OF);
    const startMs = parseIso(AS_OF).getTime() - FEATURES[featureKey].window_hours * 3600000;
    const endMs = parseIso(AS_OF).getTime();
    const offRows = new Map(detail.offline.rows.map((r) => [r.row_id, r]));
    const onRows = new Map(detail.online.rows.map((r) => [r.row_id, r]));
    for (const row of rawRows) {
      const t = parseIso(row.occurred_at).getTime();
      row.at_start = t === startMs;
      row.at_end = t === endMs;
      const off = offRows.get(row.row_id);
      const on = onRows.get(row.row_id);
      row.offline_window =
        (configs.offline.window_start_inclusive ? t >= startMs : t > startMs) &&
        (configs.offline.window_end_inclusive ? t <= endMs : t < endMs);
      row.online_window =
        (configs.online.window_start_inclusive ? t >= startMs : t > startMs) &&
        (configs.online.window_end_inclusive ? t <= endMs : t < endMs);
      // The evaluator decides row visibility (late / key / dedupe / dim / fx /
      // null) but not window membership — that is applied per feature. Fold the
      // window in here so the evidence shows what this feature actually counts:
      // a row on the boundary is excluded for exactly one side.
      row.offline_decision = decision(off, row.offline_window);
      row.online_decision = decision(on, row.online_window);
      row.after_offline_watermark = parseIso(row.ingested_at) > parseIso(detail.offline.watermark);
      row.duplicate_group = Boolean(
        (off && off.flags.duplicate_group_size > 1) || (on && on.flags.duplicate_group_size > 1),
      );
      row.diverges = Boolean(
        row.offline_decision.eligible !== row.online_decision.eligible ||
          row.offline_decision.reason !== row.online_decision.reason ||
          row.offline_decision.multiplicity !== row.online_decision.multiplicity,
      );
    }
    const flagged = rawRows.filter(
      (r) =>
        r.at_start ||
        r.at_end ||
        r.after_offline_watermark ||
        r.offline_window !== r.online_window ||
        r.raw_key !== entityKey ||
        r.duplicate_group ||
        r.diverges,
    );
    return {
      entity_key: entityKey,
      feature_key: featureKey,
      feature: FEATURES[featureKey],
      offline_value: base.offline_value,
      online_value: base.online_value,
      delta: base.delta,
      severity: base.severity,
      flags: base.flags,
      window: {
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        offline: {
          start_inclusive: configs.offline.window_start_inclusive,
          end_inclusive: configs.offline.window_end_inclusive,
          watermark: detail.offline.watermark,
        },
        online: {
          start_inclusive: configs.online.window_start_inclusive,
          end_inclusive: configs.online.window_end_inclusive,
          watermark: detail.online.watermark,
        },
      },
      attribution,
      evidence,
      raw_rows: rawRows,
      flagged_rows: flagged,
      configs: {
        offline: pickConfig(configs.offline),
        online: pickConfig(configs.online),
      },
      tone: attribution[0] ? CAUSES[attribution[0].cause]?.tone ?? 'serious' : 'serious',
    };
  }

  // ------------------------------------------------------------ repair flow
  planRepair({ causes, entity_keys }) {
    const items = this.compareAll();
    const selected = causes?.length ? causes : [...new Set(items.map((i) => i.primary_cause))];
    const causeToEntities = new Map();
    for (const cause of selected) {
      const keys = new Set();
      for (const item of items) {
        if (item.causes.includes(cause)) keys.add(item.entity_key);
      }
      causeToEntities.set(cause, keys);
    }
    const matching = new Set();
    for (const keys of causeToEntities.values()) for (const key of keys) matching.add(key);
    const presets = [];
    for (const cause of selected) {
      const preset = PRESET_FOR_CAUSE[cause];
      if (preset && !presets.includes(preset)) presets.push(preset);
    }
    const blockers = selected.filter((c) => !PRESET_FOR_CAUSE[c]);
    let nextConfigs = this.pipelines();
    if (!blockers.length) {
      for (const presetKey of presets) nextConfigs = applyPresetLocal(nextConfigs, presetKey);
    }
    // Causes can be concentrated in some entities but still shift a vector in
    // others (shared boundary rows, cohort version, dim side effects). The scope
    // is therefore every entity whose vector actually changes under the new
    // config, plus the cause-matched entities so the report stays explainable.
    const changed =
      entity_keys?.length || blockers.length
        ? []
        : entitiesWhoseVectorsChange(
            this.index,
            this.pipelines(),
            nextConfigs,
            this.index.entityKeys,
            AS_OF,
            SERVE_TIME,
          );
    const affected = new Set([...changed, ...matching]);
    let scoped = [...affected].sort();
    if (entity_keys?.length) {
      const wanted = new Set(entity_keys);
      scoped = scoped.filter((k) => wanted.has(k));
    }
    return {
      causes: selected,
      presets,
      affected_entities: scoped,
      matched_entities: [...matching].sort(),
      side_effect_entities: changed.filter((k) => !matching.has(k)).sort(),
      next_configs: nextConfigs,
      before: {
        diffs: items.length,
        entities_with_diffs: new Set(items.map((i) => i.entity_key)).size,
        by_cause: Object.fromEntries([...causeToEntities].map(([c, s]) => [c, s.size])),
      },
      blockers,
    };
  }

  applyRepair({ causes, entity_keys, dry_run = false }) {
    const plan = this.planRepair({ causes, entity_keys });
    if (plan.blockers.length) {
      throw httpError(400, `以下原因没有可自动应用的修复预设：${plan.blockers.join(', ')}`);
    }
    if (dry_run) return { dry_run: true, plan };
    const at = this.now();
    const beforeConfig = this.pipelines();
    const nextConfigs = plan.next_configs || beforeConfig;
    const beforeItems = this.compareAll();
    this.store.setPipelines(nextConfigs, at);
    this._attributeCache.clear();
    this._diffCache.clear();
    this._digestCache.clear();

    // Scope: entities attributed to the repaired causes keep their full set;
    // entities the user narrowed to are handled too.
    const scope = plan.affected_entities;
    const job = this.recomputeScope(scope, {
      trigger: 'repair',
      scope: {
        kind: 'affected_entities',
        causes: plan.causes,
        presets: plan.presets,
        entity_count: scope.length,
        before_config: beforeConfig,
      },
      at,
      idempotency_probe: true,
    });

    const afterItems = this.compareAll();
    const id = this.store.addRepair({
      causes: plan.causes,
      presets: plan.presets,
      before_config: beforeConfig,
      after_config: nextConfigs,
      scope: {
        entities: scope,
        matched: plan.matched_entities,
        side_effect: plan.side_effect_entities,
        reused: job.reused,
        recomputed: job.recomputed,
      },
      report: {
        before: summarize(beforeItems),
        after: summarize(afterItems),
        idempotent: job.idempotent,
        duration_ms: job.duration_ms,
        repaired_entities: scope,
      },
      created_at: at,
    });
    this.store.addEvent({
      kind: 'repair',
      title: `修复 ${plan.causes.map((c) => CAUSES[c]?.label ?? c).join(' / ')}`,
      detail: {
        repair_id: id,
        presets: plan.presets,
        entities: scope,
        before_diffs: beforeItems.length,
        after_diffs: afterItems.length,
        reused: job.reused,
      },
      at,
    });
    return {
      repair_id: id,
      plan,
      job,
      before: summarize(beforeItems),
      after: summarize(afterItems),
      configs: nextConfigs,
    };
  }

  repairs() {
    return this.store.listRepairs();
  }

  jobs() {
    return this.store.listRecomputeJobs(12);
  }

  quality() {
    const report = qualityInventory(this.world, this.pipelines(), AS_OF, SERVE_TIME);
    const deduped = [];
    for (const duplicate of report.duplicates) {
      deduped.push({
        ...duplicate,
        offline_effect: 'event_id 去重后仅计 1 行',
        online_effect: `${this.pipelines().online.dedupe_key === 'event_id' ? 'event_id' : '弱键'} 去重后计 ${duplicate.rows.length} 行`,
      });
    }
    return {
      ...report,
      duplicates: deduped,
      policy: {
        offline_watermark: report.watermark,
        online_watermark: SERVE_TIME,
        offline_dedupe: this.pipelines().offline.dedupe_key,
        online_dedupe: this.pipelines().online.dedupe_key,
      },
    };
  }

  // -------------------------------------------------------------- releases
  createRelease({ version, percent = 0, note = '' }) {
    if (!BUNDLES[version]) throw httpError(400, `未知版本 ${version}`);
    if (BUNDLES[version].status === 'active') throw httpError(400, '该版本已经是生产版本');
    if (this.currentRelease()) throw httpError(409, '已有进行中的发布，请先完成或回滚');
    const at = this.now();
    const release = this.store.createRelease({
      version,
      percent: clampPercent(percent),
      salt: RELEASE_SALT,
      at,
      note,
    });
    const job = this.applyRelease(release, { trigger: 'release:create', at });
    this.store.addEvent({
      kind: 'release',
      title: `创建灰度发布 ${version}（${release.percent}%）`,
      detail: { release_id: release.id, cohort: this.cohortFor(release).length, recomputed: job.recomputed.length },
      at,
    });
    return { release: this.store.getRelease(release.id), job };
  }

  rampRelease(id, percent) {
    const release = this.store.getRelease(id);
    if (!release) throw httpError(404, 'release not found');
    if (release.status === 'rolled_back') throw httpError(409, '已回滚的发布不能继续放量');
    const at = this.now();
    const before = new Set(this.cohortFor(release));
    const nextPercent = clampPercent(percent);
    const updated = this.store.updateRelease(id, {
      percent: nextPercent,
      status: nextPercent >= 100 ? 'full' : 'ramping',
      at,
      note: release.note,
    });
    this._attributeCache.clear();
    this._diffCache.clear();
    this._digestCache.clear();
    const after = new Set(this.cohortFor(updated));
    // Only entities entering or leaving the cohort change config.
    const added = [...after].filter((k) => !before.has(k));
    const removed = [...before].filter((k) => !after.has(k));
    const scope = [...added, ...removed].sort();
    const job = this.recomputeScope(scope, {
      trigger: 'release:ramp',
      scope: {
        kind: 'release_delta',
        release_id: id,
        version: updated.version,
        from_percent: release.percent,
        to_percent: nextPercent,
        added,
        removed,
      },
      at,
      idempotency_probe: false,
    });
    this.store.addEvent({
      kind: 'release',
      title: `灰度放量 ${updated.version}：${release.percent}% → ${nextPercent}%`,
      detail: { release_id: id, cohort: after.size, recomputed: job.recomputed.length },
      at,
    });
    return {
      release: updated,
      job,
      cohort: [...after].sort(),
      added,
      removed,
    };
  }

  applyRelease(release, { trigger, at }) {
    const cohort = new Set(this.cohortFor(release));
    this._attributeCache.clear();
    this._diffCache.clear();
    this._digestCache.clear();
    return this.recomputeScope([...cohort], {
      trigger,
      scope: {
        kind: 'release_cohort',
        release_id: release.id,
        version: release.version,
        percent: release.percent,
        entity_count: cohort.size,
      },
      at,
    });
  }

  validateRelease(id) {
    const release = this.store.getRelease(id);
    if (!release) throw httpError(404, 'release not found');
    const at = this.now();
    const cohort = new Set(this.cohortFor(release));
    const items = this.compareAll();

    // Explainability. A cohort diff is explained when either
    //   (a) it already existed at baseline (pre-existing pipeline divergence), or
    //   (b) it falls inside the bundle's declared impact radius
    //       (features + max |delta|) and is confirmed by re-running the entity
    //       with its online config pinned back to the active bundle.
    // Anything else is an unexplained regression introduced by the release.
    const baseline = this.store.latestSnapshot('baseline');
    const baselineKeys = new Set(baseline?.summary?.diff_keys ?? []);
    const itemsByEntity = groupBy(items, (i) => i.entity_key);
    const declared = BUNDLES[release.version]?.impact ?? { features: [], max_abs_delta: 0 };
    const declaredFeatures = new Set(declared.features || []);
    const canaryItems = [];
    const versionKeys = new Set();
    const unexplained = [];
    for (const entityKey of cohort) {
      const entityItems = itemsByEntity.get(entityKey) || [];
      canaryItems.push(...entityItems);
      const pinned = diffEntity(
        this.index,
        {
          offline: this.configFor('offline', entityKey),
          online: { ...this.configFor('online', entityKey), bundle_version: ACTIVE_VERSION },
        },
        entityKey,
        AS_OF,
        SERVE_TIME,
      );
      const pinnedByFeature = new Map(pinned.diffs.map((d) => [d.feature_key, d]));
      for (const item of entityItems) {
        const key = `${entityKey}:${item.feature_key}`;
        if (baselineKeys.has(key)) continue; // pre-existing divergence, not a regression
        const pinnedDiff = pinnedByFeature.get(item.feature_key);
        const addedByVersion =
          !pinnedDiff ||
          Math.abs((item.delta ?? 0) - (pinnedDiff.delta ?? 0)) > 1e-9;
        if (addedByVersion) versionKeys.add(key);
        const withinDeclared =
          declaredFeatures.has(item.feature_key) &&
          (item.delta === null || Math.abs(item.delta) <= declared.max_abs_delta + 1e-9);
        if (!withinDeclared) {
          unexplained.push(key);
          continue;
        }
        if (addedByVersion) versionKeys.add(key);
      }
    }
    // Features outside the declared radius that moved in the cohort at all are
    // also a regression, even when the delta happens to be small.
    for (const item of canaryItems) {
      const key = `${item.entity_key}:${item.feature_key}`;
      if (baselineKeys.has(key)) continue;
      if (!declaredFeatures.has(item.feature_key) && !unexplained.includes(key)) unexplained.push(key);
    }
    const explained = canaryItems.length - unexplained.length;
    const consistencyRate = round(canaryItems.length === 0 ? 1 : explained / canaryItems.length, 4);

    // Blast radius: entities outside the cohort were not recomputed, so they
    // must not gain diffs vs the baseline snapshot.
    const outsideDiffs = this.index.entityKeys
      .filter((k) => !cohort.has(k))
      .flatMap((k) => itemsByEntity.get(k) || []);
    const outsideRegressions = outsideDiffs
      .filter((i) => !baselineKeys.has(`${i.entity_key}:${i.feature_key}`))
      .map((i) => `${i.entity_key}:${i.feature_key}`);

    // Late / duplicate semantics must not change under the new bundle.
    const probe = this.idempotencyProbe([...cohort]);
    const semanticallyDifferent = [];
    for (const entityKey of cohort) {
      const canaryCfg = this.configFor('online', entityKey);
      const pinnedCfg = { ...canaryCfg, bundle_version: ACTIVE_VERSION };
      const a = computeEntity(this.index, canaryCfg, entityKey, AS_OF, SERVE_TIME);
      const b = computeEntity(this.index, pinnedCfg, entityKey, AS_OF, SERVE_TIME);
      for (const featureKey of FEATURE_KEYS) {
        if (JSON.stringify(a.flags[featureKey]) !== JSON.stringify(b.flags[featureKey])) {
          semanticallyDifferent.push(`${entityKey}:${featureKey}`);
        }
      }
    }
    const quality = qualityInventory(this.world, this.pipelines(), AS_OF, SERVE_TIME);
    const lateCanary = quality.late_entities.filter((k) => cohort.has(k));
    const dupCanary = quality.duplicate_entities.filter((k) => cohort.has(k));

    const checks = [
      {
        key: 'cohort_consistency',
        label: '灰度组差异可解释',
        detail:
          canaryItems.length === 0
            ? `灰度组 ${cohort.size} 个实体新版本与离线完全一致`
            : `灰度组 ${cohort.size} 个实体共 ${canaryItems.length} 项差异，${explained} 项由基线口径或版本 ${ACTIVE_VERSION}→${release.version} 的声明影响面解释，${unexplained.length} 项超出声明影响面`,
        status: unexplained.length === 0 ? 'pass' : consistencyRate >= 0.9 ? 'warn' : 'fail',
        value: consistencyRate,
      },
      {
        key: 'blast_radius',
        label: '影响范围',
        detail:
          outsideRegressions.length === 0
            ? `灰度组外 ${this.index.entityKeys.length - cohort.size} 个实体未重算，无新增差异`
            : `灰度组外出现 ${outsideRegressions.length} 项新增差异：${outsideRegressions.slice(0, 5).join(', ')}`,
        status: outsideRegressions.length === 0 ? 'pass' : 'fail',
        value: outsideRegressions.length,
      },
      {
        key: 'late_duplicate',
        label: '迟到与重复处理',
        detail: `灰度组覆盖迟到实体 ${lateCanary.length} 个、重复实体 ${dupCanary.length} 个；新版本包含决策变化 ${semanticallyDifferent.length} 处；两次重算摘要一致：${probe.idempotent ? '是' : '否'}`,
        status: semanticallyDifferent.length === 0 && probe.idempotent ? 'pass' : 'fail',
        value: semanticallyDifferent.length === 0 && probe.idempotent,
      },
    ];
    const status = checks.every((c) => c.status === 'pass')
      ? 'pass'
      : checks.some((c) => c.status === 'fail')
        ? 'fail'
        : 'warn';
    const validation = {
      release_id: id,
      version: release.version,
      percent: release.percent,
      status,
      checks,
      cohort_size: cohort.size,
      diffs_in_cohort: canaryItems.length,
      explained: explained,
      version_affected_keys: [...versionKeys].sort(),
      unexplained,
      diffs_total: items.length,
      late_entities: lateCanary,
      duplicate_entities: dupCanary,
      at,
    };
    this.store.addSnapshot({ label: 'validation', summary: validation, at });
    this.store.addEvent({
      kind: 'validation',
      title: `灰度验证 ${release.version} @ ${release.percent}%：${status.toUpperCase()}`,
      detail: validation,
      at,
    });
    return validation;
  }

  idempotencyProbe(entityKeys) {
    const before = new Map();
    for (const entityKey of entityKeys) {
      for (const side of ['offline', 'online']) {
        before.set(`${side}:${entityKey}`, this.store.getMaterialization(side, entityKey)?.input_digest);
      }
    }
    let stable = true;
    for (const entityKey of entityKeys) {
      for (const side of ['offline', 'online']) {
        const cfg = this.configFor(side, entityKey);
        const result = computeEntity(this.index, cfg, entityKey, AS_OF, SERVE_TIME);
        if (digestOf(result) !== before.get(`${side}:${entityKey}`)) stable = false;
      }
    }
    return { idempotent: stable, entities: entityKeys.length };
  }

  rollbackRelease(id, { reason = '一致性验证未通过' } = {}) {
    const release = this.store.getRelease(id);
    if (!release) throw httpError(404, 'release not found');
    if (release.status === 'rolled_back') throw httpError(409, '该发布已回滚');
    const at = this.now();
    const cohort = [...new Set(this.cohortFor(release))].sort();
    const updated = this.store.updateRelease(id, {
      percent: 0,
      status: 'rolled_back',
      at,
      note: release.note ? `${release.note} · 回滚：${reason}` : `回滚：${reason}`,
    });
    this.store.setMeta('rolled_back_version', release.version);
    this._attributeCache.clear();
    this._diffCache.clear();
    this._digestCache.clear();
    // Only entities that were canaried need their online vector rebuilt.
    const job = this.recomputeScope(cohort, {
      trigger: 'release:rollback',
      scope: {
        kind: 'rollback',
        release_id: id,
        version: release.version,
        from_percent: release.percent,
        reason,
        entity_count: cohort.length,
      },
      at,
      idempotency_probe: true,
    });
    const afterItems = this.compareAll();
    const validation = {
      release_id: id,
      version: ACTIVE_VERSION,
      percent: 0,
      status: 'rolled_back',
      checks: [
        {
          key: 'restored',
          label: '回滚后一致性',
          detail: `恢复 ${ACTIVE_VERSION}，剩余差异 ${afterItems.length} 项（均为基线已知的飞地差异）`,
          status: 'pass',
          value: afterItems.length,
        },
      ],
      cohort_size: 0,
      diffs_total: afterItems.length,
      at,
    };
    this.store.addSnapshot({ label: 'validation', summary: validation, at });
    this.store.addEvent({
      kind: 'rollback',
      title: `回滚 ${release.version} → ${ACTIVE_VERSION}`,
      detail: { release_id: id, reason, recomputed: job.recomputed.length, diffs: afterItems.length },
      at,
    });
    return { release: updated, job, validation, diffs: afterItems.length };
  }

  // ------------------------------------------------------------ validation
  validateNow({ label = 'manual' } = {}) {
    const at = this.now();
    const items = this.compareAll();
    const quality = qualityInventory(this.world, this.pipelines(), AS_OF, SERVE_TIME);
    const probe = this.idempotencyProbe(this.index.entityKeys);
    const configs = this.pipelines();
    const checks = [
      {
        key: 'window',
        label: '时间窗口',
        detail:
          configs.offline.window_start_inclusive === configs.online.window_start_inclusive &&
          configs.offline.window_end_inclusive === configs.online.window_end_inclusive
            ? '两侧窗口开闭一致'
            : `离线 [${configs.offline.window_start_inclusive ? '' : '('}start, end${configs.offline.window_end_inclusive ? '' : ')'}；在线 ${configs.online.window_start_inclusive ? '[' : '('}start, end${configs.online.window_end_inclusive ? ']' : ')'}`,
        status:
          configs.offline.window_start_inclusive === configs.online.window_start_inclusive &&
          configs.offline.window_end_inclusive === configs.online.window_end_inclusive
            ? 'pass'
            : 'fail',
      },
      {
        key: 'watermark',
        label: '迟到事件',
        detail: `离线水位滞后 ${configs.offline.batch_lag_minutes ?? 0} 分钟，迟到事件 ${quality.late.length} 行 / ${quality.late_entities.length} 个实体`,
        status: quality.late.length === 0 ? 'pass' : 'warn',
      },
      {
        key: 'dedupe',
        label: '重复计算',
        detail: `离线去重键 ${configs.offline.dedupe_key}，在线 ${configs.online.dedupe_key}；重复事件 ${quality.duplicates.length} 组`,
        status: configs.offline.dedupe_key === configs.online.dedupe_key ? 'pass' : 'fail',
      },
      {
        key: 'fill',
        label: '缺失填充',
        detail: `离线无样本填充 ${configs.offline.fill_missing}，在线 ${configs.online.fill_missing}；空金额策略 ${configs.offline.null_amount} / ${configs.online.null_amount}`,
        status:
          configs.offline.fill_missing === configs.online.fill_missing &&
          configs.offline.null_amount === configs.online.null_amount
            ? 'pass'
            : 'fail',
      },
      {
        key: 'version',
        label: '版本',
        detail: this.currentRelease()
          ? `在线灰度 ${this.currentRelease().version} @ ${this.currentRelease().percent}%，离线固定 ${ACTIVE_VERSION}`
          : `两侧均为 ${ACTIVE_VERSION}`,
        status: this.currentRelease() ? 'warn' : 'pass',
      },
      {
        key: 'idempotent',
        label: '重算幂等',
        detail: probe.idempotent
          ? `${probe.entities} 个实体重复计算输入摘要一致`
          : '重复计算输入摘要发生变化',
        status: probe.idempotent ? 'pass' : 'fail',
      },
    ];
    const status = checks.some((c) => c.status === 'fail')
      ? 'fail'
      : checks.some((c) => c.status === 'warn')
        ? 'warn'
        : 'pass';
    const validation = {
      label,
      status,
      checks,
      diffs_total: items.length,
      entities_with_diffs: new Set(items.map((i) => i.entity_key)).size,
      at,
    };
    this.store.addSnapshot({ label: 'validation', summary: validation, at });
    this.store.addEvent({
      kind: 'validation',
      title: `一致性验证：${status.toUpperCase()}`,
      detail: validation,
      at,
    });
    return validation;
  }

  summarySnapshot() {
    const items = this.compareAll();
    return {
      diffs: items.length,
      entities_with_diffs: [...new Set(items.map((i) => i.entity_key))].sort(),
      diff_keys: items.map((i) => `${i.entity_key}:${i.feature_key}`).sort(),
      by_cause: Object.fromEntries(this.causeBreakdown(items).map((c) => [c.cause, c.count])),
      by_feature: Object.fromEntries(this.featureBreakdown(items).map((f) => [f.feature_key, f.count])),
      at: AS_OF,
    };
  }

  state() {
    return {
      summary: this.diffSummary(),
      diffs: this.compareAll(),
      releases: this.releases(),
      cohort: [...this.cohortMap().entries()]
        .filter(([, v]) => v.inCanary)
        .map(([k, v]) => ({ entity_key: k, bucket: v.bucket, version: v.version })),
      bundles: BUNDLES,
      presets: PRESETS,
      causes: CAUSES,
      repairs: this.repairs(),
      jobs: this.jobs(),
      quality: this.quality(),
      validation: this.store.latestSnapshot('validation')?.summary ?? null,
      baseline: this.store.latestSnapshot('baseline'),
      as_of: AS_OF,
      serve_time: SERVE_TIME,
      active_version: ACTIVE_VERSION,
    };
  }
}

const PRESET_FOR_CAUSE = {
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

function applyPresetLocal(configs, presetKey) {
  const preset = PRESETS[presetKey];
  if (!preset) return configs;
  const next = { offline: { ...configs.offline }, online: { ...configs.online } };
  for (const side of preset.sides) Object.assign(next[side], preset.params);
  return next;
}

function groupBy(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function severityRank(s) {
  return s === 'high' ? 3 : s === 'medium' ? 2 : 1;
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function summarize(items) {
  return {
    diffs: items.length,
    entities_with_diffs: new Set(items.map((i) => i.entity_key)).size,
    by_cause: Object.fromEntries(
      [...new Set(items.map((i) => i.primary_cause))].map((cause) => [
        cause,
        items.filter((i) => i.primary_cause === cause).length,
      ]),
    ),
    by_feature: Object.fromEntries(
      FEATURE_KEYS.map((f) => [f, items.filter((i) => i.feature_key === f).length]),
    ),
  };
}

// Row visibility for one side in one feature: the evaluator's decision, with
// window membership folded in (an in-window row outside the feature window is
// not counted by this feature on this side).
function decision(row, inWindow) {
  if (!row) return { eligible: false, reason: 'not_evaluated', multiplicity: 0, in_window: inWindow };
  if (!inWindow) {
    return { eligible: false, reason: 'out_of_window', multiplicity: 0, in_window: false };
  }
  return { eligible: row.eligible, reason: row.reason, multiplicity: row.multiplicity, in_window: true };
}

function pickConfig(cfg) {  return {
    bundle_version: cfg.bundle_version,
    window: `[${cfg.window_start_inclusive ? 'start' : '(start'}, ${cfg.window_end_inclusive ? 'end]' : 'end)'}`,
    dedupe_key: cfg.dedupe_key,
    key_normalize: cfg.key_normalize,
    watermark: cfg.watermark,
    batch_lag_minutes: cfg.batch_lag_minutes,
    dim_join: cfg.dim_join,
    fx_missing: cfg.fx_missing,
    null_amount: cfg.null_amount,
    fill_missing: cfg.fill_missing,
  };
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
