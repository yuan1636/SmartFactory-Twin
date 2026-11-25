/**
 * 室内壳的几何约束（D 批 R1）。
 * 墙是最容易"看起来对、其实开错"的东西：门洞位置差 1 m、窗洞被墙糊上，肉眼要盯很久才看出来。
 * 这里把三件事变成断言：洞真的是空的、墙不越界、四角不漏缝。
 */
import { describe, expect, it } from 'vitest';
import { INTERIOR, INTERIOR_COLORS, buildInterior, cutawaySides, windowOpenings } from './envInterior';
import { ENV_BOUNDS } from './envLayout';
import { LINE_STRIPS, WORKSHOPS } from './layout';

const { parts } = buildInterior();

const isBox = (p: (typeof parts)[number]) => p.shape === 'box';
const walls = parts.filter((p) => p.color === INTERIOR_COLORS.wall);

/** 一个盒子在三个轴上的区间 */
type Pair = [number, number];
function span(p: (typeof parts)[number]): Record<'x' | 'y' | 'z', Pair> {
  return {
    x: [p.x - p.sx / 2, p.x + p.sx / 2],
    y: [p.y - p.sy / 2, p.y + p.sy / 2],
    z: [p.z - p.sz / 2, p.z + p.sz / 2],
  };
}

const overlaps = (a: Pair, b: Pair, pad = 1e-6) => a[0] < b[1] - pad && a[1] > b[0] + pad;

describe('室内壳（D 批 R1）', () => {
  it('全部部件在厂区边界内', () => {
    const out = parts.filter((p) => {
      const s = span(p);
      return s.x[0] < ENV_BOUNDS.x1 || s.x[1] > ENV_BOUNDS.x2 || s.z[0] < ENV_BOUNDS.z1 || s.z[1] > ENV_BOUNDS.z2;
    });
    expect(out.slice(0, 5).map((p) => `(${p.x},${p.z})`)).toEqual([]);
  });

  it('两个车间都有墙：北墙 1 段 + 南墙 2 段 + 过梁 1 段 + 东西墙各 3 段 = 9 段', () => {
    // 东西墙每侧 3 段（窗下带 / 窗上带 / 窗间墙合起来按 4 段算，这里只数"参与成墙"的件）
    expect(walls.length).toBeGreaterThanOrEqual(WORKSHOPS.length * 9);
    for (const ws of WORKSHOPS) {
      const near = walls.filter((p) => Math.abs(p.x - ws.x) <= ws.sizeX / 2 + 0.5 && Math.abs(p.z - ws.z) <= ws.sizeZ / 2 + 0.5);
      expect(near.length, ws.id).toBeGreaterThanOrEqual(9);
    }
  });

  it('墙厚 0.25 m；四面整高墙 8 m（窗下/窗上带是分段的，不高 8 m 是对的）', () => {
    for (const p of walls) {
      // 厚度落在哪个轴取决于朝向：南北墙厚在 z，东西墙厚在 x
      expect(Math.min(p.sx, p.sz), `(${p.x},${p.z}) 厚度`).toBeCloseTo(INTERIOR.wallThickness, 6);
    }
    // 每车间: 北墙 1 + 南墙左右 2 = 3 段整高（过梁 3.5、窗下 4.5、窗上 2.0 都不是整高）
    const fullHeight = walls.filter((p) => Math.abs(p.sy - INTERIOR.wallHeight) < 1e-6);
    expect(fullHeight).toHaveLength(WORKSHOPS.length * 3);
  });

  it('南墙卷帘门洞真的空着：门洞范围内没有任何墙体', () => {
    for (const ws of WORKSHOPS) {
      const z2 = ws.z + ws.sizeZ / 2;
      const door: Record<'x' | 'y' | 'z', Pair> = {
        x: [ws.x - INTERIOR.doorWidth / 2, ws.x + INTERIOR.doorWidth / 2],
        y: [0.01, INTERIOR.doorHeight - 0.01],
        z: [z2 - 1, z2 + 1],
      };
      const blocked = walls.filter((p) => {
        const s = span(p);
        return overlaps(s.x, door.x) && overlaps(s.y, door.y) && overlaps(s.z, door.z);
      });
      expect(blocked.length, `${ws.id} 门洞被墙堵住`).toBe(0);
    }
  });

  it('东西墙各 3 个高窗洞，洞口位置也没有墙体', () => {
    const openings = windowOpenings();
    expect(openings).toHaveLength(WORKSHOPS.length * 2 * 3);
    for (const o of openings) {
      const hole: Record<'x' | 'y' | 'z', Pair> = {
        x: [o.x - 0.6, o.x + 0.6],
        y: [o.sillY + 0.01, o.sillY + o.height - 0.01],
        z: [o.z - o.width / 2 + 0.01, o.z + o.width / 2 - 0.01],
      };
      const blocked = walls.filter((p) => {
        const s = span(p);
        return overlaps(s.x, hole.x) && overlaps(s.y, hole.y) && overlaps(s.z, hole.z);
      });
      expect(blocked.length, `窗洞 (${o.workshop} ${o.side} z=${o.z}) 被墙堵住`).toBe(0);
    }
  });

  it('窗洞高度 4.5~6 m、宽 2 m（作者给定）', () => {
    for (const o of windowOpenings()) {
      expect(o.sillY).toBeCloseTo(4.5, 6);
      expect(o.height).toBeCloseTo(1.5, 6);
      expect(o.width).toBeCloseTo(2, 6);
    }
  });

  it('每个窗洞都有 4 根窗框 + 一块玻璃（洞口不裸奔）', () => {
    const frames = parts.filter((p) => p.color === INTERIOR_COLORS.frame);
    expect(frames.length).toBe(windowOpenings().length * 4);
    const glass = parts.filter((p) => p.group === 'glass');
    expect(glass.length).toBe(windowOpenings().length);
  });

  it('墙角包柱 0.4×0.4，共 8 根（两车间 × 4 角）', () => {
    const pilasters = parts.filter((p) => p.color === INTERIOR_COLORS.pilaster);
    expect(pilasters).toHaveLength(WORKSHOPS.length * 4);
    for (const p of pilasters) {
      expect(p.sx).toBeCloseTo(0.4, 6);
      expect(p.sz).toBeCloseTo(0.4, 6);
    }
  });

  it('踢脚线 0.8 m 高，两车间各 4 道（南墙让开门洞，仍是整道）', () => {
    const skirts = parts.filter((p) => p.color === INTERIOR_COLORS.skirting);
    expect(skirts).toHaveLength(WORKSHOPS.length * 4);
    for (const p of skirts) expect(p.sy).toBeCloseTo(0.8, 6);
  });

  it('桁架每 6 m 一榀：每车间 6 榀（5 跨），弦杆+腹杆都是 0.12 方管并落在 metal 组', () => {
    const tubes = parts.filter((p) => p.color === INTERIOR_COLORS.truss && p.group === 'metal');
    // 每榀 = 上下弦 2 + 腹杆 21 = 23 件
    expect(tubes).toHaveLength(WORKSHOPS.length * 6 * 23);
    const xs = [...new Set(tubes.map((p) => Number(p.x.toFixed(2))))].sort((a, b) => a - b);
    // 每车间 6 个 x 位置，间距 6 m
    expect(xs.length).toBe(12);
    for (let i = 1; i < 6; i += 1) expect(xs[i] - xs[i - 1]).toBeCloseTo(6, 6);
  });

  it('所有墙/桁架都按顶点色并进既有组，没有新增材质组', () => {
    const groups = new Set(parts.map((p) => p.group));
    for (const g of groups) expect(['matte', 'metal', 'paint', 'emissive', 'glass']).toContain(g);
  });

  it('灯带 5 道，且吊在桁架下弦之下（不被檩条压住）', () => {
    const lamps = parts.filter((p) => p.group === 'emissive');
    expect(lamps).toHaveLength(LINE_STRIPS.length + 1);
    for (const p of lamps) expect(p.y).toBeLessThan(INTERIOR.trussBottom);
  });

  it('墙体不压产线色带（产线在车间内部，墙在周边）', () => {
    for (const strip of LINE_STRIPS) {
      const blocked = walls.filter((p) => {
        const s = span(p);
        return overlaps(s.x, [strip.x1, strip.x2]) && overlaps(s.z, [strip.z - 0.6, strip.z + 0.6]);
      });
      expect(blocked.length, `${strip.line_id} 被墙穿过`).toBe(0);
    }
  });

  it('没有非盒体的意外形状（窗框/墙/桁架都应是盒）', () => {
    expect(parts.filter((p) => !isBox(p))).toHaveLength(0);
  });
});

