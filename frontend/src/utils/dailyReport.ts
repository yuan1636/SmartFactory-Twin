/**
 * 工厂日报的计算（/ai 页，spec_phase4 偏差 D-74）。
 *
 * 为什么单独抽成纯函数：页面上的「预计影响件数」是按公式算出来的，验收要求
 * 每一行都能用页面底部公式复算。算在组件里就没法单测，也没法证明「不是随手写的数」。
 * 这里只做四则运算，所有系数（节拍、降速、处置时长、单价、不良率、分档阈值）
 * 一律由调用方从 /report/config 传进来，本文件不出现任何业务常量。
 */

import type { ReportConfig } from '../services/types';

/** 分数曲线的一个采样点（/ml/anomaly/scores 的 points 元素）。 */
export interface ScorePointLike {
  ts: string;
  score: number;
  is_anomaly: boolean;
}

/** 一段连续被判为异常的区间。 */
export interface AnomalySegment {
  startedAt: number;
  endedAt: number;
  /** 段内最大分数，即「异常分数峰值」 */
  peak: number;
  /** 持续秒数，含最后一个采样间隔（否则单点段时长为 0） */
  seconds: number;
  points: number;
}

export type ActionLevel = 'stop' | 'today' | 'observe';

export interface TodoRow {
  deviceId: string;
  lineId: string;
  anomalyType: string;
  /** 人话现象，如「振动 3.49 mm/s，比正常上限高 16%」；无读数时为纯类型文案 */
  symptom: string;
  peak: number;
  /** 异常已持续分钟数（不含处置时长） */
  activeMinutes: number;
  /** 计算影响件数用的总时长 = 已持续 + 该类型预计处置时长 */
  totalMinutes: number;
  impact: number;
  riskScore: number;
  action: ActionLevel;
  cycle: number;
  cycleSource: 'order' | 'config';
  slowdown: number;
  handlingMinutes: number;
}

export interface DeliveryRow {
  orderId: string;
  lineId: string;
  productId: string;
  remaining: number;
  /** 计划节拍（件/分钟） */
  cycle: number;
  /** 计入该线降速后的实际节拍 */
  effectiveCycle: number;
  finishAt: number;
  plannedEnd: number;
  delayHours: number;
}

export interface MonthlyLoss {
  /** 去重后的异常次数（同一设备同一类型同一开始时刻的重复行只算一次） */
  count: number;
  /** 影响产量（件） */
  output: number;
  /** 不良件数（件） */
  defects: number;
  /** 折合金额；单价未配置时为 null，页面不许显示 0 元 */
  amount: number | null;
}

/* ------------------------------------------------------------------ */
/* 1. 异常段                                                           */
/* ------------------------------------------------------------------ */

/**
 * 取曲线里**最后一段**连续判为异常的区间。
 *
 * 为什么取最后一段而不是全窗口求和：日报要回答「这台设备现在/刚才出了什么事」，
 * 两小时窗口里可能有多次注入，把历史都算进来会让「已恢复」的设备一直挂在待办顶部。
 */
export function lastAnomalySegment(points: ScorePointLike[], sampleSeconds: number): AnomalySegment | null {
  let end = -1;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    if (points[i].is_anomaly) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;

  let start = end;
  while (start > 0 && points[start - 1].is_anomaly) start -= 1;

  let peak = 0;
  for (let i = start; i <= end; i += 1) peak = Math.max(peak, points[i].score);

  const startedAt = Date.parse(points[start].ts);
  const endedAt = Date.parse(points[end].ts);
  // 两端时间戳之差是「首末采样点间隔」，真实持续时长还要加上最后一个采样周期
  const seconds = Math.max(sampleSeconds, (endedAt - startedAt) / 1000 + sampleSeconds);

  return { startedAt, endedAt, peak, seconds, points: end - start + 1 };
}

export interface IntervalLike {
  started_at: string;
  ended_at: string | null;
  anomaly_type?: string;
}

export interface PickedSegment {
  segment: AnomalySegment;
  anomalyType: string | null;
}

