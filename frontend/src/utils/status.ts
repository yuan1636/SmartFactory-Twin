/** G-03：把设备级 status 与遥测级 running_status 合并成唯一视觉状态。 */

export type EffectiveState = 'ALARM' | 'MAINTENANCE' | 'STOPPED' | 'IDLE' | 'RUNNING';

/** 优先级从高到低，与规格 4.1 一致。 */
export const STATE_PRIORITY: EffectiveState[] = ['ALARM', 'MAINTENANCE', 'STOPPED', 'IDLE', 'RUNNING'];

export interface StateMeta {
  label: string;
  /** 与 tokens.css 的 --st-* 完全同值，三维场景也用这一份，避免两处色值漂移 */
  hex: string;
  color: number;
}

export const STATE_META: Record<EffectiveState, StateMeta> = {
  RUNNING: { label: '运行中', hex: '#22c55e', color: 0x22c55e },
  IDLE: { label: '待机', hex: '#f2b233', color: 0xf2b233 },
  STOPPED: { label: '停机', hex: '#64748b', color: 0x64748b },
  ALARM: { label: '告警', hex: '#ef4444', color: 0xef4444 },
  MAINTENANCE: { label: '维护中', hex: '#3b82f6', color: 0x3b82f6 },
};

/**
 * 合并规则：ALARM / MAINTENANCE 是设备级事实，优先于遥测级；
 * 遥测级里 STOPPED 比 IDLE 更"死"，优先展示。顺序不能随意调换。
 */
export function effectiveState(status: string, runningStatus: string | null | undefined): EffectiveState {
  if (status === 'ALARM') return 'ALARM';
  if (status === 'MAINTENANCE') return 'MAINTENANCE';
  if (runningStatus === 'STOPPED') return 'STOPPED';
  if (runningStatus === 'IDLE') return 'IDLE';
  return 'RUNNING';
}

/** 统计用：状态 → 计数。 */
export function countByState(states: EffectiveState[]): Record<EffectiveState, number> {
  const result: Record<EffectiveState, number> = {
    RUNNING: 0,
    IDLE: 0,
    STOPPED: 0,
    ALARM: 0,
    MAINTENANCE: 0,
  };
  for (const s of states) result[s] += 1;
  return result;
}
