/**
 * 页面五：AI 预测分析（规格 5.6 → spec_phase4 §6.2）。
 *
 * 第 3 阶段这一页只有真值，没有模型。第 4 阶段 4.2 批把模型接进来了，
 * 布局分成两层：
 *
 *   上层「模型输出」—— 全部来自 /ml/* 接口，页面不写任何数字：
 *     指标卡 ×4 → 混淆矩阵 → 四模型对比 → 异常分数曲线
 *   下层「真值对照」—— 第 3 阶段原有的甘特与对比柱，保留不删：
 *     它们是模型的对照物，删了就没法复核"模型抓的对不对"。
 *
 * 硬性红线（§6.2）：页面上每一个数字都必须能追到一次真实的接口返回。
 * 所以模型未加载时整块换成降级提示，**不许显示 0、不许显示占位数字**。
 * 验收脚本 acceptance-ai.mjs 会逐个比对页面上带 data-ml-* 标记的数字与接口返回。
 */

import { useMemo, useState } from 'react';
import {
  ANOMALY_META,
  ANOMALY_TYPES,
  confusionHeatmapOption,
  ganttOption,
  groupedBarOption,
  modelCompareOption,
  scoreCurveOption,
} from '../charts/options';
import { ChartCard } from '../components/ChartCard';
import { DataTable, type Column } from '../components/DataTable';
import { ErrorState } from '../components/ErrorState';
import { RangePicker } from '../components/RangePicker';
import type { RangeKey } from '../hooks/useDeviceTelemetry';
import { usePolling } from '../hooks/usePolling';
import { apiGet } from '../services/api';
import { formatNumber, formatPercent, formatTime } from '../services/format';
import type {
  AlarmItem,
  AnomalyItem,
  ConfusionPayload,
  DeviceListItem,
  ModelInfo,
  Page,
  ScorePayload,
} from '../services/types';
import { anomalyVsAlarm, buildGantt, paramsText } from '../utils/analytics';

const PAGE_SIZE = 100;
const RANGE_HOURS: Record<RangeKey, number> = { '1h': 1, '6h': 6, '24h': 24 };
// 分数曲线窗口终点相对当前时刻的后退量。理由见 fetcher 处注释（活数据源的右边界竞态）。
const SCORE_WINDOW_SETTLE_MS = 5_000;

/** 四个指标卡的定义。value 一律从 ModelInfo.metrics 取，这里不写任何指标常量。 */
function metricCards(info: ModelInfo) {
  const m = info.metrics;
  if (!m) return [];
  const baselineRecall = info.baselines.find((b) => b.key === 'threshold_rule')?.recall;
  return [
    {
      key: 'pr_auc',
      label: 'PR-AUC（主指标）',
      value: m.pr_auc == null ? '—' : m.pr_auc.toFixed(4),
      unit: '',
      tone: 'normal' as const,
      hint: '正例仅 1.7%，用 PR-AUC 而不是 ROC-AUC',
    },
    {
      key: 'recall',
      label: '召回率（漏报 = 1 − 召回）',
      value: formatPercent(m.recall, 2),
      unit: '',
      tone: 'normal' as const,
      hint: baselineRecall == null ? '—' : `阈值规则召回 ${formatPercent(baselineRecall, 2)}`,
    },
    {
      key: 'detection_rate',
      label: '注入区间检出率',
      value: formatPercent(m.detection_rate, 2),
      unit: '',
      tone: (m.detection_rate ?? 0) >= 0.9 ? ('normal' as const) : ('warn' as const),
      hint: `${formatNumber(m.intervals_detected)} / ${formatNumber(m.intervals_with_rows)} 个区间，中位延迟 ${m.median_delay_seconds ?? '—'} 秒`,
    },
    {
      key: 'false_alarms',
      label: '每小时误报（每设备）',
      value: m.false_alarms_per_device_hour == null ? '—' : m.false_alarms_per_device_hour.toFixed(2),
      unit: '',
      tone: 'warn' as const,
      hint: '阈值按验证段的「每小时 ≤1 次」预算选出',
    },
  ];
}

