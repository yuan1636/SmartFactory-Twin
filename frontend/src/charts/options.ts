/** 图表 option 工厂。曲线统一在这里生成，页面只传数据。 */

import type { EChartsCoreOption } from 'echarts/core';
import { METRIC_META } from '../services/format';
import type {
  ConfusionPayload,
  MetricKey,
  MetricRange,
  ModelBaseline,
  OrderItem,
  ScorePayload,
  TelemetryPoint,
} from '../services/types';
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

/* ------------------------------------------------------------------ */
/* 第 4 阶段：AI 模型可视化（spec_phase4 §6.2）                         */
/* ------------------------------------------------------------------ */

/** 混淆矩阵四格的语义颜色。不按数值做色阶：TN 12 万、FP 221 差三个数量级， */
/** 线性色阶会让所有"错"的格子变成白色，而这恰恰是要看的地方。            */
const CONFUSION_COLORS = {
  tn: { bg: '#1b2b3f', border: '#2c4560', text: '#94a6bd', label: '真负 TN' },
  fp: { bg: '#4a2d12', border: '#b45309', text: '#fbbf24', label: '假正 FP（误报）' },
  fn: { bg: '#4a1d1d', border: '#b91c1c', text: '#fca5a5', label: '假负 FN（漏报）' },
  tp: { bg: '#14351f', border: '#15803d', text: '#86efac', label: '真正 TP（检出）' },
} as const;

/**
 * AI 页：混淆矩阵热力图。
 * 2×2 用 heatmap 而不是 HTML 表格，是为了和页面其余图表同源（同一个 ChartCard 容器、
 * 同一套 resize/dispose 逻辑），且导出图片时是矢量一致的。
 */
export function confusionHeatmapOption(payload: ConfusionPayload): EChartsCoreOption {
  const [[tn, fp], [fn, tp]] = payload.matrix;
  const rowTotals = [tn + fp, fn + tp];
  const cells: Array<[number, number, number, keyof typeof CONFUSION_COLORS]> = [
    [0, 0, tn, 'tn'],
    [1, 0, fp, 'fp'],
    [0, 1, fn, 'fn'],
    [1, 1, tp, 'tp'],
  ];
  return {
    animation: false,
    // ECharts 的 heatmap 强制要求配 visualMap，否则渲染期抛
    // "Heatmap must use with visualMap"（实测踩到，整页白屏）。
    // 这里把 visualMap 设为不显示：颜色由每个格子的 itemStyle 显式给出
    //（TN/FP/FN/TP 按语义上色，而不是按数值上色），它只负责满足图表类型的前置条件。
    visualMap: {
      show: false,
      min: 0,
      max: 1,
      inRange: { color: ['#1b2b3f'] },
    },
    // 左侧留出 y 轴标签宽度，右侧给色块说明留白
    grid: { left: 84, right: 16, top: 32, bottom: 40, containLabel: false },
    tooltip: {
      ...tooltipStyle(),
      formatter: (raw: unknown) => {
        const item = raw as { data: { value: [number, number, number, string] } };
        const [x, y, value, rawKey] = item.data.value;
        const meta = CONFUSION_COLORS[rawKey as keyof typeof CONFUSION_COLORS];
        const share = rowTotals[y] ? (value / rowTotals[y]) * 100 : 0;
        return [
          `真实：${payload.labels[y]}　预测：${payload.labels[x]}`,
          `${meta.label}：${value.toLocaleString('zh-CN')}（占该行 ${share.toFixed(3)}%）`,
        ].join('<br/>');
      },
    },
    xAxis: {
      type: 'category',
      data: payload.labels.map((label) => `预测 ${label}`),
      ...axisStyle(),
      splitLine: { show: false },
      axisLabel: { color: CHART_TEXT_MUTED, fontSize: 11 },
    },
    yAxis: {
      type: 'category',
      data: payload.labels.map((label) => `真实 ${label}`),
      ...axisStyle(),
      splitLine: { show: false },
      axisLabel: { color: CHART_TEXT_MUTED, fontSize: 11 },
    },
    series: [
      {
        type: 'heatmap',
        data: cells.map(([x, y, value, key]) => ({
          value: [x, y, value, key],
          itemStyle: {
            color: CONFUSION_COLORS[key].bg,
            borderColor: CONFUSION_COLORS[key].border,
            borderWidth: 1,
          },
        })),
        label: {
          show: true,
          formatter: (raw: unknown) => {
            const item = raw as { value: [number, number, number, string] };
            const [, y, value] = item.value;
            const share = rowTotals[y] ? (value / rowTotals[y]) * 100 : 0;
            // 数值与占比分两行：单行在 2×2 的大格子里会显得很空
            return `${value.toLocaleString('zh-CN')}\n${share.toFixed(3)}%`;
          },
          fontSize: 13,
          lineHeight: 18,
          color: CHART_TEXT,
        },
        // 2×2 的格子撑满分配区域，不留缝
        itemStyle: { borderRadius: 3 },
      },
    ],
    textStyle: { color: CHART_TEXT },
  };
}

