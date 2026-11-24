/**
 * WS 客户端（G-12）。单例连接：多个组件订阅时只开一条连接。
 * 重连退避 1/2/4/8/16 秒，第 5 次失败后固定 30 秒；
 * 重连成功先拉 /devices/latest 兜底，再接推送 —— 否则断线期间的状态会一直停在最后一帧。
 */

import { apiGet } from './api';
import { applyLatest, setSnapshot, setWsStatus } from './store';
import type { LatestResponse, Snapshot } from './types';

const WS_URL: string =
  import.meta.env.VITE_WS_URL ?? 'ws://127.0.0.1:8000/api/v1/ws/telemetry';
const BACKOFF_SECONDS = [1, 2, 4, 8, 16];
const IDLE_RETRY_SECONDS = 30;

let socket: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;
let refCount = 0;

function clearRetry() {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function scheduleReconnect() {
  const delay = attempt <= BACKOFF_SECONDS.length
    ? BACKOFF_SECONDS[Math.max(0, attempt - 1)]
    : IDLE_RETRY_SECONDS;
  clearRetry();
  retryTimer = setTimeout(() => {
    retryTimer = null;
    open();
  }, delay * 1000);
}

async function pullLatest() {
  try {
    const latest = await apiGet<LatestResponse>('/devices/latest');
    applyLatest(latest);
  } catch {
    // 兜底失败不阻塞重连：REST 也挂了的话页面靠 ErrorState 提示
  }
}

function open() {
  if (refCount === 0) return;
  setWsStatus(attempt === 0 ? 'connecting' : 'reconnecting', attempt);

  let ws: WebSocket;
  try {
    ws = new WebSocket(WS_URL);
  } catch {
    attempt += 1;
    setWsStatus('reconnecting', attempt);
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    attempt = 0;
    void pullLatest().then(() => setWsStatus('connected', 0));
  };

  ws.onmessage = (event: MessageEvent<string>) => {
    try {
      const payload = JSON.parse(event.data) as Snapshot;
      if (payload && payload.type === 'snapshot') setSnapshot(payload);
    } catch {
      // 非 JSON 帧直接丢弃，不打断连接
    }
  };

  ws.onerror = () => {
    ws.close();
  };

  ws.onclose = () => {
    if (socket === ws) socket = null;
    if (refCount === 0) return;
    attempt += 1;
    setWsStatus('reconnecting', attempt);
    scheduleReconnect();
  };
}

/** 订阅实时推送；返回取消函数。最后一个订阅者离开时关闭连接。 */
export function connectTelemetry(): () => void {
  refCount += 1;
  if (refCount === 1) {
    attempt = 0;
    open();
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    refCount -= 1;
    if (refCount === 0) {
      clearRetry();
      attempt = 0;
      if (socket) {
        const ws = socket;
        socket = null;
        ws.onclose = null;
        ws.close();
      }
      setWsStatus('disconnected', 0);
    }
  };
}
