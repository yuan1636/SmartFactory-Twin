import { describe, expect, it } from 'vitest';
import { ganttOption, lineOption, orderRateOption, thresholdsFromRange, THRESHOLD_METRICS } from './options';
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
