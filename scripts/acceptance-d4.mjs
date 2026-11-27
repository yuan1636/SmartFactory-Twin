/**
 * 批量 D4 验收：粒子与旋转光斑（D-82）。
 *
 * 判据（规格 §4 第 12 / 13 条）：
 *  12 动效不同步：≥3 处持续运动，任意两组相位差中位数 >0.1 rad；
 *  13 粒子开销：draw call ≤4、帧率降 ≤10%。
 * 另加两条本批自定：场景 draw call ≤90（D-52 阈值）、关闭粒子后绘制次数必须回落（一键关闭有效）。
 *
 * 用法：node scripts/acceptance-d4.mjs [截图目录，默认 output/d4]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { CDP, Session, sleep, check, summarize } from './lib/cdp.mjs';

const SHOT_DIR = process.argv[2] ?? 'output/d4';
const PARTICLE_BUDGET = 4;
const SCENE_BUDGET = 90;

// 自己开一个标签页：9222 上的浏览器可能正被别的窗口使用，不能抢它的当前页
const tab = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
const session = new Session(ws);
await session.send('Page.enable');
await session.goto('/overview');
await sleep(4000);

const fpsExpr = `new Promise((res) => {
  const gaps = []; let last = performance.now(); let n = 0;
  const step = () => {
    const now = performance.now(); gaps.push(now - last); last = now; n += 1;
    if (n < 180) requestAnimationFrame(step);
    else { gaps.sort((a, b) => a - b); res(Math.round(1000 / gaps[Math.floor(gaps.length / 2)])); }
  };
  requestAnimationFrame(step);
})`;

const on = JSON.parse(await session.evaluate(`JSON.stringify(window.__sceneDebug.particles())`));
const profileOn = JSON.parse(await session.evaluate(`JSON.stringify(window.__sceneDebug.profile())`));
check('粒子绘制次数 ≤4', on.drawCalls <= PARTICLE_BUDGET, `${on.drawCalls} 次（火花 / 雾 / 光斑各 1）`);
check('场景 draw call ≤90（D-52）', profileOn.sceneCalls <= SCENE_BUDGET, `${profileOn.sceneCalls}（上限 100）`);

const fpsOn = await session.evaluate(fpsExpr);
await session.evaluate(`window.__sceneDebug.setParticles(false)`);
await sleep(800);
const off = JSON.parse(await session.evaluate(`JSON.stringify(window.__sceneDebug.particles())`));
const profileOff = JSON.parse(await session.evaluate(`JSON.stringify(window.__sceneDebug.profile())`));
const fpsOff = await session.evaluate(fpsExpr);

check('关闭粒子后绘制次数回落', profileOff.sceneCalls === profileOn.sceneCalls - on.drawCalls,
  `${profileOn.sceneCalls} → ${profileOff.sceneCalls}（差 ${on.drawCalls}）`);
check('粒子开销帧率降 ≤10%', fpsOn >= fpsOff * 0.9, `开 ${fpsOn} fps / 关 ${fpsOff} fps`);
await session.evaluate(`window.__sceneDebug.setParticles(true)`);

// ---- 动效不同步：机械臂相位 + 滚筒角度 + 光斑相位 ----
const motion = JSON.parse(await session.evaluate(`JSON.stringify(window.__sceneDebug.lineMotion())`));
const arms = motion.arms.map((a) => a.angle);
const pairs = [];
for (let i = 0; i < arms.length; i += 1) {
  for (let j = i + 1; j < arms.length; j += 1) pairs.push(Math.abs(arms[i] - arms[j]));
}
pairs.sort((a, b) => a - b);
const median = pairs[Math.floor(pairs.length / 2)] ?? 0;
check('机械臂相位不同步（中位差 >0.1 rad）', median > 0.1, `中位 ${median.toFixed(2)} rad，角度 [${arms.join(', ')}]`);

// 滚筒只装在输送机（CONV-01/02）上，两台都该按本线带速自转
const spinning = motion.rollers.filter((r) => r.spinning);
const angles = [...new Set(spinning.map((r) => r.angle))];
check('两台输送机滚筒都在自转且角度不同步', spinning.length === 2 && angles.length === 2,
  `${spinning.length} 台在转，角度 [${spinning.map((r) => r.angle).join(', ')}]`);

await sleep(1400);
const motion2 = JSON.parse(await session.evaluate(`JSON.stringify(window.__sceneDebug.lineMotion())`));
const armsMoved = motion.arms.filter((a, i) => Math.abs(a.angle - motion2.arms[i].angle) > 0.005).length;
const linesMoved = motion.lines.filter((l, i) => l.items.some((x, k) => Math.abs(x - motion2.lines[i].items[k]) > 0.05)).length;
const moving = (spinning.length > 0 ? 1 : 0) + (armsMoved > 0 ? 1 : 0) + (linesMoved > 0 ? 1 : 0);
check('≥3 处持续运动（滚筒 / 机械臂 / 物料，1.4 s 后仍在动）', moving >= 3,
  `滚筒 ${spinning.length} 台、机械臂 ${armsMoved} 台、物料 ${linesMoved} 条线在动`);

const spots = JSON.parse(await session.evaluate(`JSON.stringify(window.__sceneDebug.particles().phases)`));
check('三套动效相位互不相同', new Set([spots.sparks.toFixed(1), spots.mist.toFixed(1), spots.spots.toFixed(1)]).size === 3,
  `sparks ${spots.sparks} / mist ${spots.mist} / spots ${spots.spots}`);

mkdirSync(SHOT_DIR, { recursive: true });
await session.evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='LINE-A1'); b && b.click(); })()`);
await sleep(3500);
const shot = await session.send('Page.captureScreenshot', { format: 'png' });
writeFileSync(`${SHOT_DIR}/d4_line_a1.png`, Buffer.from(shot.data, 'base64'));
check('截图非空白', Buffer.from(shot.data, 'base64').length > 20000, `${SHOT_DIR}/d4_line_a1.png`);

const code = summarize();
process.exit(code);
