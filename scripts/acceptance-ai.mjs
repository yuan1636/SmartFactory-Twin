/**
 * AI 页验收（spec_phase4 §6.2）：证明页面上的每个数字都能追到一次接口返回。
 *
 * 为什么这件事必须用脚本做：页面上最容易出的错不是"图没画出来"，而是
 * "图上的数字和接口给的不是一回事"——手写一个 0.99 的占位、或者把 recall 读成 precision，
 * 图照样好看，答辩时被问一句就穿。这里逐个把 DOM 里的数字与接口返回比对。
 *
 * 两个关键技术点：
 *
 * 1. **分数曲线用同一个时间窗重放**。页面把本次推理的 [start, end] 写进
 *    `[data-ml-window]`，脚本拿这个窗口再请求一次接口。窗口固定后结果稳定
 *    （模拟器每 2 秒还在写新数据，不同窗口必然对不上，那是假失败）。
 *
 * 2. **降级态用 Fetch 域拦截**，不是改代码或关模型。截住 `/ml/model-info`
 *    返回 `loaded:false`，验证页面换成降级提示、其余区块不消失、不显示 0。
 *    这是 G-01 唯一能被实测的部分：模型挂了系统还能用。
 *
 * 前提：Chrome --remote-debugging-port=9222，前端 5173，后端 8000，模型 artifact 就位。
 * 跑法：node scripts/acceptance-ai.mjs
 */

import { writeFileSync } from 'node:fs';
import { API, check, connect, sleep, summarize, WEB } from './lib/cdp.mjs';

const session = await connect();
await session.send('Page.enable');

/** 页面上抛出的运行时异常全部记下来，最后断言为 0 条。 */
const pageErrors = [];
session.ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') {
    pageErrors.push(message.params.exceptionDetails.text ?? 'unknown');
  }
});
await session.send('Runtime.enable');

const text = (selector) =>
  session.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);

/** 从 "TN 124,810" 这类文本里取出纯数字。 */
const digits = (value) => (value ?? '').replace(/[^\d]/g, '');

/**
 * 打开（或重载）AI 页并等到模型区渲染完。
 * 一律走 reload 而不是改 href：当前页往往就是 /ai，赋相同的 href 不会触发导航，
 * 会读到上一轮留下的 DOM，断言就变成"验上一次的自己"。
 */
async function openAiPage() {
  const path = await session.evaluate('location.pathname');
  if (path !== '/ai') {
    await session.evaluate(`location.href = ${JSON.stringify(`${WEB}/ai`)}`);
  } else {
    await session.evaluate('location.reload()');
  }
  await sleep(1000);
  const ready = await session.waitFor(
    'document.readyState === "complete" && !!document.querySelector("[data-ml-state]")',
    25000,
  );
  if (!ready) throw new Error('AI 页 25 秒内没有渲染出模型区（可能整页崩了，先手动看一眼）');
  // 分数曲线要等一次推理（200ms~2s），最多再等 20 秒
  await session.waitFor('!!document.querySelector("[data-ml-window]")', 20000);
}

console.log('=== 6.2 AI 页：模型输出区 ===');
await openAiPage();
await sleep(800);

// --------------------------------------------------------------------------- //
// 1. 结构：声明条、状态条、旧文案必须消失
// --------------------------------------------------------------------------- //
const body = await session.evaluate('document.body.innerText');
check('6.2 模型区处于 loaded 态', (await session.evaluate('document.querySelector("[data-ml-state]").dataset.mlState')) === 'loaded');
check('6.2 「预留，本阶段不实现」已消失', !body.includes('预留，本阶段不实现'));
check('6.2 「本阶段不含任何模型推理」已消失', !body.includes('本阶段不含任何模型推理'));
check(
  '6.2 声明条写明注入密度为演示设定',
  body.includes('注入密度') && body.includes('演示设定') && body.includes('不代表真实工厂异常率'),
);
check('6.2 声明条写明指标来自离线测试集', body.includes('离线测试集结果'));
check('6.2 面包屑已同步（不再是「仅展示真值」）', !body.includes('仅展示真值'));

// --------------------------------------------------------------------------- //
// 2. 指标卡：逐个与 /ml/model-info 比对
// --------------------------------------------------------------------------- //
const info = await fetch(`${API}/ml/model-info`).then((response) => response.json());
check('6.1 接口报告模型已加载', info.loaded === true, `model_id=${info.model_id}`);

