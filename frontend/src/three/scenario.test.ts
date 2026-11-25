/** 四线四工况的差异约束：差异如果只写在注释里，改着改着就退化成"同一套参数复制四遍"。 */
import { describe, expect, it } from 'vitest';
import { DEVICE_LAYOUT, LINE_DEVICES } from './layout';
import {
  LINE_SCENARIOS,
  RATED_BELT_SPEED,
  SCENARIO_BY_LINE,
  overriddenState,
  scenarioBadgeText,
  scenarioOfDevice,
  seededRandom,
} from './scenario';

describe('四线四工况（本批）', () => {
  it('正好四条线，工况两两不同', () => {
    expect(LINE_SCENARIOS).toHaveLength(4);
    expect(new Set(LINE_SCENARIOS.map((s) => s.condition)).size).toBe(4);
    expect(new Set(LINE_SCENARIOS.map((s) => s.label)).size).toBe(4);
  });

  it('四个可见维度四条线两两不同（料数/颜色/速度/托盘）', () => {
    for (const key of ['itemCount', 'itemTint', 'speedFactor', 'palletCrates'] as const) {
      const values = LINE_SCENARIOS.map((s) => s[key]);
      expect(new Set(values).size, `维度 ${key} 有重复：${values.join(',')}`).toBe(4);
    }
    // 料距可以有相同值（A1/A2 都是额定 1.0），但必须为正
    for (const s of LINE_SCENARIOS) expect(s.spacingFactor).toBeGreaterThan(0);
  });

  it('带速系数落在 0~1，且与额定带速相乘后不超过额定值', () => {
    for (const s of LINE_SCENARIOS) {
      expect(s.speedFactor).toBeGreaterThanOrEqual(0);
      expect(s.speedFactor).toBeLessThanOrEqual(1);
      expect(s.speedFactor * RATED_BELT_SPEED).toBeLessThanOrEqual(RATED_BELT_SPEED + 1e-9);
    }
  });

  it('停顿 0.2~0.3 秒、偏转不超过 ±2°、错位不超过料距 10%', () => {
    for (const s of LINE_SCENARIOS) {
      expect(s.dwellSeconds).toBeGreaterThanOrEqual(0.2);
      expect(s.dwellSeconds).toBeLessThanOrEqual(0.3);
      expect(s.yawJitterDeg).toBeLessThanOrEqual(2);
      expect(s.offsetJitter).toBeLessThanOrEqual(0.3);
    }
  });

  it('A1 满负荷：三台全 RUNNING（保证"运动流畅"，不被真实告警闸住）', () => {
    expect(Object.values(SCENARIO_BY_LINE['LINE-A1'].stateOverrides)).toEqual(['RUNNING', 'RUNNING', 'RUNNING']);
    expect(Object.keys(SCENARIO_BY_LINE['LINE-A1'].stateOverrides)).toHaveLength(3);
  });

  it('四条线四个工况各自的设备状态组合都不同（RUNNING / ALARM / MAINTENANCE / IDLE）', () => {
    const combos = LINE_SCENARIOS.map((s) => Object.values(s.stateOverrides).sort().join('+'));
    expect(combos).toEqual(['RUNNING+RUNNING+RUNNING', 'ALARM', 'MAINTENANCE+MAINTENANCE+MAINTENANCE', 'IDLE+IDLE+IDLE']);
  });

  it('每条线的覆盖只作用于本线设备，且设备 ID 都存在于坐标表', () => {
    for (const s of LINE_SCENARIOS) {
      const own = new Set(LINE_DEVICES[s.lineId]);
      for (const [deviceId, state] of Object.entries(s.stateOverrides)) {
        expect(DEVICE_LAYOUT[deviceId], `${deviceId} 不在坐标表`).toBeTruthy();
        expect(own.has(deviceId), `${deviceId} 不属于 ${s.lineId}`).toBe(true);
        expect(state).toBeTruthy();
      }
    }
  });

  it('覆盖查询：B1 三台全维护、A2 一台告警、A1 三台运行中', () => {
    expect(overriddenState('CNC-03')).toBe('MAINTENANCE');
    expect(overriddenState('ROB-03')).toBe('MAINTENANCE');
    expect(overriddenState('INSP-01')).toBe('MAINTENANCE');
    expect(overriddenState('ROB-02')).toBe('ALARM');
    expect(overriddenState('CNC-01')).toBe('RUNNING');
    expect(scenarioOfDevice('ROB-02')?.lineId).toBe('LINE-A2');
    expect(scenarioOfDevice('AIR-01')).toBeNull();
  });

  it('种子确定：同种子同序列，不同种子不同序列', () => {
    const a1 = Array.from({ length: 5 }, seededRandom(1101));
    const a2 = Array.from({ length: 5 }, seededRandom(1101));
    const b = Array.from({ length: 5 }, seededRandom(2207));
    expect(a1).toEqual(a2);
    expect(a1).not.toEqual(b);
  });

  it('角标文案列出四条线与四个工况名', () => {
    const text = scenarioBadgeText();
    for (const s of LINE_SCENARIOS) {
      expect(text).toContain(s.lineId);
      expect(text).toContain(s.label);
    }
  });
});
