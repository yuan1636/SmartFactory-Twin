/**
 * 设备建模 v2（第 4 阶段 D 批 R2 / R3，规格见 docs/spec_phase4.md §10）。
 *
 * 旧版每台设备是 2~5 个 Box/Cylinder 堆叠，人眼高度机位下认不出是什么机器。
 * 本文件把「可辨识部件」做成一张纯数据表，再生成几何。两条硬约束：
 *
 *  1. **一台设备一个 mesh**：所有部件按顶点色 merge 成一份 BufferGeometry。
 *     部件数量因此可以随便加，draw call 不跟着涨（性能优先）。
 *  2. **不越 DEVICE_SIZES 包围盒**：描边盒与 D3 的相机避障都用它，越界会让镜头穿模判定失准。
 *
 * 状态表现不在这里：状态灯 / 光环仍是合并的 InstancedMesh，机身不随状态染色
 * （`applyDeviceState` 只改灯环与标签），所以合并材质不会破坏工况表达。
 */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type DevicePartKey = 'CNC' | 'ROBOT' | 'CONVEYOR' | 'INSPECTION' | 'AIR' | 'PUMP';

export type PartShape = 'box' | 'round' | 'cyl' | 'plane' | 'shadow';

export interface DevicePart {
  /** 部件类别。验收数的是去重后的类别数，不是几何个数（4 个地脚算 1 类） */
  kind: string;
  shape: PartShape;
  color: number;
  /** 部件中心（设备局部坐标，原点在设备地面中心） */
  x: number;
  y: number;
  z: number;
  /** box/round: 宽高深；cyl: sx=直径、sy=高；plane/shadow: sx=宽、sz=深 */
  sx: number;
  sy: number;
  sz: number;
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  /** round 的圆角半径，cyl 的分段数 */
  radius?: number;
  segments?: number;
  /** 属于机械臂枢轴组（随 motion.ts 摆动），不并进静态几何 */
  arm?: boolean;
}

/** 工业配色：沿用 materials.ts 的机身基色，其余为结构件本色 */
export const DETAIL_COLORS = {
  shell: 0x5a6673,
  shellDark: 0x3c4855,
  frame: 0x27313e,
  metal: 0x8b96a3,
  metalDark: 0x4a5563,
  glass: 0x14283c,
  screen: 0x2f6f9e,
  red: 0xc0392b,
  amber: 0xd8a72a,
  plate: 0xb8c2cc,
  shadowCenter: 0x121a24,
  shadowEdge: 0x1b2634,
  conveyor: 0x3f4a57,
  robot: 0x8a7a6a,
  inspection: 0x4e6b7a,
  aux: 0x59636e,
} as const;

/** 规格 §10.4：可辨识部件数下限、每台 mesh 上限、单台三角上限 */
export const DETAIL_LIMITS = {
  minParts: { CNC: 12, ROBOT: 8, CONVEYOR: 8, INSPECTION: 8, AIR: 8, PUMP: 8 } as Record<DevicePartKey, number>,
  maxMeshesPerDevice: 3,
  maxTrianglesPerDevice: 8000,
} as const;

/** 小工具：批量生成同类重复件（地脚 / 格栅条 / 按键） */
function repeat<T>(n: number, fn: (i: number) => T): T[] {
  return Array.from({ length: n }, (_, i) => fn(i));
}

function part(p: DevicePart): DevicePart {
  return p;
}

/**
 * CNC 加工中心：床身 + 双扇滑门 + 观察窗 + 倾斜操作面板 + 顶部油雾收集器。
 * 包围盒 4.0 × 2.6 × 2.6，所有部件 y ≤ 2.6、|x| ≤ 2.0、|z| ≤ 1.3。
 */
