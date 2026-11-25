/**
 * D0 现状体检①：按 6 个「写死在代码里」的机位批量截图。
 *
 * 为什么机位要写死：D1/D2 的前后对比必须是同一双眼睛、同一台相机。
 * 手动拖到"差不多"的位置，两次截图就不是一个机位，对比就退化成"感觉变好了"。
 *
 * 前提：前端跑在 dev（5173）—— `__sceneDebug` 只在 import.meta.env.DEV 下挂载。
 * 用法：node scripts/audit-shot.mjs [输出目录，默认 output/d0]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, sleep, WEB } from './lib/cdp.mjs';

/** 6 个固定机位。坐标取自 cameraPresets.ts 与 layout.ts 的真实设备坐标，不是估的。 */
const POSES = [
  { name: '01_overview', desc: '总览全景（overview 预设）', position: [0, 40, 48], target: [0, 0, 0] },
  { name: '02_ws_a', desc: 'WS-A 车间（WS-A 预设）', position: [-20, 26, 34], target: [-20, 0, 0] },
  { name: '03_ws_b', desc: 'WS-B 车间（WS-B 预设）', position: [20, 26, 34], target: [20, 0, 0] },
  // CNC-01 在 (-31, -7.5)，特写用 focusPose 的同一公式：从东南上方看向设备腰部
  { name: '04_device', desc: 'CNC-01 设备特写', position: [-25, 5, 0.5], target: [-31, 1.2, -7.5] },
  // LINE-A1 色带 x∈[-34,-6], z=-7.5，取线中段侧前方
  { name: '05_line', desc: 'LINE-A1 产线近景（含闸门）', position: [-20, 7, 3], target: [-20, 1.5, -7.5] },
  // 人眼高度：这一张专门用来看地面材质、基座是否悬空、道具是否穿模
  { name: '06_eye_level', desc: '人眼高度（1.6 m）地面视角', position: [-16, 1.6, 10], target: [-16, 1.2, -7.5] },
];

const OUT = process.argv[2] ?? 'output/d0';
const TWEEN_MS = 600; // 与 SceneRoot.tsx 的 TWEEN_MS 一致；截图必须等缓动结束
const SETTLE_MS = 700; // 缓动后再留 100ms 让材质/标签稳定

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  const session = await connect();

  await session.send('Page.enable');
  // 必须用 Page.navigate 而不是 `location.href = 同址`：后者在已处于 /overview 时不触发导航，
  // 会继续用上一轮挂载的旧 __sceneDebug（没有 setCamera），截图全部失败且报错难懂。
  await session.send('Page.navigate', { url: `${WEB}/overview` });
  await sleep(400);
  const ready = await session.waitFor('!!window.__sceneDebug.setCamera && !!document.querySelector("canvas")', 20000);
  if (!ready) throw new Error('场景未就绪：__sceneDebug 或 canvas 不存在（是不是跑在生产构建上？）');

  // 等首帧 + 模拟器第一次快照到位，避免截到"设备全是离线灰"的中间态
  await sleep(2500);

  const rows = [];
  for (const pose of POSES) {
    await session.evaluate(
      `window.__sceneDebug.setCamera({ position: ${JSON.stringify(pose.position)}, target: ${JSON.stringify(pose.target)} })`,
    );
    await sleep(TWEEN_MS + SETTLE_MS);

    const stats = await session.evaluate('JSON.stringify(window.__sceneDebug.renderInfo())');
    const shot = await session.send('Page.captureScreenshot', { format: 'png' });
    const file = join(OUT, `${pose.name}.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));

    const s = JSON.parse(stats);
    rows.push({ ...pose, ...s, file });
    console.log(`OK   ${pose.name.padEnd(14)} ${pose.desc.padEnd(26)} calls=${String(s.calls).padStart(3)} tri=${s.triangles} fps=${s.fps}`);
  }

  // 机位表落盘，供 D1 前后对比时逐项核对
  writeFileSync(join(OUT, 'poses.json'), JSON.stringify(rows, null, 2));
  console.log(`\n共 ${rows.length} 张 → ${OUT}/，机位表 ${OUT}/poses.json`);
  process.exit(0);
};

main().catch((err) => {
  console.error('体检截图失败：', err.message);
  process.exit(1);
});
