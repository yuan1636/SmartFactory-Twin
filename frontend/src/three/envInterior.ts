/**
 * 室内壳（第 4 阶段 D 批 R1，作者 2026-11-25 指定）。
 *
 * 上一版为了"能看清"把围墙整组删掉了（D-58），结果是露天场地感：没有竖向围护、
 * 没有进光方向，设备像摆在展台上。本批按作者给的参数把围护装回来，但**留洞**：
 * 南墙卷帘门洞 6×4.5、东西墙各 3 个 2×1.5 高窗洞；挡住镜头的墙由 `cutawaySides`
 * 在运行时整组退化（见文末函数注释），所以室外机位仍能看进车间内部。
 *
 * 三条自我约束：
 *  1. 只产出 `EnvPart`，颜色靠顶点色——不新增材质、不新增 draw call，仍然并进既有的
 *     matte / metal / paint / emissive / glass 五组（labels 由 envBuilder 统一处理）；
 *  2. 不依赖 three（纯数据，可单测）：越界、穿设备、洞开错位置都能在 vitest 里先暴露；
 *  3. 颜色常量在本文件内自持，不从 envLayout 取值——envLayout 要 import 本文件，
 *     反向再取值会形成运行时循环依赖（`import type` 已在编译期擦除，不受影响）。
 */

import { LINE_STRIPS, WORKSHOPS, extendedLine, type WorkshopSpec } from './layout';
import type { EnvPart } from './envLayout';

/** 作者给定尺寸（单位米） */
export const INTERIOR = {
  wallHeight: 8,
  wallThickness: 0.25,
  /** 0.8 m 踢脚线 */
  skirtingHeight: 0.8,
  skirtingThickness: 0.3,
  /** 墙角 0.4×0.4 包柱 */
  pilaster: 0.4,
  /** 南墙卷帘门洞 */
  doorWidth: 6,
  doorHeight: 4.5,
  /** 东西墙高窗：2 m 宽 × 1.5 m 高，y 4.5~6 */
  windowWidth: 2,
  windowSill: 4.5,
  windowHeight: 1.5,
  /** 窗框方管截面 */
  frame: 0.12,
  /** 灯带标高：屋架删除后独立定义，不再挂在桁架下弦之下 */
  lampY: 7.42,
} as const;

/** 墙面配色（作者给定） */
export const INTERIOR_COLORS = {
  wall: 0x8f99a3,
  skirting: 0x1f2b3a,
  pilaster: 0x57606a,
  frame: 0x6e7883,
  shutter: 0x5b656f,
  // 与 envLayout.ENV_COLORS.lamp 同值：灯带沿用既有 emissive 组
  lamp: 0xaac7e4,
  // ---- R1.5 A 层：柱列与地面细节（人眼高度 3 m 内可见的部件）----
  column: 0xa6afb8,
  columnFoot: 0x1f2b3a,
  seam: 0x3a424a,
  grate: 0x121a24,
  grateRib: 0x333c44,
  stain: 0x0b1016,
  stain2: 0x10171f,
  bolt: 0x8b9299,
} as const;

type Group = EnvPart['group'];

function box(
  group: Group,
  color: number,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  cut?: string,
): EnvPart {
  return { group, shape: 'box', color, x, y, z, sx, sy, sz, ...(cut ? { cut } : {}) };
}

