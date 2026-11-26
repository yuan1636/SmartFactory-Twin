/**
 * 工业道具的摆放表（D2）。纯数据，不依赖 three，可单独单测。
 *
 * 原则：
 * 1. **一律由既有常量推导**，不另写一套坐标——设备挪了道具必须跟着挪，否则迟早错位。
 * 2. 每个道具都要给出「为什么放这」，因为答辩时最容易被问"这排栏杆是随手加的吗"。
 * 3. 所有位置都要能通过「与设备包围盒不相交」的脚本检查（见 scripts/acceptance-d2.mjs）。
 */

import {
  DEVICE_LAYOUT,
  DEVICE_SIZES,
  FACTORY,
  LINE_STRIPS,
  POWER_STATION,
  WORKSHOPS,
  sizeKeyOf,
} from './layout';
import type { EnvPart } from './envLayout';

/** 设备类型判定：与 builders.ts 的 typeOfId 保持一致（改一处要改两处，故只判断会用到 AUX 的部分） */
function sizeOf(deviceId: string): { x: number; y: number; z: number } {
  if (deviceId.startsWith('CNC')) return DEVICE_SIZES.CNC;
  if (deviceId.startsWith('ROB')) return DEVICE_SIZES.ROBOT;
  if (deviceId.startsWith('CONV')) return DEVICE_SIZES.CONVEYOR;
  if (deviceId.startsWith('INSP')) return DEVICE_SIZES.INSPECTION;
  return sizeKeyOf('AUX', deviceId) === 'AUX_PUMP' ? DEVICE_SIZES.AUX_PUMP : DEVICE_SIZES.AUX_AIR;
}

// ---------------------------------------------------------------- 设备基座

export interface PlinthSpec {
  deviceId: string;
  x: number;
  z: number;
  sizeX: number;
  sizeZ: number;
  /** 台面高度。设备本体不动，基座从地面长到 0.16，视觉上像设备坐在混凝土基础上 */
  height: number;
}

/**
 * 每台设备一块基座，比机身外扩 0.5 m（露出一圈台面）。
 * 为什么需要：D0 拍到的设备是"直接浮在地面上"的，没有与地面的接触关系（问题 #5）。
 */
export const PLINTH_HEIGHT = 0.16;
export const PLINTH_MARGIN = 0.5;

export function buildPlinths(): PlinthSpec[] {
  return Object.entries(DEVICE_LAYOUT).map(([deviceId, placement]) => {
    const size = sizeOf(deviceId);
    return {
      deviceId,
      x: placement.x,
      z: placement.z,
      sizeX: size.x + PLINTH_MARGIN * 2,
      sizeZ: size.z + PLINTH_MARGIN * 2,
      height: PLINTH_HEIGHT,
    };
  });
}

// ---------------------------------------------------------------- 护栏

export interface RailingRun {
  lineId: string;
  x1: number;
  x2: number;
  z: number;
  /** 立柱根数（间距 ≤2 m） */
  posts: number;
}

/**
 * 护栏到产线中心的横向距离。
 *
 * 不能取 1.5：基座外扩 0.5 后，CNC 的占地半深是 2.6/2 + 0.5 = 1.8 m，
 * 1.5 会让护栏立柱直接扎进基座里（截图上看是"护栏穿过设备下方"）。
 * 取 2.0 留 0.2 m 净距，并由 propLayout.test.ts 的包围盒断言守住。
 */
export const RAILING_OFFSET = 2.0;
export const RAILING_HEIGHT = 1.05;
export const RAILING_POST_GAP = 2.0;

/**
 * 每条产线两侧各一道护栏。
 * 放在 ±1.5 m：色带宽 1.2（±0.6），CNC 机身深 2.6（±1.3），
 * 所以 1.5 刚好在机身外侧留 0.2 m，不与任何设备相交（有脚本断言）。
 */
export function buildRailings(): RailingRun[] {
  const runs: RailingRun[] = [];
  for (const strip of LINE_STRIPS) {
    const span = Math.abs(strip.x2 - strip.x1);
    const posts = Math.max(2, Math.round(span / RAILING_POST_GAP) + 1);
    for (const sign of [-1, 1]) {
      runs.push({
        lineId: strip.line_id,
        x1: Math.min(strip.x1, strip.x2),
        x2: Math.max(strip.x1, strip.x2),
        z: strip.z + sign * RAILING_OFFSET,
        posts,
      });
    }
  }
  return runs;
}

