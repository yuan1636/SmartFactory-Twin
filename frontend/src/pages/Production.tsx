/** 页面三：生产数据分析（规格 5.4）。 */

import { useMemo, useState } from 'react';
import { groupedBarOption, orderRateOption } from '../charts/options';
import { ChartCard } from '../components/ChartCard';
import { DataTable, type Column } from '../components/DataTable';
import { ErrorState } from '../components/ErrorState';
import { MetricCard } from '../components/MetricCard';
import { RangePicker } from '../components/RangePicker';
import { usePolling } from '../hooks/usePolling';
import { apiGet, isoWindow } from '../services/api';
import { formatNumber, formatPercent, formatTime } from '../services/format';
import type { OrderItem, Page, ProductionStats } from '../services/types';
import { CHART_COLORS } from '../styles/chartColors';

/** 四条产线（种子数据固定）。名称用短号，柱状图 x 轴放得下。 */
const LINES: Array<{ id: string; label: string }> = [
  { id: 'LINE-A1', label: 'A1' },
  { id: 'LINE-A2', label: 'A2' },
  { id: 'LINE-B1', label: 'B1' },
  { id: 'LINE-B2', label: 'B2' },
];

const HOURS: Record<'1h' | '24h', number> = { '1h': 1, '24h': 24 };

const ORDER_STATUS: Record<string, string> = {
  COMPLETED: '已完成',
  IN_PROGRESS: '进行中',
  PLANNED: '计划中',
};