/** 一面带窗洞的墙：沿长度方向切段（洞两侧 + 上下）。cut = 相机在这侧室外时整组剖切 */
function wallBands(
  out: EnvPart[],
  wx: number,
  ws: WorkshopSpec,
  spanZ: number,
  winZ: number[],
  cut: string,
): void {
  const { wallThickness: T, windowSill, windowHeight, wallHeight: H } = INTERIOR;
  // 洞下整段（0 ~ 4.5）
  out.push(box('matte', INTERIOR_COLORS.wall, wx, windowSill / 2, ws.z, T, windowSill, spanZ, cut));
  // 洞上整段（6 ~ 8）
  const topH = H - (windowSill + windowHeight);
  out.push(box('matte', INTERIOR_COLORS.wall, wx, H - topH / 2, ws.z, T, topH, spanZ, cut));
  // 洞高区间（4.5 ~ 6）的窗间墙：窗口之外全是墙
  const half = INTERIOR.windowWidth / 2;
  let cursor = ws.z - spanZ / 2;
  const gaps: Array<[number, number]> = [];
  for (const dz of winZ) {
    gaps.push([cursor, ws.z + dz - half]);
    cursor = ws.z + dz + half;
  }
  gaps.push([cursor, ws.z + spanZ / 2]);
  for (const [a, b] of gaps) {
    if (b - a < 0.01) continue;
    out.push(box('matte', INTERIOR_COLORS.wall, wx, windowSill + windowHeight / 2, (a + b) / 2, T, windowHeight, b - a, cut));
  }
}

/** 窗框（四边各一根 0.12 方管）+ 玻璃。窗框属于墙的剖切组（玻璃在 glass 组，同一 cut id） */
function windowUnit(out: EnvPart[], wx: number, wz: number, cut: string): void {
  const { wallThickness: T, windowWidth: W, windowHeight: H, windowSill: y0, frame: F } = INTERIOR;
  const yMid = y0 + H / 2;
  const depth = T + F;
  // 上下横框
  for (const y of [y0, y0 + H]) {
    out.push(box('metal', INTERIOR_COLORS.frame, wx, y, wz, depth, F, W + F, cut));
  }
  // 左右竖框
  for (const dz of [-W / 2, W / 2]) {
    out.push(box('metal', INTERIOR_COLORS.frame, wx, yMid, wz + dz, depth, H, F, cut));
  }
  // 玻璃（沿用既有 glass 组，不新增材质）
  out.push(box('glass', 0x9fc4e0, wx, yMid, wz, 0.05, H - 0.04, W - 0.04, cut));
}

/** 卷帘门：洞口两侧导轨 + 顶部卷筒（洞本身是空的，所以从门洞能看进车间）。属南墙剖切组 */
function doorUnit(out: EnvPart[], ws: WorkshopSpec, z: number, cut: string): void {
  const { doorWidth: W, doorHeight: H } = INTERIOR;
  const half = W / 2;
  for (const sx of [-1, 1]) {
    out.push(box('metal', INTERIOR_COLORS.shutter, ws.x + sx * (half + 0.09), H / 2, z, 0.18, H, 0.3, cut));
  }
  // 卷筒：抬起状态（停在洞口上方），不做"门关着"
  out.push(box('metal', INTERIOR_COLORS.shutter, ws.x, H + 0.2, z, W, 0.4, 0.34, cut));
}

/**
 * 混凝土柱列（R1.5 A 层，作者指定）：每车间 3 排（z=-10/0/10）× 2 列（x=±10），
 * 0.5×0.5 m、总高 8 m；下 1 m 护脚 #1f2b3a，柱身 #3a4f68。并入 matte 组。
 * 不参与室外剖切（柱列是尺度参照，任何机位都该看得见）；设备最内排在 z=±7.5，
 * 柱排在 z=±10/0，与设备净距 ≥1 m。
 */
function columns(ws: WorkshopSpec): EnvPart[] {
  const out: EnvPart[] = [];
  const S = 0.5;
  const foot = 1;
  for (const dz of [-10, 0, 10]) {
    for (const dx of [-10, 10]) {
      const x = ws.x + dx;
      const z = ws.z + dz;
      out.push(box('matte', INTERIOR_COLORS.column, x, foot + (INTERIOR.wallHeight - foot) / 2, z, S, INTERIOR.wallHeight - foot, S));
      out.push(box('matte', INTERIOR_COLORS.columnFoot, x, foot / 2, z, S, foot, S));
    }
  }
  return out;
}

