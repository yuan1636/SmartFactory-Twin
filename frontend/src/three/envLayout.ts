/**
 * 环境层与产线补齐道具的摆放表（作者 2026-11-25 追加批次）。纯数据，不依赖 three。
 *
 * 环境层按作者给的优先级落地：柱子/桁架/灯带 → 地坪涂装 → 桥架与线缆 → 远处货架/托盘/玻璃办公室 → 安全件。
 * 产线补齐：四条线上游上料架 + 托盘堆；A 线下游检测工位台 + 下料滑台；B 线下游短传送带 + 下料滑台。
 *
 * 三条硬约束（都有单测守着）：
 *  1. 所有件都在厂区边界内；
 *  2. 产线道具不与任何设备占地（含基座外扩 0.5）相交；
 *  3. 坐标一律由 layout.ts 的常量推导，不另写一套。
 *
 * 为什么全部并进「按材质分组的合并几何」：本批的上限是 draw call ≤100，而现状 77。
 * 一物一 mesh 这条路在 D2 已经走过一遍（7 类道具 = 10 次），这里只允许 matte/metal/paint/emissive/glass/labels 六组。
 */

import { DEVICE_LAYOUT, FACTORY, LINE_STRIPS, POWER_STATION, WORKSHOPS } from './layout';
import { buildInterior } from './envInterior';
import { buildSigns } from './propLayout';
import type { LineScenario } from './scenario';

/**
 * 环境层的五个基础分组 + 围护壳（批 1）。
 *
 * `shell` 是批 1 单独拆出来的：围护墙如果留在 `matte` 里（该组 castShadow=true），
 * 会把所有从上方来的光挡在墙外，室内只剩不投影的补光——结果是**车间里一点影子都没有**，
 * 设备像贴纸贴在地上。拆出来后墙不投影，天窗光就能在室内投下设备影子。
 */
export type EnvGroup = 'matte' | 'shell' | 'metal' | 'paint' | 'emissive' | 'glass';
export type EnvShape = 'box' | 'cyl' | 'cone';

export interface EnvPart {
  group: EnvGroup;
  shape: EnvShape;
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  color: number;
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  /**
   * 剖切组 id（如 `WS-A:south`）：相机在该车间这一侧的室外时，整组退化为不可见。
   * 实现在 envBuilder（把合并索引退化为同一点，不加材质不加 draw call），
   * 触发规则在 envInterior.cutawaySides——这里只是数据标记。
   */
  cut?: string;
}

export interface EnvLabelSpec {
  x: number;
  z: number;
  /** 图集单元名（只允许 ASCII，见 ATLAS_TEXT） */
  cell: string;
  width: number;
  height: number;
  /** 文字朝向：0 = 面向 +Z（相机在南侧看得正） */
  rotY: number;
}

export const ENV_COLORS = {
  column: 0x46515f,
  truss: 0x4b5561,
  purlin: 0x424b56,
  lamp: 0xaac7e4,
  // 通道漆：第一版 0x1b3a2c 在深色地面上一眼像草坪，压暗并去掉绿味
  walkway: 0x5f6a73,
  yellowLine: 0xc9a227,
  zebra: 0xd8dee3,
  steel: 0x8b9299,
  darkSteel: 0x59636d,
  glass: 0x9fc4e0,
  wood: 0x8a6a3f,
  crate: 0x7d8792,
  slide: 0x9aa6b2,
  forklift: 0xd3811f,
  extinguisher: 0xb03a2e,
  bin: 0x2f5d4a,
  cone: 0xd4701f,
  cart: 0x9c3f36,
  office: 0x333d4a,
  desk: 0x6d5333,
};

/** 四条线的识别色：产线道具的色带用它，四条线一眼能分开 */
export const LINE_ACCENT: Record<string, number> = {
  'LINE-A1': 0x2f6fa8,
  'LINE-A2': 0xa8722f,
  'LINE-B1': 0x8a3b3b,
  'LINE-B2': 0x3f8a6a,
};

const box = (
  group: EnvGroup,
  color: number,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  rot?: { x?: number; y?: number; z?: number },
): EnvPart => ({ group, shape: 'box', color, x, y, z, sx, sy, sz, rotX: rot?.x, rotY: rot?.y, rotZ: rot?.z });

