/**
 * D2 工业道具验收。
 *
 * 三条必须分开判，混在一起会得出错误结论：
 *  1. 道具"建了没有"—— 读 propKinds，不数 mesh（数 mesh 会漏掉 InstancedMesh 里的 120 根栏杆）；
 *  2. 道具"贵不贵"—— 场景口径 draw call ≤100，且三类开销能加回整链；
 *  3. 画面"是不是黑的"—— 解 PNG 算平均亮度，防"文件有 6 张但全是黑屏"。
 *
 * 用法：node scripts/acceptance-d2.mjs [截图目录，默认 output/d2]
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { connect, sleep, check, summarize, WEB } from './lib/cdp.mjs';

const SHOT_DIR = process.argv[2] ?? 'output/d2';
const SCENE_BUDGET = 100;
const MIN_FPS = 50;
const MIN_LUMA = 6; // 平均亮度低于 6 基本就是黑屏（D0 实测正常值约 29）

const REQUIRED_KINDS = ['plinth', 'railing', 'hazard', 'tray', 'pipe', 'rack', 'sign'];
const SHOTS = ['01_overview', '02_ws_a', '03_ws_b', '04_device', '05_line', '06_eye_level'];

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

/** 把 PNG 的 dataURL 交给页面解码，取平均亮度——比在 Node 里手写 PNG 解码稳 */
const LUMA_SCRIPT = (dataUrl) => `
  (() => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      const w = 160; // 缩略后采样即可，不必全分辨率
      const h = Math.max(1, Math.round((img.height / img.width) * w));
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) {
        sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      }
      resolve(JSON.stringify({ luma: Number((sum / (d.length / 4)).toFixed(1)), w: img.width, h: img.height }));
    };
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = ${JSON.stringify(dataUrl)};
  }))()
`;

const main = async () => {
  const session = await connect();
  await session.send('Page.enable');
  await session.send('Page.navigate', { url: `${WEB}/overview` });
  await sleep(400);
  if (!(await session.waitFor('!!window.__sceneDebug?.propKinds && !!document.querySelector("canvas")', 20000))) {
    throw new Error('场景未就绪（__sceneDebug 只在 dev 存在，确认跑的是 dev server）');
  }
  await sleep(2500);

  // 收集 JS 异常：道具新增了大量新几何与贴图，渲染期崩溃会被这里抓到
  await session.evaluate(`
    (() => {
      window.__d2Errors = [];
      window.addEventListener('error', (e) => window.__d2Errors.push(String(e.message)));
      window.addEventListener('unhandledrejection', (e) => window.__d2Errors.push(String(e.reason)));
    })()
  `);

  const kinds = JSON.parse(await session.evaluate('JSON.stringify(window.__sceneDebug.propKinds())'));
  const prof = JSON.parse(await session.evaluate('JSON.stringify(window.__sceneDebug.profile())'));
  const rows = JSON.parse(await session.evaluate('JSON.stringify(window.__sceneDebug.breakdown())'));
  const fps = JSON.parse(await session.evaluate(FPS_SCRIPT));

  console.log('=== 道具类别 ===');
  console.log(kinds.join(', '));
  console.log('\n=== 开销 ===');
  console.log(`场景 ${prof.sceneCalls} / 阴影 ${prof.shadowCalls} / 后处理 ${prof.postPasses} / 整链 ${prof.total}`);
  console.log('--- 分组 ---');
  for (const r of rows) console.log(`${String(r.meshes).padStart(3)} 次  ${String(r.triangles).padStart(6)} tri  ${r.kind}`);

  console.log('\n=== 断言 ===');
  for (const kind of REQUIRED_KINDS) {
    check(`道具类别包含 ${kind}`, kinds.includes(kind), kinds.includes(kind) ? 'ok' : `实际 [${kinds.join(',')}]`);
  }
  check('道具类别 ≥7', kinds.length >= 7, `实际 ${kinds.length} 类`);

  check(`场景 draw call ≤ ${SCENE_BUDGET}`, prof.sceneCalls <= SCENE_BUDGET, `实际 ${prof.sceneCalls}`);
  const sum = prof.sceneCalls + prof.shadowCalls + prof.postPasses;
  check('场景 + 阴影 + 后处理 = 整链', Math.abs(sum - prof.total) <= 2, `${sum} vs ${prof.total}`);

  // 道具只应占个位数到十几次数：如果哪天有人"一根栏杆一个 mesh"，这条会炸
  const propRow = rows.find((r) => r.kind === 'prop');
  check('道具 draw call ≤ 14（7 类道具靠 InstancedMesh/合并压到个位数）',
    !!propRow && propRow.meshes <= 14, propRow ? `实际 ${propRow.meshes}` : '分组里没有 prop');

  check(`fps 中位 ≥ ${MIN_FPS}`, fps.fpsMedian >= MIN_FPS, `实际 ${fps.fpsMedian}`);

  console.log('\n=== 截图 ===');
  for (const name of SHOTS) {
    const p = `${SHOT_DIR}/${name}.png`;
    if (!existsSync(p)) {
      check(`${name} 存在`, false, '文件不存在');
      continue;
    }
    const bytes = statSync(p).size;
    const dataUrl = `data:image/png;base64,${readFileSync(p).toString('base64')}`;
    const { luma, w, h } = JSON.parse(await session.evaluate(LUMA_SCRIPT(dataUrl)));
    const ok = bytes > 40000 && luma >= MIN_LUMA;
    check(`${name} 非空白`, ok, `${w}×${h}, ${(bytes / 1024).toFixed(0)} KB, 平均亮度 ${luma}`);
  }

  const errors = JSON.parse(await session.evaluate('JSON.stringify(window.__d2Errors)'));
  check('全程无页面运行时异常', errors.length === 0, errors.length ? errors.slice(0, 3).join(' | ') : '0 条');

  console.log('\n注：盲测（"没听过项目的人看图能否说出工厂"）是人工项，本脚本不代替。');
  process.exit(summarize() === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error('D2 验收失败：', err.message);
  process.exit(1);
});