// ---------------------------------------------------------------- 地面警示带

export interface HazardStripSpec {
  x: number;
  z: number;
  sizeX: number;
  sizeZ: number;
}

export const HAZARD_WIDTH = 0.4;

/**
 * 黄黑警示带只画在**通道边界**，不铺在产线脚下。
 * 原因：产线上每 5.5 m 就有一台设备，铺在脚下会被机身压住一半，看起来像贴图错误。
 * 中央通道 x∈[-3,3]，两侧各一条；动力站四周各一条。
 */
export function buildHazardStrips(): HazardStripSpec[] {
  const strips: HazardStripSpec[] = [];
  const wsHalfZ = WORKSHOPS[0].sizeZ / 2; // 30/2=15，两条车间同深

  for (const sign of [-1, 1]) {
    strips.push({
      x: sign * (3 + HAZARD_WIDTH / 2),
      z: 0,
      sizeX: HAZARD_WIDTH,
      sizeZ: wsHalfZ * 2,
    });
  }

  const psHalfX = POWER_STATION.sizeX / 2;
  const psHalfZ = POWER_STATION.sizeZ / 2;
  strips.push(
    { x: POWER_STATION.x, z: POWER_STATION.z - psHalfZ, sizeX: POWER_STATION.sizeX, sizeZ: HAZARD_WIDTH },
    { x: POWER_STATION.x, z: POWER_STATION.z + psHalfZ, sizeX: POWER_STATION.sizeX, sizeZ: HAZARD_WIDTH },
    { x: POWER_STATION.x - psHalfX, z: POWER_STATION.z, sizeX: HAZARD_WIDTH, sizeZ: POWER_STATION.sizeZ },
    { x: POWER_STATION.x + psHalfX, z: POWER_STATION.z, sizeX: HAZARD_WIDTH, sizeZ: POWER_STATION.sizeZ },
  );

  return strips;
}

// ---------------------------------------------------------------- 线槽

export interface TraySpec {
  x: number;
  z: number;
  /** 沿 X 或沿 Z */
  axis: 'x' | 'z';
  length: number;
}

/** 线槽贴在车间南北墙脚（东西墙留给管道，避免两样东西抢同一面墙） */
export const TRAY_HEIGHT = 0.45;
export const TRAY_WIDTH = 0.28;

export function buildTrays(): TraySpec[] {
  const trays: TraySpec[] = [];
  for (const ws of WORKSHOPS) {
    const halfZ = ws.sizeZ / 2;
    // 贴墙内表面，留 0.2 m 给墙厚
    trays.push(
      { x: ws.x, z: ws.z - halfZ + 0.25, axis: 'x', length: ws.sizeX - 1 },
      { x: ws.x, z: ws.z + halfZ - 0.25, axis: 'x', length: ws.sizeX - 1 },
    );
  }
  return trays;
}

// ---------------------------------------------------------------- 管道
//
// 作者 2026-11-25 晚要求「天花板的管道都去掉，影响观感」。原实现是每车间一根
// 贯穿东西的圆管（y=6.2）+ 两端落地立管，D2 的第 6 类道具。数据、几何、材质、
// 验收断言一并删除，不留空类别；改回管网须同步改 propBuilder.ts、
// propLayout.test.ts、scripts/acceptance-d2.mjs 与 docs/spec_phase4.md 偏差 D-72。

// ---------------------------------------------------------------- 货架

export interface RackSpec {
  x: number;
  z: number;
  width: number;
  depth: number;
  levels: number;
  height: number;
}

/**
 * 每车间两个货架，放在**对角**的车间角落。
 * 原本放在东西墙中段（z = +7.5），结果与产线设备连成一线，从任何机位看都被 CNC 挡住
 * （实测：从车间中部看西墙货架，视线正好穿过 CNC-02）。角落既空旷又不挡产线。
 * z 取 ±(sizeZ/2 - 1.1)：避开墙脚线槽（z = ±14.75，宽 0.28）。
 */
