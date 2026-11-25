import { describe, expect, it } from 'vitest';
import { POSTFX } from './postfx';
import { SKY_COLOR, SKY_INTENSITY, SKY_TEXTURE_SIZE, hexToInt } from './sky';

/**
 * 背景是本版最容易"看起来对、其实不对"的地方：
 * 白贴图直接放进去，过 ACES 后屏幕上只有 #d1d1d1（浅灰），作者会再次说"发黑"；
 * 而把它推亮到真白，又会顶穿 bloom 阈值，整屏蒙一层白光（正是作者要去的"雾感"）。
 * 这里用 ACES 正算把两个约束都钉死。
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

/** 白色背景（线性 1.0 × intensity）过完整管线后的屏幕灰度 */
function backdropGrey(intensity: number): number {
  const linear = [intensity * POSTFX.exposure, intensity * POSTFX.exposure, intensity * POSTFX.exposure];
  const toned = m3(ACES_IN, linear).map(rrt).map(sat);
  return Math.round(sat(linearToSrgb(sat(m3(ACES_OUT, toned)[0]))) * 255);
}

describe('背景：白底 + 无雾', () => {
  it('背景贴图是纯白', () => {
    expect(SKY_COLOR.toLowerCase()).toBe('#ffffff');
    expect(hexToInt(SKY_COLOR)).toBe(0xffffff);
  });

  it('贴着 intensity=1 放进管线只有浅灰 #d1d1d1（这就是必须走 HDR 的原因）', () => {
    expect(backdropGrey(1)).toBe(0xd1);
  });

  it(`按 SKY_INTENSITY=${SKY_INTENSITY} 推亮后是接近真白（≥ #ee）`, () => {
    expect(backdropGrey(SKY_INTENSITY)).toBeGreaterThanOrEqual(0xee);
  });

  it('白底必须低于 bloom 阈值，否则整屏蒙白光（就是作者说的雾感）', () => {
    expect(POSTFX.bloomThreshold).toBeGreaterThan(SKY_INTENSITY);
  });

  it('贴图只是一个载体，尺寸小到可以忽略显存', () => {
    expect(SKY_TEXTURE_SIZE).toBeLessThanOrEqual(16);
  });
});
