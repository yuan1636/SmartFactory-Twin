/**
 * Batch 2 页面级验收脚本（Chrome DevTools Protocol 驱动无头浏览器）。
 *
 * 为什么需要它：10.2 第 10 项要求「点解除后 Toast 文案正确」，第 11/12 项要求页面数字自洽、
 * AI 页没有编造指标。这些只有真的点一下才能验，dump-dom 拿不到点击后的结果。
 *
 * 前提：本机 Chrome 已用 --remote-debugging-port=9222 启动，且前端跑在 127.0.0.1:5173。
 * 用法：node scripts/acceptance-batch2.mjs
 */

import { API, check, connect, results, sleep, summarize } from './lib/cdp.mjs';

/**
 * 造一条未解除告警，供「解除」流程验收。
 *
 * 走正常 API 而不是直接改库：要验的是"扫描任务真的把超温判成告警"这条链路。
 * 两个细节来自 docs/acceptance_phase3.md 5.1 的踩坑记录：
 * - 时间戳必须带毫秒，否则与模拟器的整 2 秒栅格撞主键，返回 409；
 * - 同设备同类型有 5 分钟冷却，撞上会被静默跳过，所以按设备顺序逐个试。
 *
 * 副作用：会在库里留下一条 95℃ 的遥测，AI 页的分数曲线会把它算成一个异常点。
 * 这是可接受的——它是真实的超温读数，模型判它异常本来就没错。
 */
