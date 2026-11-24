/** 页面四：设备告警与维护（规格 5.5，偏差 D-01 新增页）。 */

import { useMemo, useState } from 'react';
import { DataTable, type Column } from '../components/DataTable';
import { ErrorState } from '../components/ErrorState';
import { MetricCard } from '../components/MetricCard';
import { toast } from '../components/Toast';
import { usePolling } from '../hooks/usePolling';
import { apiGet, apiPatch, apiPost } from '../services/api';
import { formatNumber, formatTime } from '../services/format';
import type {
  AlarmItem,
  DeviceListItem,
  MaintenanceCreated,
  MaintenanceInput,
  MaintenanceItem,
  MaintenanceType,
  Page,
  ResolveResult,
} from '../services/types';
import {
  ALARM_LEVEL_META,
  alarmLevelCounts,
  alarmTypeLabel,
  maintenanceFeedback,
  resolveFeedback,
} from '../utils/analytics';
import { describeError } from '../utils/errors';

const MAINTENANCE_LABEL: Record<MaintenanceType, string> = {
  ROUTINE: '例行保养',
  REPAIR: '维修',
  INSPECTION: '点检',
};

type ResolvedFilter = '' | 'false' | 'true';

/** datetime-local 给的是本地时间字符串，后端要带时区，统一转 ISO。 */
function toIso(local: string): string {
  return new Date(local).toISOString();
}

