import { beforeEach, describe, expect, it } from 'vitest';
import { applyLatest, getSnapshot, resetStoreForTest, setSnapshot, subscribe } from './store';
import type { Snapshot, SnapshotDevice } from './types';

function device(overrides: Partial<SnapshotDevice> & { device_id: string }): SnapshotDevice {
  return {
    device_name: overrides.device_id,
    device_type: 'CNC',
    workshop_id: 'WS-A',
    line_id: 'LINE-A1',
    status: 'RUNNING',
    open_alarm_count: 0,
    ts: '2026-11-24T04:58:10+00:00',
    metrics: { temperature: 60, vibration: 2, current: 8, speed: 1500 },
    running_status: 'RUNNING',
    in_anomaly: false,
    ...overrides,
  };
}

function snapshot(seq: number, devices: SnapshotDevice[]): Snapshot {
  return {
    type: 'snapshot',
    server_time: '2026-11-24T04:58:10+00:00',
    seq,
    device_count: devices.length,
    summary: { running: 0, idle: 0, stopped: 0, alarm: 0, maintenance: 0, open_alarm_count: 0 },
    devices,
  };
}

describe('快照写入', () => {
  beforeEach(() => resetStoreForTest());

  it('按 device_id 排序并把两个状态字段合并成一个', () => {
    setSnapshot(
      snapshot(1, [
        device({ device_id: 'ROB-01', status: 'ALARM', running_status: 'RUNNING' }),
        device({ device_id: 'CNC-01', running_status: 'IDLE' }),
      ]),
    );
    const state = getSnapshot();
    expect(state.devices.map((d) => d.device_id)).toEqual(['CNC-01', 'ROB-01']);
    expect(state.byId['CNC-01'].state).toBe('IDLE');
    expect(state.byId['ROB-01'].state).toBe('ALARM');
  });

  it('seq 未变时不触发订阅（每秒 14 个组件重渲染的根因）', () => {
    let calls = 0;
    const unsubscribe = subscribe(() => {
      calls += 1;
    });
    setSnapshot(snapshot(7, [device({ device_id: 'CNC-01' })]));
    setSnapshot(snapshot(7, [device({ device_id: 'CNC-01' })]));
    expect(calls).toBe(1);
    unsubscribe();
  });

  it('in_anomaly 计数进快照', () => {
    setSnapshot(
      snapshot(2, [
        device({ device_id: 'CNC-01', in_anomaly: true }),
        device({ device_id: 'CNC-02', in_anomaly: true }),
        device({ device_id: 'CNC-03' }),
      ]),
    );
    expect(getSnapshot().inAnomaly).toBe(2);
  });
});

describe('/devices/latest 兜底', () => {
  beforeEach(() => resetStoreForTest());

  it('按设备级与遥测级状态统计 summary', () => {
    applyLatest({
      server_time: '2026-11-24T04:58:10+00:00',
      items: [
        {
          device_id: 'CNC-01',
          status: 'ALARM',
          open_alarm_count: 2,
          ts: '2026-11-24T04:58:10+00:00',
          running_status: 'RUNNING',
          temperature: 80,
          vibration: 3.1,
          current: 9,
          speed: 1500,
        },
        {
          device_id: 'CNC-02',
          status: 'RUNNING',
          open_alarm_count: 0,
          ts: '2026-11-24T04:58:10+00:00',
          running_status: 'IDLE',
          temperature: 60,
          vibration: 2,
          current: 8,
          speed: 1400,
        },
      ],
    });
    const state = getSnapshot();
    expect(state.summary.alarm).toBe(1);
    expect(state.summary.idle).toBe(1);
    expect(state.summary.open_alarm_count).toBe(2);
    expect(state.byId['CNC-01'].metrics.temperature).toBe(80);
    expect(state.hasData).toBe(true);
  });
});