export function buildRacks(): RackSpec[] {
  const racks: RackSpec[] = [];
  for (const ws of WORKSHOPS) {
    for (const [sx, sz] of [[-1, -1], [1, 1]] as const) {
      racks.push({
        x: ws.x + sx * (ws.sizeX / 2 - 1.6),
        z: ws.z + sz * (ws.sizeZ / 2 - 1.1),
        width: 2.4,
        depth: 0.9,
        levels: 3,
        height: 2.2,
      });
    }
  }
  return racks;
}

// ---------------------------------------------------------------- 安全标识

export interface SignSpec {
  x: number;
  y: number;
  z: number;
  /** 朝向：0 = 面向 +Z，PI = 面向 -Z */
  rotY: number;
  width: number;
  height: number;
  /** 标识种类，决定用哪张贴图 */
  kind: 'exit' | 'warning' | 'notice';
}

/** 墙面标识：每车间两块（入口一个"安全出口"、产线端头一个"注意机械伤害"） */
export function buildSigns(): SignSpec[] {
  const signs: SignSpec[] = [];
  for (const ws of WORKSHOPS) {
    const halfZ = ws.sizeZ / 2 - 0.12;
    signs.push(
      { x: ws.x - ws.sizeX / 4, y: 2.6, z: ws.z + halfZ, rotY: Math.PI, width: 1.2, height: 0.6, kind: 'exit' },
      { x: ws.x + ws.sizeX / 4, y: 2.6, z: ws.z - halfZ, rotY: 0, width: 1.2, height: 0.6, kind: 'warning' },
    );
  }
  // 动力站正门
  signs.push({
    x: POWER_STATION.x,
    y: 2.4,
    z: POWER_STATION.z + POWER_STATION.sizeZ / 2 - 0.12,
    rotY: Math.PI,
    width: 1.2,
    height: 0.6,
    kind: 'notice',
  });
  return signs;
}

// ---------------------------------------------------------------- 自查

export interface Rect {
  x1: number;
  x2: number;
  z1: number;
  z2: number;
}

/** 设备占地矩形（含基座外扩），用于"道具不与设备相交"的断言 */
export function deviceFootprints(): Array<Rect & { deviceId: string }> {
  return Object.entries(DEVICE_LAYOUT).map(([deviceId, p]) => {
    const size = sizeOf(deviceId);
    const halfX = size.x / 2 + PLINTH_MARGIN;
    const halfZ = size.z / 2 + PLINTH_MARGIN;
    return { deviceId, x1: p.x - halfX, x2: p.x + halfX, z1: p.z - halfZ, z2: p.z + halfZ };
  });
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.z1 < b.z2 && a.z2 > b.z1;
}

/** 厂区边界：道具不得超出（否则会穿到墙外） */
export const FACTORY_BOUNDS: Rect = {
  x1: -FACTORY.sizeX / 2,
  x2: FACTORY.sizeX / 2,
  z1: -FACTORY.sizeZ / 2,
  z2: FACTORY.sizeZ / 2,
};

// ---------------------------------------------------------------- R1.6 场景密度件
//
// 作者 2026-11-26：车间放大后显得空旷，每个车间可辨识物体 7 → ≥22。
// 只加装饰件，不加设备。四条硬规则之外再叠加既有道具的避让（线槽/护栏/上料架/
// 角落货架/柱列），这些避让直接体现在下面的坐标推导里，测试里守五条铁律。

/** 密度件专用视觉：饱和度 ×0.85、明度 ×0.9（作者硬规则），让装饰件退到背景里 */
export const DENSITY_SAT_FACTOR = 0.85;
export const DENSITY_LUM_FACTOR = 0.9;

