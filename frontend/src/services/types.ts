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

/**
 * /stats/production 响应。
 * 2026-11-24 实机核对：还带 orders_in_progress / completion_rate / line_id，
 * 少了它们会让「完成率」和「在制订单」无处可取。
 */
export interface ProductionStats {
  line_id: string | null;
  start: string;
  end: string;
  orders_completed: number;
  orders_in_progress: number;
  planned_quantity: number;
  actual_quantity: number;
  qualified_quantity: number;
  qualified_rate: number;
  completion_rate: number;
  utilization: number;
}

/** /orders 列表项。后端给的是 product_id（不是 product_name），且没 actual_end，只有计划区间。 */
export interface OrderItem {
  order_id: string;
  product_id: string;
  line_id: string;
  planned_quantity: number;
  actual_quantity: number;
  qualified_quantity: number;
  planned_start: string;
  planned_end: string;
  status: string;
  qualified_rate: number;
  completion_rate: number;
}

export type AlarmLevel = 'WARNING' | 'CRITICAL';

/** 告警类型：后端只产生这三类（2026-11-24 实测 48 条告警均属此三类）。 */
export type AlarmType = 'TEMPERATURE' | 'VIBRATION' | 'CURRENT';

/** /alarms 列表项。主键是 alarm_id（不是 id），时间是 detected_at（不是 triggered_at）。 */
export interface AlarmItem {
  alarm_id: number;
  device_id: string;
  alarm_type: AlarmType | string;
  alarm_level: AlarmLevel;
  message: string;
  detected_at: string;
  resolved_at: string | null;
}

/** PATCH /alarms/{id}/resolve 的返回体，G-10 的两项证据都在这里。 */
export interface ResolveResult {
  alarm_id: number;
  resolved_at: string;
  device_status: string;
  open_alarm_count: number;
}

export type MaintenanceType = 'ROUTINE' | 'REPAIR' | 'INSPECTION';

/** /maintenance 列表项。主键是 record_id，结束时间是 finished_at。 */
export interface MaintenanceItem {
  record_id: number;
  device_id: string;
  maintenance_type: MaintenanceType;
  description: string | null;
  started_at: string;
  finished_at: string | null;
  cost: number | null;
}

export interface MaintenanceInput {
  device_id: string;
  maintenance_type: MaintenanceType;
  description?: string | null;
  started_at: string;
  finished_at?: string | null;
  cost?: number | null;
}

export interface MaintenanceCreated {
  record_id: number;
  device_id: string;
  maintenance_type: MaintenanceType;
  started_at: string;
  finished_at: string | null;
  cost: number | null;
  device_status: string;
}

/** /anomalies 列表项（模拟器写入的真值）。结束时间是 ended_at，不是 finished_at。 */
export interface AnomalyItem {
  id: number;
  device_id: string;
  anomaly_type: 'TEMP_DRIFT' | 'VIB_SPIKE' | 'CURRENT_ABNORMAL' | string;
  started_at: string;
  ended_at: string | null;
  params: Record<string, unknown> | null;
}
