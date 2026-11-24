/** 顶部条右侧连接状态：已连接（绿）/ 重连中（黄 + 第 n 次）/ 已断开（红）。 */

import { useStoreSelector } from '../hooks/useTelemetry';

export function ConnectionIndicator() {
  const status = useStoreSelector((s) => s.wsStatus);
  const attempt = useStoreSelector((s) => s.wsAttempt);

  if (status === 'connected') {
    return (
      <span className="conn" title="WebSocket 实时推送正常">
        <span className="conn__dot" />
        实时已连接
      </span>
    );
  }
  if (status === 'disconnected') {
    return (
      <span className="conn" title="WebSocket 已关闭">
        <span className="conn__dot conn__dot--off" />
        已断开
      </span>
    );
  }
  if (status === 'connecting') {
    return (
      <span className="conn">
        <span className="conn__dot conn__dot--warn" />
        连接中…
      </span>
    );
  }
  return (
    <span className="conn" title="正在按退避策略重连">
      <span className="conn__dot conn__dot--warn" />
      重连中（第 {attempt} 次）
    </span>
  );
}
