/** 后端 DTO（字段名以 2026-11-24 实机响应为准，docs/spec_phase3.md 第 7 节）。 */

export type DeviceStatus = 'RUNNING' | 'ALARM' | 'MAINTENANCE';
export type RunningStatus = 'RUNNING' | 'IDLE' | 'STOPPED';
export type MetricKey = 'temperature' | 'vibration' | 'current' | 'speed';

export interface Metrics {
  temperature: number;
  vibration: number;
  current: number;
  speed: number;
}

export interface SnapshotDevice {
  device_id: string;
  device_name: string;
  device_type: string;
  workshop_id: string | null;
  line_id: string | null;
  status: DeviceStatus;
  open_alarm_count: number;
  ts: string;
  metrics: Metrics;
  running_status: RunningStatus;
  in_anomaly: boolean;
}

export interface SnapshotSummary {
  running: number;
  idle: number;
  stopped: number;
  alarm: number;
  maintenance: number;
  open_alarm_count: number;
}

export interface Snapshot {
  type: 'snapshot';
  server_time: string;
  seq: number;
  device_count: number;
  summary: SnapshotSummary;
  devices: SnapshotDevice[];
}

export interface LatestItem {
  device_id: string;
  status: DeviceStatus;
  open_alarm_count: number;
  ts: string | null;
  running_status: RunningStatus | null;
  temperature: number | null;
  vibration: number | null;
  current: number | null;
  speed: number | null;
}

export interface LatestResponse {
  server_time: string;
  items: LatestItem[];
}

export interface DeviceListItem {
  device_id: string;
  device_name: string;
  device_type: string;
  workshop_id: string | null;
  line_id: string | null;
  model: string;
  status: DeviceStatus;
  installed_at: string;
  open_alarm_count: number;
  latest_ts: string | null;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface MetricRange {
  min: number;
  max: number;
  unit: string;
}

export interface DeviceDetail extends DeviceListItem {
  metrics_normal_range: Partial<Record<MetricKey, MetricRange>>;
}

export interface TelemetryPoint {
  ts: string;
  running_status: RunningStatus;
  temperature: number | null;
  vibration: number | null;
  current: number | null;
  speed: number | null;
}

export interface TelemetryResponse {
  device_id: string;
  start: string;
  end: string;
  interval_seconds: number;
  downsample_step: number;
  count: number;
  truncated: boolean;
  points: TelemetryPoint[];
}

export interface WorkshopItem {
  id: string;
  name: string;
  line_count: number;
  device_count: number;
}

export interface LineItem {
  id: string;
  name: string;
  workshop_id: string;
  rated_capacity_per_hour: number;
  device_count: number;
}

/** /stats/production 响应（第 2 阶段实机字段）。 */
export interface ProductionStats {
  start: string;
  end: string;
  orders_completed: number;
  planned_quantity: number;
  actual_quantity: number;
  qualified_quantity: number;
  qualified_rate: number;
  utilization: number;
}

export interface OrderItem {
  order_id: string;
  line_id: string;
  product_name: string;
  planned_quantity: number;
  actual_quantity: number;
  qualified_quantity: number;
  status: string;
  planned_start: string;
  planned_end: string;
  actual_end: string | null;
}

export type AlarmLevel = 'WARNING' | 'CRITICAL';

export interface AlarmItem {
  id: number;
  device_id: string;
  alarm_type: string;
  alarm_level: AlarmLevel;
  message: string;
  triggered_at: string;
  resolved_at: string | null;
  metric_value: number | null;
  threshold_value: number | null;
}

export interface MaintenanceItem {
  id: number;
  device_id: string;
  maintenance_type: 'ROUTINE' | 'REPAIR' | 'INSPECTION';
  description: string | null;
  started_at: string;
  finished_at: string | null;
  cost: number | null;
}

export interface AnomalyItem {
  id: number;
  device_id: string;
  anomaly_type: string;
  params: Record<string, unknown> | null;
  started_at: string;
  finished_at: string | null;
}