const fields = [
  ['model_id', info.model_id, await text('[data-ml-field="model_id"]')],
  ['threshold', info.threshold?.toFixed(4), await text('[data-ml-field="threshold"]')],
  ['schema_hash', info.schema_hash, await text('[data-ml-field="schema_hash"]')],
];
for (const [name, expected, actual] of fields) {
  check(`6.2 状态条 ${name} 与接口一致`, actual?.trim() === String(expected), `页面「${actual?.trim()}」/ 接口「${expected}」`);
}

const metricCases = [
  ['pr_auc', info.metrics?.pr_auc?.toFixed(4)],
  ['recall', `${(info.metrics.recall * 100).toFixed(2)}%`],
  ['detection_rate', `${(info.metrics.detection_rate * 100).toFixed(2)}%`],
  ['false_alarms', info.metrics.false_alarms_per_device_hour?.toFixed(2)],
];
for (const [key, expected] of metricCases) {
  const shown = (await text(`[data-ml-metric="${key}"]`))?.trim() ?? '';
  // 有的卡带单位（"0.63次/设备·时"），所以比对开头而不是全等
  check(`6.2 指标卡 ${key} 与接口一致`, shown.startsWith(String(expected)), `页面「${shown}」/ 接口「${expected}」`);
}
const testRowHint = await session.evaluate(
  `[...document.querySelectorAll('.metric-card')].map(el => el.innerText).join(' ')`,
);
check(
  '6.2 指标卡标注了测试集规模',
  testRowHint.includes(info.metrics.test_rows.toLocaleString('zh-CN')) &&
    testRowHint.includes(info.metrics.test_positives.toLocaleString('zh-CN')),
  `${info.metrics.test_rows} / ${info.metrics.test_positives}`,
);

// --------------------------------------------------------------------------- //
// 3. 混淆矩阵：四个格子逐个比对
// --------------------------------------------------------------------------- //
const confusion = await fetch(`${API}/ml/anomaly/confusion`).then((response) => response.json());
const cells = [
  ['tn', confusion.matrix[0][0]],
  ['fp', confusion.matrix[0][1]],
  ['fn', confusion.matrix[1][0]],
  ['tp', confusion.matrix[1][1]],
];
for (const [key, expected] of cells) {
  const shown = await text(`[data-ml-confusion="${key}"]`);
  check(`6.2 混淆矩阵 ${key.toUpperCase()} 与接口一致`, digits(shown) === String(expected), `页面「${shown?.trim()}」`);
}
check(
  '6.1 混淆矩阵四格之和等于测试集行数',
  cells.reduce((sum, [, value]) => sum + value, 0) === confusion.test_rows,
  `${confusion.test_rows} 行`,
);

// --------------------------------------------------------------------------- //
// 4. 四模型对比：柱子数量与主模型
// --------------------------------------------------------------------------- //
check('6.2 四模型对比数据齐（4 个基线）', info.baselines.length === 4, info.baselines.map((b) => b.key).join(','));
check(
  '6.2 主模型标记唯一且为 XGBoost',
  info.baselines.filter((b) => b.is_primary).length === 1 &&
    info.baselines.find((b) => b.is_primary)?.key === 'xgboost',
);
check(
  '6.2 四模型对比图已渲染',
  (await session.evaluate('document.body.innerText')).includes('为什么用 XGBoost'),
);
check('6.2 分数曲线图已渲染', (await session.evaluate('document.body.innerText')).includes('异常分数曲线'));

// --------------------------------------------------------------------------- //
// 5. 分数曲线：用页面自己的时间窗重放请求
// --------------------------------------------------------------------------- //
const window = await session.evaluate(`(() => {
  const el = document.querySelector('[data-ml-window]');
  return el ? { start: el.dataset.start, end: el.dataset.end, device: el.dataset.device } : null;
})()`);
check('6.2 页面暴露了推理时间窗（可重放）', Boolean(window), window ? `${window.device} ${window.start} ~ ${window.end}` : '未找到');

if (window) {
  const query = new URLSearchParams({ device_id: window.device, start: window.start, end: window.end });
  const replay = await fetch(`${API}/ml/anomaly/scores?${query}`).then((response) => response.json());

  const cases = [
    ['点数', replay.count, digits(await text('[data-ml-score-count]'))],
    ['判为异常点数', replay.summary.predicted_rows, digits(await text('[data-ml-score-predicted]'))],
    ['真值区间段数', replay.intervals.length, digits(await text('[data-ml-score-intervals]'))],
  ];
  for (const [name, expected, actual] of cases) {
    check(`6.2 分数曲线${name}与同窗重放一致`, String(expected) === String(actual), `页面「${actual}」/ 接口「${expected}」`);
  }
  check(
    '6.2 曲线点数未超上限且未丢原始点',
    replay.count === replay.raw_count && replay.count > 0,
    `${replay.count} / ${replay.raw_count}`,
  );
  check(
    '6.2 模型在该窗口内确实判出了异常',
    replay.summary.predicted_rows > 0,
    `${replay.summary.predicted_rows} 点，最高分 ${replay.summary.max_score}`,
  );
}

