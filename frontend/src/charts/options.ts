/** 图表 option 工厂。曲线统一在这里生成，页面只传数据。 */

import type { EChartsCoreOption } from 'echarts/core';
import { METRIC_META } from '../services/format';
import type { MetricKey, MetricRange, OrderItem, TelemetryPoint } from '../services/types';
import { axisStyle, baseGrid, CHART_SPLIT, CHART_TEXT, CHART_TEXT_MUTED, tooltipStyle } from './init';

/**
 * 阈值规则与后端一致：WARNING = 正常上限 × 1.1，CRITICAL = × 1.25。
 * 后端 /devices/{id} 只返回 metrics_normal_range（接口已冻结，前端不得要求加字段），
 * 所以这里按同一规则反算，算出来的数与 config/devices.json 里的 thresholds 完全一致
 * （例：70 × 1.1 = 77.0，70 × 1.25 = 87.5）。
 */
export const THRESHOLD_RATIO = { warning: 1.1, critical: 1.25 } as const;

export interface Thresholds {
  warning: number | null;
  critical: number | null;
}

export function thresholdsFromRange(range?: MetricRange): Thresholds {
  if (!range || typeof range.max !== 'number') return { warning: null, critical: null };
  return {
    warning: Number((range.max * THRESHOLD_RATIO.warning).toFixed(2)),
    critical: Number((range.max * THRESHOLD_RATIO.critical).toFixed(2)),
  };
}

/**
 * 只有这三项在 config/devices.json 里配了 thresholds，转速没有。
 * 所以转速图不画参考线，否则会出现「图上有线、文案说没有」的自相矛盾。
 */
export const THRESHOLD_METRICS: MetricKey[] = ['temperature', 'vibration', 'current'];

export interface LineSeriesInput {
  metric: MetricKey;
  points: TelemetryPoint[];
  thresholds?: Thresholds;
  /** 图表高度不在这里管，由 ChartCard 控制 */
}

