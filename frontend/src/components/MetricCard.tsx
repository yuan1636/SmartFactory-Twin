/** 指标卡：数值 28px tabular-nums，tone 只影响数值颜色。 */

import type { ReactNode } from 'react';

interface MetricCardProps {
  label: string;
  value: ReactNode;
  unit?: string;
  delta?: ReactNode;
  tone?: 'normal' | 'warn' | 'crit';
}

export function MetricCard({ label, value, unit, delta, tone = 'normal' }: MetricCardProps) {
  return (
    <div className="metric-card">
      <div className="metric-card__label">{label}</div>
      <div className={`metric-card__value metric-card__value--${tone}`}>
        {value}
        {unit ? <span className="metric-card__unit">{unit}</span> : null}
      </div>
      {delta ? <div className="metric-card__delta">{delta}</div> : null}
    </div>
  );
}
