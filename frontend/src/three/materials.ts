/**
 * 状态材质池（G-17）。
 * 关键性能约束：状态灯与光环的材质**只在这里创建一次**，每秒快照只换 mesh.material 引用，
 * 绝不 new MeshStandardMaterial —— 每秒重建材质会 GC 抖动掉帧。
 */

import * as THREE from 'three';
import type { EffectiveState } from '../utils/status';
import { FACTORY } from './layout';

/**
 * 程序化混凝土贴图：仓库里不放二进制贴图资源，用 canvas 现画。
 * 组成 = 深色底 + 细颗粒噪声 + 6 m 一格的分仓缝。
 * 为什么必须有它：纯色地面在深色场景里读不出"这是一大片地面"，所有设备像浮在虚空里（D0 问题 #3）。
 */
function makeConcreteTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 canvas 2d 上下文，地面贴图生成失败');

  ctx.fillStyle = '#1c2634';
  ctx.fillRect(0, 0, size, size);

  // 细颗粒：不做完全随机，按 4×4 块加扰动更像混凝土骨料，也不会在缩小时变成噪点雪花
  const img = ctx.getImageData(0, 0, size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const grain = (Math.random() - 0.5) * 16;
      const patch = Math.sin(x * 0.021) * Math.cos(y * 0.017) * 5;
      const d = grain + patch;
      img.data[i] = Math.max(0, Math.min(255, img.data[i] + d));
      img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + d));
      img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + d));
    }
  }
  ctx.putImageData(img, 0, 0);

  // 分仓缝：贴图对应 6 m × 6 m，repeat 后自然形成整片网格
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.lineWidth = 4;
  ctx.strokeRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(120, 150, 180, 0.06)';
  ctx.lineWidth = 2;
  ctx.strokeRect(2, 2, size - 4, size - 4);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(FACTORY.sizeX / 6, FACTORY.sizeZ / 6);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * 程序化墙板贴图：竖向板缝 + 踢脚线暗带。
 * 为什么需要：实墙解决"没有背景"，但纯色墙在近景里仍是一块色板，
 * 看不出是"厂房围护结构"（D0 问题 #1 / #2 的延伸）。
 */