// --------------------------------------------------------------------------- //
// 6. 真值区块保留（第 3 阶段的功能没被改坏）
// --------------------------------------------------------------------------- //
check('6.4 异常真值时间轴仍在', body.includes('异常真值时间轴（按设备分行）'));
check('6.4 真值 vs 阈值告警对照仍在', body.includes('真值条数 vs 阈值告警条数'));
check('6.4 异常真值列表仍在', body.includes('异常真值列表'));

// --------------------------------------------------------------------------- //
// 7. 降级态：拦截 /ml/model-info 返回 loaded:false
// --------------------------------------------------------------------------- //
console.log('\n=== 6.3 降级态：模型不可用时页面必须还能用 ===');
const DEGRADED_REASON = '验收脚本注入：模型 artifact 缺失（模拟降级）';
let intercepting = false;

const intercept = async (event) => {
  const message = JSON.parse(event.data);
  if (message.method !== 'Fetch.requestPaused') return;
  const payload = {
    loaded: false,
    degraded_reason: DEGRADED_REASON,
    model_id: 'anomaly-20261124-2143-9ab70b7',
    algorithm: 'xgboost',
    trained_at: null,
    git_commit: null,
    schema_hash: null,
    schema_match: false,
    feature_count: 78,
    dataset_rows: null,
    dataset_positive_rows: null,
    positive_rate: null,
    threshold: null,
    type_labels: [],
    top_features: [],
    baselines: [],
    metrics: null,
    artifacts_dir: '',
  };
  await session.send('Fetch.fulfillRequest', {
    requestId: message.params.requestId,
    responseCode: 200,
    responseHeaders: [
      { name: 'Content-Type', value: 'application/json; charset=utf-8' },
      { name: 'Access-Control-Allow-Origin', value: '*' },
    ],
    body: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
  });
};

try {
  await session.send('Fetch.enable', { patterns: [{ urlPattern: '*/ml/model-info*' }] });
  intercepting = true;
  session.ws.addEventListener('message', intercept);

  await session.evaluate('location.reload()');
  const degradedShown = await session.waitFor('!!document.querySelector("[data-ml-state=\\"degraded\\"]")', 20000);
  check('6.3 模型不可用时页面切到降级态', degradedShown);

  const degradedText = await session.evaluate('document.body.innerText');
  check('6.3 降级原因对用户可见', degradedText.includes(DEGRADED_REASON));
  check('6.3 降级时明说告警仍由阈值规则产生', degradedText.includes('阈值规则产生'));
  check(
    '6.3 降级时不显示任何模型指标（不许出现 0 或占位数字）',
    (await session.evaluate('document.querySelectorAll("[data-ml-metric]").length')) === 0,
  );
  check(
    '6.3 降级时其余区块照常（不白屏）',
    degradedText.includes('异常真值时间轴（按设备分行）') && degradedText.includes('异常真值列表'),
  );
  check(
    '6.3 降级时页面没有抛异常',
    pageErrors.length === 0,
    pageErrors.length ? pageErrors.join(' | ') : '无',
  );
} finally {
  if (intercepting) {
    session.ws.removeEventListener('message', intercept);
    await session.send('Fetch.disable').catch(() => {});
  }
}

// 恢复：验证降级只是临时态，正常加载后指标卡会回来
await openAiPage();
await sleep(1500);
const restored = await session.evaluate('document.querySelector("[data-ml-state]")?.dataset.mlState');
check('6.3 解除拦截后自动恢复为 loaded 态', restored === 'loaded', `data-ml-state=${restored}`);
check(
  '6.3 恢复后指标卡重新出现',
  (await session.evaluate('document.querySelectorAll("[data-ml-metric]").length')) === 4,
);

check('6.2 全程无页面运行时异常', pageErrors.length === 0, pageErrors.length ? pageErrors.join(' | ') : '无');

// --------------------------------------------------------------------------- //
// 8. 截图留档
// --------------------------------------------------------------------------- //
await session.evaluate(`(() => {
  const el = document.querySelector('[data-ml-state]');
  if (el) el.scrollIntoView({ block: 'start' });
  return true;
})()`);
await sleep(600);
const shot = await session.send('Page.captureScreenshot', { format: 'png' });
writeFileSync('output/shot_ai_model.png', Buffer.from(shot.data, 'base64'));
console.log('截图已保存 output/shot_ai_model.png');

process.exit(summarize() === 0 ? 0 : 1);
