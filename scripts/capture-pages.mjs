/**
 * capture-pages.mjs —— 五个页面截图，供 README / 文档使用。
 *
 * 前提：Chrome --remote-debugging-port=9222，前端 5173，后端 8000。
 * 用法：node scripts/capture-pages.mjs [输出目录，默认 docs/img]
 *
 * 每页导航后先核实 location.pathname 与预期一致再拍，避免 SPA 时序
 * 导致拍错页（2026-11-27 实测踩过：截图时机早于路由切换，两张图同页）。
 */
import { connect, sleep } from './lib/cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2] || 'docs/img';
const BASE = 'http://127.0.0.1:5173';

// [文件名, 路径, 额外等待 ms]（三维页入场动画约 3 s，给足余量）
const PAGES = [
  ['overview', '/overview', 9_000],
  ['devices', '/devices', 5_000],
  ['production', '/production', 5_000],
  ['alerts', '/alerts', 5_000],
  ['ai', '/ai', 6_000],
];

const s = await connect();
await s.send('Page.enable');
await s.send('Runtime.enable');
await s.send('Emulation.setDeviceMetricsOverride', {
  width: 1600,
  height: 900,
  deviceScaleFactor: 1, // 1 倍：五张合计约 1.4 MB；1.5 倍约 3.9 MB，不值得
  mobile: false,
});

mkdirSync(OUT, { recursive: true });

for (const [name, path, wait] of PAGES) {
  await s.send('Page.navigate', { url: BASE + path });
  await sleep(wait);

  // 核实真实落点，防止拍错页（/devices 会自动带上选中设备 → /devices/AIR-01）
  const actual = await s.evaluate('location.pathname');
  if (actual !== path && !actual.startsWith(path + '/')) {
    throw new Error(`${path} 落点不符：实际 ${actual}`);
  }

  const shot = await s.send('Page.captureScreenshot', { format: 'png' });
  const file = join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log(`${name} → ${file}（${Math.round(shot.data.length / 1024)} KB）`);
}
process.exit(0);