function clockOf(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function lineOption({ metric, points, thresholds }: LineSeriesInput): EChartsCoreOption {
  const meta = METRIC_META[metric];
  const data = points
    .filter((p) => p[metric] !== null && p[metric] !== undefined)
    .map((p) => [new Date(p.ts).getTime(), p[metric] as number]);

  const markLineData: Array<Record<string, unknown>> = [];
  if (thresholds?.warning !== null && thresholds?.warning !== undefined) {
    markLineData.push({
      yAxis: thresholds.warning,
      lineStyle: { color: '#f2b233', type: 'dashed', width: 1 },
      label: { formatter: `WARNING ${thresholds.warning}`, color: '#f2b233', fontSize: 10, position: 'insideEndTop' },
    });
  }
  if (thresholds?.critical !== null && thresholds?.critical !== undefined) {
    markLineData.push({
      yAxis: thresholds.critical,
      lineStyle: { color: '#ef4444', type: 'dashed', width: 1 },
      label: { formatter: `CRITICAL ${thresholds.critical}`, color: '#ef4444', fontSize: 10, position: 'insideEndTop' },
    });
  }

  return {
    animation: false,
    grid: baseGrid(),
    tooltip: {
      trigger: 'axis',
      ...tooltipStyle(),
      valueFormatter: (value: unknown) =>
        typeof value === 'number' ? `${value.toFixed(meta.digits)} ${meta.unit}` : '—',
    },
    xAxis: {
      type: 'time',
      ...axisStyle(),
      splitLine: { show: false },
      axisLabel: { color: CHART_TEXT_MUTED, fontSize: 11, formatter: (value: number) => clockOf(value) },
    },
    yAxis: {
      type: 'value',
      scale: true,
      // 坐标轴上界要容得下 CRITICAL 线，否则 markLine 被裁掉、看不出超限余量
      max: (extent: { max: number }) =>
        Math.ceil(Math.max(extent.max, thresholds?.critical ?? 0) * 1.05),
      name: meta.unit,
      nameTextStyle: { color: CHART_TEXT_MUTED, fontSize: 10, padding: [0, 0, 0, -28] },
      ...axisStyle(),
    },
    series: [
      {
        name: meta.label,
        type: 'line',
        showSymbol: false,
        lineStyle: { width: 1.4, color: meta.color },
        itemStyle: { color: meta.color },
        areaStyle: { color: meta.color, opacity: 0.08 },
        sampling: 'lttb',
        data,
        markLine:
          markLineData.length > 0
            ? {
                silent: true,
                symbol: 'none',
                data: markLineData,
              }
            : undefined,
      },
    ],
    // 保留一处文字色，避免整套 option 在不同图表里出现两种灰
    textStyle: { color: CHART_TEXT },
  };
}

/** 生产页分组柱状（计划 vs 实际）。 */
export function groupedBarOption(
  categories: string[],
  series: Array<{ name: string; data: number[]; color: string }>,
): EChartsCoreOption {
  return {
    animation: false,
    grid: baseGrid(),
    tooltip: { trigger: 'axis', ...tooltipStyle() },
    legend: { textStyle: { color: CHART_TEXT_MUTED, fontSize: 11 }, top: 0, right: 0 },
    xAxis: { type: 'category', data: categories, ...axisStyle(), splitLine: { show: false } },
    yAxis: { type: 'value', ...axisStyle() },
    series: series.map((s) => ({
      name: s.name,
      type: 'bar',
      barMaxWidth: 26,
      itemStyle: { color: s.color, borderRadius: [3, 3, 0, 0] },
      data: s.data,
    })),
  };
}

/**
 * 生产页：最近 N 单的合格率与完成率走势。
 * 后端按 planned_start DESC 返回（最新在前），折线要从旧到新画，所以这里反转。
 * 后端给的是 0~1 小数，乘 100 转百分比后 y 轴固定 0~100，避免"看着像达标其实只有 60%"。
 */
export function orderRateOption(orders: OrderItem[]): EChartsCoreOption {
  const asc = [...orders].reverse();
  const categories = asc.map((o) => o.order_id.replace(/^ORD-\d{8}-/, '#'));
  return {
    animation: false,
    grid: baseGrid(),
    tooltip: {
      trigger: 'axis',
      ...tooltipStyle(),
      formatter: (raw: unknown) => {
        const list = (Array.isArray(raw) ? raw : [raw]) as Array<{
          dataIndex: number;
          seriesName: string;
          value: number;
        }>;
        const index = list[0]?.dataIndex ?? 0;
        const order = asc[index];
        if (!order) return '';
        const rows = list.map((p) => `${p.seriesName}：${Number(p.value).toFixed(1)}%`);
        return [`${order.order_id}（${order.line_id}）`, ...rows].join('<br/>');
      },
    },
    legend: { textStyle: { color: CHART_TEXT_MUTED, fontSize: 11 }, top: 0, right: 0 },
    xAxis: {
      type: 'category',
      data: categories,
      ...axisStyle(),
      splitLine: { show: false },
      // 20 个订单号全画会糊成一片：交给 ECharts 自动隔点（hideOverlap）
      axisLabel: { color: CHART_TEXT_MUTED, fontSize: 10, hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: 100,
      ...axisStyle(),
      axisLabel: { color: CHART_TEXT_MUTED, fontSize: 11, formatter: '{value}%' },
    },
    series: [
      {
        name: '合格率',
        type: 'line',
        showSymbol: false,
        lineStyle: { width: 1.6, color: '#22c55e' },
        itemStyle: { color: '#22c55e' },
        data: asc.map((o) => Number((o.qualified_rate * 100).toFixed(2))),
      },
      {
        name: '完成率',
        type: 'line',
        showSymbol: false,
        lineStyle: { width: 1.6, color: '#3b82f6', type: 'dashed' },
        itemStyle: { color: '#3b82f6' },
        data: asc.map((o) => Number((o.completion_rate * 100).toFixed(2))),
      },
    ],
    textStyle: { color: CHART_TEXT },
  };
}

/** 三类异常真值的名字与颜色。alarmType 是它们在告警表里对应的 alarm_type。 */
export const ANOMALY_META: Record<string, { label: string; color: string; alarmType: string }> = {
  TEMP_DRIFT: { label: '温度漂移', color: '#f97316', alarmType: 'TEMPERATURE' },
  VIB_SPIKE: { label: '振动尖峰', color: '#a855f7', alarmType: 'VIBRATION' },
  CURRENT_ABNORMAL: { label: '电流异常', color: '#3b82f6', alarmType: 'CURRENT' },
};

export const ANOMALY_TYPES = Object.keys(ANOMALY_META);

export interface GanttTask {
  /** 该条挂在哪个 y 轴分类上（这里是设备编号） */
  category: string;
  start: number;
  end: number;
  type: string;
  title: string;
}

/** custom 系列给的最小 API 面，只取要用的几个方法，避免引 echarts 内部类型。 */
interface GanttRenderApi {
  value(index: number): number;
  coord(point: [number, number]): [number, number];
  size(size: [number, number]): [number, number];
  style(): Record<string, unknown>;
}

/**
 * AI 页：真值时间轴（甘特条）。
 * ECharts 没有甘特图类型，用 custom 系列按 [start, 分类下标, end] 画矩形。
 * 数据项自带 itemStyle，所以三类异常在一张图里能同时分色。
 */
export function ganttOption(categories: string[], tasks: GanttTask[]): EChartsCoreOption {
  const indexOf = new Map(categories.map((c, i) => [c, i]));
  const data = tasks
    .filter((t) => indexOf.has(t.category))
    .map((t) => ({
      name: t.title,
      value: [t.start, indexOf.get(t.category) as number, t.end],
      itemStyle: { color: ANOMALY_META[t.type]?.color ?? CHART_TEXT_MUTED },
    }));

  return {
    animation: false,
    grid: { left: 64, right: 20, top: 16, bottom: 28, containLabel: false },
    tooltip: {
      ...tooltipStyle(),
      formatter: (raw: unknown) => {
        const item = raw as { name?: string; value?: [number, number, number] };
        const v = item.value;
        if (!v) return '';
        const minutes = Math.round((v[2] - v[0]) / 60000);
        return `${item.name ?? ''}<br/>持续 ${minutes} 分钟`;
      },
    },
    xAxis: {
      type: 'time',
      ...axisStyle(),
      splitLine: { show: false },
      axisLabel: {
        color: CHART_TEXT_MUTED,
        fontSize: 11,
        formatter: (value: number) => clockOf(value),
      },
    },
    yAxis: {
      type: 'category',
      data: categories,
      inverse: true,
      ...axisStyle(),
      splitLine: { lineStyle: { color: CHART_SPLIT, type: 'dashed' } },
      axisLabel: { color: CHART_TEXT, fontSize: 11 },
    },
    series: [
      {
        type: 'custom',
        encode: { x: [0, 2], y: 1 },
        data,
        renderItem: (_params: unknown, api: GanttRenderApi) => {
          const row = api.value(1);
          const start = api.coord([api.value(0), row]);
          const end = api.coord([api.value(2), row]);
          const height = Math.max(6, api.size([0, 1])[1] * 0.42);
          const width = Math.max(3, end[0] - start[0]);
          return {
            type: 'rect',
            shape: { x: start[0], y: start[1] - height / 2, width, height, r: 2 },
            style: api.style(),
          };
        },
      },
    ],
    textStyle: { color: CHART_TEXT },
  };
}
