import { describe, expect, it } from 'vitest';
import {
  DEVICE_LAYOUT,
  DEVICE_SIZES,
  FACTORY,
  LINE_STRIPS,
  WORKSHOPS,
  missingPlacements,
  sizeKeyOf,
} from './layout';

/** 与数据库 devices 表一致的 14 台设备（v1.1 第 3 节）。 */
const EXPECTED = [
  'CNC-01',
  'CNC-02',
  'CNC-03',
  'CNC-04',
  'ROB-01',
  'ROB-02',
  'ROB-03',
  'ROB-04',
  'CONV-01',
  'CONV-02',
  'INSP-01',
  'INSP-02',
  'AIR-01',
  'PUMP-01',
];

describe('G-01 坐标表', () => {
  it('恰好 14 台，且与后端设备清单一一对应', () => {
    expect(Object.keys(DEVICE_LAYOUT).sort()).toEqual([...EXPECTED].sort());
    expect(missingPlacements(EXPECTED)).toEqual([]);
  });

  it('全部落在厂区地面内（80 × 56）', () => {
    for (const [id, p] of Object.entries(DEVICE_LAYOUT)) {
      expect(Math.abs(p.x), id).toBeLessThanOrEqual(FACTORY.sizeX / 2);
      expect(Math.abs(p.z), id).toBeLessThanOrEqual(FACTORY.sizeZ / 2);
    }
  });

  it('没有两台设备占用同一坐标（穿模）', () => {
    const seen = new Set(Object.values(DEVICE_LAYOUT).map((p) => `${p.x},${p.z}`));
    expect(seen.size).toBe(EXPECTED.length);
  });

  it('两条产线的 z 间距 15m，足够放下 10m 长的输送机与 2.6m 宽的机床', () => {
    const zs = [...new Set(Object.values(DEVICE_LAYOUT).map((p) => p.z))].sort((a, b) => a - b);
    expect(zs).toContain(-7.5);
    expect(zs).toContain(7.5);
    const maxDepth = Math.max(DEVICE_SIZES.CNC.z, DEVICE_SIZES.CONVEYOR.z);
    expect(15 - maxDepth).toBeGreaterThan(0);
  });

  it('车间墙体范围覆盖本车间设备（设备不穿墙）', () => {
    const cnc = DEVICE_LAYOUT['CNC-01'];
    const wsA = WORKSHOPS.find((w) => w.id === 'WS-A');
    expect(wsA).toBeDefined();
    if (wsA) {
      expect(cnc.x).toBeGreaterThanOrEqual(wsA.x - wsA.sizeX / 2);
      expect(cnc.x).toBeLessThanOrEqual(wsA.x + wsA.sizeX / 2);
      expect(cnc.z).toBeGreaterThanOrEqual(wsA.z - wsA.sizeZ / 2);
      expect(cnc.z).toBeLessThanOrEqual(wsA.z + wsA.sizeZ / 2);
    }
  });

  it('四条产线色带齐全，长度与产线走向一致', () => {
    expect(LINE_STRIPS.map((s) => s.line_id).sort()).toEqual(['LINE-A1', 'LINE-A2', 'LINE-B1', 'LINE-B2']);
    for (const strip of LINE_STRIPS) {
      expect(strip.x2 - strip.x1).toBeGreaterThan(0);
    }
  });

  it('设备类型到外形包络的映射不丢类型', () => {
    expect(sizeKeyOf('AUX', 'AIR-01')).toBe('AUX_AIR');
    expect(sizeKeyOf('AUX', 'PUMP-01')).toBe('AUX_PUMP');
    expect(sizeKeyOf('ROBOT', 'ROB-01')).toBe('ROBOT');
    expect(sizeKeyOf('INSPECTION', 'INSP-01')).toBe('INSPECTION');
  });

  it('坐标表缺设备时能被检测出来（不允许静默跳过）', () => {
    expect(missingPlacements(['CNC-99'])).toEqual(['CNC-99']);
  });
});
