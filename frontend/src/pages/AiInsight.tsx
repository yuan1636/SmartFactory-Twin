/**
 * 页面五：工厂日报（/ai，2026-11-26 改版，spec_phase4 偏差 D-74）。
 *
 * 为什么改：原页面的主角是 PR-AUC / 混淆矩阵，回答的是「模型好不好」；
 * 但看这个页面的人要的是「今天哪里要管、不管会损失多少」。所以信息架构按
 * 结论 → 待办 → 交付风险 → 损失账 排，**模型指标降级为折叠区的证据链**。
 *
 * 三条硬约束（作者 2026-11-26）：
 *   1. 每个数字都要能追到接口字段与算式——页面底部有公式区，行内用 data-todo-* 暴露参数，
 *      acceptance-ai.mjs 会按同一算式复算每一行的「预计影响件数」。
 *   2. 待办与结论只说人话，PR-AUC / F1 / 特征维度这些词只允许出现在折叠区。
 *   3. 无数据时写「数据不足，无法给出建议」，不显示 0、不猜。
 *
 * 系数（节拍、降速、处置时长、单价、不良率、分档阈值、时限）一律来自 /report/config，
 * 前端不写任何业务常量——AGENTS 规则 8。
 */

import { useEffect, useMemo, useState } from 'react';
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
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { MetricCard } from '../components/MetricCard';
import { RangePicker } from '../components/RangePicker';
import type { RangeKey } from '../hooks/useDeviceTelemetry';
import { usePolling } from '../hooks/usePolling';
import { apiGet } from '../services/api';
import { formatNumber, formatPercent, formatTime, formatTimeShort } from '../services/format';
import type {
  AlarmItem,
  AnomalyItem,
  ConfusionPayload,
  DeviceDetail,
  DeviceListItem,
  MetricRange,
  ModelInfo,
  OrderItem,
  Page,
  ReportConfig,
  ScorePayload,
  TelemetryResponse,
} from '../services/types';
import { anomalyVsAlarm, buildGantt, paramsText } from '../utils/analytics';
import {
  buildDeliveryRisks,
  buildMonthlyLoss,
  buildTodoRows,
  lineRhythm,
  pickSegment,
  type ActionLevel,
  type AnomalySegment,
  type DeliveryRow,
  type TodoRow,
} from '../utils/dailyReport';
import { CHART_COLORS } from '../styles/chartColors';

const LIST_PAGE = 100;
/** 接口单页上限 200；本月异常已超 1000 条，损失账必须翻页取全 */
const MAX_PAGE = 200;
const MAX_PAGES = 10;
const RANGE_HOURS: Record<RangeKey, number> = { '1h': 1, '6h': 6, '24h': 24 };
const SCORE_WINDOW_SETTLE_MS = 5_000;
const SCORE_REFRESH_MS = 120_000;
/** 待办表最多 5 行（作者指定） */
const TODO_LIMIT = 5;

const ACTION_META: Record<ActionLevel, { label: string; cls: string }> = {
  stop: { label: '立即停机检修', cls: 'stop' },
  today: { label: '今日下班后处理', cls: 'today' },
  observe: { label: '继续观察', cls: 'observe' },
};

/** 异常类型 → 能用哪个指标解释现象。现象取「异常区间内的峰值」，不取当前值：
 *  异常常常发生在十几分钟前，拿此刻的读数会写出「振动 1.69，正常上限 2.5」这种自相矛盾的话。 */
const METRIC_OF_TYPE: Record<string, 'temperature' | 'vibration' | 'current'> = {
  TEMP_DRIFT: 'temperature',
  VIB_SPIKE: 'vibration',
  CURRENT_ABNORMAL: 'current',
};

interface LatestItem {
  device_id: string;
  temperature: number | null;
  vibration: number | null;
  current: number | null;
  speed: number | null;
  running_status: string;
  ts: string;
}

interface LatestPayload {
  server_time: string;
  items: LatestItem[];
}