/**
 * 屋顶桁架：作者 2026-11-25 晚要求「黑色的杆子都去掉，影响观感」，整组删除。
 * 原实现沿 x 每 6 m 一榀、每榀 2 根弦杆 + 21 根竖腹杆，另有 3 道纵向檩条，
 * 两个车间合计约 280 根方管；从人眼机位看是一片密网，把设备压在下面。
 * 灯带（emissive 组）保留，y 由 INTERIOR.lampY 单独定义，不再依赖桁架下弦标高。
 * 反向守卫在 envInterior.test.ts：metal 组 y>7 的部件必须为 0，防止有人加回来。
 */

/**
 * 地面细节（R1.5 A 层，作者指定"人眼高度 3 m 内可见"）：全部并入 paint 组
 * （MeshBasic 顶点色，所见即所得，不参与光照）。四类：
 *  1. 地砖缝分格线：每 3 m 一道，铺满车间内部（0.05 宽，颜色略亮于地面）；
 *  2. 排水沟盖板：3 块（两车间线头旁 + 中央走廊），带 4 根格栅条；
 *  3. 油渍贴花：3 处，各两片叠放的深色扁圆柱；
 *  4. 地面膨胀螺栓：12 颗，集中在 WALK 机位脚下的线头区与走廊。
 * y 高度分层（0.004~0.026）避免与产线色带/通道漆 z-fighting。
 */
function floorDetails(): EnvPart[] {
  const out: EnvPart[] = [];
  const { seam, grate, grateRib, stain, stain2, bolt } = INTERIOR_COLORS;

  // 1. 砖缝：车间内部每 3 m 一道（经纬各 ~9 道 × 2 车间）
  for (const ws of WORKSHOPS) {
    for (const dx of [-12, -9, -6, -3, 0, 3, 6, 9, 12]) {
      out.push(box('paint', seam, ws.x + dx, 0.006, ws.z, 0.05, 0.004, ws.sizeZ - 2.5));
    }
    for (const dz of [-12, -9, -6, -3, 0, 3, 6, 9, 12]) {
      out.push(box('paint', seam, ws.x, 0.006, ws.z + dz, ws.sizeX - 2.5, 0.004, 0.05));
    }
  }

  // 2. 排水沟盖板：1.4×0.9 底板 + 4 根横格栅
  const grates: Array<[number, number]> = [
    [-33.2, -3.2], // WS-A，LINE-A1 线头旁（WALK 机位脚下可见）
    [10.8, -3.2], // WS-B，LINE-B1 线头旁
    [1.9, 6.5], // 中央走廊
  ];
  for (const [gx, gz] of grates) {
    out.push(box('paint', grate, gx, 0.012, gz, 1.4, 0.016, 0.9));
    for (let i = 0; i < 4; i += 1) {
      out.push(box('paint', grateRib, gx - 0.45 + i * 0.3, 0.024, gz, 0.09, 0.006, 0.9));
    }
  }

  // 3. 油渍：两片错位扁圆叠出"不规则"轮廓
  const stains: Array<[number, number]> = [
    [-28.6, -4.6], // CNC-01 旁
    [-1.4, -8.2], // 走廊北段
    [17.8, 4.8], // ROB-04 旁
  ];
  for (const [sx, sz] of stains) {
    out.push({ group: 'paint', shape: 'cyl', color: stain, x: sx, y: 0.005, z: sz, sx: 0.62, sy: 0.004, sz: 0.62 });
    out.push({ group: 'paint', shape: 'cyl', color: stain2, x: sx + 0.25, y: 0.006, z: sz + 0.18, sx: 0.34, sy: 0.004, sz: 0.34 });
  }

  // 4. 膨胀螺栓：r 0.035 的小圆头，线头区 8 颗 + 走廊 4 颗
  const bolts: Array<[number, number]> = [
    [-34.2, -5.3], [-34.2, -9.7], [-33.4, -5.3], [-33.4, -9.7],
    [-36.2, -5.3], [-36.2, -9.7], [-31.4, -4.4], [-31.4, -10.6],
    [-1.9, -10.5], [1.9, -10.5], [-1.9, 10.5], [1.9, 10.5],
  ];
  for (const [bx, bz] of bolts) {
    out.push({ group: 'paint', shape: 'cyl', color: bolt, x: bx, y: 0.01, z: bz, sx: 0.035, sy: 0.02, sz: 0.035 });
  }
  return out;
}

