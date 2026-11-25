/**
 * 产线运行动画（规格 6.7 + 作者 2026-11-25 追加的表现层要求）。规则：
 *  1. 带面纹路按**本线速度**滚动（B1 检修时速度 0，纹路停住——皮带没转，纹路就不该动）；
 *  2. 物料沿流向前进，遇关闭闸门（ALARM / STOPPED / MAINTENANCE / 无数据）停在入口前排队；
 *     起步缓加速、到位前按刹车距离减速、顶到限制位后停顿 0.2~0.3 秒（本批新增）；
 *  3. 物料排布不规整：每件固定横向错位与 ±2° 偏转（种子确定，脚本可复现）；
 *  4. 四条线四种工况（scenario.ts）：料数、颜色、速度、停顿、设备状态各不相同；
 *  5. 输送机滚筒按本线速度自转，机器人只在本机运行时摆动；
 *  6. WS 断开整线冻结；prefers-reduced-motion 同样冻结。
 *
 * 边界：工况是**展示层**，只改外观与闸门，不改后端、不改数据。
 */

import * as THREE from 'three';
import type { EffectiveState } from '../utils/status';
import type { FactoryBuild, RollerRig } from './builders';
import { DEVICE_LAYOUT, DEVICE_SIZES, LINE_DEVICES, LINE_STRIPS, sizeKeyOf, type LineStripSpec } from './layout';
import { advanceFlow, type Gate } from './lineTraffic';
import { RATED_BELT_SPEED, SCENARIO_BY_LINE, seededRandom, type LineCondition, type LineScenario } from './scenario';

/** 物料间距与外形（米）：0.9×0.5×0.9 的料箱，落在色带面（0.15）上 */
const ITEM_SPACING = 3.0;
const ITEM_SIZE = { x: 0.9, y: 0.5, z: 0.9 };
const ITEM_Y = 0.15 + ITEM_SIZE.y / 2;
/** 带面纹路间距 */
const CLEAT_SPACING = 1.4;
const CLEAT_SIZE = { x: 0.09, y: 0.05, z: 1.0 };
const CLEAT_Y = 0.15 + CLEAT_SIZE.y / 2;
/** 停在设备入口前多少米 */
const STOP_GAP = 0.8;
/** 排在产线起点之前的物料不上线（不渲染），避免料箱飘在色带外面 */
const OFF_LINE_MARGIN = 0.5;
/** 滚筒半径（m），ω = v / r */
const ROLLER_RADIUS = 0.18;
/** 允许通过的状态：运行中与待机都算通路 */
const OPEN_STATES: ReadonlySet<EffectiveState> = new Set<EffectiveState>(['RUNNING', 'IDLE']);

interface GateSpec {
  deviceId: string;
  /** 设备入口（沿流向的上游侧）再往前 STOP_GAP 米 */
  x: number;
}

interface LineRuntime {
  lineId: string;
  scenario: LineScenario;
  start: number;
  end: number;
  z: number;
  /** 本线带速（m/s）；0 = 停住 */
  speed: number;
  gates: GateSpec[];
  /** 与 gates 一一对应的开合状态，供调试面板与验收脚本核对 */
  gateClosed: boolean[];
  items: THREE.InstancedMesh;
  cleats: THREE.InstancedMesh;
  itemXs: number[];
  velocities: number[];
  dwell: number[];
  cleatXs: number[];
  /** 每件物料的固定错位与偏转（渲染用，不参与交通计算） */
  jitter: Array<{ dx: number; yaw: number }>;
  running: boolean;
  blockedBy: string | null;
}

export interface MotionSnapshot {
  paused: boolean;
  lines: Array<{
    lineId: string;
    condition: LineCondition;
    label: string;
    /** 本线带速（m/s） */
    speed: number;
    start: number;
    end: number;
    running: boolean;
    blockedBy: string | null;
    /** 按流向升序的物料坐标（保留两位小数，下标与物料一一对应） */
    items: number[];
    /** 逐物料速度（m/s）：验证"起步加速/到位减速"用的原始数据 */
    velocities: number[];
    /** 逐物料的渲染偏移：dx（米）与 yaw（度） */
    jitter: Array<{ dx: number; yawDeg: number }>;
    /** 可见（在色带范围内）的物料数 */
    visibleItems: number;
    /** 第一条带面纹路的坐标，用来验证纹路在动 */
    cleat: number;
    /** 本线的闸门：坐标 + 此刻是否关闭 */
    gates: Array<{ deviceId: string; x: number; closed: boolean }>;
  }>;
  rollers: Array<{ deviceId: string; angle: number; spinning: boolean }>;
  arms: Array<{ deviceId: string; angle: number }>;
}

