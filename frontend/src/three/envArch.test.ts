/**
 * 批 2b 建筑层次的几何约束（D-81）。
 *
 * 四条硬约束，都是在别的批次里踩过一遍的：
 *  1. 全部在厂区边界内（越界 = 飞出去一块板，相机拉远才看得见）；
 *  2. 水平投影不许压设备（夹层柱与楼梯最容易压到 B 线设备）；
 *  3. metal 组顶部不许出现杆件（作者 2026-11-26 17:53 的否决项，判据与 envInterior 一致）；
 *  4. 三块体量必须真的存在且有厚度（防止有人把屋顶删了"省三角"）。
 */

import { describe, expect, it } from 'vitest';
import { WORKSHOPS, POWER_STATION } from './layout';
import { ENV_BOUNDS, type EnvPart } from './envLayout';
import { buildArch, buildOfficeMezzanine, buildPowerHouse, buildStorageBay } from './envArch';
import { deviceFootprints, rectsOverlap } from './propLayout';

const arch = buildArch();

function footprintOf(part: EnvPart) {
  // 这批全是轴对齐盒子/圆柱，没有旋转件，半宽直接取尺寸的一半
  const hx = part.shape === 'box' ? part.sx / 2 : part.sx;
  const hz = part.shape === 'box' ? part.sz / 2 : part.sx;
  return { x1: part.x - hx, x2: part.x + hx, z1: part.z - hz, z2: part.z + hz };
}

describe('批 2b 建筑层次', () => {
  it('三块体量的类别都在', () => {
    expect(arch.kinds).toEqual(['power-house', 'storage-bay', 'office-mezzanine']);
  });

  it('全部部件在厂区边界内', () => {
    const out = arch.parts
      .map((p) => ({ p, f: footprintOf(p) }))
      .filter(({ f }) => f.x1 < ENV_BOUNDS.x1 || f.x2 > ENV_BOUNDS.x2 || f.z1 < ENV_BOUNDS.z1 || f.z2 > ENV_BOUNDS.z2);
    expect(out.map(({ p }) => `(${p.x},${p.z})`).slice(0, 5)).toEqual([]);
  });

  it('动力站有屋顶与排风管（不是一块地坪）', () => {
    const parts = buildPowerHouse();
    const roof = parts.filter((p) => p.group === 'shell' && p.sx > POWER_STATION.sizeX && p.y > 4.5);
    expect(roof.length).toBeGreaterThan(0);
    const stacks = parts.filter((p) => p.shape === 'cyl' && p.sy > 3);
    expect(stacks.length).toBeGreaterThanOrEqual(2);
  });

  it('仓储棚在南侧场地、低于车间层高（不挡车间内部视线）', () => {
    const parts = buildStorageBay();
    const southWall = WORKSHOPS[0].z + WORKSHOPS[0].sizeZ / 2; // 15
    const inside = parts.filter((p) => footprintOf(p).z1 < southWall);
    expect(inside.map((p) => `(${p.x},${p.z})`)).toEqual([]);
    const roofY = Math.max(...parts.filter((p) => p.group === 'shell').map((p) => p.y + p.sy / 2));
    expect(roofY).toBeLessThan(WORKSHOPS[0].height);
  });

  it('办公夹层在 WS-B 内、楼板 4.6 m、且不压设备', () => {
    const parts = buildOfficeMezzanine();
    const ws = WORKSHOPS.find((w) => w.id === 'WS-B')!;
    const x1 = ws.x - ws.sizeX / 2;
    const x2 = ws.x + ws.sizeX / 2;
    const z1 = ws.z - ws.sizeZ / 2;
    for (const p of parts) {
      const f = footprintOf(p);
      expect(f.x1, p.shape).toBeGreaterThanOrEqual(x1 - 0.1);
      expect(f.x2, p.shape).toBeLessThanOrEqual(x2 + 0.1);
      expect(f.z1, p.shape).toBeGreaterThanOrEqual(z1 - 0.1);
    }
    // 楼板：横向长、薄、标高 4.6 附近
    const slab = parts.find((p) => p.sx > 20 && p.sy > 0.15 && p.sy < 0.3 && Math.abs(p.y - 4.5) < 0.2);
    expect(slab).toBeTruthy();

    // 柱子与楼梯不许压设备
    const devices = deviceFootprints();
    const hits: string[] = [];
    for (const part of parts) {
      if (part.y > 1) continue; // 楼板以上不占地面
      const rect = footprintOf(part);
      for (const d of devices) if (rectsOverlap(rect, d)) hits.push(`(${part.x},${part.z}) ← ${d.deviceId}`);
    }
    expect(hits.slice(0, 5)).toEqual([]);
  });

  it('顶部不许出现 metal 组杆件（作者 2026-11-26 否决项）', () => {
    const ceiling = WORKSHOPS[0].height - 1;
    const overhead = arch.parts.filter((p) => p.group === 'metal' && p.y - p.sy / 2 > ceiling);
    expect(overhead.map((p) => `(${p.x},${p.y},${p.z})`)).toEqual([]);
  });

  it('只并入既有六组，没有新增材质组', () => {
    for (const p of arch.parts) {
      expect(['matte', 'shell', 'metal', 'paint', 'emissive', 'glass']).toContain(p.group);
    }
  });

  it('仓储跨与动力站不冲突：两者水平投影不相交', () => {
    const bay = buildStorageBay().filter((p) => p.group === 'shell');
    const house = buildPowerHouse().filter((p) => p.group === 'shell');
    const hits: string[] = [];
    for (const a of bay) {
      const ra = footprintOf(a);
      for (const b of house) {
        if (rectsOverlap(ra, footprintOf(b))) hits.push(`(${a.x},${a.z}) ↔ (${b.x},${b.z})`);
      }
    }
    expect(hits.slice(0, 5)).toEqual([]);
  });
});
