import { describe, expect, it } from 'vitest';
import {
  confusionHeatmapOption,
  ganttOption,
  lineOption,
  modelCompareOption,
  orderRateOption,
  scoreCurveOption,
  thresholdsFromRange,
  THRESHOLD_METRICS,
} from './options';
import type { OrderItem, TelemetryPoint } from '../services/types';

const points: TelemetryPoint[] = [
  { ts: '2026-11-24T04:00:00Z', running_status: 'RUNNING', temperature: 60, vibration: 2, current: 8, speed: 1500 },
  { ts: '2026-11-24T04:00:02Z', running_status: 'RUNNING', temperature: 61, vibration: null, current: 8.1, speed: 1500 },
];

describe('阈值参考线', () => {
  it('按正常上限 ×1.1 / ×1.25 推算，与后端 config 完全一致', () => {
    expect(thresholdsFromRange({ min: 55, max: 70, unit: '℃' })).toEqual({ warning: 77, critical: 87.5 });
    expect(thresholdsFromRange({ min: 1.5, max: 3, unit: 'mm/s' })).toEqual({ warning: 3.3, critical: 3.75 });
  });

  it('没有区间时两条线都不画（转速就是这种情况）', () => {
    expect(thresholdsFromRange(undefined)).toEqual({ warning: null, critical: null });
  });

  it('转速不在阈值指标里：后端没给它配 thresholds', () => {
    expect(THRESHOLD_METRICS).not.toContain('speed');
    expect(THRESHOLD_METRICS).toEqual(['temperature', 'vibration', 'current']);
  });
});

describe('曲线 option', () => {
  it('空值点被剔除，不画成 0', () => {
    const option = lineOption({ metric: 'vibration', points, thresholds: { warning: 3.3, critical: 3.75 } });
    const series = (option.series as Array<{ data: unknown[] }>)[0];
    expect(points.length).toBe(2);
    expect(series.data.length).toBe(1);
  });

  it('有阈值时 markLine 两条，无阈值时没有 markLine', () => {
    const withThreshold = lineOption({
      metric: 'temperature',
      points,
      thresholds: { warning: 77, critical: 87.5 },
    });
    const markLine = (withThreshold.series as Array<{ markLine?: { data: unknown[] } }>)[0].markLine;
    expect(markLine?.data.length).toBe(2);

    const without = lineOption({ metric: 'speed', points, thresholds: { warning: null, critical: null } });
    expect((without.series as Array<{ markLine?: unknown }>)[0].markLine).toBeUndefined();
  });
});

function order(partial: Partial<OrderItem>): OrderItem {
  return {
    order_id: 'ORD-20261124-0016',
    product_id: 'PRD-B-001',
    line_id: 'LINE-B2',
    planned_quantity: 120,
    actual_quantity: 120,
    qualified_quantity: 116,
    planned_start: '2026-11-24T07:57:54+00:00',
    planned_end: '2026-11-24T11:57:54+00:00',
    status: 'COMPLETED',
    qualified_rate: 0.9667,
    completion_rate: 1,
    ...partial,
  };
}

describe('生产页合格率折线', () => {
  it('后端倒序返回，图里翻回正序（旧 → 新）', () => {
    const option = orderRateOption([
      order({ order_id: 'ORD-20261124-0016' }),
      order({ order_id: 'ORD-20261124-0014' }),
      order({ order_id: 'ORD-20261124-0012' }),
    ]);
    const xAxis = option.xAxis as { data: string[] };
    expect(xAxis.data).toEqual(['#0012', '#0014', '#0016']);
  });

  it('0~1 小数换成百分比，y 轴钉死 0~100', () => {
    const option = orderRateOption([order({ qualified_rate: 0.9667, completion_rate: 0.5 })]);
    const series = option.series as Array<{ data: number[] }>;
    expect(series[0].data).toEqual([96.67]);
    expect(series[1].data).toEqual([50]);
    expect((option.yAxis as { max: number }).max).toBe(100);
  });

  it('空订单不报错', () => {
    expect((orderRateOption([]).series as unknown[]).length).toBe(2);
  });
});

