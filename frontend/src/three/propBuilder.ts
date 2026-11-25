/**
 * 工业道具（D2）。目标：让"这是工厂"这个判断成立，同时不把 draw call 吃回去。
 *
 * 每一类道具都必须是 **1~3 次 draw call**，做法只有两种：
 * - 重复件（基座、栏杆立柱、横杆）→ `InstancedMesh`；
 * - 形状各异但同材质的静态件（警示带、线槽、管道、货架）→ `mergeGeometries`。
 * 绝不允许"一根栏杆一个 mesh"，那是 120 次。
 *
 * 摆放坐标全部来自 propLayout.ts，这里只管几何与材质。
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  RAILING_HEIGHT,
  TRAY_HEIGHT,
  TRAY_WIDTH,
  buildHazardStrips,
  buildPipes,
  buildPlinths,
  buildRacks,
  buildRailings,
  buildSigns,
  buildTrays,
} from './propLayout';

export interface PropBuild {
  root: THREE.Group;
  /** 实际建立的类别（验收断言"道具 ≥7 类"直接读它，不数 mesh） */
  kinds: string[];
  dispose: () => void;
}

// ---------------------------------------------------------------- 程序化贴图

/**
 * 黄黑警示斜纹。仓库里不放二进制贴图，canvas 现画。
 * 斜条按 45° 铺，纹理 repeat 由各段的 UV 缩放控制（见 buildHazard）。
 */