export interface InteriorResult {
  parts: EnvPart[];
  kinds: string[];
}

/**
 * 室内壳：两个车间各一套（墙 + 踢脚线 + 包柱 + 门窗洞 + 桁架 + 灯带）。
 * 灯带沿用既有的 emissive 组：四条产线正上方各一道，共 4 道（中央通道那道已按作者 2026-11-26 要求删除）。
 */
export function buildInterior(): InteriorResult {
  const parts: EnvPart[] = [];
  const { wallHeight: H, wallThickness: T, pilaster: P, doorWidth: DW } = INTERIOR;
  const winZ = [-8, 0, 8];

  for (const ws of WORKSHOPS) {
    const x1 = ws.x - ws.sizeX / 2;
    const x2 = ws.x + ws.sizeX / 2;
    const z1 = ws.z - ws.sizeZ / 2;
    const z2 = ws.z + ws.sizeZ / 2;
    const spanX = ws.sizeX + T; // 两端各让半个墙厚，四角不留缝
    const spanZ = ws.sizeZ + T;

    // ---- 北墙（-z）：整段 ----
    parts.push(box('matte', INTERIOR_COLORS.wall, ws.x, H / 2, z1, spanX, H, T, `${ws.id}:north`));

    // ---- 南墙（+z）：6 m × 4.5 m 卷帘门洞 ----
    const south = `${ws.id}:south`;
    const doorHalf = DW / 2;
    const leftA = x1 - T / 2;
    const leftB = ws.x - doorHalf;
    parts.push(box('matte', INTERIOR_COLORS.wall, (leftA + leftB) / 2, H / 2, z2, leftB - leftA, H, T, south));
    const rightA = ws.x + doorHalf;
    const rightB = x2 + T / 2;
    parts.push(box('matte', INTERIOR_COLORS.wall, (rightA + rightB) / 2, H / 2, z2, rightB - rightA, H, T, south));
    // 门上过梁
    parts.push(box('matte', INTERIOR_COLORS.wall, ws.x, (INTERIOR.doorHeight + H) / 2, z2, DW, H - INTERIOR.doorHeight, T, south));
    doorUnit(parts, ws, z2, south);

    // ---- 东西墙（±x）：各 3 个高窗洞 ----
    for (const sx of [-1, 1] as const) {
      const wx = ws.x + sx * (ws.sizeX / 2);
      const side = `${ws.id}:${sx > 0 ? 'east' : 'west'}`;
      wallBands(parts, wx, ws, spanZ, winZ, side);
      for (const dz of winZ) windowUnit(parts, wx, ws.z + dz, side);
    }

    // ---- 踢脚线（0.8 m，贴内侧；南墙让开门洞）----
    const skirtZ = T / 2 + INTERIOR.skirtingThickness / 2;
    const skirtLen = ws.sizeZ - 0.5;
    parts.push(box('matte', INTERIOR_COLORS.skirting, ws.x, INTERIOR.skirtingHeight / 2, z1 + skirtZ, ws.sizeX - 0.5, INTERIOR.skirtingHeight, INTERIOR.skirtingThickness));
    parts.push(box('matte', INTERIOR_COLORS.skirting, ws.x, INTERIOR.skirtingHeight / 2, z2 - skirtZ, ws.sizeX - 0.5, INTERIOR.skirtingHeight, INTERIOR.skirtingThickness, south));
    for (const sx of [-1, 1] as const) {
      const side = `${ws.id}:${sx > 0 ? 'east' : 'west'}`;
      parts.push(box('matte', INTERIOR_COLORS.skirting, ws.x + sx * (ws.sizeX / 2 - skirtZ), INTERIOR.skirtingHeight / 2, ws.z, INTERIOR.skirtingThickness, INTERIOR.skirtingHeight, skirtLen, side));
    }

    // ---- 墙角包柱 0.4×0.4 ----
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        parts.push(box('matte', INTERIOR_COLORS.pilaster, ws.x + sx * (ws.sizeX / 2 - T / 2 - P / 2), H / 2, ws.z + sz * (ws.sizeZ / 2 - T / 2 - P / 2), P, H, P));
      }
    }

    // ---- 混凝土柱列（R1.5 A 层）----
    parts.push(...columns(ws));
    // 屋架已按作者要求删除（2026-11-25 晚），顶部只留 5 道灯带
  }

  // ---- 地面细节（R1.5 A 层，paint 组）----
  parts.push(...floorDetails());

  // ---- 灯带（沿用 emissive 组，4 道：只照产线）；灯管同样延长 3 m 顶进墙内，与地面色带一致 ----
  // 中央通道那道已删（作者 2026-11-26：「中间的白线没有作用」）——站在走廊机位看，
  // 它在画面正中缩成一条竖白线，只添乱。以后要加，用 extendedLine() 同款写法。
  for (const strip of LINE_STRIPS) {
    const ext = extendedLine(strip);
    const mid = (ext.x1 + ext.x2) / 2;
    const len = Math.abs(ext.x2 - ext.x1);
    parts.push(box('emissive', INTERIOR_COLORS.lamp, mid, INTERIOR.lampY, strip.z, len, 0.12, 0.34));
  }

  return {
    parts,
    kinds: ['interior-walls', 'skirting', 'pilasters', 'columns', 'floor-detail', 'light-strips', 'window-bays', 'roller-door'],
  };
}

