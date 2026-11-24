/**
 * 程序化几何（G-06）。纯函数式：不依赖 React，方便单独在控制台里试。
 * 每台设备外层是 Group，命名 device:<id> 并挂 userData.deviceId，供射线拾取使用。
 */

import * as THREE from 'three';
import type { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { EffectiveState } from '../utils/status';
import { makeDeviceLabel, makeLineLabel, setLabelActive } from './labels';
import {
  CORRIDOR,
  DEVICE_LAYOUT,
  DEVICE_SIZES,
  FACTORY,
  FALLBACK_PLACEMENT,
  LINE_STRIPS,
  POWER_STATION,
  WORKSHOPS,
  sizeKeyOf,
} from './layout';
import { createMaterials, disposeMaterials, type SceneMaterials } from './materials';

export interface DeviceVisual {
  group: THREE.Group;
  lamp: THREE.Mesh;
  ring: THREE.Mesh;
  outline: THREE.LineSegments;
  label: CSS2DObject;
  state: EffectiveState | null;
}

/** 输送机滚筒：本体 + 随轴转的定位条，交给运行动画每帧更新实例矩阵。 */
export interface RollerRig {
  rollers: THREE.InstancedMesh;
  marks: THREE.InstancedMesh;
  /** 8 个滚筒的局部 x 坐标 */
  xs: number[];
  /** 滚筒中心高度（组内局部坐标） */
  y: number;
  /** 定位条到轴心的距离 */
  radius: number;
}

export interface FactoryBuild {
  root: THREE.Group;
  devices: Map<string, DeviceVisual>;
  materials: SceneMaterials;
  /** 输送机滚筒（按 device_id） */
  rollers: Map<string, RollerRig>;
  /** 机器人摆动枢轴（按 device_id） */
  arms: Map<string, THREE.Group>;
  dispose: () => void;
}

type DeviceType = 'CNC' | 'ROBOT' | 'CONVEYOR' | 'INSPECTION' | 'AUX';

function typeOfId(deviceId: string): DeviceType {
  if (deviceId.startsWith('CNC')) return 'CNC';
  if (deviceId.startsWith('ROB')) return 'ROBOT';
  if (deviceId.startsWith('CONV')) return 'CONVEYOR';
  if (deviceId.startsWith('INSP')) return 'INSPECTION';
  return 'AUX';
}

export function buildFactory(): FactoryBuild {
  const materials = createMaterials();
  const root = new THREE.Group();
  root.name = 'factory';
  const geometries: THREE.BufferGeometry[] = [];
  const devices = new Map<string, DeviceVisual>();
  const rollers = new Map<string, RollerRig>();
  const arms = new Map<string, THREE.Group>();

  const track = <T extends THREE.BufferGeometry>(geo: T): T => {
    geometries.push(geo);
    return geo;
  };

  const bodyMat = (type: DeviceType) => materials.body[type] ?? materials.body.CNC;

  // ---------- 地面与网格 ----------

  const floorGeo = track(new THREE.PlaneGeometry(FACTORY.sizeX, FACTORY.sizeZ));
  const floor = new THREE.Mesh(floorGeo, materials.floor);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  floor.name = 'ground';
  root.add(floor);

  // 2m 一个格子：size/divisions = 80/40
  const grid = new THREE.GridHelper(FACTORY.sizeX, FACTORY.gridDivisions, 0x1e2a3a, 0x141c28);
  grid.position.y = 0.01; // 抬高 1cm 防 z-fighting
  root.add(grid);

  // 中央通道
  const corridorGeo = track(new THREE.PlaneGeometry(CORRIDOR.sizeX, CORRIDOR.sizeZ));
  const corridor = new THREE.Mesh(corridorGeo, materials.corridor);
  corridor.rotation.x = -Math.PI / 2;
  corridor.position.set(CORRIDOR.x, 0.006, CORRIDOR.z);
  root.add(corridor);

  // ---------- 厂房与产线 ----------

  const addPave = (x: number, z: number, sizeX: number, sizeZ: number, name: string) => {
    const geo = track(new THREE.PlaneGeometry(sizeX, sizeZ));
    const mesh = new THREE.Mesh(geo, materials.pave);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.004, z);
    mesh.name = name;
    mesh.receiveShadow = true;
    root.add(mesh);
  };

  const wallGeoCache = new Map<string, THREE.BoxGeometry>();
  const makeWall = (w: number, h: number, name: string): THREE.Mesh => {
    const key = `${w}x${h}`;
    let geo = wallGeoCache.get(key);
    if (!geo) {
      geo = track(new THREE.BoxGeometry(w, h, 0.2));
      wallGeoCache.set(key, geo);
    }
    const mesh = new THREE.Mesh(geo, materials.wall);
    mesh.name = name;
    return mesh;
  };

  for (const ws of WORKSHOPS) {
    addPave(ws.x, ws.z, ws.sizeX, ws.sizeZ, `pave:${ws.id}`);
    const halfX = ws.sizeX / 2;
    const halfZ = ws.sizeZ / 2;

    const north = makeWall(ws.sizeX, ws.height, `wall:${ws.id}:north`);
    north.position.set(ws.x, ws.height / 2, ws.z - halfZ);
    root.add(north);

    const south = makeWall(ws.sizeX, ws.height, `wall:${ws.id}:south`);
    south.position.set(ws.x, ws.height / 2, ws.z + halfZ);
    root.add(south);

    // 东西两侧墙沿 Z 方向：长度取 sizeZ，不是 sizeX
    for (const sign of [1, -1]) {
      const sideGeo = track(new THREE.BoxGeometry(ws.sizeZ, ws.height, 0.2));
      const side = new THREE.Mesh(sideGeo, materials.wall);
      side.name = `wall:${ws.id}:${sign > 0 ? 'east' : 'west'}`;
      side.position.set(ws.x + sign * halfX, ws.height / 2, ws.z);
      side.rotation.y = Math.PI / 2;
      root.add(side);
    }
  }

  // 动力站
  addPave(POWER_STATION.x, POWER_STATION.z, POWER_STATION.sizeX, POWER_STATION.sizeZ, 'pave:AUX');
  const psHalfX = POWER_STATION.sizeX / 2;
  const psHalfZ = POWER_STATION.sizeZ / 2;
  const psWalls: Array<[number, number, number, number]> = [
    [POWER_STATION.x, POWER_STATION.z - psHalfZ, POWER_STATION.sizeX, 0],
    [POWER_STATION.x, POWER_STATION.z + psHalfZ, POWER_STATION.sizeX, 0],
    [POWER_STATION.x - psHalfX, POWER_STATION.z, POWER_STATION.sizeZ, Math.PI / 2],
    [POWER_STATION.x + psHalfX, POWER_STATION.z, POWER_STATION.sizeZ, Math.PI / 2],
  ];
  for (const [x, z, len, rotY] of psWalls) {
    const geo = track(new THREE.BoxGeometry(len, POWER_STATION.height, 0.2));
    const mesh = new THREE.Mesh(geo, materials.wall);
    mesh.position.set(x, POWER_STATION.height / 2, z);
    mesh.rotation.y = rotY;
    root.add(mesh);
  }

  for (const strip of LINE_STRIPS) {
    const len = Math.abs(strip.x2 - strip.x1);
    const geo = track(new THREE.BoxGeometry(len, 0.15, 1.2));
    const mesh = new THREE.Mesh(geo, materials.strip);
    mesh.position.set((strip.x1 + strip.x2) / 2, 0.075, strip.z);
    mesh.name = `strip:${strip.line_id}`;
    root.add(mesh);

    const label = makeLineLabel(strip.line_id);
    label.position.set((strip.x1 + strip.x2) / 2, 1.0, strip.z + 0.1);
    root.add(label);
  }

  // ---------- 单台设备 ----------

  const buildDevice = (deviceId: string): { group: THREE.Group; lampY: number } | null => {
    const type = typeOfId(deviceId);
    const mat = bodyMat(type);
    const group = new THREE.Group();
    group.name = `device:${deviceId}`;
    group.userData.deviceId = deviceId;

    const add = (
      geo: THREE.BufferGeometry,
      x: number,
      y: number,
      z: number,
      rotZ = 0,
      parent: THREE.Group = group,
    ) => {
      const mesh = new THREE.Mesh(track(geo), mat);
      mesh.position.set(x, y, z);
      mesh.rotation.z = rotZ;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.deviceId = deviceId;
      parent.add(mesh);
      return mesh;
    };

    let lampY: number;

    if (type === 'CNC') {
      add(new THREE.BoxGeometry(4.0, 2.2, 2.6), 0, 1.1, 0);
      add(new THREE.BoxGeometry(1.0, 0.6, 1.0), 0.6, 2.5, 0);
      add(new THREE.BoxGeometry(1.6, 1.4, 0.08), -0.9, 1.3, 1.32);
      lampY = 2.9;
    } else if (type === 'ROBOT') {
      add(new THREE.CylinderGeometry(0.6, 0.6, 0.35, 24), 0, 0.175, 0);
      add(new THREE.BoxGeometry(0.34, 1.6, 0.34), 0, 1.15, 0);
      // 大臂与夹爪套在枢轴组里：转组的 y 轴就是"机器人摆动"，几何一点不用改
      const pivot = new THREE.Group();
      pivot.name = `arm:${deviceId}`;
      pivot.position.set(0, 1.95, 0);
      group.add(pivot);
      add(new THREE.BoxGeometry(1.4, 0.3, 0.3), 0.7, 0, 0, 0, pivot);
      add(new THREE.BoxGeometry(0.32, 0.36, 0.32), 1.4, -0.23, 0, 0, pivot);
      arms.set(deviceId, pivot);
      lampY = 2.35;
    } else if (type === 'CONVEYOR') {
      add(new THREE.BoxGeometry(10.0, 0.7, 1.2), 0, 0.35, 0);
      // 8 个滚筒用 InstancedMesh：既符合"8 个滚筒"，又只占 1 个 draw call
      const rollerGeo = track(new THREE.CylinderGeometry(0.18, 0.18, 1.2, 14));
      rollerGeo.rotateX(Math.PI / 2);
      const rollerMesh = new THREE.InstancedMesh(rollerGeo, mat, 8);
      const dummy = new THREE.Object3D();
      const xs: number[] = [];
      for (let i = 0; i < 8; i += 1) {
        xs.push(-4 + i * (8 / 7));
        dummy.position.set(xs[i], 0.82, 0);
        dummy.updateMatrix();
        rollerMesh.setMatrixAt(i, dummy.matrix);
      }
      rollerMesh.castShadow = true;
      rollerMesh.userData.deviceId = deviceId;
      group.add(rollerMesh);

      // 光滑圆柱自转是看不出来的，配一条绕轴转的暗色定位条才有"在转"的观感
      const markGeo = track(new THREE.BoxGeometry(0.07, 0.07, 1.14));
      const markMesh = new THREE.InstancedMesh(markGeo, materials.rollerMark, 8);
      for (let i = 0; i < 8; i += 1) {
        dummy.position.set(xs[i], 0.95, 0);
        dummy.updateMatrix();
        markMesh.setMatrixAt(i, dummy.matrix);
      }
      markMesh.userData.deviceId = deviceId;
      group.add(markMesh);

      rollers.set(deviceId, { rollers: rollerMesh, marks: markMesh, xs, y: 0.82, radius: 0.13 });
      lampY = 1.05;
    } else if (type === 'INSPECTION') {
      add(new THREE.BoxGeometry(3.0, 0.8, 2.0), 0, 0.4, 0);
      add(new THREE.BoxGeometry(0.16, 1.0, 0.16), -1.2, 1.3, 0);
      add(new THREE.BoxGeometry(0.16, 1.0, 0.16), 1.2, 1.3, 0);
      add(new THREE.BoxGeometry(2.6, 0.16, 0.16), 0, 1.72, 0);
      add(new THREE.BoxGeometry(0.3, 0.35, 0.3), 0, 1.5, 0);
      lampY = 2.05;
    } else if (deviceId.startsWith('PUMP')) {
      add(new THREE.BoxGeometry(1.6, 0.3, 1.4), 0, 0.15, 0);
      add(new THREE.CylinderGeometry(0.7, 0.7, 1.6, 22), 0, 0.85, 0, Math.PI / 2);
      lampY = 1.7;
    } else {
      add(new THREE.BoxGeometry(2.4, 2.0, 1.6), 0, 1.0, 0);
      const fan = new THREE.CylinderGeometry(0.5, 0.5, 0.06, 24);
      add(fan, 0, 2.03, 0);
      lampY = 2.3;
    }

    return { group, lampY };
  };

  const addLampRingOutline = (group: THREE.Group, deviceId: string, lampY: number) => {
    const lampGeo = track(new THREE.SphereGeometry(0.15, 16, 12));
    const lamp = new THREE.Mesh(lampGeo, materials.states.RUNNING.lamp);
    lamp.position.set(0, lampY, 0);
    lamp.name = `lamp:${deviceId}`;
    group.add(lamp);

    const ringGeo = track(new THREE.RingGeometry(0.95, 1.2, 40));
    ringGeo.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(ringGeo, materials.states.RUNNING.ring);
    ring.position.set(0, 0.03, 0);
    group.add(ring);

    const size = DEVICE_SIZES[sizeKeyOf(typeOfId(deviceId), deviceId)] ?? DEVICE_SIZES.CNC;
    const outlineGeo = track(new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z)));
    const outline = new THREE.LineSegments(outlineGeo, materials.outline);
    outline.position.set(0, size.y / 2, 0);
    outline.visible = false;
    group.add(outline);

    return { lamp, ring, outline };
  };

  for (const [deviceId, placement] of Object.entries(DEVICE_LAYOUT)) {
    const built = buildDevice(deviceId);
    if (!built) continue;
    const { group, lampY } = built;
    const { lamp, ring, outline } = addLampRingOutline(group, deviceId, lampY);

    group.position.set(placement.x, 0, placement.z);
    group.rotation.y = placement.rotationY;
    root.add(group);

    const label = makeDeviceLabel(deviceId);
    label.position.set(0, lampY + 0.55, 0);
    group.add(label);

    devices.set(deviceId, { group, lamp, ring, outline, label, state: null });
  }

  const dispose = () => {
    for (const geo of geometries) geo.dispose();
    grid.dispose?.();
    disposeMaterials(materials);
  };

  return { root, devices, materials, rollers, arms, dispose };
}