describe('真值甘特', () => {
  it('每个任务转成 [start, 行号, end] 并带类型颜色', () => {
    const option = ganttOption(
      ['CNC-01', 'AIR-01'],
      [
        { category: 'AIR-01', start: 1000, end: 5000, type: 'VIB_SPIKE', title: 'AIR-01 · 振动尖峰' },
      ],
    );
    const data = (option.series as Array<{ data: Array<{ value: number[]; itemStyle: { color: string } }> }>)[0]
      .data;
    expect(data[0].value).toEqual([1000, 1, 5000]);
    expect(data[0].itemStyle.color).toBe('#a855f7');
  });

  it('分类里没有的设备被丢掉，不会画到不存在的行上', () => {
    const option = ganttOption(
      ['CNC-01'],
      [{ category: 'GHOST-99', start: 0, end: 1000, type: 'TEMP_DRIFT', title: 'x' }],
    );
    expect((option.series as Array<{ data: unknown[] }>)[0].data).toHaveLength(0);
  });
});

describe('混淆矩阵热力图（AI 页）', () => {
  const payload = {
    model_id: 'anomaly-test',
    matrix: [
      [124810, 221],
      [37, 2138],
    ],
    labels: ['正常', '异常'],
    threshold: 0.007866,
    pr_auc: 0.9859,
    roc_auc: 0.9943,
    test_rows: 127206,
    test_positives: 2175,
    note: '离线测试集',
  };

  it('四个格子落在正确的坐标上：行=真实、列=预测', () => {
    const option = confusionHeatmapOption(payload);
    const data = (option.series as Array<{ data: Array<{ value: [number, number, number, string] }> }>)[0].data;
    // [x=预测下标, y=真实下标, 值, 语义键]
    expect(data[0].value).toEqual([0, 0, 124810, 'tn']);
    expect(data[1].value).toEqual([1, 0, 221, 'fp']);
    expect(data[2].value).toEqual([0, 1, 37, 'fn']);
    expect(data[3].value).toEqual([1, 1, 2138, 'tp']);
  });

  it('必须有 visualMap：heatmap 缺它会抛 "must use with visualMap" 并白屏', () => {
    const option = confusionHeatmapOption(payload);
    expect(option.visualMap).toBeDefined();
    expect((option.visualMap as { show: boolean }).show).toBe(false);
  });

  it('颜色按语义给，不按数值给：漏报红、检出绿、误报橙', () => {
    const option = confusionHeatmapOption(payload);
    const data = (
      option.series as Array<{ data: Array<{ value: unknown[]; itemStyle: { color: string } }> }>
    )[0].data;
    const colorOf = (key: string) => data.find((d) => d.value[3] === key)?.itemStyle.color;
    expect(colorOf('fn')).toBe('#4a1d1d');
    expect(colorOf('tp')).toBe('#14351f');
    expect(colorOf('fp')).toBe('#4a2d12');
  });
});

