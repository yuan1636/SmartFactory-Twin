/** G-13 格式化。禁止对 ISO 字符串做 slice —— 后端存 UTC，截取会得到 8 小时前的时间。 */

import type { MetricKey } from './types';

const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);

function parts(iso: string): Intl.DateTimeFormatPart[] | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // hourCycle h23：避免 zh-CN 在 hour12:false 下把午夜显示成 24:00
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
}

function pick(list: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return list.find((p) => p.type === type)?.value ?? '';
}

/** 2026-11-24T04:58:10Z → 2026-11-24 12:58:10（本地时区） */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const p = parts(iso);
  if (!p) return '—';
  return `${pick(p, 'year')}-${pick(p, 'month')}-${pick(p, 'day')} ${pick(p, 'hour')}:${pick(p, 'minute')}:${pick(p, 'second')}`;
}

/** 11-24 12:58 */
export function formatTimeShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  const p = parts(iso);
  if (!p) return '—';
  return `${pick(p, 'month')}-${pick(p, 'day')} ${pick(p, 'hour')}:${pick(p, 'minute')}`;
}

/** 只取时分秒，图表 x 轴用 */
export function formatClock(iso: string): string {
  const p = parts(iso);
  if (!p) return '';
  return `${pick(p, 'hour')}:${pick(p, 'minute')}:${pick(p, 'second')}`;
}

export function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** 后端给 0~1 的小数 */
export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

export interface MetricMeta {
  key: MetricKey;
  label: string;
  unit: string;
  color: string;
  digits: number;
}

export const METRIC_META: Record<MetricKey, MetricMeta> = {
  temperature: { key: 'temperature', label: '温度', unit: '℃', color: '#f97316', digits: 1 },
  vibration: { key: 'vibration', label: '振动', unit: 'mm/s', color: '#a855f7', digits: 2 },
  current: { key: 'current', label: '电流', unit: 'A', color: '#3b82f6', digits: 1 },
  speed: { key: 'speed', label: '转速', unit: 'rpm', color: '#14b8a6', digits: 0 },
};

export const METRIC_KEYS: MetricKey[] = ['temperature', 'vibration', 'current', 'speed'];

export function formatMetric(key: MetricKey, value: number | null | undefined): string {
  const meta = METRIC_META[key];
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${formatNumber(value, meta.digits)} ${meta.unit}`;
}

/** 距当前多少秒（判断数据是否停更） */
export function secondsSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}

/** 数据停更提示：静默超过 15 秒就认为模拟器没在推 */
export function stalenessText(iso: string | null | undefined): string | null {
  const s = secondsSince(iso);
  if (s === null) return '暂无数据';
  if (s < 15) return null;
  if (s < 60) return `数据已停更 ${pad(s)} 秒`;
  if (s < 3600) return `数据已停更 ${Math.floor(s / 60)} 分钟`;
  return `数据已停更 ${Math.floor(s / 3600)} 小时`;
}