/**
 * AI 页：四模型 PR-AUC 对比。
 * 只画 PR-AUC 一个指标：四个模型 × 多个指标并排会变成 12 根柱子，反而看不出差别。
 * 主模型用亮绿，其余用同色系暗色，眼睛先看到"用的是哪个"。
 */
export function modelCompareOption(baselines: ModelBaseline[]): EChartsCoreOption {
  const ordered = [...baselines].sort((a, b) => (a.is_primary ? 1 : 0) - (b.is_primary ? 1 : 0));
  return {
    animation: false,
    grid: { left: 52, right: 16, top: 28, bottom: 46, containLabel: false },
    tooltip: {
      trigger: 'axis',
      ...tooltipStyle(),
      formatter: (raw: unknown) => {
        const list = (Array.isArray(raw) ? raw : [raw]) as Array<{ dataIndex: number; value: number }>;
        const index = list[0]?.dataIndex ?? 0;
        const item = ordered[index];
        if (!item) return '';
        return [
          item.label,
          `PR-AUC：${item.pr_auc?.toFixed(4) ?? '—'}`,
          `召回：${item.recall != null ? (item.recall * 100).toFixed(2) + '%' : '—'}`,
          `精确：${item.precision != null ? (item.precision * 100).toFixed(2) + '%' : '—'}`,
          `区间检出：${item.detection_rate != null ? (item.detection_rate * 100).toFixed(2) + '%' : '—'}`,
        ].join('<br/>');
      },
    },
    xAxis: {
      type: 'category',
      data: ordered.map((item) => item.label),
      ...axisStyle(),
      splitLine: { show: false },
      axisLabel: { color: CHART_TEXT_MUTED, fontSize: 10, interval: 0 },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: 1,
      ...axisStyle(),
      axisLabel: { color: CHART_TEXT_MUTED, fontSize: 11 },
    },
    series: [
      {
        type: 'bar',
        barMaxWidth: 40,
        data: ordered.map((item) => ({
          value: item.pr_auc ?? 0,
          itemStyle: {
            color: item.is_primary ? '#22c55e' : '#3b5a7d',
            borderRadius: [3, 3, 0, 0],
          },
        })),
        label: {
          show: true,
          position: 'top',
          color: CHART_TEXT,
          fontSize: 11,
          formatter: (raw: unknown) => {
            const item = raw as { value: number };
            return Number(item.value).toFixed(3);
          },
        },
      },
    ],
    textStyle: { color: CHART_TEXT },
  };
}

/**
 * AI 页：异常分数曲线（全页最有说服力的一张图）。
 *
 * 三样东西叠在一起：
 * - 折线 = 模型逐点给出的异常分数；
 * - 红色散点 = 被判为异常的点（超过阈值的那些）；
 * - 半透明色块 = 注入真值的区间，颜色按异常类型区分。
 *
 * 看这张图要问的是「红色散点是否落在色块里、色块里是否都有红色散点」，
 * 也就是漏报和误报在时间上的分布，比一个 F1 数字直观得多。
 *
 * 纵轴保持线性 0~1（没有换成对数轴）：常态分数在 1e-5 量级，线性轴下确实贴近底部，
 * 但换成对数轴会让 0.0079 的阈值线跑到 70% 高度，看起来像"阈值很高"——那才是真的误导。
 * 贴底是数据的真实形态，页面用脚注说明即可。
 */
