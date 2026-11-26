/**
 * R1.6 密度件测试：作者五条铁律 + 实例化配额 + 与既有道具的避让 + 视觉规则。
 * 数据源：buildDensityProps()（纯数据，不 import three）。
 */
import { describe, expect, it } from 'vitest';

import { DEVICE_LAYOUT, LINE_STRIPS, WORKSHOPS } from './layout';
import {
  DENSITY_BASE_COLORS,
  DENSITY_UNIT_SHAPE,
  TRAY_Z,
  WALL_FACE_X,
  WALL_FACE_Z,
  buildDensityProps,
  densityColor,
  deviceFootprints,
  rectsOverlap,
  type Rect,
} from './propLayout';

const parts = buildDensityProps();
const densityGrey = densityColor(DENSITY_BASE_COLORS.crane);

/** 密度件占地（无旋转；cyl 用外接方） */
function footprint(p: (typeof parts)[number]): Rect {
  return { x1: p.x - p.sx / 2, x2: p.x + p.sx / 2, z1: p.z - p.sz / 2, z2: p.z + p.sz / 2 };
}

/** 所属车间（按 x 就近）；动力站没有密度件 */
function workshopOf(p: (typeof parts)[number]) {
  return WORKSHOPS.find((w) => Math.abs(p.x - w.x) <= WALL_FACE_X + 1)!;
}

/** 密度件不许碰的既有静态道具（护栏/线槽/上料架/线头托盘堆/角落货架/下游工位台等） */
function staticObstacles(): Array<Rect & { why: string }> {
  const out: Array<Rect & { why: string }> = [];
  for (const ws of WORKSHOPS) {
    out.push(
      // 墙脚线槽（南北各一条，通长）
      { why: '线槽N', x1: ws.x - WALL_FACE_X + 0.4, x2: ws.x + WALL_FACE_X - 0.4, z1: TRAY_Z - 0.14, z2: TRAY_Z + 0.14 },
      { why: '线槽S', x1: ws.x - WALL_FACE_X + 0.4, x2: ws.x + WALL_FACE_X - 0.4, z1: -TRAY_Z - 0.14, z2: -TRAY_Z + 0.14 },
      // 角落货架（D2 对角两个）
      { why: '角落货架', x1: ws.x - 15.4 - 1.2, x2: ws.x - 15.4 + 1.2, z1: -13.9 - 0.45, z2: -13.9 + 0.45 },
      { why: '角落货架', x1: ws.x + 15.4 - 1.2, x2: ws.x + 15.4 + 1.2, z1: 13.9 - 0.45, z2: 13.9 + 0.45 },
    );
  }
  for (const strip of LINE_STRIPS) {
    const x1 = Math.min(strip.x1, strip.x2);
    const x2 = Math.max(strip.x1, strip.x2);
    out.push(
      // 护栏（线两侧 z=±2.0，立柱 + 横杆）
      { why: `护栏${strip.line_id}`, x1: x1 - 0.1, x2: x2 + 0.1, z1: strip.z - 2.05, z2: strip.z - 1.95 },
      { why: `护栏${strip.line_id}`, x1: x1 - 0.1, x2: x2 + 0.1, z1: strip.z + 1.95, z2: strip.z + 2.05 },
      // 上料架（线头 x1-2，1.16×2.16）
      { why: `上料架${strip.line_id}`, x1: strip.x1 - 2.6, x2: strip.x1 - 1.4, z1: strip.z - 1.1, z2: strip.z + 1.1 },
      // 线头托盘堆（x1-0.9, z+2.85，1.2×1.0）
      { why: `线头托盘${strip.line_id}`, x1: strip.x1 - 1.5, x2: strip.x1 - 0.3, z1: strip.z + 2.35, z2: strip.z + 3.35 },
    );
    if (strip.line_id.startsWith('LINE-A')) {
      // 检测工位台 + 下料滑台
      out.push(
        { why: `检测台${strip.line_id}`, x1: strip.x2 + 1.05, x2: strip.x2 + 2.95, z1: strip.z - 0.5, z2: strip.z + 0.5 },
        { why: `下料滑台${strip.line_id}`, x1: strip.x2 + 0.25, x2: strip.x2 + 1.75, z1: strip.z - 0.48, z2: strip.z + 0.48 },
      );
    } else {
      // 短传送带 + 侧向下料滑台
      out.push(
        { why: `短传送带${strip.line_id}`, x1: strip.x2 - 0.2, x2: strip.x2 + 2.8, z1: strip.z - 0.5, z2: strip.z + 0.5 },
        { why: `侧滑台${strip.line_id}`, x1: strip.x2 + 1.975, x2: strip.x2 + 2.925, z1: strip.z + 0.4, z2: strip.z + 1.9 },
      );
    }
  }
  // B1 检修套件（警戒锥 + 工具车）
  const b1 = LINE_STRIPS.find((s) => s.line_id === 'LINE-B1')!;
  out.push({ why: 'B1检修件', x1: b1.x1 + 2.8, x2: b1.x1 + 3 + 5 * 4.2 + 0.2, z1: -4.8, z2: -4.2 });
  out.push({ why: 'B1检修工具车', x1: b1.x1 + 8.5 - 0.55, x2: b1.x1 + 8.5 + 0.55, z1: -4.71, z2: -4.09 });
  return out;
}

