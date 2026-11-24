/** 外壳：侧边导航 + 顶部条 + 内容区 + Toast。WS 连接在这里建立，全站共用一条。 */

import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useStoreSelector } from '../hooks/useTelemetry';
import { connectTelemetry } from '../services/ws';
import { SideNav } from './SideNav';
import { ToastHost } from './Toast';
import { TopBar } from './TopBar';

const TITLES: Array<{ prefix: string; title: string; crumb: string }> = [
  { prefix: '/overview', title: '工厂数字孪生总览', crumb: '页面一' },
  { prefix: '/devices', title: '设备监控中心', crumb: '页面二' },
  { prefix: '/production', title: '生产数据分析', crumb: '页面三' },
  { prefix: '/alerts', title: '设备告警与维护', crumb: '页面四 · 偏差 D-01 新增' },
  { prefix: '/ai', title: 'AI 预测分析', crumb: '页面五 · 仅展示真值，无模型' },
];

export function Layout() {
  const location = useLocation();
  const wsStatus = useStoreSelector((s) => s.wsStatus);
  const attempt = useStoreSelector((s) => s.wsAttempt);

  useEffect(() => connectTelemetry(), []);

  const matched = TITLES.find((t) => location.pathname.startsWith(t.prefix));
  const degraded = wsStatus === 'reconnecting' || wsStatus === 'disconnected';

  return (
    <div className="shell">
      <SideNav />
      <div className="main">
        <TopBar title={matched?.title ?? '页面不存在'} crumb={matched?.crumb} />
        {degraded ? (
          <div className="degraded-bar">
            实时连接已断开，正在重连（第 {attempt} 次）。三维状态灯已转灰，数值停止更新 —— 数据不是当前值。
          </div>
        ) : null}
        <div className="content">
          <Outlet />
        </div>
      </div>
      <ToastHost />
    </div>
  );
}
