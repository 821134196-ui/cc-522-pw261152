// Deterministic demo world. The generator only writes raw source data
// (events, customer dimension, FX rates). All feature values, diffs and cause
// attribution are produced by the engine at query time — nothing is hardcoded
// into the comparison layer.

import { mulberry32, addMinutes, parseIso } from './deterministic.js';
import { AS_OF, COHORT_SIZE, TIER_WEIGHTS } from './spec.js';

export const AS_OF_DATE = parseIso(AS_OF);
export const SERVE_TIME = '2026-11-19T06:30:00Z';

function pad(n) {
  return String(n).padStart(2, '0');
}

function at(day, hour, minute = 0, second = 0) {
  // day: 9..19 of 2026-11
  return `2026-11-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second || 0)}Z`;
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function tierFor(index) {
  const tiers = ['standard', 'plus', 'standard', 'private', 'plus', 'standard', 'private', 'plus'];
  return tiers[index % tiers.length];
}

function currencyFor(rng) {
  const r = rng();
  if (r < 0.82) return 'CNY';
  if (r < 0.96) return 'USD';
  return 'EUR';
}

export const DIM_FANOUT_ENTITY = 'ACC-2048';
export const DIM_MISSING_ENTITY = 'ACC-2047';
export const DIM_MISSING_CUSTOMER = 'CUST-9999';
export const FX_MISSING_ENTITY = 'ACC-2053';
export const NULL_AMOUNT_ENTITY = 'ACC-2045';
export const EMPTY_ENTITY = 'ACC-2059';

// Ground truth used by tests / documentation only. The engine never reads it.
export const INJECTED = {
  'ACC-2041': [
    { cause: 'window_boundary', feature: 'spend_24h', note: '11-18T06:00:00 恰在 24h 窗口起点，离线左闭包含、在线右开不含' },
  ],
  'ACC-2042': [
    { cause: 'window_boundary', feature: 'spend_24h', note: '11-19T06:00:00 恰在窗口终点，离线不含、在线右闭包含' },
  ],
  'ACC-2043': [
    { cause: 'late_event', feature: 'spend_24h', note: '03:10 发生、06:12 才摄取，晚于批次 as-of' },
    { cause: 'late_event', feature: 'spend_7d', note: '迟到事件同时影响 7d 窗口' },
  ],
  'ACC-2044': [
    { cause: 'late_event', feature: 'spend_24h', note: '04:05 发生、06:21 摄取' },
  ],
  'ACC-2045': [
    { cause: 'missing_value', feature: 'txn_count_24h', note: '金额为空：离线按 0 计入笔数，在线跳过' },
  ],
  'ACC-2046': [
    { cause: 'duplicate_event', feature: 'spend_24h', note: '同一 event_id 两次投递且金额被修正，在线弱去重键漏掉重复' },
  ],
  'ACC-2047': [
    { cause: 'dim_missing', feature: 'spend_24h', note: '客户维表缺失，离线内连接丢弃全部事件' },
  ],
  'ACC-2048': [
    { cause: 'dim_fanout', feature: 'spend_24h', note: '维表存在两条有效行，离线裸连接放大事件' },
  ],
  'ACC-2049': [
    { cause: 'duplicate_event', feature: 'refund_ratio_7d', note: '退款重试载荷金额不同，在线重复计入' },
  ],
  'ACC-2050': [
    { cause: 'window_boundary', feature: 'spend_24h', note: '起点与终点各有一笔边界事件，方向相反' },
  ],
  'ACC-2051': [
    { cause: 'late_event', feature: 'txn_count_24h', note: '迟到购买' },
  ],
  'ACC-2053': [
    { cause: 'fx_unknown', feature: 'spend_24h', note: 'HKD 无汇率：离线原值透传，在线跳过' },
  ],
  'ACC-2056': [
    { cause: 'key_mismatch', feature: 'spend_24h', note: '源端键存在大小写/空白变体，离线按原始键聚合' },
  ],
  'ACC-2061': [
    { cause: 'key_mismatch', feature: 'spend_24h', note: '源端键尾随空格变体' },
  ],
  'ACC-2059': [
    { cause: 'missing_fill', feature: 'spend_24h', note: '窗口内无样本：离线填 0，在线返回 null' },
    { cause: 'missing_fill', feature: 'risk_score', note: '缺失值语义不同，风险分一侧有值一侧为 null' },
  ],
};

export function keyFor(index) {
  return `ACC-${2041 + index}`;
}

function buildEntities() {
  const entities = [];
  for (let i = 0; i < COHORT_SIZE; i++) {
    const key = keyFor(i);
    const index = i;
    entities.push({
      key,
      tier: tierFor(index),
      segment: ['retail', 'smb', 'wealth'][index % 3],
      region: ['east', 'south', 'north', 'west'][index % 4],
      signup_date: `2025-${pad((index % 12) + 1)}-${pad((index % 27) + 1)}`,
      status: 'active',
    });
  }
  return entities;
}

function buildEvents(entities) {
  const events = [];
  let rowId = 1;

  const push = (row) => {
    events.push({ row_id: rowId++, ...row });
  };

  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];
    const rng = mulberry32(1000 + i * 37);
    if (entity.key === EMPTY_ENTITY) continue; // no source events at all
    const customerId =
      entity.key === DIM_MISSING_ENTITY ? DIM_MISSING_CUSTOMER : `CUST-${entity.key}`;
    const baseAmount = entity.tier === 'private' ? 600 : entity.tier === 'plus' ? 260 : 110;
    const rawKeyBase = entity.key === 'ACC-2056' ? 'acc-2056 ' : entity.key === 'ACC-2061' ? `${entity.key} ` : entity.key;

    const addRandomPurchase = (day, hourLo, hourHi, minuteAny = true) => {
      const hour = hourLo + Math.floor(rng() * (hourHi - hourLo + 1));
      const minute = minuteAny ? Math.floor(rng() * 60) : 0;
      if (day === 19 && (hour > 1 || (hour === 1 && minute > 0))) {
        return null;
      }
      const occurred = at(day, hour, minute, Math.floor(rng() * 60));
      const ingestLag = 3 + Math.floor(rng() * 38);
      const ingested = addMinutes(parseIso(occurred), ingestLag).toISOString().replace('.000Z', 'Z');
      if (parseIso(ingested) > parseIso('2026-11-19T05:50:00Z')) return null;
      const amount = Math.round(baseAmount * (0.3 + rng() * 1.9) * 100) / 100;
      const currency = currencyFor(rng);
      const eventId = `EV-${entity.key}-${day}-${pad(hour)}${pad(minute)}-${Math.floor(rng() * 1e6)}`;
      push({
        event_id: eventId,
        raw_key: rawKeyBase,
        entity_key_norm: entity.key,
        customer_id: customerId,
        type: 'purchase',
        amount,
        currency,
        occurred_at: occurred,
        ingested_at: ingested,
        updated_at: ingested,
      });
      return { eventId, occurred, amount, currency };
    };

    const addRefundFor = (purchase, day, hour, minute) => {
      const occurred = at(day, hour, minute, Math.floor(rng() * 60));
      if (parseIso(occurred) > parseIso('2026-11-19T05:00:00Z')) return;
      const ingestLag = 4 + Math.floor(rng() * 30);
      const ingested = addMinutes(parseIso(occurred), ingestLag).toISOString().replace('.000Z', 'Z');
      const amount = Math.round(purchase.amount * (0.35 + rng() * 0.65) * 100) / 100;
      push({
        event_id: `EV-${entity.key}-R-${day}-${pad(hour)}${pad(minute)}-${Math.floor(rng() * 1e6)}`,
        raw_key: rawKeyBase,
        entity_key_norm: entity.key,
        customer_id: customerId,
        type: 'refund',
        amount,
        currency: purchase.currency,
        occurred_at: occurred,
        ingested_at: ingested,
        updated_at: ingested,
      });
    };

    for (let day = 9; day <= 18; day++) {
      const count = 2 + Math.floor(rng() * 5);
      for (let n = 0; n < count; n++) {
        const purchase = addRandomPurchase(day, 0, 23);
        if (purchase && rng() < 0.16) {
          const refundDay = Math.min(19, day + (rng() < 0.5 ? 0 : 1));
          const refundHour = refundDay === 19 ? Math.floor(rng() * 4) : Math.floor(rng() * 24);
          addRefundFor(purchase, refundDay, refundHour, Math.floor(rng() * 60));
        }
      }
    }
    // Small amount of overnight traffic before the batch as-of.
    const overnight = Math.floor(rng() * 3);
    for (let n = 0; n < overnight; n++) addRandomPurchase(19, 0, 1);

    // Guarantee at least two in-window purchases for every non-empty entity.
    const inWindow = events.filter(
      (e) =>
        e.entity_key_norm === entity.key &&
        e.type === 'purchase' &&
        parseIso(e.occurred_at) >= parseIso('2026-11-18T06:00:00Z') &&
        parseIso(e.occurred_at) < parseIso(AS_OF),
    );
    let guard = 0;
    while (inWindow.length < 2 && guard < 5) {
      const purchase = addRandomPurchase(18, 8, 23);
      if (purchase) inWindow.push(purchase);
      guard++;
    }
  }

  // ---- Injected edge cases (raw records only) -----------------------------

  const add = (row) =>
    push({
      entity_key_norm: row.entity_key_norm,
      raw_key: row.raw_key ?? row.entity_key_norm,
      customer_id: row.customer_id ?? `CUST-${row.entity_key_norm}`,
      type: row.type ?? 'purchase',
      amount: row.amount ?? null,
      currency: row.currency ?? 'CNY',
      occurred_at: row.occurred_at,
      ingested_at: row.ingested_at ?? row.occurred_at,
      updated_at: row.updated_at ?? row.ingested_at ?? row.occurred_at,
      event_id: row.event_id,
    });

  const standardIngest = (occurred, lag = 9) =>
    addMinutes(parseIso(occurred), lag).toISOString().replace('.000Z', 'Z');

  // Window start (left-closed offline / excluded online)
  for (const [entity, amount] of [['ACC-2041', 320], ['ACC-2050', 88]]) {
    const occurred = '2026-11-18T06:00:00Z';
    add({
      event_id: `EV-${entity}-WIN-START`,
      entity_key_norm: entity,
      amount,
      occurred_at: occurred,
      ingested_at: standardIngest(occurred, 4),
    });
  }
  // Window end (excluded offline / right-closed online). Ingested just after the
  // batch as-of, exactly like a real cut-off straddling event.
  for (const [entity, amount] of [['ACC-2042', 199], ['ACC-2050', 175]]) {
    add({
      event_id: `EV-${entity}-WIN-END`,
      entity_key_norm: entity,
      amount,
      occurred_at: '2026-11-19T06:00:00Z',
      ingested_at: '2026-11-19T06:04:00Z',
    });
  }
  // Late events: occurred before as-of, ingested after it (next batch territory).
  add({
    event_id: 'EV-ACC-2043-LATE',
    entity_key_norm: 'ACC-2043',
    amount: 468.5,
    occurred_at: '2026-11-19T03:10:00Z',
    ingested_at: '2026-11-19T06:12:00Z',
  });
  add({
    event_id: 'EV-ACC-2044-LATE',
    entity_key_norm: 'ACC-2044',
    amount: 1290,
    occurred_at: '2026-11-19T04:05:00Z',
    ingested_at: '2026-11-19T06:21:00Z',
  });
  add({
    event_id: 'EV-ACC-2051-LATE',
    entity_key_norm: 'ACC-2051',
    amount: 260,
    occurred_at: '2026-11-19T02:40:00Z',
    ingested_at: '2026-11-19T06:18:00Z',
  });

  // Duplicate delivery with a corrected payload. Offline idempotency is keyed on
  // event_id; online keyed on (entity, minute, amount) and therefore counts both.
  const duplicate = (entity, eventId, firstAmount, secondAmount, detectedAt, lagMinutes) => {
    add({
      event_id: eventId,
      entity_key_norm: entity,
      amount: firstAmount,
      occurred_at: '2026-11-18T09:40:00Z',
      ingested_at: detectedAt,
      updated_at: detectedAt,
    });
    const correctedAt = addMinutes(parseIso(detectedAt), lagMinutes)
      .toISOString()
      .replace('.000Z', 'Z');
    add({
      event_id: eventId,
      entity_key_norm: entity,
      amount: secondAmount,
      occurred_at: '2026-11-18T09:40:00Z',
      ingested_at: correctedAt,
      updated_at: correctedAt,
    });
  };
  duplicate('ACC-2046', 'EV-ACC-2046-DUP', 180, 205, '2026-11-18T10:00:00Z', 22);
  duplicate('ACC-2049', 'EV-ACC-2049-DUP', 96, 120, '2026-11-18T10:10:00Z', 22);
  // Duplicate refund with a corrected amount → refund ratio drift.
  add({
    event_id: 'EV-ACC-2049-R-DUP',
    entity_key_norm: 'ACC-2049',
    type: 'refund',
    amount: 60,
    occurred_at: '2026-11-17T08:15:00Z',
    ingested_at: '2026-11-17T08:40:00Z',
  });
  add({
    event_id: 'EV-ACC-2049-R-DUP',
    entity_key_norm: 'ACC-2049',
    type: 'refund',
    amount: 75,
    occurred_at: '2026-11-17T08:15:00Z',
    ingested_at: '2026-11-17T09:02:00Z',
  });

  // Entity-key variants: the offline job groups on the raw source key.
  for (const [entity, amount, suffix] of [
    ['ACC-2056', 210, '1'],
    ['ACC-2056', 96.4, '2'],
    ['ACC-2061', 144, '1'],
    ['ACC-2061', 58.2, '2'],
  ]) {
    add({
      event_id: `EV-${entity}-KEY-${suffix}`,
      entity_key_norm: entity,
      raw_key: entity === 'ACC-2056' ? ` ${entity.toLowerCase()} ` : `${entity} `,
      amount,
      occurred_at: `2026-11-1${suffix === '1' ? '7' : '8'}T0${suffix === '1' ? '9' : '4'}:20:00Z`,
      ingested_at: `2026-11-1${suffix === '1' ? '7' : '8'}T0${suffix === '1' ? '9' : '4'}:51:00Z`,
    });
  }

  // FX rate missing for HKD.
  add({
    event_id: 'EV-ACC-2053-FX',
    entity_key_norm: 'ACC-2053',
    amount: 320,
    currency: 'HKD',
    occurred_at: '2026-11-18T09:00:00Z',
    ingested_at: '2026-11-18T09:22:00Z',
  });

  // Null amount purchase.
  add({
    event_id: 'EV-ACC-2045-NULL',
    entity_key_norm: 'ACC-2045',
    amount: null,
    occurred_at: '2026-11-18T12:00:00Z',
    ingested_at: '2026-11-18T12:14:00Z',
  });

  return events;
}

function buildDim(entities) {
  const rows = [];
  let id = 1;
  for (const entity of entities) {
    rows.push({
      id: id++,
      customer_id: `CUST-${entity.key}`,
      entity_key: entity.key,
      tier: entity.tier,
      segment: entity.segment,
      effective_from: '2025-01-01T00:00:00Z',
      effective_to: '2026-12-31T23:59:59Z',
      updated_at: '2026-10-01T00:00:00Z',
    });
  }
  // Fan-out: two concurrently valid rows for the same customer.
  const fanout = rows.find((r) => r.entity_key === DIM_FANOUT_ENTITY);
  rows.push({
    ...fanout,
    id: id++,
    segment: 'wealth',
    updated_at: '2026-11-02T00:00:00Z',
  });
  return rows;
}

export function buildWorld() {
  const entities = buildEntities();
  const events = buildEvents(entities);
  const dim = buildDim(entities);
  const fx = [
    { currency: 'CNY', rate: 1 },
    { currency: 'USD', rate: 7.08 },
    { currency: 'EUR', rate: 7.72 },
  ];
  return { entities, events, dim, fx };
}

export function entityNote(entityKey) {
  return INJECTED[entityKey] || [];
}

export const TIER_VALUE = TIER_WEIGHTS;