const CNC_PARTS: DevicePart[] = [
  // 1 假接触阴影：只比机身宽一圈，收在机身底下，避免地面上出现一块孤立的黑色矩形
  part({ kind: 'contactShadow', shape: 'shadow', color: DETAIL_COLORS.shadowCenter, x: 0, y: 0.012, z: 0, sx: 4.2, sy: 0, sz: 2.75 }),
  // 2 底座与四个调平地脚
  part({ kind: 'plinth', shape: 'round', color: DETAIL_COLORS.frame, x: 0, y: 0.17, z: 0, sx: 3.9, sy: 0.34, sz: 2.5, radius: 0.05 }),
  ...repeat(4, (i) => part({
    kind: 'levelingFoot', shape: 'cyl', color: DETAIL_COLORS.metalDark,
    x: i < 2 ? -1.6 : 1.6, y: 0.055, z: i % 2 ? -1.0 : 1.0, sx: 0.22, sy: 0.11, sz: 0.22, segments: 10,
  })),
  // 3 主箱体（圆角，取代原来的纯方块）
  part({ kind: 'mainBody', shape: 'round', color: DETAIL_COLORS.shell, x: 0, y: 1.28, z: -0.05, sx: 3.86, sy: 1.88, sz: 2.42, radius: 0.09 }),
  // 4 顶部台阶与油雾收集器
  part({ kind: 'topHousing', shape: 'round', color: DETAIL_COLORS.shellDark, x: -0.2, y: 2.3, z: -0.05, sx: 2.5, sy: 0.28, sz: 2.0, radius: 0.05 }),
  part({ kind: 'mistCollector', shape: 'round', color: DETAIL_COLORS.metalDark, x: 0.85, y: 2.42, z: -0.05, sx: 0.9, sy: 0.3, sz: 0.9, radius: 0.06 }),
  ...repeat(4, (i) => part({
    kind: 'collectorVent', shape: 'box', color: DETAIL_COLORS.frame,
    x: 0.55 + i * 0.2, y: 2.58, z: -0.05, sx: 0.06, sy: 0.02, sz: 0.7,
  })),
  // 5 前滑门：两扇 + 分缝 + 门框
  part({ kind: 'doorFrame', shape: 'box', color: DETAIL_COLORS.frame, x: -0.58, y: 1.35, z: 1.20, sx: 2.5, sy: 1.62, sz: 0.06 }),
  part({ kind: 'slidingDoor', shape: 'round', color: DETAIL_COLORS.shellDark, x: -1.15, y: 1.35, z: 1.25, sx: 1.16, sy: 1.5, sz: 0.05, radius: 0.03 }),
  part({ kind: 'slidingDoor', shape: 'round', color: DETAIL_COLORS.shellDark, x: 0.02, y: 1.35, z: 1.25, sx: 1.16, sy: 1.5, sz: 0.05, radius: 0.03 }),
  // 6 观察窗：深色玻璃 + 窗框（贴在左扇门上）
  part({ kind: 'windowFrame', shape: 'box', color: DETAIL_COLORS.metalDark, x: -1.15, y: 1.55, z: 1.29, sx: 0.92, sy: 0.72, sz: 0.03 }),
  part({ kind: 'windowGlass', shape: 'box', color: DETAIL_COLORS.glass, x: -1.15, y: 1.55, z: 1.31, sx: 0.82, sy: 0.62, sz: 0.02 }),
  part({ kind: 'doorHandle', shape: 'cyl', color: DETAIL_COLORS.metal, x: 0.48, y: 1.3, z: 1.32, sx: 0.07, sy: 0.62, sz: 0.07, segments: 10 }),
  // 7 右侧倾斜操作面板 + 屏幕 + 按键阵列 + 急停
  part({ kind: 'controlPanel', shape: 'round', color: DETAIL_COLORS.frame, x: 1.36, y: 1.52, z: 1.28, sx: 0.86, sy: 0.72, sz: 0.16, radius: 0.04, rotX: -0.22 }),
  part({ kind: 'panelScreen', shape: 'box', color: DETAIL_COLORS.screen, x: 1.36, y: 1.64, z: 1.38, sx: 0.62, sy: 0.32, sz: 0.02 }),
  ...repeat(6, (i) => part({
    kind: 'panelKey', shape: 'box', color: DETAIL_COLORS.metal,
    x: 1.12 + (i % 3) * 0.22, y: 1.39 - Math.floor(i / 3) * 0.11, z: 1.37, sx: 0.1, sy: 0.06, sz: 0.02,
  })),
  part({ kind: 'emergencyStop', shape: 'cyl', color: DETAIL_COLORS.red, x: 1.68, y: 1.28, z: 1.34, sx: 0.16, sy: 0.1, sz: 0.16, segments: 12, rotZ: Math.PI / 2 }),
  // 8 侧面散热格栅（6 条）与线缆拖链
  ...repeat(6, (i) => part({
    kind: 'sideVent', shape: 'box', color: DETAIL_COLORS.frame,
    x: -1.94, y: 0.82 + i * 0.16, z: -0.3, sx: 0.03, sy: 0.08, sz: 1.1,
  })),
  part({ kind: 'cableCarrier', shape: 'box', color: DETAIL_COLORS.metalDark, x: -0.4, y: 2.28, z: -1.0, sx: 1.6, sy: 0.12, sz: 0.16 }),
  // 9 环绕可见的结构：人眼机位（WALK / AISLE）看的是侧面与背面，只有正面有细节就会露出光板
  part({ kind: 'serviceDoor', shape: 'round', color: DETAIL_COLORS.shellDark, x: -1.95, y: 1.3, z: -0.25, sx: 0.05, sy: 1.5, sz: 1.35, radius: 0.02 }),
  part({ kind: 'serviceLatch', shape: 'box', color: DETAIL_COLORS.metal, x: -1.99, y: 1.3, z: 0.35, sx: 0.04, sy: 0.22, sz: 0.06 }),
  ...repeat(2, (i) => part({
    kind: 'hinge', shape: 'cyl', color: DETAIL_COLORS.metalDark,
    x: -1.99, y: 0.75 + i * 1.1, z: -0.85, sx: 0.08, sy: 0.14, sz: 0.08, segments: 8,
  })),
  part({ kind: 'electricCabinet', shape: 'round', color: DETAIL_COLORS.shellDark, x: 1.96, y: 1.45, z: -0.5, sx: 0.22, sy: 0.9, sz: 0.8, radius: 0.03 }),
  ...repeat(4, (i) => part({
    kind: 'cabinetVent', shape: 'box', color: DETAIL_COLORS.frame,
    x: 2.08, y: 1.2 + i * 0.16, z: -0.5, sx: 0.02, sy: 0.06, sz: 0.5,
  })),
  part({ kind: 'rearVent', shape: 'box', color: DETAIL_COLORS.frame, x: -0.3, y: 1.6, z: -1.28, sx: 1.1, sy: 0.7, sz: 0.04 }),
  part({ kind: 'cablePort', shape: 'cyl', color: DETAIL_COLORS.metalDark, x: 1.2, y: 0.7, z: -1.3, sx: 0.24, sy: 0.1, sz: 0.24, segments: 10, rotX: Math.PI / 2 }),
  ...repeat(4, (i) => part({
    kind: 'liftingEye', shape: 'cyl', color: DETAIL_COLORS.metal,
    x: i < 2 ? -1.6 : 1.6, y: 2.5, z: i % 2 ? -0.9 : 0.9, sx: 0.14, sy: 0.09, sz: 0.14, segments: 8,
  })),
  // 10 铭牌与前沿黄黑警示条
  part({ kind: 'namePlate', shape: 'box', color: DETAIL_COLORS.plate, x: -0.6, y: 0.46, z: 1.28, sx: 0.62, sy: 0.16, sz: 0.02 }),
  part({ kind: 'warningStripe', shape: 'box', color: DETAIL_COLORS.amber, x: 0, y: 0.36, z: 1.28, sx: 3.6, sy: 0.07, sz: 0.03 }),
];

