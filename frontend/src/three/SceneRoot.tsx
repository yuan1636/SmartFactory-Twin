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
import { CAMERA_PRESETS, ORBIT_LIMITS, focusPose, type CameraPose, type PresetKey } from './cameraPresets';
import { createLabelRenderer } from './labels';
import { DEVICE_LAYOUT } from './layout';
import { createMotion, type MotionSnapshot } from './motion';
import { createPostFx, FOG, POSTFX, type PostFx } from './postfx';

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
  getStats: () => SceneStats;
}

interface SceneRootProps {
  selectedDeviceId?: string | null;
  onSelectDevice?: (deviceId: string) => void;
  showFps?: boolean;
}

declare global {
  interface Window {
    __sceneDebug?: {
      renderInfo: () => SceneStats;
      /** 只读相机位姿：验收脚本用它确认预设切换有缓动、且镜头不会钻到地面以下 */
      camera: () => { position: [number, number, number]; target: [number, number, number] };
      /** 产线运行动画快照：验收脚本用它确认物料在动、堵料时停在设备前、降级时冻结 */
      lineMotion: () => MotionSnapshot;
      /** 实时设备状态表（WS 未连上时全为 null）：验收脚本据此推导哪条产线该被挡住 */
      deviceStates: () => Record<string, EffectiveState | null>;
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
    };
  }
}

const TWEEN_MS = 600;

const SceneRoot = forwardRef<SceneHandle, SceneRootProps>(function SceneRoot(
  { selectedDeviceId = null, onSelectDevice, showFps = true },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fpsRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<{
    setPreset: (key: PresetKey) => void;
    focusDevice: (deviceId: string) => void;
    getStats: () => SceneStats;
  } | null>(null);
  const selectedRef = useRef<string | null>(selectedDeviceId);
  const onSelectRef = useRef(onSelectDevice);
  onSelectRef.current = onSelectDevice;

  useImperativeHandle(ref, () => ({
    setPreset: (key) => apiRef.current?.setPreset(key),
    focusDevice: (id) => apiRef.current?.focusDevice(id),
    getStats: () => apiRef.current?.getStats() ?? { calls: 0, triangles: 0, fps: 0, sceneCalls: 0, shadowCalls: 0, postPasses: 0 },
  }));

  // 选中态变化只需要改描边，不必重建场景
  useEffect(() => {
    selectedRef.current = selectedDeviceId;
    apiRef.current?.focusDevice(selectedDeviceId ?? '');
  }, [selectedDeviceId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(FOG.color);
    // 雾色必须等于背景色，否则远景会出现一条色带（规格 §6.2）
    scene.fog = new THREE.Fog(FOG.color, FOG.near, FOG.far);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 400);
    const preset = CAMERA_PRESETS.overview;
    camera.position.set(...preset.position);

    // antialias 关掉：接入 EffectComposer 后，默认帧缓冲的 MSAA 作用不到中间 target，
    // 抗锯齿交给 postfx 里的 SMAAPass（D1 / 规格 §6.1）
    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
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
    const stateOf = (deviceId: string): EffectiveState | null => {
      if (frameState.wsStatus !== 'connected') return null;
      return frameState.byId[deviceId]?.state ?? null;
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
      }
    };
    refreshHighlight();

    /** 状态写入 visual + 已断开转灰；灯/环的实际颜色由主循环里的 lights.update 统一刷 */
    const applyStore = () => {
      const state = readStore();
      if (state.wsStatus === 'connected') {
        for (const device of state.devices) {
          const visual = build.devices.get(device.device_id);
          if (visual) applyDeviceState(visual, device.state);
        }
      } else if (state.wsStatus === 'reconnecting' || state.wsStatus === 'disconnected') {
        applyDisconnected(build.devices.values());
        build.lights.disconnect(build.devices.values());
      }
    };
    applyStore();
    const unsubscribe = subscribeStore(applyStore);

    // ---------- 相机缓动（不做瞬移，瞬移会让人分不清方向） ----------
    const tween = { active: false, start: 0, fromPos: new THREE.Vector3(), toPos: new THREE.Vector3(), fromTarget: new THREE.Vector3(), toTarget: new THREE.Vector3() };

    const moveTo = (pose: CameraPose) => {
      tween.active = true;
      tween.start = performance.now();
      tween.fromPos.copy(camera.position);
      tween.toPos.set(...pose.position);
      tween.fromTarget.copy(controls.target);
      tween.toTarget.set(...pose.target);
    };

    // ---------- 指针拾取 ----------
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let lastHoverAt = 0;
    const groups = Array.from(build.devices.values()).map((v: DeviceVisual) => v.group);

    const pick = (event: PointerEvent): string | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(groups, true);
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
        renderer.domElement.style.cursor = id ? 'pointer' : 'grab';
      }
    };

    let downAt: { x: number; y: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      downAt = { x: event.clientX, y: event.clientY };
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
      moveTo(focusPose(DEVICE_LAYOUT[id]?.x ?? 0, DEVICE_LAYOUT[id]?.z ?? 0));
      onSelectRef.current?.(id);
    };

    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);

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

    // ---------- 主循环 ----------
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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

      if (tween.active) {
        const progress = Math.min(1, (performance.now() - tween.start) / TWEEN_MS);
        const eased = 1 - (1 - progress) ** 3;
        camera.position.lerpVectors(tween.fromPos, tween.toPos, eased);
        controls.target.lerpVectors(tween.fromTarget, tween.toTarget, eased);
        if (progress >= 1) tween.active = false;
      }

      motion.update(dt, stateOf);
      animateMaterial(t);
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

    apiRef.current = {
      setPreset: (key) => moveTo(CAMERA_PRESETS[key]),
      focusDevice: (deviceId) => {
        if (!deviceId) return;
        const placement = DEVICE_LAYOUT[deviceId];
        if (placement) moveTo(focusPose(placement.x, placement.z));
      },
      getStats,
    };

    if (import.meta.env.DEV) {
      window.__sceneDebug = {
        renderInfo: getStats,
        camera: () => ({
          position: camera.position.toArray() as [number, number, number],
          target: controls.target.toArray() as [number, number, number],
        }),
        lineMotion: () => motion.snapshot(),
        setCamera: (pose: CameraPose) => moveTo(pose),
        /** 后处理参数读数：D1 验收逐项比对规格 §6.1 的表 */
        postfx: () => postfx.describe(),
        /** 原子读四项开销：整链 / 场景 / 阴影 / 后处理（加不回总数就说明统计有漏） */
        profile: () => profile(),
        /** 按名称前缀分组，回答"这些 draw call 花在什么上面"（D2 合批的依据） */
        breakdown: () => breakdown(),
        /** 场景自身 draw call，可选是否含阴影（D2 的 ≤100 按「不含阴影」判） */
        measureSceneCalls: (withShadows?: boolean) => measureSceneCalls(withShadows ?? false),
        deviceStates: () => {
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
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      controls.dispose();
      motion.dispose();
      postfx.dispose();
      build.dispose();
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
      <div className="viewport__hint">左键拖拽旋转 · 滚轮缩放 · 点击设备查看详情</div>
    </div>
  );
});

export default SceneRoot;