/** hex → HSL →（s×0.85, l×0.9）→ hex。纯函数，单测守转换数学。 */
export function densityColor(hex: number): number {
  const r = ((hex >> 16) & 255) / 255;
  const g = ((hex >> 8) & 255) / 255;
  const b = (hex & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;
  const d = max - min;
  if (d > 1e-9) {
    s = l > 0.5 ? d / Math.max(1e-9, 2 - max - min) : d / Math.max(1e-9, max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  s = Math.min(1, s * DENSITY_SAT_FACTOR);
  l = Math.min(1, l * DENSITY_LUM_FACTOR);
  // HSL → RGB
  const hue2rgb = (p: number, q: number, t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  let r2: number, g2: number, b2: number;
  if (s < 1e-9) {
    r2 = g2 = b2 = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r2 = hue2rgb(p, q, h + 1 / 3);
    g2 = hue2rgb(p, q, h);
    b2 = hue2rgb(p, q, h - 1 / 3);
  }
  const to255 = (v: number) => Math.round(v * 255);
  return (to255(r2) << 16) | (to255(g2) << 8) | to255(b2);
}

/** 密度件基色（普通工业色板），进场景前一律过 densityColor */
export const DENSITY_BASE_COLORS = {
  cabinet: 0x5d7080, // 配电柜
  shelf: 0x8b9299, // 备件货架 / WIP 料架
  cart: 0x9c3f36, // 工具车
  fire: 0xb03a2e, // 消防柜
  gas: 0x2f5d4a, // 气瓶
  pipe: 0x6e7883, // 管廊
  pallet: 0x8a6a3f, // 托盘堆
  crate: 0x9aa6b2, // 周转箱堆
  coil: 0x5a6c7e, // 卷料
  crane: 0x4a5561, // 天车轨道/小车
} as const;

/**
 * 实例化类别：重复件不进合并网格，一个类别一个 InstancedMesh（作者指定四类）。
 * 成员 part 仍带完整位姿/尺寸/颜色，envBuilder 按类别聚合成 InstancedMesh：
 * geometry 用单位体（box 1×1×1 / cyl r0.5 h1），矩阵做逐实例缩放。
 */
export type DensityInstKind = 'cabinet' | 'pallet-stack' | 'crate-stack' | 'gas-bottle';

/** 密度件用的组：只允许 matte（roughness 0.88 / metalness 0.06 ≈ 作者要求的 0.9 / 0.1） */
const D = (shape: 'box' | 'cyl', color: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, inst?: DensityInstKind) => ({
  group: 'matte' as const,
  shape,
  color: densityColor(color),
  x,
  y,
  z,
  sx,
  sy,
  sz,
  ...(inst ? { inst } : {}),
});

/** 车间几何常量（envInterior/layout 推导而来，供测试断言用；改墙厚/柱列要同步） */
export const WALL_FACE_X = 16.875; // |x| 方向墙内面（ws.sizeX/2 - 墙厚/2）
export const WALL_FACE_Z = 14.875; // |z| 方向墙内面
export const TRAY_Z = 14.75; // 墙脚线槽中心（宽 0.28）
export const COLUMN_OFFSET = 10; // 柱列 x/z 偏移（envInterior.columns：z=±10 两排、x=±10）

/**
 * 每车间的密度件偏移表（相对车间中心）。全局坐标 = ws.x + dx, ws.z + dz。
 * 所有偏移都手动核对过：设备占地（含基座）、柱列、墙脚线槽、护栏（z=±9.5）、
 * 上料架（线头 x1-2）、线头托盘堆（x1-0.9, z+2.85）、角落货架（±15.4, ±13.9）、
 * 南墙卷帘门（|dx|<3）均不相交；|dx|<2 或 |dz|<2 不放任何东西。
 */
const CABINETS = [-5.25, -3.15, -1.05, 1.05, 3.15, 5.25]; // 间距 1.2、柜宽 0.9
const SHELVES = [-8.35, -4.65, 4.65, 8.35]; // 南墙，让开 |dx|<3 的卷帘门
const PALLETS: Array<[number, number]> = [
  [-14.5, 11.5], [-11.8, 11.5], [11.8, 11.5], [14.3, 11.5],
  [-14.5, -11.5], [-11.8, -11.5], [11.8, -11.5], [14.3, -11.5],
  [-15.9, -2.8], [15.6, 4.2], [-6.8, 2.6], [6.8, -2.6],
];
const PALLET_LAYERS = [4, 3, 5, 3, 4, 5, 3, 4, 3, 4, 5, 3]; // 3~5 层循环
const CRATES: Array<[number, number]> = [
  [-13.2, 2.6], [13.2, -2.6], [-8.6, -2.6], [8.6, 2.6],
  [-14.6, 8.6], [14.6, -8.6], [-14.6, -8.6], [14.6, 8.6],
];

/**
 * R1.6 密度件（每车间 47 件 + 设备 6 = 53 个可辨识物体）：
 * 贴墙层：配电柜 6、备件货架 4、工具车 2、气瓶架 1（4 瓶）、消防柜 2、管廊 2 条通长（y=5.5）
 * 物料层：在制品料架 4（每线 2）、托盘堆 12（3~5 层）、周转箱堆 8、卷料立架 2
 * 纵深层：桥式起重机（2 根工字钢轨道 y=7.0 横跨 + 2 台天车小车）
 */
export function buildDensityProps(): EnvPart[] {
  const out: EnvPart[] = [];
  for (const ws of WORKSHOPS) {
    // ---- 贴墙层 ----
    // 配电柜：北墙一排（北墙无门窗，是唯一整面实墙），西端留出角落货架
    for (const dx of CABINETS) {
      out.push(D('box', DENSITY_BASE_COLORS.cabinet, ws.x + dx, 1.0, -14.3, 0.9, 2.0, 0.6, 'cabinet'));
    }
    // 备件货架：南墙，卷帘门两侧各 2（门洞 |dx|<3 不能堵）
    for (const dx of SHELVES) {
      const x = ws.x + dx;
      out.push(
        D('box', DENSITY_BASE_COLORS.shelf, x, 1.2, 14.15, 3.0, 2.4, 0.8),
        D('box', DENSITY_BASE_COLORS.shelf, x, 0.45, 14.15, 2.86, 0.05, 0.72), // 底层板
        D('box', DENSITY_BASE_COLORS.shelf, x, 1.22, 14.15, 2.86, 0.05, 0.72), // 中层板
      );
    }
    // 工具车：东西墙各一台（对角布置，northwest 侧留给气瓶架/消防柜）
    for (const [sx, dz] of [[-1, -12], [1, 12]] as const) {
      const x = ws.x + sx * 16.5;
      out.push(
        D('box', DENSITY_BASE_COLORS.cart, x, 0.62, dz, 0.7, 0.9, 1.1),
        D('box', DENSITY_BASE_COLORS.cart, x, 1.12, dz, 0.74, 0.05, 1.14), // 台面
      );
    }
    // 气瓶架（4 瓶）：东墙中段（西墙让给上料架），底盘 + 两根立柱 + 挡杆，瓶体实例化
    {
      const fx = ws.x + 16.55;
      const fz = 3.5;
      out.push(
        D('box', DENSITY_BASE_COLORS.gas, fx, 0.04, fz, 0.5, 0.08, 2.0), // 底盘
        D('box', DENSITY_BASE_COLORS.gas, fx, 0.76, fz - 1.02, 0.5, 1.44, 0.08),
        D('box', DENSITY_BASE_COLORS.gas, fx, 0.76, fz + 1.02, 0.5, 1.44, 0.08),
        D('box', DENSITY_BASE_COLORS.gas, fx + 0.24, 0.76, fz, 0.06, 1.44, 2.12),
      );
      for (const dz of [-0.62, -0.21, 0.21, 0.62]) {
        out.push(D('cyl', DENSITY_BASE_COLORS.gas, fx - 0.1, 0.7, fz + dz, 0.3, 1.4, 0.3, 'gas-bottle'));
      }
    }
    // 消防柜：北墙两端（柜门朝通道，不能和配电柜排挤在一起）
    for (const sx of [-1, 1]) {
      out.push(D('box', DENSITY_BASE_COLORS.fire, ws.x + sx * 12.8, 0.6, -14.3, 0.8, 1.2, 0.4));
    }
    // 管廊 2 条通长（y=5.5）：南北墙各一条，2 根 Ø0.25 管 + 每 8m 一副支架
    for (const sz of [-1, 1]) {
      const z = ws.z + sz * 14.2;
      for (const dz of [-0.18, 0.18]) {
        out.push(D('box', DENSITY_BASE_COLORS.pipe, ws.x, 5.5, z + dz, 32.8, 0.25, 0.25));
      }
      for (let k = -2; k <= 2; k += 1) {
        out.push(D('box', DENSITY_BASE_COLORS.pipe, ws.x + k * 8, 5.15, z, 0.12, 0.7, 0.5));
      }
    }

    // ---- 物料层 ----
    // 在制品料架：每条线 2 个，放在线外侧 z=±12.5（距线 5m > 3m，1.8m 高不违反铁律 5）
    for (const sz of [-1, 1]) {
      for (const sx of [-1, 1]) {
        const x = ws.x + sx * 10;
        const z = ws.z + sz * 12.5;
        out.push(
          D('box', DENSITY_BASE_COLORS.shelf, x, 0.9, z, 2.0, 1.8, 0.8),
          D('box', DENSITY_BASE_COLORS.shelf, x, 0.62, z + sz * 0.1, 1.84, 0.05, 0.6),
          D('box', DENSITY_BASE_COLORS.shelf, x, 1.24, z + sz * 0.1, 1.84, 0.05, 0.6),
        );
      }
    }
    // 托盘堆 12 处（3~5 层，实例化）：散布在两线外侧与东西墙中段
    PALLETS.forEach(([dx, dz], i) => {
      const layers = PALLET_LAYERS[i % PALLET_LAYERS.length];
      out.push(D('box', DENSITY_BASE_COLORS.pallet, ws.x + dx, (0.16 + layers * 0.16) / 2, dz, 1.2, 0.16 + layers * 0.16, 1.0, 'pallet-stack'));
    });
    // 周转箱堆 8 处（实例化）：中央区 + 东西墙中段
    for (const [dx, dz] of CRATES) {
      out.push(D('box', DENSITY_BASE_COLORS.crate, ws.x + dx, 0.36, dz, 0.85, 0.72, 0.62, 'crate-stack'));
    }
    // 卷料立架 2 处：南墙中段（A 形架 + 两卷立料）
    for (const sx of [-1, 1]) {
      const x = ws.x + sx * 4.5;
      out.push(
        D('box', DENSITY_BASE_COLORS.shelf, x, 0.1, 13.0, 2.4, 0.2, 0.8),
        D('box', DENSITY_BASE_COLORS.shelf, x - 0.9, 0.85, 13.0, 0.14, 1.5, 0.7),
        D('box', DENSITY_BASE_COLORS.shelf, x + 0.9, 0.85, 13.0, 0.14, 1.5, 0.7),
        D('cyl', DENSITY_BASE_COLORS.coil, x - 0.45, 0.85, 13.0, 1.1, 1.3, 1.1),
        D('cyl', DENSITY_BASE_COLORS.coil, x + 0.45, 0.85, 13.0, 1.1, 1.3, 1.1),
      );
    }

    // ---- 纵深层：桥式起重机（铁律 4 的豁免项）----
    for (const sz of [-1, 1]) {
      const z = ws.z + sz * 12;
      // 工字钢轨道：上翼缘 + 腹板 + 下翼缘（y=7.0）
      out.push(
        D('box', DENSITY_BASE_COLORS.crane, ws.x, 7.22, z, 32.8, 0.06, 0.34),
        D('box', DENSITY_BASE_COLORS.crane, ws.x, 7.0, z, 32.8, 0.4, 0.12),
        D('box', DENSITY_BASE_COLORS.crane, ws.x, 6.78, z, 32.8, 0.06, 0.34),
      );
    }
    // 天车小车 2 台：骑在轨道上（对角线布置，避免同侧拥挤）
    for (const [sx, sz] of [[-1, -1], [1, 1]] as const) {
      const x = ws.x + sx * 6.5;
      const z = ws.z + sz * 12;
      out.push(
        D('box', DENSITY_BASE_COLORS.crane, x, 7.5, z, 1.6, 0.7, 1.1),
        D('cyl', DENSITY_BASE_COLORS.crane, x, 6.6, z, 0.5, 0.6, 0.5), // 吊钩卷筒
      );
    }
  }
  return out;
}

/** 密度件类别 → 单位几何（envBuilder 聚合 InstancedMesh 用） */
export const DENSITY_UNIT_SHAPE: Record<DensityInstKind, 'box' | 'cyl'> = {
  cabinet: 'box',
  'pallet-stack': 'box',
  'crate-stack': 'box',
  'gas-bottle': 'cyl',
};
