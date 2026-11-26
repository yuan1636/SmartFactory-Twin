/**
 * 三维场景挂载点。React 只负责生命周期，场景内部全部是 three 的命令式代码。
 * 结构要点：
 *  - 状态更新走 store 订阅，不经过 React 渲染（G-17：每秒 1 次快照不能让 14 个组件重渲染）；
 *  - 每秒只改共享材质的 opacity 与 mesh.material 引用，不新建任何材质/几何；
 *  - 严格模式下会挂载两次，cleanup 必须彻底释放，否则页面上会留两个画布。
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { readStore, subscribeStore } from '../hooks/useTelemetry';
import type { EffectiveState } from '../utils/status';
import { applyDeviceState, applyDisconnected, buildFactory, setDeviceSelected, type DeviceVisual } from './builders';
import { cutawaySides } from './envInterior';
import { CAMERA_PRESETS, DEFAULT_FOV, ENTRANCE_PATH, ENTRANCE_START, ORBIT_LIMITS, PRESET_ORDER, focusPose, type CameraPose, type PresetKey } from './cameraPresets';
import { createLabelRenderer, setLabelShown } from './labels';
import { DEVICE_LAYOUT, DEVICE_SIZES, deviceBox, deviceTypeOf, sizeKeyOf } from './layout';
import { createMotion, type MotionSnapshot } from './motion';
import { createPostFx, POSTFX, type PostFx } from './postfx';
import { LINE_SCENARIOS, overriddenState, scenarioBadgeText } from './scenario';
import { SKY_CLEAR_HEX, SKY_INTENSITY, makeSkyTexture } from './sky';

export interface SceneStats {
  /** 整链总 draw call（场景 + 所有后处理 pass），D1 起验收按这个数算 */
  calls: number;
  triangles: number;
  fps: number;
  /** 只含场景的 draw call（不含后处理），D2 的「≤100」按这个数判 */
  sceneCalls: number;
  /** 阴影 pass 的 draw call（只与投影体数量有关） */
  shadowCalls: number;
  /** 后处理引入的额外 draw call = calls - sceneCalls - shadowCalls */
  postPasses: number;
}

export interface SceneHandle {
  setPreset: (key: PresetKey) => void;
  focusDevice: (deviceId: string) => void;
  toggleTour: () => void;
  getStats: () => SceneStats;
}

interface SceneRootProps {
  selectedDeviceId?: string | null;
  /** D3 起：三维点击不再跳转监控页，外层负责弹设备详情；传 null 表示清除选中（R 复位） */
  onSelectDevice?: (deviceId: string | null) => void;
  showFps?: boolean;
}

declare global {
  interface Window {
    __sceneDebug?: {
      renderInfo: () => SceneStats;
      /** 只读相机位姿：验收脚本用它确认预设切换有缓动、且镜头不会钻到地面以下。
       *  lastTransitionMs 是最近一次完成的过渡的实际耗时（入场完成前为 null），D3 验收读它断言时长；
       *  transitionSeq 每完成一次过渡 +1：脚本靠它判断「过渡结束了」，比比对耗时长得多
       *  （两次过渡耗时可能因帧量化恰好相等，用时延判断会漏判） */
      camera: () => {
        position: [number, number, number];
        target: [number, number, number];
        lastTransitionMs: number | null;
        transitionSeq: number;
      };
      /** D3：5 个预设的键名与位姿（脚本两两切换、断言终点位姿用） */
      presets: () => Array<{ key: PresetKey; position: [number, number, number]; target: [number, number, number] }>;
      /** D3：14 台设备包围盒（断言相机过渡路径不穿设备） */
      deviceBoxes: () => Record<string, { min: [number, number, number]; max: [number, number, number] }>;
      /** D3：设备中心投影到屏幕的 CSS 像素坐标（逐台点击测命中率用） */
      deviceAnchors: () => Record<string, { x: number; y: number; behind: boolean }>;
      /** 展示页：任意世界坐标投影到屏幕 CSS 像素（构图对称性自检用） */
      projectPoint: (x: number, y: number, z: number) => { x: number; y: number; behind: boolean };
      /** D3：巡游状态（第几站、站名、是否在跑） */
      tour: () => { active: boolean; index: number; station: PresetKey };
      /** 产线运行动画快照：验收脚本用它确认物料在动、堵料时停在设备前、降级时冻结 */
      lineMotion: () => MotionSnapshot;
      /** 实时设备状态表（含演示工况覆盖，与三维画面一致）：验收脚本据此推导哪条产线该被挡住 */
      deviceStates: () => Record<string, EffectiveState | null>;
      /** 原始 WS 状态表（不含工况覆盖）：用来核对"图上与列表不一致是工况，不是数据错" */
      wsDeviceStates: () => Record<string, EffectiveState | null>;
      /** 四条线的演示工况（本批）：条件、料数、带速、状态覆盖 */
      scenario: () => Array<{
        lineId: string;
        condition: string;
        label: string;
        itemCount: number;
        itemTint: string;
        speedFactor: number;
        overrides: Record<string, EffectiveState>;
      }>;
      /** 环境层：类别清单 + 各组绘制体数量（验收断言"≤6 次"） */
      env: () => { kinds: string[]; drawables: Array<{ group: string; meshes: number }> };
      /** 只给验收脚本用：把相机移到指定位姿。D0 的 6 张固定机位截图靠它复现，只存在于 DEV 分支 */
      setCamera: (pose: CameraPose) => void;
      /** 后处理参数读数（D1）：pass 链名字 + 曝光 + bloom 三项 + 雾 */
      postfx: () => {
        passes: string[];
        exposure: number;
        toneMapping: number;
        bloom: { strength: number; radius: number; threshold: number };
        fog: { near: number; far: number; color: string } | null;
      };
      /** 场景自身 draw call（不含后处理）：D2 的 ≤100 按它判 */
      measureSceneCalls: (withShadows?: boolean) => {
        sceneCalls: number;
        sceneTriangles: number;
        withShadows: boolean;
      };
      profile: () => {
        total: number;
        sceneCalls: number;
        shadowCalls: number;
        postPasses: number;
        sceneTriangles: number;
      };
      /** 按名称前缀分组统计可见绘制体，用来回答"这 120 次画在什么上面"（D2 合批的依据与证据） */
      breakdown: () => Array<{ kind: string; meshes: number; triangles: number }>;
      /** 已建立的工业道具类别 */
      propKinds: () => string[];
      /** 设备建模 v2（D 批 R2/R3）：逐台的部件类别数 / mesh 数 / 三角数，验收读它断言 §10.4 */
      deviceDetail: () => Array<{ id: string; key: string; parts: number; triangles: number; meshes: number }>;
    };
  }
}

