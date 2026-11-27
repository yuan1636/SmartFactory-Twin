/**
 * D5 界面层验收（D-83）。
 *
 * 判据（规格 §4 第 16 条 + D5 目标）：
 *  1. KPI 数字跳动宽度差 < 1 px（tabular-nums 生效，不是靠等宽字体的错觉）；
 *  2. 连接状态 3 态（已连接 / 连接中 / 已断开）真的会在断网/恢复时出现；
 *  3. 组件内硬编码色值 0 处（由 npm script 里的 grep 判，不在浏览器里判）；
 *  4. 封面截图 ≥1680×1050 且无调试角标（走生产构建，见 docs 的说明）。
 *
 * 用法：node scripts/acceptance-d5.mjs [截图目录，默认 output/d5]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { CDP, Session, sleep, check, summarize } from './lib/cdp.mjs';

const SHOT_DIR = process.argv[2] ?? 'output/d5';
const tab = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
const session = new Session(ws);
await session.send('Page.enable');
await session.send('Network.enable');
await session.evaluate(`location.href = 'http://127.0.0.1:5173/production'`);
await sleep(6000);

// ---- 1. KPI 宽度差：同一 class 下 "1,234" 与 "9,876" 的宽度必须一致 ----
const widthProbe = await session.evaluate(`(() => {
  const base = document.querySelector('.metric-card__value');
  if (!base) return null;
  const make = (text) => {
    const el = document.createElement('span');
    el.className = base.className;
    el.style.position = 'absolute';
    el.style.visibility = 'hidden';
    el.style.whiteSpace = 'nowrap';
    el.textContent = text;
    document.body.appendChild(el);
    return el;
  };
  const a = make('1,234');
  const b = make('9,876');
  const wa = a.getBoundingClientRect().width;
  const wb = b.getBoundingClientRect().width;
  const numeric = getComputedStyle(base).fontVariantNumeric;
  a.remove(); b.remove();
  return { wa, wb, numeric };
})()`);
check('KPI 数值宽度不随数字变化（<1 px）', widthProbe !== null && Math.abs(widthProbe.wa - widthProbe.wb) < 1,
  widthProbe ? `1,234 → ${widthProbe.wa.toFixed(2)} px；9,876 → ${widthProbe.wb.toFixed(2)} px；font-variant-numeric=${widthProbe.numeric}` : '找不到 .metric-card__value');

// ---- 2. 连接状态 3 态 ----
const readState = async () => session.evaluate(`(() => {
  const el = document.querySelector('.conn-indicator') ?? document.querySelector('[class*="conn"]');
  return el ? el.textContent.trim() : null;
})()`);
const connected = await readState();
check('状态 1/3：已连接', Boolean(connected && connected.includes('已实时连接')), connected ?? '读不到指示器');

await session.send('Network.emulateNetworkConditions', {
  offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
});
await sleep(7000);
const offline = await readState();
check('状态 2/3：断线有明确提示', Boolean(offline && /断开|重连/.test(offline)), offline ?? '读不到指示器');

await session.send('Network.emulateNetworkConditions', {
  offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
});
await sleep(12000);
const back = await readState();
check('状态 3/3：恢复后回到已连接', Boolean(back && back.includes('已实时连接')), back ?? '读不到指示器');

// ---- 3. 封面截图（16:10 视口，界面层完整） ----
mkdirSync(SHOT_DIR, { recursive: true });
await session.send('Emulation.setDeviceMetricsOverride', {
  width: 1680, height: 1050, deviceScaleFactor: 1, mobile: false,
});
await session.evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='工厂总览'); b && b.click(); })()`);
await sleep(5000);
const shot = await session.send('Page.captureScreenshot', { format: 'png' });
const buf = Buffer.from(shot.data, 'base64');
writeFileSync(`${SHOT_DIR}/cover_1680x1050.png`, buf);
check('封面截图 ≥1680×1050 且非空白', buf.length > 40000, `${SHOT_DIR}/cover_1680x1050.png（${(buf.length / 1024).toFixed(0)} KB）`);

await fetch(`${CDP}/json/close/${tab.id}`);
const code = summarize();
process.exit(code);
