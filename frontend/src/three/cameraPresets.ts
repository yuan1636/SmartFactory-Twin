/** G-07：相机预设与轨道限制。老师演示时必须能一键回到总览。 */

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
}

/**
 * D3 起 5 个预设，`PRESET_ORDER` 的顺序即键位 1~5 的映射顺序。
 * DEVICE 的静态位姿取 CNC-01 特写（与 `focusPose(CNC-01)` 完全一致）：
 * 运行时 setPreset('DEVICE') 会改看当前选中设备，没有选中时落回这里。
 * LINE-A1：单条产线近景，斜上方看向整条 A1（x -34..-6, z -7.5）。
 */
export const CAMERA_PRESETS = {
  overview: { position: [0, 40, 48], target: [0, 0, 0] },
  'WS-A': { position: [-20, 26, 34], target: [-20, 0, 0] },
  'WS-B': { position: [20, 26, 34], target: [20, 0, 0] },
  'LINE-A1': { position: [-20, 7, 14], target: [-20, 1.2, -7.5] },
  DEVICE: { position: [-25, 5, 0.5], target: [-31, 1.2, -7.5] },
} satisfies Record<string, CameraPose>;

export type PresetKey = keyof typeof CAMERA_PRESETS;

/** 预设固定顺序：键位 1~5 与巡游序列都按它走，不许乱。 */
export const PRESET_ORDER: PresetKey[] = ['overview', 'WS-A', 'WS-B', 'LINE-A1', 'DEVICE'];

/** 单设备聚焦：从东南上方看向设备腰部。 */
export function focusPose(x: number, z: number): CameraPose {
  return {
    position: [x + 6, 5, z + 8],
    target: [x, 1.2, z],
  };
}

/**
 * D3 入场起点：场外西南上方（方位角约 -72°、水平半径 62、高 60）。
 * 两处硬约束别改坏：
 *  - 距原点 86.3 < ORBIT_LIMITS.maxDistance 90，否则第一帧就会被 OrbitControls 夹回 90；
 *  - 高度 60 保住俯角，入场全程不与设备包围盒相交。
 */
export const ENTRANCE_START: CameraPose = {
  position: [-58.9, 60, 19.2],
  target: [0, 0, 0],
};

/** 入场的球面插值参数：方位角 -72°→0°、水平半径 62→48、高度 60→40（终点即 overview）。 */
export const ENTRANCE_PATH = { azimuth0: (-72 * Math.PI) / 180, azimuth1: 0, radius0: 62, radius1: 48, height0: 60, height1: 40 };

export const ORBIT_LIMITS = {
  minDistance: 6,
  maxDistance: 90,
  maxPolarAngle: Math.PI / 2.15, // 再往下就穿到地面以下了
  dampingFactor: 0.08,
};
