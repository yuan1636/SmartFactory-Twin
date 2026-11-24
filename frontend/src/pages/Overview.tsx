/** 页面一：工厂数字孪生总览（规格 5.2）。 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { MetricCard } from '../components/MetricCard';
import { ErrorState } from '../components/ErrorState';
import { usePolling } from '../hooks/usePolling';
import { useStore } from '../hooks/useTelemetry';
import { apiGet } from '../services/api';
import { formatMetric, formatNumber, stalenessText } from '../services/format';
import { setCatalog } from '../services/store';
import type { DeviceListItem, Page, WorkshopItem } from '../services/types';
import SceneRoot, { type SceneHandle } from '../three/SceneRoot';
import { CAMERA_PRESETS, type PresetKey } from '../three/cameraPresets';
import { STATE_META, STATE_PRIORITY } from '../utils/status';
import type { EffectiveState } from '../utils/status';

type Filter = 'all' | 'WS-A' | 'WS-B' | 'AUX';

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'WS-A', label: 'WS-A' },
  { key: 'WS-B', label: 'WS-B' },
  { key: 'AUX', label: '动力站' },
];

export default function Overview() {
  const snapshot = useStore();
  const sceneRef = useRef<SceneHandle>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [focused, setFocused] = useState<string | null>(null);

  const workshops = usePolling<{ items: WorkshopItem[] }>(
    () => apiGet<{ items: WorkshopItem[] }>('/workshops'),
    60_000,
  );

  // 设备台账 10 秒一次：/devices/latest 兜底时没有设备名，靠它补全（否则列表只剩编号）
  const catalog = usePolling<Page<DeviceListItem>>(
    () => apiGet<Page<DeviceListItem>>('/devices', { page: 1, page_size: 50 }),
    10_000,
  );

  useEffect(() => {
    if (catalog.data) setCatalog(catalog.data.items);
  }, [catalog.data]);

  const devices = useMemo(() => {
    if (filter === 'all') return snapshot.devices;
    if (filter === 'AUX') return snapshot.devices.filter((d) => d.workshop_id === null);
    return snapshot.devices.filter((d) => d.workshop_id === filter);
  }, [snapshot.devices, filter]);

  const summary = snapshot.summary;
  const stale = stalenessText(snapshot.devices[0]?.ts);
  const hasData = snapshot.hasData;

  const workshopName = (id: string) =>
    workshops.data?.items.find((w) => w.id === id)?.name ?? id;

  const onPickDevice = (id: string) => {
    setFocused(id);
    sceneRef.current?.focusDevice(id);
  };

  const onPreset = (key: PresetKey) => {
    sceneRef.current?.setPreset(key);
  };

  const alarmTone = summary.alarm > 0 ? 'crit' : 'normal';

  return (
    <div className="overview" style={{ minHeight: 600 }}>
      <div className="overview__kpis">
        <div className="kpi-row">
          <MetricCard
            label="运行中设备"
            value={hasData ? formatNumber(summary.running) : '—'}
            unit={hasData ? '/ 14 台' : undefined}
            delta={hasData ? '遥测级 RUNNING + 设备级 RUNNING' : '等待实时数据'}
          />
          <MetricCard
            label="告警设备"
            value={hasData ? formatNumber(summary.alarm) : '—'}
            unit={hasData ? '台' : undefined}
            tone={alarmTone}
            delta={summary.alarm > 0 ? '存在未解除告警' : '当前无告警设备'}
          />
          <MetricCard
            label="异常中设备"
            value={hasData ? formatNumber(snapshot.inAnomaly) : '—'}
            unit={hasData ? '台' : undefined}
            delta="模拟器注入的异常真值，非模型预测"
          />
          <MetricCard
            label="未解除告警"
            value={hasData ? formatNumber(summary.open_alarm_count) : '—'}
            unit={hasData ? '条' : undefined}
            tone={summary.open_alarm_count > 0 ? 'warn' : 'normal'}
            delta={stale ?? '统计自 WS 快照'}
          />
        </div>
      </div>

      <div className="overview__viewport">
        <div className="card" style={{ padding: 0, overflow: 'hidden', flex: 1, minHeight: 0 }}>
          <div style={{ position: 'relative', height: '100%' }}>
            <SceneRoot
              ref={sceneRef}
              selectedDeviceId={focused}
              onSelectDevice={(id) => setFocused(id)}
            />
            <div className="viewport__overlay-top">
              {(Object.keys(CAMERA_PRESETS) as PresetKey[]).map((key) => (
                <button key={key} type="button" className="btn btn--ghost" onClick={() => onPreset(key)}>
                  {key === 'overview' ? '总览' : key}
                </button>
              ))}
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  setFocused(null);
                  onPreset('overview');
                }}
              >
                重置视角
              </button>
            </div>
          </div>
        </div>
        <div className="card" style={{ padding: '4px 12px' }}>
          <Legend />
        </div>
      </div>

      <aside className="overview__side">
        <div className="device-list__head">
          <span className="secondary" style={{ fontSize: 13 }}>
            设备列表
          </span>
          <span className="muted" style={{ fontSize: 12 }}>
            {devices.length} 台
          </span>
          <div style={{ marginLeft: 'auto' }}>
            <select
              className="select"
              value={filter}
              onChange={(e) => setFilter(e.target.value as Filter)}
              aria-label="按车间筛选"
            >
              {FILTERS.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.key === 'all' ? f.label : f.key === 'AUX' ? f.label : workshopName(f.key)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="device-list">
          {!hasData && workshops.error ? (
            <ErrorState error={workshops.error} onRetry={workshops.refresh} />
          ) : !hasData ? (
            <div className="state-block">
              <div className="state-block__title">等待实时数据</div>
              <div className="state-block__hint">
                后端 WebSocket 尚未推送快照。确认 uvicorn 与模拟器都在运行。
              </div>
            </div>
          ) : devices.length === 0 ? (
            <div className="state-block">
              <div className="state-block__title">该车间没有设备</div>
            </div>
          ) : (
            devices.map((d) => {
              const meta = STATE_META[d.state];
              return (
                <div
                  key={d.device_id}
                  className={`device-list__row${focused === d.device_id ? ' is-active' : ''}`}
                  onClick={() => onPickDevice(d.device_id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onPickDevice(d.device_id);
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <span className="status-dot" style={{ background: meta.hex }} title={meta.label} />
                  <span className="device-list__id">{d.device_id}</span>
                  <span className="device-list__name">{d.device_name}</span>
                  <span className="device-list__temp">
                    {d.metrics.temperature === undefined
                      ? '—'
                      : formatMetric('temperature', d.metrics.temperature)}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </aside>
    </div>
  );
}

function Legend() {
  return (
    <div className="legend">
      <span className="muted">状态图例</span>
      {STATE_PRIORITY.map((state: EffectiveState) => (
        <span key={state} className="legend__item">
          <span className="legend__swatch" style={{ background: STATE_META[state].hex }} />
          {STATE_META[state].label}
        </span>
      ))}
      <span className="muted" style={{ marginLeft: 'auto' }}>
        优先级：告警 &gt; 维护中 &gt; 停机 &gt; 待机 &gt; 运行中
      </span>
    </div>
  );
}
