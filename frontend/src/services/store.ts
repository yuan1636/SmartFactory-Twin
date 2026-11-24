/**
 * 模块级状态存储 + useSyncExternalStore（规格 7.4）。
 * 不引状态库：本项目只有一份实时快照，且三维场景需要绕过 React 直接更新。
 * 关键点：seq 未变时不触发订阅，否则每秒 14 个组件重渲染。
 */

import { effectiveState, type EffectiveState } from '../utils/status';
import type {
  DeviceListItem,
  DeviceStatus,
  LatestResponse,
  Metrics,
  RunningStatus,
  Snapshot,
  SnapshotSummary,
} from './types';

export type WsStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface DeviceView {
  device_id: string;
  device_name: string;
  device_type: string;
  workshop_id: string | null;
  line_id: string | null;
  status: DeviceStatus;
  running_status: RunningStatus | null;
  ts: string | null;
  /** 来自 /devices/latest 时可能只有部分指标 */
  metrics: Partial<Metrics>;
  open_alarm_count: number;
  in_anomaly: boolean;
  state: EffectiveState;
}

export interface StoreSnapshot {
  seq: number;
  serverTime: string | null;
  devices: DeviceView[];
  byId: Record<string, DeviceView>;
  summary: SnapshotSummary;
  /** 前端统计：in_anomaly 为 true 的设备数（WS 快照里有，summary 里没有） */
  inAnomaly: number;
  wsStatus: WsStatus;
  wsAttempt: number;
  /** 是否拿到过实时/兜底数据，用于区分「还没数据」与「有数据但停了」 */
  hasData: boolean;
  /** /devices 台账缓存：/devices/latest 没有设备名，靠它补全 */
  catalog: Record<string, DeviceListItem>;
}

const EMPTY_SUMMARY: SnapshotSummary = {
  running: 0,
  idle: 0,
  stopped: 0,
  alarm: 0,
  maintenance: 0,
  open_alarm_count: 0,
};

const EMPTY: StoreSnapshot = {
  seq: 0,
  serverTime: null,
  devices: [],
  byId: {},
  summary: EMPTY_SUMMARY,
  inAnomaly: 0,
  wsStatus: 'connecting',
  wsAttempt: 0,
  hasData: false,
  catalog: {},
};

let current: StoreSnapshot = EMPTY;
const listeners = new Set<() => void>();

function emit(next: StoreSnapshot) {
  current = next;
  for (const cb of listeners) cb();
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getSnapshot(): StoreSnapshot {
  return current;
}

export function getDevice(id: string): DeviceView | undefined {
  return current.byId[id];
}

function toViews(snapshot: Snapshot): DeviceView[] {
  return snapshot.devices
    .map<DeviceView>((d) => ({
      device_id: d.device_id,
      device_name: d.device_name,
      device_type: d.device_type,
      workshop_id: d.workshop_id,
      line_id: d.line_id,
      status: d.status,
      running_status: d.running_status,
      ts: d.ts,
      metrics: d.metrics,
      open_alarm_count: d.open_alarm_count,
      in_anomaly: d.in_anomaly,
      state: effectiveState(d.status, d.running_status),
    }))
    .sort((a, b) => a.device_id.localeCompare(b.device_id));
}

export function setSnapshot(snapshot: Snapshot): void {
  if (snapshot.seq === current.seq && current.hasData) return;

  const devices = toViews(snapshot);
  const byId: Record<string, DeviceView> = {};
  let inAnomaly = 0;
  for (const d of devices) {
    byId[d.device_id] = d;
    if (d.in_anomaly) inAnomaly += 1;
  }

  emit({
    ...current,
    seq: snapshot.seq,
    serverTime: snapshot.server_time,
    devices,
    byId,
    summary: snapshot.summary ?? EMPTY_SUMMARY,
    inAnomaly,
    hasData: true,
  });
}

/** WS 重连兜底：/devices/latest 只有最新一条与状态，没有 device_name（靠 catalog 补）。 */
export function applyLatest(latest: LatestResponse, catalog: Record<string, DeviceListItem> = {}): void {
  const known = { ...current.catalog, ...catalog };
  const devices: DeviceView[] = latest.items
    .map<DeviceView>((item) => {
      const meta = known[item.device_id];
      const metrics: Partial<Metrics> = {};
      if (item.temperature !== null) metrics.temperature = item.temperature;
      if (item.vibration !== null) metrics.vibration = item.vibration;
      if (item.current !== null) metrics.current = item.current;
      if (item.speed !== null) metrics.speed = item.speed;
      return {
        device_id: item.device_id,
        device_name: meta?.device_name ?? item.device_id,
        device_type: meta?.device_type ?? '',
        workshop_id: meta?.workshop_id ?? null,
        line_id: meta?.line_id ?? null,
        status: item.status,
        running_status: item.running_status,
        ts: item.ts,
        metrics,
        open_alarm_count: item.open_alarm_count,
        in_anomaly: false,
        state: effectiveState(item.status, item.running_status),
      };
    })
    .sort((a, b) => a.device_id.localeCompare(b.device_id));

  const byId: Record<string, DeviceView> = {};
  const summary: SnapshotSummary = { ...EMPTY_SUMMARY };
  for (const d of devices) {
    byId[d.device_id] = d;
    if (d.status === 'ALARM') summary.alarm += 1;
    else if (d.status === 'MAINTENANCE') summary.maintenance += 1;
    else if (d.running_status === 'IDLE') summary.idle += 1;
    else if (d.running_status === 'STOPPED') summary.stopped += 1;
    else summary.running += 1;
    summary.open_alarm_count += d.open_alarm_count;
  }

  emit({
    ...current,
    serverTime: latest.server_time,
    devices,
    byId,
    summary,
    inAnomaly: 0,
    hasData: devices.length > 0,
  });
}

/** 设备台账（名称/类型/所属），来自 /devices 轮询。只补静态字段，不动实时值。 */
export function setCatalog(items: DeviceListItem[]): void {
  if (items.length === 0) return;
  let changed = false;
  const catalog = { ...current.catalog };
  const byId = { ...current.byId };
  for (const item of items) {
    catalog[item.device_id] = item;
    const existed = byId[item.device_id];
    if (!existed) continue; // 设备清单以实时快照为准，台账只做补全
    if (
      existed.device_name !== item.device_name ||
      existed.device_type !== item.device_type ||
      existed.workshop_id !== item.workshop_id ||
      existed.line_id !== item.line_id
    ) {
      byId[item.device_id] = {
        ...existed,
        device_name: item.device_name,
        device_type: item.device_type,
        workshop_id: item.workshop_id,
        line_id: item.line_id,
      };
      changed = true;
    }
  }
  if (!changed) {
    emit({ ...current, catalog });
    return;
  }
  const devices = Object.values(byId).sort((a, b) => a.device_id.localeCompare(b.device_id));
  emit({ ...current, byId, devices, catalog });
}

export function setWsStatus(status: WsStatus, attempt = 0): void {
  if (current.wsStatus === status && current.wsAttempt === attempt) return;
  emit({ ...current, wsStatus: status, wsAttempt: attempt });
}

/** 仅测试用：把 store 复位成初始态，避免用例之间互相污染。 */
export function resetStoreForTest(): void {
  current = EMPTY;
  listeners.clear();
}
