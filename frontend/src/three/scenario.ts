/**
 * 四条产线的演示工况（作者 2026-11-25 追加：产线完整化 + 差异化）。
 *
 * 为什么要这张表：四条线如果共用同一套参数，画面就是复制粘贴；角度一换，观众立刻看出"这是同一个东西摆了四次"。
 * 四种工况在**料密度、物料颜色、带速、停顿、设备状态**五个维度上都不相同，并且每线独立相位。
 *
 * 边界（必须一起引用，不许单摘数字）：
 *  - 这是**展示层**的工况表：只改三维外观、闸门与带速，**不改后端、不改数据库、不改 WS 契约**；
 *  - `stateOverrides` 只作用于三维画面。页面右侧设备列表与 KPI 卡片仍按真实 WS 数据渲染，
 *    两者不一致是**有意为之**（演示需要四种可辨的工况），界面上有「三维演示工况」角标说明；
 *  - 四条线**全部**由工况表着色（含 A1）。原因：真实数据随时可能出现告警，A1 一旦被真实告警闸住，
 *    「满负荷、运动流畅」就不成立、演示时会像卡死（实拍验证过：A1 真的在 CNC-01 前堆了料）。
 *    想看真实状态时看列表与 KPI；三维看的是四工况演示。
 */

import type { EffectiveState } from '../utils/status';

export type LineCondition = 'full' | 'minor-jam' | 'maintenance' | 'changeover';

export interface LineScenario {
  lineId: string;
  condition: LineCondition;
  /** 工况中文名（角标与验收输出用） */
  label: string;
  /** 视觉料距系数：1 = 额定 3.0 m。只影响观感，队列判据仍按额定料距 */
  spacingFactor: number;
  /** 初始在线的物料件数（四线必须不同） */
  itemCount: number;
  /** 物料染色（四线必须不同） */
  itemTint: string;
  /** 带速系数（相对额定 2.4 m/s）：0 = 完全停住 */
  speedFactor: number;
  /** 到位/放行前的停顿秒数（0.2~0.3） */
  dwellSeconds: number;
  /** 起步加速度 m/s² */
  accel: number;
  /** 到位减速度 m/s² */
  decel: number;
  /** 排布偏转上限（度，±2 以内） */
  yawJitterDeg: number;
  /** 横向错位上限（米，≈料距 10%） */
  offsetJitter: number;
  /** 抖动随机种子：每线不同，保证可复现（脚本同一份数据跑两次结果一致） */
  seed: number;
  /** 上料架/托盘堆上的料箱数（0 = 空托盘，换型待料） */
  palletCrates: number;
  /**
   * 可选：初始物料位置（相对色带起点的偏移，米）。
   * 用在"整线冻结"的工况上——带速 0 时物料永远不会自己走到机前，
   * 想让画面出现"料停在设备前"的停线现场，就得把初始位摆在那里（不是伪造数据，是停机快照）。
   */
  initialOffsets?: number[];
  /**
   * 演示工况的设备状态覆盖：只影响三维着色与闸门/滚筒/机械臂，不影响后端与列表。
   * 键是设备 ID，值是覆盖后的视觉状态。
   */
  stateOverrides: Record<string, EffectiveState>;
}

/** 额定带速（m/s），与 motion.ts 的 BELT_SPEED 同源；这里只用来算"相对速度" */
export const RATED_BELT_SPEED = 2.4;

