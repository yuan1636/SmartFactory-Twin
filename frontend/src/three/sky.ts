/**
 * 三维背景（作者 2026-11-25 第四次调整：整体色调亮化，参考「东方电机智慧车间运营中心」截图）
 *
 * 演变：深色纯色 → 深色渐变+雾 → 白底无雾 → **暗青渐变（HUD 同色系）**。
 *
 * ── 为什么贴图里填的不是"看到的颜色" ──────────────────────────────────────
 * 整帧要过 ACESFilmic（曝光 1.05），暗色区会被压到接近 0（实测填 #0a0f16 → 屏幕 #000102）。
 * 所以贴图里填的是**补偿值**：用 ACES 正算模型逐通道牛顿反解出来的，使屏幕显示正好是
 * SKY_DISPLAY 里的目标色。补偿值与曝光耦合：改 POSTFX.exposure 必须重算，见 sky.test.ts
 * 的正算校验（测试里有独立的 ACES 实现，两条路径互查）。
 *
 * ── 与 bloom 的关系 ────────────────────────────────────────────────────────
 * 暗青背景线性亮度 < 0.05，远低于 POSTFX.bloomThreshold(0.85)，不会泛光；
 * 白底时代的 SKY_INTENSITY=3.0 / 阈值 3.2 约束随之作废。
 */

import * as THREE from 'three';

/** 屏幕上想看到的颜色（与 HUD 外壳 --bg-scene 同一色系） */
export const SKY_DISPLAY = {
  top: '#0d1f28',
  bottom: '#17333d',
} as const;

/** 贴图里实际填的补偿值（ACES 反解，推导见文件头与 sky.test.ts） */
export const SKY_STOPS = {
  top: 0x293e48,
  bottom: 0x35515b,
} as const;

/** 背景亮度倍率：暗色不需要 HDR 推亮，回到 1.0 */
export const SKY_INTENSITY = 1.0;

/** 渐变贴图的竖向分辨率（横向 4px 足够，纯竖向渐变） */
export const SKY_TEXTURE_SIZE = 256;

/** 清屏色 = 渐变底部补偿值（首帧/边缘与画布背景接上） */
export const SKY_CLEAR_HEX = SKY_STOPS.bottom;

/** 16 进制串 → three 用的 0xRRGGBB 整数 */
export function hexToInt(hex: string): number {
  return Number.parseInt(hex.replace('#', ''), 16);
}

/**
 * 暗青竖向渐变贴图。仍用贴图而不是 Color：渐变只有贴图做得了，
 * 且贴图的 colorSpace 必须标 sRGB，否则渐变被当线性值二次编码。
 */
export function makeSkyTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = SKY_TEXTURE_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 canvas 2d 上下文，背景贴图生成失败');
  const grad = ctx.createLinearGradient(0, 0, 0, SKY_TEXTURE_SIZE);
  grad.addColorStop(0, `#${SKY_STOPS.top.toString(16).padStart(6, '0')}`);
  grad.addColorStop(1, `#${SKY_STOPS.bottom.toString(16).padStart(6, '0')}`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}
