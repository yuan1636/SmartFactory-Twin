/**
 * 建筑层次（批 2b，D-81）：二层办公夹层 + 独立动力站体量 + 一跨仓储。
 *
 * 为什么需要这一批：批 2a 把层高从 8 m 抬到 12 m 后，车间里只有 3 台设备，
 * 空旷感反而被放大（验收 §21.4 原话："12 m 净空只会放大空"）。作者 2026-11-26 17:53
 * 明确「不需要添加顶部栏杆影响视线」，所以补体积只能靠**体量**而不是杆件：
 *   - 动力站：原来只有一块地坪 + 两台辅助设备，等于露天摆放；补成一栋带屋顶与排风管的房子；
 *   - 仓储跨：厂区北侧原本空着，补一跨带柱的棚库，给总览机位一个"厂房后面还有东西"的天际线；
 *   - 办公夹层：在 WS-B 北侧补二层玻璃房，给 12 m 净空一个"人待的地方"作尺度参照。
 *
 * 三条自我约束（与 envInterior 同款）：
 *  1. 只产出 `EnvPart`，颜色走顶点色，只并入既有的 shell / matte / metal / glass 四组，
 *     **不新增材质、不新增 draw call**；
 *  2. 不依赖 three（纯数据，可单测）；
 *  3. **不进 metal 组的顶部**：envInterior.test.ts 有一条反向守卫
 *     「metal 组 y-半高 > 层高-1 m 的部件必须为 0」，屋面一律走 shell（且 shell 不投影）。
 */

import { POWER_STATION, WORKSHOPS } from './layout';
import type { EnvPart } from './envLayout';

/** 配色：与既有环境层同一套冷灰，局部压深一档做"体量的暗部" */
const ARCH_COLORS = {
  plinth: 0x2f3841,
  wall: 0x66707b,
  roof: 0x3d4650,
  fascia: 0x566069,
  concrete: 0x6d7781,
  beam: 0x3f4954,
  glass: 0x9fc4e0,
  mullion: 0x4b5561,
  louver: 0x2b333c,
  stack: 0x59636d,
  rack: 0x7d8792,
  rackBoard: 0x98a1aa,
  pallet: 0x8a6a3f,
  crate: 0x7d8792,
  tread: 0x8b9299,
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
): EnvPart {
  return { group, shape: 'box', color, x, y, z, sx, sy, sz };
}

function cyl(group: Group, color: number, x: number, y: number, z: number, r: number, h: number): EnvPart {
  return { group, shape: 'cyl', color, x, y, z, sx: r, sy: h, sz: r };
}

/**
 * 独立动力站：地坪台基 + 三面墙 + 平屋面 + 女儿墙 + 百叶 + 两根排风管。
 *
 * 南面留 x ∈ [-5, 5] 的开口（面向厂区），里面 AIR-01 / PUMP-01 仍看得见——
 * 这两台是项目事实里的设备，不能被封死在盒子里。开口上方补过梁，避免"墙悬空"。
 */
export function buildPowerHouse(): EnvPart[] {
  const { x, z, sizeX, sizeZ, height: H } = POWER_STATION;
  const parts: EnvPart[] = [];
  const W = 0.3; // 墙厚
  const halfX = sizeX / 2;
  const halfZ = sizeZ / 2;
  const hx = halfX + 0.4; // 台基比墙体各外扩 0.4 m
  const hz = halfZ + 0.4;

  // 台基（0.3 m）：比地面高一步，读得出"这是一栋房子不是一块地"
  parts.push(box('matte', ARCH_COLORS.plinth, x, 0.15, z, hx * 2, 0.3, hz * 2));

  // 三面墙：北（背）、东、西；南面留开口
  parts.push(box('shell', ARCH_COLORS.wall, x, H / 2 + 0.3, z + halfZ, sizeX + W, H, W));
  for (const sx of [-1, 1]) {
    parts.push(box('shell', ARCH_COLORS.wall, x + sx * halfX, H / 2 + 0.3, z, W, H, sizeZ));
  }
  // 南面：两侧各一段实墙 + 4.2 m 以上过梁（开口 10 m 宽，正对厂区通道）
  const pierW = (sizeX - 10) / 2;
  for (const sx of [-1, 1]) {
    parts.push(
      box('shell', ARCH_COLORS.wall, x + sx * (5 + pierW / 2), H / 2 + 0.3, z - halfZ, pierW, H, W),
    );
  }
  parts.push(box('shell', ARCH_COLORS.wall, x, H - 0.4 + 0.3, z - halfZ, 10, 0.8, W));

  // 平屋面 + 女儿墙（女儿墙进 metal 组但顶在 5.4 m，不触发"顶部杆件"守卫）
  const roofY = H + 0.3;
  parts.push(box('shell', ARCH_COLORS.roof, x, roofY + 0.13, z, hx * 2 + 0.2, 0.26, hz * 2 + 0.2));
  for (const sz of [-1, 1]) {
    parts.push(box('metal', ARCH_COLORS.fascia, x, roofY + 0.45, z + sz * (hz), hx * 2 + 0.2, 0.4, 0.18));
  }
  for (const sx of [-1, 1]) {
    parts.push(box('metal', ARCH_COLORS.fascia, x + sx * hx, roofY + 0.45, z, 0.18, 0.4, hz * 2 + 0.2));
  }

  // 百叶（东西外墙各 5 道，深色横向条带——一条墙只要有一条百叶就读得出"这是设备房"）
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 5; i += 1) {
      parts.push(
        box('matte', ARCH_COLORS.louver, x + sx * (halfX + W / 2 + 0.02), 1.6 + i * 0.5, z, 0.06, 0.18, sizeZ - 2.4),
      );
    }
  }

  // 排风管：一根粗的（主排风）+ 一根细的（冷却水排空），都从屋面伸出去
  parts.push(cyl('metal', ARCH_COLORS.stack, x + 6.0, roofY + 2.4, z + 3.2, 0.42, 4.8));
  parts.push(cyl('matte', ARCH_COLORS.roof, x + 6.0, roofY + 4.9, z + 3.2, 0.52, 0.24));
  parts.push(cyl('metal', ARCH_COLORS.stack, x + 4.4, roofY + 1.7, z + 3.6, 0.26, 3.4));
  parts.push(cyl('matte', ARCH_COLORS.roof, x + 4.4, roofY + 3.5, z + 3.6, 0.34, 0.2));

  return parts;
}

