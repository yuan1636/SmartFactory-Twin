/**
 * 页面五：AI 预测分析（规格 5.6）。
 * 本阶段没有任何模型：页面只展示模拟器写入的异常真值与阈值规则告警的对照。
 * 硬性禁止：不得出现「准确率」「故障概率」这类没有模型就没有的数字。
 */

import { useMemo } from 'react';
import { ANOMALY_META, ANOMALY_TYPES, ganttOption, groupedBarOption } from '../charts/options';
import { ChartCard } from '../components/ChartCard';
import { DataTable, type Column } from '../components/DataTable';
import { ErrorState } from '../components/ErrorState';
import { usePolling } from '../hooks/usePolling';
import { apiGet } from '../services/api';
import { formatNumber, formatTime } from '../services/format';
import type { AlarmItem, AnomalyItem, Page } from '../services/types';
import { anomalyVsAlarm, buildGantt, paramsText } from '../utils/analytics';

const PAGE_SIZE = 100;

export default function AiInsight() {
  const anomalies = usePolling<Page<AnomalyItem>>(
    () => apiGet<Page<AnomalyItem>>('/anomalies', { page: 1, page_size: PAGE_SIZE }),
    60_000,
  );

  const alarms = usePolling<Page<AlarmItem>>(
    () => apiGet<Page<AlarmItem>>('/alarms', { page: 1, page_size: 100 }),
    60_000,
  );

  const rows = anomalies.data?.items ?? [];

  const gantt = useMemo(() => buildGantt(rows), [rows]);
  const ganttChart = useMemo(() => ganttOption(gantt.categories, gantt.tasks), [gantt]);

  const compare = useMemo(
    () => anomalyVsAlarm(rows, alarms.data?.items ?? []),
    [rows, alarms.data],
  );
  const compareChart = useMemo(
    () =>
      groupedBarOption(compare.categories, [
        { name: '异常真值条数', data: compare.truth, color: '#3b82f6' },
        { name: '阈值告警条数', data: compare.alarm, color: '#ef4444' },
      ]),
    [compare],
  );

  const columns: Column<AnomalyItem>[] = [
    { key: 'device_id', title: '设备', width: 96 },
    {
      key: 'anomaly_type',
      title: '类型',
      width: 100,
      render: (r) => (
        <span style={{ color: ANOMALY_META[r.anomaly_type]?.color }}>
          {ANOMALY_META[r.anomaly_type]?.label ?? r.anomaly_type}
        </span>
      ),
    },
    { key: 'started_at', title: '开始', width: 156, render: (r) => formatTime(r.started_at) },
    { key: 'ended_at', title: '结束', width: 156, render: (r) => formatTime(r.ended_at) },
    { key: 'params', title: '参数', render: (r) => <span className="mono-sm">{paramsText(r.params)}</span> },
  ];

  const legend = (
    <div className="legend">
      {ANOMALY_TYPES.map((type) => (
        <span className="legend__item" key={type}>
          <span className="legend__swatch" style={{ background: ANOMALY_META[type].color }} />
          {ANOMALY_META[type].label}
        </span>
      ))}
    </div>
  );

  return (
    <div className="page-stack">
      <div className="notice-bar">
        <strong>本阶段不含任何模型推理。</strong>
        以下数据来自模拟器写入的异常真值与阈值告警规则，不是模型预测结果。
        异常检测模型、故障预测与产量预测属第 4 阶段。
      </div>

      <div className="kpi-row kpi-row--3">
        <div className="metric-card">
          <div className="metric-card__label">异常真值累计</div>
          <div className="metric-card__value metric-card__value--normal">
            {anomalies.data ? formatNumber(anomalies.data.total) : '—'}
            <span className="metric-card__unit">条</span>
          </div>
          <div className="metric-card__delta">
            图中展示最近 {Math.min(PAGE_SIZE, rows.length)} 条（模拟器每 20 分钟注入一次）
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-card__label">阈值告警累计</div>
          <div className="metric-card__value metric-card__value--normal">
            {alarms.data ? formatNumber(alarms.data.total) : '—'}
            <span className="metric-card__unit">条</span>
          </div>
          <div className="metric-card__delta">扫描任务按 inserted_at 增量判定</div>
        </div>
        <div className="metric-card">
          <div className="metric-card__label">两者差值</div>
          <div className="metric-card__value metric-card__value--warn">
            {anomalies.data && alarms.data
              ? formatNumber(anomalies.data.total - alarms.data.total)
              : '—'}
            <span className="metric-card__unit">条</span>
          </div>
          <div className="metric-card__delta">
            说明阈值规则会漏（渐变未到阈值）也会误（尖峰超限但真值窗口已过）
          </div>
        </div>
      </div>

      {anomalies.error ? (
        <div className="card">
          <ErrorState error={anomalies.error} onRetry={anomalies.refresh} />
        </div>
      ) : (
        <ChartCard
          title="异常真值时间轴（按设备分行）"
          option={ganttChart}
          height={Math.max(240, gantt.categories.length * 22 + 48)}
          loading={anomalies.loading && !anomalies.data}
          empty={rows.length === 0}
          emptyText="还没有异常真值记录"
          extra={legend}
          footnote="每根条是一次注入的起止区间；条越密说明该设备被注入得越频繁。这是真值，不是检测结果。"
        />
      )}

      <div className="chart-grid">
        <ChartCard
          title="真值条数 vs 阈值告警条数（按类型）"
          option={compareChart}
          height={240}
          loading={anomalies.loading && !anomalies.data}
          empty={rows.length === 0}
          emptyText="暂无数据"
          footnote="两类数字天然不等：阈值规则只看瞬时值，真值是注入器写下的标准答案。"
        />
        <div className="card reserved-box">
          <div className="reserved-box__title">异常检测模型输出 —— 预留，本阶段不实现</div>
          <div className="reserved-box__hint">
            第 4 阶段接入 XGBoost / 时序模型后，这里放预测区间、置信度与命中情况。
            现在留空，不放任何编造的数字。
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card__title-row">
          <h3 className="card__title">异常真值列表</h3>
          <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
            共 {formatNumber(anomalies.data?.total ?? 0)} 条
          </span>
        </div>
        {anomalies.error ? (
          <ErrorState error={anomalies.error} onRetry={anomalies.refresh} />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            loading={anomalies.loading && !anomalies.data}
            empty="暂无异常真值"
          />
        )}
        <div className="card__footnote">
          参数列为注入器写入的原始参数（如 start_from / slope_per_tick），用来复现该次异常。
        </div>
      </div>
    </div>
  );
}