/**
 * 日报用的「异常段」：**优先用注入真值区间**，而不是模型连续判真点。
 *
 * 为什么：模型是逐点阈值判定，一次 90 秒的注入常常只判出 1~2 个孤立点（实测 CONV-01
 * 最后一段只有 1 个点 → 持续 2 秒），拿它算「持续时长」会得出 0.03 分钟这种没有
 * 决策意义的数，风险分也永远趋近 0。真值区间的起止是注入器写的标准答案，时长稳定。
 * 峰值仍取模型分数（区间内 points 的最大 score），所以「峰值 × 持续时长」两因子都真实。
 *
 * 区间内没有模型点时**不猜**：换下一段；全都没有就退回模型连续段。
 */
export function pickSegment(
  points: ScorePointLike[],
  intervals: IntervalLike[],
  sampleSeconds: number,
): PickedSegment | null {
  // 库里存在同一次注入被写两遍的重复行（实测 id 1162 / 1163 完全一致），先按内容去重
  const unique = new Map<string, IntervalLike>();
  for (const item of intervals) {
    const key = `${item.started_at}|${item.ended_at ?? ''}|${item.anomaly_type ?? ''}`;
    if (!unique.has(key)) unique.set(key, item);
  }

  const ordered = [...unique.values()].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  for (const item of ordered) {
    const startedAt = Date.parse(item.started_at);
    const endedAt = item.ended_at ? Date.parse(item.ended_at) : startedAt + sampleSeconds * 1000;
    let peak = Number.NEGATIVE_INFINITY;
    let hits = 0;
    for (const p of points) {
      const t = Date.parse(p.ts);
      if (t >= startedAt && t <= endedAt) {
        peak = Math.max(peak, p.score);
        hits += 1;
      }
    }
    if (hits === 0) continue;
    return {
      segment: {
        startedAt,
        endedAt,
        peak,
        seconds: Math.max(sampleSeconds, (endedAt - startedAt) / 1000),
        points: hits,
      },
      anomalyType: item.anomaly_type ?? null,
    };
  }

  const fallback = lastAnomalySegment(points, sampleSeconds);
  return fallback ? { segment: fallback, anomalyType: null } : null;
}

/* ------------------------------------------------------------------ */
/* 2. 节拍：优先用订单反推，缺订单时才用配置假设值                      */
/* ------------------------------------------------------------------ */

/** 由一张订单反推计划节拍（件/分钟）：计划数量 / 计划时长。 */
export function plannedCycle(order: {
  planned_quantity: number;
  planned_start: string;
  planned_end: string;
}): number | null {
  const minutes = (Date.parse(order.planned_end) - Date.parse(order.planned_start)) / 60_000;
  if (!(minutes > 0) || !(order.planned_quantity > 0)) return null;
  return order.planned_quantity / minutes;
}

export interface Rhythm {
  cycle: number;
  source: 'order' | 'config';
}

/**
 * 某条线的节拍。理由：订单里的「计划数量 / 计划时长」是工厂自己排的产能，
 * 比配置里的假设值更硬；只有该线没有可解析的订单时才退回配置。
 */
export function lineRhythm(
  lineId: string,
  orders: Array<{ line_id: string; planned_quantity: number; planned_start: string; planned_end: string }>,
  config: ReportConfig,
): Rhythm | null {
  const mine = orders
    .filter((o) => o.line_id === lineId)
    .map((o) => ({ o, cycle: plannedCycle(o) }))
    .filter((x): x is { o: (typeof orders)[number]; cycle: number } => x.cycle != null);
  if (mine.length > 0) {
    // 取最新一张（不依赖接口返回顺序，显式比较 planned_start）
    const latest = mine.reduce((a, b) =>
      Date.parse(a.o.planned_start) >= Date.parse(b.o.planned_start) ? a : b,
    );
    return { cycle: latest.cycle, source: 'order' };
  }
  const fallback = config.lines[lineId]?.cycle_per_minute;
  return fallback > 0 ? { cycle: fallback, source: 'config' } : null;
}

/* ------------------------------------------------------------------ */
/* 3. 现象：用人话，不出现指标术语                                      */
/* ------------------------------------------------------------------ */

/** 指标中文名。只用于「现象」一列，页面上不许出现 PR-AUC / F1 这类术语。 */
const METRIC_WORD: Record<string, string> = {
  temperature: '温度',
  vibration: '振动',
  current: '电流',
};

