/** D3 相机预设约束：坐标写错最便宜的暴露方式是单元测试，不必起浏览器。 */
import { describe, expect, it } from 'vitest';
import { CAMERA_PRESETS, ENTRANCE_START, ORBIT_LIMITS, PRESET_ORDER, focusPose } from './cameraPresets';
import { DEVICE_LAYOUT } from './layout';

type Vec3 = [number, number, number];

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('cameraPresets（D3）', () => {
  it('正好 5 个预设，顺序为 overview / WS-A / WS-B / LINE-A1 / DEVICE（键位 1~5 按它映射）', () => {
    expect(PRESET_ORDER).toEqual(['overview', 'WS-A', 'WS-B', 'LINE-A1', 'DEVICE']);
    expect(Object.keys(CAMERA_PRESETS)).toEqual(PRESET_ORDER);
  });

  it('每个预设都在地面上方，相机-目标距离落在轨道限制内（越界会被 OrbitControls 夹回）', () => {
    for (const key of PRESET_ORDER) {
      const pose = CAMERA_PRESETS[key];
      expect(pose.position[1], key).toBeGreaterThan(0);
      const d = dist(pose.position, pose.target);
      expect(d, key).toBeGreaterThanOrEqual(ORBIT_LIMITS.minDistance);
      expect(d, key).toBeLessThanOrEqual(ORBIT_LIMITS.maxDistance);
    }
  });

  it('DEVICE 静态位姿 = focusPose(CNC-01)：无选中时落点要与「设备跟随」一致', () => {
    const { x, z } = DEVICE_LAYOUT['CNC-01'];
    expect(CAMERA_PRESETS.DEVICE).toEqual(focusPose(x, z));
  });

  it('LINE-A1 看向 A1 产线中段（z=-7.5，x 在色带 -34..-6 之间）', () => {
    const target = CAMERA_PRESETS['LINE-A1'].target;
    expect(target[2]).toBeCloseTo(-7.5);
    expect(target[0]).toBeGreaterThan(-34);
    expect(target[0]).toBeLessThan(-6);
  });

  it('入场起点在场外（x 或 z 超出厂区半宽），且距原点 < maxDistance（否则第一帧被夹回）', () => {
    const p = ENTRANCE_START.position;
    expect(Math.abs(p[0]) > 40 || Math.abs(p[2]) > 30).toBe(true);
    expect(dist(p, ENTRANCE_START.target)).toBeLessThan(ORBIT_LIMITS.maxDistance);
  });
});