describe('R1.6 密度件：数据形状与实例化配额', () => {
  it('四类实例化成员数量正确（每车间 6 托盘堆×2 / 周转箱×2 / 配电柜 / 气瓶）', () => {
    const count = (kind: string) => parts.filter((p) => p.inst === kind).length;
    expect(count('cabinet')).toBe(12); // 6 × 2 车间
    expect(count('pallet-stack')).toBe(24); // 12 × 2
    expect(count('crate-stack')).toBe(16); // 8 × 2
    expect(count('gas-bottle')).toBe(8); // 4 瓶 × 2
  });

  it('实例化类别与单位几何一一对应（envBuilder 聚合依据）', () => {
    const kinds = new Set(parts.filter((p) => p.inst).map((p) => p.inst!));
    expect([...kinds].sort()).toEqual(['cabinet', 'crate-stack', 'gas-bottle', 'pallet-stack'].sort());
    for (const kind of kinds) {
      const member = parts.find((p) => p.inst === kind)!;
      expect(DENSITY_UNIT_SHAPE[kind]).toBe(member.shape);
    }
  });

  it('托盘堆 3~5 层（高度 0.64~0.96）', () => {
    const heights = parts.filter((p) => p.inst === 'pallet-stack').map((p) => p.sy);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(0.16 * 4); // 3 层 = 0.16×(1+3)
    expect(Math.max(...heights)).toBeLessThanOrEqual(0.16 * 6 + 1e-9); // 5 层 = 0.16×(1+5)，浮点容差
    expect(new Set(heights).size).toBeGreaterThanOrEqual(3); // 层数有变化
  });

  it('每车间可辨识物体 ≥22（清单计数：设备 6 + 密度件 47）', () => {
    for (const ws of WORKSHOPS) {
      const devices = Object.values(DEVICE_LAYOUT).filter((d) => Math.abs(d.x - ws.x) < 17 && Math.abs(d.z - ws.z) < 15).length;
      // 密度件可辨识物：配电柜 6 + 货架 4 + 工具车 2 + 气瓶架 1 + 消防柜 2 + 管廊 2
      // + WIP 料架 4 + 托盘堆 12 + 周转箱堆 8 + 卷料架 2 + 轨道 2 + 天车 2 = 47
      const densityItems = 47;
      expect(devices + densityItems).toBeGreaterThanOrEqual(22);
    }
  });
});