const METRIC_UNIT: Record<string, string> = {
  temperature: '℃',
  vibration: 'mm/s',
  current: 'A',
};

/**
 * 现象文案。传入的值应当是**异常区间内的峰值**（不是此刻读数），否则会出现
 * 「振动 1.69 mm/s，正常上限 2.5」这种异常已恢复后的自相矛盾描述。
 * 没有读数就只说类型——不许为了凑一句话编一个数出来。
 */
export function symptomText(
  anomalyType: string,
  label: string,
  latest: { temperature: number | null; vibration: number | null; current: number | null } | null,
  normalRange: Partial<Record<string, { min: number; max: number }>> | null,
): string {
  const metric =
    anomalyType === 'VIB_SPIKE' ? 'vibration' : anomalyType === 'TEMP_DRIFT' ? 'temperature' : 'current';
  const value = latest ? (latest as Record<string, number | null>)[metric] : null;
  const range = normalRange?.[metric];
  if (value == null || !range || !(range.max > 0)) {
    return `${label}持续异常`;
  }
  const pct = Math.round(((value - range.max) / range.max) * 100);
  const word = METRIC_WORD[metric] ?? metric;
  const unit = METRIC_UNIT[metric] ?? '';
  if (pct > 0) return `${word} ${value} ${unit}，比正常上限高 ${pct}%`;
  // 峰值没超过上限时不硬说「偏高」：只陈述事实，避免页面自相矛盾
  return `${word} ${value} ${unit}（正常上限 ${range.max} ${unit}）`;
}

/* ------------------------------------------------------------------ */
/* 4. 待办清单                                                         */
/* ------------------------------------------------------------------ */

function actionOf(impact: number, thresholds: { stop: number; today: number }): ActionLevel {
  if (impact > thresholds.stop) return 'stop';
  if (impact >= thresholds.today) return 'today';
  return 'observe';
}

export interface TodoInput {
  scores: Array<{
    deviceId: string;
    anomalyType: string;
    segment: AnomalySegment;
    latest: { temperature: number | null; vibration: number | null; current: number | null } | null;
    normalRange: Partial<Record<string, { min: number; max: number }>> | null;
  }>;
  devices: Array<{ device_id: string; line_id: string | null }>;
  orders: Array<{ line_id: string; planned_quantity: number; planned_start: string; planned_end: string }>;
  config: ReportConfig;
  /** 最多返回几行 */
  limit?: number;
}

/**
 * 待办行：影响件数 = 总时长(分钟) × 该线节拍(件/分) × 该类型降速比例。
 * 总时长 = 异常已持续分钟 + 该类型预计处置分钟（后者的来源是 config 假设值）。
 * 只用「异常持续」会得出 0.5 件这种没有决策意义的数——处置本身也在占用产能。
 */
