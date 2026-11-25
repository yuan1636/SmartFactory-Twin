/** D3 相机预设约束：坐标写错最便宜的暴露方式是单元测试，不必起浏览器。 */
import { describe, expect, it } from 'vitest';
import { CAMERA_PRESETS, ENTRANCE_PATH, ENTRANCE_START, ORBIT_LIMITS, PRESET_ORDER, focusPose, type CameraPose } from './cameraPresets';
import { DEVICE_LAYOUT } from './layout';

type Vec3 = [number, number, number];

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('cameraPresets（D3）', () => {
  it('正好 7 个预设，WALK/AISLE 排在 overview 之后（键位按 PRESET_ORDER 映射）', () => {
    expect(PRESET_ORDER).toEqual(['overview', 'WALK', 'AISLE', 'WS-A', 'WS-B', 'LINE-A1', 'DEVICE']);
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

  it('LINE-A1 看向 A1 产线中段（z=-7.5，x 在色带 -37..-3 之间）', () => {
    const target = CAMERA_PRESETS['LINE-A1'].target;
    expect(target[2]).toBeCloseTo(-7.5);
    expect(target[0]).toBeGreaterThan(-37);
    expect(target[0]).toBeLessThan(-3);
  });

  // ---- R1.5 A 层：人视机位 ----
  it('WALK：人眼高度 1.68、FOV 72、站在 LINE-A1 线头（西端）视线朝 +x 沿产线', () => {
    const p = CAMERA_PRESETS.WALK;
    expect(p.position[1]).toBeCloseTo(1.68, 6);
    expect(p.fov).toBe(72);
    expect(p.position[2]).toBeCloseTo(-7.5, 6);
    expect(p.target[0]).toBeGreaterThan(p.position[0]); // 朝 +x
    expect(p.target[2]).toBeCloseTo(-7.5, 6); // 沿产线纵深，不歪头
    // 站在车间内（墙内），不被剖切规则误判成室外
    expect(p.position[0]).toBeGreaterThan(-37);
  });

  it('AISLE：人眼偏高 1.9、FOV 66、站在中央走廊北端朝 +z 看通道纵深', () => {
    const p = CAMERA_PRESETS.AISLE;
    expect(p.position[1]).toBeCloseTo(1.9, 6);
    expect(p.fov).toBe(66);
    expect(p.position[0]).toBeCloseTo(0, 6);
    expect(p.position[2]).toBeCloseTo(-14, 6);
    expect(p.target[2]).toBeGreaterThan(p.position[2]); // 朝 +z
  });

  it('只有人视机位带 fov，其余用默认 60（DEFAULT_FOV）', () => {
    for (const key of PRESET_ORDER) {
      const fov = (CAMERA_PRESETS[key] as CameraPose).fov;
      if (key === 'WALK') expect(fov).toBe(72);
      else if (key === 'AISLE') expect(fov).toBe(66);
      else expect(fov, key).toBeUndefined();
    }
  });

  it('入场起点在场外（x 或 z 超出厂区半宽），且距原点 < maxDistance（否则第一帧被夹回）', () => {
    const p = ENTRANCE_START.position;
    expect(Math.abs(p[0]) > 40 || Math.abs(p[2]) > 30).toBe(true);
    expect(dist(p, ENTRANCE_START.target)).toBeLessThan(ORBIT_LIMITS.maxDistance);
  });

  // ---- D 批（车间室内化）新增约束 ----
  it('D 批：轨道上限收到 72，总览机位退到 [0,36,46]', () => {
    expect(ORBIT_LIMITS.maxDistance).toBe(72);
    expect(CAMERA_PRESETS.overview.position).toEqual([0, 36, 46]);
  });

  it('D 批：入场终点参数 = 总览机位（否则入场停在 overview 旁边，验收的"终点位姿"会失败）', () => {
    const [x, y, z] = CAMERA_PRESETS.overview.position;
    expect(ENTRANCE_PATH.azimuth1).toBe(0);
    expect(ENTRANCE_PATH.radius1).toBeCloseTo(Math.hypot(x, z), 6);
    expect(ENTRANCE_PATH.height1).toBe(y);
    // 终点按渲染用的球面公式回算，必须落回 overview
    expect(Math.sin(ENTRANCE_PATH.azimuth1) * ENTRANCE_PATH.radius1).toBeCloseTo(x, 6);
    expect(Math.cos(ENTRANCE_PATH.azimuth1) * ENTRANCE_PATH.radius1).toBeCloseTo(z, 6);
  });

  it('D 批：入场起点 = 球面参数算出来的点（起点与路径不一致会导致首帧跳一下）', () => {
    const [x, y, z] = ENTRANCE_START.position;
    expect(Math.sin(ENTRANCE_PATH.azimuth0) * ENTRANCE_PATH.radius0).toBeCloseTo(x, 1);
    expect(ENTRANCE_PATH.height0).toBe(y);
    expect(Math.cos(ENTRANCE_PATH.azimuth0) * ENTRANCE_PATH.radius0).toBeCloseTo(z, 1);
  });
});
