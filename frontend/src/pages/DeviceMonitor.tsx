/** 页面二：设备监控中心（规格 5.3）。 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChartCard } from '../components/ChartCard';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { LoadingBlock } from '../components/LoadingBlock';
import { RangePicker } from '../components/RangePicker';
import { StatusBadge } from '../components/StatusBadge';
import { lineOption, thresholdsFromRange, THRESHOLD_METRICS } from '../charts/options';
import { useDeviceTelemetry, RANGE_HOURS, type RangeKey } from '../hooks/useDeviceTelemetry';
import { usePolling } from '../hooks/usePolling';
import { useStore } from '../hooks/useTelemetry';
import { apiGet } from '../services/api';
import {
  formatMetric,
  formatNumber,
  formatTime,
  METRIC_KEYS,
  METRIC_META,
  stalenessText,
} from '../services/format';
import type { DeviceDetail, DeviceListItem, Page, TelemetryPoint } from '../services/types';
import { STATE_META, effectiveState } from '../utils/status';

const EMPTY_POINTS: TelemetryPoint[] = [];

export default function DeviceMonitor() {
  const { deviceId } = useParams<{ deviceId: string }>();
  const navigate = useNavigate();
  const [range, setRange] = useState<RangeKey>('1h');
  const [keyword, setKeyword] = useState('');
  const [workshop, setWorkshop] = useState('');

  const snapshot = useStore();

  const list = usePolling<Page<DeviceListItem>>(
    () =>
      apiGet<Page<DeviceListItem>>('/devices', {
        page: 1,
        page_size: 50,
        workshop_id: workshop || undefined,
      }),
    10_000,
    { key: workshop },
  );

  // 进入 /devices 没带 deviceId 时默认选中第一个，并把地址改成可分享的 /devices/CNC-01
  useEffect(() => {
    if (deviceId || !list.data || list.data.items.length === 0) return;
    navigate(`/devices/${list.data.items[0].device_id}`, { replace: true });
  }, [deviceId, list.data, navigate]);

  const detail = usePolling<DeviceDetail>(
    () => apiGet<DeviceDetail>(`/devices/${deviceId}`),
    30_000,
    { enabled: Boolean(deviceId), key: deviceId ?? '' },
  );

  const telemetry = useDeviceTelemetry(deviceId, range);
  const live = deviceId ? snapshot.byId[deviceId] : undefined;

  const filtered = useMemo(() => {
    const items = list.data?.items ?? [];
    const kw = keyword.trim();
    if (!kw) return items;
    const upper = kw.toUpperCase();
    return items.filter((d) => d.device_id.toUpperCase().includes(upper) || d.device_name.includes(kw));
  }, [list.data, keyword]);

  const points = telemetry.data?.points ?? EMPTY_POINTS;

  // option 必须 memo：否则每次 WS 快照触发的重渲染都会 setOption 一次
  const chartOptions = useMemo(
    () =>
      METRIC_KEYS.map((key) =>
        lineOption({
          metric: key,
          points,
          // 只有配了阈值的三项画参考线；转速没有阈值，别画出「图上有的线」
          thresholds: THRESHOLD_METRICS.includes(key)
            ? thresholdsFromRange(detail.data?.metrics_normal_range[key])
            : { warning: null, critical: null },
        }),
      ),
    [points, detail.data],
  );

  const state = live
    ? live.state
    : detail.data
      ? effectiveState(detail.data.status, null)
      : null;

  const stale = stalenessText(live?.ts ?? detail.data?.latest_ts);

  return (
    <div className="devices-page">
      <aside className="devices-page__side">
        <div
          style={{
            padding: 12,
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <input
            className="input"
            placeholder="搜索设备编号 / 名称"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <select className="select" value={workshop} onChange={(e) => setWorkshop(e.target.value)}>
            <option value="">全部车间</option>
            <option value="WS-A">WS-A 机加工</option>
            <option value="WS-B">WS-B 检测与装配</option>
          </select>
        </div>
        <div className="device-list">
          {list.loading && !list.data ? (
            <div style={{ padding: 12 }}>
              <LoadingBlock rows={6} />
            </div>
          ) : list.error ? (
            <ErrorState error={list.error} onRetry={list.refresh} />
          ) : filtered.length === 0 ? (
            <EmptyState title="没有匹配的设备" />
          ) : (
            filtered.map((d) => {
              const active = d.device_id === deviceId;
              const rowView = snapshot.byId[d.device_id];
              return (
                <div
                  key={d.device_id}
                  className={`device-list__row${active ? ' is-active' : ''}`}
                  onClick={() => navigate(`/devices/${d.device_id}`)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') navigate(`/devices/${d.device_id}`);
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <span
                    className="status-dot"
                    style={{
                      background: rowView ? STATE_META[rowView.state].hex : 'var(--st-stopped)',
                    }}
                  />
                  <span className="device-list__id">{d.device_id}</span>
                  <span className="device-list__name">{d.device_name}</span>
                  {d.open_alarm_count > 0 ? (
                    <span className="device-list__temp" style={{ color: 'var(--st-alarm)' }}>
                      {d.open_alarm_count}
                    </span>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </aside>

      <div className="devices-page__main">
        {!deviceId ? (
          <EmptyState title="请选择设备" hint="左侧列表点击任意设备，或直接访问 /devices/CNC-01" />
        ) : detail.error ? (
          <div className="card">
            <ErrorState error={detail.error} onRetry={detail.refresh} />
          </div>
        ) : !detail.data ? (
          <div className="card">
            <LoadingBlock rows={5} />
          </div>
        ) : (
          <>
            <div className="card">
              <div className="card__title-row">
                <h3 className="card__title">
                  {detail.data.device_name}
                  <span className="muted" style={{ marginLeft: 8, fontWeight: 400, fontSize: 13 }}>
                    {detail.data.device_id}
                  </span>
                </h3>
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
                  {stale ? <span className="warn-text">{stale}</span> : null}
                  {state ? <StatusBadge state={state} /> : <StatusBadge state="STOPPED" unknown />}
                </div>
              </div>
              <div className="device-detail">
                <div className="device-detail__item">
                  型号
                  <div className="device-detail__value">{detail.data.model}</div>
                </div>
                <div className="device-detail__item">
                  类型
                  <div className="device-detail__value">{detail.data.device_type}</div>
                </div>
                <div className="device-detail__item">
                  车间 / 产线
                  <div className="device-detail__value">
                    {detail.data.workshop_id ?? '动力站'} / {detail.data.line_id ?? '—'}
                  </div>
                </div>
                <div className="device-detail__item">
                  未解除告警
                  <div
                    className="device-detail__value"
                    style={{ color: detail.data.open_alarm_count > 0 ? 'var(--st-alarm)' : undefined }}
                  >
                    {detail.data.open_alarm_count} 条
                  </div>
                </div>
                {METRIC_KEYS.map((key) => {
                  const baseRange = detail.data?.metrics_normal_range[key];
                  const current = live?.metrics[key];
                  return (
                    <div className="device-detail__item" key={key}>
                      {METRIC_META[key].label}（{METRIC_META[key].unit}）
                      <div className="device-detail__value">
                        {current === undefined ? '—' : formatMetric(key, current)}
                        <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>
                          正常 {baseRange ? `${baseRange.min} ~ ${baseRange.max}` : '—'}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div
              className="card"
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px' }}
            >
              <span className="secondary" style={{ fontSize: 13 }}>
                时间范围
              </span>
              <RangePicker value={range} onChange={setRange} />
              <span className="muted" style={{ fontSize: 12 }}>
                最近 {RANGE_HOURS[range]} 小时 · 原始采样 2 秒 1 点
              </span>
              {telemetry.data && (telemetry.data.downsample_step > 1 || telemetry.data.truncated) ? (
                <span className="range-info" style={{ marginLeft: 'auto' }}>
                  当前为抽样展示：每 {telemetry.data.downsample_step} 个点取 1 个，共{' '}
                  {formatNumber(telemetry.data.count)} 点
                </span>
              ) : null}
            </div>

            {telemetry.error ? (
              <div className="card">
                <ErrorState error={telemetry.error} onRetry={telemetry.refresh} />
              </div>
            ) : (
              <div className="chart-grid">
                {METRIC_KEYS.map((key, index) => (
                  <ChartCard
                    key={key}
                    title={`${METRIC_META[key].label}（${METRIC_META[key].unit}）`}
                    height={230}
                    loading={telemetry.loading && !telemetry.data}
                    empty={points.length === 0}
                    emptyText={`最近 ${RANGE_HOURS[range]} 小时没有该指标的采样点`}
                    option={chartOptions[index]}
                    footnote={
                      key === 'speed'
                        ? '转速不设告警阈值（后端未对转速配置阈值），因此没有参考线。'
                        : '参考线按正常上限推算：WARNING ×1.1、CRITICAL ×1.25（与后端阈值同规则）'
                    }
                  />
                ))}
              </div>
            )}

            <div className="muted" style={{ fontSize: 12 }}>
              数据窗口：
              {telemetry.data
                ? `${formatTime(telemetry.data.start)} ~ ${formatTime(telemetry.data.end)}`
                : '—'}
              ，共 {telemetry.data ? formatNumber(telemetry.data.count) : 0} 点；每 60 秒自动刷新。
            </div>
          </>
        )}
      </div>
    </div>
  );
}
