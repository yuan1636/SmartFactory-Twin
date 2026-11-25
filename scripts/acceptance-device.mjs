/**
 * 设备建模 v2（第 4 阶段 D 批 R2 / R3）页面级验收，判据见 docs/spec_phase4.md §10.4。
 *
 * 查四件事：逐台部件数 / mesh 数 / 三角数、场景 draw call、三个机位截图非黑屏、拾取仍可用。
 * 帧率这里只记录不判定：CDP 若是无头 Chrome（SwiftShader），数字不作数。
 *
 * 用法：node scripts/acceptance-device.mjs [输出目录] [--expect=14]
 *   R2 只有 4 台 CNC 启用 v2，跑 `--expect=4`；R3 后跑默认 14。
 */

import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, sleep, check, summarize, WEB } from './lib/cdp.mjs';
import { canvasLuma } from './lib/luma.mjs';

const args = process.argv.slice(2);
const OUT = args.find((a) => !a.startsWith('--')) ?? 'output/device';
const EXPECT = Number(args.find((a) => a.startsWith('--expect='))?.split('=')[1] ?? 14);
const MIN_PARTS = { CNC: 12, ROBOT: 8, CONVEYOR: 8, INSPECTION: 8, AIR: 8, PUMP: 8 };
const MAX_MESHES = 3;
const MAX_TRIANGLES = 8000;
const SCENE_BUDGET = 100;
const MIN_LUMA = 6;

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  const session = await connect();
  await session.send('Page.enable');
  await session.send('Page.navigate', { url: `${WEB}/overview` });
  await sleep(400);
  const ready = await session.waitFor(
    '!!window.__sceneDebug?.deviceDetail && !!document.querySelector("canvas")',
    20000,
  );
  if (!ready) throw new Error('场景未就绪：__sceneDebug.deviceDetail 或 canvas 不存在');
  await sleep(2500);

  // ---------- 1. 逐台几何统计 ----------
  const details = JSON.parse(await session.evaluate('JSON.stringify(window.__sceneDebug.deviceDetail())'));
  check(`启用设备建模 v2 的台数 = ${EXPECT}`, details.length === EXPECT, `实际 ${details.length} 台：${details.map((d) => d.id).join(',')}`);
  for (const d of details) {
    const floor = MIN_PARTS[d.key] ?? 8;
    check(`${d.id} 部件类别 ≥ ${floor}`, d.parts >= floor, `实际 ${d.parts}`);
    check(`${d.id} mesh ≤ ${MAX_MESHES}`, d.meshes <= MAX_MESHES, `实际 ${d.meshes}`);
    check(`${d.id} 三角 ≤ ${MAX_TRIANGLES}`, d.triangles <= MAX_TRIANGLES, `实际 ${d.triangles}`);
  }
  const totalTriangles = details.reduce((s, d) => s + d.triangles, 0);
  console.log(`     合计 ${details.length} 台 / ${totalTriangles} 三角，单台最多 ${Math.max(...details.map((d) => d.triangles), 0)}`);

  // ---------- 2. 场景开销（原子读，三项必须加回整链） ----------
  const p = JSON.parse(await session.evaluate('JSON.stringify(window.__sceneDebug.profile())'));
  check(`场景 draw call ≤ ${SCENE_BUDGET}`, p.sceneCalls <= SCENE_BUDGET, `实际 ${p.sceneCalls}`);
  check('场景 + 阴影 + 后处理 = 整链', p.sceneCalls + p.shadowCalls + p.postPasses === p.total,
    `${p.sceneCalls} + ${p.shadowCalls} + ${p.postPasses} = ${p.total}`);
  console.log(`     fps 角标 ${JSON.parse(await session.evaluate('JSON.stringify(window.__sceneDebug.renderInfo())')).fps}（无头环境不作数，仅记录）`);

  // ---------- 3. 三个机位截图 ----------
  const presets = JSON.parse(await session.evaluate('JSON.stringify(window.__sceneDebug.presets())'));
  const byKey = Object.fromEntries(presets.map((x) => [x.key, x]));
  const poses = [
    { name: '01_device', desc: 'CNC-01 正面/右侧', position: [-25, 5, 0.5], target: [-31, 1.2, -7.5] },
    // 专门看 −x 侧面与背面：人眼机位从线头望过来正对这一面，只有正面有细节会露馅
    { name: '01b_side', desc: 'CNC-01 侧面/背面', position: [-37, 3.2, -1.5], target: [-31, 1.3, -7.5] },
    { name: '02_walk', desc: 'WALK 人眼机位', ...(byKey.WALK ?? { position: [-33, 1.68, -7.5], target: [-20, 1.4, -7.5] }) },
    { name: '03_overview', desc: '总览', ...(byKey.overview ?? { position: [0, 36, 46], target: [0, 0, 0] }) },
    // 逐类近景：总览机位太远，认不出结构就只能靠这四张
    { name: '04_robot', desc: 'ROB-01 关节与夹爪', position: [-21.5, 3.2, -3], target: [-25.5, 1.2, -7.5] },
    { name: '05_conveyor', desc: 'CONV-01 支腿与滚筒', position: [-12.5, 3, -2.5], target: [-16, 0.8, -7.5] },
    { name: '06_inspection', desc: 'INSP-01 龙门检测台', position: [25, 3.4, -3], target: [21, 1, -7.5] },
    { name: '07_aux', desc: 'AIR-01 / PUMP-01 动力站', position: [0, 4, 28], target: [0, 1, 22] },
  ];

  for (const pose of poses) {
    await session.evaluate(`window.__sceneDebug.setCamera(${JSON.stringify({ position: pose.position, target: pose.target })})`);
    await sleep(1300);
    const shot = await session.send('Page.captureScreenshot', { format: 'png' });
    const file = join(OUT, `${pose.name}.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    const kb = Math.round(statSync(file).size / 1024);
    const { luma } = await canvasLuma(session, file);
    check(`${pose.name} 非黑屏且有内容`, luma >= MIN_LUMA && kb > 30, `${kb} KB，平均亮度 ${luma}（${pose.desc}）`);
  }

  // ---------- 4. 拾取接口仍在（合并几何不许吃掉 deviceId） ----------
  const anchors = JSON.parse(await session.evaluate('JSON.stringify(window.__sceneDebug.deviceAnchors())'));
  check('14 台设备投影坐标齐备', Object.keys(anchors).length === 14, `实际 ${Object.keys(anchors).length}`);

  console.log(`\n截图 → ${OUT}/`);
  process.exit(summarize() ? 1 : 0);
};

main().catch((err) => {
  console.error('设备建模验收失败：', err.message);
  process.exit(1);
});
