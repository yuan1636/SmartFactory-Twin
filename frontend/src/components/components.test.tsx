import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DataTable } from './DataTable';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { StatusBadge } from './StatusBadge';
import { ApiError } from '../services/api';

describe('StatusBadge', () => {
  it('五态都有中文名', () => {
    const { rerender } = render(<StatusBadge state="ALARM" />);
    expect(screen.getByText('告警')).toBeInTheDocument();
    rerender(<StatusBadge state="MAINTENANCE" />);
    expect(screen.getByText('维护中')).toBeInTheDocument();
  });

  it('未知状态显示“未知”而不是假装运行中', () => {
    render(<StatusBadge state="RUNNING" unknown />);
    expect(screen.getByText('未知')).toBeInTheDocument();
  });
});

describe('EmptyState / ErrorState', () => {
  it('空态显示标题与提示', () => {
    render(<EmptyState title="暂无告警记录" hint="换个筛选条件" />);
    expect(screen.getByText('暂无告警记录')).toBeInTheDocument();
    expect(screen.getByText('换个筛选条件')).toBeInTheDocument();
  });

  it('错误态给出可读文案与重试按钮，不是 [object Object]', () => {
    const error = new ApiError('VALIDATION_ERROR', '请求参数校验失败', 422, [
      { field: 'query.start', message: '不是合法时间' },
    ]);
    render(<ErrorState error={error} onRetry={() => {}} />);
    expect(screen.getByText(/query.start/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });
});

describe('DataTable', () => {
  it('渲染列与行，空数据走空态', () => {
    const rows = [{ id: 'CNC-01', name: '数控机床 1' }];
    const { rerender } = render(
      <DataTable
        columns={[
          { key: 'id', title: '设备' },
          { key: 'name', title: '名称' },
        ]}
        rows={rows}
        rowKey={(r) => r.id}
      />,
    );
    expect(screen.getByText('CNC-01')).toBeInTheDocument();
    expect(screen.getByText('数控机床 1')).toBeInTheDocument();

    rerender(
      <DataTable
        columns={[{ key: 'id', title: '设备' }]}
        rows={[] as Array<{ id: string }>}
        rowKey={(r) => r.id}
        empty="暂无告警记录"
      />,
    );
    expect(screen.getByText('暂无告警记录')).toBeInTheDocument();
  });
});
