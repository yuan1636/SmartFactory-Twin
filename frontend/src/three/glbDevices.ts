/**
 * GLB 设备接入（批 3，D-78）。
 *
 * 背景：Blender 脚本（`tools/blender/gen_devices.py`）导出的模型是"一零件一 mesh"，
 * 一台 CNC 有 25 个 mesh。直接塞进场景会让场景 draw call 从 59 涨到 ~190，
 * 远超 ≤100 的预算（D2 起就守着的红线）。所以加载后必须**先烘焙再合并**：
 *
 *  1. 按源材质的 metalness 与 opacity 把零件分成 3 桶：paint / metal / glass；
 *  2. 每个零件把它材质的颜色写进顶点色（glTF 的材质色是线性值，直接搬）；
 *  3. 同桶几何合并成 1 个 mesh，用一份共享材质 —— 与既有设备建模 v2 的做法一致
 *     （顶点色承担颜色，材质只承担"这是漆面还是金属"）。
 *
 * 结果：每台设备 2~3 个 mesh（玻璃只有带观察窗的机型才有），
 * 一台 CNC 从 25 次绘制降到 3 次，而外观仍是 Blender 里带倒角的模型。
 *
 * 机械臂单独处理：Blender 里把大臂及以上挂在 `arm_pivot` 空物体上，
 * 这里把该节点的子件按"相对枢轴的矩阵"烘焙，再挂回一个同名 Group，
 * 写进 `build.arms`——motion.ts 照旧转 `rotation.y`，动画接口一行没改。
 *
 * 失败策略：任一模型 404 / 解析失败 → 保留原有程序化几何，只在控制台报一次，
 * 不 throw。宁可少一层细节，也不能白屏。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { FactoryBuild } from './builders';

/** 只替换这三类；CONVEYOR / AUX 的形体简单、且有滚筒动画，暂留程序化 */
const MODELS: Record<string, string> = {
  CNC: 'models/cnc.glb',
  ROBOT: 'models/robot.glb',
  INSPECTION: 'models/inspection.glb',
};

const BUCKET_MATERIALS = () => ({
  paint: new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.44,
    metalness: 0.12,
    envMapIntensity: 0.95,
  }),
  metal: new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.3,
    metalness: 0.95,
    envMapIntensity: 1.15,
  }),
  glass: new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.06,
    metalness: 0.1,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
    envMapIntensity: 1.4,
  }),
});

type Bucket = 'paint' | 'metal' | 'glass';

function bucketOf(material: THREE.Material): Bucket {
  const m = material as THREE.MeshStandardMaterial;
  if ((m as THREE.Material).transparent && (m.opacity ?? 1) < 0.9) return 'glass';
  if ((m.metalness ?? 0) > 0.55) return 'metal';
  return 'paint';
}

/**
 * 把一个 GLB 场景烘焙成 { 桶 → 合并几何 }。
 * `relativeTo` 给了就按"相对该节点"的矩阵烘焙（机械臂用）。
 */
function bakeScene(scene: THREE.Object3D, relativeTo?: THREE.Object3D) {
  scene.updateMatrixWorld(true);
  const base = relativeTo ? relativeTo.matrixWorld.clone().invert() : new THREE.Matrix4();
  const buckets: Record<Bucket, THREE.BufferGeometry[]> = { paint: [], metal: [], glass: [] };

  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    // 机械臂桶只收枢轴下的件；其余只收枢轴外的件
    let inArm = false;
    let p: THREE.Object3D | null = mesh;
    while (p) {
      if (p.name === 'arm_pivot') {
        inArm = true;
        break;
      }
      p = p.parent;
    }
    if (relativeTo ? !inArm : inArm) return;

    const src = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const bucket = bucketOf(src);
    const color = (src as THREE.MeshStandardMaterial).color ?? new THREE.Color(0xffffff);

    const geo = mesh.geometry.clone();
    // 合并的前提是属性集合一致：UV 我们不用（几何靠顶点色），法线保留，切线丢掉
    for (const name of Object.keys(geo.attributes)) {
      if (!['position', 'normal', 'color'].includes(name)) geo.deleteAttribute(name);
    }
    if (!geo.attributes.normal) geo.computeVertexNormals();
    geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(base, mesh.matrixWorld));

    const count = geo.attributes.position.count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    buckets[bucket].push(geo);
  });

  const merged: Partial<Record<Bucket, THREE.BufferGeometry>> = {};
  for (const key of Object.keys(buckets) as Bucket[]) {
    const list = buckets[key];
    if (!list.length) continue;
    const geo = mergeGeometries(list, false);
    for (const g of list) g.dispose();
    if (geo) merged[key] = geo;
  }
  return merged;
}