/** 坐标表里没有的设备：堆到动力站旁并在控制台报警，不静默跳过（3.3）。 */
export function placeOrphanDevice(deviceId: string): THREE.Group {
  const group = new THREE.Group();
  group.name = `device:${deviceId}`;
  group.userData.deviceId = deviceId;
  group.position.set(FALLBACK_PLACEMENT.x, 0, FALLBACK_PLACEMENT.z);
  return group;
}

/** 状态切换只换材质引用，不新建材质（G-17）。 */
export function applyDeviceState(visual: DeviceVisual, state: EffectiveState, materials: SceneMaterials): void {
  if (visual.state === state) return;
  visual.state = state;
  const pair = materials.states[state];
  visual.lamp.material = pair.lamp;
  visual.ring.material = pair.ring;
  visual.ring.visible = state !== 'STOPPED';
  setLabelActive(visual.label, state === 'ALARM');
}

/** WS 断开：状态灯转灰、光环隐藏，不再按最后一帧闪烁（8.2）。 */
export function applyDisconnected(visuals: Iterable<DeviceVisual>, materials: SceneMaterials): void {
  for (const visual of visuals) {
    visual.state = null;
    visual.lamp.material = materials.disconnected;
    visual.ring.visible = false;
    setLabelActive(visual.label, false);
  }
}

export function setDeviceSelected(visual: DeviceVisual, selected: boolean): void {
  visual.outline.visible = selected;
  setLabelActive(visual.label, selected);
}
