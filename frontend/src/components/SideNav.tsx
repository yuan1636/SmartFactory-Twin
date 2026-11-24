import { NavLink } from 'react-router-dom';

interface NavItem {
  to: string;
  label: string;
  disabled?: boolean;
  badge?: string;
  hint?: string;
}

const ITEMS: NavItem[] = [
  { to: '/overview', label: '工厂总览' },
  { to: '/devices', label: '设备监控' },
  { to: '/production', label: '生产分析' },
  { to: '/alerts', label: '告警与维护' },
  { to: '/ai', label: 'AI 预测分析' },
  { to: '/assistant', label: 'AI 工业助手', disabled: true, badge: '预留', hint: '预留，本阶段不实现' },
];

export function SideNav() {
  return (
    <nav className="side-nav">
      <div className="side-nav__brand">
        <div className="side-nav__brand-name">SmartFactory Twin</div>
        <div className="side-nav__brand-sub">智慧工厂数字孪生 V1.0</div>
      </div>
      {ITEMS.map((item) =>
        item.disabled ? (
          <span
            key={item.to}
            className="side-nav__item is-disabled"
            title={item.hint}
            aria-disabled="true"
          >
            {item.label}
            {item.badge ? <span className="side-nav__badge">{item.badge}</span> : null}
          </span>
        ) : (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => `side-nav__item${isActive ? ' is-active' : ''}`}
          >
            {item.label}
          </NavLink>
        ),
      )}
    </nav>
  );
}