function monthStartIso(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

function monthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth() + 1}`;
}

/** 取不到采样间隔时按 2 秒（与 devices.json 一致），只影响段时长 ±2s */
function sampleSecondsOf(points: Array<{ ts: string }>): number {
  if (points.length < 2) return 2;
  const delta = (Date.parse(points[1].ts) - Date.parse(points[0].ts)) / 1000;
  return delta > 0 ? delta : 2;
}

async function fetchMonthAnomalies(): Promise<AnomalyItem[]> {
  const start = monthStartIso();
  const first = await apiGet<Page<AnomalyItem>>('/anomalies', { start, page: 1, page_size: MAX_PAGE });
  const pages = Math.min(MAX_PAGES, Math.ceil(first.total / MAX_PAGE));
  if (pages <= 1) return first.items;
  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) =>
      apiGet<Page<AnomalyItem>>('/anomalies', { start, page: i + 2, page_size: MAX_PAGE }),
    ),
  );
  return [...first.items, ...rest.flatMap((r) => r.items)];
}

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
  // ---------- 折叠区（模型详情 / 页底公式）的状态 ----------
  const [modelsOpen, setModelsOpen] = useState(false);
  // 公式区跟模型详情同一种处理：默认收起，避免首屏被 8 条算式和系数假设值撑长。
  // 需要复算的人点开就有，不需要的人不用滚动路过。
  const [formulaOpen, setFormulaOpen] = useState(false);
  const [deviceId, setDeviceId] = useState('CNC-01');
  const [range, setRange] = useState<RangeKey>('1h');

  // ---------- 日报数据 ----------
  const reportCfg = usePolling<ReportConfig>(() => apiGet<ReportConfig>('/report/config'), 300_000);
  const cfg = reportCfg.data;
  const windowMin = cfg?.report_window_minutes ?? null;

  const devices = usePolling<Page<DeviceListItem>>(
    () => apiGet<Page<DeviceListItem>>('/devices', { page: 1, page_size: MAX_PAGE }),
    300_000,
  );
  const latest = usePolling<LatestPayload>(() => apiGet<LatestPayload>('/devices/latest'), 10_000);
  const orders = usePolling<Page<OrderItem>>(
    () => apiGet<Page<OrderItem>>('/orders', { page: 1, page_size: MAX_PAGE }),
    60_000,
  );

  // 窗口内出现过的异常 → 圈定"哪几台设备需要算分数"。不是直接拿真值当结论：
  // 日报的风险分按作者公式要用模型分数峰值，真值只负责告诉我们去看哪几台。
  const windowAnoms = usePolling<Page<AnomalyItem>>(
    () =>
      apiGet<Page<AnomalyItem>>('/anomalies', {
        start: new Date(Date.now() - (windowMin ?? 120) * 60_000).toISOString(),
        page_size: LIST_PAGE,
      }),
    60_000,
    { enabled: windowMin != null, key: String(windowMin) },
  );

  const monthAnoms = usePolling<AnomalyItem[]>(() => fetchMonthAnomalies(), 600_000, {
    enabled: cfg != null,
    key: monthKey(),
  });

  // ---------- 折叠区数据（默认不拉，展开才拉） ----------
  const modelInfo = usePolling<ModelInfo>(() => apiGet<ModelInfo>('/ml/model-info'), 300_000, {
    enabled: modelsOpen,
  });
  const loaded = modelInfo.data?.loaded === true;
  const confusion = usePolling<ConfusionPayload>(() => apiGet<ConfusionPayload>('/ml/anomaly/confusion'), 300_000, {
    enabled: modelsOpen && loaded,
  });
  const scores = usePolling<ScorePayload>(
    () => {
      const endMs = Date.now() - SCORE_WINDOW_SETTLE_MS;
      return apiGet<ScorePayload>('/ml/anomaly/scores', {
        device_id: deviceId,
        start: new Date(endMs - RANGE_HOURS[range] * 3600 * 1000).toISOString(),
        end: new Date(endMs).toISOString(),
      });
    },
    SCORE_REFRESH_MS,
    { enabled: modelsOpen && loaded, key: `${deviceId}|${range}` },
  );
  const anomaliesFull = usePolling<Page<AnomalyItem>>(
    () => apiGet<Page<AnomalyItem>>('/anomalies', { page: 1, page_size: LIST_PAGE }),
    60_000,
    { enabled: modelsOpen },
  );
  const alarms = usePolling<Page<AlarmItem>>(
    () => apiGet<Page<AlarmItem>>('/alarms', { page: 1, page_size: LIST_PAGE }),
    60_000,
    { enabled: modelsOpen },
  );

  // ---------- 待办所需的逐台分数 ----------
  const candidates = useMemo(() => {
    const count = new Map<string, number>();
    for (const item of windowAnoms.data?.items ?? []) {
      count.set(item.device_id, (count.get(item.device_id) ?? 0) + 1);
    }
    // 最多 6 台：一次推理约 0.3s，6 台并发在 1s 内，再多就值得先做后端聚合了
    return [...count.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([id]) => id);
  }, [windowAnoms.data]);
  const candidateKey = candidates.join('|');

  const [scoreMap, setScoreMap] = useState<Record<string, ScorePayload>>({});
  const [rangeMap, setRangeMap] = useState<Record<string, Partial<Record<string, MetricRange>>>>({});
  const [scoreLoading, setScoreLoading] = useState(false);

  useEffect(() => {
    if (!candidateKey || windowMin == null) {
      setScoreMap({});
      return;
    }
    let alive = true;
    const ids = candidateKey.split('|');

    const load = async () => {
      setScoreLoading(true);
      const end = Date.now() - SCORE_WINDOW_SETTLE_MS;
      const start = end - windowMin * 60_000;
      const results = await Promise.allSettled(
        ids.map((id) =>
          apiGet<ScorePayload>('/ml/anomaly/scores', {
            device_id: id,
            start: new Date(start).toISOString(),
            end: new Date(end).toISOString(),
          }),
        ),
      );
      if (!alive) return;
      const next: Record<string, ScorePayload> = {};
      results.forEach((result, i) => {
        if (result.status === 'fulfilled') next[ids[i]] = result.value;
      });
      setScoreMap(next);
      setScoreLoading(false);
    };

    void load();
    const timer = setInterval(load, SCORE_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [candidateKey, windowMin]);

  // 正常区间只用来把「振动 3.49」翻译成「比正常上限高 16%」，拿不到就只说类型
  useEffect(() => {
    if (!candidateKey) {
      setRangeMap({});
      return;
    }
    let alive = true;
    void Promise.all(
      candidateKey.split('|').map((id) =>
        apiGet<DeviceDetail>(`/devices/${id}`)
          .then((detail) => [id, detail.metrics_normal_range] as const)
          .catch(() => null),
      ),
    ).then((list) => {
      if (!alive) return;
      const next: Record<string, Partial<Record<string, MetricRange>>> = {};
      for (const entry of list) if (entry) next[entry[0]] = entry[1];
      setRangeMap(next);
    });
    return () => {
      alive = false;
    };
  }, [candidateKey]);

  const latestById = useMemo(
    () => new Map((latest.data?.items ?? []).map((item) => [item.device_id, item])),
    [latest.data],
  );
  const lineById = useMemo(
    () => new Map((devices.data?.items ?? []).map((d) => [d.device_id, d.line_id])),
    [devices.data],
  );

  const scoreItems = useMemo(() => {
    if (!cfg) return [];
    const out: Array<{
      deviceId: string;
      anomalyType: string;
      segment: AnomalySegment;
      latest: { temperature: number | null; vibration: number | null; current: number | null } | null;
      normalRange: Partial<Record<string, MetricRange>> | null;
    }> = [];

    for (const id of candidates) {
      const payload = scoreMap[id];
      if (!payload || payload.points.length === 0) continue;
      const picked = pickSegment(payload.points, payload.intervals, sampleSecondsOf(payload.points));
      if (!picked) continue;
      const { segment } = picked;
      // 类型优先取真值区间自带的类型；没有时退回曲线标签 / 窗口内最新真值记录
      const labeled = payload.points.filter((p) => p.label_type);
      const type =
        picked.anomalyType ??
        labeled[labeled.length - 1]?.label_type ??
        windowAnoms.data?.items.find((a) => a.device_id === id)?.anomaly_type ??
        '';
      out.push({
        deviceId: id,
        anomalyType: type,
        segment,
        latest: latestById.get(id) ?? null,
        normalRange: rangeMap[id] ?? null,
      });
    }
    return out;
  }, [cfg, candidates, scoreMap, latestById, rangeMap, windowAnoms.data]);

  const orderItems = orders.data?.items ?? [];
  const deviceItems = devices.data?.items ?? [];

  // 区间内该指标的峰值：只为了把「振动尖峰」翻译成「振动 4.1 mm/s，比正常上限高 37%」
  const [metricPeak, setMetricPeak] = useState<Record<string, number>>({});
  const segmentKey = scoreItems
    .map((item) => `${item.deviceId}|${item.anomalyType}|${item.segment.startedAt}`)
    .join(',');

  useEffect(() => {
    if (!segmentKey) {
      setMetricPeak({});
      return;
    }
    let alive = true;
    const items = segmentKey.split(',').map((key) => {
      const [deviceId, anomalyType, startedAt] = key.split('|');
      return { deviceId, anomalyType, startedAt: Number(startedAt) };
    });

    void Promise.all(
      items.map(async (item) => {
        const metric = METRIC_OF_TYPE[item.anomalyType];
        if (!metric) return null;
        const seg = scoreItems.find((s) => s.deviceId === item.deviceId);
        if (!seg) return null;
        try {
          const response = await apiGet<TelemetryResponse>(`/devices/${item.deviceId}/telemetry`, {
            start: new Date(seg.segment.startedAt - 5000).toISOString(),
            end: new Date(seg.segment.endedAt + 5000).toISOString(),
          });
          const values = response.points
            .map((p) => p[metric])
            .filter((v): v is number => v !== null && v !== undefined);
          return values.length ? ([item.deviceId, Math.max(...values)] as const) : null;
        } catch {
          return null;
        }
      }),
    ).then((list) => {
      if (!alive) return;
      const next: Record<string, number> = {};
      for (const entry of list) if (entry) next[entry[0]] = entry[1];
      setMetricPeak(next);
    });

    return () => {
      alive = false;
    };
    // scoreItems 每次渲染都是新数组，只按「设备+类型+区间起点」的指纹重拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentKey]);

  /** 把区间峰值塞进「读数」的位置，symptomText 只认这个结构 */
  const scoreItemsWithPeak = useMemo(
    () =>
      scoreItems.map((item) => {
        const peak = metricPeak[item.deviceId];
        const metric = METRIC_OF_TYPE[item.anomalyType];
        if (peak == null || !metric) return item;
        return {
          ...item,
          latest: { temperature: null, vibration: null, current: null, [metric]: peak },
        };
      }),
    [scoreItems, metricPeak],
  );

  const todo: TodoRow[] = useMemo(
    () =>
      cfg
        ? buildTodoRows({
            scores: scoreItemsWithPeak,
            devices: deviceItems,
            orders: orderItems,
            config: cfg,
            limit: TODO_LIMIT,
          })
        : [],
    [cfg, scoreItemsWithPeak, deviceItems, orderItems],
  );

  /** 每条线当前被压到什么程度：取该线所有活跃异常里最严重的降速比例 */
  const activeSlowdown = useMemo(() => {
    const map: Record<string, number> = {};
    if (!cfg) return map;
    for (const item of scoreItems) {
      const line = lineById.get(item.deviceId);
      const handling = cfg.anomaly_handling[item.anomalyType];
      if (line && handling) map[line] = Math.max(map[line] ?? 0, handling.slowdown);
    }
    return map;
  }, [cfg, scoreItems, lineById]);

  const deliveryRows: DeliveryRow[] = useMemo(() => {
    if (!cfg) return [];
    const effective: Record<string, number> = {};
    const lines = new Set<string>([...Object.keys(cfg.lines), ...orderItems.map((o) => o.line_id)]);
    for (const line of lines) {
      const rhythm = lineRhythm(line, orderItems, cfg);
      if (rhythm) effective[line] = rhythm.cycle * (1 - (activeSlowdown[line] ?? 0));
    }
    return buildDeliveryRisks({ orders: orderItems, effectiveCycle: effective, config: cfg, now: Date.now() });
  }, [cfg, orderItems, activeSlowdown]);

  const loss = useMemo(
    () =>
      cfg && monthAnoms.data
        ? buildMonthlyLoss(monthAnoms.data, deviceItems, orderItems, cfg, Date.now())
        : null,
    [cfg, monthAnoms.data, deviceItems, orderItems],
  );

  // ---------- 结论 ----------
  const dataReady = Boolean(cfg && devices.data && latest.data && !windowAnoms.error);
  const highRisk = cfg ? todo.filter((row) => row.riskScore >= cfg.risk_score_high).length : null;
  const totalImpact = todo.reduce((sum, row) => sum + row.impact, 0);
  const deadlineHours = cfg && todo.length > 0 ? cfg.action_deadline_hours[todo[0].action] : null;

  const advice = useMemo(() => {
    if (!dataReady) return '数据不足，无法给出建议';
    if (todo.length === 0) return '当前巡检窗口内没有需要动作的设备，按计划生产即可。';
    const stop = todo.filter((row) => row.action === 'stop');
    if (stop.length > 0) {
      return `${stop.length} 台设备建议立即停机检修，优先处理 ${stop[0].deviceId}（${stop[0].lineId}，预计影响 ${stop[0].impact} 件）。`;
    }
    const today = todo.filter((row) => row.action === 'today');
    if (today.length > 0) {
      return `${today.length} 台设备建议今日下班后处理，合计预计影响 ${totalImpact} 件，未到立即停机线。`;
    }
    return `当前 ${todo.length} 台设备的异常影响可控（合计 ${totalImpact} 件），继续观察即可。`;
  }, [dataReady, todo, totalImpact]);

  const scoreError = Object.keys(scoreMap).length === 0 && scoreItems.length === 0;

  // ---------- 折叠区（原模型区 + 真值区，内容原样保留） ----------
  const rows = anomaliesFull.data?.items ?? [];
  const gantt = useMemo(() => buildGantt(rows), [rows]);
  const ganttChart = useMemo(() => ganttOption(gantt.categories, gantt.tasks), [gantt]);
  const compare = useMemo(() => anomalyVsAlarm(rows, alarms.data?.items ?? []), [rows, alarms.data]);
  const compareChart = useMemo(
    () =>
      groupedBarOption(compare.categories, [
        { name: '异常真值条数', data: compare.truth, color: CHART_COLORS.primary },
        { name: '阈值告警条数', data: compare.alarm, color: CHART_COLORS.danger },
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

  const anomalyColumns: Column<AnomalyItem>[] = [
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

  // ---------- 待办表列 ----------
  const todoColumns: Column<TodoRow>[] = [
    {
      key: 'device',
      title: '设备',
      width: 130,
      render: (r) => (
        <div>
          <div className="mono-sm" data-todo-device={r.deviceId}>
            {r.deviceId}
          </div>
          <div className="report-sub">风险分 {r.riskScore.toFixed(1)}</div>
        </div>
      ),
    },
    { key: 'line', title: '产线', width: 92, render: (r) => <span className="mono-sm">{r.lineId}</span> },
    { key: 'symptom', title: '现象', render: (r) => <span data-todo-symptom={r.deviceId}>{r.symptom}</span> },
    {
      key: 'impact',
      title: '预计影响件数',
      width: 120,
      align: 'right',
      render: (r) => (
        <span
          className="report-impact"
          data-todo-impact={r.impact}
          data-todo-device-id={r.deviceId}
          data-todo-active-min={r.activeMinutes.toFixed(2)}
          data-todo-handling-min={r.handlingMinutes}
          data-todo-cycle={r.cycle.toFixed(4)}
          data-todo-slowdown={r.slowdown}
          data-todo-cycle-source={r.cycleSource}
        >
          {formatNumber(r.impact)}
        </span>
      ),
    },
    {
      key: 'action',
      title: '建议动作',
      width: 150,
      render: (r) => <span className={`report-badge report-badge--${ACTION_META[r.action].cls}`}>{ACTION_META[r.action].label}</span>,
    },
  ];

  const deliveryColumns: Column<DeliveryRow>[] = [
    { key: 'order', title: '订单', width: 150, render: (r) => <span className="mono-sm">{r.orderId}</span> },
    { key: 'line', title: '产线', width: 92, render: (r) => <span className="mono-sm">{r.lineId}</span> },
    { key: 'product', title: '产品', width: 110, render: (r) => <span className="mono-sm">{r.productId}</span> },
    {
      key: 'remaining',
      title: '剩余件',
      width: 80,
      align: 'right',
      render: (r) => <span data-delivery-remaining={r.orderId}>{formatNumber(r.remaining)}</span>,
    },
    {
      key: 'cycle',
      title: '当前节拍',
      width: 110,
      align: 'right',
      render: (r) => <span data-delivery-cycle={r.orderId}>{r.effectiveCycle.toFixed(3)} 件/分</span>,
    },
    {
      key: 'finish',
      title: '预计完成',
      width: 120,
      render: (r) => <span data-delivery-finish={r.orderId}>{formatTimeShort(new Date(r.finishAt).toISOString())}</span>,
    },
    { key: 'planned', title: '计划交付', width: 120, render: (r) => formatTimeShort(new Date(r.plannedEnd).toISOString()) },
    {
      key: 'delay',
      title: '延期',
      width: 90,
      align: 'right',
      render: (r) => <span className="report-late" data-delivery-delay={r.orderId}>{r.delayHours.toFixed(1)} h</span>,
    },
  ];

  return (
    <div className="page-stack report">
      {/* ---------------- 1. 结论条 ---------------- */}
      <section className="report-hero" data-report-block="conclusion">
        <div className="report-hero__main">
          <div className="report-hero__kicker">
            工厂日报 · {formatTimeShort(latest.data?.server_time ?? new Date().toISOString())} 更新
          </div>
          <h2 className="report-hero__advice" data-report-advice>
            {advice}
          </h2>
          <div className="report-hero__note">
            近 {windowMin ?? '—'} 分钟巡检窗口 · 系数为假设值（展开页底公式区可复算）· 数据为模拟器注入，非真实工厂
          </div>
        </div>
        <div className="report-hero__stats">
          <div className="report-stat">
            <div className="report-stat__value" data-report-stat="high-risk">
              {dataReady && highRisk != null ? formatNumber(highRisk) : '—'}
            </div>
            <div className="report-stat__label">高风险设备</div>
          </div>
          <div className="report-stat">
            <div className="report-stat__value" data-report-stat="impact">
              {dataReady ? formatNumber(totalImpact) : '—'}
            </div>
            <div className="report-stat__label">预计影响件数</div>
          </div>
          <div className="report-stat">
            <div className="report-stat__value" data-report-stat="deadline">
              {deadlineHours != null ? `≤ ${deadlineHours} h` : '—'}
            </div>
            <div className="report-stat__label">建议处理时限</div>
          </div>
        </div>
      </section>

      {/* ---------------- 2. 待办清单 ---------------- */}
      <section className="card" data-report-block="todo">
        <div className="card__title-row">
          <h3 className="card__title">今日待办</h3>
          <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
            按预计影响件数降序 · 最多 {TODO_LIMIT} 行
          </span>
        </div>
        {reportCfg.error ? (
          <ErrorState error={reportCfg.error} onRetry={reportCfg.refresh} />
        ) : windowAnoms.error ? (
          <ErrorState error={windowAnoms.error} onRetry={windowAnoms.refresh} />
        ) : (
          <DataTable
            columns={todoColumns}
            rows={todo}
            rowKey={(r) => r.deviceId}
            loading={(windowAnoms.loading && !windowAnoms.data) || (scoreLoading && scoreItems.length === 0)}
            empty={dataReady ? '当前窗口内没有需要动作的设备' : '数据不足，无法给出建议'}
          />
        )}
        <div className="card__footnote">
          「预计影响件数」= round((异常已持续分钟 + 该类型预计处置分钟) × 该线节拍 × 降速比例)，每行参数已写入
          DOM，可用页底公式复算。「现象」取该次异常区间内的峰值读数，不是此刻读数。
          {scoreError && dataReady ? ' 分数曲线暂不可用，待办为空不代表没有异常。' : ''}
        </div>
      </section>

      {/* ---------------- 3. 交付风险 ---------------- */}
      <section className="card" data-report-block="delivery">
        <div className="card__title-row">
          <h3 className="card__title">未来 {cfg?.delivery_horizon_hours ?? 8} 小时交付风险</h3>
          <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
            在制订单按当前节拍外推
          </span>
        </div>
        {orders.error ? (
          <ErrorState error={orders.error} onRetry={orders.refresh} />
        ) : (
          <DataTable
            columns={deliveryColumns}
            rows={deliveryRows}
            rowKey={(r) => r.orderId}
            loading={orders.loading && !orders.data}
            empty={dataReady ? '按当前节拍外推，未来 8 小时内没有会延期的在制订单' : '数据不足，无法给出建议'}
          />
        )}
        <div className="card__footnote">
          外推完成时间 = 现在 + 剩余件数 ÷ 当前节拍；当前节拍 = 计划节拍 × (1 − 该线最严重异常的降速比例)。只列延期且完成时间落在视界内的单。
        </div>
      </section>

      {/* ---------------- 4. 本月损失账 ---------------- */}
      <section className="card" data-report-block="loss">
        <div className="card__title-row">
          <h3 className="card__title">本月损失账</h3>
          <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
            {monthAnoms.data ? `本月 ${formatNumber(loss?.count ?? 0)} 次异常（已去重）` : '统计中…'}
          </span>
        </div>
        <div className="kpi-row" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
          <MetricCard
            label="异常次数"
            value={<span data-report-loss="count">{loss ? formatNumber(loss.count) : '—'}</span>}
            unit="次"
            delta="按设备 + 类型 + 开始时刻去重"
          />
          <MetricCard
            label="影响产量"
            value={<span data-report-loss="output">{loss ? formatNumber(loss.output) : '—'}</span>}
            unit="件"
            tone="warn"
            delta="真值区间时长 × 节拍 × 降速"
          />
          <MetricCard
            label="不良件数"
            value={<span data-report-loss="defects">{loss ? formatNumber(loss.defects) : '—'}</span>}
            unit="件"
            tone="warn"
            delta={`不良率 ${cfg ? formatPercent(cfg.defect_rate, 1) : '—'}（假设值）`}
          />
          <MetricCard
            label="折合金额"
            value={
              loss == null ? (
                '—'
              ) : loss.amount == null ? (
                <span data-report-loss="amount" data-report-price-missing="true" style={{ fontSize: 18 }}>
                  未配置单价
                </span>
              ) : (
                <span data-report-loss="amount">¥{formatNumber(loss.amount)}</span>
              )
            }
            delta={
              cfg && cfg.unit_price_cny > 0
                ? `单价 ¥${formatNumber(cfg.unit_price_cny)}/件（假设值）`
                : '单价未配置 → 不折算金额'
            }
          />
        </div>
      </section>

      {/* ---------------- 5. 模型详情（默认收起） ---------------- */}
      <details
        className="card report-fold"
        data-report-fold
        data-open={modelsOpen ? 'true' : 'false'}
        onToggle={(event) => setModelsOpen(event.currentTarget.open)}
      >
        <summary className="report-fold__summary">
          模型详情与真值对照（指标 / 混淆矩阵 / 模型对比 / 分数曲线）
          <span className="report-fold__hint">{modelsOpen ? '点击收起' : '点击展开'}</span>
        </summary>

        <div className="report-fold__body">
          {!modelsOpen ? null : modelInfo.error ? (
            <ErrorState error={modelInfo.error} onRetry={modelInfo.refresh} />
          ) : modelInfo.data && !loaded ? (
            <div className="model-degraded" data-ml-state="degraded">
              <div className="model-degraded__title">模型未加载，当前告警仍由阈值规则产生</div>
              <div className="model-degraded__reason" data-ml-degraded-reason>
                {modelInfo.data.degraded_reason}
              </div>
              <div className="model-degraded__hint">
                下方「异常真值」与「真值 vs 阈值告警」两块照常显示，不受模型状态影响。
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
                    <div className={`metric-card__value metric-card__value--${card.tone}`} data-ml-metric={card.key}>
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
                        <span data-ml-confusion="fp" style={{ color: CHART_COLORS.falsePositive }}>
                          FP {formatNumber(confusion.data.matrix[0][1])}
                        </span>
                        {' · '}
                        <span data-ml-confusion="fn" style={{ color: CHART_COLORS.falseNegative }}>
                          FN {formatNumber(confusion.data.matrix[1][0])}
                        </span>
                        {' · '}
                        <span data-ml-confusion="tp" style={{ color: CHART_COLORS.truePositive }}>
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
                    </>
                  ) : (
                    '曲线由 /ml/anomaly/scores 实时推理得到，不是缓存的旧结果。'
                  )
                }
              />

              {/* 真值对照（第 3 阶段原有，折叠区内保留） */}
              <div className="kpi-row kpi-row--3">
                <div className="metric-card">
                  <div className="metric-card__label">异常真值累计</div>
                  <div className="metric-card__value metric-card__value--normal">
                    {anomaliesFull.data ? formatNumber(anomaliesFull.data.total) : '—'}
                    <span className="metric-card__unit">条</span>
                  </div>
                  <div className="metric-card__delta">
                    图中展示最近 {Math.min(LIST_PAGE, rows.length)} 条（模拟器每 20 分钟注入一次）
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
                    {anomaliesFull.data && alarms.data
                      ? formatNumber(anomaliesFull.data.total - alarms.data.total)
                      : '—'}
                    <span className="metric-card__unit">条</span>
                  </div>
                  <div className="metric-card__delta">
                    说明阈值规则会漏（渐变未到阈值）也会误（尖峰超限但真值窗口已过）
                  </div>
                </div>
              </div>

              {anomaliesFull.error ? (
                <ErrorState error={anomaliesFull.error} onRetry={anomaliesFull.refresh} />
              ) : (
                <ChartCard
                  title="异常真值时间轴（按设备分行）"
                  option={ganttChart}
                  height={Math.max(240, gantt.categories.length * 22 + 48)}
                  loading={anomaliesFull.loading && !anomaliesFull.data}
                  empty={rows.length === 0}
                  emptyText="还没有异常真值记录"
                  extra={legend}
                  footnote="每根条是一次注入的起止区间；这是真值，不是检测结果。"
                />
              )}

              <ChartCard
                title="真值条数 vs 阈值告警条数（按类型）"
                option={compareChart}
                height={240}
                loading={anomaliesFull.loading && !anomaliesFull.data}
                empty={rows.length === 0}
                emptyText="暂无数据"
                footnote="两类数字天然不等：阈值规则只看瞬时值，真值是注入器写下的标准答案。"
              />

              <div className="card">
                <div className="card__title-row">
                  <h3 className="card__title">异常真值列表</h3>
                  <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
                    共 {formatNumber(anomaliesFull.data?.total ?? 0)} 条
                  </span>
                </div>
                <DataTable
                  columns={anomalyColumns}
                  rows={rows}
                  rowKey={(r) => r.id}
                  loading={anomaliesFull.loading && !anomaliesFull.data}
                  empty="暂无异常真值"
                />
                <div className="card__footnote">
                  参数列为注入器写入的原始参数（如 start_from / slope_per_tick），用来复现该次异常。
                </div>
              </div>
            </>
          )}
        </div>
      </details>

      {/* ---------------- 6. 公式与来源（页底，默认折叠，D-81） ---------------- */}
      <details
        className="card report-fold report-formula"
        data-report-formula
        data-open={formulaOpen ? 'true' : 'false'}
        onToggle={(event) => setFormulaOpen(event.currentTarget.open)}
      >
        <summary className="report-fold__summary">
          公式与数据来源
          {/* 收起状态下也必须能读到「假设值」——这是页面的合规声明，
              不能因为折叠就消失（§19.2 要求系数性质随时可见） */}
          <span className="report-fold__hint">
            {formulaOpen ? '点击收起' : '系数均为假设值 · 点击展开复算'}
          </span>
        </summary>
        <div className="report-fold__body">
        <ol className="report-formula__list">
          <li>
            <b>节拍</b> = 该线最新订单的 planned_quantity ÷ (planned_end − planned_start)，取不到时用{' '}
            <code>/report/config → lines[line].cycle_per_minute</code>。
            <span className="report-src">来源：/orders（planned_quantity / planned_start / planned_end）</span>
          </li>
          <li>
            <b>风险分</b> = 最后一段连续异常的峰值分数 × 该段持续分钟数。
            <span className="report-src">来源：/ml/anomaly/scores → points[].score / points[].is_anomaly</span>
          </li>
          <li>
            <b>异常持续分钟</b> = (真值区间 ended_at − started_at) ÷ 60；没有真值区间时退回最后一段连续异常点。
            <span className="report-src">来源：/ml/anomaly/scores → intervals（按区间内 points 取峰值，区间内无模型点则不采用）</span>
          </li>
          <li>
            <b>预计影响件数</b> = round((异常持续分钟 + 处置分钟) × 节拍 × 降速比例)。
            <span className="report-src">处置分钟 / 降速比例：/report/config → anomaly_handling[type]</span>
          </li>
          <li>
            <b>建议动作</b>：影响 &gt; {cfg?.action_thresholds.stop ?? 15} 件 → 立即停机检修；
            {cfg?.action_thresholds.today ?? 5} ~ {cfg?.action_thresholds.stop ?? 15} 件 → 今日下班后处理；
            &lt; {cfg?.action_thresholds.today ?? 5} 件 → 继续观察。
            <span className="report-src">来源：/report/config → action_thresholds</span>
          </li>
          <li>
            <b>外推完成时间</b> = 现在 + (planned_quantity − actual_quantity) ÷ 当前节拍；当前节拍 = 计划节拍 × (1 −
            该线最严重异常的降速比例)。
            <span className="report-src">来源：/orders、/report/config</span>
          </li>
          <li>
            <b>本月影响产量</b> = Σ 每条异常区间分钟 × 节拍 × 降速比例；不良件数 = 影响产量 × 不良率。
            <span className="report-src">来源：/anomalies（started_at / ended_at，按设备+类型+开始时刻去重）</span>
          </li>
          <li>
            <b>折合金额</b> = 不良件数 × 单价；单价未配置（≤0）时显示「未配置单价」，不折算。
            <span className="report-src">来源：/report/config → unit_price_cny</span>
          </li>
        </ol>
        <div className="report-assumptions">
          <span>本页系数（全部假设值，非实测成本）：</span>
          {cfg ? (
            <span className="mono-sm">
              单价 {cfg.unit_price_cny > 0 ? `¥${formatNumber(cfg.unit_price_cny)}/件` : '未配置'} · 不良率{' '}
              {formatPercent(cfg.defect_rate, 1)} · 高风险线 风险分 ≥{' '}
              {cfg.risk_score_high} · 节拍{' '}
              {Object.entries(cfg.lines)
                .map(([line, v]) => `${line} ${v.cycle_per_minute}`)
                .join(' / ')}{' '}
              件/分 · 处置{' '}
              {Object.entries(cfg.anomaly_handling)
                .map(([, v]) => `${v.label} ${v.handling_minutes}min/降速 ${Math.round(v.slowdown * 100)}%`)
                .join(' · ')}
            </span>
          ) : (
            <span className="mono-sm">配置加载中…</span>
          )}
        </div>
        <div className="card__footnote">
          配置文件：{cfg?.source.file ?? 'config/report.json'}（{cfg?.source.kind === 'assumption' ? '假设值' : '—'}）。
          三维场景与遥测数据由模拟器生成，仅用于演示，不代表真实工厂。
        </div>
        </div>
      </details>

      {windowAnoms.data && windowAnoms.data.items.length === 0 ? (
        <EmptyState title="数据不足，无法给出建议" hint="巡检窗口内没有异常记录，待办与结论不会凭空生成。" />
      ) : null}
    </div>
  );
}
