/**
 * 设备建模 v2 的几何约束（规格 §10.4）。
 * 坐标写错、部件越过包围盒、合并失败，最便宜的暴露方式都是单测，不必起浏览器。
 */
import { describe, expect, it } from 'vitest';
import {
  ARM_PIVOT_Y,
  DETAIL_LAMP_Y,
  DEVICE_PARTS,
  DETAIL_LIMITS,
  buildDeviceDetail,
  partKindsOf,
  type DevicePart,
  type DevicePartKey,
} from './deviceDetail';
import { DEVICE_SIZES } from './layout';

/** 操作件（把手 / 面板 / 法兰）本来就该凸出机身，给 0.15 m 容差；贴地暗晕不参与相机避障，单独跳过 */
const PROTRUSION_TOLERANCE = 0.15;

const enabledKeys = Object.keys(DEVICE_PARTS) as DevicePartKey[];

const SIZE_KEY: Record<DevicePartKey, keyof typeof DEVICE_SIZES> = {
  CNC: 'CNC',
  ROBOT: 'ROBOT',
  CONVEYOR: 'CONVEYOR',
  INSPECTION: 'INSPECTION',
  AIR: 'AUX_AIR',
  PUMP: 'AUX_PUMP',
};

/** 圆柱在 rotZ / rotX 后轴向会换，包围盒半长要跟着换，否则检查会把旋转件误判为越界 */
function halfExtent(p: DevicePart): [number, number, number] {
  if (p.shape === 'cyl') {
    const r = p.sx / 2;
    const h = p.sy / 2;
    if (p.rotZ) return [h, r, r];
    if (p.rotX) return [r, r, h];
    return [r, h, r];
  }
  return [p.sx / 2, p.sy / 2, p.sz / 2];
}

describe('deviceDetail（D 批 R2/R3）', () => {
  it('六类设备全部启用，且每类都有状态灯高度', () => {
    expect(enabledKeys.sort()).toEqual(['AIR', 'CNC', 'CONVEYOR', 'INSPECTION', 'PUMP', 'ROBOT'].sort());
    for (const key of enabledKeys) {
      expect(Number.isFinite(DETAIL_LAMP_Y[key]), `${key} lampY`).toBe(true);
    }
  });

  it('已启用的类型都达到可辨识部件数下限', () => {
    for (const key of enabledKeys) {
      const kinds = partKindsOf(key);
      expect(kinds.length, `${key} 部件类别数`).toBeGreaterThanOrEqual(DETAIL_LIMITS.minParts[key]);
    }
  });

  it('每台恰好 1 片假接触阴影，且类别名固定', () => {
    for (const key of enabledKeys) {
      const shadows = DEVICE_PARTS[key].filter((p) => p.kind === 'contactShadow');
      expect(shadows.length, key).toBe(1);
      expect(shadows[0].shape).toBe('shadow');
    }
  });

  it('静态部件不越出 DEVICE_SIZES 包围盒（描写盒与 D3 相机避障共用它）', () => {
    for (const key of enabledKeys) {
      const size = DEVICE_SIZES[SIZE_KEY[key]];
      for (const p of DEVICE_PARTS[key]) {
        if (p.shape === 'shadow' || p.arm) continue;
        const [hx, hy, hz] = halfExtent(p);
        expect(Math.abs(p.x) + hx, `${key}/${p.kind} x`).toBeLessThanOrEqual(size.x / 2 + PROTRUSION_TOLERANCE);
        expect(Math.abs(p.z) + hz, `${key}/${p.kind} z`).toBeLessThanOrEqual(size.z / 2 + PROTRUSION_TOLERANCE);
        expect(p.y - hy, `${key}/${p.kind} 底部`).toBeGreaterThanOrEqual(-PROTRUSION_TOLERANCE);
        expect(p.y + hy, `${key}/${p.kind} 顶部`).toBeLessThanOrEqual(size.y + PROTRUSION_TOLERANCE);
      }
    }
  });

  it('几何能合并成一份：全体非索引、有顶点色、三角数在上限内', () => {
    for (const key of enabledKeys) {
      const built = buildDeviceDetail(key);
      // RoundedBoxGeometry 非索引、其余索引，合并前必须统一；不一致会直接抛错
      expect(built.staticGeometry.index, `${key} 应为非索引`).toBeNull();
      expect(built.staticGeometry.getAttribute('color'), `${key} 顶点色`).toBeTruthy();
      expect(built.triangleCount, `${key} 三角数`).toBeLessThanOrEqual(DETAIL_LIMITS.maxTrianglesPerDevice);
      expect(built.triangleCount).toBeGreaterThan(0);
      expect(built.meshCount).toBeLessThanOrEqual(DETAIL_LIMITS.maxMeshesPerDevice);
      built.staticGeometry.dispose();
      built.armGeometry?.dispose();
    }
  });

  it('CNC 样板：至少能数出 12 类结构件，且包含机床的辨识特征', () => {
    const kinds = partKindsOf('CNC');
    expect(kinds.length).toBeGreaterThanOrEqual(12);
    for (const must of ['mainBody', 'slidingDoor', 'windowGlass', 'controlPanel', 'emergencyStop', 'sideVent', 'namePlate', 'contactShadow']) {
      expect(kinds, `缺 ${must}`).toContain(must);
    }
  });

  it('只有 ROBOT 有机械臂部件，且枢轴高度与部件表一致', () => {
    for (const key of enabledKeys) {
      const arms = DEVICE_PARTS[key].filter((p) => p.arm);
      const built = buildDeviceDetail(key);
      expect(!!built.armGeometry, key).toBe(arms.length > 0);
      expect(arms.length > 0, `${key} 不该有臂`).toBe(key === 'ROBOT');
      built.staticGeometry.dispose();
      built.armGeometry?.dispose();
    }
    expect(ARM_PIVOT_Y).toBe(1.95);
  });

  it('顶点色长度与 position 一致（mergeGeometries 的属性一致性前提）', () => {
    for (const key of enabledKeys) {
      const built = buildDeviceDetail(key);
      for (const geo of [built.staticGeometry, built.armGeometry]) {
        if (!geo) continue;
        expect(geo.getAttribute('color').count, key).toBe(geo.getAttribute('position').count);
      }
      built.staticGeometry.dispose();
      built.armGeometry?.dispose();
    }
  });
});
