/**
 * 图表容器（G-15）。页面禁止直接 echarts.init：resize、dispose、空态都在这里收口，
 * 否则 7 张图会写 7 遍重复逻辑，且窗口缩放后不重绘。
 */

import { useEffect, useRef, type ReactNode } from 'react';
import type { EChartsCoreOption } from 'echarts/core';
import { initChart } from '../charts/init';
import { EmptyState } from './EmptyState';
import { LoadingBlock } from './LoadingBlock';

interface ChartCardProps {
  title: string;
  option: EChartsCoreOption;
  height?: number;
  loading?: boolean;
  empty?: boolean;
  emptyText?: string;
  footnote?: ReactNode;
  extra?: ReactNode;
}

export function ChartCard({
  title,
  option,
  height = 220,
  loading = false,
  empty = false,
  emptyText = '暂无数据',
  footnote,
  extra,
}: ChartCardProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ReturnType<typeof initChart> | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = initChart(host);
    chartRef.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(host);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || loading || empty) return;
    chart.setOption(option, false);
  }, [option, loading, empty]);

  return (
    <div className="card">
      <div className="card__title-row">
        <h3 className="card__title">{title}</h3>
        {extra ? <div style={{ marginLeft: 'auto' }}>{extra}</div> : null}
      </div>
      <div style={{ position: 'relative', height }}>
        <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
        {loading || empty ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'var(--bg-panel)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {loading ? <LoadingBlock rows={3} /> : <EmptyState title={emptyText} />}
          </div>
        ) : null}
      </div>
      {footnote ? <div className="card__footnote">{footnote}</div> : null}
    </div>
  );
}
