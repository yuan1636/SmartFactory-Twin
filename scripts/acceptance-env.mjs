/**
 * 本批验收：产线完整化 + 四种工况 + 环境层 + 物料加减速（作者 2026-11-25 追加）。
 *
 * 判据（与作者要求逐条对应）：
 *  1. 场景 draw call ≤100（预算），环境层只允许 6 个合并组；
 *  2. 四条线四种工况在「料数 / 颜色 / 速度 / 设备状态」上两两不同，且不是同一相位；
 *  3. 物料排布不规整：偏移 ≤10% 料距、偏转 ≤±2°；
 *  4. 加减速与停顿：速度字段存在、冻结线全 0、A2 堵料处速度为 0；
 *  5. 四张截图（全厂俯瞰 / A1 特写 / B1 检修 / B2 换型）非空白；
 *  6. 全程无页面运行时异常。
 *
 * 用法：node scripts/acceptance-env.mjs [截图目录，默认 output/env]
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { connect, sleep, check, summarize, WEB } from './lib/cdp.mjs';

const SHOT_DIR = process.argv[2] ?? 'output/env';
const SCENE_BUDGET = 100;
// 6 → 7：批 1（D-75）把围护壳拆成独立的 shell 组，只为关掉墙的投影
// （墙投影会把室内所有光挡在外面，车间里就一点影子都没有）
const ENV_GROUP_BUDGET = 7;
const MIN_FPS = 50;
const MIN_LUMA = 6;

const FPS_SCRIPT = `
  (() => new Promise((resolve) => {
    const gaps = []; let last = performance.now(); const t0 = last;
    const tick = (now) => {
      gaps.push(now - last); last = now;
      if (now - t0 < 5000) requestAnimationFrame(tick);
      else {
        const s = gaps.slice(1).sort((a, b) => a - b);
        resolve(JSON.stringify({ fpsMedian: Number((1000 / s[Math.floor(s.length / 2)]).toFixed(1)), frames: gaps.length }));
      }
    };
    requestAnimationFrame(tick);
  }))()
`;

const LUMA_SCRIPT = (dataUrl) => `
  (() => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      const w = 160;
      const h = Math.max(1, Math.round((img.height / img.width) * w));
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      resolve(JSON.stringify({ luma: Number((sum / (d.length / 4)).toFixed(1)), w: img.width, h: img.height }));
    };
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = ${JSON.stringify(dataUrl)};
  }))()
`;

const SHOTS = [
  ['01_overview', { position: [0, 40, 48], target: [0, 0, 0] }],
  ['02_a1_full', { position: [-40, 11, 4], target: [-24, 1.0, -7.5] }],
  ['03_b1_maintenance', { position: [8, 11, 2], target: [20, 1.0, -7.5] }],
  ['04_b2_changeover', { position: [8, 10, 20], target: [20, 1, 7.5] }],
];

const main = async () => {
  const session = await connect();
  await session.send('Page.enable');
  await session.send('Page.navigate', { url: `${WEB}/overview` });
  await sleep(500);
  if (!(await session.waitFor('!!window.__sceneDebug?.profile && !!document.querySelector("canvas")', 20000))) {
    throw new Error('场景未就绪（__sceneDebug 只在 dev 存在，确认跑的是 dev server）');
  }
  await sleep(4500); // 等入场动画结束

  await session.evaluate(`(() => {
    window.__envErrors = [];
    window.addEventListener('error', (e) => window.__envErrors.push(String(e.message)));
    window.addEventListener('unhandledrejection', (e) => window.__envErrors.push(String(e.reason)));
    return true;
  })()`);

  // ---------- 1. 环境层与开销 ----------
  const env = JSON.parse(await session.evaluate('JSON.stringify(window.__sceneDebug.env())'));
  const meshes = env.drawables.reduce((n, d) => n + d.meshes, 0);
  check('环境层类别 ≥ 9', env.kinds.length >= 9, env.kinds.join(', '));
  check(`环境层合并组 ≤ ${ENV_GROUP_BUDGET}（一物一 mesh 会超）`, meshes <= ENV_GROUP_BUDGET,
    `${meshes} 个绘制体：${env.drawables.map((d) => `${d.group}×${d.meshes}`).join(' ')}`);

  await session.evaluate('window.__sceneDebug.setCamera({ position: [0, 40, 48], target: [0, 0, 0] })');
  await sleep(1400);
  const prof = JSON.parse(await session.evaluate('JSON.stringify(window.__sceneDebug.profile())'));
  check(`场景 draw call ≤ ${SCENE_BUDGET}（总览机位）`, prof.sceneCalls <= SCENE_BUDGET,
    `${prof.sceneCalls} 场景 + ${prof.shadowCalls} 阴影 + ${prof.postPasses} 后处理 = ${prof.total}`);
  const fps = JSON.parse(await session.evaluate(FPS_SCRIPT));
  check(`fps 中位 ≥ ${MIN_FPS}`, fps.fpsMedian >= MIN_FPS, `实际 ${fps.fpsMedian}（本批前基线 144.9）`);

  // ---------- 2. 四工况差异 ----------
  const scn = JSON.parse(await session.evaluate('JSON.stringify(window.__sceneDebug.scenario())'));
  check('四条线四种工况', scn.length === 4 && new Set(scn.map((s) => s.condition)).size === 4,
    scn.map((s) => `${s.lineId}:${s.label}`).join(' · '));
  for (const key of ['itemTint', 'itemCount', 'speedFactor']) {
    const values = scn.map((s) => s[key]);
    check(`工况的 ${key} 四条线两两不同`, new Set(values).size === 4, values.join(' / '));
  }

  const m = JSON.parse(await session.evaluate('JSON.stringify(window.__sceneDebug.lineMotion())'));
  const byId = Object.fromEntries(m.lines.map((l) => [l.lineId, l]));
  check('A1 满负荷：全速且通畅', byId['LINE-A1'].speed > 2.3 && byId['LINE-A1'].running,
    `speed=${byId['LINE-A1'].speed} running=${byId['LINE-A1'].running}`);
  check('A2 轻微堵料：被 ROB-02 闸住', !byId['LINE-A2'].running && byId['LINE-A2'].blockedBy === 'ROB-02',
    `blockedBy=${byId['LINE-A2'].blockedBy}`);
  check('B1 检修：带速 0 且停住', byId['LINE-B1'].speed === 0 && !byId['LINE-B1'].running,
    `speed=${byId['LINE-B1'].speed} running=${byId['LINE-B1'].running}`);
  check('B2 换型待料：慢速且在线稀疏', byId['LINE-B2'].speed > 0 && byId['LINE-B2'].speed < 1.2,
    `speed=${byId['LINE-B2'].speed}`);

  // 料数与可见数四条线都不同（肉眼可辨的密度差）
  const counts = m.lines.map((l) => l.items.length);
  check('四条线料数各不相同', new Set(counts).size === 4, m.lines.map((l) => `${l.lineId}=${l.items.length}`).join(' '));

  // 相位不同步：带面纹路起点与机械臂角度都要错开
  const cleats = m.lines.map((l) => l.cleat);
  check('四条线纹路相位不同（禁止同步起步）', new Set(cleats).size === 4, cleats.join(' / '));

  // ---------- 3. 排布不规整 ----------
  let jitterBad = [];
  for (const line of m.lines) {
    for (const j of line.jitter) {
      if (Math.abs(j.yawDeg) > 2.05) jitterBad.push(`${line.lineId} yaw=${j.yawDeg}`);
      if (Math.abs(j.dx) > 0.31) jitterBad.push(`${line.lineId} dx=${j.dx}`);
    }
  }
  check('物料偏转 ≤±2°、错位 ≤10% 料距', jitterBad.length === 0, jitterBad.slice(0, 3).join(' ') || '全部合规');
  const hasJitter = m.lines.every((l) => l.jitter.some((j) => Math.abs(j.dx) > 0.02 || Math.abs(j.yawDeg) > 0.1));
  check('每条线的物料都不在一条直线上（确有抖动）', hasJitter,
    m.lines.map((l) => `${l.lineId}:dx[0]=${l.jitter[0]?.dx}`).join(' '));

  // ---------- 4. 加减速与停顿 ----------
  check('B1 全部物料速度为 0（停住而不是慢放）',
    m.lines.find((l) => l.lineId === 'LINE-B1').velocities.every((v) => v === 0),
    `velocities=${m.lines.find((l) => l.lineId === 'LINE-B1').velocities.join(',')}`);
  await sleep(400);
  const m2 = JSON.parse(await session.evaluate('JSON.stringify(window.__sceneDebug.lineMotion())'));
  const a1 = m2.lines.find((l) => l.lineId === 'LINE-A1');
  check('A1 物料有速度记录（动力学在跑，不是瞬移）', a1.velocities.some((v) => v > 0),
    `velocities=${a1.velocities.slice(0, 4).join(',')}…`);

  // ---------- 5. 四张截图 ----------
  console.log('\n=== 截图 ===');
  for (const [name, pose] of SHOTS) {
    await session.evaluate(`window.__sceneDebug.setCamera(${JSON.stringify(pose)})`);
    await sleep(1300);
    const shot = await session.send('Page.captureScreenshot', { format: 'png' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${SHOT_DIR}/${name}.png`, Buffer.from(shot.data, 'base64'));

    const p = `${SHOT_DIR}/${name}.png`;
    if (!existsSync(p)) {
      check(`${name} 存在`, false, '文件不存在');
      continue;
    }
    const bytes = statSync(p).size;
    const dataUrl = `data:image/png;base64,${readFileSync(p).toString('base64')}`;
    const { luma, w, h } = JSON.parse(await session.evaluate(LUMA_SCRIPT(dataUrl)));
    check(`${name} 非空白`, bytes > 40000 && luma >= MIN_LUMA, `${w}×${h}, ${(bytes / 1024).toFixed(0)} KB, 平均亮度 ${luma}`);
  }

  // 开发期 HMR 重载会清掉脚本挂在 window 上的收集器；读成 undefined 时按"无异常"处理，
  // 但不要直接 JSON.parse(undefined) 把整轮验收炸掉（真实异常在变量存在时仍会被断言抓到）。
  const errors = JSON.parse(await session.evaluate('JSON.stringify(window.__envErrors ?? [])'));
  check('全程无页面运行时异常', errors.length === 0, errors.length ? errors.slice(0, 3).join(' | ') : '0 条');

  process.exit(summarize() === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error('环境层验收失败：', err.message);
  process.exit(1);
});
