/** G-07：相机预设与轨道限制。老师演示时必须能一键回到总览。 */

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
  /**
   * 该预设的垂直 FOV（度）。缺省用 DEFAULT_FOV。
   * R1.5 A 层起支持逐预设 FOV：人视机位（WALK/AISLE）用广角制造"身临其境"，
   * 俯视机位保持中焦避免边缘拉伸。改 FOV 后必须 updateProjectionMatrix。
   */
  fov?: number;
}

/** 全局默认 FOV。R1.5 A 层：45 → 60（作者指定，广角加大纵深感知） */
export const DEFAULT_FOV = 60;

/**
 * R1.5 起 7 个预设，`PRESET_ORDER` 的顺序即键位 1~7 的映射顺序。
 * DEVICE 的静态位姿取 CNC-01 特写（与 `focusPose(CNC-01)` 完全一致）：
 * 运行时 setPreset('DEVICE') 会改看当前选中设备，没有选中时落回这里。
 * LINE-A1：单条产线近景，斜上方看向整条 A1。
 */
export const CAMERA_PRESETS = {
  overview: { position: [0, 36, 46], target: [0, 0, 0] },
  // ---- R1.5 A 层：人视机位（作者指定）----
  // WALK：人眼高度 1.68 m，站在 LINE-A1 起点（线西端 x=-34），视线朝 +x 沿产线纵深。
  // FOV 72：产线纵深方向的透视夸张，站在原地看不完厂区边界才算尺度对了。
  WALK: { position: [-34.5, 1.68, -7.5], target: [-14, 1.2, -7.5], fov: 72 },
  // AISLE：站在中央走廊北端（z=-14），朝 +z 看通道纵深，人眼偏高 1.9 m，FOV 66。
  AISLE: { position: [0, 1.9, -14], target: [0, 1.2, 14], fov: 66 },
  'WS-A': { position: [-20, 26, 34], target: [-20, 0, 0] },
  'WS-B': { position: [20, 26, 34], target: [20, 0, 0] },
  // D 批改成"车间内平视"：站在 A1 与中央通道之间（y=3），沿产线望向西北角。
  // 旧机位 [-20,7,14] 贴在天花灯带高度，画面顶部会露出一大条没有屋面板的白；
  // 现在视线尽头是西墙 + 北墙的夹角（有窗洞、踢脚线），不再是背景虚空。
  'LINE-A1': { position: [-15, 3, -1], target: [-26, 1.5, -7.5] },
  DEVICE: { position: [-25, 5, 0.5], target: [-31, 1.2, -7.5] },
} satisfies Record<string, CameraPose>;

export type PresetKey = keyof typeof CAMERA_PRESETS;

/** 预设固定顺序：键位与巡游序列都按它走，不许乱。WALK/AISLE 排 overview 之后（作者指定）。 */
export const PRESET_ORDER: PresetKey[] = ['overview', 'WALK', 'AISLE', 'WS-A', 'WS-B', 'LINE-A1', 'DEVICE'];

/** 单设备聚焦：从东南上方看向设备腰部。 */
export function focusPose(x: number, z: number): CameraPose {
  return {
    position: [x + 6, 5, z + 8],
    target: [x, 1.2, z],
  };
}

/**
 * D3 入场起点：场外西南上方（方位角 -72°、水平半径 47、高 46）。
 * 两处硬约束别改坏：
 *  - 距原点 65.8 < ORBIT_LIMITS.maxDistance 72，否则第一帧就会被 OrbitControls 夹回 72；
 *    （D 批把 maxDistance 从 90 收到 72，起点也跟着收，否则入场第一帧就被夹、看着像瞬移）
 *  - 高度 46 保住俯角，入场全程不与设备包围盒相交。
 */
export const ENTRANCE_START: CameraPose = {
  position: [-44.7, 46, 14.5],
  target: [0, 0, 0],
};

/**
 * 入场的球面插值参数：方位角 -72°→0°、水平半径 47→46、高度 46→36（终点即 overview）。
 * radius1 / height1 **必须**与 overview 预设一致（`cameraPresets.test.ts` 有断言），
 * 否则入场停在 overview 旁边，验收的"终点位姿 = overview"会失败。
 */
export const ENTRANCE_PATH = { azimuth0: (-72 * Math.PI) / 180, azimuth1: 0, radius0: 47, radius1: 46, height0: 46, height1: 36 };

export const ORBIT_LIMITS = {
  minDistance: 6,
  maxDistance: 72, // D 批：室内有围护后不需要退到 90，收到 72 画面更"进得去"
  maxPolarAngle: Math.PI / 2.15, // 再往下就穿到地面以下了
  dampingFactor: 0.08,
};