/**
 * 一跨仓储棚库：柱 + 屋面 + 三面墙 + 内部货架（南面敞开，正对厂区）。
 *
 * 放在**南侧场地、动力站东侧**而不是厂区北侧：北侧 z < -15 的体量会被 12 m 高的车间
 * 完全挡住（实测总览机位一张截图里根本看不见），等于白建。南侧场地的矮体量
 * 从 (4,40,48) 机位看只在画面下缘占一条，视线掠过它的高度约 16 m，不会遮住车间内部。
 *
 * 高度 5.6 m：单层库房，压得比车间（12 m）低一档，才读得出"附属建筑"而不是"第三栋厂房"。
 */
export function buildStorageBay(): EnvPart[] {
  const parts: EnvPart[] = [];
  const cx = 14.5;
  const cz = 21;
  const sizeX = 10;
  const sizeZ = 8;
  const H = 5.6;
  const halfX = sizeX / 2;
  const halfZ = sizeZ / 2;

  // 柱：3 列 × 2 排
  for (const dx of [-halfX + 0.3, 0, halfX - 0.3]) {
    for (const dz of [-halfZ + 0.4, halfZ - 0.4]) {
      parts.push(box('matte', ARCH_COLORS.concrete, cx + dx, H / 2, cz + dz, 0.3, H, 0.3));
      parts.push(box('matte', ARCH_COLORS.plinth, cx + dx, 0.12, cz + dz, 0.42, 0.24, 0.42));
    }
  }

  // 屋面（shell：不投影，否则库内的光全被挡掉）+ 檐口
  parts.push(box('shell', ARCH_COLORS.roof, cx, H + 0.12, cz, sizeX + 0.5, 0.24, sizeZ + 0.5));
  for (const sz of [-1, 1]) {
    parts.push(box('metal', ARCH_COLORS.fascia, cx, H + 0.36, cz + sz * (halfZ + 0.25), sizeX + 0.5, 0.4, 0.14));
  }
  for (const sx of [-1, 1]) {
    parts.push(box('metal', ARCH_COLORS.fascia, cx + sx * (halfX + 0.25), H + 0.36, cz, 0.14, 0.4, sizeZ + 0.5));
  }

  // 三面墙（北 + 东西），南面敞开对着厂区
  parts.push(box('shell', ARCH_COLORS.wall, cx, H / 2, cz - halfZ, sizeX + 0.5, H, 0.28));
  for (const sx of [-1, 1]) {
    parts.push(box('shell', ARCH_COLORS.wall, cx + sx * halfX, H / 2, cz, 0.28, H, sizeZ));
  }

  // 内部：两组货架（3 层板 + 4 立柱），按 10 m 跨缩放
  for (const dx of [-2.4, 2.4]) {
    const rx = cx + dx;
    const rz = cz - 1.6;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        parts.push(box('metal', ARCH_COLORS.rack, rx + sx * 1.1, 1.15, rz + sz * 0.45, 0.08, 2.3, 0.08));
      }
    }
    for (const y of [0.6, 1.35, 2.1]) {
      parts.push(box('metal', ARCH_COLORS.rackBoard, rx, y, rz, 2.4, 0.06, 1.0));
    }
    for (let i = 0; i < 3; i += 1) {
      parts.push(box('matte', ARCH_COLORS.crate, rx - 0.8 + i * 0.8, 0.9, rz, 0.7, 0.5, 0.8));
    }
    for (let i = 0; i < 2; i += 1) {
      parts.push(box('matte', ARCH_COLORS.crate, rx - 0.4 + i * 0.8, 1.65, rz, 0.7, 0.5, 0.8));
    }
  }
  // 靠西墙的两垛托盘（周转料，不摆满）
  for (const dz of [-2.2, 0.6]) {
    for (let i = 0; i < 3; i += 1) {
      parts.push(box('matte', ARCH_COLORS.pallet, cx - 3.9, 0.07 + i * 0.14, cz + dz, 1.2, 0.14, 1.0));
    }
  }

  return parts;
}