const cyl = (group: EnvGroup, color: number, x: number, y: number, z: number, r: number, h: number): EnvPart => ({
  group,
  shape: 'cyl',
  color,
  x,
  y,
  z,
  sx: r, // 半径
  sy: h,
  sz: r,
});

/** 圆锥（警戒锥用）：sx = 底半径，sz = 顶半径 */
const cone = (group: EnvGroup, color: number, x: number, y: number, z: number, rBottom: number, rTop: number, h: number): EnvPart => ({
  group,
  shape: 'cone',
  color,
  x,
  y,
  z,
  sx: rBottom,
  sy: h,
  sz: rTop,
});

// ---------------------------------------------------------------- 4. 地坪涂装

/** 中央通道的绿色人行道 + 两侧黄线 + 车间外侧两道斑马线 */
export function buildFloorPaint(): EnvPart[] {
  const parts: EnvPart[] = [];
  const walkZ = WORKSHOPS[0].sizeZ - 1;

  // 人行道底色（比地面略亮，像是刷过漆的通道）
  parts.push(box('paint', ENV_COLORS.walkway, 0, 0.008, 0, 5.2, 0.004, walkZ));
  // 通道两侧黄线（警示斜纹在 x=±3.2，这条是内侧的实线）
  for (const sx of [-1, 1]) {
    parts.push(box('paint', ENV_COLORS.yellowLine, sx * 2.7, 0.012, 0, 0.12, 0.004, walkZ));
  }
  // 斑马线：车间外侧各一道，横穿通道
  for (const sz of [-1, 1]) {
    const z = sz * (WORKSHOPS[0].sizeZ / 2 + 1.2);
    for (let i = 0; i < 7; i += 1) {
      const x = -2.4 + i * 0.8;
      parts.push(box('paint', ENV_COLORS.zebra, x, 0.012, z, 0.36, 0.004, 3.4));
    }
  }
  return parts;
}

// ---------------------------------------------------------------- 5. 桥架与线缆

/**
 * 天花桥架：作者 2026-11-25 晚要求「天花板的管道都去掉，影响观感」，整组删除。
 *
 * 历史：第一版是每条产线正上方 4 道长桥 + 12 处下引线；作者反馈"管道/线缆太密"
 * 后改成沿墙布置（4 段主桥 + 4 根支线 + 竖杆）。这次进一步要求全部去掉，
 * 所以数据、几何、验收类别一并删除，顶部只留 5 道白色灯带。
 * 反向守卫在 envLayout.test.ts：metal 组不应再有 y ≥ 5 的长条/竖杆。
 */

// ---------------------------------------------------------------- 6. 玻璃隔断办公室

export const OFFICE = { x: -27, z: 22, sizeX: 13, sizeZ: 7.5, height: 3.2 };

/**
 * 玻璃隔断办公室：放在厂区西南外侧（动力站西边），从总览机位看是右下的一个"产品化"体块。
 * 玻璃是单独一组（透明材质），框架与屋面并进 matte/metal，不额外吃 draw call。
 */
export function buildOffice(): EnvPart[] {
  const { x, z, sizeX, sizeZ, height } = OFFICE;
  const parts: EnvPart[] = [];
  const halfX = sizeX / 2;
  const halfZ = sizeZ / 2;

  parts.push(box('matte', 0x2a3340, x, 0.04, z, sizeX, 0.08, sizeZ)); // 地台
  parts.push(box('matte', ENV_COLORS.office, x, height + 0.1, z, sizeX + 0.3, 0.2, sizeZ + 0.3)); // 顶板
  parts.push(box('matte', ENV_COLORS.office, x, height / 2, z + halfZ, sizeX, height, 0.2)); // 后墙
  for (const sx of [-1, 1]) {
    parts.push(box('matte', ENV_COLORS.office, x + sx * halfX, height / 2, z, 0.2, height, sizeZ)); // 侧墙
  }

  // 前脸玻璃：中间留 1.6 m 门洞，两侧各一块
  const glassW = (sizeX - 1.6) / 2;
  for (const sx of [-1, 1]) {
    parts.push(box('glass', ENV_COLORS.glass, x + sx * (0.8 + glassW / 2), height / 2 - 0.2, z - halfZ, glassW, height - 0.9, 0.06));
  }
  // 门框 + 竖梃
  for (const dx of [-0.8, 0.8]) {
    parts.push(box('metal', ENV_COLORS.darkSteel, x + dx, height / 2 - 0.2, z - halfZ, 0.1, height - 0.9, 0.12));
  }
  parts.push(box('metal', ENV_COLORS.darkSteel, x, height - 0.62, z - halfZ, 1.7, 0.1, 0.12));
  // 室内：三张办公桌 + 三把椅子（远看是"里面有工位"，不必精细）
  for (let i = 0; i < 3; i += 1) {
    const dx = -3.6 + i * 3.6;
    parts.push(box('matte', ENV_COLORS.desk, x + dx, 0.72, z + 0.8, 1.6, 0.08, 0.8));
    parts.push(box('matte', 0x3d4753, x + dx, 0.36, z + 0.8, 0.12, 0.72, 0.7));
    parts.push(box('matte', 0x2f3843, x + dx, 0.45, z + 1.7, 0.5, 0.9, 0.5));
  }
  return parts;
}

