/**
 * 工厂日报计算的单测（D-74）。
 *
 * 重点不是覆盖率，是**把页面底部那几条公式钉死**：
 * 影响件数、风险分、延期小时、损失账，验收脚本会用同样的算式复算，两处必须一致。
 */

import { describe, expect, it } from 'vitest';
import {
  buildDeliveryRisks,
  buildMonthlyLoss,
  buildTodoRows,
  lastAnomalySegment,
  lineRhythm,
  pickSegment,
  plannedCycle,
  symptomText,
} from './dailyReport';
import type { ReportConfig } from '../services/types';

const CFG: ReportConfig = {
  version: 'test',
  note: 'test',
  currency: 'CNY',
  unit_price_cny: 850,
  defect_rate: 0.03,
  risk_score_high: 3,
  action_thresholds: { stop: 15, today: 5 },
  action_deadline_hours: { stop: 2, today: 8, observe: 24 },
  report_window_minutes: 120,
  delivery_horizon_hours: 8,
  lines: {
    'LINE-A1': { cycle_per_minute: 0.5 },
  },
  anomaly_handling: {
    VIB_SPIKE: { label: '振动尖峰', slowdown: 0.5, handling_minutes: 60 },
    TEMP_DRIFT: { label: '温度漂移', slowdown: 0.25, handling_minutes: 45 },
    CURRENT_ABNORMAL: { label: '电流异常', slowdown: 0.35, handling_minutes: 30 },
  },
  source: { file: 'config/report.json', kind: 'assumption' },
};

const point = (sec: number, score: number, isAnomaly: boolean) => ({
  ts: new Date(Date.UTC(2026, 10, 26, 5, 0, sec)).toISOString(),
  score,
  is_anomaly: isAnomaly,
});

describe('lastAnomalySegment', () => {
  it('取最后一段连续异常，峰值取段内最大', () => {
    const points = [
      point(0, 0.1, true),
      point(2, 0.2, true),
      point(4, 0.01, false),
      point(6, 0.9, true),
      point(8, 0.7, true),
      point(10, 0.02, false),
    ];
    const seg = lastAnomalySegment(points, 2);
    expect(seg).not.toBeNull();
    expect(seg!.peak).toBeCloseTo(0.9);
    // 首末点相差 2 秒 + 一个采样周期
    expect(seg!.seconds).toBe(4);
    expect(seg!.points).toBe(2);
  });

  it('单点段时长按一个采样周期算，不会得到 0', () => {
    const seg = lastAnomalySegment([point(4, 0.5, false), point(6, 1, true)], 2);
    expect(seg!.seconds).toBe(2);
    expect(seg!.peak).toBe(1);
  });

  it('全程正常返回 null（页面据此显示「暂无待办」而不是编一行）', () => {
    expect(lastAnomalySegment([point(0, 0.01, false), point(2, 0.02, false)], 2)).toBeNull();
  });
});

describe('pickSegment（真值区间优先）', () => {
  it('用区间起止当持续时长，峰值取区间内模型分', () => {
    const points = [point(0, 0.9, false), point(2, 0.99, false), point(4, 0.1, false)];
    const picked = pickSegment(
      points,
      [{ started_at: '2026-11-26T05:00:00Z', ended_at: '2026-11-26T05:00:04Z', anomaly_type: 'VIB_SPIKE' }],
      2,
    );
    expect(picked!.segment.seconds).toBe(4);
    expect(picked!.segment.peak).toBeCloseTo(0.99);
    expect(picked!.anomalyType).toBe('VIB_SPIKE');
  });

  it('重复区间按内容去重，取开始时间最晚的一段', () => {
    const points = [
      point(0, 0.2, false),
      point(2, 0.3, false),
      point(120, 0.8, false),
      point(122, 0.95, false),
    ];
    const picked = pickSegment(
      points,
      [
        { started_at: '2026-11-26T05:00:00Z', ended_at: '2026-11-26T05:00:02Z', anomaly_type: 'TEMP_DRIFT' },
        { started_at: '2026-11-26T05:00:00Z', ended_at: '2026-11-26T05:00:02Z', anomaly_type: 'TEMP_DRIFT' },
        { started_at: '2026-11-26T05:02:00Z', ended_at: '2026-11-26T05:02:02Z', anomaly_type: 'VIB_SPIKE' },
      ],
      2,
    );
    expect(picked!.anomalyType).toBe('VIB_SPIKE');
    expect(picked!.segment.peak).toBeCloseTo(0.95);
  });

  it('区间内没有模型点时退回连续异常点，类型为空', () => {
    const points = [point(600, 0.4, false), point(602, 0.7, true), point(604, 0.6, true)];
    const picked = pickSegment(
      points,
      [{ started_at: '2026-11-26T05:00:00Z', ended_at: '2026-11-26T05:00:02Z', anomaly_type: 'TEMP_DRIFT' }],
      2,
    );
    expect(picked!.anomalyType).toBeNull();
    expect(picked!.segment.peak).toBeCloseTo(0.7);
  });
});

