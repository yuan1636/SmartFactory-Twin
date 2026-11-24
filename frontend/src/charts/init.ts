/**
 * ECharts 按需引入：只注册用到的图表与组件，包体积从 ~1MB 降到 300KB 左右。
 * 页面禁止直接 echarts.init，统一走 ChartCard（G-15）。
 */

import * as echarts from 'echarts/core';
import { BarChart, CustomChart, LineChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  LineChart,
  BarChart,
  // 甘特条没有现成图表类型，用 custom 系列画矩形（AI 页真值时间轴）
  CustomChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  CanvasRenderer,
]);

export { echarts };

export const CHART_TEXT = '#94a6bd';
export const CHART_TEXT_MUTED = '#64748b';
export const CHART_SPLIT = '#1e2a3a';

/** 所有图表共用的底色与坐标轴样式，避免每张图各写一遍。 */
export function baseGrid() {
  return {
    left: 48,
    right: 16,
    top: 28,
    bottom: 28,
    containLabel: false,
  };
}

export function axisStyle() {
  return {
    axisLine: { lineStyle: { color: CHART_SPLIT } },
    axisLabel: { color: CHART_TEXT_MUTED, fontSize: 11 },
    splitLine: { lineStyle: { color: CHART_SPLIT, type: 'dashed' as const } },
  };
}

export function tooltipStyle() {
  return {
    backgroundColor: '#131c28',
    borderColor: '#243449',
    textStyle: { color: '#e8eef6', fontSize: 12 },
    axisPointer: { lineStyle: { color: '#35506e' } },
  };
}

export function initChart(el: HTMLElement) {
  return echarts.init(el, undefined, { renderer: 'canvas' });
}
