/**
 * 环境层构建器（作者 2026-11-25 追加批次）。
 *
 * 唯一的目标：把柱子/桁架/灯带/地坪涂装/桥架/办公室/纵深道具/安全件/产线补齐件全部塞进 **6 次 draw call**：
 *   matte     —— 混凝土柱、办公室体块、托盘、料箱、废料箱、叉车车身（顶点色）
 *   metal     —— 桁架、檩条、桥架、货架、桌子腿、滑台、工具车（顶点色）
 *   paint     —— 地坪涂装 + 线色带（不参与光照，颜色所见即所得）
 *   emissive  —— 顶部灯带（自发光，不投光：真灯每盏都会触发阴影重算）
 *   glass     —— 办公室玻璃（透明，单独一组）
 *   labels    —— 工位编号/产线名（一张图集 + 一个材质）
 *
 * 为什么用顶点色而不是"一种颜色一个材质"：材质数 = draw call 数。顶点色让
 * 十几种颜色的上百个方块合成一次绘制；这也是本批能守住 ≤100 的根本原因。
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  ATLAS_TEXT,
  buildEnvironment,
  buildLineProps,
  type EnvGroup,
  type EnvLabelSpec,
  type EnvPart,
} from './envLayout';
import { LINE_SCENARIOS } from './scenario';

export interface EnvBuild {
  root: THREE.Group;
  kinds: string[];
  /** B1 的「维修中」标识（由 builders.ts 转成 CSS2D 标签） */
  maintenanceLabels: Array<{ x: number; y: number; z: number; text: string }>;
  /** 各组实际合并后的绘制体数量（验收用：必须 ≤6） */
  drawables: Array<{ group: EnvGroup | 'labels'; meshes: number }>;
  /**
   * 剖切：让 `cut` 标记的墙段（见 envLayout.EnvPart.cut）整体不可见/恢复。
   * 用合并索引退化为同一点实现——不加材质、不加 draw call，
   * 阴影 pass 与主 pass 共用同一份索引，不会出现"墙没了影子还在"。
   * 只应在集合内容变化时调用（内部会无条件重传 GPU 缓冲）。
   */
  setCutaway: (ids: ReadonlySet<string>) => void;
  dispose: () => void;
}

/** 图集：8 列 × 4 行，单元 256×80 px（2048×320）。只画 ASCII，见 envLayout 的说明。
 *  单元比例 3.2:1 与地面牌子（1.6×0.5）一致——第一版用正方形单元，牌面被拉宽 3 倍，字都变形了 */
const ATLAS_COLS = 8;
const ATLAS_ROWS = 4;
const CELL_W = 256;
const CELL_H = 80;

function makeLabelAtlas(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_COLS * CELL_W;
  canvas.height = ATLAS_ROWS * CELL_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 canvas 2d 上下文，工位图集生成失败');

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ATLAS_TEXT.forEach((text, i) => {
    const c = i % ATLAS_COLS;
    const r = Math.floor(i / ATLAS_COLS);
    const x = c * CELL_W;
    const y = r * CELL_H;
    // 深色底板 + 内描边，像刷在地面上的漆字
    ctx.fillStyle = '#101a26';
    ctx.fillRect(x + 2, y + 2, CELL_W - 4, CELL_H - 4);
    ctx.strokeStyle = 'rgba(180, 205, 230, 0.35)';
    ctx.lineWidth = 3;
    ctx.strokeRect(x + 5, y + 5, CELL_W - 10, CELL_H - 10);
    ctx.fillStyle = '#d7e6f5';
    ctx.font = 'bold 44px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + CELL_W / 2, y + CELL_H / 2);
  });

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** 给几何体写入统一顶点色（mergeGeometries 要求所有子几何体属性一致） */
function paint(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const color = new THREE.Color(hex);
  const count = geo.attributes.position.count;
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    arr[i * 3] = color.r;
    arr[i * 3 + 1] = color.g;
    arr[i * 3 + 2] = color.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function toGeometry(part: EnvPart): THREE.BufferGeometry {
  let geo: THREE.BufferGeometry;
  if (part.shape === 'cone') {
    geo = new THREE.CylinderGeometry(part.sz, part.sx, part.sy, 12);
  } else if (part.shape === 'cyl') {
    geo = new THREE.CylinderGeometry(part.sx, part.sx, part.sy, 10);
  } else {
    geo = new THREE.BoxGeometry(part.sx, part.sy, part.sz);
  }
  if (part.rotX) geo.rotateX(part.rotX);
  if (part.rotZ) geo.rotateZ(part.rotZ);
  if (part.rotY) geo.rotateY(part.rotY);
  geo.translate(part.x, part.y, part.z);
  return paint(geo, part.color);
}

function labelGeometry(spec: EnvLabelSpec): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(spec.width, spec.height);
  const idx = ATLAS_TEXT.indexOf(spec.cell);
  const c = (idx < 0 ? 0 : idx) % ATLAS_COLS;
  const r = Math.floor((idx < 0 ? 0 : idx) / ATLAS_COLS);
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let k = 0; k < uv.count; k += 1) {
    const u = uv.getX(k);
    const v = uv.getY(k);
    uv.setXY(k, (c + u) / ATLAS_COLS, 1 - (r + 1 - v) / ATLAS_ROWS);
  }
  geo.rotateX(-Math.PI / 2);
  if (spec.rotY) geo.rotateY(spec.rotY);
  geo.translate(spec.x, 0.02, spec.z);
  return geo;
}

