import { useEffect, useState } from 'react';
import { formatTime } from '../services/format';
import { ConnectionIndicator } from './ConnectionIndicator';

interface TopBarProps {
  title: string;
  crumb?: string;
}

export function TopBar({ title, crumb }: TopBarProps) {
  const [now, setNow] = useState(() => new Date().toISOString());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date().toISOString()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <header className="top-bar">
      <div>
        <span className="top-bar__title">{title}</span>
        {crumb ? <span className="top-bar__crumb" style={{ marginLeft: 10 }}>{crumb}</span> : null}
      </div>
      <div className="top-bar__right">
        <ConnectionIndicator />
        <span className="top-bar__clock" title="本机时间（后端时间为 UTC，前端已按本地时区换算）">
          {formatTime(now)}
        </span>
      </div>
    </header>
  );
}
