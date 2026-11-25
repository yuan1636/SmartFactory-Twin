/**
 * 产线运行动画的页面级验收（规格 6.7 / 10.2-13）。
 *
 * 验的是「真在动」和「动得对」，不是"看起来在动"：
 *  - 每条产线的闸门开合必须等于实时设备状态表（不是写死哪条线该堵）；
 *  - 通畅产线：物料沿流向位移、带面纹路滚动、滚筒自转、机器人摆动；
 *  - 被挡产线：物料停在被停下设备的入口前，后排按料距排队；
 *  - prefers-reduced-motion：两次采样完全一致（冻住），而不是仅仅变慢。
 *
 * 期望值全部从运行时的 deviceStates() 推导，状态变了脚本不会假通过也不会假失败。
 * 前提：Chrome 以 --remote-debugging-port=9222 启动，前端在 127.0.0.1:5173，后端在 8000。
 * 用法：node scripts/acceptance-motion.mjs
 */

import { check, connect, sleep, summarize } from './lib/cdp.mjs';

/** 与 motion.ts 一致：只有这两种状态算通路 */
const OPEN_STATES = new Set(['RUNNING', 'IDLE']);
const ITEM_SPACING = 3.0;
const MAX_STEP_PER_SEC = 5; // dt 钳制 0.1s × 带速 2.4 的理论上限留余量

const round = (n) => Math.round(n * 100) / 100;

const snapshotOf = (s) => s.evaluate('window.__sceneDebug.lineMotion()');
const statesOf = (s) => s.evaluate('window.__sceneDebug.deviceStates()');

async function waitConnected(s) {
  return s.waitFor(
    'Array.from(document.querySelectorAll(".conn")).some((el) => el.textContent.includes("实时已连接"))',
    15000,
  );
}

async function openOverview(s) {
  await s.goto('/overview');
  const ready = await s.waitFor('!!window.__sceneDebug && !!window.__sceneDebug.lineMotion', 15000);
  if (!ready) throw new Error('三维调试钩子没出现（__sceneDebug.lineMotion）');
  // 必须等 WS 真正连上：未连上时所有设备无状态、闸门全关，会把通畅产线误判成堵死
  if (!(await waitConnected(s))) throw new Error('WS 15 秒内未连上，先确认后端 8000 与模拟器在跑');
}

async function checkGates(s) {
  await openOverview(s);
  const m = await snapshotOf(s);
  const states = await statesOf(s);

  check('四条产线都有物料', m.lines.length === 4, m.lines.map((l) => `${l.lineId}:${l.items.length}`).join(' '));

  // 闸门开合必须等于"该设备此刻不在 RUNNING/IDLE"
  const mismatch = [];
  for (const line of m.lines) {
    for (const gate of line.gates) {
      const expected = !OPEN_STATES.has(states[gate.deviceId]);
      if (gate.closed !== expected) {
        mismatch.push(`${gate.deviceId}(状态${states[gate.deviceId]}，闸门${gate.closed ? '关' : '开'})`);
      }
    }
  }
  check('6.7 闸门开合与设备状态表一致', mismatch.length === 0, mismatch.join(' ') || `${m.lines.reduce((n, l) => n + l.gates.length, 0)} 个闸门`);

  // running / blockedBy 必须与闸门自洽：blockedBy 指的是流向最上游那个关着的闸门
  const incoherent = m.lines.filter((line) => {
    const closed = line.gates.filter((g) => g.closed);
    const frontByFlow = [...closed].sort((a, b) => a.x - b.x)[0];
    return line.running !== (closed.length === 0) || (line.blockedBy ?? null) !== (frontByFlow?.deviceId ?? null);
  });
  check(
    '6.7 running / blockedBy 与闸门自洽',
    incoherent.length === 0,
    incoherent.map((l) => `${l.lineId}(running=${l.running},blockedBy=${l.blockedBy})`).join(' ') ||
      m.lines.map((l) => `${l.lineId}:${l.running ? '通' : `堵@${l.blockedBy}`}`).join(' '),
  );

  // 本批起四条线四种工况（料数 9/8/6/5），阈值按各自工况的料数取 min(5, itemCount)
  const scn = await s.evaluate('window.__sceneDebug.scenario().reduce((a, x) => (a[x.lineId] = x, a), {})');
  check(
    '每条产线上都有可见物料（不是空跑）',
    m.lines.every((l) => l.visibleItems >= Math.min(5, scn[l.lineId]?.itemCount ?? 5)),
    m.lines.map((l) => `${l.lineId}=${l.visibleItems}/${l.items.length}`).join(' '),
  );
  return m;
}