// ---------------------------------------------------------------- 7. 厂区外侧的纵深道具

/** 托盘堆（远处纵深用）：3 层托盘 + 顶部料箱 */
function palletStack(x: number, z: number, crates: number): EnvPart[] {
  const parts: EnvPart[] = [];
  for (let i = 0; i < 3; i += 1) {
    parts.push(box('matte', ENV_COLORS.wood, x, 0.07 + i * 0.14, z, 1.2, 0.14, 1.0));
  }
  for (let i = 0; i < crates; i += 1) {
    parts.push(box('matte', ENV_COLORS.crate, x, 0.72 + i * 0.58, z, 0.9, 0.56, 0.8));
  }
  return parts;
}

/** 简易货架（远处纵深用）：4 立柱 + 3 层板 */
function outerRack(x: number, z: number): EnvPart[] {
  const parts: EnvPart[] = [];
  const w = 2.4;
  const d = 0.9;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(box('metal', 0x8a5a26, x + (sx * w) / 2, 0.9, z + (sz * d) / 2, 0.08, 1.8, 0.08));
    }
  }
  for (let lv = 1; lv <= 3; lv += 1) {
    parts.push(box('metal', 0x8a5a26, x, (1.8 / 4) * lv, z, w, 0.06, d));
  }
  return parts;
}

/** 叉车：车身 + 门架 + 货叉 + 四个轮（远看轮廓就够） */
function forklift(x: number, z: number, rotY: number): EnvPart[] {
  const parts: EnvPart[] = [];
  parts.push(box('matte', ENV_COLORS.forklift, x, 0.62, z, 1.5, 0.9, 2.2, { y: rotY }));
  parts.push(box('matte', 0x2f3843, x, 1.35, z - 0.2, 1.2, 0.55, 1.0, { y: rotY }));
  parts.push(box('metal', 0x4a5563, x + Math.cos(rotY) * 1.0, 1.2, z - Math.sin(rotY) * 1.0, 0.14, 2.0, 0.14, { y: rotY }));
  for (const dz of [-0.35, 0.35]) {
    parts.push(box('metal', 0x6b7480, x + Math.cos(rotY) * 1.35, 0.12, z - Math.sin(rotY) * 1.35 + dz, 0.12, 0.06, 1.1, { y: rotY }));
  }
  for (const sx of [-0.55, 0.55]) {
    for (const sz of [-0.75, 0.75]) {
      parts.push(box('matte', 0x1b1f24, x + sx, 0.28, z + sz, 0.24, 0.56, 0.56, { y: rotY }));
    }
  }
  return parts;
}

/** 厂区外侧（车间与厂界之间）的纵深道具：托盘堆、远处货架、叉车 */
export function buildOuterProps(): EnvPart[] {
  const parts: EnvPart[] = [];
  const stacks: Array<[number, number, number]> = [
    [-16, 24, 3],
    [-12, 24, 2],
    [12, 24, 3],
    [16, 24, 2],
    [-2, 18.5, 1],
    [22, 19, 2],
  ];
  for (const [x, z, crates] of stacks) parts.push(...palletStack(x, z, crates));

  parts.push(...outerRack(10, 26.2));
  parts.push(...outerRack(13.2, 26.2));
  parts.push(...forklift(6.4, 24.6, 0.35));
  return parts;
}

// ---------------------------------------------------------------- 7.5 标识立牌立柱

