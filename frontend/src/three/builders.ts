/**
 * 程序化几何（G-06）。纯函数式：不依赖 React，方便单独在控制台里试。
 * 每台设备外层是 Group，命名 device:<id> 并挂 userData.deviceId，供射线拾取使用。
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { EffectiveState } from '../utils/status';
import { STATE_META } from '../utils/status';
import { makeDeviceLabel, makeLineLabel, makeScenarioLabel, setLabelActive } from './labels';
import { buildEnv } from './envBuilder';
import {
  CORRIDOR,
  DEVICE_LAYOUT,
  DEVICE_SIZES,
  FACTORY,
  FALLBACK_PLACEMENT,
  LINE_STRIPS,
  extendedLine,
  POWER_STATION,
  WORKSHOPS,
  sizeKeyOf,
} from './layout';
import { createMaterials, disposeMaterials, RING_BRIGHTNESS, type SceneMaterials } from './materials';
import { buildProps } from './propBuilder';
import { buildDeviceDetail, partKeyOf, type DevicePartKey } from './deviceDetail';

export interface DeviceVisual {
  group: THREE.Group;
  /** 状态灯在 lampMesh 实例数组中的下标（D2 合批后不再一台一个 mesh） */
  lampIndex: number;
  /** 地面光环在 ringMesh 实例数组中的下标 */
  ringIndex: number;
  outline: THREE.LineSegments;
  label: CSS2DObject;
  state: EffectiveState | null;
}

/**
 * 状态灯与光环的合并渲染器。
 *
 * 为什么合并：14 台设备各一个灯、各一个环，就是 28 次 draw call，占场景的四分之一。
 * 合并成 2 个 InstancedMesh 后只剩 2 次，而"逐台不同颜色 + 呼吸/闪烁"全部靠
 * `instanceColor` 实现——灯与环本来就是自发光 basic 材质，染色与调 opacity 在深色场景里
 * 观感等价（见 materials.ts 的 RING_BRIGHTNESS 注释）。
 *
 * 代价：不能再用"换材质引用"表示状态，必须每帧写颜色。14×2 次浮点写入可忽略，
 * 但 `instanceColor.needsUpdate` 会重传 buffer，所以做了脏检查。
 */
export interface StatusLights {
  lamps: THREE.InstancedMesh;
  rings: THREE.InstancedMesh;
  /** 按当前状态与时间刷新实例颜色（呼吸/闪烁）；reduceMotion 时只上静态色 */
  update: (visuals: Iterable<DeviceVisual>, t: number, reduceMotion: boolean) => void;
  /** WS 断开：全部转灰、光环隐去（规格 8.2） */
  disconnect: (visuals: Iterable<DeviceVisual>) => void;
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
  /** 合并后的状态灯与光环（D2 合批） */
  lights: StatusLights;
  /** 已建立的工业道具类别（D2 验收断言"≥7 类"读它，不数 mesh） */
  propKinds: string[];
  /** 环境层与产线补齐件的类别（本批新增，验收读它） */
  envKinds: string[];
  /** 环境层各组实际绘制体数量：合计必须 ≤6（一物一 mesh 会在这里露馅） */
  envDrawables: Array<{ group: string; meshes: number }>;
  /** 室外剖切（D 批 R1）：相机在某车间某侧室外时把那面墙退化掉，规则见 envInterior.cutawaySides */
  setCutaway: (ids: ReadonlySet<string>) => void;
  /** 输送机滚筒（按 device_id） */
  rollers: Map<string, RollerRig>;
  /** 机器人摆动枢轴（按 device_id） */
  arms: Map<string, THREE.Group>;
  /** 设备建模 v2 的逐台几何统计（规格 §10.4：部件数 / mesh 数 / 三角数），验收脚本读它 */
  deviceDetails: Array<{ id: string; key: DevicePartKey; parts: number; triangles: number; meshes: number }>;
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
  const deviceDetails: FactoryBuild['deviceDetails'] = [];

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