export interface FactoryMotion {
  update: (dt: number, stateOf: (deviceId: string) => EffectiveState | null) => void;
  snapshot: () => MotionSnapshot;
  dispose: () => void;
}

/** 设备入口的闸门坐标：机身沿 X 的一半宽度 + 停料余量。 */
function gateOf(deviceId: string): GateSpec | null {
  const placement = DEVICE_LAYOUT[deviceId];
  if (!placement) return null;
  const type = deviceId.startsWith('CNC')
    ? 'CNC'
    : deviceId.startsWith('ROB')
      ? 'ROBOT'
      : deviceId.startsWith('CONV')
        ? 'CONVEYOR'
        : deviceId.startsWith('INSP')
          ? 'INSPECTION'
          : 'AUX';
  const size = DEVICE_SIZES[sizeKeyOf(type, deviceId)];
  return { deviceId, x: placement.x - size.x / 2 - STOP_GAP };
}

export function createMotion(build: FactoryBuild): FactoryMotion {
  const geometries: THREE.BufferGeometry[] = [];
  const ownedMaterials: THREE.Material[] = [];
  const track = <T extends THREE.BufferGeometry>(geo: T): T => {
    geometries.push(geo);
    return geo;
  };

  const dummy = new THREE.Object3D();
  const lines: LineRuntime[] = [];
  const rollerAngles = new Map<string, { rig: RollerRig; angle: number; spinning: boolean }>();
  const armPhase = new Map<string, number>();
  /** 设备 → 本线带速：滚筒转速必须与带速同步，否则"带在走、辊不转" */
  const deviceLineSpeed = new Map<string, number>();
  let pausedNow = false;

  const itemGeo = track(new THREE.BoxGeometry(ITEM_SIZE.x, ITEM_SIZE.y, ITEM_SIZE.z));
  const cleatGeo = track(new THREE.BoxGeometry(CLEAT_SIZE.x, CLEAT_SIZE.y, CLEAT_SIZE.z));

  for (const strip of LINE_STRIPS) {
    const scenario = SCENARIO_BY_LINE[strip.line_id];
    if (!scenario) continue;
    const speed = RATED_BELT_SPEED * scenario.speedFactor;
    for (const id of LINE_DEVICES[strip.line_id] ?? []) deviceLineSpeed.set(id, speed);
  }

  const buildLine = (strip: LineStripSpec): LineRuntime | null => {
    const deviceIds = LINE_DEVICES[strip.line_id];
    const scenario = SCENARIO_BY_LINE[strip.line_id];
    if (!deviceIds || !scenario) return null;

    const speed = RATED_BELT_SPEED * scenario.speedFactor;
    const length = Math.abs(strip.x2 - strip.x1);
    const itemCount = Math.max(1, Math.min(scenario.itemCount, Math.floor(length / (ITEM_SPACING * 0.6))));
    const cleatCount = Math.floor(length / CLEAT_SPACING) + 1;

    // 物料颜色逐线不同（作者要求：四条线的物料密度、颜色、运动状态必须有肉眼可辨的差别）。
    // 每条线本来就是独立 InstancedMesh，换材质不会多 draw call。
    const itemMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(scenario.itemTint),
      roughness: 0.45,
      metalness: 0.55,
    });
    ownedMaterials.push(itemMaterial);

    const items = new THREE.InstancedMesh(itemGeo, itemMaterial, itemCount);
    items.name = `flow:${strip.line_id}:items`;
    items.castShadow = true;
    items.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    build.root.add(items);

    const cleats = new THREE.InstancedMesh(cleatGeo, build.materials.cleat, cleatCount);
    cleats.name = `flow:${strip.line_id}:cleats`;
    cleats.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    build.root.add(cleats);

    // 抖动与初相位都由种子决定：同一条线每次加载长得一样，四条线互相不同（可复现）
    const rnd = seededRandom(scenario.seed);
    const jitter = Array.from({ length: itemCount }, () => ({
      dx: (rnd() * 2 - 1) * scenario.offsetJitter,
      yaw: ((rnd() * 2 - 1) * scenario.yawJitterDeg * Math.PI) / 180,
    }));

    // 起始排料：按本线料距铺开，并给一个种子相位，四条线不会同时起步；
    // 冻结工况（B1 检修）用工况表给的停机快照位置——带速 0 时物料不会自己走到机前
    const spread = ITEM_SPACING * scenario.spacingFactor;
    const phase = rnd() * spread;
    const itemXs: number[] = [];
    for (let i = 0; i < itemCount; i += 1) {
      const offset = scenario.initialOffsets?.[i];
      const x = offset !== undefined ? strip.x1 + offset : strip.x1 + phase * 0.4 + i * spread;
      itemXs.push(Math.max(strip.x1, Math.min(strip.x2 - 0.6, x)));
    }
    const cleatXs: number[] = [];
    for (let i = 0; i < cleatCount; i += 1) cleatXs.push(strip.x1 + rnd() * CLEAT_SPACING + i * CLEAT_SPACING);

    return {
      lineId: strip.line_id,
      scenario,
      start: strip.x1,
      end: strip.x2,
      z: strip.z,
      speed,
      gates: deviceIds.map(gateOf).filter((g): g is GateSpec => g !== null),
      gateClosed: [],
      items,
      cleats,
      itemXs,
      velocities: itemXs.map(() => 0),
      dwell: itemXs.map(() => 0),
      cleatXs: cleatXs.sort((a, b) => a - b),
      jitter,
      running: true,
      blockedBy: null,
    };
  };

  for (const strip of LINE_STRIPS) {
    const line = buildLine(strip);
    if (line) lines.push(line);
  }

  for (const [deviceId, rig] of build.rollers) {
    rollerAngles.set(deviceId, { rig, angle: 0, spinning: false });
  }
  for (const deviceId of build.arms.keys()) armPhase.set(deviceId, 0);

  const writeItems = (line: LineRuntime) => {
    for (let i = 0; i < line.itemXs.length; i += 1) {
      const x = line.itemXs[i];
      const j = line.jitter[i];
      const onLine = x >= line.start - OFF_LINE_MARGIN && x <= line.end + OFF_LINE_MARGIN;
      dummy.position.set(x + j.dx, ITEM_Y, line.z);
      // 偏转 ±2°：物料不是阅兵方阵，静止时也能看出"人手摆的"
      dummy.rotation.set(0, j.yaw, 0);
      // 排在起点之前的料"还没上线"：缩成 0 隐藏，不额外占 draw call
      dummy.scale.setScalar(onLine ? 1 : 0);
      dummy.updateMatrix();
      line.items.setMatrixAt(i, dummy.matrix);
    }
    line.items.instanceMatrix.needsUpdate = true;
  };

  const writeCleats = (line: LineRuntime) => {
    for (let i = 0; i < line.cleatXs.length; i += 1) {
      dummy.position.set(line.cleatXs[i], CLEAT_Y, line.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      line.cleats.setMatrixAt(i, dummy.matrix);
    }
    line.cleats.instanceMatrix.needsUpdate = true;
  };

  for (const line of lines) {
    writeItems(line);
    writeCleats(line);
  }

  const update = (dt: number, stateOf: (deviceId: string) => EffectiveState | null) => {
    const step = Math.max(0, Math.min(dt, 0.1)); // 切标签页回来时 dt 会很大，钳死避免瞬移
    pausedNow = step === 0;

    for (const line of lines) {
      const closed: Gate[] = [];
      line.gateClosed = line.gates.map((gate) => {
        const state = stateOf(gate.deviceId);
        const isClosed = state === null || !OPEN_STATES.has(state);
        if (isClosed) closed.push({ x: gate.x, deviceId: gate.deviceId });
        return isClosed;
      });
      closed.sort((a, b) => a.x - b.x);
      line.running = closed.length === 0;
      line.blockedBy = closed.length > 0 ? closed[0].deviceId : null;

      const flow = advanceFlow({
        positions: line.itemXs,
        gates: closed,
        start: line.start,
        end: line.end,
        // 回炉落到带外一个料距的位置：带满时它在色带外等着，有空位才进线
        recycleTo: line.start - ITEM_SPACING,
        speed: line.speed,
        targetSpeed: line.speed,
        accel: line.speed > 0 ? line.scenario.accel : 0,
        decel: line.scenario.decel,
        dwellSeconds: line.scenario.dwellSeconds,
        velocities: line.velocities,
        dwell: line.dwell,
        dt: step,
        spacing: ITEM_SPACING,
        stopGap: 0,
      });
      line.itemXs = flow.positions;
      line.velocities = flow.velocities;
      line.dwell = flow.dwell;

      // 带面纹路按本线速度滚：速度 0（检修）时纹路必须停住
      const span = line.end - line.start;
      line.cleatXs = line.cleatXs
        .map((x) => {
          const next = x + line.speed * step;
          return next >= line.end ? next - span : next;
        })
        .sort((a, b) => a - b);

      writeItems(line);
      writeCleats(line);
    }

    // 滚筒：只在本机"运行中/待机"时自转；ω = v / r（v 取本线带速）
    for (const [deviceId, entry] of rollerAngles) {
      const state = stateOf(deviceId);
      const speed = deviceLineSpeed.get(deviceId) ?? RATED_BELT_SPEED;
      entry.spinning = state !== null && OPEN_STATES.has(state) && speed > 0;
      if (entry.spinning) entry.angle = (entry.angle + (speed / ROLLER_RADIUS) * step) % (Math.PI * 2);
      const rig = entry.rig;
      for (let i = 0; i < rig.xs.length; i += 1) {
        dummy.position.set(rig.xs[i], rig.y, 0);
        dummy.rotation.set(0, 0, entry.angle);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        rig.rollers.setMatrixAt(i, dummy.matrix);

        // 定位条绕轴心公转：这是"看得见的转速"
        dummy.position.set(
          rig.xs[i] + Math.cos(entry.angle) * rig.radius,
          rig.y + Math.sin(entry.angle) * rig.radius,
          0,
        );
        dummy.rotation.set(0, 0, entry.angle);
        dummy.updateMatrix();
        rig.marks.setMatrixAt(i, dummy.matrix);
      }
      rig.rollers.instanceMatrix.needsUpdate = true;
      rig.marks.instanceMatrix.needsUpdate = true;
    }

    // 机器人摆动：只在本机运行时累加相位，停机就冻结在当前姿态
    for (const [deviceId, pivot] of build.arms) {
      const state = stateOf(deviceId);
      const open = state !== null && OPEN_STATES.has(state);
      if (open) armPhase.set(deviceId, (armPhase.get(deviceId) ?? 0) + step);
      const phase = armPhase.get(deviceId) ?? 0;
      // 摆动幅度也逐台不同（同样的相位不同摆幅，14 台不会像广播体操）
      const amp = 0.34 + ((deviceId.charCodeAt(deviceId.length - 1) % 5) * 0.04);
      pivot.rotation.y = Math.sin(phase * 0.55) * amp;
    }
  };

  const round2 = (n: number) => Math.round(n * 100) / 100;

  const snapshot = (): MotionSnapshot => ({
    paused: pausedNow,
    lines: lines.map((line) => ({
      lineId: line.lineId,
      condition: line.scenario.condition,
      label: line.scenario.label,
      speed: line.speed,
      start: line.start,
      end: line.end,
      running: line.running,
      blockedBy: line.blockedBy,
      items: line.itemXs.map(round2),
      velocities: line.velocities.map(round2),
      jitter: line.jitter.map((j) => ({ dx: round2(j.dx), yawDeg: Math.round((j.yaw * 180) / Math.PI * 10) / 10 })),
      visibleItems: line.itemXs.filter((x) => x >= line.start - OFF_LINE_MARGIN).length,
      cleat: round2(line.cleatXs[0] ?? 0),
      gates: line.gates.map((gate, i) => ({
        deviceId: gate.deviceId,
        x: round2(gate.x),
        closed: line.gateClosed[i] ?? true,
      })),
    })),
    rollers: [...rollerAngles.entries()].map(([deviceId, entry]) => ({
      deviceId,
      angle: round2(entry.angle),
      spinning: entry.spinning,
    })),
    arms: [...build.arms.keys()].map((deviceId) => ({
      deviceId,
      angle: Math.round((build.arms.get(deviceId)?.rotation.y ?? 0) * 100) / 100,
    })),
  });

  const dispose = () => {
    for (const line of lines) {
      build.root.remove(line.items);
      build.root.remove(line.cleats);
      line.items.dispose();
      line.cleats.dispose();
    }
    for (const m of ownedMaterials) m.dispose();
    for (const geo of geometries) geo.dispose();
  };

  return { update, snapshot, dispose };
}