/**
 * 围墙移走后（作者要求），原本挂在墙面的标识会悬空。
 * 这里给每块标识配两根立柱伸到标识底边，变成落地立牌——位置、朝向与标识完全一致。
 */
export function buildSignPosts(): EnvPart[] {
  const parts: EnvPart[] = [];
  for (const s of buildSigns()) {
    const postH = Math.max(0.6, s.y - s.height / 2);
    for (const sx of [-0.45, 0.45]) {
      parts.push(box('metal', ENV_COLORS.darkSteel, s.x + sx, postH / 2, s.z, 0.07, postH, 0.07));
    }
    parts.push(box('metal', ENV_COLORS.darkSteel, s.x, 0.05, s.z, 1.1, 0.1, 0.4));
  }
  return parts;
}

// ---------------------------------------------------------------- 8. 安全件

/** 灭火器（墙边 6 具）、废料箱（4 只）、安全出口牌由既有 props 的 sign 组负责 */
export function buildSafetyItems(): EnvPart[] {
  const parts: EnvPart[] = [];
  const walls: Array<[number, number]> = [
    [-32, -14.2],
    [-8, 14.2],
    [8, -14.2],
    [32, 14.2],
    [POWER_STATION.x - POWER_STATION.sizeX / 2 - 0.6, POWER_STATION.z],
    [POWER_STATION.x + POWER_STATION.sizeX / 2 + 0.6, POWER_STATION.z],
  ];
  for (const [x, z] of walls) {
    parts.push(cyl('matte', ENV_COLORS.extinguisher, x, 0.28, z, 0.13, 0.56));
    parts.push(box('metal', 0x4a5563, x, 0.56, z, 0.06, 0.1, 0.06));
  }
  const bins: Array<[number, number]> = [
    [-2.4, 16.6],
    [2.4, 16.6],
    [-2.4, -16.6],
    [2.4, -16.6],
  ];
  for (const [x, z] of bins) {
    parts.push(box('matte', ENV_COLORS.bin, x, 0.45, z, 0.6, 0.9, 0.6));
    parts.push(box('metal', 0x3f4a56, x, 0.92, z, 0.64, 0.06, 0.64));
  }
  return parts;
}

// ---------------------------------------------------------------- 9. 工位编号与产线名（地面贴字）

/** 图集里要画的文字（只允许 ASCII：canvas 画中文依赖系统字体，跨机器会糊） */
export const ATLAS_TEXT: string[] = [
  'A1-01', 'A1-02', 'A1-03',
  'A2-01', 'A2-02', 'A2-03',
  'B1-01', 'B1-02', 'B1-03',
  'B2-01', 'B2-02', 'B2-03',
  'PWR-01', 'PWR-02',
  'LINE-A1', 'LINE-A2', 'LINE-B1', 'LINE-B2',
];

/** 工位编号：色带起点侧（z 更靠北的那一侧），避开护栏与警示带 */
export function buildStationLabels(): EnvLabelSpec[] {
  const labels: EnvLabelSpec[] = [];
  const cellOfDevice: Record<string, string> = {
    'CNC-01': 'A1-01', 'ROB-01': 'A1-02', 'CONV-01': 'A1-03',
    'CNC-02': 'A2-01', 'ROB-02': 'A2-02', 'CONV-02': 'A2-03',
    'CNC-03': 'B1-01', 'ROB-03': 'B1-02', 'INSP-01': 'B1-03',
    'CNC-04': 'B2-01', 'ROB-04': 'B2-02', 'INSP-02': 'B2-03',
    'AIR-01': 'PWR-01', 'PUMP-01': 'PWR-02',
  };
  for (const [deviceId, placement] of Object.entries(DEVICE_LAYOUT)) {
    const cell = cellOfDevice[deviceId];
    if (!cell) continue;
    const isPower = cell.startsWith('PWR');
    labels.push({
      x: placement.x,
      z: isPower ? placement.z + 2.4 : placement.z - 3.4,
      cell,
      // 与图集单元同比例（256:80 = 3.2:1），否则文字会被横向拉宽
      width: 1.6,
      height: 0.5,
      rotY: 0,
    });
  }
  for (const strip of LINE_STRIPS) {
    labels.push({
      x: strip.x1 + 3.2,
      z: strip.z - 4.4,
      cell: strip.line_id,
      width: 2.56,
      height: 0.8,
      rotY: 0,
    });
  }
  return labels;
}

