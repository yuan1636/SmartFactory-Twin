import { describe, expect, it } from 'vitest';
import { lineOption, thresholdsFromRange, THRESHOLD_METRICS } from './options';
import type { TelemetryPoint } from '../services/types';

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
