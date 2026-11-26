/**
 * 室内壳的几何约束（D 批 R1）。
 * 墙是最容易"看起来对、其实开错"的东西：门洞位置差 1 m、窗洞被墙糊上，肉眼要盯很久才看出来。
 * 这里把三件事变成断言：洞真的是空的、墙不越界、四角不漏缝。
 */
import { describe, expect, it } from 'vitest';
import { INTERIOR, INTERIOR_COLORS, buildInterior, cutawaySides, windowOpenings } from './envInterior';
import { ENV_BOUNDS } from './envLayout';
import { DEVICE_LAYOUT, LINE_STRIPS, WORKSHOPS, extendedLine } from './layout';

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

  it('踢脚线 0.8 m 高，两车间各 4 道（南墙让开门洞，仍是整道）；柱护脚同色但高 1m，按高度区分', () => {
    const skirts = parts.filter((p) => p.color === INTERIOR_COLORS.skirting && p.sy === 0.8);
    expect(skirts).toHaveLength(WORKSHOPS.length * 4);
    for (const p of skirts) expect(p.sy).toBeCloseTo(0.8, 6);
  });

  it('屋架杆件已按作者要求整组删除（2026-11-25 晚）：metal 组 y>7 必须为空', () => {
    // 原实现每车间 6 榀、每榀 23 根方管，两个车间约 280 根，人眼机位下是一片密网。
    // 这条是反向守卫：谁把深色杆件加回来，测试立刻失败。
    const tubes = parts.filter((p) => p.group === 'metal' && p.y > 7);
    expect(tubes).toHaveLength(0);
  });

  it('所有墙件都按顶点色并进既有组，没有新增材质组', () => {
    // 批 1 起多一个 shell 组：围护墙/踢脚/包柱必须与 matte 分开，才能单独关掉投影
    // （墙投影会把室内所有直射光挡在外面，车间里就没有任何设备影子）。
    // 这不是"新增材质"，仍是顶点色 + 一份 MeshStandardMaterial，只多 1 次 draw call。
    const groups = new Set(parts.map((p) => p.group));
    for (const g of groups) expect(['matte', 'shell', 'metal', 'paint', 'emissive', 'glass']).toContain(g);
  });

  it('围护墙/踢脚/包柱全在 shell 组（否则室内又会没有影子）', () => {
    const shell = parts.filter((p) => p.group === 'shell');
    expect(shell.length).toBeGreaterThan(0);

    // 反向守卫：matte 里不许再出现"整面墙"。
    // 判据用尺寸而不是颜色——柱脚与踢脚线同色（0x1f2b3a），按颜色判会把柱脚当成墙。
    // 墙的形态是「满高 + 长跨」；柱子是 0.5×0.5，不会被误判。
    const tall = INTERIOR.wallHeight - 1e-6;
    const wallLike = parts.filter(
      (p) => p.group === 'matte' && p.sy >= tall && Math.max(p.sx, p.sz) > 5,
    );
    expect(wallLike).toHaveLength(0);
  });

  it('灯带 4 道（只照产线；中央通道那道已按作者 2026-11-26 要求删除），标高由 lampY 独立定义', () => {
    const lamps = parts.filter((p) => p.group === 'emissive');
    expect(lamps).toHaveLength(LINE_STRIPS.length);
    for (const p of lamps) expect(p.y).toBe(INTERIOR.lampY);
  });

  it('产线顶进墙内被截断（R1.5）：延长后的灯带端点落在东西墙厚度带内，且与南北墙零重叠', () => {
    for (const ws of WORKSHOPS) {
      for (const strip of LINE_STRIPS.filter((s) => s.workshop_id === ws.id)) {
        const ext = extendedLine(strip);
        const west = [ws.x - ws.sizeX / 2 - INTERIOR.wallThickness / 2, ws.x - ws.sizeX / 2 + INTERIOR.wallThickness / 2];
        const east = [ws.x + ws.sizeX / 2 - INTERIOR.wallThickness / 2, ws.x + ws.sizeX / 2 + INTERIOR.wallThickness / 2];
        // 端点进墙（墙带内）——被墙截断的视觉由不透明墙体保证
        expect(ext.x1, `${strip.line_id} 西端没进墙`).toBeGreaterThanOrEqual(west[0]);
        expect(ext.x1).toBeLessThanOrEqual(west[1]);
        expect(ext.x2, `${strip.line_id} 东端没进墙`).toBeGreaterThanOrEqual(east[0]);
        expect(ext.x2).toBeLessThanOrEqual(east[1]);
        // 延长后的灯带与南北墙零重叠（不许斜穿出车间）
        const lamp = { x: (ext.x1 + ext.x2) / 2, sx: ext.x2 - ext.x1, z: strip.z, sz: 0.34 };
        const crossing = walls.filter((p) => {
          const s = span(p);
          return overlaps(s.x, [lamp.x - lamp.sx / 2, lamp.x + lamp.sx / 2]) && overlaps(s.z, [lamp.z - lamp.sz / 2, lamp.z + lamp.sz / 2]) && s.x[1] - s.x[0] > 0.5;
        });
        expect(crossing.length, `${strip.line_id} 被南北墙穿过`).toBe(0);
      }
    }
  });

  it('设备与道具仍按色带本体布置（延长段只许用于绘制，不许带走设备）', () => {
    for (const strip of LINE_STRIPS) {
      for (const [id, d] of Object.entries(DEVICE_LAYOUT)) {
        if (Math.abs(d.z - strip.z) > 0.6) continue;
        if (Math.sign(d.x) !== Math.sign(strip.x1)) continue; // 排除另一车间的同 z 设备
        expect(d.x, `${id} 应在色带本体 ${strip.x1}..${strip.x2} 内`).toBeGreaterThanOrEqual(strip.x1 - 1);
        expect(d.x).toBeLessThanOrEqual(strip.x2 + 1);
      }
    }
  });

  it('没有非盒体的意外形状（墙系/柱列都应是盒；地面油渍与螺栓是有意用圆柱的，paint 组除外）', () => {
    expect(parts.filter((p) => p.group !== 'paint' && !isBox(p))).toHaveLength(0);
    // paint 组里只允许"贴地扁件"：box 或扁平圆柱（sy ≤ 0.02）
    expect(parts.filter((p) => p.group === 'paint' && p.shape === 'cyl' && p.sy > 0.02)).toHaveLength(0);
  });
});

