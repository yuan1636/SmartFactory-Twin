/**
 * D0 现状体检②：采集 3 个性能基线 + 首屏可交互时间。
 *
 * 三个基线：draw call / 三角形 / fps（5 秒 rAF 中位数）。
 * 为什么不用角标的 fps：角标是 500ms 窗口取整，波动大，会得出"49 还是 50"的无意义争论。
 *
 * 首屏可交互的口径（本文件定义，别处不许自创）：
 *   navigationStart → 第一次「canvas 已有尺寸且渲染循环跑过一帧」的时刻。
 * 不用 FCP：FCP 是 HTML 文本首次绘制的时刻，那时三维画布还是空的，对"能看"没有意义。
 *
 * 前提：dev 前端（5173）+ 窗口化 Chrome（有 GPU）。无头是 SwiftShader，帧率不作数。
 * 用法：node scripts/audit-baseline.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { connect, sleep, WEB } from './lib/cdp.mjs';

/** 注入到新文档最早时机：记录三维首帧与 DOM 就绪 */
const INIT = `
  (() => {
    window.__boot = { start: performance.now(), firstFrameAt: null, domReadyAt: null, rafCount: 0 };
    document.addEventListener('DOMContentLoaded', () => { window.__boot.domReadyAt = performance.now(); });
    const tick = () => {
      window.__boot.rafCount++;
      if (window.__boot.firstFrameAt === null) {
        const c = document.querySelector('canvas');
        if (c && c.width > 0 && c.height > 0) window.__boot.firstFrameAt = performance.now();
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })();
`;

const main = async () => {
  const session = await connect();
  await session.send('Page.enable');
  await session.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT });

  // 冷加载：显式 Page.navigate，保证走一次完整导航（不是 SPA 内跳转）
  await session.send('Page.navigate', { url: `${WEB}/overview` });
  await sleep(300);
  const loaded = await session.waitFor(
    'window.__boot && window.__boot.firstFrameAt !== null && !!window.__sceneDebug',
    20000,
  );
  if (!loaded) throw new Error('首帧未在 20 秒内出现，检查前端是否在 dev 模式运行');

  const boot = await session.evaluate('JSON.stringify(window.__boot)');
  const b = JSON.parse(boot);

  // fps：rAF 采样 5 秒，取每帧间隔的中位数再换算
  const fpsScript = `
    (() => new Promise((resolve) => {
      const gaps = [];
      let last = performance.now();
      const t0 = last;
      const tick = (now) => {
        gaps.push(now - last); last = now;
        if (now - t0 < 5000) requestAnimationFrame(tick);
        else {
          const sorted = gaps.slice(1).sort((a, b) => a - b);
          const med = sorted[Math.floor(sorted.length / 2)];
          resolve(JSON.stringify({
            frames: gaps.length,
            medianGapMs: Number(med.toFixed(2)),
            fpsMedian: Number((1000 / med).toFixed(1)),
            p95GapMs: Number(sorted[Math.floor(sorted.length * 0.95)].toFixed(2)),
          }));
        }
      };
      requestAnimationFrame(tick);
    }))()
  `;
  const fps = JSON.parse(await session.evaluate(fpsScript));

  // draw call：三次采样取最大（render.calls 每帧重置，单次可能撞上 UI 重绘帧）
  const calls = [];
  for (let i = 0; i < 3; i += 1) {
    calls.push(JSON.parse(await session.evaluate('JSON.stringify(window.__sceneDebug.renderInfo())')));
    await sleep(400);
  }

  const result = {
    measuredAt: new Date().toISOString(),
    // 首屏：以 navigationStart(=0) 到首帧为准
    firstCanvasFrameMs: Math.round(b.firstFrameAt),
    domReadyMs: Math.round(b.domReadyAt ?? 0),
    fps,
    calls: calls.map((c) => c.calls),
    callsMax: Math.max(...calls.map((c) => c.calls)),
    triangles: calls[0].triangles,
    badgeFps: calls[calls.length - 1].fps,
    renderer: await session.evaluate(
      '(() => { const c = document.querySelector("canvas"); const gl = c && (c.getContext("webgl2") || c.getContext("webgl")); const d = gl && gl.getExtension("WEBGL_debug_renderer_info"); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "unknown"; })()',
    ),
  };

  mkdirSync('output/d0', { recursive: true });
  writeFileSync('output/d0/baseline.json', JSON.stringify(result, null, 2));

  console.log('=== D0 性能基线 ===');
  console.log(`渲染器        : ${result.renderer}`);
  console.log(`首屏可交互    : ${result.firstCanvasFrameMs} ms（DOM 就绪 ${result.domReadyMs} ms）`);
  console.log(`fps           : 中位 ${fps.fpsMedian}（间隔中位 ${fps.medianGapMs} ms，p95 ${fps.p95GapMs} ms，${fps.frames} 帧 / 5s）`);
  console.log(`draw call     : 三次 ${result.calls.join(' / ')}，取最大 ${result.callsMax}`);
  console.log(`三角形        : ${result.triangles}`);
  console.log(`角标 fps      : ${result.badgeFps}（仅参考，不作验收依据）`);
  console.log('\n已写 output/d0/baseline.json');

  if (/swiftshader|software/i.test(result.renderer)) {
    console.log('\n⚠ 检测到软件渲染（SwiftShader）：帧率数字不可用于验收，请换窗口化 Chrome 重跑。');
  }
  process.exit(0);
};

main().catch((err) => {
  console.error('基线采集失败：', err.message);
  process.exit(1);
});
