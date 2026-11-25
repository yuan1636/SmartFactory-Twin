/**
 * 页面一：纯三维展示页（作者 2026-11-25 指定）。
 *
 * 「打开主页，眼前只有一座工厂，没有一张卡片、没有一个列表」：
 *  - 原 overview__kpis（4 张 MetricCard）与设备列表面板整体删除；
 *  - 画布铺满内容区（高度 = 视口减顶栏，抵消 .content 内边距）；
 *  - 右上角只留一行无背景的状态文字（取自 WS 快照 summary）；
 *  - 唯一允许的浮层是按需出现的设备详情卡：三维点击设备 → 详情卡 → 「查看监控页」。
 *    旧版由列表行点击触发，列表删除后由 SceneRoot 的 onSelectDevice（三维拾取）触发。
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePolling } from '../hooks/usePolling';
import { useStore } from '../hooks/useTelemetry';
import { apiGet } from '../services/api';
import { formatMetric, stalenessText } from '../services/format';
import { setCatalog } from '../services/store';
import type { DeviceListItem, Page } from '../services/types';
import SceneRoot, { type SceneHandle } from '../three/SceneRoot';
import { PRESET_ORDER, type PresetKey } from '../three/cameraPresets';
import { STATE_META } from '../utils/status';

const PRESET_LABEL: Record<PresetKey, string> = {
  overview: '总览',
  WALK: '车间行走',
  AISLE: '走廊纵深',
  'WS-A': 'WS-A',
  'WS-B': 'WS-B',
  'LINE-A1': 'LINE-A1',
  DEVICE: '设备特写',
};

export default function Overview() {
  const navigate = useNavigate();
  const snapshot = useStore();
  const sceneRef = useRef<SceneHandle>(null);
  const [focused, setFocused] = useState<string | null>(null);

  // 设备台账 10 秒一次：详情卡上的设备名靠它补全（/devices/latest 兜底时没有设备名）
  const catalog = usePolling<Page<DeviceListItem>>(
    () => apiGet<Page<DeviceListItem>>('/devices', { page: 1, page_size: 50 }),
    10_000,
  );
  useEffect(() => {
    if (catalog.data) setCatalog(catalog.data.items);
  }, [catalog.data]);

  const summary = snapshot.summary;
  const hasData = snapshot.hasData;
  const stale = stalenessText(snapshot.devices[0]?.ts);
  // D3（偏差 D-55）：三维点中的设备详情卡数据源（实时快照，未连上时各值为 —）
  const focusedDevice = focused
    ? snapshot.devices.find((d) => d.device_id === focused) ?? null
    : null;

  // 右上角极简状态行（无背景框）：正常 = summary 三项；停更 = stalenessText 的「数据已停更 N 秒」
  const statusLine = !hasData
    ? '等待实时数据'
    : stale ?? `运行 ${summary.running}/14 · 告警 ${summary.alarm} · 异常 ${snapshot.inAnomaly}`;

  const onPreset = (key: PresetKey) => {
    sceneRef.current?.setPreset(key);
  };

  return (
    <div className="overview overview--stage">
      <SceneRoot
        ref={sceneRef}
        selectedDeviceId={focused}
        // D3（偏差 D-55）：三维点击 = 选中 + 弹详情卡 + 推近，跳转入口在详情卡按钮
        onSelectDevice={(id) => {
          setFocused(id);
        }}
      />

      <div className="viewport__overlay-top">
        <span className="stage-status" data-testid="stage-status">
          {statusLine}
        </span>
        <div className="viewport__preset-row">
          {PRESET_ORDER.map((key) => (
            <button key={key} type="button" className="btn btn--ghost" onClick={() => onPreset(key)}>
              {PRESET_LABEL[key]}
            </button>
          ))}
          <button type="button" className="btn btn--ghost" onClick={() => sceneRef.current?.toggleTour()}>
            巡游
          </button>
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

      {focusedDevice ? (
        <div className="device-detail device-detail--float" data-testid="device-detail">
          <div className="device-detail__head">
            <span
              className="status-dot"
              style={{ background: STATE_META[focusedDevice.state].hex }}
              title={STATE_META[focusedDevice.state].label}
            />
            <span className="device-detail__title" data-testid="device-detail-title">
              {focusedDevice.device_id}
            </span>
            <span className="device-detail__name">{focusedDevice.device_name}</span>
            <button
              type="button"
              className="btn btn--ghost device-detail__close"
              aria-label="关闭详情"
              onClick={() => setFocused(null)}
            >
              ×
            </button>
          </div>
          <div className="device-detail__metrics">
            <span>温度 {formatMetric('temperature', focusedDevice.metrics.temperature)}</span>
            <span>振动 {formatMetric('vibration', focusedDevice.metrics.vibration)}</span>
            <span>电流 {formatMetric('current', focusedDevice.metrics.current)}</span>
            <span>转速 {focusedDevice.metrics.speed === 0 ? '—' : formatMetric('speed', focusedDevice.metrics.speed)}</span>
          </div>
          <div className="device-detail__foot">
            <span className="muted">
              {focusedDevice.open_alarm_count > 0 ? `未解除告警 ${focusedDevice.open_alarm_count} 条` : '当前无告警'}
            </span>
            <button type="button" className="btn btn--ghost" onClick={() => navigate(`/devices/${focusedDevice.device_id}`)}>
              查看监控页
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
