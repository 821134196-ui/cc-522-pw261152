// Domain specification: features, diff causes, repair presets and version bundles.

export const AS_OF = '2026-11-19T06:00:00Z';
export const COHORT_SIZE = 48; // ACC-2041 .. ACC-2088

export const FEATURES = {
  spend_24h: {
    label: '24h 消费额',
    short: 'spend_24h',
    unit: 'CNY',
    window_hours: 24,
    kind: 'sum_purchase',
    precision: 2,
  },
  txn_count_24h: {
    label: '24h 交易笔数',
    short: 'txn_count_24h',
    unit: '笔',
    window_hours: 24,
    kind: 'count_purchase',
    precision: 0,
  },
  spend_7d: {
    label: '7d 消费额',
    short: 'spend_7d',
    unit: 'CNY',
    window_hours: 168,
    kind: 'sum_purchase',
    precision: 2,
  },
  refund_ratio_7d: {
    label: '7d 退款率',
    short: 'refund_ratio_7d',
    unit: '',
    window_hours: 168,
    kind: 'refund_ratio',
    precision: 4,
  },
  risk_score: {
    label: '风险分',
    short: 'risk_score',
    unit: '',
    window_hours: 168,
    kind: 'derived',
    precision: 4,
  },
};

export const FEATURE_KEYS = Object.keys(FEATURES);

export const TIER_WEIGHTS = {
  standard: 0.2,
  plus: 0.5,
  private: 0.8,
};

// Cause catalog drives the legend, colors, recommended repair and copy.
export const CAUSES = {
  window_boundary: {
    label: '窗口边界',
    tone: 'serious',
    color: 'var(--series-4)',
    summary: '离线窗口 [start, end) 与在线窗口 (start, end] 对边界事件取舍不同。',
    presets: ['window_half_open'],
  },
  late_event: {
    label: '迟到事件',
    tone: 'warning',
    color: 'var(--series-2)',
    summary: '事件在离线批次水位之后才被摄取，离线漏算而在下一次批次才可见。',
    presets: ['fresh_cutoff'],
  },
  duplicate_event: {
    label: '重复计算',
    tone: 'critical',
    color: 'var(--series-8)',
    summary: '在线去重键弱于 event_id，同一事件的不同载荷被重复计入。',
    presets: ['dedupe_event_id'],
  },
  key_mismatch: {
    label: '实体键不一致',
    tone: 'critical',
    color: 'var(--series-5)',
    summary: '源端键存在大小写/空白变体，离线按原始键聚合，在线做了规范化。',
    presets: ['normalize_keys'],
  },
  dim_fanout: {
    label: '维表扇出',
    tone: 'serious',
    color: 'var(--series-3)',
    summary: '维表存在重复有效行，离线裸连接导致事件行被放大。',
    presets: ['dim_latest'],
  },
  dim_missing: {
    label: '维表缺失',
    tone: 'warning',
    color: 'var(--series-7)',
    summary: '离线内连接丢弃无维表记录的事件，在线左连接仍计入。',
    presets: ['dim_latest'],
  },
  fx_unknown: {
    label: '汇率缺失',
    tone: 'warning',
    color: 'var(--series-6)',
    summary: '币种缺少汇率时，离线按原值透传，在线直接跳过该事件。',
    presets: ['fx_strict'],
  },
  missing_value: {
    label: '空值处理',
    tone: 'serious',
    color: 'var(--series-1)',
    summary: '金额为空的事件被离线按 0 计入、在线丢弃，笔数与金额口径不一致。',
    presets: ['null_fill_policy'],
  },
  missing_fill: {
    label: '缺失填充',
    tone: 'serious',
    color: 'var(--series-1)',
    summary: '无样本时离线填充 0，在线返回 null，下游对缺失语义理解不同。',
    presets: ['null_fill_policy'],
  },
  version_mismatch: {
    label: '版本差异',
    tone: 'warning',
    color: 'var(--series-2)',
    summary: '灰度期间离线仍固定在旧版本，在线小流量使用新版本转换逻辑。',
    presets: [],
  },
  transform_drift: {
    label: '转换差异',
    tone: 'serious',
    color: 'var(--series-8)',
    summary: '两侧窗口、去重和填充配置一致，仍出现数值差异，需排查转换实现。',
    presets: [],
  },
};

export const CAUSE_ORDER = Object.keys(CAUSES);