/**
 * 二层办公夹层：WS-B 北侧（z = -14.6 ~ -10.8），楼板标高 4.6 m。
 *
 * 为什么放北侧而不是东端：东端 x 27~36 是 B 线色带末端与下料滑台的位置，
 * 夹层压在上面会从总览机位挡住"物料下线"这一段；北侧设备最外沿 z = -8.8，
 * 夹层内沿 z = -10.8，净距 2 m，俯视不遮设备、侧视成一条 4.6~7.4 m 的横向体量。
 */
export function buildOfficeMezzanine(): EnvPart[] {
  const parts: EnvPart[] = [];
  const ws = WORKSHOPS.find((w) => w.id === 'WS-B') ?? WORKSHOPS[1];
  const x1 = ws.x - 15; // 5
  const x2 = ws.x + 9; // 29
  const zFront = ws.z - ws.sizeZ / 2 + 0.4; // -14.6（贴北墙内侧）
  const zBack = zFront + 3.8; // -10.8（面向车间的一侧）
  const floorY = 4.6;
  const ceilY = 7.4;
  const cx = (x1 + x2) / 2;
  const len = x2 - x1;
  const depth = zBack - zFront;

  // 楼板 + 前缘梁（楼板下的暗色带，读得出"这是二层"）
  parts.push(box('matte', ARCH_COLORS.concrete, cx, floorY - 0.11, (zFront + zBack) / 2, len, 0.22, depth));
  parts.push(box('matte', ARCH_COLORS.beam, cx, floorY - 0.34, zBack - 0.1, len, 0.46, 0.24));

  // 支承柱：4 根，落在楼板下
  for (const dx of [-10, -3.4, 3.2, 9.8]) {
    parts.push(box('matte', ARCH_COLORS.beam, cx + dx, (floorY - 0.22) / 2, zBack - 0.5, 0.32, floorY - 0.22, 0.32));
  }

  // 顶板（房间的"天花板"，同时给夹层一个明确的厚度）
  parts.push(box('matte', ARCH_COLORS.roof, cx, ceilY + 0.09, (zFront + zBack) / 2, len, 0.18, depth));

  // 玻璃隔断：8 个开间，每间 2.6 m；竖梃进 metal 组
  const bays = 8;
  const bayW = len / bays;
  for (let i = 0; i < bays; i += 1) {
    const bx = x1 + bayW * (i + 0.5);
    parts.push(
      box('glass', ARCH_COLORS.glass, bx, (floorY + ceilY) / 2, zBack, bayW - 0.16, ceilY - floorY - 0.1, 0.05),
    );
    parts.push(box('metal', ARCH_COLORS.mullion, x1 + bayW * i, (floorY + ceilY) / 2, zBack, 0.1, ceilY - floorY, 0.14));
  }
  parts.push(box('metal', ARCH_COLORS.mullion, x2, (floorY + ceilY) / 2, zBack, 0.1, ceilY - floorY, 0.14));
  // 上沿横梁 + 下沿栏板（玻璃上方与楼板之间收口）
  parts.push(box('metal', ARCH_COLORS.mullion, cx, ceilY - 0.06, zBack, len, 0.12, 0.14));
  parts.push(box('shell', ARCH_COLORS.beam, cx, floorY + 0.16, zBack, len, 0.32, 0.16));

  // 楼梯：从车间地面直跑到二层（x 4.0~5.6，z -6.2 → -10.8）
  const steps = 12;
  const rise = floorY / steps;
  const run = 0.4;
  for (let i = 1; i <= steps; i += 1) {
    const y = rise * i;
    const z = -10.8 + (steps - i) * run + run / 2;
    parts.push(box('matte', ARCH_COLORS.tread, 4.8, y - 0.03, z, 1.6, 0.06, run + 0.02));
  }
  // 楼梯两侧斜梁用两段近似（不做旋转件：斜梁旋转在合并里要额外算，收益不值）
  for (const sx of [-0.82, 0.82]) {
    parts.push(box('metal', ARCH_COLORS.mullion, 4.8 + sx, floorY / 2 - 0.1, -8.6, 0.08, 0.3, 4.4));
  }
  return parts;
}

export interface ArchResult {
  parts: EnvPart[];
  kinds: string[];
}

/** 三块建筑体量的汇总（供 envLayout.buildEnvironment 调用） */
export function buildArch(): ArchResult {
  return {
    parts: [...buildPowerHouse(), ...buildStorageBay(), ...buildOfficeMezzanine()],
    kinds: ['power-house', 'storage-bay', 'office-mezzanine'],
  };
}