function makeHazardTexture(): THREE.CanvasTexture {
  const s = 128;
  const canvas = document.createElement('canvas');
  canvas.width = s;
  canvas.height = s;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 canvas 2d 上下文，警示带贴图生成失败');

  ctx.fillStyle = '#d8a41c';
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = '#15181c';
  ctx.save();
  ctx.translate(s / 2, s / 2);
  ctx.rotate(-Math.PI / 4);
  // 转到 45° 后横向铺条，条宽占一半，纹理重复时接缝自然对齐
  for (let i = -s; i < s; i += 64) {
    ctx.fillRect(i, -s, 32, s * 2);
  }
  ctx.restore();

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** 安全标识贴图：只画几何图形 + 英文，不画中文——canvas 中文依赖系统字体，跨机器会变糊 */
function makeSignTexture(kind: 'exit' | 'warning' | 'notice'): THREE.CanvasTexture {
  const w = 256;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 canvas 2d 上下文，标识贴图生成失败');

  if (kind === 'exit') {
    ctx.fillStyle = '#0f7a3d';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#e8f5ee';
    // 简化人形：一个圆 + 一个三角身 + 一条箭头
    ctx.beginPath();
    ctx.arc(70, 42, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(58, 56, 24, 34);
    ctx.beginPath();
    ctx.moveTo(96, 70);
    ctx.lineTo(140, 70);
    ctx.lineTo(140, 58);
    ctx.lineTo(170, 78);
    ctx.lineTo(140, 98);
    ctx.lineTo(140, 86);
    ctx.lineTo(96, 86);
    ctx.closePath();
    ctx.fill();
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText('EXIT', 34, 118);
  } else if (kind === 'warning') {
    ctx.fillStyle = '#d8a41c';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#15181c';
    ctx.beginPath();
    ctx.moveTo(w / 2, 16);
    ctx.lineTo(w / 2 + 40, 88);
    ctx.lineTo(w / 2 - 40, 88);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#d8a41c';
    ctx.fillRect(w / 2 - 4, 42, 8, 26);
    ctx.beginPath();
    ctx.arc(w / 2, 78, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#15181c';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText('CAUTION', 88, 116);
  } else {
    ctx.fillStyle = '#123a63';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#dce8f5';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText('POWER', 34, 56);
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText('AUTHORIZED ONLY', 20, 96);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ---------------------------------------------------------------- 构建

export function buildProps(): PropBuild {
  const root = new THREE.Group();
  root.name = 'props';

  const geometries: THREE.BufferGeometry[] = [];
  const textures: THREE.Texture[] = [];
  const materials: THREE.Material[] = [];
  const track = <T extends THREE.BufferGeometry>(g: T): T => {
    geometries.push(g);
    return g;
  };
  const mat = <T extends THREE.Material>(m: T): T => {
    materials.push(m);
    return m;
  };

  const kinds: string[] = [];

  const concrete = mat(new THREE.MeshStandardMaterial({ color: 0x3b434d, roughness: 0.95, metalness: 0.04 }));
  const steel = mat(new THREE.MeshStandardMaterial({ color: 0x8b9299, roughness: 0.55, metalness: 0.65 }));
  const safetyYellow = mat(new THREE.MeshStandardMaterial({ color: 0xd9a12a, roughness: 0.6, metalness: 0.3 }));
  const trayMat = mat(new THREE.MeshStandardMaterial({ color: 0x4d545c, roughness: 0.7, metalness: 0.4 }));
  const pipeMat = mat(new THREE.MeshStandardMaterial({ color: 0x7e858d, roughness: 0.45, metalness: 0.75 }));
  const rackMat = mat(new THREE.MeshStandardMaterial({ color: 0xb26320, roughness: 0.7, metalness: 0.25 }));

  const dummy = new THREE.Object3D();

  // ---------- 1. 设备基座（14 个 → 1 次） ----------
  {
    const plinths = buildPlinths();
    const geo = track(new THREE.BoxGeometry(1, 1, 1));
    const mesh = new THREE.InstancedMesh(geo, concrete, plinths.length);
    mesh.name = 'prop:plinth';
    plinths.forEach((p, i) => {
      dummy.position.set(p.x, p.height / 2, p.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(p.sizeX, p.height, p.sizeZ);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    // 实例散布全场，父级只有一个 mesh，默认包围球会把整批误剔除
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    kinds.push('plinth');
  }

  // ---------- 2. 护栏立柱（约 120 根 → 1 次） ----------
  const railingRuns = buildRailings();
  {
    const totalPosts = railingRuns.reduce((n, r) => n + r.posts, 0);
    const geo = track(new THREE.BoxGeometry(0.07, 1, 0.07));
    const mesh = new THREE.InstancedMesh(geo, steel, totalPosts);
    mesh.name = 'prop:railPost';
    let i = 0;
    for (const run of railingRuns) {
      for (let k = 0; k < run.posts; k += 1) {
        const t = run.posts === 1 ? 0 : k / (run.posts - 1);
        dummy.position.set(run.x1 + (run.x2 - run.x1) * t, RAILING_HEIGHT / 2, run.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, RAILING_HEIGHT, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        i += 1;
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    // 细杆的阴影既看不清又要多一次绘制，关掉
    mesh.castShadow = false;
    root.add(mesh);
    kinds.push('railing');
  }

  // ---------- 3. 护栏横杆（每道 2 根 → 1 次） ----------
  {
    const geo = track(new THREE.BoxGeometry(1, 0.055, 0.055));
    const mesh = new THREE.InstancedMesh(geo, safetyYellow, railingRuns.length * 2);
    mesh.name = 'prop:railBar';
    let i = 0;
    for (const run of railingRuns) {
      const len = run.x2 - run.x1;
      for (const y of [RAILING_HEIGHT - 0.08, RAILING_HEIGHT * 0.55]) {
        dummy.position.set((run.x1 + run.x2) / 2, y, run.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(len, 1, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        i += 1;
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    root.add(mesh);
  }

  // ---------- 4. 地面黄黑警示带（6 段 → 1 次，合并以保留各自 UV 重复） ----------
  {
    const hazardTex = makeHazardTexture();
    textures.push(hazardTex);
    const hazardMat = mat(new THREE.MeshBasicMaterial({ map: hazardTex, toneMapped: false }));

    const parts: THREE.BufferGeometry[] = [];
    for (const s of buildHazardStrips()) {
      const geo = new THREE.PlaneGeometry(s.sizeX, s.sizeZ);
      geo.rotateX(-Math.PI / 2);
      geo.translate(s.x, 0.015, s.z);
      // 斜纹按 1.2 m 一格重复：实例化做不到逐实例 UV，所以这里逐段改 uv 后合并
      const uv = geo.attributes.uv as THREE.BufferAttribute;
      for (let k = 0; k < uv.count; k += 1) {
        uv.setXY(k, (uv.getX(k) * s.sizeX) / 1.2, (uv.getY(k) * s.sizeZ) / 1.2);
      }
      parts.push(geo);
    }
    const merged = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    if (!merged) throw new Error('警示带几何合并失败');
    const mesh = new THREE.Mesh(track(merged), hazardMat);
    mesh.name = 'prop:hazard';
    root.add(mesh);
    kinds.push('hazard');
  }

  // ---------- 5. 线槽（8 段 → 1 次） ----------
  {
    const parts: THREE.BufferGeometry[] = [];
    for (const t of buildTrays()) {
      const geo = new THREE.BoxGeometry(t.length, TRAY_HEIGHT, TRAY_WIDTH);
      geo.translate(t.x, TRAY_HEIGHT / 2, t.z);
      parts.push(geo);
    }
    const merged = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    if (!merged) throw new Error('线槽几何合并失败');
    const mesh = new THREE.Mesh(track(merged), trayMat);
    mesh.name = 'prop:tray';
    mesh.receiveShadow = true;
    root.add(mesh);
    kinds.push('tray');
  }

  // ---------- 6. 管道（主管 + 立管 → 1 次） ----------
  {
    const parts: THREE.BufferGeometry[] = [];
    for (const p of buildPipes()) {
      const geo = new THREE.CylinderGeometry(p.radius, p.radius, p.length, 12);
      if (p.axis === 'x') geo.rotateZ(Math.PI / 2);
      if (p.axis === 'z') geo.rotateX(Math.PI / 2);
      geo.translate(p.x, p.y, p.z);
      parts.push(geo);
    }
    const merged = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    if (!merged) throw new Error('管道几何合并失败');
    const mesh = new THREE.Mesh(track(merged), pipeMat);
    mesh.name = 'prop:pipe';
    mesh.castShadow = true;
    root.add(mesh);
    kinds.push('pipe');
  }

  // ---------- 7. 货架（4 个 × 7 件 → 1 次） ----------
  {
    const parts: THREE.BufferGeometry[] = [];
    for (const r of buildRacks()) {
      const halfW = r.width / 2;
      const halfD = r.depth / 2;
      // 4 根立柱
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const post = new THREE.BoxGeometry(0.08, r.height, 0.08);
          post.translate(r.x + sx * halfW, r.height / 2, r.z + sz * halfD);
          parts.push(post);
        }
      }
      // 层板
      for (let lv = 1; lv <= r.levels; lv += 1) {
        const shelf = new THREE.BoxGeometry(r.width, 0.06, r.depth);
        shelf.translate(r.x, (r.height / (r.levels + 1)) * lv, r.z);
        parts.push(shelf);
      }
    }
    const merged = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    if (!merged) throw new Error('货架几何合并失败');
    const mesh = new THREE.Mesh(track(merged), rackMat);
    mesh.name = 'prop:rack';
    mesh.castShadow = true;
    root.add(mesh);
    kinds.push('rack');
  }

  // ---------- 8. 安全标识（5 块 × 3 种贴图 → 3 次） ----------
  {
    const signTex: Record<string, THREE.CanvasTexture> = {
      exit: makeSignTexture('exit'),
      warning: makeSignTexture('warning'),
      notice: makeSignTexture('notice'),
    };
    Object.values(signTex).forEach((t) => textures.push(t));

    const byKind: Record<string, THREE.BufferGeometry[]> = { exit: [], warning: [], notice: [] };
    for (const s of buildSigns()) {
      const geo = new THREE.PlaneGeometry(s.width, s.height);
      geo.rotateY(s.rotY);
      geo.translate(s.x, s.y, s.z);
      byKind[s.kind].push(geo);
    }

    for (const kind of ['exit', 'warning', 'notice'] as const) {
      const parts = byKind[kind];
      if (!parts.length) continue;
      const merged = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      if (!merged) throw new Error(`标识几何合并失败：${kind}`);
      const m = mat(new THREE.MeshBasicMaterial({ map: signTex[kind], toneMapped: false }));
      const mesh = new THREE.Mesh(track(merged), m);
      mesh.name = `prop:sign-${kind}`;
      root.add(mesh);
    }
    kinds.push('sign');
  }

  const dispose = () => {
    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
    for (const t of textures) t.dispose();
  };

  return { root, kinds, dispose };
}