describe('室外剖切（D 批 R1 追加）', () => {
  const CUT_RE = /^(WS-A|WS-B):(north|south|west|east)$/;

  it('cut 标记只落在墙系件上，且 id 格式合法', () => {
    const marked = parts.filter((p) => p.cut);
    expect(marked.length).toBeGreaterThan(0);
    for (const p of marked) expect(p.cut, `${p.group}@(${p.x},${p.z})`).toMatch(CUT_RE);
    // 包柱与桁架不许被剖（车间轮廓与顶盖感靠它们）
    expect(parts.filter((p) => p.color === INTERIOR_COLORS.pilaster && p.cut)).toHaveLength(0);
    expect(parts.filter((p) => p.color === INTERIOR_COLORS.truss && p.cut)).toHaveLength(0);
  });

  it('每个车间四面各有剖切组：墙、窗框、玻璃、踢脚线、门导轨都跟着同组走', () => {
    for (const ws of WORKSHOPS) {
      for (const side of ['north', 'south', 'west', 'east'] as const) {
        const id = `${ws.id}:${side}`;
        const groupParts = parts.filter((p) => p.cut === id);
        expect(groupParts.length, `${id} 没有成员`).toBeGreaterThan(0);
        // 玻璃必须跟着墙走：墙剖了玻璃留下会悬空
        if (side === 'west' || side === 'east') {
          expect(groupParts.some((p) => p.group === 'glass'), `${id} 缺玻璃`).toBe(true);
          expect(groupParts.some((p) => p.group === 'metal'), `${id} 缺窗框`).toBe(true);
        }
        if (side === 'south') {
          expect(groupParts.some((p) => p.group === 'metal'), `${id} 缺门导轨/卷筒`).toBe(true);
        }
      }
    }
  });

  it('总览机位 (0, 46)：两车间的南墙 + 相邻内墙都剖掉，外墙留着', () => {
    const ids = cutawaySides({ x: 0, z: 46 });
    expect(ids).toContain('WS-A:south');
    expect(ids).toContain('WS-B:south');
    expect(ids).toContain('WS-A:east'); // 相机在走廊正上，相邻内墙也挡视线
    expect(ids).toContain('WS-B:west');
    expect(ids).not.toContain('WS-A:north');
    expect(ids).not.toContain('WS-B:north');
  });

  it('车间内机位（LINE-A1 视点）：WS-A 什么都不剖；WS-B 的西墙剖（视线穿不过两车间）', () => {
    expect(cutawaySides({ x: -15, z: -1 })).toEqual(['WS-B:west']);
  });

  it('入场起点（场外西南）：只剖相邻的外侧墙', () => {
    const ids = cutawaySides({ x: -44.7, z: 14.5 });
    expect(ids).toEqual(['WS-A:west', 'WS-B:west']);
  });
});