describe('节拍', () => {
  const order = {
    line_id: 'LINE-A1',
    planned_quantity: 120,
    planned_start: '2026-11-26T04:50:00Z',
    planned_end: '2026-11-26T08:50:00Z',
  };

  it('订单反推：120 件 / 240 分钟 = 0.5 件每分钟', () => {
    expect(plannedCycle(order)).toBeCloseTo(0.5);
  });

  it('有订单优先用订单，没有才退配置', () => {
    expect(lineRhythm('LINE-A1', [order], CFG)).toEqual({ cycle: 0.5, source: 'order' });
    expect(lineRhythm('LINE-A2', [order], CFG)).toBeNull(); // 配置里没有 LINE-A2 → 不猜
    expect(lineRhythm('LINE-A1', [], CFG)).toEqual({ cycle: 0.5, source: 'config' });
  });
});

describe('待办行', () => {
  const scores = [
    {
      deviceId: 'CONV-01',
      anomalyType: 'CURRENT_ABNORMAL',
      segment: { startedAt: Date.parse('2026-11-26T05:00:00Z'), endedAt: 0, peak: 1, seconds: 120, points: 60 },
      latest: { temperature: null, vibration: null, current: 12.05 },
      normalRange: { current: { min: 6, max: 10 } },
    },
  ];
  const devices = [{ device_id: 'CONV-01', line_id: 'LINE-A1' }];
  const orders = [
    {
      line_id: 'LINE-A1',
      planned_quantity: 120,
      planned_start: '2026-11-26T04:50:00Z',
      planned_end: '2026-11-26T08:50:00Z',
    },
  ];

  it('影响件数 = (已持续 + 处置) × 节拍 × 降速', () => {
    const [row] = buildTodoRows({ scores, devices, orders, config: CFG });
    expect(row.activeMinutes).toBeCloseTo(2);
    expect(row.totalMinutes).toBeCloseTo(32);
    // 32 × 0.5 × 0.35 = 5.6 → 6
    expect(row.impact).toBe(6);
    expect(row.action).toBe('today');
    expect(row.riskScore).toBeCloseTo(2);
    expect(row.symptom).toContain('电流');
  });

  it('分档边界：15 属「今日下班后」，16 才是「立即停机」', () => {
    const at = (seconds: number) =>
      buildTodoRows({
        scores: [{ ...scores[0], segment: { ...scores[0].segment, seconds } }],
        devices,
        orders,
        config: CFG,
      })[0];

    const vib = (seconds: number) =>
      buildTodoRows({
        scores: [
          {
            deviceId: 'CONV-01',
            anomalyType: 'VIB_SPIKE',
            segment: { startedAt: 0, endedAt: 0, peak: 1, seconds, points: 1 },
            latest: null,
            normalRange: null,
          },
        ],
        devices,
        orders,
        config: CFG,
      })[0];

    // 60 秒 + 60 分钟 = 61 分钟 × 0.5 × 0.5 = 15.25 → 15 → today
    expect(vib(60).impact).toBe(15);
    expect(vib(60).action).toBe('today');
    // 120 秒 + 60 分钟 = 62 分钟 × 0.5 × 0.5 = 15.5 → 16 → stop
    expect(vib(120).impact).toBe(16);
    expect(vib(120).action).toBe('stop');
    expect(at(120).action).toBe('today');
  });

  it('只留影响件数最大的 5 行', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      deviceId: `D-${i}`,
      anomalyType: 'TEMP_DRIFT',
      segment: { startedAt: 0, endedAt: 0, peak: 1, seconds: 60 * (i + 1), points: 1 },
      latest: null,
      normalRange: null,
    }));
    const rows = buildTodoRows({
      scores: many,
      devices: many.map((s) => ({ device_id: s.deviceId, line_id: 'LINE-A1' })),
      orders,
      config: CFG,
    });
    expect(rows).toHaveLength(5);
    expect(rows[0].impact).toBeGreaterThanOrEqual(rows[4].impact);
  });
});

