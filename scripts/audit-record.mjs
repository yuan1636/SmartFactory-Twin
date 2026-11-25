/**
 * D0 现状体检③：录 30 秒演示片段（overview 机位，含物料流动）。
 *
 * 为什么不用 ffmpeg 抓帧：本机没装 ffmpeg。这里用浏览器自带的 MediaRecorder 直接录 canvas 流，
 * 输出 webm（Chrome 可直接播放）。需要 mp4 时再转，命令见 docs/spec_phase4.md §8.4。
 *
 * 关键一点：录完必须**验证它不是黑屏**——WebGL canvas 若没开 preserveDrawingBuffer，
 * captureStream 有可能录出一片全黑。这里把录好的 blob 重新解码、取 1 秒处一帧算平均亮度，
 * 亮度低于 3（0~255）即判定为黑屏并报错，避免"录了个寂寞"还归档。
 *
 * 用法：node scripts/audit-record.mjs [秒数，默认 30]
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { connect, sleep, WEB } from './lib/cdp.mjs';

const SECONDS = Number(process.argv[2] ?? 30);
const OUT_DIR = resolve('output/d0');

const main = async () => {
  mkdirSync(OUT_DIR, { recursive: true });
  const session = await connect();
  await session.send('Page.enable');

  // 允许下载到指定目录，否则 anchor.click() 只会弹保存框
  await session.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: OUT_DIR,
    eventsEnabled: true,
  });

  await session.send('Page.navigate', { url: `${WEB}/overview` });
  await sleep(400);
  const ready = await session.waitFor('!!window.__sceneDebug.setCamera && !!document.querySelector("canvas")', 20000);
  if (!ready) throw new Error('场景未就绪');

  // 固定到总览机位，与 audit-shot 的 01_overview 一致
  await session.evaluate('window.__sceneDebug.setCamera({ position: [0,40,48], target: [0,0,0] })');
  await sleep(1500);

  const script = `
    (async () => {
      const canvas = document.querySelector('canvas');
      if (!canvas) throw new Error('找不到 canvas');
      const stream = canvas.captureStream(30);
      const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
        .find((m) => MediaRecorder.isTypeSupported(m));
      if (!mime) throw new Error('浏览器不支持 MediaRecorder webm');

      const chunks = [];
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 3000000 });
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const stopped = new Promise((r) => { rec.onstop = r; });
      rec.start(1000);
      await new Promise((r) => setTimeout(r, ${SECONDS * 1000}));
      rec.stop();
      await stopped;

      const blob = new Blob(chunks, { type: 'video/webm' });

      // 验收①：把录好的视频解码回来，取 1s 处一帧算平均亮度，防止黑屏入库
      const url = URL.createObjectURL(blob);
      const video = document.createElement('video');
      video.src = url; video.muted = true;
      await new Promise((res, rej) => {
        video.onloadeddata = res;
        video.onerror = () => rej(new Error('解码失败'));
        setTimeout(() => rej(new Error('解码超时')), 8000);
      });
      await new Promise((res) => { video.onseeked = res; video.currentTime = Math.min(1, video.duration / 3); });

      const c2 = document.createElement('canvas');
      c2.width = 320; c2.height = 200;
      const ctx = c2.getContext('2d');
      ctx.drawImage(video, 0, 0, c2.width, c2.height);
      const px = ctx.getImageData(0, 0, c2.width, c2.height).data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) sum += (px[i] + px[i + 1] + px[i + 2]) / 3;
      const meanLuma = sum / (px.length / 4);

      // 验收②：触发下载（走 CDP 的 downloadPath）
      const a = document.createElement('a');
      a.href = url; a.download = 'd0_${SECONDS}s.webm';
      document.body.appendChild(a); a.click(); a.remove();

      return JSON.stringify({ mime, bytes: blob.size, durationSec: Number(video.duration.toFixed(2)), meanLuma: Number(meanLuma.toFixed(1)) });
    })()
  `;

  const raw = await session.evaluate(script);
  const info = JSON.parse(raw);
  await sleep(2500); // 等下载落盘

  const file = resolve(OUT_DIR, `d0_${SECONDS}s.webm`);
  const onDisk = existsSync(file);
  const size = onDisk ? statSync(file).size : 0;

  console.log('=== 录屏结果 ===');
  console.log(`编码        : ${info.mime}`);
  console.log(`时长        : ${info.durationSec} s`);
  console.log(`大小        : ${(info.bytes / 1048576).toFixed(2)} MB`);
  console.log(`1s 处平均亮度: ${info.meanLuma} / 255 ${info.meanLuma < 3 ? '← 黑屏！' : '（有内容）'}`);
  console.log(`落盘        : ${onDisk ? `${file}（${(size / 1048576).toFixed(2)} MB）` : '未找到文件'}`);

  if (info.meanLuma < 3) {
    console.error('\n✗ 录到的是黑屏：canvas.captureStream 拿不到 WebGL 内容。');
    process.exit(2);
  }
  if (!onDisk) {
    console.error('\n✗ 下载未落盘，检查 Browser.setDownloadBehavior 是否生效');
    process.exit(3);
  }
  process.exit(0);
};

main().catch((err) => {
  console.error('录屏失败：', err.message);
  process.exit(1);
});
