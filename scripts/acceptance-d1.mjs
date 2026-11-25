/**
 * D1 视觉基调验收：后处理参数是否就是规格 §6.1 那张表，以及增量开销是否在预算内。
 *
 * 两个数字必须分开看，否则会得出相反结论：
 *  - sceneCalls：只含场景（合批管这个，D2 的 ≤100 按它判）
 *  - calls     ：场景 + 阴影 + 全部后处理 pass（真实 GPU 开销，D1 的增量预算按它判）
 *
 * 用法：node scripts/acceptance-d1.mjs
 */

import { readFileSync } from 'node:fs';
import { connect, sleep, check, summarize, WEB } from './lib/cdp.mjs';

const ACES = 4; // THREE.ACESFilmicToneMapping
// sceneDelta 的相对基准见 D-45：D0 的 108 是旧计数口径，D1 改为显式 reset 后同场景为 132（半透明墙）/ 120（实墙），
// 因此这里改判「场景 ≤100 目标」与「D1 不引入额外场景几何」两条，而不是硬扣 108。
const BUDGET = { sceneTarget: 100, fpsDropPct: 15 };

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** rAF 采样 5 秒取间隔中位数，与 audit-baseline 同一口径 */
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

const main = async () => {
  const before = readJson('output/d0/baseline.json');
  const session = await connect();
  await session.send('Page.enable');
  // 必须 Page.navigate：同址赋 href 不会重载，会拿到上一次挂载的旧调试对象（D-24 的同类坑）
  await session.send('Page.navigate', { url: `${WEB}/overview` });
  await sleep(400);
  if (!(await session.waitFor('!!window.__sceneDebug?.postfx && !!document.querySelector("canvas")', 20000))) {
    throw new Error('场景未就绪（是不是跑在生产构建？__sceneDebug 只在 dev 存在）');
  }
  await sleep(2500); // 让模拟器快照与标签稳定

  const p = JSON.parse(await session.evaluate('JSON.stringify(window.__sceneDebug.postfx())'));
  console.log('=== 后处理参数 ===');
  console.log(JSON.stringify(p, null, 1));

  check('toneMapping 为 ACESFilmic（4）', p.toneMapping === ACES, `实际 ${p.toneMapping}`);
  check('曝光在 1.00~1.10', p.exposure >= 1.0 && p.exposure <= 1.1, `实际 ${p.exposure}`);
  check(
    'pass 链为 RenderPass → UnrealBloomPass → OutputPass → SMAAPass',
    p.passes.join(',') === 'RenderPass,UnrealBloomPass,OutputPass,SMAAPass',
    p.passes.join(' → '),
  );
  check('OutputPass 在 SMAA 之前（LDR 上做边缘检测）', p.passes.indexOf('OutputPass') < p.passes.indexOf('SMAAPass'));
  check(
    'Bloom 三项（0.35 / 0.6 / 3.2）',
    Math.abs(p.bloom.strength - 0.35) < 0.01
      && Math.abs(p.bloom.radius - 0.6) < 0.01
      // 阈值 0.85→3.2：作者 2026-11-25 要求白底，白底线性 3.0，阈值低于它会整屏泛白（即"雾感"）
      && Math.abs(p.bloom.threshold - 3.2) < 0.01,
    `${p.bloom.strength} / ${p.bloom.radius} / ${p.bloom.threshold}`,
  );
  // 作者 2026-11-25 三改：near 28→26/far 120→110 → 背景改渐变 → 「不要迷雾，背景换白色」。
  // 本版雾已移除（scene.fog = null），这条断言从此前的"雾参数对不对"改成"雾确实没了"。
  check('雾已移除（作者要求「不要迷雾」）', p.fog === null,
    p.fog ? `仍有雾 ${p.fog.color} ${p.fog.near}~${p.fog.far}` : 'scene.fog = null');

  // 先读整链总数，再测场景自身（measureSceneCalls 会额外渲一帧，必须在前面读）
  const prof = JSON.parse(await session.evaluate('JSON.stringify(window.__sceneDebug.profile())'));
  const fps = JSON.parse(await session.evaluate(FPS_SCRIPT));

  const baselineCalls = before.callsMax ?? before.calls; // D0 的 calls 是三次采样数组，取最大值
  console.log('\n=== 开销对比（D0 → D1）===');
  console.log(`场景 draw call   : ${baselineCalls} → ${prof.sceneCalls}（Δ ${prof.sceneCalls - baselineCalls}）`);
  console.log(`  ├ 阴影 pass    : ${prof.shadowCalls}\n  ├ 后处理 pass  : ${prof.postPasses}\n  └ 整链合计     : ${prof.total}`);
  console.log(`三角形           : ${before.triangles} → ${prof.sceneTriangles}`);
  console.log(`fps 中位         : ${before.fps.fpsMedian} → ${fps.fpsMedian}`);

  const delta = prof.sceneCalls - baselineCalls;
  check(`场景 draw call 仍在可合批范围（≤ ${BUDGET.sceneTarget + 40}）`, prof.sceneCalls <= BUDGET.sceneTarget + 40, `实际 ${prof.sceneCalls}，D2 目标 ≤${BUDGET.sceneTarget}`);
  // 三项拆分必须能加回总数，这是"统计没算漏"的硬证据（D0 的 108 是旧口径，不与本项比较，见 D-45）
  const sum = prof.sceneCalls + prof.shadowCalls + prof.postPasses;
  check('场景 + 阴影 + 后处理 = 整链 draw call', Math.abs(sum - prof.total) <= 2,
    `${prof.sceneCalls} + ${prof.shadowCalls} + ${prof.postPasses} = ${sum}（整链 ${prof.total}）`);

  const dropPct = ((before.fps.fpsMedian - fps.fpsMedian) / before.fps.fpsMedian) * 100;
  check(`fps 降幅 ≤ ${BUDGET.fpsDropPct}%`, dropPct <= BUDGET.fpsDropPct, `实际 ${dropPct.toFixed(1)}%`);

  // 144Hz 屏会把 fps 顶在上限，降幅自然接近 0——这不是"没有开销"，要如实说明
  if (fps.fpsMedian >= 140) {
    console.log('\n注：fps 已顶到 144Hz 刷新上限，降幅不可用于判断开销大小；开销请看 draw call 与三角形。');
  }

  process.exit(summarize() === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error('D1 验收失败：', err.message);
  process.exit(1);
});
