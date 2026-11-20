// SQLite persistence. Materialized feature vectors are the comparison's source
// of truth, which is what makes "only recompute affected entities" enforceable:
// an entity whose materialization was not rebuilt simply keeps its old row.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pipelines (
  side TEXT PRIMARY KEY,
  config TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS materializations (
  side TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  bundle_version TEXT NOT NULL,
  features TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  computed_at INTEGER NOT NULL,
  reused_from TEXT,
  PRIMARY KEY (side, entity_key, config_hash)
);
CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL,
  percent INTEGER NOT NULL,
  status TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  note TEXT
);
CREATE TABLE IF NOT EXISTS repairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  causes TEXT NOT NULL,
  presets TEXT NOT NULL,
  before_config TEXT NOT NULL,
  after_config TEXT NOT NULL,
  scope TEXT NOT NULL,
  report TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  summary TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recompute_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger TEXT NOT NULL,
  scope TEXT NOT NULL,
  recomputed TEXT NOT NULL,
  reused INTEGER NOT NULL,
  idempotent INTEGER NOT NULL,
  verified TEXT,
  duration_ms INTEGER NOT NULL,
  at TEXT NOT NULL
);
`;

const SCHEMA_VERSION = 3;

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  // Demo app: a schema bump rebuilds the derived tables rather than carrying a
  // long migration chain. Raw source rows are generated, so nothing is lost
  // that cannot be re-derived.
  migrate() {
    const current = Number(this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value ?? 0);
    if (current === SCHEMA_VERSION) return;
    for (const table of ['materializations', 'releases', 'repairs', 'events', 'snapshots', 'recompute_jobs', 'pipelines', 'meta']) {
      this.db.exec(`DROP TABLE IF EXISTS ${table};`);
    }
    this.db.exec(SCHEMA);
    this.db.prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?)").run(String(SCHEMA_VERSION));
  }

  close() {
    this.db.close();
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this.db
      .prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  }

  nextSeq() {
    const next = Number(this.getMeta('seq') || 0) + 1;
    this.setMeta('seq', next);
    return next;
  }

  getPipelines() {
    const rows = this.db.prepare('SELECT side, config FROM pipelines').all();
    if (!rows.length) return null;
    const out = {};
    for (const row of rows) out[row.side] = JSON.parse(row.config);
    return out;
  }

  setPipelines(configs, at) {
    const stmt = this.db.prepare(
      'INSERT INTO pipelines(side, config, updated_at) VALUES(?, ?, ?) ON CONFLICT(side) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at',
    );
    for (const side of Object.keys(configs)) stmt.run(side, JSON.stringify(configs[side]), at);
  }

  getMaterialization(side, entityKey, configHash = null) {
    const row = configHash
      ? this.db
          .prepare(
            'SELECT side, entity_key, config_hash, bundle_version, features, input_digest, computed_at, reused_from FROM materializations WHERE side = ? AND entity_key = ? AND config_hash = ? ORDER BY computed_at DESC LIMIT 1',
          )
          .get(side, entityKey, configHash)
      : this.db
          .prepare(
            'SELECT side, entity_key, config_hash, bundle_version, features, input_digest, computed_at, reused_from FROM materializations WHERE side = ? AND entity_key = ? ORDER BY computed_at DESC LIMIT 1',
          )
          .get(side, entityKey);
    if (!row) return null;
    return {
      side: row.side,
      entity_key: row.entity_key,
      config_hash: row.config_hash,
      bundle_version: row.bundle_version,
      features: JSON.parse(row.features),
      input_digest: row.input_digest,
      computed_at: Number(row.computed_at),
      reused_from: row.reused_from,
    };
  }

  putMaterialization(mat) {
    this.db
      .prepare(
        `INSERT INTO materializations(side, entity_key, config_hash, bundle_version, features, input_digest, computed_at, reused_from)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(side, entity_key, config_hash) DO UPDATE SET
           bundle_version = excluded.bundle_version,
           features = excluded.features,
           input_digest = excluded.input_digest,
           computed_at = excluded.computed_at,
           reused_from = excluded.reused_from`,
      )
      .run(
        mat.side,
        mat.entity_key,
        mat.config_hash,
        mat.bundle_version,
        JSON.stringify(mat.features),
        mat.input_digest,
        mat.computed_at,
        mat.reused_from ?? null,
      );
  }

  materializationCount() {
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM materializations').get().n);
  }

  listReleases() {
    return this.db
      .prepare('SELECT * FROM releases ORDER BY id DESC')
      .all()
      .map((r) => ({
        id: Number(r.id),
        version: r.version,
        percent: Number(r.percent),
        status: r.status,
        salt: r.salt,
        created_at: r.created_at,
        updated_at: r.updated_at,
        note: r.note,
      }));
  }

  getRelease(id) {
    return this.listReleases().find((r) => r.id === id) || null;
  }

  createRelease({ version, percent, salt, at, note }) {
    const info = this.db
      .prepare(
        "INSERT INTO releases(version, percent, status, salt, created_at, updated_at, note) VALUES(?, ?, 'canary', ?, ?, ?, ?)",
      )
      .run(version, percent, salt, at, at, note ?? null);
    return this.getRelease(Number(info.lastInsertRowid));
  }

  updateRelease(id, { percent, status, at, note }) {
    const current = this.getRelease(id);
    if (!current) throw new Error(`release ${id} not found`);
    this.db
      .prepare('UPDATE releases SET percent = ?, status = ?, updated_at = ?, note = ? WHERE id = ?')
      .run(percent ?? current.percent, status ?? current.status, at, note ?? current.note, id);
    return this.getRelease(id);
  }

  addRepair(repair) {
    const info = this.db
      .prepare(
        'INSERT INTO repairs(causes, presets, before_config, after_config, scope, report, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        JSON.stringify(repair.causes),
        JSON.stringify(repair.presets),
        JSON.stringify(repair.before_config),
        JSON.stringify(repair.after_config),
        JSON.stringify(repair.scope),
        JSON.stringify(repair.report),
        repair.created_at,
      );
    return Number(info.lastInsertRowid);
  }

  listRepairs() {
    return this.db
      .prepare('SELECT * FROM repairs ORDER BY id DESC')
      .all()
      .map((r) => ({
        id: Number(r.id),
        causes: JSON.parse(r.causes),
        presets: JSON.parse(r.presets),
        before_config: JSON.parse(r.before_config),
        after_config: JSON.parse(r.after_config),
        scope: JSON.parse(r.scope),
        report: JSON.parse(r.report),
        created_at: r.created_at,
      }));
  }

  addEvent({ kind, title, detail, at }) {
    this.db
      .prepare('INSERT INTO events(kind, title, detail, at) VALUES(?, ?, ?, ?)')
      .run(kind, title, JSON.stringify(detail ?? {}), at);
  }

  listEvents(limit = 40) {
    return this.db
      .prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map((e) => ({
        id: Number(e.id),
        kind: e.kind,
        title: e.title,
        detail: JSON.parse(e.detail),
        at: e.at,
      }));
  }

  addSnapshot({ label, summary, at }) {
    this.db
      .prepare('INSERT INTO snapshots(label, summary, at) VALUES(?, ?, ?)')
      .run(label, JSON.stringify(summary), at);
    return Number(this.db.prepare('SELECT last_insert_rowid() AS id').get().id);
  }

  latestSnapshot(label) {
    const row = label
      ? this.db.prepare('SELECT * FROM snapshots WHERE label = ? ORDER BY id DESC LIMIT 1').get(label)
      : this.db.prepare('SELECT * FROM snapshots ORDER BY id DESC LIMIT 1').get();
    if (!row) return null;
    return { id: Number(row.id), label: row.label, summary: JSON.parse(row.summary), at: row.at };
  }

  addRecomputeJob(job) {
    this.db
      .prepare(
        'INSERT INTO recompute_jobs(trigger, scope, recomputed, reused, idempotent, verified, duration_ms, at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        job.trigger,
        JSON.stringify(job.scope),
        JSON.stringify(job.recomputed),
        job.reused,
        job.idempotent ? 1 : 0,
        JSON.stringify(job.verified ?? { checked: 0, drifted: [] }),
        job.duration_ms,
        job.at,
      );
    return Number(this.db.prepare('SELECT last_insert_rowid() AS id').get().id);
  }

  listRecomputeJobs(limit = 20) {
    return this.db
      .prepare('SELECT * FROM recompute_jobs ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map((j) => ({
        id: Number(j.id),
        trigger: j.trigger,
        scope: JSON.parse(j.scope),
        recomputed: JSON.parse(j.recomputed),
        reused: Number(j.reused),
        idempotent: Boolean(j.idempotent),
        verified: j.verified ? JSON.parse(j.verified) : { checked: 0, drifted: [] },
        duration_ms: Number(j.duration_ms),
        at: j.at,
      }));
  }

  clearAll() {
    for (const table of [
      'meta',
      'pipelines',
      'materializations',
      'releases',
      'repairs',
      'events',
      'snapshots',
      'recompute_jobs',
    ]) {
      this.db.exec(`DELETE FROM ${table};`);
    }
    this.db.exec("DELETE FROM sqlite_sequence WHERE name IN ('releases','repairs','events','snapshots','recompute_jobs');");
  }
}