export const PRESETS = {
  window_half_open: {
    label: '统一窗口为 [start, end)',
    detail: '离线与在线都使用左闭右开窗口，边界事件只在一个批次内计入。',
    params: { window_start_inclusive: true, window_end_inclusive: false },
    sides: ['offline', 'online'],
  },
  fresh_watermark: {
    label: '消除离线水位滞后',
    detail: '离线批次水位推进到与在线一致（serve 时刻），不再漏掉批次水位之后的迟到事件。',
    params: { watermark: 'current' },
    sides: ['offline'],
  },
  dedupe_event_id: {
    label: '统一按 event_id 去重',
    detail: '在线改用 event_id 作为幂等键，与离线保持一致，重试和改单不会重复累计。',
    params: { dedupe_key: 'event_id' },
    sides: ['online'],
  },
  normalize_keys: {
    label: '实体键规范化',
    detail: '两侧都执行 trim + 大写规范化，键变体归并到同一实体。',
    params: { key_normalize: true },
    sides: ['offline'],
  },
  dim_latest: {
    label: '维表取最新有效行',
    detail: '按 customer_id 去重取最新 updated_at 的有效行，既避免扇出，也保留缺失维表的左连接。',
    params: { dim_join: 'latest' },
    sides: ['offline'],
  },
  fx_strict: {
    label: '汇率缺失严格跳过',
    detail: '缺少汇率时两侧都跳过该记录并计入数据质量指标，不再透传原值。',
    params: { fx_missing: 'skip' },
    sides: ['offline'],
  },
  null_fill_policy: {
    label: '显式空值策略',
    detail: '空金额一律跳过；无样本时两侧统一返回 null，不以 0 代替。',
    params: { null_amount: 'skip', fill_missing: 'null' },
    sides: ['offline', 'online'],
  },
};

export const PRESET_ORDER = Object.keys(PRESETS);

export const DEFAULT_PIPELINE = {
  offline: {
    bundle_version: '3.2.0',
    window_start_inclusive: true,
    window_end_inclusive: false,
    dedupe_key: 'event_id',
    key_normalize: false,
    watermark: 'batch',
    batch_lag_minutes: 15,
    dim_join: 'raw',
    fx_missing: 'raw_passthrough',
    null_amount: 'fill_zero',
    fill_missing: 'zero',
  },
  online: {
    bundle_version: '3.2.0',
    window_start_inclusive: false,
    window_end_inclusive: true,
    dedupe_key: 'entity_minute_amount',
    key_normalize: true,
    watermark: 'current',
    batch_lag_minutes: 0,
    dim_join: 'latest',
    fx_missing: 'skip',
    null_amount: 'skip',
    fill_missing: 'null',
  },
};

export const BUNDLES = {
  '2.8.0': {
    status: 'superseded',
    notes: '历史版本，仅保留用于回滚验证。',
    risk: { spend_cap: 5000, spend_weight: 0.8, tier_weight: 0.2, refund_weight: 0 },
  },
  '3.0.0': {
    status: 'superseded',
    notes: '引入 7d 退款率特征。',
    risk: { spend_cap: 6000, spend_weight: 0.75, tier_weight: 0.25, refund_weight: 0 },
  },
  '3.2.0': {
    status: 'active',
    notes: '当前生产版本，风险分由 7d 消费与客户等级构成。',
    risk: { spend_cap: 6000, spend_weight: 0.7, tier_weight: 0.3, refund_weight: 0 },
    impact: { features: [], max_abs_delta: 0 },
  },
  '4.0.0': {
    status: 'draft',
    notes: '引入退款率惩罚项并下调等级权重，风险分口径变更。',
    risk: { spend_cap: 6000, spend_weight: 0.55, tier_weight: 0.2, refund_weight: 0.25 },
    // Declared blast radius: only risk_score may move, and by at most 0.25.
    impact: { features: ['risk_score'], max_abs_delta: 0.25 },
  },
  '4.1.0': {
    status: 'draft',
    notes: '候选版本：声明影响面与 4.0.0 相同（风险分 ±0.10），但退款率权重录入错误，实际偏移超出声明。',
    risk: { spend_cap: 6000, spend_weight: 0.55, tier_weight: 0.2, refund_weight: 25 },
    impact: { features: ['risk_score'], max_abs_delta: 0.1 },
  },
};

export const RELEASE_SALT = 'rel-2026.11.20-rc1';
