/**
 * G-01 / G-06 唯一数据源：设备坐标、产线色带、厂房尺寸、机身尺寸。
 * 约定：1 单位 = 1 米；Y 向上；X 向东；Z 向南；原点在厂区中心地面；rotationY 一律 0。
 */

export interface DevicePlacement {
  x: number;
  z: number;
  rotationY: number;
}

export interface BoxSize {
  x: number;
  y: number;
  z: number;
}

export const FACTORY = { sizeX: 80, sizeZ: 56, gridDivisions: 40 };

export interface WorkshopSpec {
  id: string;
  name: string;
  x: number;
  z: number;
  sizeX: number;
  sizeZ: number;
  height: number;
}

export const WORKSHOPS: WorkshopSpec[] = [
  { id: 'WS-A', name: '机加工车间', x: -20, z: 0, sizeX: 34, sizeZ: 30, height: 8 },
  { id: 'WS-B', name: '检测与装配车间', x: 20, z: 0, sizeX: 34, sizeZ: 30, height: 8 },
];

export const CORRIDOR = { x: 0, z: 0, sizeX: 6, sizeZ: 30 };

export const POWER_STATION = { x: 0, z: 22, sizeX: 16, sizeZ: 10, height: 5 };

/** 不在坐标表里的设备堆在动力站旁，并且控制台报警 —— 不允许静默跳过（3.3 一致性要求）。 */
export const FALLBACK_PLACEMENT: DevicePlacement = { x: 0, z: 22, rotationY: 0 };

export const DEVICE_LAYOUT: Record<string, DevicePlacement> = {
  // WS-A / LINE-A1（z = -7.5）
  'CNC-01': { x: -31.0, z: -7.5, rotationY: 0 },
  'ROB-01': { x: -25.5, z: -7.5, rotationY: 0 },
  'CONV-01': { x: -16.0, z: -7.5, rotationY: 0 },
  // WS-A / LINE-A2（z = +7.5）
  'CNC-02': { x: -31.0, z: 7.5, rotationY: 0 },
  'ROB-02': { x: -25.5, z: 7.5, rotationY: 0 },
  'CONV-02': { x: -16.0, z: 7.5, rotationY: 0 },
  // WS-B / LINE-B1（z = -7.5）
  'CNC-03': { x: 9.0, z: -7.5, rotationY: 0 },
  'ROB-03': { x: 14.5, z: -7.5, rotationY: 0 },
  'INSP-01': { x: 21.0, z: -7.5, rotationY: 0 },
  // WS-B / LINE-B2（z = +7.5）
  'CNC-04': { x: 9.0, z: 7.5, rotationY: 0 },
  'ROB-04': { x: 14.5, z: 7.5, rotationY: 0 },
  'INSP-02': { x: 21.0, z: 7.5, rotationY: 0 },
  // 动力站（不属任何车间）
  'AIR-01': { x: -4.0, z: 22.0, rotationY: 0 },
  'PUMP-01': { x: 4.0, z: 22.0, rotationY: 0 },
};

export interface LineStripSpec {
  line_id: string;
  workshop_id: string;
  x1: number;
  x2: number;
  z: number;
}

export const LINE_STRIPS: LineStripSpec[] = [
  { line_id: 'LINE-A1', workshop_id: 'WS-A', x1: -34, x2: -6, z: -7.5 },
  { line_id: 'LINE-A2', workshop_id: 'WS-A', x1: -34, x2: -6, z: 7.5 },
  { line_id: 'LINE-B1', workshop_id: 'WS-B', x1: 6, x2: 34, z: -7.5 },
  { line_id: 'LINE-B2', workshop_id: 'WS-B', x1: 6, x2: 34, z: 7.5 },
];

/**
 * 产线 → 设备，**顺序即物料流方向**（与种子数据 seed.sql 的 line_id 一致）。
 * 供产线运行动画使用：设备是这条线上的"闸门"，顺序错了物料会逆流。
 * AIR-01 / PUMP-01 属动力站，不在任何产线上。
 */
export const LINE_DEVICES: Record<string, string[]> = {
  'LINE-A1': ['CNC-01', 'ROB-01', 'CONV-01'],
  'LINE-A2': ['CNC-02', 'ROB-02', 'CONV-02'],
  'LINE-B1': ['CNC-03', 'ROB-03', 'INSP-01'],
  'LINE-B2': ['CNC-04', 'ROB-04', 'INSP-02'],
};

/** 物料流方向：色带 x1 < x2 一律沿 +X 流动（四条产线都是）。 */
export function flowDirection(strip: LineStripSpec): 1 | -1 {
  return strip.x2 >= strip.x1 ? 1 : -1;
}

/** G-06：六类机身外形包络（用于摆位校验与描边盒，不参与建模细节）。 */
export const DEVICE_SIZES: Record<string, BoxSize> = {
  CNC: { x: 4.0, y: 2.6, z: 2.6 },
  ROBOT: { x: 1.8, y: 2.4, z: 1.4 },
  CONVEYOR: { x: 10.0, y: 0.9, z: 1.2 },
  INSPECTION: { x: 3.0, y: 1.8, z: 2.0 },
  AUX_AIR: { x: 2.4, y: 2.0, z: 1.6 },
  AUX_PUMP: { x: 1.6, y: 1.4, z: 1.4 },
};

export function sizeKeyOf(deviceType: string, deviceId: string): keyof typeof DEVICE_SIZES {
  if (deviceType === 'AUX') return deviceId.startsWith('PUMP') ? 'AUX_PUMP' : 'AUX_AIR';
  if (deviceType === 'ROBOT') return 'ROBOT';
  if (deviceType === 'CONVEYOR') return 'CONVEYOR';
  if (deviceType === 'INSPECTION') return 'INSPECTION';
  return 'CNC';
}

/** 由设备 ID 前缀推类型：DEVICE_LAYOUT 只有坐标没有 device_type，调试与验收够用。 */
export function deviceTypeOf(deviceId: string): string {
  if (deviceId.startsWith('ROB')) return 'ROBOT';
  if (deviceId.startsWith('CONV')) return 'CONVEYOR';
  if (deviceId.startsWith('INSP')) return 'INSPECTION';
  if (deviceId.startsWith('AIR') || deviceId.startsWith('PUMP')) return 'AUX';
  return 'CNC';
}

/** 设备包围盒（y 从地面到机身顶）：D3 验收脚本用它断言相机路径不穿设备。 */
export function deviceBox(deviceId: string): { min: [number, number, number]; max: [number, number, number] } | null {
  const p = DEVICE_LAYOUT[deviceId];
  if (!p) return null;
  const s = DEVICE_SIZES[sizeKeyOf(deviceTypeOf(deviceId), deviceId)];
  return {
    min: [p.x - s.x / 2, 0, p.z - s.z / 2],
    max: [p.x + s.x / 2, s.y, p.z + s.z / 2],
  };
}

/** 设备清单与坐标表的一致性检查（启动时打日志，验收脚本据此判断）。 */
export function missingPlacements(deviceIds: string[]): string[] {
  return deviceIds.filter((id) => !DEVICE_LAYOUT[id]);
}