async function checkMovement(s, m0) {
  // 取速度最高且通畅的线：B2 是 0.84 m/s 的换型待料，2 秒位移太小，不能当样本
  const free = m0.lines.filter((l) => l.running && l.speed > 0).sort((a, b) => b.speed - a.speed)[0];
  if (!free) {
    check('存在通畅产线（否则位移断言无从谈起）', false, '四条线全被挡住，请先确认设备状态');
    return;
  }

  const span = 34 - 6; // 仅用于把"回炉"折算成正向位移；四条线色带长度都是 28m
  await sleep(2000);
  const m1 = await snapshotOf(s);
  const lineAfter = m1.lines.find((l) => l.lineId === free.lineId);
  const deltas = lineAfter.items.map((x, i) => x - free.items[i]);
  // 回炉那一下是 end→start 的跳变，折算成"等效前进"再判断
  const forward = deltas.map((d) => (d < 0 ? d + span : d));

  check(
    `6.7 通畅产线（${free.lineId}）物料整体沿 +X 前移`,
    forward.every((d) => d > 0.1),
    `等效位移 ${forward.map(round).join(',')} m`,
  );
  check(
    '6.7 位移没有瞬移（dt 钳制生效）',
    forward.every((d) => d < MAX_STEP_PER_SEC),
    `最大 ${round(Math.max(...forward))} m / 2s`,
  );

  // 本批起纹路跟随本线带速：B1 检修（速度 0）纹路本来就不该动，只查有速度的线
  const moving = m1.lines.filter((l) => l.speed > 0);
  const cleatMoved = moving.every((l) => {
    const before = m0.lines.find((x) => x.lineId === l.lineId);
    return Math.abs(l.cleat - before.cleat) > 0.05;
  });
  check('6.7 带面纹路随本线带速滚动（速度 0 的线不动）', cleatMoved,
    moving.map((l) => `${l.lineId}:${m0.lines.find((x) => x.lineId === l.lineId).cleat}→${l.cleat}`).join(' '));
}

async function checkQueue(s, m0) {
  const states = await statesOf(s);
  // 选"稳定"的关闸样本：维护中/停机是设备级事实，不会像告警那样随遥测抖动；
  // 只有全都是告警时才退而用告警，否则队列会在采样过程中反复散掉。
  const candidates = [];
  for (const line of m0.lines) {
    // 冻结线（本批的 B1 检修，速度 0）不会自己把料喂到闸门前，排队现象只在有速度的线上发生
    if (line.speed === 0) continue;
    for (const gate of line.gates.filter((g) => g.closed)) {
      candidates.push({ line, gate, state: states[gate.deviceId] });
    }
  }
  const stable = candidates.filter((c) => c.state === 'MAINTENANCE' || c.state === 'STOPPED');
  const pick = (stable.length > 0 ? stable : candidates)[0];

  if (!pick) {
    check('存在被挡住的产线（堵料断言的样本）', false, '四条线都通畅，无法验证物料是否停在设备前');
    return;
  }
  console.log(`  排队样本：${pick.line.lineId} 上的 ${pick.gate.deviceId}（状态 ${pick.state}）`);

  // 队列是"喂"出来的：先让下游的料走空、回炉的料走到闸门前排好，最多等 24 秒。
  // 注意 sleep 必须在分支外，否则闸门一开一合就可能把 60 次采样在 2 秒内跑完。
  let line = pick.line;
  let queued = [];
  let settled = false;
  for (let i = 0; i < 60; i += 1) {
    const m = await snapshotOf(s);
    line = m.lines.find((l) => l.lineId === pick.line.lineId);
    const gate = line.gates.find((g) => g.deviceId === pick.gate.deviceId);
    if (gate && gate.closed) {
      queued = line.items.filter((x) => x <= gate.x + 0.05 && x >= line.start - 0.5).sort((a, b) => b - a);
      if (queued.length >= 2 && Math.abs(queued[0] - gate.x) < 0.3 && Math.abs(queued[1] - (gate.x - ITEM_SPACING)) < 0.3) {
        settled = true;
        break;
      }
    }
    await sleep(400);
  }

  const gate = line.gates.find((g) => g.deviceId === pick.gate.deviceId);
  check(
    `6.7 物料停在 ${pick.gate.deviceId} 入口前（期望 ${round(gate.x)}）`,
    settled,
    `队首 ${queued[0] === undefined ? '无' : queued[0]}，队列 ${queued.map(round).join(',') || '空'}`,
  );
  if (!settled) {
    check('6.7 堵料时后排按料距排队', false, '队列未排满，本条未取到样本');
    return;
  }

  const gaps = queued.slice(0, -1).map((x, i) => round(x - queued[i + 1]));
  check(
    '6.7 堵料时后排按料距排队',
    Math.abs(gaps[0] - ITEM_SPACING) < 0.3,
    `队首间距 ${gaps[0]}（期望 ${ITEM_SPACING}），完整队列 ${queued.map(round).join(',')}`,
  );
  // 队列后面可能还有第二个关着的闸门（本例 A1 的 CNC-01 也在告警），
  // 所以只对"队首间距"下断言；但任何情况下都不允许有物料停在闸门下游的穿模区
  const crossed = line.items.filter((x) => x > gate.x && x < gate.x + 0.6);
  check('6.7 没有物料穿过关着的闸门', crossed.length === 0, crossed.map(round).join(',') || '无');
}

