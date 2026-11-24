import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="card placeholder">
      <h2>页面不存在</h2>
      <p className="muted">地址可能输错了，或者该页面属于后续阶段。</p>
      <Link className="btn btn--primary" to="/overview" style={{ display: 'inline-block', textDecoration: 'none' }}>
        返回总览
      </Link>
    </div>
  );
}