function makeWallTexture(): THREE.CanvasTexture {
  const w = 256;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 canvas 2d 上下文，墙面贴图生成失败');

  // 上亮下暗的竖向渐变，模拟高侧窗带来的天光衰减
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#28384a');
  grad.addColorStop(0.55, '#1f2b3a');
  grad.addColorStop(1, '#16202b');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // 竖向板缝：每 64px 一道（贴图映射到约 4 m，即每 1 m 一块板）
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.lineWidth = 3;
  for (let x = 0; x <= w; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  // 板缝右侧的高光，让缝看起来是"凹进去"的
  ctx.strokeStyle = 'rgba(150, 180, 210, 0.07)';
  ctx.lineWidth = 2;
  for (let x = 3; x <= w; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  // 踢脚线：底部一条更暗的带，墙与地面的交界不再"糊在一起"
  ctx.fillStyle = 'rgba(8, 12, 18, 0.75)';
  ctx.fillRect(0, h - 14, w, 14);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping; // 竖向不重复：踢脚线只应出现在底部
  tex.repeat.set(3, 1);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * 光环的基础亮度。原实现是 per-state 的材质 `opacity`（ALARM 0.25 / RUNNING 0.18 / 其它 0.12~0.15）。
 * D2 把 14 个光环合并成 1 个 InstancedMesh 后，材质只有一个 opacity，改不动逐台差异，
 * 于是把「透明度差异」折成「颜色亮度系数」——背景是深色地面，两者在视觉上等价。
 * 这是近似，不是等价变换：若光环叠在浅色物体上，观感会比原来略实。当前场景无此情况。
 */
export const RING_BRIGHTNESS: Record<EffectiveState, number> = {
  RUNNING: 0.18,
  IDLE: 0.12,
  STOPPED: 0.15,
  ALARM: 0.25,
  MAINTENANCE: 0.15,
};

export interface SceneMaterials {
  /**
   * 状态灯 / 光环合并渲染用的基材质（D2 合批：14 + 14 个 mesh → 2 个 InstancedMesh）。
   * 基色白色，实际颜色由 `instanceColor` 逐实例写入，见 builders.ts 的 `StatusLights`。
   */
  lampBase: THREE.MeshBasicMaterial;
  ringBase: THREE.MeshBasicMaterial;
  /** WS 断开时统一转灰，光环隐藏（规格 8.2） */
  disconnected: THREE.MeshBasicMaterial;
  body: Record<string, THREE.MeshStandardMaterial>;
  outline: THREE.LineBasicMaterial;
  floor: THREE.MeshStandardMaterial;
  wall: THREE.MeshStandardMaterial;
  strip: THREE.MeshBasicMaterial;
  corridor: THREE.MeshBasicMaterial;
  pave: THREE.MeshBasicMaterial;
  /** 产线运行动画（第 6.7 节）：带面纹路、物料、滚筒上的定位条 */
  cleat: THREE.MeshBasicMaterial;
  workpiece: THREE.MeshStandardMaterial;
  rollerMark: THREE.MeshBasicMaterial;
}

/** 机身基色（G-04：不随状态染色） */
const BODY_COLOR: Record<string, string> = {
  CNC: '#5a6673',
  ROBOT: '#8a7a6a',
  CONVEYOR: '#3f4a57',
  INSPECTION: '#4e6b7a',
  AUX: '#59636e',
};

export function createMaterials(): SceneMaterials {
  const body: Record<string, THREE.MeshStandardMaterial> = {};
  for (const [type, hex] of Object.entries(BODY_COLOR)) {
    body[type] = new THREE.MeshStandardMaterial({
      color: new THREE.Color(hex),
      roughness: 0.62,
      metalness: 0.35,
    });
  }

  const floorTexture = makeConcreteTexture();
  const wallTexture = makeWallTexture();

  return {
    // 合并后的灯与环：基色白，靠 instanceColor 染色。transparent 是为了让 ALARM 的
    // 呼吸/闪烁能通过颜色亮度表现出来（不透明的自发光球看不出"在闪"）。
    lampBase: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, toneMapped: false }),
    ringBase: new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 1,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    }),
    disconnected: new THREE.MeshBasicMaterial({ color: 0x64748b, transparent: true, opacity: 1, toneMapped: false }),
    body,
    outline: new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }),
    floor: new THREE.MeshStandardMaterial({
      map: floorTexture,
      color: 0xffffff, // 贴图自带基色，这里不再乘色，否则会二次压暗
      roughness: 0.92,
      metalness: 0.02,
    }),
    // 墙面：原来是 opacity 0.12 + depthWrite:false 的"幽灵墙"，截图里等于没有（D0 问题 #1）。
    // 改成实墙：8 m 高、朝内可见，总览机位（y=40）仍能从墙顶看进车间内部。
    wall: new THREE.MeshStandardMaterial({
      map: wallTexture,
      color: 0xffffff, // 贴图自带明暗与板缝，不再乘色
      roughness: 0.88,
      metalness: 0.06,
      side: THREE.DoubleSide,
    }),
    strip: new THREE.MeshBasicMaterial({ color: 0x1e3a5f, transparent: true, opacity: 0.9 }),
    corridor: new THREE.MeshBasicMaterial({ color: 0x16222f }),
    pave: new THREE.MeshBasicMaterial({ color: 0x141e2b }),
    // 带面纹路比色带亮一档，靠"动"被看见；物料比机身浅，深色地面上才分得出来
    cleat: new THREE.MeshBasicMaterial({ color: 0x356d9e, transparent: true, opacity: 0.85, toneMapped: false }),
    workpiece: new THREE.MeshStandardMaterial({ color: 0x9fb2c4, roughness: 0.45, metalness: 0.6 }),
    rollerMark: new THREE.MeshBasicMaterial({ color: 0x141c26 }),
  };
}

/**
 * 只处理共享材质：几何体由各 builder 自己收集（一台设备一份，不会有每秒重建问题）。
 */
export function disposeMaterials(materials: SceneMaterials | null): void {
  if (!materials) return;
  materials.disconnected.dispose();
  materials.lampBase.dispose();
  materials.ringBase.dispose();
  for (const m of Object.values(materials.body)) m.dispose();
  materials.outline.dispose();
  materials.floor.map?.dispose(); // 程序化贴图是运行时创建的，不 dispose 会在反复挂载时累积显存
  materials.floor.dispose();
  materials.wall.map?.dispose();
  materials.wall.dispose();
  materials.strip.dispose();
  materials.corridor.dispose();
  materials.pave.dispose();
  materials.cleat.dispose();
  materials.workpiece.dispose();
  materials.rollerMark.dispose();
}