export function buildEnv(): EnvBuild {
  const root = new THREE.Group();
  root.name = 'env';

  const env = buildEnvironment();
  const lineProps = buildLineProps(LINE_SCENARIOS);
  const parts = [...env.parts, ...lineProps.parts];
  const labels = env.labels;

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const textures: THREE.Texture[] = [];
  const track = <T extends THREE.BufferGeometry>(g: T): T => {
    geometries.push(g);
    return g;
  };
  const mat = <T extends THREE.Material>(m: T): T => {
    materials.push(m);
    return m;
  };

  const drawables: EnvBuild['drawables'] = [];

  /** 剖切段登记：cut id → 它在各组合并索引里的区间（BoxGeometry 36 索引/段，恢复用 saved 原值） */
  interface CutRange {
    attr: THREE.BufferAttribute;
    start: number;
    end: number;
    saved: Uint16Array | Uint32Array;
  }
  const cutRanges = new Map<string, CutRange[]>();

  const groups: Array<{ group: EnvGroup; material: THREE.Material; castShadow: boolean; receiveShadow: boolean }> = [
    {
      group: 'matte',
      material: mat(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.06 })),
      castShadow: true,
      receiveShadow: true,
    },
    {
      // 围护壳（批 1，D-75）：墙、踢脚、包柱。单独成组只为了**关掉投影**——
      // 墙一旦投影，从上方来的光全被挡在墙外，室内只剩不投影的补光，
      // 结果是车间里没有任何设备影子（实测：LINE-A1 近景地面完全无影，
      // 设备像贴纸）。接收阴影仍开着，墙面上仍能接到设备与柱子的投影。
      group: 'shell',
      material: mat(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.05 })),
      castShadow: false,
      receiveShadow: true,
    },
    {
      group: 'metal',
      material: mat(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.52, metalness: 0.62 })),
      castShadow: false,
      receiveShadow: false,
    },
    {
      group: 'paint',
      // 地坪涂装不参与光照：颜色所见即所得，否则深色地面上黄线会灰掉
      material: mat(new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false })),
      castShadow: false,
      receiveShadow: false,
    },
    {
      group: 'emissive',
      material: mat(new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false })),
      castShadow: false,
      receiveShadow: false,
    },
    {
      group: 'glass',
      material: mat(
        new THREE.MeshStandardMaterial({
          color: 0xffffff,
          vertexColors: true,
          transparent: true,
          opacity: 0.26,
          roughness: 0.08,
          metalness: 0.2,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      ),
      castShadow: false,
      receiveShadow: false,
    },
  ];

  for (const cfg of groups) {
    const list = parts.filter((p) => p.group === cfg.group);
    if (!list.length) continue;
    const geos = list.map((p) => toGeometry(p));
    // 剖切段登记要在 dispose 之前读 index，且必须按合并顺序累计索引基址——
    // mergeGeometries 会把第 i 个子几何的索引整体平移到 [基址, 基址+count)
    let indexBase = 0;
    const pendingCuts: Array<{ cut: string; start: number; end: number }> = [];
    for (let i = 0; i < list.length; i += 1) {
      const cnt = geos[i].index?.count ?? 0;
      if (list[i].cut && cnt > 0) pendingCuts.push({ cut: list[i].cut!, start: indexBase, end: indexBase + cnt });
      indexBase += cnt;
    }
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) throw new Error(`环境层几何合并失败：${cfg.group}`);
    if (pendingCuts.length && merged.index) {
      merged.index.setUsage(THREE.DynamicDrawUsage); // 运行时会反复写
      for (const pc of pendingCuts) {
        const saved = (merged.index.array as Uint16Array | Uint32Array).slice(pc.start, pc.end) as Uint16Array | Uint32Array;
        const list2 = cutRanges.get(pc.cut) ?? [];
        list2.push({ attr: merged.index, start: pc.start, end: pc.end, saved });
        cutRanges.set(pc.cut, list2);
      }
    }
    const mesh = new THREE.Mesh(track(merged), cfg.material);
    mesh.name = `env:${cfg.group}`;
    mesh.castShadow = cfg.castShadow;
    mesh.receiveShadow = cfg.receiveShadow;
    mesh.frustumCulled = false; // 合并后是全场大网格，默认包围球会误剔除
    root.add(mesh);
    drawables.push({ group: cfg.group, meshes: 1 });
  }

  // ---------- 工位编号 / 产线名（一张图集 → 1 次 draw call） ----------
  {
    const atlas = makeLabelAtlas();
    textures.push(atlas);
    const labelMat = mat(new THREE.MeshBasicMaterial({ map: atlas, transparent: true, toneMapped: false, depthWrite: false }));
    const geos = labels.map(labelGeometry);
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) throw new Error('工位编号几何合并失败');
    const mesh = new THREE.Mesh(track(merged), labelMat);
    mesh.name = 'env:labels';
    mesh.frustumCulled = false;
    root.add(mesh);
    drawables.push({ group: 'labels', meshes: 1 });
  }

  /** 剖切开关：隐藏=三组索引全写成 0 号顶点（退化三角形，光栅化直接丢弃）；恢复=写回 saved 原值 */
  const setCutaway = (ids: ReadonlySet<string>) => {
    for (const [cut, ranges] of cutRanges) {
      const hide = ids.has(cut);
      for (const r of ranges) {
        const arr = r.attr.array as Uint16Array | Uint32Array;
        if (hide) arr.fill(0, r.start, r.end);
        else arr.set(r.saved, r.start);
        r.attr.needsUpdate = true;
      }
    }
  };

  const dispose = () => {
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
    for (const t of textures) t.dispose();
  };

  return {
    root,
    kinds: [...env.kinds, ...lineProps.kinds],
    maintenanceLabels: lineProps.maintenanceLabels,
    drawables,
    setCutaway,
    dispose,
  };
}