describe('四模型对比柱（AI 页）', () => {
  const base = {
    pr_auc: 0.9,
    precision: 0.9,
    recall: 0.8,
    f1: 0.85,
    threshold: 0.5,
    detection_rate: 0.87,
    false_alarms_per_device_hour: 0.04,
  };
  const baselines = [
    { ...base, key: 'threshold_rule', label: '阈值规则', pr_auc: 0.9098, is_primary: false },
    { ...base, key: 'logistic_regression', label: '逻辑回归', pr_auc: 0.9421, is_primary: false },
    { ...base, key: 'isolation_forest', label: 'IsolationForest', pr_auc: 0.067, is_primary: false },
    { ...base, key: 'xgboost', label: 'XGBoost', pr_auc: 0.9859, is_primary: true },
  ];

  it('四根柱子，数值取 pr_auc 原值', () => {
    const option = modelCompareOption(baselines);
    const series = (option.series as Array<{ data: Array<{ value: number }> }>)[0];
    expect(series.data.map((d) => d.value)).toEqual([0.9098, 0.9421, 0.067, 0.9859]);
  });

  it('主模型排在最后且用绿色，其余同色系暗色', () => {
    const option = modelCompareOption(baselines);
    const series = (
      option.series as Array<{ data: Array<{ value: number; itemStyle: { color: string } }> }>
    )[0];
    expect(series.data[series.data.length - 1].itemStyle.color).toBe('#22c55e');
    expect(series.data[0].itemStyle.color).toBe('#3b5a7d');
  });

  it('PR-AUC 为空时画 0 而不是 NaN（NaN 会让整根柱子消失）', () => {
    const option = modelCompareOption([{ ...baselines[0], pr_auc: null }]);
    const series = (option.series as Array<{ data: Array<{ value: number }> }>)[0];
    expect(series.data[0].value).toBe(0);
  });
});

describe('异常分数曲线（AI 页）', () => {
  const payload = {
    device_id: 'CNC-01',
    start: '2026-11-25T00:00:00+00:00',
    end: '2026-11-25T01:00:00+00:00',
    model_id: 'anomaly-test',
    threshold: 0.007866,
    generated_at: '2026-11-25T01:00:01+00:00',
    warmup_rows: 150,
    warmup_available: true,
    raw_count: 5,
    downsample_step: 1,
    count: 5,
    points: [
      { ts: '2026-11-25T00:10:00+00:00', score: 0.000002, is_anomaly: false, label_type: null },
      { ts: '2026-11-25T00:10:02+00:00', score: 0.9, is_anomaly: true, label_type: 'TEMP_DRIFT' },
      { ts: '2026-11-25T00:10:04+00:00', score: 0.95, is_anomaly: true, label_type: 'TEMP_DRIFT' },
      { ts: '2026-11-25T00:10:06+00:00', score: 0.000004, is_anomaly: false, label_type: null },
      { ts: '2026-11-25T00:10:08+00:00', score: 0.000003, is_anomaly: false, label_type: null },
    ],
    summary: { predicted_rows: 2, predicted_rate: 0.4, max_score: 0.95, mean_score: 0.37 },
    intervals: [
      {
        id: 1,
        anomaly_type: 'TEMP_DRIFT',
        started_at: '2026-11-25T00:10:01+00:00',
        ended_at: '2026-11-25T00:10:05+00:00',
      },
    ],
  };

  it('折线含全部点，散点只含判为异常的点', () => {
    const option = scoreCurveOption(payload);
    const [line, scatter] = option.series as Array<{ data: unknown[][] }>;
    expect(line.data).toHaveLength(5);
    expect(scatter.data).toHaveLength(2);
    expect(scatter.data[0][1]).toBe(0.9);
  });

  it('阈值画成 markLine，真值区间画成 markArea（段数一致）', () => {
    const option = scoreCurveOption(payload);
    const series = (option.series as Array<{
      markLine?: { data: Array<{ yAxis: number }> };
      markArea?: { data: unknown[][] };
    }>)[0];
    expect(series.markLine?.data[0].yAxis).toBe(0.007866);
    expect(series.markArea?.data).toHaveLength(1);
    // 每段是 [起点, 终点] 两个对象，且带类型颜色（温度漂移是橙色）
    const area = series.markArea!.data[0] as Array<{ itemStyle: { color: string } }>;
    expect(area[0].itemStyle.color).toBe('#f97316');
  });

  it('不用 areaStyle：面积填充会盖住 markArea 与散点', () => {
    const option = scoreCurveOption(payload);
    const series = (option.series as Array<{ areaStyle?: unknown }>)[0];
    expect(series.areaStyle).toBeUndefined();
  });
});
