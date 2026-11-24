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
import { applyDeviceState, applyDisconnected, buildFactory, setDeviceSelected, type DeviceVisual } from './builders';
import { CAMERA_PRESETS, ORBIT_LIMITS, focusPose, type CameraPose, type PresetKey } from './cameraPresets';
import { createLabelRenderer } from './labels';
import { DEVICE_LAYOUT } from './layout';

export interface SceneStats {
  calls: number;
  triangles: number;
  fps: number;
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
    __sceneDebug?: { renderInfo: () => SceneStats };
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
    getStats: () => apiRef.current?.getStats() ?? { calls: 0, triangles: 0, fps: 0 },
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
    scene.background = new THREE.Color(0x0b1018);

    const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 400);
    const preset = CAMERA_PRESETS.overview;
    camera.position.set(...preset.position);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
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

    const hemi = new THREE.HemisphereLight(0xffffff, 0x223044, 0.9);
    scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xffffff, 1.1);
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

    const build = buildFactory();
    scene.add(build.root);

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

    /** 状态材质引用切换 + 已断开转灰 */
    const applyStore = () => {
      const state = readStore();
      if (state.wsStatus === 'connected') {
        for (const device of state.devices) {
          const visual = build.devices.get(device.device_id);
          if (visual) applyDeviceState(visual, device.state, build.materials);
        }
      } else if (state.wsStatus === 'reconnecting' || state.wsStatus === 'disconnected') {
        applyDisconnected(build.devices.values(), build.materials);
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
      labelRenderer.setSize(width, height);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    // ---------- 主循环 ----------
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const clock = new THREE.Clock();
    let raf = 0;
    let frames = 0;
    let fps = 0;
    let fpsAt = performance.now();

    const animateMaterial = (t: number) => {
      if (reduceMotion) return;
      // 呼吸 0.5Hz（2 秒周期）；告警闪烁 1Hz（光敏安全上限，禁止更快）
      const breath = 0.75 + 0.25 * (0.5 + 0.5 * Math.sin((t / 2) * Math.PI * 2));
      const blink = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2));
      const slow = 0.5 + 0.5 * (0.5 + 0.5 * Math.sin(t * Math.PI));
      build.materials.states.RUNNING.lamp.opacity = breath;
      build.materials.states.ALARM.lamp.opacity = blink;
      build.materials.states.ALARM.ring.opacity = 0.25 * blink;
      build.materials.states.MAINTENANCE.lamp.opacity = slow;
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

      if (tween.active) {
        const progress = Math.min(1, (performance.now() - tween.start) / TWEEN_MS);
        const eased = 1 - (1 - progress) ** 3;
        camera.position.lerpVectors(tween.fromPos, tween.toPos, eased);
        controls.target.lerpVectors(tween.fromTarget, tween.toTarget, eased);
        if (progress >= 1) tween.active = false;
      }

      animateMaterial(t);
      controls.update();
      renderer.render(scene, camera);
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
    controls.update();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
    setBadge(null);

    tick();

    const getStats = (): SceneStats => ({
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      fps,
    });

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
      window.__sceneDebug = { renderInfo: getStats };
    }

    return () => {
      cancelAnimationFrame(raf);
      unsubscribe();
      observer.disconnect();
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      controls.dispose();
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
