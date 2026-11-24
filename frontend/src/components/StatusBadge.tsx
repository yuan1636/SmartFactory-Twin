/** 状态徽章（G-03 的显示出口）：圆点 + 中文名，颜色取 tokens 里的 --st-*。 */

import { STATE_META, type EffectiveState } from '../utils/status';

interface StatusBadgeProps {
  state: EffectiveState;
  size?: 'sm' | 'md';
  /** 未知状态（WS 未连接、REST 兜底拿不到 running_status）时只显示占位 */
  unknown?: boolean;
}

export function StatusBadge({ state, size = 'md', unknown = false }: StatusBadgeProps) {
  if (unknown) {
    return (
      <span className={`status-badge${size === 'sm' ? ' status-badge--sm' : ''}`}>
        <span className="status-dot" style={{ background: 'var(--st-stopped)' }} />
        未知
      </span>
    );
  }
  const meta = STATE_META[state];
  return (
    <span className={`status-badge${size === 'sm' ? ' status-badge--sm' : ''}`}>
      <span className="status-dot" style={{ background: meta.hex }} />
      {meta.label}
    </span>
  );
}