async function checkSpinAndArms(s) {
  const states = await statesOf(s);
  const m0 = await snapshotOf(s);
  await sleep(1200);
  const m1 = await snapshotOf(s);

  const roller = m0.rollers.find((r) => OPEN_STATES.has(states[r.deviceId]));
  if (roller) {
    const after = m1.rollers.find((r) => r.deviceId === roller.deviceId);
    check('6.7 运行中的输送机滚筒自转', roller.spinning && after.spinning && after.angle !== roller.angle,
      `${roller.deviceId} ${roller.angle} → ${after.angle}`);
  } else {
    check('6.7 运行中的输送机滚筒自转', false, '没有处于运行中的输送机');
  }

  const stoppedRoller = m0.rollers.find((r) => !OPEN_STATES.has(states[r.deviceId]));
  if (stoppedRoller) {
    const after = m1.rollers.find((r) => r.deviceId === stoppedRoller.deviceId);
    check('6.7 非运行状态的输送机滚筒停转', !after.spinning && after.angle === stoppedRoller.angle,
      `${stoppedRoller.deviceId} angle ${stoppedRoller.angle} → ${after.angle}`);
  } else {
    console.log('  （没有处于停机/维护/告警的输送机，滚筒停转分支本次未取到样本）');
  }

  const armRunning = m0.arms.find((a) => OPEN_STATES.has(states[a.deviceId]));
  const armStopped = m0.arms.find((a) => !OPEN_STATES.has(states[a.deviceId]));
  check('6.7 运行中的机器人在摆动',
    Boolean(armRunning) && m1.arms.find((a) => a.deviceId === armRunning.deviceId).angle !== armRunning.angle,
    armRunning ? `${armRunning.deviceId} ${armRunning.angle} → ${m1.arms.find((a) => a.deviceId === armRunning.deviceId).angle} rad` : '没有运行中的机器人');
  if (armStopped) {
    check('6.7 非运行状态的机器人停止摆动',
      m1.arms.find((a) => a.deviceId === armStopped.deviceId).angle === armStopped.angle,
      `${armStopped.deviceId} ${armStopped.angle} → ${m1.arms.find((a) => a.deviceId === armStopped.deviceId).angle} rad`);
  }

  // 第 4 阶段统一口径（规格 §4 第 1 条 / D-41）：预算按「场景」算 ≤100；
  // 整链 = 场景 + 阴影 + 后处理，只作信息打印（第 3 阶段的 150 整链旧口径已作废）
  const stats = await s.evaluate('window.__sceneDebug.profile()');
  check('9 场景 draw call 在预算内（≤100，第 4 阶段口径）', stats.sceneCalls <= 100,
    `${stats.sceneCalls} 场景 + ${stats.shadowCalls} 阴影 + ${stats.postPasses} 后处理 = ${stats.total} 整链`);
}

async function checkReducedMotion(s) {
  await s.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await s.evaluate('location.reload()');
  await sleep(1200);
  const ready = await s.waitFor('!!window.__sceneDebug && !!window.__sceneDebug.lineMotion', 15000);
  const linked = await waitConnected(s);
  check('动效降级后页面仍可用', ready);

  const a = await snapshotOf(s);
  await sleep(1500);
  const b = await snapshotOf(s);
  const frozen = JSON.stringify(a.lines) === JSON.stringify(b.lines) && JSON.stringify(a.rollers) === JSON.stringify(b.rollers);
  check('4.3 prefers-reduced-motion 时产线完全冻结（不是变慢）', frozen && a.paused === true,
    `paused=${a.paused}，WS 已连=${linked}，物料抽样 ${JSON.stringify(a.lines[0].items.slice(0, 3))}`);

  // 还原媒体特性，避免影响后续人工验收
  await s.send('Emulation.setEmulatedMedia', { media: '', features: [] });
  await s.evaluate('location.reload()');
  await sleep(1200);
  const restored = await s.waitFor('!!window.__sceneDebug && !!window.__sceneDebug.lineMotion', 15000);
  await waitConnected(s);
  const c0 = await snapshotOf(s);
  await sleep(1200);
  const c1 = await snapshotOf(s);
  check('还原媒体特性后动画恢复', restored && JSON.stringify(c0.lines) !== JSON.stringify(c1.lines));
}

const session = await connect();
try {
  const m0 = await checkGates(session);
  await checkMovement(session, m0);
  await checkQueue(session, m0);
  await checkSpinAndArms(session);
  await checkReducedMotion(session);
} finally {
  session.ws.close();
}

process.exit(summarize() === 0 ? 0 : 1);