export default function Production() {
  const [range, setRange] = useState<'1h' | '24h'>('24h');
  const hours = HOURS[range];

  // 必须显式传窗口：不传时后端默认最近 1 小时，而模拟器按 30 件/小时推进，
  // 该窗口实测返回全 0（orders_completed=0、qualified_rate=0），页面会变成四张 0 卡片。
  const stats = usePolling<ProductionStats>(
    () => {
      const { start, end } = isoWindow(hours);
      return apiGet<ProductionStats>('/stats/production', { start, end });
    },
    30_000,
    { key: range },
  );

  // 四条产线并行，不能串行：串行会让 30 秒轮询变成 4 次接续等待
  const perLine = usePolling<ProductionStats[]>(
    () => {
      // 四条产线共用一个时间窗，否则 4 次请求的窗口会差几毫秒，柱状图对比不公平
      const { start, end } = isoWindow(hours);
      return Promise.all(
        LINES.map((line) =>
          apiGet<ProductionStats>('/stats/production', { line_id: line.id, start, end }),
        ),
      );
    },
    30_000,
    { key: range },
  );

  const orders = usePolling<Page<OrderItem>>(
    () => apiGet<Page<OrderItem>>('/orders', { page: 1, page_size: 20 }),
    30_000,
  );

  const orderRows = orders.data?.items ?? [];

  const barOption = useMemo(
    () =>
      groupedBarOption(
        LINES.map((l) => l.label),
        [
          {
            name: '计划产量',
            data: (perLine.data ?? []).map((s) => s.planned_quantity),
            color: CHART_COLORS.planned,
          },
          {
            name: '实际产量',
            data: (perLine.data ?? []).map((s) => s.actual_quantity),
            color: CHART_COLORS.primary,
          },
        ],
      ),
    [perLine.data],
  );

  const rateOption = useMemo(() => orderRateOption(orderRows), [orderRows]);

  const columns: Column<OrderItem>[] = [
    { key: 'order_id', title: '订单号', width: 172 },
    { key: 'line_id', title: '产线', width: 90 },
    { key: 'product_id', title: '产品', width: 110 },
    {
      key: 'planned_quantity',
      title: '计划',
      align: 'right',
      render: (r) => formatNumber(r.planned_quantity),
    },
    {
      key: 'actual_quantity',
      title: '实际',
      align: 'right',
      render: (r) => formatNumber(r.actual_quantity),
    },
    {
      key: 'qualified_rate',
      title: '合格率',
      align: 'right',
      render: (r) => (
        <span style={{ color: r.qualified_rate < 0.95 ? 'var(--st-idle)' : undefined }}>
          {formatPercent(r.qualified_rate)}
        </span>
      ),
    },
    {
      key: 'completion_rate',
      title: '完成率',
      align: 'right',
      render: (r) => formatPercent(r.completion_rate),
    },
    {
      key: 'status',
      title: '状态',
      width: 90,
      render: (r) => ORDER_STATUS[r.status] ?? r.status,
    },
  ];

  const s = stats.data;
  const noCompleted = Boolean(s && s.orders_completed === 0);
  const qualifiedTone = s && s.qualified_rate < 0.95 ? 'warn' : 'normal';
  const utilTone = s && s.utilization < 0.6 ? 'warn' : 'normal';

  return (
    <div className="page-stack">
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px' }}>
        <span className="secondary" style={{ fontSize: 13 }}>
          统计窗口
        </span>
        <RangePicker value={range} onChange={(next) => setRange(next as '1h' | '24h')} options={['1h', '24h']} />
        <span className="muted" style={{ fontSize: 12 }}>
          每 30 秒自动刷新；产线对比为 4 条产线并行查询
        </span>
      </div>

      {stats.error ? (
        <div className="card">
          <ErrorState error={stats.error} onRetry={stats.refresh} />
        </div>
      ) : noCompleted ? (
        <div className="card">
          <div className="state-block">
            <div className="state-block__title">当前窗口内没有已完工订单</div>
            <div className="state-block__hint">
              模拟器按 30 件/小时推进，订单需数小时才完工。切到「24 小时」通常就有数据；
              这里不显示 0% 合格率，避免把「还没完工」误读成「良率为零」。
            </div>
          </div>
        </div>
      ) : (
        <div className="kpi-row">
          <MetricCard
            label="已完成订单"
            value={s ? formatNumber(s.orders_completed) : '—'}
            unit={s ? '单' : undefined}
            delta={s ? `在制 ${formatNumber(s.orders_in_progress)} 单` : '等待数据'}
          />
          <MetricCard
            label="实际产量"
            value={s ? formatNumber(s.actual_quantity) : '—'}
            unit={s ? '件' : undefined}
            delta={s ? `计划 ${formatNumber(s.planned_quantity)} 件 · 完成率 ${formatPercent(s.completion_rate)}` : '等待数据'}
          />
          <MetricCard
            label="合格率"
            value={s ? formatPercent(s.qualified_rate) : '—'}
            delta={s ? `合格 ${formatNumber(s.qualified_quantity)} / 实际 ${formatNumber(s.actual_quantity)}` : '等待数据'}
            tone={qualifiedTone}
          />
          <MetricCard
            label="设备利用率"
            value={s ? formatPercent(s.utilization) : '—'}
            delta="按遥测采样点中 RUNNING 的占比"
            tone={utilTone}
          />
        </div>
      )}

      <div className="chart-grid">
        <ChartCard
          title="四条产线产量对比（计划 vs 实际）"
          option={barOption}
          height={240}
          loading={perLine.loading && !perLine.data}
          empty={Boolean(perLine.data) && (perLine.data ?? []).every((x) => x.planned_quantity === 0)}
          emptyText="当前窗口内四条产线都没有订单"
          footnote="逐产线调用 /stats/production?line_id=… 共 4 次，前端合并（Promise.all 并行）"
        />
        <ChartCard
          title="最近 20 单合格率与完成率走势"
          option={rateOption}
          height={240}
          loading={orders.loading && !orders.data}
          empty={orderRows.length === 0}
          emptyText="暂无订单"
          footnote="后端按 planned_start 倒序返回，图中按时间正序绘制；百分比 = 后端小数 ×100"
        />
      </div>

      <div className="card">
        <div className="card__title-row">
          <h3 className="card__title">订单列表（最近 20 单）</h3>
          <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
            共 {formatNumber(orders.data?.total ?? 0)} 单
          </span>
        </div>
        {orders.error ? (
          <ErrorState error={orders.error} onRetry={orders.refresh} />
        ) : (
          <DataTable
            columns={columns}
            rows={orderRows}
            rowKey={(r) => r.order_id}
            loading={orders.loading && !orders.data}
            empty="暂无订单"
          />
        )}
      </div>

      <div className="muted" style={{ fontSize: 12 }}>
        统计窗口：
        {s ? `${formatTime(s.start)} ~ ${formatTime(s.end)}` : '—'}
        ，合格率 = 合格数 / 实际数，完成率 = 实际数 / 计划数，利用率 = RUNNING 采样点 / 全部采样点。
      </div>
    </div>
  );
}
