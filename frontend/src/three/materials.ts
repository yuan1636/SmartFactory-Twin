/**
 * 状态材质池（G-17）。
 * 关键性能约束：状态灯与光环的材质**只在这里创建一次**，每秒快照只换 mesh.material 引用，
 * 绝不 new MeshStandardMaterial —— 每秒重建材质会 GC 抖动掉帧。
 */

import * as THREE from 'three';
import { STATE_META, type EffectiveState } from '../utils/status';

export interface StateMaterialPair {
  lamp: THREE.MeshBasicMaterial;
  ring: THREE.MeshBasicMaterial;
}

export interface SceneMaterials {
  states: Record<EffectiveState, StateMaterialPair>;
  /** WS 断开时统一转灰，光环隐藏（规格 8.2） */
  disconnected: THREE.MeshBasicMaterial;
  body: Record<string, THREE.MeshStandardMaterial>;
  outline: THREE.LineBasicMaterial;
  floor: THREE.MeshStandardMaterial;
  wall: THREE.MeshStandardMaterial;
  strip: THREE.MeshBasicMaterial;
  corridor: THREE.MeshBasicMaterial;
  pave: THREE.MeshBasicMaterial;
}

/** 机身基色（G-04：不随状态染色） */
const BODY_COLOR: Record<string, string> = {
  CNC: '#5a6673',
  ROBOT: '#8a7a6a',
  CONVEYOR: '#3f4a57',
  INSPECTION: '#4e6b7a',
  AUX: '#59636e',
};

const STATE_ORDER: EffectiveState[] = ['RUNNING', 'IDLE', 'STOPPED', 'ALARM', 'MAINTENANCE'];

export function createMaterials(): SceneMaterials {
  const states = {} as Record<EffectiveState, StateMaterialPair>;
  for (const state of STATE_ORDER) {
    const color = STATE_META[state].color;
    states[state] = {
      lamp: new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, toneMapped: false }),
      ring: new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: state === 'ALARM' ? 0.25 : state === 'RUNNING' ? 0.18 : state === 'IDLE' ? 0.12 : 0.15,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false,
      }),
    };
  }

  const body: Record<string, THREE.MeshStandardMaterial> = {};
  for (const [type, hex] of Object.entries(BODY_COLOR)) {
    body[type] = new THREE.MeshStandardMaterial({
      color: new THREE.Color(hex),
      roughness: 0.62,
      metalness: 0.35,
    });
  }

  return {
    states,
    disconnected: new THREE.MeshBasicMaterial({ color: 0x64748b, transparent: true, opacity: 1, toneMapped: false }),
    body,
    outline: new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }),
    floor: new THREE.MeshStandardMaterial({ color: 0x0f1722, roughness: 0.95, metalness: 0 }),
    wall: new THREE.MeshStandardMaterial({
      color: 0x2e9be6,
      transparent: true,
      opacity: 0.12,
      side: THREE.DoubleSide,
      depthWrite: false,
      roughness: 0.9,
    }),
    strip: new THREE.MeshBasicMaterial({ color: 0x1e3a5f, transparent: true, opacity: 0.9 }),
    corridor: new THREE.MeshBasicMaterial({ color: 0x16222f }),
    pave: new THREE.MeshBasicMaterial({ color: 0x141e2b }),
  };
}

/**
 * 只处理共享材质：几何体由各 builder 自己收集（一台设备一份，不会有每秒重建问题）。
 */
export function disposeMaterials(materials: SceneMaterials | null): void {
  if (!materials) return;
  for (const pair of Object.values(materials.states)) {
    pair.lamp.dispose();
    pair.ring.dispose();
  }
  materials.disconnected.dispose();
  for (const m of Object.values(materials.body)) m.dispose();
  materials.outline.dispose();
  materials.floor.dispose();
  materials.wall.dispose();
  materials.strip.dispose();
  materials.corridor.dispose();
  materials.pave.dispose();
}
