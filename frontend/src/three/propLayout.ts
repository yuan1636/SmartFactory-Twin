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

export interface PipeSpec {
  axis: 'x' | 'y' | 'z';
  x: number;
  y: number;
  z: number;
  length: number;
  radius: number;
}

/** 车间内架空管廊：两根沿 X 的主管道，走在两条产线之间（z = ±5） */
export const PIPE_HEIGHT = 6.2;
export const PIPE_RADIUS = 0.3;
/** 主管到车间中心的横向距离：产线在 ±7.5，取 5 让管子正好压在产线与通道之间 */
export const PIPE_OFFSET = 5;

export function buildPipes(): PipeSpec[] {
  const pipes: PipeSpec[] = [];
  for (const ws of WORKSHOPS) {
    for (const sign of [-1, 1]) {
      const z = ws.z + sign * PIPE_OFFSET;
      // 主管：贯穿车间东西
      pipes.push({ axis: 'x', x: ws.x, y: PIPE_HEIGHT, z, length: ws.sizeX - 1.2, radius: PIPE_RADIUS });
      // 两端落地立管，让主管看起来是"接到设备上的"而不是浮在空中
      for (const sx of [-1, 1]) {
        pipes.push({
          axis: 'y',
          x: ws.x + sx * (ws.sizeX / 2 - 1.2),
          y: PIPE_HEIGHT / 2,
          z,
          length: PIPE_HEIGHT,
          radius: PIPE_RADIUS * 0.75,
        });
      }
    }
  }
  return pipes;
}

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
