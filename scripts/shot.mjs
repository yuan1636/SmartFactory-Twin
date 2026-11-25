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
  const metrics = await session.evaluate(`JSON.stringify({
    width: document.documentElement.scrollWidth,
    height: Math.max(document.body.scrollHeight, document.querySelector('.page-scroll')?.scrollHeight ?? 0),
    dpr: window.devicePixelRatio || 1,
  })`);
  const size = JSON.parse(metrics);
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 1680,
    height: Math.min(4000, size.height),
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(1200);
}

const shot = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log(`已保存 ${out}`);
process.exit(0);
