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

/**
 * 设备 ID → 模型。按前缀匹配而不是按设备类型：
 * AUX 一台空压机、一台冷却泵，形体完全不同，不能共用一个模型。
 * 输送机（CONV）的滚筒**不在 GLB 里**——`RollerRig` 每帧写实例矩阵做旋转，
 * GLB 再带一套会双份；所以 conveyor.glb 只建机架/支腿/侧梁/电机/控制盒。
 */
const MODELS = {
  cnc: 'models/cnc.glb',
  robot: 'models/robot.glb',
  inspection: 'models/inspection.glb',
  conveyor: 'models/conveyor.glb',
  aux_air: 'models/aux_air.glb',
  aux_pump: 'models/aux_pump.glb',
} as const;

type ModelKey = keyof typeof MODELS;

function modelKeyOf(deviceId: string): ModelKey | null {
  if (deviceId.startsWith('CNC')) return 'cnc';
  if (deviceId.startsWith('ROB')) return 'robot';
  if (deviceId.startsWith('CONV')) return 'conveyor';
  if (deviceId.startsWith('INSP')) return 'inspection';
  if (deviceId.startsWith('AIR')) return 'aux_air';
  if (deviceId.startsWith('PUMP')) return 'aux_pump';
  return null;
}

/**
 * 表面细节贴图（批 4，D-80）。由 `tools/blender/gen_textures.py` 程序化生成，
 * 4 张 512² PNG，合计约 790 KB。漆面是橘皮+喷塑颗粒，金属是拉丝条纹。
 *
 * 为什么自己生成：项目要求资产可复现、无版权争议；而且这些贴图必须配合
 * Blender 侧的立方投影 UV（1 UV = 1 米）才能保证颗粒尺度是物理正确的。
 */
const DETAIL = {
  paint: {
    normal: 'models/tex/paint_normal.png',
    rough: 'models/tex/paint_rough.png',
    dirt: 'models/tex/paint_dirt.png',
  },
  metal: {
    normal: 'models/tex/metal_normal.png',
    rough: 'models/tex/metal_rough.png',
    dirt: 'models/tex/metal_dirt.png',
  },
} as const;

/**
 * 法线与粗糙度用**两个不同的重复率**，这不是随意定的：
 *
 * - 法线贴图讲的是毫米级细节（橘皮 3 mm、喷塑颗粒 1 mm），必须高频重复才不糊成一片；
 *   但高频细节在 10 m 外小于一个像素，会被 mipmap 平均掉——这是物理正确的，
 *   真实车间远看也看不出喷塑颗粒。
 * - 粗糙度贴图承担的是"脏污 / 磨损"这类**分米级**变化，它不会被 mipmap 抹平，
 *   所以远看仍有信息。要让它出现得足够大，repeat 必须小。
 *
 * 结论：normal 高重复（细节），rough 低重复（脏污）。两者各用各的。
 */
const NORMAL_REPEAT = 6;
const ROUGH_REPEAT = 0.7;
/**
 * 色差乘子要铺得比粗糙度**更开**：它的作用是让相邻面板互不相同。
 * 一张 512² 压住约 2.2 m，正好覆盖一台机床的立面，重复感最弱。
 */
const DIRT_REPEAT = 0.45;

interface DetailMaps {
  normal: THREE.Texture;
  rough: THREE.Texture;
  dirt: THREE.Texture;
}

type DetailKey = keyof typeof DETAIL;

const BUCKET_MATERIALS = (detail: Partial<Record<DetailKey, DetailMaps>>) => ({
  paint: new THREE.MeshStandardMaterial({
    vertexColors: true,
    // 有 roughnessMap 时必须把标量粗糙度交出去（设为 1，让贴图直接决定），
    // 否则两者相乘会得到一个凭空变光滑的漆面
    roughness: detail.paint ? 1.0 : 0.44,
    metalness: 0.12,
    envMapIntensity: 0.95,
    ...(detail.paint
      ? {
          map: detail.paint.dirt,
          normalMap: detail.paint.normal,
          normalScale: new THREE.Vector2(0.45, 0.45),
          roughnessMap: detail.paint.rough,
        }
      : {}),
  }),
  metal: new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: detail.metal ? 1.0 : 0.3,
    metalness: 0.95,
    envMapIntensity: 1.15,
    ...(detail.metal
      ? {
          map: detail.metal.dirt,
          normalMap: detail.metal.normal,
          normalScale: new THREE.Vector2(0.4, 0.4),
          roughnessMap: detail.metal.rough,
        }
      : {}),
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

/** 贴图缺失只降级成"没有细节"，绝不影响模型本体（不能因为一张 PNG 白屏）。 */
async function loadDetailMaps(baseUrl: string): Promise<Partial<Record<DetailKey, DetailMaps>>> {
  const loader = new THREE.TextureLoader();
  const prep = (tex: THREE.Texture, repeat: number) => {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat, repeat);
    // 法线与粗糙度都是非颜色数据。一旦按 sRGB 解码，法线会被 gamma 抬高、
    // 光照方向整体偏掉（表现为表面浮一层蓝紫噪点），这个必须显式设。
    tex.colorSpace = THREE.NoColorSpace;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  };

  const out: Partial<Record<DetailKey, DetailMaps>> = {};
  await Promise.all(
    (Object.keys(DETAIL) as DetailKey[]).map(async (key) => {
      try {
        const [normal, rough, dirt] = await Promise.all([
          loader.loadAsync(`${baseUrl}${DETAIL[key].normal}`),
          loader.loadAsync(`${baseUrl}${DETAIL[key].rough}`),
          loader.loadAsync(`${baseUrl}${DETAIL[key].dirt}`),
        ]);
        out[key] = {
          normal: prep(normal, NORMAL_REPEAT),
          rough: prep(rough, ROUGH_REPEAT),
          dirt: prep(dirt, DIRT_REPEAT),
        };
      } catch (error) {
        console.warn(`[glb] 贴图缺失，${key} 退回纯色：`, (error as Error).message);
      }
    }),
  );
  return out;
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
    // 合并的前提是属性集合一致：position / normal / color / uv 保留，切线丢掉
    // （法线贴图在没有切线属性时，three 会在片元里用 UV 推导切线，够用）
    for (const name of Object.keys(geo.attributes)) {
      if (!['position', 'normal', 'color', 'uv'].includes(name)) geo.deleteAttribute(name);
    }
    if (!geo.attributes.normal) geo.computeVertexNormals();
    if (!geo.attributes.uv) {
      // 少数件（曲线转网格的软管）可能没 UV。补零 UV，而不是跳过——
      // 属性集不一致会让 mergeGeometries 直接返回 null，整台设备就没了。
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    }
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

  const [detail] = await Promise.all([loadDetailMaps(baseUrl), Promise.all(
    Object.entries(MODELS).map(async ([key, path]) => {
      try {
        const gltf = await loader.loadAsync(`${baseUrl}${path}`);
        loaded.set(key, gltf.scene);
      } catch (error) {
        failed.push(`${path}: ${(error as Error).message}`);
      }
    }),
  )]);

  const materials = BUCKET_MATERIALS(detail);
  const result: GlbUpgradeResult = { swapped: 0, skipped: 0, failed, triangles: 0 };

  for (const [deviceId, visual] of build.devices) {
    const key = modelKeyOf(deviceId);
    const scene = key ? loaded.get(key) : undefined;
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
    if (key === 'robot') {
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