async function injectOpenAlarm() {
  // 先排除 5 分钟内已经报过温度告警的设备：同设备同类型有 5 分钟冷却（G-09），
  // 撞上冷却期这次注入会被静默跳过，表现出来就是"等了半天没告警"。
  const recent = await fetch(`${API}/alarms?page=1&page_size=200`).then((r) => r.json());
  const now = Date.now();
  const cooling = new Set(
    (recent.items ?? [])
      .filter(
        (a) =>
          a.alarm_type === 'TEMPERATURE' &&
          now - new Date(a.detected_at).getTime() < 5 * 60 * 1000,
      )
      .map((a) => a.device_id),
  );
  const target = ['CNC-01', 'CNC-04', 'CNC-02', 'CNC-03', 'INSP-01', 'ROB-02'].find(
    (deviceId) => !cooling.has(deviceId),
  );
  if (!target) {
    console.log('  候选设备全部处于 5 分钟冷却中，跳过注入');
    return false;
  }

  // 只让温度超限，其余指标取该设备正常区间的中值。
  // 不能把振动/电流写死（原来的 2.0 / 9.5 是按 CNC 的阈值定的）：INSP-01 的振动
  // 严重阈值只有 1.88、电流 3.75，一次注入会同时生成 TEMPERATURE / VIBRATION /
  // CURRENT 三条告警（2026-11-25 实测），"解除"验收就变成了三选一，语义错乱。
  const detail = await fetch(`${API}/devices/${target}`).then((r) => r.json());
  const range = detail.metrics_normal_range ?? {};
  const middle = (metric, fallback) => {
    const bounds = range[metric];
    return bounds ? Number(((bounds.min + bounds.max) / 2).toFixed(2)) : fallback;
  };
  // 温度取该设备正常上限 ×1.35：既超过 critical（×1.25），又不至于离谱
  const temperature = Number((((range.temperature?.max ?? 70) * 1.35)).toFixed(1));

  const ts = new Date(Date.now() - 7500).toISOString();
  const response = await fetch(`${API}/telemetry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: target,
      ts,
      temperature,
      vibration: middle('vibration', 2.0),
      current: middle('current', 8.0),
      speed: middle('speed', 1500),
      running_status: 'RUNNING',
    }),
  });
  if (!response.ok) {
    console.log(`  注入失败：HTTP ${response.status}（${target} @ ${ts}）`);
    return false;
  }

  // 只等这一台，不再换设备重试。
  // 原实现是"15 秒没等到告警就换下一台接着注入"，实测一次运行会往 4 台设备各写
  // 一条 95℃（2026-11-25 复现），事后要逐条清理，而且 AI 页会多出一串假尖峰。
  // 扫描周期 5 秒，25 秒等不到说明扫描任务有问题，该报错而不是继续污染数据。
  for (let i = 0; i < 25; i += 1) {
    await sleep(1000);
    const open = await fetch(`${API}/alarms?resolved=false&page=1&page_size=1`).then((r) => r.json());
    if (open.total > 0) {
      console.log(`  已注入未解除告警：${target} 温度 ${temperature}℃ @ ${ts}`);
      return true;
    }
  }
  console.log(`  注入到 ${target} 后 25 秒仍未生成告警，请检查后端告警扫描任务`);
  return false;
}

async function checkAlerts(s) {
  await s.goto('/alerts');
  const ready = await s.waitFor('document.querySelector(".table") || document.querySelector(".state-block")', 10000);
  check('告警页渲染', ready, ready ? '' : '10 秒内既没有表格也没有空态');

  const kpi = await s.evaluate(`
    Array.from(document.querySelectorAll('.metric-card')).map((c) => ({
      label: c.querySelector('.metric-card__label')?.textContent?.trim() ?? '',
      value: c.querySelector('.metric-card__value')?.textContent?.trim() === '' ? '' : c.querySelector('.metric-card__value')?.textContent?.trim() ?? '',
    }))
  `);
  console.log('  告警 KPI：', JSON.stringify(kpi));

  // 不能按索引取「第二张表」：告警为空时列表渲染的是空态，第一张 .table 其实是维护记录，
  // tables[1] 直接 undefined（2026-11-25 实测：未解除告警 0 条时误报"没有第二张表"）。
  // 按卡片标题定位才稳。
  const MAINT_CARD = `[...document.querySelectorAll('.card')]
    .find((c) => c.querySelector('.card__title')?.textContent.trim() === '维护记录')`;
  await s.waitFor(`(() => { const c = ${MAINT_CARD}; return Boolean(c && c.querySelector('.table')); })()`, 12000);
  const maintRows = await s.evaluate(`(() => {
    const card = ${MAINT_CARD};
    if (!card) return -1;
    const table = card.querySelector('.table');
    return table ? table.querySelectorAll('tbody tr').length : 0;
  })()`);
  check('维护记录表有数据', maintRows > 0, maintRows < 0 ? '页面上没有维护记录卡片' : `${maintRows} 行`);

  // 没有未解除告警时先造一条：否则这条断言永远依赖"上一次运行留下的数据"。
  // 注入方式与 docs/acceptance_phase3.md 5.1 一致（时间戳带毫秒，避开模拟器的整 2 秒栅格）。
  let armed = await s.evaluate('document.querySelectorAll(".table button.btn--primary").length > 0');
  if (!armed) {
    armed = await injectOpenAlarm();
    if (armed) {
      await s.goto('/alerts');
      await s.waitFor('document.querySelectorAll(".table button.btn--primary").length > 0', 15000);
    }
  }

  const clicked = await s.evaluate(`(() => {
    const btn = document.querySelector('.table button.btn--primary');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);

  if (!clicked) {
    check('解除按钮存在', false, '注入告警后仍没有解除按钮（后端扫描任务可能没在跑）');
    return;
  }
  check('解除按钮存在', true, armed ? '现场注入并等待告警落库' : '');

  await sleep(1500);
  const toasts = await s.evaluate(`Array.from(document.querySelectorAll('.toast')).map((t) => t.textContent.trim())`);
  const text = toasts.join(' | ');
  console.log('  Toast：', text || '（无）');
  const g10 = /已解除 1 条/.test(text) && (/仍有 \d+ 条/.test(text) || /已无未解除告警/.test(text));
  check('10.2-10 解除 Toast 复述 G-10 结果', g10, text);
}

async function checkProduction(s) {
  await s.goto('/production');
  const ready = await s.waitFor('document.querySelectorAll(".metric-card").length >= 4');
  check('生产页 KPI 渲染', ready);

  // 卡片先渲染、数据后到，中间态是「—／等待数据」。只等卡片数量会在数据到达前就断言，
  // 表现为"页面 — / 接口 96.6%"这种假失败（2026-11-25 实测复现）。要等值真的填上。
  await s.waitFor(
    `[...document.querySelectorAll('.metric-card__value')]
       .every((el) => el.textContent.trim() !== '' && !el.textContent.includes('—'))`,
    15000,
  );

  const cards = await s.evaluate(`
    Array.from(document.querySelectorAll('.metric-card')).map((c) => ({
      label: c.querySelector('.metric-card__label')?.textContent?.trim() ?? '',
      value: c.querySelector('.metric-card__value')?.firstChild?.textContent?.trim() ?? '',
      delta: c.querySelector('.metric-card__delta')?.textContent?.trim() ?? '',
    }))
  `);
  console.log('  生产 KPI：', JSON.stringify(cards));

  // 起止必须同一次取时：分开取会把 24 小时撑成 86400.002 秒，后端直接 400
  const endMs = Date.now();
  const startIso = new Date(endMs - 24 * 3600 * 1000).toISOString();
  const endIso = new Date(endMs).toISOString();
  const stats = await fetch(
    `${API}/stats/production?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`,
  ).then((r) => r.json());

  const expectRate = `${(stats.qualified_rate * 100).toFixed(1)}%`;
  const shownRate = cards.find((c) => c.label === '合格率')?.value ?? '';
  check('10.2-11 合格率与后端一致', shownRate === expectRate, `页面 ${shownRate} / 接口 ${expectRate}`);

  const shownOrders = cards.find((c) => c.label === '已完成订单')?.value ?? '';
  check(
    '10.2-11 已完成订单与后端一致',
    shownOrders === String(stats.orders_completed),
    `页面 ${shownOrders} / 接口 ${stats.orders_completed}`,
  );

  const rows = await s.evaluate('document.querySelectorAll(".table tbody tr").length');
  check('订单表有数据', rows > 0, `${rows} 行`);

  const order = await fetch(`${API}/orders?page=1&page_size=20`).then((r) => r.json());
  const first = order.items[0];
  const firstRow = await s.evaluate(
    'Array.from(document.querySelectorAll(".table tbody tr")).slice(0,1).map(tr => Array.from(tr.children).map(td => td.textContent.trim()))',
  );
  if (first && firstRow.length > 0) {
    check('订单首行与接口一致', firstRow[0][0] === first.order_id, `页面 ${firstRow[0][0]} / 接口 ${first.order_id}`);
  }

  const bars = await s.evaluate('document.querySelectorAll(".chart-grid canvas").length');
  check('两张图表已绘制', bars >= 2, `${bars} 个 canvas`);
}

async function checkAi(s) {
  await s.goto('/ai');
  const ready = await s.waitFor('document.querySelector(".notice-bar")');
  check('AI 页声明条存在', ready);

  const body = await s.evaluate('document.body.innerText');
  const notice = await s.evaluate('document.querySelector(".notice-bar")?.innerText ?? ""');
  // 第 4 阶段 4.2 起这一页有模型了，第 3 阶段的「不含模型推理」断言已作废，
  // 换成等价的合规要求：必须写明指标来源（离线测试集）与注入密度的演示性质。
  check(
    '10.2-12 声明条写明指标来源与演示性质',
    /离线测试集结果/.test(notice) && /注入密度/.test(notice) && /演示设定/.test(notice),
    notice.slice(0, 48).replace(/\s+/g, ' '),
  );

  const banned = /准确率|故障概率|预计故障|模型置信度|预测准确/.exec(body);
  check('10.2-12 页面无编造的模型指标', banned === null, banned ? `出现「${banned[0]}」` : '未发现');

  // 预留虚线框在第 4 阶段已被真实模型区取代，断言随之换成"模型区存在"。
  check(
    '10.2-12 模型输出区存在（原预留框已替换）',
    await s.evaluate('Boolean(document.querySelector("[data-ml-state]"))'),
  );

  const canvases = await s.evaluate('document.querySelectorAll("canvas").length');
  check('AI 页两张图已绘制', canvases >= 2, `${canvases} 个 canvas`);

  const rows = await s.evaluate('document.querySelectorAll(".table tbody tr").length');
  check('真值表有数据', rows > 0, `${rows} 行`);
}


async function checkOverview3D(s) {
  await s.goto('/overview');
  const labels = await s.evaluate('document.querySelectorAll("[data-device-label]").length');
  check('三维设备标签 14 个', labels === 14, `${labels} 个`);

  const cam0 = await s.evaluate('window.__sceneDebug?.camera?.() ?? null');
  if (!cam0) {
    check('相机调试钩子可用', false, 'window.__sceneDebug.camera 不存在');
    return;
  }
  check('相机调试钩子可用', true);

  const clicked = await s.evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll('.viewport__overlay-top button'))
      .find((b) => b.textContent.trim() === 'WS-A');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  check('相机预设按钮存在', clicked);

  await sleep(150);
  const camMid = await s.evaluate('window.__sceneDebug.camera()');
  await sleep(900);
  const camEnd = await s.evaluate('window.__sceneDebug.camera()');

  const near = (a, b, tol = 0.6) => Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol && Math.abs(a[2] - b[2]) < tol;
  check(
    '10.2-7 预设切换到 WS-A 的终点位姿正确',
    near(camEnd.position, [-20, 26, 34]),
    `终点 ${camEnd.position.map((n) => n.toFixed(1)).join(',')}`,
  );
  // 600ms 缓动：150ms 时既不在起点也不在终点，才算真的"缓动"而不是瞬移
  const tweening = !near(camMid.position, cam0.position, 0.3) && !near(camMid.position, camEnd.position, 0.3);
  check('10.2-7 切换过程有缓动（非瞬移）', tweening, `中途 ${camMid.position.map((n) => n.toFixed(1)).join(',')}`);
  check('10.2-7 镜头不低于地面', camEnd.position[1] > 0, `y=${camEnd.position[1].toFixed(1)}`);

  // 点标签所在位置 = 穿过 DOM 标签点到 canvas，由射线拾取选中设备
  const target = await s.evaluate(`(() => {
    const el = document.querySelector('[data-device-label]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), id: el.getAttribute('data-device-label') };
  })()`);
  if (!target) {
    check('10.2-6 点击设备跳转', false, '没找到设备标签');
    return;
  }

  // hover：命中设备时该设备标签应加上 is-active（规格 6.3 的 hover 反馈在 DOM 上的唯一痕迹）
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, buttons: 0 });
  await sleep(400);
  const hovered = await s.evaluate(
    `document.querySelector('[data-device-label="${target.id}"]')?.classList.contains('is-active') ?? false`,
  );
  check('10.2-6 hover 有高亮反馈', hovered, `标签 ${target.id}`);

  // D3（偏差 D-55）起：三维点击不再跳转监控页，而是选中 + 侧栏弹设备详情 + 镜头推近；
  // 跳转能力保留在详情卡的「查看监控页」按钮里，原「跳转到监控页」断言随之改写。
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, buttons: 0 });
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1, buttons: 1 });
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(1200);

  const path = await s.evaluate('location.pathname');
  const title = await s.evaluate('document.querySelector(\'[data-testid="device-detail-title"]\')?.textContent ?? null');
  check(
    '10.2-6 点击设备弹出侧栏详情（不跳转，偏差 D-55）',
    path.startsWith('/overview') && title === target.id,
    `路径 ${path}，详情标题 ${title}`,
  );
}

const session = await connect();
try {
  await checkOverview3D(session);
  await checkAlerts(session);
  await checkProduction(session);
  await checkAi(session);
} finally {
  session.ws.close();
}

process.exit(summarize() === 0 ? 0 : 1);