export default function AiInsight() {
  const [deviceId, setDeviceId] = useState('CNC-01');
  const [range, setRange] = useState<RangeKey>('1h');

  // 模型信息 5 分钟刷一次：训练产物不会随运行变化，但换模型后要能自动反映
  const modelInfo = usePolling<ModelInfo>(() => apiGet<ModelInfo>('/ml/model-info'), 300_000);
  const loaded = modelInfo.data?.loaded === true;

  const devices = usePolling<Page<DeviceListItem>>(
    () => apiGet<Page<DeviceListItem>>('/devices', { page: 1, page_size: 100 }),
    300_000,
  );

  const confusion = usePolling<ConfusionPayload>(
    () => apiGet<ConfusionPayload>('/ml/anomaly/confusion'),
    300_000,
    { enabled: loaded },
  );

  // 推理要 200ms~2s，轮询间隔给 120 秒。窗口在 fetcher 里现算，
  // 否则页面开久了以后曲线会永远停在上次渲染的那一小时。
  //
  // 终点后退 5 秒再取数：模拟器每 2 秒写一批、时间戳还略有滞后，若把"当前时刻"
  // 当窗口终点，最新几个采样点会在页面请求之后、验收脚本重放之前才落库，
  // 于是页面点数比同窗重放少 1 个（实测 944 vs 945，约 1/3 概率复现）。
  // 后退 5 秒让窗口落在已经落库的数据上，同窗重放才可复现。
  const scores = usePolling<ScorePayload>(
    () => {
      const endMs = Date.now() - SCORE_WINDOW_SETTLE_MS;
      return apiGet<ScorePayload>('/ml/anomaly/scores', {
        device_id: deviceId,
        start: new Date(endMs - RANGE_HOURS[range] * 3600 * 1000).toISOString(),
        end: new Date(endMs).toISOString(),
      });
    },
    120_000,
    { enabled: loaded, key: `${deviceId}|${range}` },
  );

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

  const cards = modelInfo.data ? metricCards(modelInfo.data) : [];
  const confusionChart = useMemo(
    () => (confusion.data ? confusionHeatmapOption(confusion.data) : null),
    [confusion.data],
  );
  const compareModelChart = useMemo(
    () => (modelInfo.data?.baselines.length ? modelCompareOption(modelInfo.data.baselines) : null),
    [modelInfo.data],
  );
  const scoreChart = useMemo(
    () => (scores.data && scores.data.count > 0 ? scoreCurveOption(scores.data) : null),
    [scores.data],
  );

  // 主模型相对阈值规则的增量：这句话比"模型更好"有信息量，且完全由接口数据算出
  const delta = useMemo(() => {
    const info = modelInfo.data;
    if (!info?.metrics) return null;
    const baseline = info.baselines.find((b) => b.key === 'threshold_rule');
    if (!baseline || baseline.pr_auc == null || info.metrics.pr_auc == null) return null;
    return {
      pr_auc: info.metrics.pr_auc - baseline.pr_auc,
      recall: (info.metrics.recall ?? 0) - (baseline.recall ?? 0),
      precision: (info.metrics.precision ?? 0) - (baseline.precision ?? 0),
    };
  }, [modelInfo.data]);

  const deviceOptions: DeviceListItem[] = devices.data?.items?.length
    ? devices.data.items
    : [{ device_id: deviceId } as DeviceListItem];

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
        <strong>模型基于模拟器注入真值训练，指标为离线测试集结果。</strong>
        注入密度（约每 9 分钟一次）为演示设定，不代表真实工厂异常率；真实场景下异常更稀疏，指标会变差。
        判定阈值在验证段按「每设备每小时误报 ≤1 次」选出，测试段未参与调参。
      </div>

      {/* ---------------- 模型输出区 ---------------- */}
      {modelInfo.error ? (
        <div className="card">
          <ErrorState error={modelInfo.error} onRetry={modelInfo.refresh} />
        </div>
      ) : modelInfo.data && !loaded ? (
        <div className="card model-degraded" data-ml-state="degraded">
          <div className="model-degraded__title">模型未加载，当前告警仍由阈值规则产生</div>
          <div className="model-degraded__reason" data-ml-degraded-reason>
            {modelInfo.data.degraded_reason}
          </div>
          <div className="model-degraded__hint">
            下方「异常真值」与「真值 vs 阈值告警」两块照常显示，不受模型状态影响。
            这是有意设计：模型不可用时系统功能不残缺，只是少了 AI 归因。
          </div>
        </div>
      ) : (
        <>
          <div className="model-strip" data-ml-state="loaded">
            <span className="model-strip__badge">模型已加载</span>
            <span className="mono-sm" data-ml-field="model_id">
              {modelInfo.data?.model_id ?? '加载中…'}
            </span>
            {modelInfo.data ? (
              <>
                <span className="model-strip__sep">·</span>
                <span className="mono-sm">
                  训练于 {formatTime(modelInfo.data.trained_at)}（commit {modelInfo.data.git_commit}）
                </span>
                <span className="model-strip__sep">·</span>
                <span className="mono-sm">
                  {modelInfo.data.feature_count} 维特征 · schema{' '}
                  <span data-ml-field="schema_hash">{modelInfo.data.schema_hash}</span>
                  {modelInfo.data.schema_match ? '（一致）' : '（不一致）'}
                </span>
                <span className="model-strip__sep">·</span>
                <span className="mono-sm">
                  判定阈值 <span data-ml-field="threshold">{modelInfo.data.threshold?.toFixed(4)}</span>
                </span>
              </>
            ) : null}
          </div>

          <div className="kpi-row" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
            {cards.map((card) => (
              <div className="metric-card" key={card.key}>
                <div className="metric-card__label">{card.label}</div>
                <div
                  className={`metric-card__value metric-card__value--${card.tone}`}
                  data-ml-metric={card.key}
                >
                  {card.value}
                  {card.unit ? <span className="metric-card__unit">{card.unit}</span> : null}
                </div>
                <div className="metric-card__delta">{card.hint}</div>
                <div className="metric-card__delta" style={{ opacity: 0.75 }}>
                  测试集 {formatNumber(modelInfo.data?.metrics?.test_rows)} 行 / 正例{' '}
                  {formatNumber(modelInfo.data?.metrics?.test_positives)} 行
                </div>
              </div>
            ))}
          </div>

          <div className="chart-grid">
            <ChartCard
              title="混淆矩阵（离线测试集）"
              option={confusionChart ?? {}}
              height={240}
              loading={confusion.loading && !confusion.data}
              empty={!confusion.data}
              emptyText="混淆矩阵不可用"
              extra={
                confusion.data ? (
                  <div className="mono-sm" style={{ lineHeight: 1.6 }}>
                    <span data-ml-confusion="tn">TN {formatNumber(confusion.data.matrix[0][0])}</span>
                    {' · '}
                    <span data-ml-confusion="fp" style={{ color: '#fbbf24' }}>
                      FP {formatNumber(confusion.data.matrix[0][1])}
                    </span>
                    {' · '}
                    <span data-ml-confusion="fn" style={{ color: '#fca5a5' }}>
                      FN {formatNumber(confusion.data.matrix[1][0])}
                    </span>
                    {' · '}
                    <span data-ml-confusion="tp" style={{ color: '#86efac' }}>
                      TP {formatNumber(confusion.data.matrix[1][1])}
                    </span>
                  </div>
                ) : null
              }
              footnote={
                confusion.data
                  ? `${confusion.data.note}。阈值 ${confusion.data.threshold.toFixed(4)}，PR-AUC ${confusion.data.pr_auc?.toFixed(4)}。`
                  : undefined
              }
            />
            <ChartCard
              title="四模型 PR-AUC 对比（为什么用 XGBoost）"
              option={compareModelChart ?? {}}
              height={240}
              loading={modelInfo.loading && !modelInfo.data}
              empty={!compareModelChart}
              emptyText="模型对比不可用"
              footnote={
                delta
                  ? `相对阈值规则基线：PR-AUC ${delta.pr_auc >= 0 ? '+' : ''}${delta.pr_auc.toFixed(4)}、召回 ${
                      delta.recall >= 0 ? '+' : ''
                    }${(delta.recall * 100).toFixed(2)}pp、精确 ${delta.precision >= 0 ? '+' : ''}${(
                      delta.precision * 100
                    ).toFixed(2)}pp。模型的代价是误报变多，不是全面更优。`
                  : undefined
              }
            />
          </div>

          <ChartCard
            title="异常分数曲线（实时推理 vs 注入真值）"
            option={scoreChart ?? {}}
            height={280}
            loading={scores.loading && !scores.data}
            empty={!scoreChart}
            emptyText="该时间窗内没有遥测数据"
            extra={
              <div className="toolbar">
                <select
                  className="input"
                  style={{ width: 168, height: 30, padding: '0 8px' }}
                  value={deviceId}
                  onChange={(event) => setDeviceId(event.target.value)}
                  aria-label="选择设备"
                  data-ml-device-select
                >
                  {deviceOptions.map((device) => (
                    <option key={device.device_id} value={device.device_id}>
                      {device.device_id}
                      {device.device_name ? ` ${device.device_name}` : ''}
                    </option>
                  ))}
                </select>
                <RangePicker value={range} onChange={setRange} />
              </div>
            }
            footnote={
              scores.data ? (
                <>
                  {/* 把本次推理用的时间窗写进 DOM：验收脚本要用同一个窗口重放请求，
                      才能逐字段比对"页面数字 = 接口返回"。窗口固定后结果稳定，
                      否则两次采样之间模拟器又写了两秒数据，数字必然对不上。 */}
                  <span
                    data-ml-window
                    data-start={scores.data.start}
                    data-end={scores.data.end}
                    data-device={scores.data.device_id}
                    hidden
                  />
                  共 <span data-ml-score-count>{formatNumber(scores.data.count)}</span> 个点（原始{' '}
                  {formatNumber(scores.data.raw_count)} 点，降采样 ×{scores.data.downsample_step}，预热{' '}
                  {scores.data.warmup_rows} 点）。窗口内模型判为异常{' '}
                  <span data-ml-score-predicted>{formatNumber(scores.data.summary.predicted_rows)}</span>{' '}
                  个点，注入真值 <span data-ml-score-intervals>{scores.data.intervals.length}</span> 段。
                  红色散点是超过阈值的点，半透明色块是注入真值区间——两者应当互相覆盖。
                  纵轴线性 0~1：正常时段分数在 1e-5 量级，因此贴着底部；尖峰才是异常。
                </>
              ) : (
                '曲线由 /ml/anomaly/scores 实时推理得到，不是缓存的旧结果。'
              )
            }
          />
        </>
      )}

      {/* ---------------- 真值对照区（第 3 阶段原有，保留） ---------------- */}
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

      <ChartCard
        title="真值条数 vs 阈值告警条数（按类型）"
        option={compareChart}
        height={240}
        loading={anomalies.loading && !anomalies.data}
        empty={rows.length === 0}
        emptyText="暂无数据"
        footnote="两类数字天然不等：阈值规则只看瞬时值，真值是注入器写下的标准答案。"
      />

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
