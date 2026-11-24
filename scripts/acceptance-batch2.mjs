/**
 * Batch 2 页面级验收脚本（Chrome DevTools Protocol 驱动无头浏览器）。
 *
 * 为什么需要它：10.2 第 10 项要求「点解除后 Toast 文案正确」，第 11/12 项要求页面数字自洽、
 * AI 页没有编造指标。这些只有真的点一下才能验，dump-dom 拿不到点击后的结果。
 *
 * 前提：本机 Chrome 已用 --remote-debugging-port=9222 启动，且前端跑在 127.0.0.1:5173。
 * 用法：node scripts/acceptance-batch2.mjs
 */

const CDP = 'http://127.0.0.1:9222';
const WEB = 'http://127.0.0.1:5173';
const API = 'http://127.0.0.1:8000/api/v1';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  · ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pickPage() {
  for (let i = 0; i < 30; i += 1) {
    try {
      const list = await fetch(`${CDP}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // 浏览器还没起来
    }
    await sleep(300);
  }
  throw new Error('无法连上 CDP 9222');
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const out = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (out.exceptionDetails) {
      throw new Error(out.exceptionDetails.text ?? '页面内执行出错');
    }
    return out.result.value;
  }

  async goto(path) {
    await this.evaluate(`location.href = ${JSON.stringify(WEB + path)}`);
    await this.waitFor('document.readyState === "complete" && !!document.querySelector(".side-nav")', 10000);
  }

  async waitFor(expression, timeout = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await this.evaluate(`Boolean(${expression})`)) return true;
      await sleep(200);
    }
    return false;
  }
}

async function connect() {
  const page = await pickPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WS 连接失败')), { once: true });
  });
  const session = new Session(ws);
  await session.send('Runtime.enable');
  return session;
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

  const maintRows = await s.evaluate(`(() => {
    const tables = document.querySelectorAll('.table');
    const second = tables[1];
    return second ? second.querySelectorAll('tbody tr').length : -1;
  })()`);
  check('维护记录表有数据', maintRows > 0, maintRows < 0 ? '页面上没有第二张表' : `${maintRows} 行`);

  const clicked = await s.evaluate(`(() => {
    const btn = document.querySelector('.table button.btn--primary');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);

  if (!clicked) {
    check('解除按钮存在', false, '当前没有未解除告警可点（需先注入告警）');
    return;
  }
  check('解除按钮存在', true);

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
  check(
    '10.2-12 声明条说明「不含模型推理」',
    /本阶段不含任何模型推理/.test(notice),
    notice.slice(0, 40).replace(/\s+/g, ' '),
  );

  const banned = /准确率|故障概率|预计故障|模型置信度|预测准确/.exec(body);
  check('10.2-12 页面无编造的模型指标', banned === null, banned ? `出现「${banned[0]}」` : '未发现');

  check('10.2-12 预留虚线框存在', await s.evaluate('Boolean(document.querySelector(".reserved-box"))'));

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

  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, buttons: 0 });
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1, buttons: 1 });
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(1200);

  const path = await s.evaluate('location.pathname');
  check('10.2-6 点击设备跳转到监控页', path.startsWith('/devices/'), `当前路径 ${path}`);
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

const failed = results.filter((r) => !r.ok);
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
process.exit(failed.length === 0 ? 0 : 1);