  // ---------- 厂房围护：只留地坪，围墙已按作者要求移除（2026-11-25） ----------
  //
  // 原来 8 面车间墙 + 动力站 4 面墙合并成 1 个 mesh（D2 合批）。作者看过后要求去掉：
  // 8 m 高的实墙从斜侧机位直接挡住半个车间，看设备反而要绕着找角度。
  // 「室内感」改由柱子 + 屋顶桁架 + 顶部灯带 + 桥架承担（envBuilder.ts），
  // 这些竖向/顶部构件不挡视线。墙材质仍保留在 SceneMaterials 里，将来要做半高围挡可直接复用。
  for (const ws of WORKSHOPS) {
    addPave(ws.x, ws.z, ws.sizeX, ws.sizeZ, `pave:${ws.id}`);
  }
  addPave(POWER_STATION.x, POWER_STATION.z, POWER_STATION.sizeX, POWER_STATION.sizeZ, 'pave:AUX');

  // ---------- 产线色带：合并成 1 个 mesh（4 → 1）----------

  const stripParts: THREE.BufferGeometry[] = [];
  for (const strip of LINE_STRIPS) {
    // R1.5 A 层：色带轨道延长 3 m 顶进墙内被截断（暗示产线延伸到画面外）；设备/道具仍按本体坐标
    const ext = extendedLine(strip);
    const len = Math.abs(ext.x2 - ext.x1);
    const geo = new THREE.BoxGeometry(len, 0.15, 1.2);
    geo.translate((ext.x1 + ext.x2) / 2, 0.075, strip.z);
    stripParts.push(geo);
  }

  const mergedStrip = mergeGeometries(stripParts, false);
  for (const part of stripParts) part.dispose();
  if (!mergedStrip) throw new Error('色带几何合并失败：各段属性不一致');
  const stripMesh = new THREE.Mesh(track(mergedStrip), materials.strip);
  stripMesh.name = 'strip:merged';
  root.add(stripMesh);