export default function Alerts() {
  const [deviceId, setDeviceId] = useState('');
  const [level, setLevel] = useState('');
  const [resolvedFilter, setResolvedFilter] = useState<ResolvedFilter>('false');
  const [resolving, setResolving] = useState<number | null>(null);

  const [formDevice, setFormDevice] = useState('');
  const [formType, setFormType] = useState<MaintenanceType>('ROUTINE');
  const [formDesc, setFormDesc] = useState('');
  const [formStarted, setFormStarted] = useState('');
  const [formFinished, setFormFinished] = useState('');
  const [formCost, setFormCost] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const devices = usePolling<Page<DeviceListItem>>(
    () => apiGet<Page<DeviceListItem>>('/devices', { page: 1, page_size: 50 }),
    60_000,
  );

  // 未解除告警单独拉一份：KPI 要的是「全厂未解除」，不能跟着下面的筛选变
  const openAlarms = usePolling<Page<AlarmItem>>(
    () => apiGet<Page<AlarmItem>>('/alarms', { resolved: false, page_size: 100 }),
    10_000,
  );

  const alarms = usePolling<Page<AlarmItem>>(
    () =>
      apiGet<Page<AlarmItem>>('/alarms', {
        page: 1,
        page_size: 50,
        device_id: deviceId || undefined,
        alarm_level: level || undefined,
        resolved: resolvedFilter === '' ? undefined : resolvedFilter === 'true',
      }),
    10_000,
    { key: `${deviceId}|${level}|${resolvedFilter}` },
  );

  const maintenance = usePolling<Page<MaintenanceItem>>(
    () => apiGet<Page<MaintenanceItem>>('/maintenance', { page: 1, page_size: 20 }),
    60_000,
  );

  const openCounts = useMemo(
    () => alarmLevelCounts(openAlarms.data?.items ?? []),
    [openAlarms.data],
  );

  const onResolve = async (alarmId: number) => {
    setResolving(alarmId);
    try {
      const res = await apiPatch<ResolveResult>(`/alarms/${alarmId}/resolve`);
      const fb = resolveFeedback(res);
      // G-10：必须说清还剩几条，不能写成「操作成功」
      if (fb.kind === 'success') toast.success(fb.message);
      else toast.info(fb.message);
      alarms.refresh();
      openAlarms.refresh();
      devices.refresh();
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setResolving(null);
    }
  };

  const onCreateMaintenance = async () => {
    if (!formDevice) {
      toast.error('请先选择设备');
      return;
    }
    if (!formStarted) {
      toast.error('请填写开始时间');
      return;
    }
    const body: MaintenanceInput = {
      device_id: formDevice,
      maintenance_type: formType,
      description: formDesc.trim() || null,
      started_at: toIso(formStarted),
      finished_at: formFinished ? toIso(formFinished) : null,
      cost: formCost.trim() === '' ? null : Number(formCost),
    };
    if (body.finished_at && body.finished_at < body.started_at) {
      toast.error('结束时间不能早于开始时间');
      return;
    }
    setSubmitting(true);
    try {
      const created = await apiPost<MaintenanceCreated>('/maintenance', body);
      const fb = maintenanceFeedback(created.device_status, Boolean(created.finished_at));
      if (fb.kind === 'success') toast.success(fb.message);
      else toast.info(fb.message);
      setFormDesc('');
      setFormCost('');
      setFormFinished('');
      maintenance.refresh();
      devices.refresh();
      openAlarms.refresh();
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setSubmitting(false);
    }
  };

  const alarmColumns: Column<AlarmItem>[] = [
    { key: 'detected_at', title: '时间', width: 156, render: (r) => formatTime(r.detected_at) },
    { key: 'device_id', title: '设备', width: 96 },
    { key: 'alarm_type', title: '类型', width: 70, render: (r) => alarmTypeLabel(r.alarm_type) },
    {
      key: 'alarm_level',
      title: '等级',
      width: 70,
      render: (r) => (
        <span style={{ color: ALARM_LEVEL_META[r.alarm_level].color }}>{ALARM_LEVEL_META[r.alarm_level].label}</span>
      ),
    },
    { key: 'message', title: '文案' },
    {
      key: 'resolved_at',
      title: '状态',
      width: 76,
      render: (r) => (r.resolved_at ? '已解除' : <span className="warn-text">未解除</span>),
    },
    {
      key: 'action',
      title: '操作',
      width: 72,
      render: (r) =>
        r.resolved_at ? (
          <span className="muted">—</span>
        ) : (
          <button
            type="button"
            className="btn btn--primary"
            disabled={resolving === r.alarm_id}
            onClick={() => void onResolve(r.alarm_id)}
          >
            {resolving === r.alarm_id ? '解除中…' : '解除'}
          </button>
        ),
    },
  ];

  const maintenanceColumns: Column<MaintenanceItem>[] = [
    { key: 'device_id', title: '设备', width: 96 },
    {
      key: 'maintenance_type',
      title: '类型',
      width: 88,
      render: (r) => MAINTENANCE_LABEL[r.maintenance_type] ?? r.maintenance_type,
    },
    { key: 'description', title: '描述', render: (r) => r.description ?? '—' },
    { key: 'started_at', title: '开始', width: 156, render: (r) => formatTime(r.started_at) },
    { key: 'finished_at', title: '结束', width: 156, render: (r) => formatTime(r.finished_at) },
    {
      key: 'cost',
      title: '成本',
      width: 92,
      align: 'right',
      render: (r) => (r.cost === null ? '—' : `¥ ${formatNumber(r.cost, 2)}`),
    },
  ];

  return (
    <div className="page-stack">
      <div className="kpi-row kpi-row--3">
        <MetricCard
          label="未解除告警（全厂）"
          value={openAlarms.data ? formatNumber(openAlarms.data.total) : '—'}
          unit={openAlarms.data ? '条' : undefined}
          delta={openAlarms.data ? '每 10 秒刷新' : '等待数据'}
          tone={openCounts.total > 0 ? 'crit' : 'normal'}
        />
        <MetricCard
          label="其中 CRITICAL"
          value={openAlarms.data ? formatNumber(openCounts.critical) : '—'}
          unit={openAlarms.data ? '条' : undefined}
          delta="超过阈值 ×1.25"
          tone={openCounts.critical > 0 ? 'crit' : 'normal'}
        />
        <MetricCard
          label="其中 WARNING"
          value={openAlarms.data ? formatNumber(openCounts.warning) : '—'}
          unit={openAlarms.data ? '条' : undefined}
          delta="超过阈值 ×1.1"
          tone={openCounts.warning > 0 ? 'warn' : 'normal'}
        />
      </div>

      <div className="card">
        <div className="card__title-row">
          <h3 className="card__title">告警列表</h3>
          <div className="toolbar" style={{ marginLeft: 'auto' }}>
            <select className="select" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
              <option value="">全部设备</option>
              {(devices.data?.items ?? []).map((d) => (
                <option key={d.device_id} value={d.device_id}>
                  {d.device_id} {d.device_name}
                </option>
              ))}
            </select>
            <select className="select" value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="">全部等级</option>
              <option value="CRITICAL">CRITICAL</option>
              <option value="WARNING">WARNING</option>
            </select>
            <select
              className="select"
              value={resolvedFilter}
              onChange={(e) => setResolvedFilter(e.target.value as ResolvedFilter)}
            >
              <option value="false">未解除</option>
              <option value="true">已解除</option>
              <option value="">全部</option>
            </select>
          </div>
        </div>
        {alarms.error ? (
          <ErrorState error={alarms.error} onRetry={alarms.refresh} />
        ) : (
          <DataTable
            columns={alarmColumns}
            rows={alarms.data?.items ?? []}
            rowKey={(r) => r.alarm_id}
            loading={alarms.loading && !alarms.data}
            empty={resolvedFilter === 'false' ? '当前没有未解除告警' : '没有匹配的告警'}
          />
        )}
        <div className="card__footnote">
          解除按 G-10 决定设备状态：该设备还有其它未解除告警时保持 ALARM，清零后才回 RUNNING。共{' '}
          {formatNumber(alarms.data?.total ?? 0)} 条符合筛选。
        </div>
      </div>

      <div className="card">
        <div className="card__title-row">
          <h3 className="card__title">维护记录</h3>
          <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
            共 {formatNumber(maintenance.data?.total ?? 0)} 条
          </span>
        </div>
        {maintenance.error ? (
          <ErrorState error={maintenance.error} onRetry={maintenance.refresh} />
        ) : (
          <DataTable
            columns={maintenanceColumns}
            rows={maintenance.data?.items ?? []}
            rowKey={(r) => r.record_id}
            loading={maintenance.loading && !maintenance.data}
            empty="暂无维护记录"
          />
        )}
      </div>

      <div className="card">
        <div className="card__title-row">
          <h3 className="card__title">新增维护记录</h3>
        </div>
        <div className="form-grid">
          <label className="field">
            设备
            <select className="select" value={formDevice} onChange={(e) => setFormDevice(e.target.value)}>
              <option value="">请选择设备</option>
              {(devices.data?.items ?? []).map((d) => (
                <option key={d.device_id} value={d.device_id}>
                  {d.device_id} {d.device_name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            类型
            <select
              className="select"
              value={formType}
              onChange={(e) => setFormType(e.target.value as MaintenanceType)}
            >
              <option value="ROUTINE">例行保养</option>
              <option value="REPAIR">维修</option>
              <option value="INSPECTION">点检</option>
            </select>
          </label>
          <label className="field">
            开始时间
            <input
              className="input"
              type="datetime-local"
              value={formStarted}
              onChange={(e) => setFormStarted(e.target.value)}
            />
          </label>
          <label className="field">
            结束时间（可空）
            <input
              className="input"
              type="datetime-local"
              value={formFinished}
              onChange={(e) => setFormFinished(e.target.value)}
            />
          </label>
          <label className="field">
            成本（元，可空）
            <input
              className="input"
              type="number"
              min={0}
              step="0.01"
              value={formCost}
              onChange={(e) => setFormCost(e.target.value)}
            />
          </label>
          <label className="field" style={{ gridColumn: 'span 3' }}>
            描述
            <input
              className="input"
              placeholder="例：更换主轴轴承"
              value={formDesc}
              onChange={(e) => setFormDesc(e.target.value)}
            />
          </label>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
          <button
            type="button"
            className="btn btn--primary"
            disabled={submitting}
            onClick={() => void onCreateMaintenance()}
          >
            {submitting ? '提交中…' : '提交'}
          </button>
          <span className="warn-text">未填结束时间将把设备置为「维护中」</span>
        </div>
      </div>
    </div>
  );
}
