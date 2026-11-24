/** G-07：相机预设与轨道限制。老师演示时必须能一键回到总览。 */

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
}

export const CAMERA_PRESETS: Record<'overview' | 'WS-A' | 'WS-B', CameraPose> = {
  overview: { position: [0, 40, 48], target: [0, 0, 0] },
  'WS-A': { position: [-20, 26, 34], target: [-20, 0, 0] },
  'WS-B': { position: [20, 26, 34], target: [20, 0, 0] },
};

export type PresetKey = keyof typeof CAMERA_PRESETS;

/** 单设备聚焦：从东南上方看向设备腰部。 */
export function focusPose(x: number, z: number): CameraPose {
  return {
    position: [x + 6, 5, z + 8],
    target: [x, 1.2, z],
  };
}

export const ORBIT_LIMITS = {
  minDistance: 6,
  maxDistance: 90,
  maxPolarAngle: Math.PI / 2.15, // 再往下就穿到地面以下了
  dampingFactor: 0.08,
};