export function scoreCurveOption(payload: ScorePayload): EChartsCoreOption {
  const line = payload.points.map((point) => [point.ts, point.score]);
  const flagged = payload.points
    .filter((point) => point.is_anomaly)
    .map((point) => [point.ts, point.score]);

  const markAreaData = payload.intervals.map((interval) => {
    const meta = ANOMALY_META[interval.anomaly_type];
    return [
      {
        xAxis: interval.started_at,
        name: meta?.label ?? interval.anomaly_type,
        itemStyle: { color: meta?.color ?? CHART_TEXT_MUTED, opacity: 0.2 },
      },
      { xAxis: interval.ended_at },
    ];
  });

  return {
    animation: false,
    // top 留 40 给图例：两个 series（折线 + 散点）不标出来，读者只能靠脚注猜红线是什么
    grid: { left: 52, right: 16, top: 40, bottom: 46, containLabel: false },
    legend: {
      data: ['异常分数', '判为异常'],
      textStyle: { color: CHART_TEXT_MUTED, fontSize: 11 },
      top: 0,
      right: 0,
      icon: 'roundRect',
      itemWidth: 10,
      itemHeight: 8,
    },
    tooltip: {
      trigger: 'axis',
      ...tooltipStyle(),
      formatter: (raw: unknown) => {
        const list = (Array.isArray(raw) ? raw : [raw]) as Array<{
          axisValue: string | number;
          seriesName: string;
          value: [string, number];
        }>;
        const first = list[0];
        if (!first) return '';
        const stamp = new Date(first.axisValue as string);
        const hit = payload.points.find((p) => p.ts === first.axisValue);
        const rows = [
          `时间：${stamp.toLocaleString('zh-CN', { hour12: false })}`,
          `分数：${Number(first.value[1]).toFixed(6)}`,
          `判定：${hit?.is_anomaly ? '异常' : '正常'}`,
        ];
        if (hit?.label_type) rows.push(`归因：${ANOMALY_META[hit.label_type]?.label ?? hit.label_type}`);
        return rows.join('<br/>');
      },
    },
    xAxis: {
      type: 'time',
      ...axisStyle(),
      axisLabel: {
        color: CHART_TEXT_MUTED,
        fontSize: 10,
        formatter: (value: number) => {
          const d = new Date(value);
          const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
          return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        },
      },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: 1,
      ...axisStyle(),
      axisLabel: { color: CHART_TEXT_MUTED, fontSize: 11 },
    },
    series: [
      {
        name: '异常分数',
        type: 'line',
        showSymbol: false,
        sampling: 'lttb',
        lineStyle: { width: 1.6, color: '#38bdf8' },
        itemStyle: { color: '#38bdf8' },
        // 不用 areaStyle：尖峰段一冲顶，面积填充会把下方整个区域涂实，
        // 既是视觉噪音，又会盖住 markArea 的真值色块与红色散点（实测踩到）。
        data: line,
        markLine: {
          silent: true,
          symbol: 'none',
          lineStyle: { color: '#f59e0b', type: 'dashed', width: 1 },
          label: {
            formatter: `判定阈值 ${payload.threshold.toFixed(4)}`,
            color: '#f59e0b',
            fontSize: 10,
            position: 'insideEndTop',
          },
          data: [{ yAxis: payload.threshold }],
        },
        markArea: {
          silent: true,
          data: markAreaData,
        },
      },
      {
        name: '判为异常',
        type: 'scatter',
        symbolSize: 3,
        itemStyle: { color: '#ef4444', opacity: 0.85 },
        data: flagged,
        z: 5,
      },
    ],
    textStyle: { color: CHART_TEXT },
  };
}
