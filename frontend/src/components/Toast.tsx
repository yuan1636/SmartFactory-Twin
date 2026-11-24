/** 命令式 Toast：toast.success('...')，右下角最多同时 3 条，3 秒自动消失。 */

import { useEffect, useState } from 'react';

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

let seq = 0;
let items: ToastItem[] = [];
const listeners = new Set<(list: ToastItem[]) => void>();

function publish() {
  for (const listener of listeners) listener(items);
}

function push(kind: ToastKind, message: string) {
  const item: ToastItem = { id: (seq += 1), kind, message };
  items = [...items, item].slice(-3);
  publish();
  window.setTimeout(() => {
    items = items.filter((i) => i.id !== item.id);
    publish();
  }, 3000);
}

export const toast = {
  success: (message: string) => push('success', message),
  error: (message: string) => push('error', message),
  info: (message: string) => push('info', message),
};

export function ToastHost() {
  const [list, setList] = useState<ToastItem[]>(items);

  useEffect(() => {
    listeners.add(setList);
    setList(items);
    return () => {
      listeners.delete(setList);
    };
  }, []);

  if (list.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {list.map((item) => (
        <div key={item.id} className={`toast toast--${item.kind}`}>
          {item.message}
        </div>
      ))}
    </div>
  );
}