export const LINE_SCENARIOS: LineScenario[] = [
  {
    lineId: 'LINE-A1',
    condition: 'full',
    label: '满负荷',
    spacingFactor: 1.0,
    itemCount: 9,
    itemTint: '#9fb2c4',
    speedFactor: 1.0,
    dwellSeconds: 0.25,
    accel: 1.6,
    decel: 2.4,
    yawJitterDeg: 1.6,
    offsetJitter: 0.28,
    seed: 1101,
    palletCrates: 4,
    // 满负荷：三台全 RUNNING（真实数据里的告警会让 A1 在演示时堵住，见文件头说明）
    stateOverrides: { 'CNC-01': 'RUNNING', 'ROB-01': 'RUNNING', 'CONV-01': 'RUNNING' },
  },
  {
    lineId: 'LINE-A2',
    condition: 'minor-jam',
    label: '轻微堵料',
    spacingFactor: 1.0,
    itemCount: 8,
    itemTint: '#bd8a52',
    speedFactor: 0.75,
    dwellSeconds: 0.3,
    accel: 1.4,
    decel: 2.2,
    yawJitterDeg: 2.0,
    offsetJitter: 0.3,
    seed: 2207,
    palletCrates: 2,
    // ROB-02 呈告警色 → 闸门关闭 → 缓存位天然堆 3~4 件（堵料不是摆出来的，是闸门逻辑跑出来的）。
    // 选 ROB-02 而不是 CNC-02：CNC-02 的闸门在 x=-33.8，紧贴色带起点，队列几乎全落在带外看不见。
    stateOverrides: { 'ROB-02': 'ALARM' },
  },
  {
    lineId: 'LINE-B1',
    condition: 'maintenance',
    label: '检修中',
    spacingFactor: 1.5,
    itemCount: 6,
    itemTint: '#7b838d',
    speedFactor: 0,
    dwellSeconds: 0.3,
    accel: 1.2,
    decel: 2.0,
    yawJitterDeg: 1.2,
    offsetJitter: 0.3,
    seed: 3301,
    palletCrates: 1,
    // 停机快照：料停在 CNC-03 出口、ROB-03 闸门前（12.8）以及产线中后段，带速 0 不会自己走
    initialOffsets: [0.2, 3.0, 6.8, 11.0, 15.0, 19.0],
    // 整线维护：设备停机色 + 停住（带速 0、滚筒停、机械臂冻结、上游物料堆积）
    stateOverrides: { 'CNC-03': 'MAINTENANCE', 'ROB-03': 'MAINTENANCE', 'INSP-01': 'MAINTENANCE' },
  },
  {
    lineId: 'LINE-B2',
    condition: 'changeover',
    label: '换型待料',
    spacingFactor: 1.6,
    itemCount: 5,
    itemTint: '#c6d3e2',
    speedFactor: 0.35,
    dwellSeconds: 0.3,
    accel: 1.0,
    decel: 1.8,
    yawJitterDeg: 2.0,
    offsetJitter: 0.3,
    seed: 4409,
    palletCrates: 0,
    // 半停：设备待机色（黄），料稀疏、走得慢、每段到位都停一下
    stateOverrides: { 'CNC-04': 'IDLE', 'ROB-04': 'IDLE', 'INSP-02': 'IDLE' },
  },
];

export const SCENARIO_BY_LINE: Record<string, LineScenario> = Object.fromEntries(
  LINE_SCENARIOS.map((s) => [s.lineId, s]),
);

/** 设备 ID → 该设备所属线的工况（动力站设备不在任何线上，返回 null） */
export function scenarioOfDevice(deviceId: string): LineScenario | null {
  for (const s of LINE_SCENARIOS) {
    if (Object.prototype.hasOwnProperty.call(s.stateOverrides, deviceId)) return s;
  }
  return null;
}

/** 设备 ID → 视觉状态覆盖（没有覆盖返回 undefined，交给真实 WS 状态） */
export function overriddenState(deviceId: string): EffectiveState | undefined {
  for (const s of LINE_SCENARIOS) {
    const hit = s.stateOverrides[deviceId];
    if (hit) return hit;
  }
  return undefined;
}

/** 角标文案：界面上必须说明「这是三维演示工况」，避免被当成真实状态 */
export function scenarioBadgeText(): string {
  return LINE_SCENARIOS.map((s) => `${s.lineId} ${s.label}`).join(' · ');
}

/** 确定性伪随机（mulberry32）：同一种子每次跑出同一组偏移，脚本可复现 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