// ---------------------------------------------------------------- 10. 产线补齐道具

export interface LinePropResult {
  parts: EnvPart[];
  kinds: string[];
  /** B1 检修工况的「维修中」标识（HTML 标签，不用贴图：中文跨机器渲染更稳） */
  maintenanceLabels: Array<{ x: number; y: number; z: number; text: string }>;
}

/**
 * 每条线的上下游补齐件。为什么这么摆：
 *  - 上料架 + 托盘堆在色带起点外侧（车间内墙一侧），把"料从哪来"接上；
 *  - A 线下游是检测工位台 + 下料滑台（A 线末端是 CONV，物料下线后要检验);
 *  - B 线下游是短传送带段 + 侧向下料滑台（B 线末端是 INSP，检测完要送出工位）；
 *  - 3.0 m 是上限：B 线色带终点 x=34，车间内墙 37，扣除墙厚只放得下 3 m（规格写的 3~4 m，取 3）。
 */
export function buildLineProps(scenarios: LineScenario[]): LinePropResult {
  const parts: EnvPart[] = [];
  const kinds: string[] = [];
  const maintenanceLabels: LinePropResult['maintenanceLabels'] = [];

  for (const strip of LINE_STRIPS) {
    const sc = scenarios.find((s) => s.lineId === strip.line_id);
    const accent = LINE_ACCENT[strip.line_id] ?? ENV_COLORS.steel;
    const z = strip.z;

    // ---- 上游：上料架（3 层，带线色标）----
    const rx = strip.x1 - 2.0;
    for (const sx of [-0.55, 0.55]) {
      for (const sz of [-1.05, 1.05]) {
        parts.push(box('metal', ENV_COLORS.steel, rx + sx, 1.0, z + sz, 0.09, 2.0, 0.09));
      }
    }
    for (const y of [0.5, 1.1, 1.7]) {
      parts.push(box('metal', ENV_COLORS.steel, rx, y, z, 1.16, 0.06, 2.16));
    }
    // 线色识别：贴在货架朝产线那一面（+X）的窄色带
    parts.push(box('paint', accent, rx + 0.6, 1.86, z, 0.05, 0.16, 0.9));
    const rackCrates = Math.min(4, sc?.palletCrates ?? 0);
    for (let i = 0; i < rackCrates; i += 1) {
      const shelf = i < 2 ? 0.5 : 1.1;
      const dz = i % 2 === 0 ? -0.55 : 0.55;
      parts.push(box('matte', ENV_COLORS.crate, rx, shelf + 0.3, z + dz, 0.8, 0.55, 0.85));
    }

    // ---- 上游：托盘堆（空托盘也画，换型待料时正是"托盘在场、料没上"）----
    const px = strip.x1 - 0.9;
    const pz = z + 2.85;
    for (let i = 0; i < 3; i += 1) {
      parts.push(box('matte', ENV_COLORS.wood, px, 0.07 + i * 0.14, pz, 1.2, 0.14, 1.0));
    }
    const stackCrates = Math.max(0, (sc?.palletCrates ?? 0) - 2);
    for (let i = 0; i < stackCrates; i += 1) {
      parts.push(box('matte', ENV_COLORS.crate, px, 0.72 + i * 0.58, pz, 0.9, 0.56, 0.8));
    }

    // ---- 下游 ----
    if (strip.line_id.startsWith('LINE-A')) {
      // 检测工位台
      const tx = strip.x2 + 2.0;
      parts.push(box('metal', ENV_COLORS.steel, tx, 0.86, z, 1.9, 0.08, 1.0));
      for (const sx of [-0.85, 0.85]) {
        for (const sz of [-0.42, 0.42]) {
          parts.push(box('metal', ENV_COLORS.steel, tx + sx, 0.43, z + sz, 0.07, 0.86, 0.07));
        }
      }
      parts.push(box('matte', 0x2f3843, tx + 0.5, 1.08, z, 0.42, 0.32, 0.08)); // 检测屏幕
      parts.push(box('paint', accent, tx - 0.2, 0.91, z - 0.48, 1.9, 0.02, 0.06)); // 台沿线色带
      // 下料滑台：从带面斜到地面
      parts.push(box('metal', ENV_COLORS.slide, strip.x2 + 1.0, 0.72, z, 1.5, 0.08, 0.95, { z: -0.22 }));
      kinds.push('inspection-table', 'unload-slide');
    } else {
      // 短传送带段（3.0 m）：机体 + 带面 + 4 腿 + 两侧挡边
      // 中心取 x2+1.3：色带终点 34，车间内墙 37，机体 3.0 m 正好落在 33.8~36.8（不穿墙）
      const cx = strip.x2 + 1.3;
      parts.push(box('metal', ENV_COLORS.darkSteel, cx, 0.72, z, 3.0, 0.16, 1.0));
      parts.push(box('paint', 0x22303d, cx, 0.81, z, 2.9, 0.03, 0.86));
      for (const sx of [-1.25, 1.25]) {
        for (const sz of [-0.4, 0.4]) {
          parts.push(box('metal', ENV_COLORS.steel, cx + sx, 0.36, z + sz, 0.07, 0.72, 0.07));
        }
      }
      for (const sz of [-0.52, 0.52]) {
        parts.push(box('metal', accent, cx, 0.9, z + sz, 3.0, 0.09, 0.05));
      }
      // 侧向下料滑台（朝 +Z 出料，避开 37 m 处的车间内墙）
      parts.push(box('metal', ENV_COLORS.slide, strip.x2 + 2.45, 0.58, z + 1.15, 0.95, 0.08, 1.5, { x: 0.2 }));
      kinds.push('short-conveyor', 'unload-slide');
    }

    // ---- B1 检修：警戒锥 + 工具车 + 维修中标识 ----
    if (sc?.condition === 'maintenance') {
      for (let i = 0; i < 6; i += 1) {
        const cx = strip.x1 + 3 + i * 4.2;
        parts.push(cone('matte', ENV_COLORS.cone, cx, 0.26, z + 3.0, 0.16, 0.03, 0.52));
        parts.push(box('matte', 0x2d3540, cx, 0.02, z + 3.0, 0.36, 0.04, 0.36));
      }
      const cartX = strip.x1 + 8.5;
      parts.push(box('matte', ENV_COLORS.cart, cartX, 0.5, z + 3.1, 1.1, 0.7, 0.62));
      parts.push(box('metal', ENV_COLORS.steel, cartX, 0.95, z + 3.35, 1.1, 0.06, 0.06));
      for (const sx of [-0.4, 0.4]) {
        parts.push(box('matte', 0x1b1f24, cartX + sx, 0.09, z + 3.1, 0.2, 0.18, 0.5));
      }
      parts.push(box('metal', ENV_COLORS.steel, cartX - 0.52, 1.15, z + 3.1, 0.05, 0.4, 0.05));
      maintenanceLabels.push({ x: cartX, y: 2.5, z: z + 3.1, text: '维修中 · LINE-B1' });
      kinds.push('maintenance-kit');
    }
  }

  // 去重：两个分支都会 push unload-slide
  kinds.push('feeder-rack', 'pallet-stack');
  return { parts, kinds: [...new Set(kinds)], maintenanceLabels };
}

// ---------------------------------------------------------------- 汇总

export interface EnvironmentResult {
  parts: EnvPart[];
  labels: EnvLabelSpec[];
  kinds: string[];
}

/** 环境层三件套（不含产线道具）：给单测与验收断言"类别齐不齐"用 */
export function buildEnvironment(): EnvironmentResult {
  const interior = buildInterior();
  const parts: EnvPart[] = [
    ...interior.parts,
    ...buildFloorPaint(),
    ...buildOffice(),
    ...buildOuterProps(),
    ...buildSignPosts(),
    ...buildSafetyItems(),
  ];
  return {
    parts,
    labels: buildStationLabels(),
    kinds: [
      ...interior.kinds,
      'floor-paint',
      'office',
      'outer-racks',
      'sign-posts',
      'safety',
    ],
  };
}

/** 厂区边界（与 propLayout 的 FACTORY_BOUNDS 同值，这里独立导出避免循环依赖） */
export const ENV_BOUNDS = {
  x1: -FACTORY.sizeX / 2,
  x2: FACTORY.sizeX / 2,
  z1: -FACTORY.sizeZ / 2,
  z2: FACTORY.sizeZ / 2,
};
