import { describe, expect, it } from 'vitest';
import { POSTFX } from './postfx';
import { SKY_DISPLAY, SKY_STOPS, SKY_TEXTURE_SIZE, hexToInt } from './sky';

/**
 * 背景是本版最容易"看起来对、其实不对"的地方：
 * 整帧过 ACESFilmic（曝光 1.05），暗色区被压到接近 0——直接把"好看的"深青填进贴图，
 * 屏幕上就是纯黑（填 #0a0f16 → 屏幕 #000102，作者为此连改三次背景）。
 * 所以贴图里填的是反解出来的补偿值。这里用独立的 ACES 正算校验补偿值仍然有效，
 * 与 sky.ts 的推导互为印证——一边算错另一边会先红。
 */
const ACES_IN = [
  [0.59719, 0.35458, 0.04823],
  [0.076, 0.90834, 0.01566],
  [0.0284, 0.13383, 0.83777],
];
const ACES_OUT = [
  [1.60475, -0.53108, -0.07367],
  [-0.10208, 1.10813, -0.00605],
  [-0.00327, -0.07276, 1.07602],
];

const m3 = (m: number[][], v: number[]) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const sat = (x: number) => Math.min(1, Math.max(0, x));
// three 的 ACES 不做输入饱和，先饱和会把高光拍平（曾经算错过一次）
const rrt = (v: number) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** 补偿值过完整管线后的屏幕 RGB（十六进制） */
function displayOf(stops: number): string {
  const n = hexToInt(`#${stops.toString(16).padStart(6, '0')}`);
  const linear = [16, 8, 0].map((sh) => srgbToLinear(((n >> sh) & 255) / 255) * POSTFX.exposure); // R,G,B 顺序
  const toned = m3(ACES_IN, linear).map(rrt).map(sat);
  const out = m3(ACES_OUT, toned).map(sat);
  return (
    '#' +
    out
      .map((c) => Math.round(sat(linearToSrgb(c)) * 255).toString(16).padStart(2, '0'))
      .join('')
  );
}

/** 目标色与实际显示的每通道偏差（0~255） */
function maxChannelDelta(hexA: string, hexB: string): number {
  const a = hexToInt(hexA);
  const b = hexToInt(hexB);
  return Math.max(...[0, 8, 16].map((sh) => Math.abs(((a >> sh) & 255) - ((b >> sh) & 255))));
}

describe('背景：暗青渐变（HUD 同色系）', () => {
  it('补偿值过 ACES 后，屏幕显示与目标色的偏差 ≤ 2/255（暗部压得太狠，补偿必须精确）', () => {
    expect(maxChannelDelta(displayOf(SKY_STOPS.top), SKY_DISPLAY.top)).toBeLessThanOrEqual(2);
    expect(maxChannelDelta(displayOf(SKY_STOPS.bottom), SKY_DISPLAY.bottom)).toBeLessThanOrEqual(2);
  });

  it('背景是暗色：显示亮度远低于 bloom 阈值对应的线性值，不会整屏泛光', () => {
    // 阈值 0.85 对应的显示灰度远亮于背景；退一步直接断言背景显示色足够暗（每通道 < 0x40）
    for (const hex of [SKY_DISPLAY.top, SKY_DISPLAY.bottom]) {
      const n = hexToInt(hex);
      for (const sh of [0, 8, 16]) expect((n >> sh) & 255, hex).toBeLessThan(0x40);
    }
    expect(POSTFX.bloomThreshold).toBeGreaterThan(0.1);
  });

  it('渐变自上而下变亮（近地面端更亮，呼应参考图的地面向远处收光）', () => {
    const t = hexToInt(`#${SKY_STOPS.top.toString(16).padStart(6, '0')}`);
    const b = hexToInt(`#${SKY_STOPS.bottom.toString(16).padStart(6, '0')}`);
    const luma = (n: number) => [16, 8, 0].reduce((acc, sh, i) => acc + [0.2126, 0.7152, 0.0722][i] * ((n >> sh) & 255), 0);
    expect(luma(b)).toBeGreaterThan(luma(t));
  });

  it('贴图是竖向渐变的载体：高度 ≥ 128 才不会出现色带', () => {
    expect(SKY_TEXTURE_SIZE).toBeGreaterThanOrEqual(128);
  });
});