export function buildTodoRows({ scores, devices, orders, config, limit = 5 }: TodoInput): TodoRow[] {
  const lineOf = new Map(devices.map((d) => [d.device_id, d.line_id]));
  const rows: TodoRow[] = [];

  for (const item of scores) {
    const lineId = lineOf.get(item.deviceId);
    if (!lineId) continue;
    const handling = config.anomaly_handling[item.anomalyType];
    if (!handling) continue; // 类型没有处置参数 → 不猜，直接跳过（页面会提示配置缺失）
    const rhythm = lineRhythm(lineId, orders, config);
    if (!rhythm) continue;

    const activeMinutes = item.segment.seconds / 60;
    const totalMinutes = activeMinutes + handling.handling_minutes;
    const impact = Math.round(totalMinutes * rhythm.cycle * handling.slowdown);

    rows.push({
      deviceId: item.deviceId,
      lineId,
      anomalyType: item.anomalyType,
      symptom: symptomText(item.anomalyType, handling.label, item.latest, item.normalRange),
      peak: item.segment.peak,
      activeMinutes,
      totalMinutes,
      impact,
      riskScore: item.segment.peak * activeMinutes,
      action: actionOf(impact, config.action_thresholds),
      cycle: rhythm.cycle,
      cycleSource: rhythm.source,
      slowdown: handling.slowdown,
      handlingMinutes: handling.handling_minutes,
    });
  }

  return rows.sort((a, b) => b.impact - a.impact || b.riskScore - a.riskScore).slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* 5. 交付风险                                                         */
/* ------------------------------------------------------------------ */

export interface DeliveryInput {
  orders: Array<{
    order_id: string;
    line_id: string;
    product_id: string;
    planned_quantity: number;
    actual_quantity: number;
    planned_start: string;
    planned_end: string;
    status: string;
  }>;
  /** 每条线的实际节拍（已计入降速），件/分钟 */
  effectiveCycle: Record<string, number>;
  config: ReportConfig;
  now: number;
}

/**
 * 在制订单按当前节拍外推完成时间。
 * 只保留「外推完成时间落在未来 8 小时内、且晚于 planned_end」的单——
 * 8 小时是 config 的 delivery_horizon_hours，不写死。
 */
export function buildDeliveryRisks({ orders, effectiveCycle, config, now }: DeliveryInput): DeliveryRow[] {
  const horizonMs = config.delivery_horizon_hours * 3_600_000;
  const rows: DeliveryRow[] = [];

  for (const order of orders) {
    if (order.status !== 'IN_PROGRESS' && order.status !== 'DELAYED') continue;
    const remaining = order.planned_quantity - order.actual_quantity;
    if (remaining <= 0) continue;
    const cycle = plannedCycle(order);
    const effective = effectiveCycle[order.line_id];
    if (!cycle || !(effective > 0)) continue;

    const finishAt = now + (remaining / effective) * 60_000;
    const plannedEnd = Date.parse(order.planned_end);
    const delayHours = (finishAt - plannedEnd) / 3_600_000;
    if (!(delayHours > 0)) continue; // 不会延期 → 不进风险清单
    if (finishAt - now > horizonMs) continue; // 落在 8 小时视界外，明天再看

    rows.push({
      orderId: order.order_id,
      lineId: order.line_id,
      productId: order.product_id,
      remaining,
      cycle,
      effectiveCycle: effective,
      finishAt,
      plannedEnd,
      delayHours,
    });
  }

  return rows.sort((a, b) => b.delayHours - a.delayHours);
}

/* ------------------------------------------------------------------ */
/* 6. 本月损失账                                                       */
/* ------------------------------------------------------------------ */

/**
 * 本月损失。异常次数按「设备 + 类型 + 开始时刻」去重：
 * 实测库里存在同一条注入被写两次的重复行（2026-11-26 查到 id 1162/1163 完全一致），
 * 不去重会把「异常次数」与「影响产量」整体放大一倍。
 */
export function buildMonthlyLoss(
  anomalies: Array<{ device_id: string; anomaly_type: string; started_at: string; ended_at: string | null }>,
  devices: Array<{ device_id: string; line_id: string | null }>,
  orders: Array<{ line_id: string; planned_quantity: number; planned_start: string; planned_end: string }>,
  config: ReportConfig,
  now: number,
): MonthlyLoss {
  const seen = new Set<string>();
  const lineOf = new Map(devices.map((d) => [d.device_id, d.line_id]));
  let output = 0;

  for (const row of anomalies) {
    const key = `${row.device_id}|${row.anomaly_type}|${row.started_at}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const handling = config.anomaly_handling[row.anomaly_type];
    const lineId = lineOf.get(row.device_id);
    if (!handling || !lineId) continue;
    const rhythm = lineRhythm(lineId, orders, config);
    if (!rhythm) continue;

    const end = row.ended_at ? Date.parse(row.ended_at) : now;
    const minutes = Math.max(0, (end - Date.parse(row.started_at)) / 60_000);
    // 已结束的注入按真实区间；未结束的按「已持续 + 处置时长」估，与待办口径一致
    const total = row.ended_at ? minutes : minutes + handling.handling_minutes;
    output += total * rhythm.cycle * handling.slowdown;
  }

  const defects = Math.round(output * config.defect_rate);
  return {
    count: seen.size,
    output: Math.round(output),
    defects,
    amount: config.unit_price_cny > 0 ? Math.round(defects * config.unit_price_cny) : null,
  };
}
