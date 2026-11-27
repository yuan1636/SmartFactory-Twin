/**
 * 连接状态探针（D5 / D6 共用）：每 250 ms 读一次顶部连接指示器的文字，打时间线。
 *
 * 为什么不在浏览器里模拟断网：CDP 的 Network.emulateNetworkConditions 只影响**新请求**，
 * 已经建立的 WebSocket 不会被掐断（实测文字一直停在"实时已连接"）。
 * 要验"断线有提示、恢复能回来"，只能真的把后端停掉 —— 由调用方在外部 kill/start。
 *
 * 用法：node scripts/probe-conn.mjs 20000 > output/conn_timeline.log
 */

import { CDP, Session, sleep } from './lib/cdp.mjs';

const durationMs = Number(process.argv[2] ?? 20000);
const tab = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
const session = new Session(ws);
await session.send('Page.enable');
await session.evaluate(`location.href = 'http://127.0.0.1:5173/production'`);
await sleep(4000);

const read = () =>
  session.evaluate(`(() => {
    const el = document.querySelector('.conn-indicator') ?? document.querySelector('[class*="conn"]');
    return el ? el.textContent.trim().replace(/\\s+/g, ' ') : '(none)';
  })()`);

const started = Date.now();
let last = '';
while (Date.now() - started < durationMs) {
  const text = await read();
  if (text !== last) {
    console.log(`${new Date().toISOString().slice(11, 19)}  ${text}`);
    last = text;
  }
  await sleep(250);
}
await fetch(`${CDP}/json/close/${tab.id}`);
process.exit(0);
