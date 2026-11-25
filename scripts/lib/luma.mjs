/** 从截图 PNG 里算「画布区域」的平均亮度：WebGL 画布不能直接 drawImage 读像素（无 preserveDrawingBuffer），只能截屏后解码 */
import { readFileSync } from 'node:fs';

const SCRIPT = (b64, rect) => `(async () => {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,${b64}'; });
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(${rect.x}, ${rect.y}, ${rect.w}, ${rect.h}).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  return +(sum / (d.length / 4)).toFixed(2);
})()`;

export async function canvasLuma(session, pngPath) {
  const rect = JSON.parse(
    await session.evaluate(
      "JSON.stringify((() => { const c = document.querySelector('canvas'); const r = c.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })())",
    ),
  );
  const b64 = readFileSync(pngPath).toString('base64');
  return { luma: await session.evaluate(SCRIPT(b64, rect)), rect };
}
