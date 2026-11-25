/**
 * D3 镜头与交互验收（规格 §5.4）。
 *
 * 六条主断言：
 *  ① 入场时长 3.0±0.2 s（读 lastTransitionMs——它记的是「实际」耗时，不是计划值）；
 *  ② 预设数量 = 7（R1.5 起：overview / WALK / AISLE / WS-A / WS-B / LINE-A1 / DEVICE）；
 *  ③ 14 台设备点击命中 100%（投影坐标逐台真实点击，断言侧栏详情标题 = 设备号）；
 *  ④ 5 个预设两两切换 ≤1200 ms（20 个有序对全测）；
 *  ⑤ 切换过程不穿设备（每 50 ms 采相机位置，与设备包围盒求交）；
 *  ⑥ 巡游一圈不重复不跳位（7 站 + 回卷 = 8 站），鼠标点击立即退出。
 * 外加两条回归守卫：场景 draw call ≤100（D2 预算）与 fps 中位数 ≥50。
 *
 * 用法：node scripts/acceptance-d3.mjs
 */

import { connect, sleep, check, summarize, WEB } from './lib/cdp.mjs';

// 按钮文案与预设键的映射（Overview.tsx 的 overlay 按钮）
const LABEL = { overview: '总览', 'WS-A': 'WS-A', 'WS-B': 'WS-B', 'LINE-A1': 'LINE-A1', DEVICE: '设备特写' };
const PRESET_KEYS = Object.keys(LABEL);

const near = (a, b, tol = 0.6) =>
  Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol && Math.abs(a[2] - b[2]) < tol;

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

const cam = async (session) => JSON.parse(await session.evaluate('JSON.stringify(window.__sceneDebug.camera())'));

const clickPreset = async (session, key) => {
  const clicked = await session.evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('.viewport__overlay-top button'))
      .find((x) => x.textContent.trim() === ${JSON.stringify(LABEL[key])});
    if (!b) return false;
    b.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`找不到预设按钮：${LABEL[key]}`);
};

/**
 * 触发一次切换并等它完成。
 * 完成判据是「transitionSeq 变了」+「相机已到终点位姿」：
 * 只看位置会在缓动尾段提前命中，只比耗时不可靠（帧量化下两次耗时可能恰好相等）。
 */
const runSwitch = async (session, toKey, prevSeq) => {
  await clickPreset(session, toKey);
  const pose = JSON.parse(await session.evaluate('JSON.stringify(window.__sceneDebug.presets())'))
    .find((p) => p.key === toKey);
  const t = Date.now();
  while (Date.now() - t < 3000) {
    const c = await cam(session);
    if (c.transitionSeq !== prevSeq && near(c.position, pose.position)) {
      return { ms: c.lastTransitionMs, seq: c.transitionSeq, end: c.position };
    }
    await sleep(60);
  }
  return { ms: null, seq: prevSeq, end: null };
};

const waitPose = async (session, key, timeout = 3000) => {
  const pose = JSON.parse(await session.evaluate('JSON.stringify(window.__sceneDebug.presets())'))
    .find((p) => p.key === key);
  const t = Date.now();
  while (Date.now() - t < timeout) {
    const c = await cam(session);
    if (near(c.position, pose.position)) return true;
    await sleep(80);
  }
  return false;
};

/** 重置视角（回到总览并清选中）：点击会推近相机，任何依赖总览投影的操作前都必须先回位。 */
const resetView = async (session) => {
  await session.evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('.viewport__overlay-top button'))
      .find((x) => x.textContent.trim() === '重置视角');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  const ok = await waitPose(session, 'overview');
  if (!ok) throw new Error('重置视角未回到 overview 位姿');
  await sleep(300); // 等 select(null) 的副作用走完
};