  // 标签是 CSS2DObject（DOM 层），不参与 draw call，仍需逐条建
  for (const strip of LINE_STRIPS) {
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

    // ---------- 设备建模 v2（D 批 R2）：先把已启用部件表的类型换成合并几何 ----------
    // 十几个部件按顶点色并成一份几何，只占 1 个 mesh（旧版是 3~5 个 Box 各占 1 次）。
    // 机身不随状态染色（applyDeviceState 只改灯/环与标签），所以合并材质不破坏工况表达；
    // userData.deviceId 仍挂在 mesh 上，D3 的 14/14 点击拾取不受影响。
    const detailKey = partKeyOf(deviceId);
    if (detailKey) {
      const detail = buildDeviceDetail(detailKey);
      const shell = new THREE.Mesh(track(detail.staticGeometry), materials.deviceShell);
      shell.name = `device-shell:${deviceId}`;
      shell.castShadow = true;
      shell.receiveShadow = true;
      shell.userData.deviceId = deviceId;
      group.add(shell);
      deviceDetails.push({
        id: deviceId,
        key: detailKey,
        parts: detail.partKinds.length,
        triangles: detail.triangleCount,
        meshes: detail.meshCount,
      });
      return { group, lampY: 2.9 };
    }

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

  const addOutline = (group: THREE.Group, deviceId: string) => {
    const size = DEVICE_SIZES[sizeKeyOf(typeOfId(deviceId), deviceId)] ?? DEVICE_SIZES.CNC;
    const outlineGeo = track(new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z)));
    const outline = new THREE.LineSegments(outlineGeo, materials.outline);
    outline.position.set(0, size.y / 2, 0);
    outline.visible = false;
    group.add(outline);
    return outline;
  };

  // 灯与环的位置先收集，循环结束后合并成 2 个 InstancedMesh（14 + 14 → 2 次 draw call）
  const lampSlots: Array<{ x: number; y: number; z: number }> = [];
  const ringSlots: Array<{ x: number; z: number }> = [];

  for (const [deviceId, placement] of Object.entries(DEVICE_LAYOUT)) {
    const built = buildDevice(deviceId);
    if (!built) continue;
    const { group, lampY } = built;
    const outline = addOutline(group, deviceId);

    group.position.set(placement.x, 0, placement.z);
    group.rotation.y = placement.rotationY;
    root.add(group);

    const label = makeDeviceLabel(deviceId);
    label.position.set(0, lampY + 0.55, 0);
    group.add(label);

    // 灯挂在 group 局部 (0, lampY, 0)，group 只有平移与绕 Y 旋转，所以世界坐标就是 (x, lampY, z)
    const lampIndex = lampSlots.length;
    lampSlots.push({ x: placement.x, y: lampY, z: placement.z });
    const ringIndex = ringSlots.length;
    ringSlots.push({ x: placement.x, z: placement.z });

    devices.set(deviceId, { group, lampIndex, ringIndex, outline, label, state: null });
  }

  // ---------- 合并后的状态灯与光环 ----------

  const dummy = new THREE.Object3D();

  const lampGeo = track(new THREE.SphereGeometry(0.15, 16, 12));
  const lamps = new THREE.InstancedMesh(lampGeo, materials.lampBase, Math.max(1, lampSlots.length));
  lamps.name = 'lamp:merged';
  lampSlots.forEach((slot, i) => {
    dummy.position.set(slot.x, slot.y, slot.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    lamps.setMatrixAt(i, dummy.matrix);
  });
  lamps.instanceMatrix.needsUpdate = true;
  // 实例散布在全场，父级只有一个 mesh，默认包围球按第一个实例算会把整批误剔除
  lamps.frustumCulled = false;
  root.add(lamps);

  const ringGeo = track(new THREE.RingGeometry(0.95, 1.2, 40));
  ringGeo.rotateX(-Math.PI / 2);
  const rings = new THREE.InstancedMesh(ringGeo, materials.ringBase, Math.max(1, ringSlots.length));
  rings.name = 'ring:merged';
  ringSlots.forEach((slot, i) => {
    dummy.position.set(slot.x, 0.03, slot.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    rings.setMatrixAt(i, dummy.matrix);
  });
  rings.instanceMatrix.needsUpdate = true;
  rings.frustumCulled = false;
  root.add(rings);

  const ringShown: boolean[] = ringSlots.map(() => true);
  const tint = new THREE.Color();

  const lights: StatusLights = {
    lamps,
    rings,
    update: (visuals, t, reduceMotion) => {
      for (const visual of visuals) {
        const state = visual.state;
        const base = state ? STATE_META[state].color : 0x64748b;

        // 相位与频率逐台错开（作者要求：禁止全场同步呼吸）。
        // 相位步长 1.7 rad 是无理数近似，14 台不会在某一刻重新聚齐；
        // 频率在 0.44~0.56 Hz 之间三档轮转，肉眼是"各有各的节奏"，但不是乱闪。
        const i = visual.lampIndex;
        const phase = (i * 1.7) % (Math.PI * 2);
        const breathFreq = 0.5 + ((i % 3) - 1) * 0.06;
        const breath = reduceMotion ? 1 : 0.75 + 0.25 * (0.5 + 0.5 * Math.sin(t * breathFreq * Math.PI * 2 + phase));
        // 告警闪烁仍守 1 Hz（光敏安全上限，频率扰动 ±6% 但不快过 1.06 Hz）
        const blink = reduceMotion ? 1 : 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2 + phase));
        const slow = reduceMotion ? 0.8 : 0.5 + 0.5 * (0.5 + 0.5 * Math.sin(t * 0.5 * Math.PI + phase));

        let lampK = 1;
        if (state === 'RUNNING') lampK = breath;
        else if (state === 'ALARM') lampK = blink;
        else if (state === 'MAINTENANCE') lampK = slow;
        lamps.setColorAt(visual.lampIndex, tint.setHex(base).multiplyScalar(lampK));

        // 光环：ALARM 跟随闪烁，其余按状态给固定亮度；STOPPED / 未连接不画
        const ringK = state === 'ALARM' ? blink : 1;
        const brightness = state ? RING_BRIGHTNESS[state] : 0;
        rings.setColorAt(visual.ringIndex, tint.setHex(base).multiplyScalar(brightness * ringK));

        const show = state !== null && state !== 'STOPPED';
        if (ringShown[visual.ringIndex] !== show) {
          ringShown[visual.ringIndex] = show;
          const slot = ringSlots[visual.ringIndex];
          dummy.position.set(slot.x, 0.03, slot.z);
          dummy.rotation.set(0, 0, 0);
          // 缩到 0 而不是 move 走：实例不能单独 visible，缩放是最省的逐实例开关
          dummy.scale.setScalar(show ? 1 : 0);
          dummy.updateMatrix();
          rings.setMatrixAt(visual.ringIndex, dummy.matrix);
          rings.instanceMatrix.needsUpdate = true;
        }
      }

      // 28 次颜色写入 + 每个 buffer 各 168 字节上传，成本可忽略；不做脏检查是为了少一处状态不同步的坑
      if (lamps.instanceColor) lamps.instanceColor.needsUpdate = true;
      if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
    },
    disconnect: (visuals) => {
      for (const visual of visuals) {
        visual.state = null;
        setLabelActive(visual.label, false);
        lamps.setColorAt(visual.lampIndex, tint.setHex(0x64748b));
        rings.setColorAt(visual.ringIndex, tint.setHex(0x64748b).multiplyScalar(0));
        if (ringShown[visual.ringIndex]) {
          ringShown[visual.ringIndex] = false;
          const slot = ringSlots[visual.ringIndex];
          dummy.position.set(slot.x, 0.03, slot.z);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.setScalar(0);
          dummy.updateMatrix();
          rings.setMatrixAt(visual.ringIndex, dummy.matrix);
          rings.instanceMatrix.needsUpdate = true;
        }
      }
      if (lamps.instanceColor) lamps.instanceColor.needsUpdate = true;
      if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
    },
  };

  // ---------- 工业道具（D2）----------
  // 单独一个 builder 管自己的材质与贴图，避免 SceneMaterials 无限膨胀；
  // 但挂在同一个 root 下，dispose 时一起走。
  const props = buildProps();
  root.add(props.root);

  // ---------- 环境层与产线补齐件（本批）----------
  // 六个合并组封顶 draw call；B1 的「维修中」用 CSS2D 标签（DOM，不占 draw call）
  const env = buildEnv();
  root.add(env.root);
  for (const label of env.maintenanceLabels) {
    const obj = makeScenarioLabel(label.text);
    obj.position.set(label.x, label.y, label.z);
    root.add(obj);
  }

  const dispose = () => {
    for (const geo of geometries) geo.dispose();
    grid.dispose?.();
    props.dispose();
    env.dispose();
    disposeMaterials(materials);
  };

  return {
    root,
    devices,
    materials,
    lights,
    propKinds: props.kinds,
    envKinds: env.kinds,
    envDrawables: env.drawables,
    setCutaway: env.setCutaway,
    rollers,
    arms,
    deviceDetails,
    dispose,
  };
}

/** 坐标表里没有的设备：堆到动力站旁并在控制台报警，不静默跳过（3.3）。 */
export function placeOrphanDevice(deviceId: string): THREE.Group {
  const group = new THREE.Group();
  group.name = `device:${deviceId}`;
  group.userData.deviceId = deviceId;
  group.position.set(FALLBACK_PLACEMENT.x, 0, FALLBACK_PLACEMENT.z);
  return group;
}

/** 状态切换只改内部状态与标签；灯/环的颜色由 StatusLights.update 每帧统一写。 */
export function applyDeviceState(visual: DeviceVisual, state: EffectiveState): void {
  if (visual.state === state) return;
  visual.state = state;
  setLabelActive(visual.label, state === 'ALARM');
}

/** WS 断开：状态灯转灰、光环隐藏，不再按最后一帧闪烁（8.2）。颜色由 lights.disconnect 写。 */
export function applyDisconnected(visuals: Iterable<DeviceVisual>): void {
  for (const visual of visuals) {
    visual.state = null;
    setLabelActive(visual.label, false);
  }
}

export function setDeviceSelected(visual: DeviceVisual, selected: boolean): void {
  visual.outline.visible = selected;
  setLabelActive(visual.label, selected);
}
