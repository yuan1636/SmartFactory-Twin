/**
 * 截图工具：把浏览器**当前已打开**的页面截下来存成 PNG。
 *
 * 它不接受 URL —— 用之前先让页面停在想看的那一页（例如跑完 acceptance-ai.mjs 会停在 /ai）。
 * 用法：node scripts/shot.mjs output/shot_ai.png [--full]
 *   --full 会先把视口撑到整页高度再截，避免只截到首屏
 */
import { writeFileSync } from 'node:fs';
import { connect, sleep } from './lib/cdp.mjs';

const out = process.argv[2] ?? 'output/shot.png';
const full = process.argv.includes('--full');

const session = await connect();
await session.send('Page.enable');
await sleep(1500);

if (full) {
  // 先滚回顶部：整页截图应当从页面开头算起，否则会截到"从当前滚动位置往下"的一段。
  // 滚动容器是 .content（见 global.css：.content { overflow: auto }），不是 window。
  await session.evaluate(`(() => {
    window.scrollTo(0, 0);
    document.querySelector('.content')?.scrollTo(0, 0);
  })()`);
  await sleep(400);
  const metrics = await session.evaluate(`JSON.stringify({
    width: document.documentElement.scrollWidth,
    height: Math.ceil(
      document.querySelector('.content')?.scrollHeight ||
      document.body.scrollHeight ||
      window.innerHeight
    ),
    dpr: window.devicePixelRatio || 1,
  })`);
  const size = JSON.parse(metrics);
  // 上限只是防呆（AI 页真实高度约 4 千多像素，放宽到 12000 足够覆盖任何页面）
  const height = Math.min(12000, size.height);
  console.log(`整页高度 ${size.height}px，按 ${height}px 截取`);
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1680,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(1200);
}

const shot = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log(`已保存 ${out}`);
process.exit(0);
