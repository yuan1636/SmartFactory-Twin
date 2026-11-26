import { NavLink } from 'react-router-dom';

interface NavItem {
  to: string;
  label: string;
}

const ITEMS: NavItem[] = [
  { to: '/overview', label: '工厂总览' },
  { to: '/devices', label: '设备监控' },
  { to: '/production', label: '生产分析' },
  { to: '/alerts', label: '告警与维护' },
  { to: '/ai', label: '工厂日报' },
];

export function SideNav() {
  return (
    <nav className="side-nav">
      <div className="side-nav__brand">
        <div className="side-nav__brand-name">SmartFactory Twin</div>
        <div className="side-nav__brand-sub">智慧工厂数字孪生 V1.0</div>
      </div>
      {ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) => `side-nav__item${isActive ? ' is-active' : ''}`}
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