describe('室外剖切（D 批 R1 追加）', () => {
  const CUT_RE = /^(WS-A|WS-B):(north|south|west|east)$/;

  it('cut 标记只落在墙系件上，且 id 格式合法', () => {
    const marked = parts.filter((p) => p.cut);
    expect(marked.length).toBeGreaterThan(0);
    for (const p of marked) expect(p.cut, `${p.group}@(${p.x},${p.z})`).toMatch(CUT_RE);
    // 包柱不许被剖（车间轮廓靠它）；屋架已删，顶部自然也不该有可剖的 metal 件
    expect(parts.filter((p) => p.color === INTERIOR_COLORS.pilaster && p.cut)).toHaveLength(0);
    expect(parts.filter((p) => p.group === 'metal' && p.y > 7 && p.cut)).toHaveLength(0);
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

describe('R1.5 A 层：柱列与地面细节', () => {
  // 护脚与踢脚线同色（作者指定都是 #1f2b3a），按尺寸区分：护脚 0.5×0.5、高 1
  const isFoot = (p: (typeof parts)[number]) => p.sy === 1 && p.sx === 0.5 && p.sz === 0.5;
  const colBody = parts.filter((p) => p.color === INTERIOR_COLORS.column);
  const colFoot = parts.filter((p) => p.color === INTERIOR_COLORS.columnFoot && isFoot(p));

  it('柱列：每车间 2 排（z=±10）× 2 列 = 4 根；中排 z=0 已按作者 2026-11-26 要求删除', () => {
    expect(colBody).toHaveLength(WORKSHOPS.length * 4);
    expect(colFoot).toHaveLength(WORKSHOPS.length * 4);
    // 中排不许回来：z=0 附近（±1m）不许有任何柱
    for (const p of [...colBody, ...colFoot]) {
      expect(Math.abs(p.z - WORKSHOPS.find((w) => Math.abs(p.z - w.z) < 12)!.z)).toBeGreaterThan(9);
    }
    for (const p of [...colBody, ...colFoot]) {
      expect(p.sx).toBeCloseTo(0.5, 6);
      expect(p.sz).toBeCloseTo(0.5, 6);
    }
    for (const p of colBody) expect(p.sy).toBeCloseTo(INTERIOR.wallHeight - 1, 6);
    for (const p of colFoot) expect(p.sy).toBeCloseTo(1, 6);
    // 柱身坐护脚上：柱身 y 范围 1..8，护脚 0..1
    for (const p of colBody) expect(p.y - p.sy / 2).toBeCloseTo(1, 6);
    for (const p of colFoot) expect(p.y - p.sy / 2).toBeCloseTo(0, 6);
  });

  it('柱列不压产线色带，且离设备最内排 ≥ 1m', () => {
    for (const strip of LINE_STRIPS) {
      const blocked = [...colBody, ...colFoot].filter((p) => {
        const s = span(p);
        return overlaps(s.x, [strip.x1, strip.x2]) && overlaps(s.z, [strip.z - 0.6, strip.z + 0.6]);
      });
      expect(blocked.length, `${strip.line_id} 被柱子压住`).toBe(0);
    }
    for (const [id, d] of Object.entries(DEVICE_LAYOUT)) {
      for (const p of [...colBody, ...colFoot]) {
        const s = span(p);
        const inX = d.x + 0.5 > s.x[0] && d.x - 0.5 < s.x[1];
        const inZ = d.z + 0.5 > s.z[0] && d.z - 0.5 < s.z[1];
        expect(inX && inZ, `${id} 与柱 (${p.x},${p.z}) 净距不足`).toBe(false);
      }
    }
  });

  it('地面细节全在 paint 组：砖缝 36、盖板 3+格栅 12、油渍 6 片、螺栓 12 颗', () => {
    const paint = parts.filter((p) => p.group === 'paint');    const seam = paint.filter((p) => p.color === INTERIOR_COLORS.seam);
    const grate = paint.filter((p) => p.color === INTERIOR_COLORS.grate);
    const rib = paint.filter((p) => p.color === INTERIOR_COLORS.grateRib);
    const stain = paint.filter((p) => p.color === INTERIOR_COLORS.stain);
    const stain2 = paint.filter((p) => p.color === INTERIOR_COLORS.stain2);
    const bolt = paint.filter((p) => p.color === INTERIOR_COLORS.bolt);
    expect(seam).toHaveLength(WORKSHOPS.length * 18);
    expect(grate).toHaveLength(3);
    expect(rib).toHaveLength(12);
    expect(stain.length).toBe(3);
    expect(stain2.length).toBe(3);
    expect(bolt).toHaveLength(12);
    // 都贴地（y ∈ (0, 0.05)），不飘不埋
    for (const p of [...seam, ...grate, ...rib, ...stain, ...stain2, ...bolt]) {
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(0.05);
    }
  });

  it('柱列与地面细节不参与室外剖切', () => {
    for (const p of [...colBody, ...colFoot]) expect(p.cut).toBeUndefined();
  });
});
