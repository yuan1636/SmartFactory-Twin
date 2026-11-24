/**
 * 产线运行动画（规格 6.7）。四条规则，全部由真实状态驱动、都能被脚本断言：
 *  1. 带面纹路恒速滚动 = 皮带在转（设备状态不改变带速，只改变闸门开合）；
 *  2. 物料沿流向匀速前进，遇到关闭的闸门（ALARM / STOPPED / MAINTENANCE / 无数据）
 *     停在设备入口前，后面的依次排队；走到终点下线、回起点重新上料；
 *  3. 输送机滚筒只在该机自身"运行中/待机"时自转，否则停转；
 *  4. 机器人只在该机自身"运行中/待机"时摆动，停机就停在当前姿态。
 * WS 断开（全部设备无状态）时整线冻结，绝不假装还在生产；prefers-reduced-motion 时同样冻结。
 */

import * as THREE from 'three';
import type { EffectiveState } from '../utils/status';
import type { FactoryBuild, RollerRig } from './builders';
import { DEVICE_LAYOUT, DEVICE_SIZES, LINE_DEVICES, LINE_STRIPS, sizeKeyOf, type LineStripSpec } from './layout';
import { advanceFlow, type Gate } from './lineTraffic';

/** 额定带速（m/s）。40m 视距下低于 1.5 几乎看不出在动。 */
const BELT_SPEED = 2.4;
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
/** 允许通过的状态：运行中与待机都算通路 */
const OPEN_STATES: ReadonlySet<EffectiveState> = new Set<EffectiveState>(['RUNNING', 'IDLE']);

interface GateSpec {
  deviceId: string;
  /** 设备入口（沿流向的上游侧）再往前 STOP_GAP 米 */
  x: number;
}

interface LineRuntime {
  lineId: string;
  start: number;
  end: number;
  z: number;
  gates: GateSpec[];
  /** 与 gates 一一对应的开合状态，供调试面板与验收脚本核对 */
  gateClosed: boolean[];
  items: THREE.InstancedMesh;
  cleats: THREE.InstancedMesh;
  itemXs: number[];
  cleatXs: number[];
  running: boolean;
  blockedBy: string | null;
}

export interface MotionSnapshot {
  paused: boolean;
  lines: Array<{
    lineId: string;
    start: number;
    end: number;
    running: boolean;
    blockedBy: string | null;
    /** 按流向升序的物料坐标（保留两位小数，下标与物料一一对应） */
    items: number[];
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
  const track = <T extends THREE.BufferGeometry>(geo: T): T => {
    geometries.push(geo);
    return geo;
  };

  const dummy = new THREE.Object3D();
  const lines: LineRuntime[] = [];
  const rollerAngles = new Map<string, { rig: RollerRig; angle: number; spinning: boolean }>();
  const armPhase = new Map<string, number>();
  let pausedNow = false;

  const itemGeo = track(new THREE.BoxGeometry(ITEM_SIZE.x, ITEM_SIZE.y, ITEM_SIZE.z));
  const cleatGeo = track(new THREE.BoxGeometry(CLEAT_SIZE.x, CLEAT_SIZE.y, CLEAT_SIZE.z));

  const buildLine = (strip: LineStripSpec): LineRuntime | null => {
    const deviceIds = LINE_DEVICES[strip.line_id];
    if (!deviceIds) return null;

    const length = Math.abs(strip.x2 - strip.x1);
    const itemCount = Math.floor(length / ITEM_SPACING);
    const cleatCount = Math.floor(length / CLEAT_SPACING) + 1;

    const items = new THREE.InstancedMesh(itemGeo, build.materials.workpiece, itemCount);
    items.name = `flow:${strip.line_id}:items`;
    items.castShadow = true;
    items.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    build.root.add(items);

    const cleats = new THREE.InstancedMesh(cleatGeo, build.materials.cleat, cleatCount);
    cleats.name = `flow:${strip.line_id}:cleats`;
    cleats.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    build.root.add(cleats);

    // 起始排料：从起点等距铺开，第一条要能立刻看见
    const itemXs: number[] = [];
    for (let i = 0; i < itemCount; i += 1) itemXs.push(strip.x1 + i * ITEM_SPACING);
    const cleatXs: number[] = [];
    for (let i = 0; i < cleatCount; i += 1) cleatXs.push(strip.x1 + i * CLEAT_SPACING);

    return {
      lineId: strip.line_id,
      start: strip.x1,
      end: strip.x2,
      z: strip.z,
      gates: deviceIds.map(gateOf).filter((g): g is GateSpec => g !== null),
      gateClosed: [],
      items,
      cleats,
      itemXs,
      cleatXs,
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
      const onLine = x >= line.start - OFF_LINE_MARGIN && x <= line.end + OFF_LINE_MARGIN;
      dummy.position.set(x, ITEM_Y, line.z);
      dummy.rotation.set(0, 0, 0);
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
        speed: BELT_SPEED,
        dt: step,
        spacing: ITEM_SPACING,
        stopGap: 0,
      });
      line.itemXs = flow.positions;

      // 带面纹路：一直滚（皮带在转），滚过终点就绕回起点
      const span = line.end - line.start;
      line.cleatXs = line.cleatXs
        .map((x) => {
          const next = x + BELT_SPEED * step;
          return next >= line.end ? next - span : next;
        })
        .sort((a, b) => a - b);

      writeItems(line);
      writeCleats(line);
    }

    // 滚筒：只在本机"运行中/待机"时自转；ω = v / r，视觉上才不打滑
    for (const [deviceId, entry] of rollerAngles) {
      const state = stateOf(deviceId);
      entry.spinning = state !== null && OPEN_STATES.has(state);
      if (entry.spinning) entry.angle = (entry.angle + (BELT_SPEED / 0.18) * step) % (Math.PI * 2);
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
      pivot.rotation.y = Math.sin(phase * 0.55) * 0.42;
    }
  };

  const snapshot = (): MotionSnapshot => ({
    paused: pausedNow,
    lines: lines.map((line) => ({
      lineId: line.lineId,
      start: line.start,
      end: line.end,
      running: line.running,
      blockedBy: line.blockedBy,
      items: line.itemXs.map((x) => Math.round(x * 100) / 100),
      visibleItems: line.itemXs.filter((x) => x >= line.start - OFF_LINE_MARGIN).length,
      cleat: Math.round((line.cleatXs[0] ?? 0) * 100) / 100,
      gates: line.gates.map((gate, i) => ({
        deviceId: gate.deviceId,
        x: Math.round(gate.x * 100) / 100,
        closed: line.gateClosed[i] ?? true,
      })),
    })),
    rollers: [...rollerAngles.entries()].map(([deviceId, entry]) => ({
      deviceId,
      angle: Math.round(entry.angle * 100) / 100,
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
    for (const geo of geometries) geo.dispose();
  };

  return { update, snapshot, dispose };
}