function trianglesOf(geo: THREE.BufferGeometry): number {
  return geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
}

export interface GlbUpgradeResult {
  swapped: number;
  skipped: number;
  failed: string[];
  triangles: number;
}

/**
 * 用 GLB 替换程序化外壳。必须在 `buildFactory()` 之后、首帧之前调用。
 * 旧的外壳 mesh 会被移除（几何由 build.dispose 统一释放，这里不重复 dispose）。
 */
export async function upgradeDevicesWithGlb(build: FactoryBuild): Promise<GlbUpgradeResult> {
  const loader = new GLTFLoader();
  const baseUrl = import.meta.env.BASE_URL ?? '/';
  const loaded = new Map<string, THREE.Group>();
  const failed: string[] = [];

  await Promise.all(
    Object.entries(MODELS).map(async ([type, path]) => {
      try {
        const gltf = await loader.loadAsync(`${baseUrl}${path}`);
        loaded.set(type, gltf.scene);
      } catch (error) {
        failed.push(`${path}: ${(error as Error).message}`);
      }
    }),
  );

  const materials = BUCKET_MATERIALS();
  const result: GlbUpgradeResult = { swapped: 0, skipped: 0, failed, triangles: 0 };

  for (const [deviceId, visual] of build.devices) {
    const type = deviceId.startsWith('CNC')
      ? 'CNC'
      : deviceId.startsWith('ROB')
        ? 'ROBOT'
        : deviceId.startsWith('INSP')
          ? 'INSPECTION'
          : '';
    const scene = type ? loaded.get(type) : undefined;
    if (!scene) {
      result.skipped += 1;
      continue;
    }

    const group = visual.group;
    // 幂等：dev 下 React StrictMode 会把整个 effect 跑两遍，第二次不能再叠一层 GLB。
    // 卸载时按名字前缀清掉"上一次装上的东西"，否则几何会成倍叠加（实测 130→190 calls）。
    for (const child of [...group.children]) {
      const name = child.name ?? '';
      if (
        name.startsWith('device-shell:') ||
        name.startsWith('device-arm:') ||
        name.startsWith('arm:') ||
        name.startsWith(`${deviceId}:`)
      ) {
        group.remove(child);
      }
    }

    // 静态件：整份 GLB（机械臂件会被 bakeScene 过滤掉）
    const body = bakeScene(scene);
    let tri = 0;
    for (const key of Object.keys(body) as Bucket[]) {
      const geo = body[key]!;
      const mesh = new THREE.Mesh(geo, materials[key]);
      mesh.name = `${deviceId}:${key}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.deviceId = deviceId;
      group.add(mesh);
      tri += trianglesOf(geo);
    }

    // 机械臂：按枢轴烘焙，挂到同名 Group 上，交给 motion.ts 继续摆
    if (type === 'ROBOT') {
      const pivotNode = scene.getObjectByName('arm_pivot');
      if (pivotNode) {
        const arm = bakeScene(scene, pivotNode);
        const pivot = new THREE.Group();
        pivot.name = `arm:${deviceId}`;
        // Blender 的枢轴位置（Z=1.95）经 Y-up 转换后就是 three 的 y；直接用节点世界坐标
        const world = new THREE.Vector3();
        pivotNode.getWorldPosition(world);
        pivot.position.copy(world);
        for (const key of Object.keys(arm) as Bucket[]) {
          const geo = arm[key]!;
          const mesh = new THREE.Mesh(geo, materials[key]);
          mesh.name = `${deviceId}:arm:${key}`;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.userData.deviceId = deviceId;
          pivot.add(mesh);
          tri += trianglesOf(geo);
        }
        group.add(pivot);
        build.arms.set(deviceId, pivot);
      }
    }

    const detail = build.deviceDetails.find((d) => d.id === deviceId);
    if (detail) {
      detail.triangles = Math.round(tri);
      detail.meshes = group.children.filter((c) => (c as THREE.Mesh).isMesh).length;
    }
    result.triangles += Math.round(tri);
    result.swapped += 1;
  }

  if (failed.length) {
    console.warn('[glb] 部分设备模型加载失败，保留程序化几何：', failed.join('; '));
  }
  return result;
}
