/**
 * 道具摆放的几何约束测试。
 *
 * 为什么用测试而不是"看图"：穿模在俯视图上经常看不出来（护栏扎进基座那次就是），
 * 但包围盒相交是能直接算的。D2 的硬指标「道具不穿设备」靠这些用例守住，
 * 以后改了偏移量、换了设备尺寸，跑一次就知道有没有破。
 */

import { describe, expect, it } from 'vitest';
import {
  FACTORY_BOUNDS,
  RAILING_OFFSET,
  buildHazardStrips,
  buildPipes,
  buildPlinths,
  buildRacks,
  buildRailings,
  buildSigns,
  buildTrays,
  deviceFootprints,
  rectsOverlap,
  type Rect,
} from './propLayout';
import { DEVICE_LAYOUT, LINE_STRIPS, POWER_STATION, WORKSHOPS } from './layout';

const footprints = deviceFootprints();

/** 把中心+宽深转成矩形，便于统一做相交判断 */
const toRect = (x: number, z: number, sizeX: number, sizeZ: number): Rect => ({
  x1: x - sizeX / 2,
  x2: x + sizeX / 2,
  z1: z - sizeZ / 2,
  z2: z + sizeZ / 2,
});

describe('道具摆放不穿设备', () => {
  it('每台设备都有自己的基座，且基座之间不重叠', () => {
    const plinths = buildPlinths();
    expect(plinths).toHaveLength(Object.keys(DEVICE_LAYOUT).length);

    for (let i = 0; i < plinths.length; i += 1) {
      for (let j = i + 1; j < plinths.length; j += 1) {
        const a = toRect(plinths[i].x, plinths[i].z, plinths[i].sizeX, plinths[i].sizeZ);
        const b = toRect(plinths[j].x, plinths[j].z, plinths[j].sizeX, plinths[j].sizeZ);
        expect(rectsOverlap(a, b), `${plinths[i].deviceId} 与 ${plinths[j].deviceId} 的基座重叠`).toBe(false);
      }
    }
  });

  it('护栏不扎进任何设备基座', () => {
    for (const run of buildRailings()) {
      // 护栏是一维线段，用极窄的矩形表示它扫过的范围
      const band = { x1: run.x1, x2: run.x2, z1: run.z - 0.06, z2: run.z + 0.06 };
      for (const fp of footprints) {
        expect(
          rectsOverlap(band, fp),
          `${run.lineId} 的护栏（z=${run.z}）压住了 ${fp.deviceId} 的占地`,
        ).toBe(false);
      }
    }
  });

  it('护栏偏移必须大于「最宽设备的基座半深」，否则必然穿模', () => {
    // CNC 深 2.6，基座外扩 0.5 → 半深 1.8
    expect(RAILING_OFFSET).toBeGreaterThan(2.6 / 2 + 0.5);
  });

  it('货架不压设备、且不超出厂区', () => {
    for (const r of buildRacks()) {
      const rect = toRect(r.x, r.z, r.width, r.depth);
      for (const fp of footprints) {
        expect(rectsOverlap(rect, fp), `货架(${r.x},${r.z}) 压住了 ${fp.deviceId}`).toBe(false);
      }
      expect(rect.x1).toBeGreaterThan(FACTORY_BOUNDS.x1);
      expect(rect.x2).toBeLessThan(FACTORY_BOUNDS.x2);
      expect(rect.z1).toBeGreaterThan(FACTORY_BOUNDS.z1);
      expect(rect.z2).toBeLessThan(FACTORY_BOUNDS.z2);
    }
  });

  it('地面警示带不与设备占地相交', () => {
    for (const s of buildHazardStrips()) {
      const rect = toRect(s.x, s.z, s.sizeX, s.sizeZ);
      for (const fp of footprints) {
        expect(rectsOverlap(rect, fp), `警示带(${s.x},${s.z}) 压住了 ${fp.deviceId}`).toBe(false);
      }
    }
  });

  it('管道的落地立管不插进设备', () => {
    for (const p of buildPipes()) {
      if (p.axis !== 'y') continue; // 只检查落地的立管，横管在高处 6.2 m，与设备不冲突
      const rect = toRect(p.x, p.z, p.radius * 2, p.radius * 2);
      for (const fp of footprints) {
        expect(rectsOverlap(rect, fp), `立管(${p.x},${p.z}) 插进了 ${fp.deviceId}`).toBe(false);
      }
    }
  });
});

describe('道具摆放的合理性', () => {
  it('七类道具都有内容（少于 7 类视为未完成）', () => {
    const counts = {
      plinth: buildPlinths().length,
      railing: buildRailings().length,
      hazard: buildHazardStrips().length,
      tray: buildTrays().length,
      pipe: buildPipes().length,
      rack: buildRacks().length,
      sign: buildSigns().length,
    };
    for (const [kind, n] of Object.entries(counts)) {
      expect(n, `${kind} 数量为 0`).toBeGreaterThan(0);
    }
    expect(Object.keys(counts)).toHaveLength(7);
  });

  it('护栏覆盖四条产线的两侧', () => {
    const runs = buildRailings();
    expect(runs).toHaveLength(LINE_STRIPS.length * 2);
    for (const strip of LINE_STRIPS) {
      const mine = runs.filter((r) => r.lineId === strip.line_id);
      expect(mine).toHaveLength(2);
      // 两侧对称
      const zs = mine.map((r) => r.z).sort((a, b) => a - b);
      expect(zs[1] - strip.z).toBeCloseTo(strip.z - zs[0], 6);
    }
  });

  it('线槽与管道都在车间范围内', () => {
    for (const ws of WORKSHOPS) {
      const trays = buildTrays().filter((t) => Math.abs(t.x - ws.x) < ws.sizeX / 2);
      expect(trays.length).toBeGreaterThanOrEqual(2);
      for (const t of trays) {
        expect(t.length).toBeLessThanOrEqual(ws.sizeX);
      }
    }
  });

  it('动力站四周都有警示带', () => {
    const strips = buildHazardStrips();
    const near = strips.filter(
      (s) => Math.abs(s.x - POWER_STATION.x) <= POWER_STATION.sizeX && Math.abs(s.z - POWER_STATION.z) <= POWER_STATION.sizeZ,
    );
    expect(near.length).toBe(4);
  });
});
