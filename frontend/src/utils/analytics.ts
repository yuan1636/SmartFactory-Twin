/**
 * Batch 2 三个页面的纯计算部分：告警分级、G-10 解除文案、真值甘特分组、真值 vs 告警对比。
 * 抽成纯函数是为了能单测——页面里 React + ECharts 不好断言，但这些规则可以。
 */

import { ANOMALY_META, ANOMALY_TYPES, type GanttTask } from '../charts/options';
import type { AlarmItem, AlarmLevel, AnomalyItem, ResolveResult } from '../services/types';
import { STATE_META, type EffectiveState } from './status';

export const ALARM_LEVEL_META: Record<AlarmLevel, { label: string; color: string }> = {
  CRITICAL: { label: '严重', color: '#ef4444' },
  WARNING: { label: '预警', color: '#f2b233' },
};

export const ALARM_TYPE_LABEL: Record<string, string> = {
  TEMPERATURE: '温度',
  VIBRATION: '振动',
  CURRENT: '电流',
};

export function alarmTypeLabel(type: string): string {
  return ALARM_TYPE_LABEL[type] ?? type;
}

/** 未解除告警按等级统计。传进来的必须是 resolved_at 为 null 的列表。 */
export function alarmLevelCounts(items: AlarmItem[]): { total: number; critical: number; warning: number } {
  let critical = 0;
  let warning = 0;
  for (const item of items) {
    if (item.alarm_level === 'CRITICAL') critical += 1;
    else warning += 1;
  }
  return { total: items.length, critical, warning };
}

function statusText(status: string): string {
  const meta = STATE_META[status as EffectiveState];
  return meta ? meta.label : status;
}

/**
 * G-10 的前端可见性：解除后必须说清「还剩几条」，而不是一句「操作成功」。
 * 返回 kind 让调用方决定 toast 颜色：仍有残留是 info（黄），彻底清零才是 success（绿）。
 */
export function resolveFeedback(res: ResolveResult): { kind: 'success' | 'info'; message: string } {
  const status = statusText(res.device_status);
  if (res.open_alarm_count > 0) {
    return {
      kind: 'info',
      message: `已解除 1 条；该设备仍有 ${res.open_alarm_count} 条未解除告警，状态保持「${status}」`,
    };
  }
  return {
    kind: 'success',
    message: `已解除 1 条；该设备已无未解除告警，状态为「${status}」`,
  };
}

/** 新增维护记录后同样要说清设备状态，否则用户不知道设备被置成维护中了。 */
export function maintenanceFeedback(deviceStatus: string, hasFinished: boolean): { kind: 'success' | 'info'; message: string } {
  const status = statusText(deviceStatus);
  if (!hasFinished) {
    return { kind: 'info', message: `维护记录已创建；未填结束时间，设备状态已置为「${status}」` };
  }
  return { kind: 'success', message: `维护记录已创建；设备状态为「${status}」` };
}

export interface GanttData {
  categories: string[];
  tasks: GanttTask[];
}

/**
 * 真值甘特：按设备分行，活动最多的设备排最上面（便于一眼看到重灾区）。
 * ended_at 为空表示该次注入还没结束，用 nowMs 当右端，否则条形长度为 0 看不见。
 */
export function buildGantt(anomalies: AnomalyItem[], nowMs: number = Date.now()): GanttData {
  const perDevice = new Map<string, number>();
  for (const a of anomalies) perDevice.set(a.device_id, (perDevice.get(a.device_id) ?? 0) + 1);

  const categories = [...perDevice.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([device]) => device);

  const tasks: GanttTask[] = anomalies
    .filter((a) => !Number.isNaN(new Date(a.started_at).getTime()))
    .map((a) => {
      const start = new Date(a.started_at).getTime();
      const rawEnd = a.ended_at ? new Date(a.ended_at).getTime() : nowMs;
      const meta = ANOMALY_META[a.anomaly_type];
      return {
        category: a.device_id,
        start,
        end: Math.max(rawEnd, start + 60_000), // 至少 1 分钟宽，否则 2px 的条也看不到
        type: a.anomaly_type,
        title: `${a.device_id} · ${meta?.label ?? a.anomaly_type}`,
      };
    })
    .sort((a, b) => a.start - b.start);

  return { categories, tasks };
}

/**
 * 真值条数 vs 告警条数（按三类对齐）。
 * 两者天然不等：阈值规则会漏（渐变的漂移没到阈值）也会误（瞬时尖峰超限但真值窗口已过），
 * 这张图就是给人看这个差值的，不能把它说成"准确率"。
 */
export function anomalyVsAlarm(
  anomalies: AnomalyItem[],
  alarms: AlarmItem[],
): { categories: string[]; truth: number[]; alarm: number[] } {
  const truthCount = new Map<string, number>();
  for (const a of anomalies) truthCount.set(a.anomaly_type, (truthCount.get(a.anomaly_type) ?? 0) + 1);

  const typeOfAlarm = new Map<string, string>();
  for (const [type, meta] of Object.entries(ANOMALY_META)) typeOfAlarm.set(meta.alarmType, type);

  const alarmCount = new Map<string, number>();
  for (const a of alarms) {
    const type = typeOfAlarm.get(a.alarm_type);
    if (!type) continue;
    alarmCount.set(type, (alarmCount.get(type) ?? 0) + 1);
  }

  return {
    categories: ANOMALY_TYPES.map((t) => ANOMALY_META[t].label),
    truth: ANOMALY_TYPES.map((t) => truthCount.get(t) ?? 0),
    alarm: ANOMALY_TYPES.map((t) => alarmCount.get(t) ?? 0),
  };
}

/** 真值表里把 params 展开成 "speed_ratio=0.85 · current_ratio=1.45"，不显示原始 JSON。 */
export function paramsText(params: Record<string, unknown> | null): string {
  if (!params) return '—';
  const parts = Object.entries(params).map(([k, v]) => {
    if (v === null) return `${k}=null`;
    if (typeof v === 'object') return `${k}=${JSON.stringify(v)}`;
    return `${k}=${String(v)}`;
  });
  return parts.length > 0 ? parts.join(' · ') : '—';
}
