import { describe, expect, it } from 'vitest';
import type { AlarmItem, AnomalyItem, ResolveResult } from '../services/types';
import {
  alarmLevelCounts,
  anomalyVsAlarm,
  buildGantt,
  maintenanceFeedback,
  paramsText,
  resolveFeedback,
} from './analytics';

function alarm(partial: Partial<AlarmItem>): AlarmItem {
  return {
    alarm_id: 1,
    device_id: 'CNC-01',
    alarm_type: 'TEMPERATURE',
    alarm_level: 'WARNING',
    message: 'x',
    detected_at: '2026-11-24T04:00:00+00:00',
    resolved_at: null,
    ...partial,
  };
}

function anomaly(partial: Partial<AnomalyItem>): AnomalyItem {
  return {
    id: 1,
    device_id: 'CNC-01',
    anomaly_type: 'TEMP_DRIFT',
    started_at: '2026-11-24T04:00:00+00:00',
    ended_at: '2026-11-24T04:05:00+00:00',
    params: null,
    ...partial,
  };
}

describe('未解除告警分级', () => {
  it('按等级分开计数，总数等于两条之和', () => {
    const counts = alarmLevelCounts([
      alarm({ alarm_id: 1, alarm_level: 'CRITICAL' }),
      alarm({ alarm_id: 2, alarm_level: 'CRITICAL' }),
      alarm({ alarm_id: 3, alarm_level: 'WARNING' }),
    ]);
    expect(counts).toEqual({ total: 3, critical: 2, warning: 1 });
  });

  it('空列表不炸', () => {
    expect(alarmLevelCounts([])).toEqual({ total: 0, critical: 0, warning: 0 });
  });
});

describe('G-10 解除文案', () => {
  it('仍有残留：说明还剩几条，并原样带上设备状态', () => {
    const res: ResolveResult = {
      alarm_id: 12,
      resolved_at: '2026-11-24T05:00:00+00:00',
      device_status: 'ALARM',
      open_alarm_count: 2,
    };
    const fb = resolveFeedback(res);
    expect(fb.kind).toBe('info');
    expect(fb.message).toContain('仍有 2 条');
    expect(fb.message).toContain('告警');
  });

  it('清零：状态回运行中，用 success 色', () => {
    const res: ResolveResult = {
      alarm_id: 13,
      resolved_at: '2026-11-24T05:00:00+00:00',
      device_status: 'RUNNING',
      open_alarm_count: 0,
    };
    const fb = resolveFeedback(res);
    expect(fb.kind).toBe('success');
    expect(fb.message).toContain('运行中');
    expect(fb.message).not.toContain('仍有');
  });

  it('维护中不会因为清告警变成运行中，文案如实反映', () => {
    const res: ResolveResult = {
      alarm_id: 14,
      resolved_at: '2026-11-24T05:00:00+00:00',
      device_status: 'MAINTENANCE',
      open_alarm_count: 0,
    };
    expect(resolveFeedback(res).message).toContain('维护中');
  });
});

describe('新增维护文案', () => {
  it('未填结束时间要提示设备已置为维护中', () => {
    const fb = maintenanceFeedback('MAINTENANCE', false);
    expect(fb.kind).toBe('info');
    expect(fb.message).toContain('维护中');
  });

  it('填了结束时间按普通成功提示', () => {
    expect(maintenanceFeedback('RUNNING', true).kind).toBe('success');
  });
});

describe('真值甘特分组', () => {
  it('按设备活动数倒序分行，活动多的排上面', () => {
    const data = buildGantt([
      anomaly({ id: 1, device_id: 'AIR-01' }),
      anomaly({ id: 2, device_id: 'PUMP-01' }),
      anomaly({ id: 3, device_id: 'PUMP-01' }),
    ]);
    expect(data.categories).toEqual(['PUMP-01', 'AIR-01']);
    expect(data.tasks).toHaveLength(3);
  });

  it('未结束的注入用当前时间当右端，并保证至少 1 分钟宽', () => {
    const now = new Date('2026-11-24T04:30:00Z').getTime();
    // 已开始 30 分钟还没结束 → 右端取 now
    const data = buildGantt([anomaly({ started_at: '2026-11-24T04:00:00Z', ended_at: null })], now);
    expect(data.tasks[0].end).toBe(now);
    // 只持续 10 秒的真值，图上也要有 1 分钟宽度，否则 2px 的条根本看不见
    const narrow = buildGantt(
      [anomaly({ started_at: '2026-11-24T04:00:00Z', ended_at: '2026-11-24T04:00:10Z' })],
      now,
    ).tasks[0];
    expect(narrow.end - narrow.start).toBeGreaterThanOrEqual(60_000);
  });

  it('类型标签落到中文名', () => {
    const data = buildGantt([anomaly({ anomaly_type: 'VIB_SPIKE' })]);
    expect(data.tasks[0].title).toContain('振动尖峰');
  });
});

describe('真值 vs 告警', () => {
  it('告警类型映射到对应真值类型后分别计数', () => {
    const result = anomalyVsAlarm(
      [anomaly({ id: 1 }), anomaly({ id: 2 }), anomaly({ id: 3, anomaly_type: 'VIB_SPIKE' })],
      [alarm({ alarm_id: 1, alarm_type: 'TEMPERATURE' }), alarm({ alarm_id: 2, alarm_type: 'CURRENT' })],
    );
    // 顺序固定为 TEMP_DRIFT / VIB_SPIKE / CURRENT_ABNORMAL
    expect(result.truth).toEqual([2, 1, 0]);
    expect(result.alarm).toEqual([1, 0, 1]);
  });

  it('未知告警类型被忽略，不硬塞进某类', () => {
    const result = anomalyVsAlarm([], [alarm({ alarm_type: 'SOMETHING_NEW' })]);
    expect(result.alarm).toEqual([0, 0, 0]);
  });
});

describe('真值参数展开', () => {
  it('键值用 · 连接，不吐原始 JSON', () => {
    expect(paramsText({ speed_ratio: 0.85, current_ratio: 1.45 })).toBe('speed_ratio=0.85 · current_ratio=1.45');
  });

  it('空参数显示占位符', () => {
    expect(paramsText(null)).toBe('—');
    expect(paramsText({})).toBe('—');
  });
});