// 过渡时长（D3）。预设切换硬指标 ≤1200ms，计划 1000ms 留掉帧余量；
// 入场 3.0±0.2s；setCamera 是调试钩子，audit-shot.mjs 按它等待，改动必须同步那边。
const DUR_PRESET = 1000;
const DUR_ENTRANCE = 3000;
const DUR_SETCAM = 600;
const TOUR_INTERVAL_MS = 6000; // 巡游每 6 秒换一个机位（规格 D3）

const SceneRoot = forwardRef<SceneHandle, SceneRootProps>(function SceneRoot(
  { selectedDeviceId = null, onSelectDevice, showFps = true },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fpsRef = useRef<HTMLDivElement | null>(null);
  const tourRef = useRef<HTMLDivElement | null>(null);
  const scenarioRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<{
    setPreset: (key: PresetKey) => void;
    focusDevice: (deviceId: string) => void;
    toggleTour: () => void;
    select: (deviceId: string | null) => void;
    getStats: () => SceneStats;
  } | null>(null);
  const selectedRef = useRef<string | null>(selectedDeviceId);
  const onSelectRef = useRef(onSelectDevice);
  onSelectRef.current = onSelectDevice;

  useImperativeHandle(ref, () => ({
    setPreset: (key) => apiRef.current?.setPreset(key),
    focusDevice: (id) => apiRef.current?.focusDevice(id),
    toggleTour: () => apiRef.current?.toggleTour(),
    getStats: () => apiRef.current?.getStats() ?? { calls: 0, triangles: 0, fps: 0, sceneCalls: 0, shadowCalls: 0, postPasses: 0 },
  }));

  // 选中态变化只需要改描边 + 推近相机，不必重建场景。
  // 相机飞行也走这里（而不是点击处理里直接飞）：3D 点击与侧栏列表点行最终都汇到这一条路，不会双重过渡。
  useEffect(() => {
    selectedRef.current = selectedDeviceId;
    apiRef.current?.select(selectedDeviceId);
  }, [selectedDeviceId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    // 背景：暗青竖向渐变贴图（作者 2026-11-25 整体色调亮化，参考智慧车间 HUD 截图）。
    // 贴图里填的是 ACES 补偿值（见 sky.ts），backgroundIntensity 回到 1.0。
    // 不用 scene.background = new THREE.Color(0xffffff)：Color 走 clearColor 会被夹在 [0,1]，
    // 过 ACES 后屏幕上只有 #d1d1d1（浅灰）。理由与实测值见 sky.ts。
    const backgroundTexture = makeSkyTexture();
    scene.background = backgroundTexture;
    scene.backgroundIntensity = SKY_INTENSITY;
    // 雾已移除（作者要求「不要迷雾」）：远景不再淡出，靠白底与阴影拉开层次。
    scene.fog = null;

    // R1.5 A 层：默认 FOV 45→60（作者指定），人视预设（WALK/AISLE）再各自加广角
    const camera = new THREE.PerspectiveCamera(DEFAULT_FOV, 1, 0.5, 400);
    const preset = CAMERA_PRESETS.overview;
    camera.position.set(...preset.position);

    // antialias 关掉：接入 EffectComposer 后，默认帧缓冲的 MSAA 作用不到中间 target，
    // 抗锯齿交给 postfx 里的 SMAAPass（D1 / 规格 §6.1）
    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // 清屏色=白：背景贴图始终在，清屏色只在贴图拆掉的那一帧可见，与画布保持一致避免闪一下
    renderer.setClearColor(SKY_CLEAR_HEX, 1); // SKY_CLEAR_HEX 已是 0xRRGGBB 整数（sky.ts）
    // ACESFilmic 必须在加 Bloom 之前设：NoToneMapping 下高光会被直接截断成纯白块
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = POSTFX.exposure;
    // 关掉自动重置：一次 composer.render() 里包含多个 pass，只有累积才能量到真实总 draw call
    renderer.info.autoReset = false;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.style.display = 'block';
    host.appendChild(renderer.domElement);

    const labelRenderer = createLabelRenderer();
    host.appendChild(labelRenderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(...preset.target);
    controls.minDistance = ORBIT_LIMITS.minDistance;
    controls.maxDistance = ORBIT_LIMITS.maxDistance;
    controls.maxPolarAngle = ORBIT_LIMITS.maxPolarAngle;
    controls.enableDamping = true;
    controls.dampingFactor = ORBIT_LIMITS.dampingFactor;
    controls.update();

    // ACESFilmic 会压暗中间调（这正是它的目的：保住高光），所以配合色调映射必须把光补回来，
    // 否则设备细节全埋进暗部——D1 第一版就是这个症状：墙有了，但"看不清"（比 D0 更糟）。
    // 冷天光 + 暖地光的半球光负责"体积感"，主方向光负责投影，反侧补光只提亮暗面、不投影。
    const hemi = new THREE.HemisphereLight(0xdfe9f5, 0x2a3a4d, 1.55);
    scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xfff4e2, 1.7);
    dir.position.set(30, 50, 20);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.left = -60;
    dir.shadow.camera.right = 60;
    dir.shadow.camera.top = 60;
    dir.shadow.camera.bottom = -60;
    dir.shadow.camera.near = 1;
    dir.shadow.camera.far = 160;
    scene.add(dir);

    // 反侧补光：只负责把主光打不到的暗面从"全黑"提到"能看出轮廓"，不投影（投影会让画面脏）
    const fill = new THREE.DirectionalLight(0x9dc4e8, 0.45);
    fill.position.set(-40, 30, -25);
    scene.add(fill);

    // ---- D 批 R1：室内补光 ----
    // 车间装回 8 m 围墙后，上面这盏投影主光被挡在墙外，室内只剩不到一半的照度（实测会暗 20%+）。
    // 三件一套：半球光抬底（模拟墙面/地面的互相反弹），两盏不投影的天窗光把光"从屋顶漏进来"。
    // 都不投影：室内已经有主光的投影，再加两套阴影会让地面发脏，而且阴影贴图重算三倍。
    const interiorHemi = new THREE.HemisphereLight(0x9fb2c4, 0x1f2b3a, 1.15);
    scene.add(interiorHemi);

    const skylight1 = new THREE.DirectionalLight(0xdce8f4, 1.35);
    skylight1.position.set(-26, 44, 52); // 从南侧天窗方向斜下
    skylight1.castShadow = false;
    scene.add(skylight1);

    const skylight2 = new THREE.DirectionalLight(0xcfdcea, 0.9);
    skylight2.position.set(34, 40, -46); // 反侧补，避免室内只剩一个方向的明暗
    skylight2.castShadow = false;
    scene.add(skylight2);

    const build = buildFactory();
    scene.add(build.root);

    // 后处理管线（D1 视觉基调）：RenderPass → Bloom → OutputPass → SMAA。
    // 必须在 build 之后创建，否则首帧没有 bloom 与色调映射，截图会拍到"半成品"。
    const postfx: PostFx = createPostFx(
      renderer,
      scene,
      camera,
      host.clientWidth || 1,
      host.clientHeight || 1,
    );

    // 产线运行动画（规格 6.7）。每帧只读一次 store，14 台设备共用同一个快照
    const motion = createMotion(build);
    let frameState = readStore();
    /**
     * 三维画面的"有效状态" = 演示工况覆盖 ?? 真实 WS 状态。
     * 为什么要有覆盖：作者要求四条线四种可辨工况（A2 预警、B1 检修停住、B2 半停）。
     * 覆盖只影响三维着色、闸门、滚筒与机械臂，**不改后端、不改数据库、不改 WS 契约**；
     * 页面右侧列表与 KPI 仍显示真实数据，界面上有「三维演示工况」角标说明这一点。
     * WS 断开时一律返回 null（不能拿工况假装有数据）。
     */
    const stateOf = (deviceId: string): EffectiveState | null => {
      if (frameState.wsStatus !== 'connected') return null;
      return overriddenState(deviceId) ?? frameState.byId[deviceId]?.state ?? null;
    };

    // 坐标表与后端设备清单不一致时大声报出来，不静默跳过（3.3）
    const snapshot = readStore();
    for (const device of snapshot.devices) {
      if (!build.devices.has(device.device_id)) {
        console.warn(`[layout] 缺少设备 ${device.device_id}，已跳过摆位`);
      }
    }

    let hoveredId: string | null = null;
    const refreshHighlight = () => {
      for (const [id, visual] of build.devices) {
        const active = id === hoveredId || id === selectedRef.current;
        setDeviceSelected(visual, active);
        // 名牌默认隐藏，悬停或选中该设备时才显示（纯三维展示页，作者 2026-11-25 指定）
        setLabelShown(visual.label, active);
      }
    };
    refreshHighlight();

    /** 状态写入 visual + 已断开转灰；灯/环的实际颜色由主循环里的 lights.update 统一刷 */
    const applyStore = () => {
      const state = readStore();
      if (state.wsStatus === 'connected') {
        for (const device of state.devices) {
          const visual = build.devices.get(device.device_id);
          // 工况覆盖优先于 WS 状态（只改画面，见 stateOf 的说明）
          if (visual) applyDeviceState(visual, overriddenState(device.device_id) ?? device.state);
        }
        // 兜底：被覆盖但不在 WS 快照里的设备（理论上不会有，出现了也不能静默漏掉）
        for (const sc of LINE_SCENARIOS) {
          for (const [id, overridden] of Object.entries(sc.stateOverrides)) {
            if (state.byId[id]) continue;
            const visual = build.devices.get(id);
            if (visual) applyDeviceState(visual, overridden);
          }
        }
      } else if (state.wsStatus === 'reconnecting' || state.wsStatus === 'disconnected') {
        applyDisconnected(build.devices.values());
        build.lights.disconnect(build.devices.values());
      }
    };
    applyStore();
    const unsubscribe = subscribeStore(applyStore);

    // ---------- 动效降级开关（提前到相机逻辑之前：入场动画要不要跑由它决定） ----------
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ---------- 入场动画：3 秒从场外绕到总览机位（规格 D3：是「绕过来」，不是瞬移） ----------
    // 起点参数写在 ENTRANCE_PATH；起点距原点必须 < maxDistance(90)，否则第一帧就被 OrbitControls 夹回。
    const entrance = { active: !reduceMotion, start: performance.now() };

    // ---------- 相机过渡（D3 重做）----------
    // 位置走二次贝塞尔、中间控制点抬高：直线插值在低位机位之间会擦过机身（规格 D3 风险①）。
    // lastTransitionMs 记录「实际」耗时而不是计划值，验收脚本读到的数字才可信。
    const tween = {
      active: false,
      start: 0,
      duration: DUR_PRESET,
      fromPos: new THREE.Vector3(),
      midPos: new THREE.Vector3(),
      toPos: new THREE.Vector3(),
      fromTarget: new THREE.Vector3(),
      toTarget: new THREE.Vector3(),
      // R1.5 A 层：FOV 随过渡一起缓动（人视机位 66/72°，俯视 60°），落到位正好是目标值
      fromFov: DEFAULT_FOV,
      toFov: DEFAULT_FOV,
    };
    let lastTransitionMs: number | null = null;
    let transitionSeq = 0;

    const moveTo = (pose: CameraPose, duration = DUR_PRESET) => {
      entrance.active = false;
      tween.active = true;
      tween.start = performance.now();
      tween.duration = duration;
      tween.fromPos.copy(camera.position);
      tween.toPos.set(...pose.position);
      tween.fromTarget.copy(controls.target);
      tween.toTarget.set(...pose.target);
      tween.fromFov = camera.fov;
      tween.toFov = pose.fov ?? DEFAULT_FOV;
      tween.midPos.lerpVectors(tween.fromPos, tween.toPos, 0.5);
      // 抬高量与两点距离成正比、封顶 10 米：够越过最高设备（2.6 m）外加安全余量
      tween.midPos.y += Math.min(10, tween.fromPos.distanceTo(tween.toPos) * 0.18);
    };

    // ---------- 巡游模式（D3）：每 6 秒换一个预设机位循环不停；任何手动操作立即退出，
    // 否则演示时会出现「镜头自己跑、鼠标拉不回来」（规格 D3 风险②） ----------
    const tour = { active: false, index: 0, nextAt: 0 };
    const syncTourBadge = () => {
      const el = tourRef.current;
      if (!el) return;
      el.style.display = tour.active ? 'block' : 'none';
      if (tour.active) {
        el.textContent = `巡游中 · 第 ${tour.index + 1}/${PRESET_ORDER.length} 站 · 按 P 或点击画面退出`;
      }
    };
    const startTour = () => {
      entrance.active = false;
      tour.index = 0;
      moveTo(CAMERA_PRESETS[PRESET_ORDER[0]]);
      tour.active = true;
      tour.nextAt = performance.now() + TOUR_INTERVAL_MS;
      syncTourBadge();
    };
    const stopTour = () => {
      if (!tour.active) return;
      tour.active = false;
      syncTourBadge();
    };
    const toggleTour = () => (tour.active ? stopTour() : startTour());

    // ---------- 指针拾取 ----------
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let lastHoverAt = 0;
    const groups = Array.from(build.devices.values()).map((v: DeviceVisual) => v.group);
    // 环境层一起进射线：墙/柱比设备更靠近相机时，可见面是墙柱，
    // 点击/hover 必须落在墙柱上（返回 null），而不是透到后面的设备。
    // 剖切掉的墙段是零面积退化三角形，raycast 天然跳过，不影响室外拾取。
    const pickTargets: THREE.Object3D[] = [...groups, build.envRoot];

    const pick = (event: PointerEvent): string | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(pickTargets, true);
      for (const hit of hits) {
        let node: THREE.Object3D | null = hit.object;
        while (node) {
          const id = node.userData?.deviceId as string | undefined;
          if (id) return id;
          node = node.parent;
        }
      }
      return null;
    };

    const onPointerMove = (event: PointerEvent) => {
      const now = performance.now();
      if (now - lastHoverAt < 80) return; // 节流 80ms
      lastHoverAt = now;
      const id = pick(event);
      if (id !== hoveredId) {
        hoveredId = id;
        refreshHighlight();
      }
      // 非设备区恢复拖拽手势（grab），设备上为 pointer。
      // 无条件写：只写在 id 变化处时，首帧悬停会一直是 auto。
      renderer.domElement.style.cursor = id ? 'pointer' : 'grab';
    };

    let downAt: { x: number; y: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      // 手动操作立即退出巡游 / 打断入场（规格 D3 风险②：不能出现镜头自己跑、拉不回来）
      stopTour();
      entrance.active = false;
      downAt = { x: event.clientX, y: event.clientY };
    };
    const onWheel = () => {
      stopTour();
      entrance.active = false;
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!downAt) return;
      const moved = Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y);
      downAt = null;
      if (moved > 4) return; // 拖动旋转视角不算点击
      const id = pick(event);
      if (!id) return;
      selectedRef.current = id;
      refreshHighlight();
      // D3（偏差 D-55）：点击只推近 + 通知外层弹设备详情，不再直接跳转监控页；
      // 相机飞行统一由 [selectedDeviceId] 副作用触发，这里不重复 moveTo。
      onSelectRef.current?.(id);
    };

    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: true });

    // ---------- 键位（D3，R1.5 扩到 7 个预设）：数字键切预设、R 复位、P 巡游。输入控件聚焦时不抢键 ----------
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const key = event.key.toLowerCase();
      if (key >= '1' && key <= String(PRESET_ORDER.length)) {
        stopTour();
        moveTo(CAMERA_PRESETS[PRESET_ORDER[Number(key) - 1]]);
      } else if (key === 'r') {
        stopTour();
        selectedRef.current = null;
        refreshHighlight();
        onSelectRef.current?.(null);
        moveTo(CAMERA_PRESETS.overview);
      } else if (key === 'p') {
        toggleTour();
      }
    };
    window.addEventListener('keydown', onKeyDown);

    // ---------- 自适应尺寸 ----------
    const resize = () => {
      const width = host.clientWidth || 1;
      const height = host.clientHeight || 1;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      postfx.setSize(width, height);
      labelRenderer.setSize(width, height);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    /** 每帧重置计数再整链渲染：一次 composer.render() 跑 4 个 pass，只有重置后累积才量得到真实总 draw call */
    const renderFrame = () => {
      renderer.info.reset();
      postfx.render();
    };

    /**
     * 只量「场景自身」的 draw call：不含后处理，可选是否含阴影 pass。
     * 三个数要分开，否则没法判断优化有没有效果：
     *   - 场景（无阴影）= 几何合批管这个，D2 的 ≤100 按它判；
     *   - 阴影 pass     = 只与投影体数量有关，和合批不是一回事；
     *   - 后处理        = 与分辨率相关，与场景内容无关。
     * 副作用是这一帧没有 bloom，下一帧 renderFrame 会覆盖，肉眼不可见。
     */
    let sceneCalls = 0;
    let shadowCalls = 0;
    const measureSceneCalls = (withShadows = false) => {
      const prev = dir.castShadow;
      dir.castShadow = withShadows;
      renderer.info.reset();
      renderer.render(scene, camera);
      const calls = renderer.info.render.calls;
      const triangles = renderer.info.render.triangles;
      dir.castShadow = prev;
      if (!withShadows) sceneCalls = calls;
      return { sceneCalls: calls, sceneTriangles: triangles, withShadows };
    };

    // ---------- 室外剖切（D 批 R1）----------
    // 相机落在车间某侧室外 → 那面墙整组退化（规则 envInterior.cutawaySides）。
    // 每帧算一次集合，集合没变不写 GPU 缓冲；入场动画/巡游/手动轨道全覆盖。
    let lastCutKey = '';
    const applyCutaway = () => {
      const ids = cutawaySides(camera.position);
      const key = ids.join('|');
      if (key === lastCutKey) return;
      lastCutKey = key;
      build.setCutaway(new Set(ids));
    };

    // ---------- 主循环 ----------
    const clock = new THREE.Clock();
    let prevT = 0;
    let raf = 0;
    let frames = 0;
    let fps = 0;
    let fpsAt = performance.now();

    /**
     * 呼吸/闪烁原本改的是「每种状态共享材质的 opacity」，现在灯与环各只有 1 个 InstancedMesh，
     * 材质是共享的，只能改成逐实例写颜色（见 builders.ts 的 StatusLights）。
     * reduceMotion 时不返回：仍要刷一次静态色，否则第一次渲染会是白球。
     */
    const animateMaterial = (t: number) => {
      build.lights.update(build.devices.values(), t, reduceMotion);
    };

    const setBadge = (fpsValue: number | null) => {
      const el = fpsRef.current;
      if (!el) return;
      const calls = renderer.info.render.calls;
      const fpsText = fpsValue === null ? '— fps' : `${fpsValue} fps`;
      // dev 环境同时显示 draw call，方便对照性能预算（第 9 节）；验收也直接从这里读
      el.textContent = import.meta.env.DEV ? `${fpsText} · ${calls} calls` : fpsText;
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const t = clock.getElapsedTime();
      frameState = readStore();
      // 两种情况让动画停住，但画面照常渲染：
      //  1) 动效降级（prefers-reduced-motion）；
      //  2) WS 断开——没有数据就不许假装还在生产（规格 6.7 第 6 条）
      const frozen = reduceMotion || frameState.wsStatus !== 'connected';
      const dt = frozen ? 0 : Math.max(0, t - prevT);
      prevT = t;

      // 入场优先：绕场球面插值（方位角/半径/高度分别缓动），终点与 overview 预设重合。
      // 球心 = ENTRANCE_START.target（overview 的 target）：总览机位平移后球心不再是原点。
      if (entrance.active) {
        const elapsed = performance.now() - entrance.start;
        const progress = Math.min(1, elapsed / DUR_ENTRANCE);
        const eased = 1 - (1 - progress) ** 3;
        const azimuth = ENTRANCE_PATH.azimuth0 + (ENTRANCE_PATH.azimuth1 - ENTRANCE_PATH.azimuth0) * eased;
        const radius = ENTRANCE_PATH.radius0 + (ENTRANCE_PATH.radius1 - ENTRANCE_PATH.radius0) * eased;
        const height = ENTRANCE_PATH.height0 + (ENTRANCE_PATH.height1 - ENTRANCE_PATH.height0) * eased;
        const [cx, , cz] = ENTRANCE_START.target;
        camera.position.set(cx + Math.sin(azimuth) * radius, height, cz + Math.cos(azimuth) * radius);
        controls.target.set(...ENTRANCE_START.target);
        if (progress >= 1) {
          entrance.active = false;
          lastTransitionMs = elapsed;
          transitionSeq += 1;
        }
      } else if (tween.active) {
        const elapsed = performance.now() - tween.start;
        const progress = Math.min(1, elapsed / tween.duration);
        const eased = 1 - (1 - progress) ** 3;
        // 二次贝塞尔 P(t) = (1-t)²·P0 + 2(1-t)t·P1 + t²·P2，P1 是抬高后的中点
        const u = 1 - eased;
        const w0 = u * u;
        const w1 = 2 * u * eased;
        const w2 = eased * eased;
        camera.position.set(
          w0 * tween.fromPos.x + w1 * tween.midPos.x + w2 * tween.toPos.x,
          w0 * tween.fromPos.y + w1 * tween.midPos.y + w2 * tween.toPos.y,
          w0 * tween.fromPos.z + w1 * tween.midPos.z + w2 * tween.toPos.z,
        );
        controls.target.lerpVectors(tween.fromTarget, tween.toTarget, eased);
        camera.fov = tween.fromFov + (tween.toFov - tween.fromFov) * eased;
        camera.updateProjectionMatrix();
        if (progress >= 1) {
          tween.active = false;
          lastTransitionMs = elapsed;
          transitionSeq += 1;
        }
      }

      // 巡游推进：到点换下一站，循环不停
      if (tour.active && performance.now() >= tour.nextAt) {
        tour.index = (tour.index + 1) % PRESET_ORDER.length;
        moveTo(CAMERA_PRESETS[PRESET_ORDER[tour.index]]);
        tour.nextAt += TOUR_INTERVAL_MS;
        syncTourBadge();
      }

      motion.update(dt, stateOf);
      animateMaterial(t);
      applyCutaway();
      controls.update();
      renderFrame();
      labelRenderer.render(scene, camera);

      frames += 1;
      const now = performance.now();
      if (now - fpsAt >= 500) {
        fps = Math.round((frames * 1000) / (now - fpsAt));
        frames = 0;
        fpsAt = now;
        setBadge(fps);
      }
    };

    // 先同步渲染一帧：无头浏览器 / 后台标签页里 rAF 可能被节流，画布与 draw call 仍要能读出来
    motion.update(0, stateOf);
    controls.update();
    renderFrame();
    labelRenderer.render(scene, camera);
    setBadge(null);

    tick();

    const getStats = (): SceneStats => {
      const total = renderer.info.render.calls;
      return {
        calls: total,
        triangles: renderer.info.render.triangles,
        fps,
        sceneCalls,
        shadowCalls,
        postPasses: Math.max(0, total - sceneCalls - shadowCalls),
      };
    };

    /**
     * 一次读齐四项：整链 / 场景（无阴影）/ 阴影 / 后处理。
     * 为什么必须原子读：分几次读会跨帧，sceneCalls 可能已被上一次测量改写，
     * 加不回总数（D1 调试时真的出现过 120+50+45=215 这种事）。
     */
    const profile = () => {
      const total = renderer.info.render.calls; // 上一帧整链（含后处理）
      const withShadow = measureSceneCalls(true).sceneCalls;
      const noShadow = measureSceneCalls(false).sceneCalls;
      shadowCalls = Math.max(0, withShadow - noShadow);
      return {
        total,
        sceneCalls: noShadow,
        shadowCalls,
        postPasses: Math.max(0, total - withShadow),
        sceneTriangles: measureSceneCalls(false).sceneTriangles,
      };
    };

    // 主循环启动前先跑一次，保证角标与验收脚本第一次读到的不是 0
    profile();

    /**
     * 按名称前缀分组统计「会被画出来的物体」。
     *
     * 为什么需要它：`profile()` 只说总数（120），说不出花在哪。D2 要合批，
     * 就必须先知道是 14 套状态灯占 14 次、还是 4 条色带逐段各占一次。
     * 分组键取 `name` 里冒号前的前缀（`device:CNC-01` → `device`），
     * 没名字的用构造类型兜底，这样新增道具忘了命名也能被看见。
     *
     * 统计口径与 draw call 不是一一对应（一个 InstancedMesh 画 N 个实例仍是 1 次），
     * 所以每个 Mesh 只算 1 次，与 three 的行为一致。
     */
    const breakdown = () => {
      const groups = new Map<string, { meshes: number; triangles: number }>();
      const visibleInTree = (obj: THREE.Object3D): boolean => {
        let node: THREE.Object3D | null = obj;
        while (node) {
          if (!node.visible) return false;
          node = node.parent;
        }
        return true;
      };

      scene.traverse((obj) => {
        const asMesh = obj as THREE.Mesh;
        const isDrawable = (asMesh as unknown as { isMesh?: boolean }).isMesh === true
          || (obj as THREE.LineSegments).isLineSegments === true;
        if (!isDrawable || !visibleInTree(obj)) return;

        const raw = obj.name || obj.type;
        const kind = raw.includes(':') ? raw.slice(0, raw.indexOf(':')) : raw;
        const geo = asMesh.geometry;
        const tris = geo?.index
          ? geo.index.count / 3
          : (geo?.attributes?.position?.count ?? 0) / 3;
        // InstancedMesh 一次画 N 个实例，仍只占 1 次 draw call
        const entry = groups.get(kind) ?? { meshes: 0, triangles: 0 };
        entry.meshes += 1;
        entry.triangles += tris;
        groups.set(kind, entry);
      });

      return [...groups.entries()]
        .map(([kind, v]) => ({ kind, meshes: v.meshes, triangles: Math.round(v.triangles) }))
        .sort((a, b) => b.meshes - a.meshes);
    };

    /** 选中一台设备：改描边，fly=true 时相机推近（3D 点击与侧栏点行最终都汇到这里） */
    const select = (deviceId: string | null, fly: boolean) => {
      selectedRef.current = deviceId;
      refreshHighlight();
      if (fly && deviceId) {
        const placement = DEVICE_LAYOUT[deviceId];
        if (placement) moveTo(focusPose(placement.x, placement.z));
      }
    };

    apiRef.current = {
      setPreset: (key) => {
        stopTour();
        // DEVICE 预设是「设备跟随」：看当前选中设备，没有选中时落回静态位姿（CNC-01 特写）
        if (key === 'DEVICE') {
          const id = selectedRef.current ?? 'CNC-01';
          const placement = DEVICE_LAYOUT[id];
          if (placement) {
            moveTo(focusPose(placement.x, placement.z));
            return;
          }
        }
        moveTo(CAMERA_PRESETS[key]);
      },
      focusDevice: (deviceId) => {
        stopTour();
        if (!deviceId) return;
        const placement = DEVICE_LAYOUT[deviceId];
        if (placement) moveTo(focusPose(placement.x, placement.z));
      },
      toggleTour: () => toggleTour(),
      select: (deviceId) => select(deviceId, deviceId !== null),
      getStats,
    };

    if (import.meta.env.DEV) {
      window.__sceneDebug = {
        renderInfo: getStats,
        camera: () => ({
          position: camera.position.toArray() as [number, number, number],
          target: controls.target.toArray() as [number, number, number],
          lastTransitionMs,
          transitionSeq,
        }),
        /** D3：预设清单与位姿（脚本两两切换、断言终点位姿用） */
        presets: () => PRESET_ORDER.map((key) => ({ key, ...CAMERA_PRESETS[key] })),
        /** D3：14 台设备包围盒（断言相机过渡路径不穿设备） */
        deviceBoxes: () => {
          const out: Record<string, { min: [number, number, number]; max: [number, number, number] }> = {};
          for (const id of Object.keys(DEVICE_LAYOUT)) {
            const box = deviceBox(id);
            if (box) out[id] = box;
          }
          return out;
        },
        /** R1.5/展示页：任意世界坐标投影到屏幕 CSS 像素（构图对称性自检用） */
        projectPoint: (x: number, y: number, z: number) => {
          const v = new THREE.Vector3(x, y, z).project(camera);
          const r = renderer.domElement.getBoundingClientRect();
          return {
            x: Math.round(((v.x + 1) / 2) * r.width + r.left),
            y: Math.round(((1 - v.y) / 2) * r.height + r.top),
            behind: v.z > 1,
          };
        },
        /** D3：设备中心投影到屏幕的 CSS 像素坐标（逐台点击测命中率用） */
        deviceAnchors: () => {
          const rect = renderer.domElement.getBoundingClientRect();
          const out: Record<string, { x: number; y: number; behind: boolean }> = {};
          const v = new THREE.Vector3();
          for (const [id, placement] of Object.entries(DEVICE_LAYOUT)) {
            const size = DEVICE_SIZES[sizeKeyOf(deviceTypeOf(id), id)];
            v.set(placement.x, size.y / 2, placement.z).project(camera);
            out[id] = {
              x: Math.round(((v.x + 1) / 2) * rect.width + rect.left),
              y: Math.round(((1 - v.y) / 2) * rect.height + rect.top),
              behind: v.z > 1,
            };
          }
          return out;
        },
        /** D3：巡游状态 */
        tour: () => ({ active: tour.active, index: tour.index, station: PRESET_ORDER[tour.index] }),
        /** 四条线的演示工况（本批）：验收据此断言"四线必须有可见差异" */
        scenario: () =>
          LINE_SCENARIOS.map((s) => ({
            lineId: s.lineId,
            condition: s.condition,
            label: s.label,
            itemCount: s.itemCount,
            itemTint: s.itemTint,
            speedFactor: s.speedFactor,
            overrides: { ...s.stateOverrides },
          })),
        /** 环境层类别与各组绘制体数量：一物一 mesh 会在这里露馅 */
        env: () => ({ kinds: build.envKinds, drawables: build.envDrawables }),
        lineMotion: () => motion.snapshot(),
        setCamera: (pose: CameraPose) => moveTo(pose, DUR_SETCAM),
        /** 后处理参数读数：D1 验收逐项比对规格 §6.1 的表 */
        postfx: () => postfx.describe(),
        /** 原子读四项开销：整链 / 场景 / 阴影 / 后处理（加不回总数就说明统计有漏） */
        profile: () => profile(),
        /** 按名称前缀分组，回答"这些 draw call 花在什么上面"（D2 合批的依据） */
        breakdown: () => breakdown(),
        /** 已建立的工业道具类别（D2 断言"≥7 类"） */
        propKinds: () => build.propKinds,
        /** 设备建模 v2 的逐台统计：部件数 / mesh 数 / 三角数 */
        deviceDetail: () => build.deviceDetails.map((d) => ({ ...d })),
        /** 场景自身 draw call，可选是否含阴影（D2 的 ≤100 按「不含阴影」判） */
        measureSceneCalls: (withShadows?: boolean) => measureSceneCalls(withShadows ?? false),
        deviceStates: () => {
          const current = readStore();
          const map: Record<string, EffectiveState | null> = {};
          for (const device of current.devices) {
            map[device.device_id] = stateOf(device.device_id);
          }
          return map;
        },
        wsDeviceStates: () => {
          const current = readStore();
          const map: Record<string, EffectiveState | null> = {};
          for (const device of current.devices) {
            map[device.device_id] = current.wsStatus === 'connected' ? device.state : null;
          }
          return map;
        },
      };
    }

    return () => {
      cancelAnimationFrame(raf);
      unsubscribe();
      observer.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('wheel', onWheel);
      controls.dispose();
      motion.dispose();
      postfx.dispose();
      build.dispose();
      scene.background = null;
      // 背景贴图不在 materials 池里，单独释放；否则反复挂载会累积显存
      backgroundTexture.dispose();
      scene.clear();
      renderer.dispose();
      renderer.domElement.remove();
      labelRenderer.domElement.remove();
      apiRef.current = null;
      if (import.meta.env.DEV) delete window.__sceneDebug;
    };
  }, []);

  return (
    <div
      className="viewport"
      style={{ height: '100%' }}
      ref={hostRef}
      data-testid="scene-root"
    >
      {showFps ? <div className="viewport__fps" ref={fpsRef}>— fps</div> : null}
      <div className="viewport__tour" ref={tourRef} style={{ display: 'none' }} />
      {/* 三维演示工况角标：四条线四种工况是展示设定，不写在这里会被当成真实状态（必须一直可见） */}
      <div className="viewport__scenario" ref={scenarioRef}>
        <span className="viewport__scenario-tag">三维演示工况</span>
        {scenarioBadgeText()}
      </div>
      <div className="viewport__hint">左键拖拽旋转 · 滚轮缩放 · 点击设备看详情 · 键位 1~7 切视角 / R 复位 / P 巡游</div>
    </div>
  );
});

export default SceneRoot;
