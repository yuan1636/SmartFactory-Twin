/**
 * 设备建模 v2 的几何约束（规格 §10.4）。
 * 坐标写错、部件越过包围盒、合并失败，最便宜的暴露方式都是单测，不必起浏览器。
 */
import { describe, expect, it } from 'vitest';
import { DEVICE_PARTS, DETAIL_LIMITS, buildDeviceDetail, partKindsOf } from './deviceDetail';
import { DEVICE_SIZES } from './layout';

/** 操作件（把手 / 面板 / 急停）本来就该凸出机身，给 0.15 m 容差；贴地暗晕不参与相机避障，单独放宽 */
const PROTRUSION_TOLERANCE = 0.15;

const enabledKeys = Object.keys(DEVICE_PARTS) as Array<keyof typeof DEVICE_PARTS>;

describe('deviceDetail（D 批 R2/R3）', () => {
  it('已启用的类型都达到可辨识部件数下限', () => {
    for (const key of enabledKeys) {
      const kinds = partKindsOf(key);
      expect(kinds.length, `${key} 部件类别数`).toBeGreaterThanOrEqual(DETAIL_LIMITS.minParts[key]);
    }
  });

  it('每台恰好 1 片假接触阴影，且类别名固定', () => {
    for (const key of enabledKeys) {
      const shadows = (DEVICE_PARTS[key] ?? []).filter((p) => p.kind === 'contactShadow');
      expect(shadows.length, key).toBe(1);
      expect(shadows[0].shape).toBe('shadow');
    }
  });

  it('实体部件不越出 DEVICE_SIZES 包围盒（操作件允许凸出 0.15 m）', () => {
    const size = DEVICE_SIZES.CNC;
    for (const p of DEVICE_PARTS.CNC ?? []) {
      if (p.shape === 'shadow') continue;
      const tol = PROTRUSION_TOLERANCE;
      expect(Math.abs(p.x) + p.sx / 2, `${p.kind} x`).toBeLessThanOrEqual(size.x / 2 + tol);
      expect(Math.abs(p.z) + p.sz / 2, `${p.kind} z`).toBeLessThanOrEqual(size.z / 2 + tol);
      expect(p.y - p.sy / 2, `${p.kind} 底部`).toBeGreaterThanOrEqual(-tol);
      expect(p.y + p.sy / 2, `${p.kind} 顶部`).toBeLessThanOrEqual(size.y + tol);
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