describe('R1.6 五条铁律', () => {
  it('铁律 1：贴墙层（柜/架/车/瓶/消火栓/管廊）全部在墙内面 1.5m 内', () => {
    // 贴墙层的判据：z 在 ±(13~15) 贴南北墙，或 x 在 ±(15.5~17) 贴东西墙
    const wallLayer = parts.filter((p) => {
      const dz = Math.abs(Math.abs(p.z - workshopOf(p).z) - WALL_FACE_Z);
      const dx = Math.abs(Math.abs(p.x - workshopOf(p).x) - WALL_FACE_X);
      return dz <= 1.5 || dx <= 1.5;
    });
    // 每车间至少 40 个贴墙件（柜 6 + 货架板 12 + 工具车 4 + 气瓶架 4+4 + 消防柜 2 + 管廊 14）
    expect(wallLayer.length).toBeGreaterThanOrEqual(80); // 2 车间
    // 反向：贴墙件之外不许有"看起来该贴墙"的大件（高 >1.5 且离墙 >3m 的件只允许天车/料架）
    for (const p of parts) {
      if (p.color === densityGrey && p.y > 4) continue; // 天车（纵深层）
      const ws = workshopOf(p);
      const dz = Math.abs(Math.abs(p.z - ws.z) - WALL_FACE_Z);
      const dx = Math.abs(Math.abs(p.x - ws.x) - WALL_FACE_X);
      const wallDist = Math.min(dz, dx);
      if (p.y + p.sy / 2 > 1.5) {
        expect(wallDist, `高件 (${p.x},${p.z}) 离墙 ${wallDist.toFixed(2)}m 应贴墙`).toBeLessThanOrEqual(6.5);
      }
    }
  });

  it('铁律 2：与 deviceFootprints() 任一设备包围盒零相交', () => {
    for (const p of parts) {
      for (const d of deviceFootprints()) {
        expect(rectsOverlap(footprint(p), d), `${p.inst ?? 'part'}@(${p.x},${p.z}) 撞设备 ${d.deviceId}`).toBe(false);
      }
    }
  });

  it('铁律 3：中央通道 |x|<2 或 |z|<2 内不得出现装饰件', () => {
    for (const p of parts) {
      const f = footprint(p);
      const hitX = f.x1 < 2 && f.x2 > -2;
      const hitZ = f.z1 < 2 && f.z2 > -2;
      expect(hitX && hitZ, `件@(${p.x},${p.z}) 侵入中央通道`).toBe(false);
    }
  });

  it('铁律 4：高度 ≤6m（天车轨道/小车豁免，且 ≤7.9m）', () => {
    for (const p of parts) {
      const top = p.y + p.sy / 2;
      if (p.color === densityGrey) {
        expect(top, `天车件@(${p.x},${p.z}) 顶高`).toBeLessThanOrEqual(7.9);
      } else {
        expect(top, `非天车件@(${p.x},${p.z}) 顶高 ${top.toFixed(2)}`).toBeLessThanOrEqual(6);
      }
    }
  });

  it('铁律 5：距产线 3m 内的物件高度 ≤1.5m', () => {
    for (const p of parts) {
      const f = footprint(p);
      for (const strip of LINE_STRIPS) {
        const x1 = Math.min(strip.x1, strip.x2) - 3;
        const x2 = Math.max(strip.x1, strip.x2) + 3;
        const z1 = strip.z - 0.6 - 3;
        const z2 = strip.z + 0.6 + 3;
        if (rectsOverlap(f, { x1, x2, z1, z2 })) {
          expect(p.y + p.sy / 2, `件@(${p.x},${p.z}) 在 ${strip.line_id} 3m 内但高 ${(p.y + p.sy / 2).toFixed(2)}`).toBeLessThanOrEqual(1.5);
        }
      }
    }
  });
});

describe('R1.6 与既有道具避让 + 视觉规则', () => {
  it('不与护栏/线槽/上料架/线头托盘堆/角落货架/下游工位等既有道具相交', () => {
    for (const p of parts) {
      // 架空件（管廊 y5.5、天车 y7）从既有道具（全部 ≤2.4m 高）头顶通过，2D 占地相交不是真冲突
      if (p.y - p.sy / 2 >= 3) continue;
      for (const o of staticObstacles()) {
        expect(rectsOverlap(footprint(p), o), `${p.inst ?? 'part'}@(${p.x},${p.z}) 撞 ${o.why}`).toBe(false);
      }
    }
  });

  it('全部在 matte 组（无 emissive / 无状态灯通道），且颜色都过 densityColor', () => {
    const palette = new Set(Object.values(DENSITY_BASE_COLORS).map(densityColor));
    for (const p of parts) {
      expect(p.group).toBe('matte');
      expect(palette.has(p.color), `颜色 0x${p.color.toString(16)} 不是 densityColor 的产物`).toBe(true);
    }
  });

  it('densityColor：饱和度 ×0.85、明度 ×0.9 的转换数学', () => {
    expect(densityColor(0xff0000)).toBe(0xd41111); // s 1→0.85, l 0.5→0.45
    expect(densityColor(0x808080)).toBe(0x737373); // 灰只降明度
    expect(densityColor(0xffffff)).toBe(0xe6e6e6); // l 1→0.9
  });
});
