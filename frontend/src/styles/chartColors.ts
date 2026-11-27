/**
 * 图表色（D5 界面层收尾）。
 *
 * 为什么不能直接吃 `var(--accent)`：ECharts 的 color 是 canvas 绘制的，不认 CSS 变量，
 * 传进去会得到一个字面量字符串 `var(--accent)` 然后画成黑色。
 * 于是这些值只能以 JS 常量存在——但**必须集中在这一处**，
 * 组件里出现 `#rrggbb` 就算违规（验收脚本会 grep components/pages，命中数必须为 0）。
 *
 * 取值与 tokens.css 的语义色一一对应，改配色时两边要一起改。
 */
export const CHART_COLORS = {
  /** 主序列（实际值 / 异常真值） */
  primary: '#3b82f6',
  /** 计划值（比主色压暗一档，退到背景里） */
  planned: '#2b3f57',
  /** 告警 / 风险 */
  danger: '#ef4444',
  /** 待办提示（黄） */
  warning: '#fbbf24',
  /** 混淆矩阵：误报 */
  falsePositive: '#fbbf24',
  /** 混淆矩阵：漏报 */
  falseNegative: '#fca5a5',
  /** 混淆矩阵：命中 */
  truePositive: '#86efac',
} as const;
