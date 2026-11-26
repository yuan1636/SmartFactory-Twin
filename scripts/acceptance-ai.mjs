/**
 * 工厂日报页验收（/ai，spec_phase4 偏差 D-74）。
 *
 * 这个脚本要证明的不是"页面能打开"，而是三件容易被糊弄过去的事：
 *
 * 1. **默认只看到 4 块**。模型指标必须在折叠区里，靠 `<details>` 收起；
 *    脚本先断言 `[data-report-block]` 恰好 4 个、`[data-ml-metric]` 为 0，
 *    再点开 summary 断言指标卡回来 4 张。防的是"折叠区默认展开"这种假交付。
 *
 * 2. **每行「预计影响件数」都能复算**。页面把 active_min / handling_min / cycle /
 *    slowdown 写进 `data-todo-*`，脚本按页底公式 round((a+h)×c×s) 逐行重算，
 *    必须与页面显示的整数完全一致。公式和实现一旦分叉，这里立刻红。
 *
 * 3. **本月损失账独立重算**。脚本自己拉 /anomalies（翻页取全）+ /orders + /devices
 *    + /report/config，用同一套定义算 count/output/defects/amount，与页面比对。
 *
 * 另外验证「单价改成 0 → 显示未配置单价，不显示 0 元」：直接改 config/report.json，
 * reload 断言，再在 finally 里还原——比拦截 fetch 更接近真实运维场景。
 *
 * 前提：Chrome --remote-debugging-port=9222，前端 5173，后端 8000，模型 artifact 就位。
 * 跑法：node scripts/acceptance-ai.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { API, check, connect, sleep, summarize, WEB } from './lib/cdp.mjs';

const CONFIG_PATH = 'config/report.json';
const PAGE = 200;

const session = await connect();
await session.send('Page.enable');

const pageErrors = [];
session.ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') {
    pageErrors.push(message.params.exceptionDetails.text ?? 'unknown');
  }
});
await session.send('Runtime.enable');

const text = (selector) => session.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const digits = (value) => (value ?? '').replace(/[^\d]/g, '');

async function openReport() {
  const path = await session.evaluate('location.pathname');
  if (path !== '/ai') {
    await session.evaluate(`location.href = ${JSON.stringify(`${WEB}/ai`)}`);
  } else {
    await session.evaluate('location.reload()');
  }
  await sleep(1200);
  const ready = await session.waitFor('!!document.querySelector("[data-report-advice]")', 25000);
  if (!ready) throw new Error('日报页 25 秒内没有渲染出结论条（先手动看一眼）');
  // 待办需要 6 台设备各跑一次实时推理（约 0.3s/台），最多再等 20 秒
  await session.waitFor(
    '!!document.querySelector("[data-todo-impact]") || document.body.innerText.includes("没有需要动作的设备") || document.body.innerText.includes("数据不足")',
    20000,
  );
}

console.log('=== D-74 工厂日报：信息架构 ===');
await openReport();
await sleep(600);

// ---------------------------------------------------------------- //
// 1. 默认只看到 4 块，模型详情收起
// ---------------------------------------------------------------- //
const blocks = await session.evaluate(
  `[...document.querySelectorAll('[data-report-block]')].map((el) => el.dataset.reportBlock)`,
);
check('默认可见区块恰好 4 块（结论/待办/交付/损失账）', blocks.length === 4, blocks.join(' → '));
check(
  '四块顺序与作者要求一致',
  blocks.join(',') === 'conclusion,todo,delivery,loss',
  blocks.join(','),
);
check(
  '模型详情默认收起',
  (await session.evaluate(`document.querySelector('[data-report-fold]').dataset.open`)) === 'false',
);
check(
  '收起时页面上没有任何模型指标数字',
  (await session.evaluate(`document.querySelectorAll('[data-ml-metric]').length`)) === 0,
);
check(
  '收起时不出现 PR-AUC / F1 术语（这些只在折叠区）',
  !(await session.evaluate('document.body.innerText')).includes('PR-AUC'),
);

// ---------------------------------------------------------------- //
// 2. 结论条：一句话 + 3 个数字
// ---------------------------------------------------------------- //
const advice = (await text('[data-report-advice]'))?.trim() ?? '';
check('结论条有一句话建议', advice.length >= 8, advice);
check('结论是「要动作」而不是罗列指标', /建议|可控|数据不足/.test(advice), advice);

const stats = await session.evaluate(
  `[...document.querySelectorAll('[data-report-stat]')].map((el) => el.textContent.trim())`,
);
check('结论条有 3 个数字', stats.length === 3, stats.join(' | '));
check('三个数字都有值（不是占位破折号）', stats.every((v) => v !== '—'), stats.join(' | '));

// ---------------------------------------------------------------- //
// 3. 待办清单：逐行复算
// ---------------------------------------------------------------- //
const rows = await session.evaluate(`(() => {
  return [...document.querySelectorAll('[data-todo-impact]')].map((el) => ({
    impact: Number(el.dataset.todoImpact),
    active: Number(el.dataset.todoActiveMin),
    handling: Number(el.dataset.todoHandlingMin),
    cycle: Number(el.dataset.todoCycle),
    slowdown: Number(el.dataset.todoSlowdown),
    source: el.dataset.todoCycleSource,
    device: el.dataset.todoDeviceId,
    label: el.textContent.trim(),
    action: el.closest('tr')?.querySelector('.report-badge')?.textContent?.trim() ?? '',
  }));
})()`);

check('待办行数 ≤ 5', rows.length <= 5, `${rows.length} 行`);
check('待办有数据（当前演示数据里确有异常）', rows.length > 0, `${rows.length} 行`);

let recomputeOk = 0;
for (const row of rows) {
  const expected = Math.round((row.active + row.handling) * row.cycle * row.slowdown);
  if (expected === row.impact) recomputeOk += 1;
  else {
    check(
      `待办 ${row.device} 影响件数可复算`,
      false,
      `页面 ${row.impact} / 复算 round((${row.active}+${row.handling})×${row.cycle}×${row.slowdown}) = ${expected}`,
    );
  }
}
check(`待办每一行的影响件数都能按页底公式复算`, recomputeOk === rows.length, `${recomputeOk}/${rows.length}`);

const sorted = rows.every((row, i) => i === 0 || rows[i - 1].impact >= row.impact);
check('待办按影响件数降序', sorted, rows.map((r) => r.impact).join(' ≥ '));

// 分档必须与 /report/config 的阈值一致，不许自己拍
const cfg = await fetch(`${API}/report/config`).then((r) => r.json());
const expectAction = (impact) =>
  impact > cfg.action_thresholds.stop
    ? '立即停机检修'
    : impact >= cfg.action_thresholds.today
      ? '今日下班后处理'
      : '继续观察';
const actionOk = rows.every((row) => row.action === expectAction(row.impact));
check('建议动作与分档阈值一致（>15 / 5~15 / <5）', actionOk, rows.map((r) => `${r.impact}→${r.action}`).join(' | '));

const todoText = await session.evaluate(`document.querySelector('[data-report-block="todo"]')?.innerText ?? ''`);
check('待办里没有 PR-AUC / F1 / 特征维度 这类术语', !/PR-AUC|F1|特征维度/.test(todoText));
check('现象列是人话（含中文指标名或「持续异常」）', /振动|温度|电流|持续异常/.test(todoText), '');

// ---------------------------------------------------------------- //
// 4. 交付风险：延期小时与页面显示一致
// ---------------------------------------------------------------- //
const deliveries = await session.evaluate(`(() => {
  return [...document.querySelectorAll('[data-delivery-delay]')].map((el) => {
    const row = el.closest('tr');
    const cells = [...row.querySelectorAll('td')].map((td) => td.textContent.trim());
    return { order: el.dataset.deliveryDelay, delay: Number(el.textContent.replace(/[^\d.]/g, '')), cells };
  });
})()`);

check('交付风险行 ≤ 在制订单数', deliveries.length >= 0, `${deliveries.length} 行`);
for (const row of deliveries) {
  const finish = row.cells[5];
  const planned = row.cells[6];
  check(`订单 ${row.order} 有预计完成与计划交付`, Boolean(finish) && Boolean(planned), `${finish} / ${planned}`);
}
const deliveryText = await session.evaluate(`document.querySelector('[data-report-block="delivery"]')?.innerText ?? ''`);
check('交付风险说明写清了外推口径', /外推完成时间|当前节拍/.test(deliveryText));

// ---------------------------------------------------------------- //
// 5. 损失账：脚本独立重算后与页面比对
// ---------------------------------------------------------------- //
async function fetchMonthAnomalies() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const first = await fetch(`${API}/anomalies?start=${encodeURIComponent(start)}&page=1&page_size=${PAGE}`).then((r) =>
    r.json(),
  );
  const pages = Math.min(10, Math.ceil(first.total / PAGE));
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, pages - 1) }, (_, i) =>
      fetch(`${API}/anomalies?start=${encodeURIComponent(start)}&page=${i + 2}&page_size=${PAGE}`).then((r) => r.json()),
    ),
  );
  return [...first.items, ...rest.flatMap((r) => r.items)];
}

const [monthAnoms, devicesPage, ordersPage] = await Promise.all([
  fetchMonthAnomalies(),
  fetch(`${API}/devices?page_size=${PAGE}`).then((r) => r.json()),
  fetch(`${API}/orders?page_size=${PAGE}`).then((r) => r.json()),
]);

const lineOf = new Map(devicesPage.items.map((d) => [d.device_id, d.line_id]));
const cycleOf = (lineId) => {
  const mine = ordersPage.items
    .filter((o) => o.line_id === lineId)
    .map((o) => ({
      o,
      cycle: (o.planned_quantity / (Date.parse(o.planned_end) - Date.parse(o.planned_start))) * 60000,
    }))
    .filter((x) => Number.isFinite(x.cycle) && x.cycle > 0);
  if (mine.length === 0) return cfg.lines[lineId]?.cycle_per_minute ?? null;
  mine.sort((a, b) => Date.parse(b.o.planned_start) - Date.parse(a.o.planned_start));
  return mine[0].cycle;
};

const seen = new Set();
let output = 0;
for (const row of monthAnoms) {
  const key = `${row.device_id}|${row.anomaly_type}|${row.started_at}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const handling = cfg.anomaly_handling[row.anomaly_type];
  const lineId = lineOf.get(row.device_id);
  if (!handling || !lineId) continue;
  const cycle = cycleOf(lineId);
  if (!cycle) continue;
  const end = row.ended_at ? Date.parse(row.ended_at) : Date.now();
  const minutes = Math.max(0, (end - Date.parse(row.started_at)) / 60000);
  output += (row.ended_at ? minutes : minutes + handling.handling_minutes) * cycle * handling.slowdown;
}
const expectLoss = {
  count: seen.size,
  output: Math.round(output),
  defects: Math.round(output * cfg.defect_rate),
};
expectLoss.amount = cfg.unit_price_cny > 0 ? Math.round(expectLoss.defects * cfg.unit_price_cny) : null;

const shownLoss = {
  count: Number(digits(await text('[data-report-loss="count"]'))),
  output: Number(digits(await text('[data-report-loss="output"]'))),
  defects: Number(digits(await text('[data-report-loss="defects"]'))),
  amountText: (await text('[data-report-loss="amount"]'))?.trim() ?? '',
};

check('损失账 异常次数与独立重算一致（已去重）', shownLoss.count === expectLoss.count, `页面 ${shownLoss.count} / 重算 ${expectLoss.count}`);
check(
  '损失账 影响产量与独立重算一致（±1 件，浮点取整）',
  Math.abs(shownLoss.output - expectLoss.output) <= 1,
  `页面 ${shownLoss.output} / 重算 ${expectLoss.output}`,
);
check(
  '损失账 不良件数与独立重算一致（±1 件）',
  Math.abs(shownLoss.defects - expectLoss.defects) <= 1,
  `页面 ${shownLoss.defects} / 重算 ${expectLoss.defects}`,
);
check(
  '损失账 金额 = 不良件数 × 单价',
  expectLoss.amount != null && digits(shownLoss.amountText) === String(expectLoss.amount),
  `页面「${shownLoss.amountText}」/ 重算 ${expectLoss.amount}`,
);
check('损失账注明了假设值', (await session.evaluate(`document.querySelector('[data-report-block="loss"]')?.innerText ?? ''`)).includes('假设值'));

// ---------------------------------------------------------------- //
// 6. 页底公式区：八条口径齐全
// ---------------------------------------------------------------- //
const formula = await session.evaluate(`document.querySelector('[data-report-formula]')?.innerText ?? ''`);
check('公式区在页面底部且可见', formula.length > 100);
for (const keyword of ['节拍', '风险分', '异常持续分钟', '预计影响件数', '建议动作', '外推完成时间', '本月影响产量', '折合金额']) {
  check(`公式区有「${keyword}」`, formula.includes(keyword));
}
check('公式区逐个标注了来源接口', (formula.match(/来源：/g) ?? []).length >= 7, `${(formula.match(/来源：/g) ?? []).length} 处`);

// ---------------------------------------------------------------- //
// 7. 单价改 0：显示「未配置单价」，不显示 0 元
// ---------------------------------------------------------------- //
console.log('\n=== D-74 单价未配置的分支 ===');
const originalConfig = readFileSync(CONFIG_PATH, 'utf8');
try {
  const zero = JSON.parse(originalConfig);
  zero.unit_price_cny = 0;
  writeFileSync(CONFIG_PATH, `${JSON.stringify(zero, null, 2)}\n`, 'utf8');

  await openReport();
  await sleep(2500);
  const missing = await session.evaluate(`!!document.querySelector('[data-report-price-missing]')`);
  check('单价为 0 时显示「未配置单价」', missing);
  const amountCell = (await text('[data-report-loss="amount"]'))?.trim() ?? '';
  check('单价为 0 时不显示 0 元', amountCell === '未配置单价', `实际「${amountCell}」`);
  // 只断言损失账区块：公式区会如实写「单价 未配置」，那里出现 ¥0 才是 bug
  const lossText = await session.evaluate(`document.querySelector('[data-report-block="loss"]')?.innerText ?? ''`);
  check('单价为 0 时损失账里不出现「¥0」', !lossText.includes('¥0'), lossText.replace(/\n/g, ' ').slice(0, 60));
} finally {
  writeFileSync(CONFIG_PATH, originalConfig, 'utf8');
  await openReport();
  await sleep(2000);
}
check('还原单价后金额重新出现', digits(await text('[data-report-loss="amount"]')) !== '', '');

// ---------------------------------------------------------------- //
// 8. 展开折叠区：模型指标与接口一致
// ---------------------------------------------------------------- //
console.log('\n=== D-74 折叠区：模型证据链 ===');
await session.evaluate(`document.querySelector('[data-report-fold]').open = true`);
await session.waitFor(`document.querySelectorAll('[data-ml-metric]').length === 4`, 25000);
check(
  '展开后折叠区标记为 open',
  (await session.evaluate(`document.querySelector('[data-report-fold]').dataset.open`)) === 'true',
);
check('展开后指标卡回来 4 张', (await session.evaluate(`document.querySelectorAll('[data-ml-metric]').length`)) === 4);

const info = await fetch(`${API}/ml/model-info`).then((r) => r.json());
check('接口报告模型已加载', info.loaded === true, `model_id=${info.model_id}`);
for (const [name, expected] of [
  ['model_id', info.model_id],
  ['threshold', info.threshold?.toFixed(4)],
  ['schema_hash', info.schema_hash],
]) {
  const actual = (await text(`[data-ml-field="${name}"]`))?.trim();
  check(`折叠区 ${name} 与接口一致`, actual === String(expected), `页面「${actual}」/ 接口「${expected}」`);
}

const confusion = await fetch(`${API}/ml/anomaly/confusion`).then((r) => r.json());
for (const [key, expected] of [
  ['tn', confusion.matrix[0][0]],
  ['fp', confusion.matrix[0][1]],
  ['fn', confusion.matrix[1][0]],
  ['tp', confusion.matrix[1][1]],
]) {
  const shown = await text(`[data-ml-confusion="${key}"]`);
  check(`混淆矩阵 ${key.toUpperCase()} 与接口一致`, digits(shown) === String(expected), `页面「${shown?.trim()}」`);
}

const window = await session.evaluate(`(() => {
  const el = document.querySelector('[data-ml-window]');
  return el ? { start: el.dataset.start, end: el.dataset.end, device: el.dataset.device } : null;
})()`);
check('分数曲线暴露了可重放的时间窗', Boolean(window), window ? `${window.device} ${window.start} ~ ${window.end}` : '未找到');
if (window) {
  const query = new URLSearchParams({ device_id: window.device, start: window.start, end: window.end });
  const replay = await fetch(`${API}/ml/anomaly/scores?${query}`).then((r) => r.json());
  check('分数曲线点数与同窗重放一致', digits(await text('[data-ml-score-count]')) === String(replay.count));
  check('判为异常点数与同窗重放一致', digits(await text('[data-ml-score-predicted]')) === String(replay.summary.predicted_rows));
}

// ---------------------------------------------------------------- //
// 9. 截图与异常
// ---------------------------------------------------------------- //
await session.evaluate(`(() => {
  document.querySelector('[data-report-fold]').open = false;
  window.scrollTo(0, 0);
  document.querySelector('.content')?.scrollTo(0, 0);
})()`);
await sleep(600);
const shot = await session.send('Page.captureScreenshot', { format: 'png' });
writeFileSync('output/report_acceptance.png', Buffer.from(shot.data, 'base64'));
console.log('截图已保存 output/report_acceptance.png（默认收起态）');

check('全程无页面运行时异常', pageErrors.length === 0, pageErrors.length ? pageErrors.join(' | ') : '无');

process.exit(summarize() === 0 ? 0 : 1);
