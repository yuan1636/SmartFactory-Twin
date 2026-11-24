import type { ReactNode } from 'react';
import { EmptyState } from './EmptyState';
import { LoadingBlock } from './LoadingBlock';

export interface Column<T> {
  key: string;
  title: string;
  width?: number;
  align?: 'left' | 'right' | 'center';
  render?: (row: T) => ReactNode;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  empty?: string;
  loading?: boolean;
}

/** 行数 ≤ 100，不做虚拟滚动。 */
export function DataTable<T>({ columns, rows, rowKey, empty = '暂无数据', loading = false }: DataTableProps<T>) {
  if (loading) return <LoadingBlock rows={5} />;
  if (rows.length === 0) return <EmptyState title={empty} />;

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} style={{ width: col.width, textAlign: col.align ?? 'left' }}>
                {col.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((col) => (
                <td key={col.key} style={{ textAlign: col.align ?? 'left' }}>
                  {col.render ? col.render(row) : String((row as Record<string, unknown>)[col.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
