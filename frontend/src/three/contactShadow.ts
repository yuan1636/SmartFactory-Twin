/**
 * 接触阴影（批 1「光影与材质」，D-75）。
 *
 * 阴影贴图只能回答"有没有被光直射"，回答不了"物体和地面挨得有多紧"：
 * 方向光的软阴影在物体正下方会漏光，看到的是"一圈浅灰"，于是设备看起来是
 * 贴在地面上的贴纸，不是压在地上的机器。真实的接触遮蔽是**短距离**的、
 * 各向同性的、随距离快速衰减的暗区，阴影贴图给不了，只能用贴片近似。
 *
 * 做法：每台设备脚下一个径向渐变的 quad，用 MultiplyBlending 把地面**压暗**
 * （白=不变，灰=压暗），合并成 1 个 mesh → **1 次 draw call**。
 *
 * 三个必须注意的点：
 *  1. `depthWrite = false` + `polygonOffset`：否则会和地面 z-fighting，出现闪烁条纹；
 *  2. y 抬 2 cm 而不是 0：与地面标线（paint 组在 y=0.01）错开，不掉进缝里；
 *  3. 不进拾取集合：它在 envRoot 之外单独 add，射线打不到它，
 *     所以不会出现"点设备脚下一片阴影弹出设备卡"。
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DEVICE_LAYOUT, deviceBox } from './layout';

/** 半径 = 设备占地半宽 × 该系数：小一点像接触遮蔽，大一点像"发霉"，取 0.95~1.15 之间 */
const SPREAD = 1.05;
/** 贴片比设备占地向外多出的余量（米），让阴影边缘落到设备轮廓之外 */
const MARGIN = 0.55;

function makeRadialTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 canvas 2d 上下文，接触阴影贴图生成失败');

  // 白底：multiply 时等于"不改变地面"
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  // 中心压到 0.42，中段快速衰减，外圈回到 1.0。
  // 用两段渐变是为了得到"硬核 + 软边"的接触感：单段线性渐变看起来像雾团。
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(96, 96, 96, 1)');
  grad.addColorStop(0.42, 'rgba(150, 150, 150, 1)');
  grad.addColorStop(0.72, 'rgba(218, 218, 218, 1)');
  grad.addColorStop(1, 'rgba(255, 255, 255, 1)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace; // 这是权重图，不是颜色，不能走 sRGB
  tex.anisotropy = 2;
  return tex;
}

export interface ContactShadows {
  mesh: THREE.Mesh;
  dispose: () => void;
}

/** 为 14 台设备各铺一片接触阴影，合并成 1 个 mesh */
export function createContactShadows(): ContactShadows {
  const texture = makeRadialTexture();
  const geos: THREE.BufferGeometry[] = [];

  for (const deviceId of Object.keys(DEVICE_LAYOUT)) {
    const box = deviceBox(deviceId);
    if (!box) continue;
    const width = (box.max[0] - box.min[0]) * SPREAD + MARGIN * 2;
    const depth = (box.max[2] - box.min[2]) * SPREAD + MARGIN * 2;
    const geo = new THREE.PlaneGeometry(width, depth);
    geo.rotateX(-Math.PI / 2); // 平面默认朝 +Z，转成朝上
    geo.translate((box.min[0] + box.max[0]) / 2, 0.02, (box.min[2] + box.max[2]) / 2);
    geos.push(geo);
  }

  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  if (!merged) throw new Error('接触阴影几何合并失败');

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    blending: THREE.MultiplyBlending,
    depthWrite: false,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  const mesh = new THREE.Mesh(merged, material);
  mesh.name = 'contact-shadows';
  // 铺满全厂的合并网格，包围球会让它被整体误剔除
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;

  return {
    mesh,
    dispose: () => {
      merged.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}
