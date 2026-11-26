/** 环境层与产线补齐件的几何约束：越界、扎设备、类别缺失，都在这里先暴露。 */
import { describe, expect, it } from 'vitest';
import { LINE_STRIPS } from './layout';
import {
  ATLAS_TEXT,
  ENV_BOUNDS,
  ENV_COLORS,
  buildEnvironment,
  buildLineProps,
  buildStationLabels,
  type EnvPart,
} from './envLayout';
import { deviceFootprints, rectsOverlap } from './propLayout';
import { LINE_SCENARIOS } from './scenario';

const env = buildEnvironment();
const lineProps = buildLineProps(LINE_SCENARIOS);

/**
 * 部件水平半径：按实际尺寸算，并把 rotX / rotZ 带来的外扩算进去。
 * 不能用 max(sx,sz)/2 的方框近似——桁架弦杆是 29 m 长的细梁，方框化会把半宽算成 14.5 m，
 * 立刻误报越界（第一版就是这么挂的：(-33.6,0) 其实是沿 Z 的弦杆）。
 */
function halfExtents(part: EnvPart) {
  if (part.shape !== 'box') return { hx: part.sx, hz: part.sx };
  const rx = Math.abs(part.rotX ?? 0);
  const rz = Math.abs(part.rotZ ?? 0);
  const hx = part.sx / 2;
  const hz = part.sz / 2;
  const hy = part.sy / 2;
  return {
    hx: hx * Math.cos(rz) + hy * Math.sin(rz),
    hz: hz * Math.cos(rx) + hy * Math.sin(rx),
  };
}

function footprintOf(part: EnvPart) {
  const { hx, hz } = halfExtents(part);
  return { x1: part.x - hx, x2: part.x + hx, z1: part.z - hz, z2: part.z + hz };
}

describe('环境层（本批）', () => {
  it('全部部件在厂区边界内', () => {
    const out = [...env.parts, ...lineProps.parts]
      .map((p) => ({ p, f: footprintOf(p) }))
      .filter(({ f }) => f.x1 < ENV_BOUNDS.x1 || f.x2 > ENV_BOUNDS.x2 || f.z1 < ENV_BOUNDS.z1 || f.z2 > ENV_BOUNDS.z2);
    expect(out.map(({ p }) => `(${p.x},${p.z})`).slice(0, 5)).toEqual([]);
  });

  it('环境类别 ≥9 类', () => {
    expect(env.kinds.length).toBeGreaterThanOrEqual(9);
  });

  it('灯带 = 4 道（只照产线；中央通道那道已按作者 2026-11-26 要求删除）', () => {
    expect(env.parts.filter((p) => p.group === 'emissive')).toHaveLength(LINE_STRIPS.length);
    expect(env.kinds, '顶部深色杆件不许加回来').not.toContain('trusses');
    expect(env.kinds, '天花板管道/桥架不许加回来').not.toContain('cable-tray');
  });

  it('产线道具不与任何设备占地（含基座外扩）相交', () => {
    const devices = deviceFootprints();
    const hits: string[] = [];
    for (const part of lineProps.parts) {
      const rect = footprintOf(part);
      for (const d of devices) {
        if (rectsOverlap(rect, d)) hits.push(`${d.deviceId} ← (${part.x},${part.z})`);
      }
    }
    expect(hits.slice(0, 5)).toEqual([]);
  });

  it('四条线都有上料架与托盘堆', () => {
    expect(lineProps.kinds).toContain('feeder-rack');
    expect(lineProps.kinds).toContain('pallet-stack');
    // 每条线上游都有 3 层货架板（每条线 3 块，共 12 块）
    const shelves = lineProps.parts.filter((p) => p.color === 0x8b9299 && p.sy === 0.06 && p.sx === 1.16);
    expect(shelves.length).toBe(12);
  });

  it('A 线有检测工位台、B 线有短传送带段，两条线都有下料滑台', () => {
    expect(lineProps.kinds).toContain('inspection-table');
    expect(lineProps.kinds).toContain('short-conveyor');
    expect(lineProps.kinds).toContain('unload-slide');
    // 短传送带只有 B 线两条 → 机体 3.0 m 的深色钢件正好 2 件
    const conveyors = lineProps.parts.filter((p) => p.color === ENV_COLORS.darkSteel && p.sx === 3.0 && p.sy === 0.16);
    expect(conveyors.length).toBe(2);
  });

  it('只有 B1 有检修套装（警戒锥/工具车/维修中标识）', () => {
    expect(lineProps.kinds).toContain('maintenance-kit');
    expect(lineProps.maintenanceLabels).toHaveLength(1);
    expect(lineProps.maintenanceLabels[0].text).toContain('LINE-B1');
    const cones = lineProps.parts.filter((p) => p.color === 0xd4701f);
    expect(cones).toHaveLength(6);
  });

  it('工位编号与产线名都在图集单元表里，且都在厂区范围内', () => {
    const labels = buildStationLabels();
    expect(labels.length).toBe(14 + 4);
    for (const label of labels) {
      expect(ATLAS_TEXT).toContain(label.cell);
      expect(label.x).toBeGreaterThan(ENV_BOUNDS.x1);
      expect(label.x).toBeLessThan(ENV_BOUNDS.x2);
      expect(label.z).toBeGreaterThan(ENV_BOUNDS.z1);
      expect(label.z).toBeLessThan(ENV_BOUNDS.z2);
    }
  });

  it('标识立牌立柱：每块标识两根（围墙去掉后不悬空）', () => {
    const posts = env.parts.filter((p) => p.color === ENV_COLORS.darkSteel && p.sx === 0.07 && p.sz === 0.07);
    expect(posts.length).toBe(10); // 5 块标识 × 2 根
  });
});