describe('现象文案', () => {
  it('有读数时给出对比百分比', () => {
    expect(
      symptomText('VIB_SPIKE', '振动尖峰', { temperature: null, vibration: 3.49, current: null }, { vibration: { min: 1.5, max: 3 } }),
    ).toBe('振动 3.49 mm/s，比正常上限高 16%');
  });

  it('没读数时只说类型，不编数字', () => {
    expect(symptomText('TEMP_DRIFT', '温度漂移', null, null)).toBe('温度漂移持续异常');
  });
});

describe('交付风险', () => {
  const now = Date.parse('2026-11-26T05:00:00Z');
  const order = {
    order_id: 'ORD-1',
    line_id: 'LINE-A1',
    product_id: 'PRD-A-001',
    planned_quantity: 120,
    actual_quantity: 18,
    planned_start: '2026-11-26T04:50:00Z',
    planned_end: '2026-11-26T08:50:00Z',
    status: 'IN_PROGRESS',
  };

  it('剩余 102 件按降速后的节拍外推，与 planned_end 比较', () => {
    const [row] = buildDeliveryRisks({ orders: [order], effectiveCycle: { 'LINE-A1': 0.25 }, config: CFG, now });
    expect(row.remaining).toBe(102);
    // 102 / 0.25 = 408 分钟 = 6.8 小时；planned_end 距 now 3.83 小时
    expect(row.delayHours).toBeCloseTo(6.8 - 3.8333, 2);
  });

  it('节拍够快时不算延期', () => {
    const rows = buildDeliveryRisks({ orders: [order], effectiveCycle: { 'LINE-A1': 0.5 }, config: CFG, now });
    // 102 / 0.5 = 204 分钟 = 3.4 小时 → 08:24Z，早于 08:50Z
    expect(rows).toHaveLength(0);
  });

  it('视界外的单不列（8 小时是配置值）', () => {
    const rows = buildDeliveryRisks({ orders: [order], effectiveCycle: { 'LINE-A1': 0.05 }, config: CFG, now });
    // 2040 分钟 = 34 小时，超过 8 小时视界
    expect(rows).toHaveLength(0);
  });
});

describe('本月损失账', () => {
  const devices = [{ device_id: 'AIR-01', line_id: 'LINE-A1' }];
  const orders = [
    {
      line_id: 'LINE-A1',
      planned_quantity: 120,
      planned_start: '2026-11-26T04:50:00Z',
      planned_end: '2026-11-26T08:50:00Z',
    },
  ];

  it('重复行去重，金额 = 不良件数 × 单价', () => {
    const row = {
      device_id: 'AIR-01',
      anomaly_type: 'TEMP_DRIFT',
      started_at: '2026-11-26T04:40:00Z',
      ended_at: '2026-11-26T04:47:00Z',
    };
    const loss = buildMonthlyLoss([row, { ...row }], devices, orders, CFG, Date.parse('2026-11-26T05:00:00Z'));
    expect(loss.count).toBe(1);
    // 7 分钟 × 0.5 × 0.25 = 0.875 → 1 件
    expect(loss.output).toBe(1);
    expect(loss.defects).toBe(0); // round(1 × 0.03) = 0
    expect(loss.amount).toBe(0);
  });

  it('单价为 0 时不折算金额（null，页面显示「未配置单价」）', () => {
    const loss = buildMonthlyLoss(
      [{ device_id: 'AIR-01', anomaly_type: 'TEMP_DRIFT', started_at: '2026-11-26T04:40:00Z', ended_at: '2026-11-26T04:47:00Z' }],
      devices,
      orders,
      { ...CFG, unit_price_cny: 0 },
      Date.parse('2026-11-26T05:00:00Z'),
    );
    expect(loss.amount).toBeNull();
  });
});