const main = async () => {
  const session = await connect();
  await session.send('Page.enable');

  // —— 冷启动：Page.navigate 强制新文档，入场动画只在冷挂载跑一次 ——
  await session.send('Page.navigate', { url: `${WEB}/overview` });
  await sleep(400);
  if (!(await session.waitFor('!!window.__sceneDebug?.camera && !!document.querySelector("canvas")', 20000))) {
    throw new Error('场景未就绪（__sceneDebug 只在 dev 存在，确认跑的是 dev server）');
  }
  await session.evaluate(`(() => {
    window.__d3Errors = [];
    window.addEventListener('error', (e) => window.__d3Errors.push(String(e.message)));
    window.addEventListener('unhandledrejection', (e) => window.__d3Errors.push(String(e.reason)));
    return true;
  })()`);
  await sleep(500);

  // ① 入场时长
  let entranceMs = null;
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      const c = await cam(session);
      if (c.lastTransitionMs !== null) { entranceMs = c.lastTransitionMs; break; }
      await sleep(150);
    }
  }
  check('入场时长 3.0±0.2 s', entranceMs !== null && entranceMs >= 2800 && entranceMs <= 3200, `${entranceMs} ms`);
  const presets = JSON.parse(await session.evaluate('JSON.stringify(window.__sceneDebug.presets())'));
  const poseOf = Object.fromEntries(presets.map((p) => [p.key, p]));
  const camNow = await cam(session);
  check('入场终点位姿 = overview 预设（绕到了总览，不是半路停住）', near(camNow.position, poseOf.overview.position, 0.8),
    camNow.position.map((n) => n.toFixed(1)).join(','));

  // ② 预设数量
  check('预设数量 = 7（R1.5 加 WALK/AISLE）', presets.length === 7 && PRESET_KEYS.every((k) => presets.some((p) => p.key === k)),
    presets.map((p) => p.key).join(' / '));

  // ③ 14 台点击命中：规格指定测「总览机位」。点击后相机会推近，所以每台都必须
  // 先回总览、重算投影坐标再点——坐标算一次连点会点在旧画面上（第一版就是这么挂的）
  let hits = 0;
  const misses = [];
  const deviceIds = Object.keys(JSON.parse(await session.evaluate('JSON.stringify(window.__sceneDebug.deviceBoxes())')));
  for (const id of deviceIds) {
    await resetView(session);
    const anchors = JSON.parse(await session.evaluate('JSON.stringify(window.__sceneDebug.deviceAnchors())'));
    const a = anchors[id];
    if (!a || a.behind) { misses.push(`${id}(behind)`); continue; }
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y, buttons: 0 });
    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1, buttons: 1 });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: a.x, y: a.y, button: 'left', clickCount: 1, buttons: 0 });
    let ok = false;
    const t1 = Date.now();
    while (Date.now() - t1 < 1600) {
      const title = await session.evaluate('document.querySelector(\'[data-testid="device-detail-title"]\')?.textContent ?? null');
      if (title === id) { ok = true; break; }
      await sleep(120);
    }
    if (ok) hits += 1; else misses.push(id);
  }
  check('14 台点击命中 100%', hits === 14, `${hits} / 14${misses.length ? `，未命中: ${misses.join(',')}` : ''}`);

  // ④ 预设两两切换 ≤1200 ms。先清选中：DEVICE 预设是「跟随选中设备」，
  // 带着残留选中跑落点就不是静态位姿了
  await resetView(session);
  let prevSeq = (await cam(session)).transitionSeq;
  const pairMs = {};
  let maxMs = 0;
  let maxPair = '';
  let badPair = null;
  for (const from of PRESET_KEYS) {
    await clickPreset(session, from);
    const r = await runSwitch(session, from, prevSeq);
    if (r.ms === null) { badPair = `进 ${from}`; break; }
    prevSeq = r.seq;
    for (const to of PRESET_KEYS) {
      if (to === from) continue;
      const r2 = await runSwitch(session, to, prevSeq);
      if (r2.ms === null) { badPair = `${from}→${to}`; break; }
      pairMs[`${from}→${to}`] = r2.ms;
      if (r2.ms > maxMs) { maxMs = r2.ms; maxPair = `${from}→${to}`; }
      prevSeq = r2.seq;
    }
    if (badPair) break;
  }
  check('预设切换 ≤ 1200 ms（20 个有序对）', !badPair && maxMs <= 1200,
    badPair ? `未完成: ${badPair}` : `最大 ${maxMs} ms (${maxPair})`);

  // ⑤ 切换过程不穿设备：挑三条最容易擦机身的路径，50 ms 采样
  await session.evaluate(`(() => {
    window.__camSamples = [];
    window.__camSampler = setInterval(() => {
      window.__camSamples.push(window.__sceneDebug.camera().position.slice());
    }, 50);
    return true;
  })()`);
  for (const [from, to] of [['overview', 'DEVICE'], ['WS-A', 'DEVICE'], ['LINE-A1', 'WS-B']]) {
    await clickPreset(session, from);
    await waitPose(session, from);
    prevSeq = (await cam(session)).transitionSeq;
    const r = await runSwitch(session, to, prevSeq);
    if (r.ms === null) throw new Error(`采样切换 ${from}→${to} 未完成`);
    await sleep(200);
  }
  await session.evaluate('clearInterval(window.__camSampler)');
  const samples = JSON.parse(await session.evaluate('JSON.stringify(window.__camSamples)'));
  const boxes = JSON.parse(await session.evaluate('JSON.stringify(window.__sceneDebug.deviceBoxes())'));
  const MARGIN = 0.4; // 包围盒外扩 0.4 m：擦边也算擦
  let intersect = 0;
  for (const p of samples) {
    for (const b of Object.values(boxes)) {
      if (p[0] > b.min[0] - MARGIN && p[0] < b.max[0] + MARGIN
        && p[1] > b.min[1] - MARGIN && p[1] < b.max[1] + MARGIN
        && p[2] > b.min[2] - MARGIN && p[2] < b.max[2] + MARGIN) {
        intersect += 1;
        break;
      }
    }
  }
  check('切换过程不穿设备', intersect === 0, `采样 ${samples.length} 次, 相交 ${intersect}`);

  // ⑥ 巡游：5 站一圈 + 回卷 = 6 站；点击画面立即退出
  await session.evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('.viewport__overlay-top button'))
      .find((x) => x.textContent.trim() === '巡游');
    if (!b) return false;
    b.click();
    return true;
  })()`);
  const stations = [];
  let cur = null;
  const t2 = Date.now();
  while (Date.now() - t2 < 60000 && stations.length < 8) {
    const tour = JSON.parse(await session.evaluate('JSON.stringify(window.__sceneDebug.tour())'));
    if (tour.active && tour.station !== cur) {
      cur = tour.station;
      stations.push(cur);
    }
    await sleep(400);
  }
  // R1.5：7 个预设一圈 + 回卷 = 8 站；TOUR_INTERVAL 6s × 7 = 42s，等待窗口放宽到 60s
  const lap = ['overview', 'WALK', 'AISLE', 'WS-A', 'WS-B', 'LINE-A1', 'DEVICE'];
  const noRepeat = new Set(stations.slice(0, 7)).size === 7;
  check('巡游一圈不重复不跳位', stations.length >= 8 && stations[7] === stations[0]
    && lap.every((s, i) => stations[i] === s) && noRepeat,
    `${stations.length} 站: ${stations.join(' → ')}`);
  // 鼠标按下立即退出（演示时「镜头自己跑、拉不回来」是规格点名的风险）
  const canvasRect = JSON.parse(await session.evaluate(`JSON.stringify((() => {
    const r = document.querySelector('canvas').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })())`));
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: canvasRect.x, y: canvasRect.y, button: 'left', clickCount: 1, buttons: 1 });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: canvasRect.x, y: canvasRect.y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(300);
  const tourAfter = JSON.parse(await session.evaluate('JSON.stringify(window.__sceneDebug.tour())'));
  check('鼠标点击立即退出巡游', tourAfter.active === false, tourAfter.active ? '仍在巡游' : '已退出');

  // 回归守卫：D2 的 draw call 预算与帧率不能被 D3 破坏
  const prof = JSON.parse(await session.evaluate('JSON.stringify(window.__sceneDebug.profile())'));
  check('场景 draw call ≤ 100（D2 预算守卫）', prof.sceneCalls <= 100, `实际 ${prof.sceneCalls}`);
  const fps = JSON.parse(await session.evaluate(FPS_SCRIPT));
  check('fps 中位 ≥ 50', fps.fpsMedian >= 50, `实际 ${fps.fpsMedian}`);

  const errors = JSON.parse(await session.evaluate('JSON.stringify(window.__d3Errors)'));
  check('全程无页面运行时异常', errors.length === 0, errors.length ? errors.slice(0, 3).join(' | ') : '0 条');

  process.exit(summarize() === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error('D3 验收失败：', err.message);
  process.exit(1);
});
