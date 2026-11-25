/**
 * 三维背景（作者 2026-11-25 第三次调整：「不要迷雾，把背景颜色换成白色」）
 *
 * 演变：深色纯色 → 深色竖向渐变（+ 雾 26~110）→ **白底、无雾**。
 * 前两版作者都嫌黑/有雾感，本版直接给白底，雾一并去掉（`scene.fog = null`）。
 *
 * ── 为什么不是 `scene.background = new THREE.Color(0xffffff)` ──────────────
 * 1. Color 背景走 `gl.clearColor`，值被夹在 [0,1]；整帧还要过 ACESFilmic（曝光 1.05），
 *    线性 1.0 映射后屏幕上只有 **#d1d1d1**——是浅灰不是白。
 * 2. 贴图背景有 `scene.backgroundIntensity`，可以把值推过 1 进 HDR，才拿得到真正的白。
 *    实测（ACES 正算）：线性 1.0 → #d1d1d1；2.0 → #e9e9e9；3.0 → #f1f1f1。
 *
 * ── 代价：背景被推到 3.0，会顶到 bloom 阈值 ────────────────────────────────
 * 白底在线性空间是 3.0，只要 bloom 阈值低于它，整屏就会蒙一层白光——正是作者要去的"雾感"。
 * 所以 `POSTFX.bloomThreshold` 必须 > `SKY_INTENSITY`，`sky.test.ts` 里有这条约束断言。
 */

import * as THREE from 'three';

/** 作者要的白：贴图本身是纯白，靠 backgroundIntensity 在 HDR 空间推到 #f1f1f1 */
export const SKY_COLOR = '#ffffff';

/**
 * 背景亮度倍率。取 3.0：屏幕显示 #f1f1f1（ACES 滚降很硬，1.0 时只有 #d1d1d1）。
 * 改这个值必须同时改 `POSTFX.bloomThreshold`（保持严格大于），否则白底会泛光。
 */
export const SKY_INTENSITY = 3.0;

/** 白底贴图不需要尺寸，4×4 足够（只是给 backgroundIntensity 一个载体） */
export const SKY_TEXTURE_SIZE = 4;

/** 16 进制串 → three 用的 0xRRGGBB 整数 */
export function hexToInt(hex: string): number {
  return Number.parseInt(hex.replace('#', ''), 16);
}

/**
 * 纯白贴图。用贴图而不是 Color 的唯一理由：Color 走 clearColor 会被夹到 1.0，
 * 贴图才有 `backgroundIntensity` 可以推到 HDR（见文件头）。
 */
export function makeSkyTexture(): THREE.CanvasTexture {
  const size = SKY_TEXTURE_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 canvas 2d 上下文，背景贴图生成失败');
  ctx.fillStyle = SKY_COLOR;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  // 必须标 sRGB：白不受影响，但换回带色背景时标错会被当线性值二次编码
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}