/** 当前已启用的部件表。R2 只放 CNC，R3 再补齐其余五类。 */
export const DEVICE_PARTS: Partial<Record<DevicePartKey, DevicePart[]>> = {
  CNC: CNC_PARTS,
};

/** 由设备 ID 取部件表键；未启用的类型返回 null，调用方回退旧几何 */
export function partKeyOf(deviceId: string): DevicePartKey | null {
  let key: DevicePartKey;
  if (deviceId.startsWith('CNC')) key = 'CNC';
  else if (deviceId.startsWith('ROB')) key = 'ROBOT';
  else if (deviceId.startsWith('CONV')) key = 'CONVEYOR';
  else if (deviceId.startsWith('INSP')) key = 'INSPECTION';
  else if (deviceId.startsWith('PUMP')) key = 'PUMP';
  else key = 'AIR';
  return DEVICE_PARTS[key] ? key : null;
}

/** 去重后的可辨识部件类别：验收脚本数的是这个，不是几何个数 */
export function partKindsOf(key: DevicePartKey): string[] {
  const list = DEVICE_PARTS[key] ?? [];
  return [...new Set(list.map((p) => p.kind))];
}

function paint(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** 假接触阴影：6×6 网格的矩形面，按到中心距离把顶点色从暗心渐变到地面色 */
function shadowGeometry(p: DevicePart): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(p.sx, p.sz, 6, 6);
  geo.rotateX(-Math.PI / 2);
  const center = new THREE.Color(DETAIL_COLORS.shadowCenter);
  const edge = new THREE.Color(DETAIL_COLORS.shadowEdge);
  const pos = geo.attributes.position;
  const arr = new Float32Array(pos.count * 3);
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i += 1) {
    const d = Math.min(1, Math.hypot(pos.getX(i) / (p.sx / 2), pos.getZ(i) / (p.sz / 2)));
    tmp.copy(center).lerp(edge, d * d);
    arr[i * 3] = tmp.r;
    arr[i * 3 + 1] = tmp.g;
    arr[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function toGeometry(p: DevicePart): THREE.BufferGeometry {
  if (p.shape === 'shadow') {
    const g = shadowGeometry(p);
    g.translate(p.x, p.y, p.z);
    const flat = g.index ? g.toNonIndexed() : g;
    if (flat !== g) g.dispose();
    return flat;
  }
  let geo: THREE.BufferGeometry;
  switch (p.shape) {
    case 'round': {
      const maxR = Math.min(p.sx, p.sy, p.sz) / 2 - 0.001;
      // RoundedBoxGeometry 内部把 segments 翻成 2*segments+1 段：1 → 108 三角，2 → 300 三角。
      // 圆角只要有就行，2 段在这个尺寸下看不出差别，但三角数会翻近三倍（性能优先）。
      geo = new RoundedBoxGeometry(p.sx, p.sy, p.sz, 1, Math.min(p.radius ?? 0.04, maxR));
      break;
    }
    case 'cyl':
      geo = new THREE.CylinderGeometry(p.sx / 2, p.sx / 2, p.sy, p.segments ?? 12);
      break;
    case 'plane':
      geo = new THREE.PlaneGeometry(p.sx, p.sz);
      geo.rotateX(-Math.PI / 2);
      break;
    default:
      geo = new THREE.BoxGeometry(p.sx, p.sy, p.sz);
  }
  if (p.rotX) geo.rotateX(p.rotX);
  if (p.rotY) geo.rotateY(p.rotY);
  if (p.rotZ) geo.rotateZ(p.rotZ);
  geo.translate(p.x, p.y, p.z);
  const painted = paint(geo, p.color);
  // RoundedBoxGeometry 是非索引的，Box/Cylinder/Plane 是索引的；mergeGeometries 要求全体一致。
  // 统一转非索引（顶点数略增，但省掉给圆角箱补索引的复杂度），三角数一律按 position.count/3 算。
  if (!painted.index) return painted;
  const flat = painted.toNonIndexed();
  painted.dispose();
  return flat;
}

export interface DeviceDetailBuild {
  /** 静态部件合并后的一份几何 → 1 个 mesh */
  staticGeometry: THREE.BufferGeometry;
  /** 机械臂部件（挂在枢轴组里随动画摆动）；非 ROBOT 为 null */
  armGeometry: THREE.BufferGeometry | null;
  partKinds: string[];
  triangleCount: number;
  /** 实际生成的 mesh 数（不含轮廓线与 CSS2D 标签） */
  meshCount: number;
}

/**
 * 生成一台设备的细节几何。所有部件共享一份顶点色材质，合并成尽量少的 mesh。
 * 调用方负责 dispose 返回的几何。
 */
export function buildDeviceDetail(key: DevicePartKey): DeviceDetailBuild {
  const list = DEVICE_PARTS[key];
  if (!list) throw new Error(`设备部件表未启用：${key}`);

  const build = (parts: DevicePart[]): THREE.BufferGeometry | null => {
    if (!parts.length) return null;
    const geos = parts.map(toGeometry);
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) throw new Error(`设备几何合并失败：${key}（子几何属性不一致）`);
    return merged;
  };

  const staticGeo = build(list.filter((p) => !p.arm));
  const armGeo = build(list.filter((p) => p.arm));
  if (!staticGeo) throw new Error(`设备静态几何为空：${key}`);

  // 全部子几何已统一为非索引，三角数按顶点数算；用 index.count 会漏掉圆角箱。
  const triangles =
    (staticGeo.attributes.position.count + (armGeo?.attributes.position.count ?? 0)) / 3;
  return {
    staticGeometry: staticGeo,
    armGeometry: armGeo,
    partKinds: partKindsOf(key),
    triangleCount: triangles,
    meshCount: armGeo ? 2 : 1,
  };
}