/** 窗洞清单（给单测与验收断言"东西墙各 3 个、高度对"用） */
export interface WindowOpening {
  workshop: string;
  side: 'east' | 'west';
  x: number;
  z: number;
  sillY: number;
  width: number;
  height: number;
}

export function windowOpenings(): WindowOpening[] {
  const list: WindowOpening[] = [];
  for (const ws of WORKSHOPS) {
    for (const sx of [-1, 1] as const) {
      for (const dz of [-8, 0, 8]) {
        list.push({
          workshop: ws.id,
          side: sx > 0 ? 'east' : 'west',
          x: ws.x + sx * (ws.sizeX / 2),
          z: ws.z + dz,
          sillY: INTERIOR.windowSill,
          width: INTERIOR.windowWidth,
          height: INTERIOR.windowHeight,
        });
      }
    }
  }
  return list;
}

/**
 * 剖切规则：相机落在某车间的某一侧**室外**时，那一侧的墙整组退化为不可见。
 *
 * 为什么不做半透明：半透明要改材质（加 transparent 或新材质），会破坏
 * "六个合并组封顶"的约束；退化为不可见只需要改合并后的索引，阴影 pass 走
 * 同一份索引，天然不会出现"墙没了影子还在"的穿帮。
 * 包柱不剖（四角留柱，车间轮廓仍读得出来）；桁架不剖（俯视/侧视都有顶盖感）。
 *
 * 纯函数（只吃 x/z），单测直接覆盖总览/入场/车间内三个典型机位。
 */
export function cutawaySides(camera: { x: number; z: number }): string[] {
  const out: string[] = [];
  for (const ws of WORKSHOPS) {
    const x1 = ws.x - ws.sizeX / 2;
    const x2 = ws.x + ws.sizeX / 2;
    const z1 = ws.z - ws.sizeZ / 2;
    const z2 = ws.z + ws.sizeZ / 2;
    if (camera.z < z1) out.push(`${ws.id}:north`);
    if (camera.z > z2) out.push(`${ws.id}:south`);
    if (camera.x < x1) out.push(`${ws.id}:west`);
    if (camera.x > x2) out.push(`${ws.id}:east`);
  }
  return out;
}
