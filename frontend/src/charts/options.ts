/** 图表 option 工厂。曲线统一在这里生成，页面只传数据。 */

import type { EChartsCoreOption } from 'echarts/core';
import { METRIC_META } from '../services/format';
import type { MetricKey, MetricRange, TelemetryPoint } from '../services/types';
import { axisStyle, baseGrid, CHART_TEXT, CHART_TEXT_MUTED, tooltipStyle } from './init';

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
