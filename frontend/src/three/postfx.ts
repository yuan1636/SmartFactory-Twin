/**
 * 后处理管线（D1 视觉基调）：RenderPass → Bloom → OutputPass → SMAA。
 *
 * 三条硬约束，每条都有踩过的坑：
 *  1. **必须用 OutputPass 收尾色调映射与色彩空间**。加了 EffectComposer 后，
 *     `renderer.outputColorSpace` 不再自动作用到最终画面；少了这步整屏会发灰，
 *     看起来像"做了个负面优化"。
 *  2. **SMAA 放在 OutputPass 之后**。SMAA 是针对 LDR（已色调映射、已 sRGB）图像做边缘检测的；
 *     放在 OutputPass 之前，它看到的是线性 HDR 值，边缘阈值全部失准。
 *  3. **draw call 统计必须把 pass 算进去**。UnrealBloomPass 是多级降采样，一次 bloom 就有 10 次左右
 *     全屏绘制；只统计场景绘制会得出"加了后处理没花什么"的错误结论（D1 验收按总 draw call 计）。
 *
 * 依赖：three@0.170.0 自带的 examples/jsm，**不新增 package.json 依赖**；
 * SMAAPass 的查找贴图是模块内置的 base64，不需要额外资源文件。
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';

/** 参数集中在规格 §6.1 的表里，改这里必须同步改文档，否则下次验收对不上 */
export const POSTFX = {
  exposure: 1.05,
  bloomStrength: 0.35,
  bloomRadius: 0.6,
  /**
   * 作者 2026-11-25 要求「不要迷雾、背景换白色」后，阈值从 0.85 抬到 3.2。
   * 原因：白底被 `SKY_INTENSITY` 推到线性 3.0，阈值低于它整屏就会蒙一层白光——
   * 那层白光正是"雾感"的来源。阈值 3.2 > 3.0，白底不再泛光。
   * 副作用：场景内最亮的发光体（灯带等）线性值都在 1 以下，本版起 bloom 实质不触发；
   * 通道保留是为了不动既有验收链（pass 数量与顺序），不是忘了关。
   * 不变量写在 `sky.test.ts`：bloomThreshold > SKY_INTENSITY。
   */
  bloomThreshold: 0.85, // 暗青背景线性 <0.05，回归常规阈值；白底时代的 3.2 作废（sky.ts）
} as const;

/**
 * 雾：作者 2026-11-25 明确要求「不要迷雾」，本版**已移除**（`scene.fog = null`）。
 * 历史（留痕，别再按旧文档找）：v1 是 Fog(0x0b1018, 28, 120)；
 * v2 收到 near 26 / far 110 并把雾色调成背景渐变中段；v3 连雾一起去掉，改白底。
 * 保留这个空说明是为了让后来人知道"这里曾经有雾、为什么没了"，而不是以为漏了。
 */

export interface PostFx {
  render: () => void;
  setSize: (width: number, height: number) => void;
  dispose: () => void;
  /** 供验收脚本读取：pass 链名字与参数，避免脚本去猜内部结构 */
  describe: () => {
    passes: string[];
    exposure: number;
    toneMapping: number;
    bloom: { strength: number; radius: number; threshold: number };
    fog: { near: number; far: number; color: string } | null;
  };
}

export function createPostFx(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  width: number,
  height: number,
): PostFx {
  // HalfFloat 才能让 Bloom 的阈值作用在线性 HDR 值上；用 UnsignedByte 会让高光在进入 bloom 前就被截断
  const target = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    samples: 0, // 走 SMAA，不走 MSAA；两者同时开等于为抗锯齿付两次成本
  });

  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // 与 renderer.setPixelRatio 一致
  composer.setSize(width, height);

  const renderPass = new RenderPass(scene, camera);
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(width, height),
    POSTFX.bloomStrength,
    POSTFX.bloomRadius,
    POSTFX.bloomThreshold,
  );
  const output = new OutputPass();
  const smaa = new SMAAPass(width, height);

  composer.addPass(renderPass);
  composer.addPass(bloom);
  composer.addPass(output);
  composer.addPass(smaa);

  // 用实例身份映射稳定标签：`constructor.name` 会被 Vite 预打包改写成 `_UnrealBloomPass`，
  // 拿它做断言会导致"明明接对了却 FAIL"（D1 实际踩到过）
  const LABELS = new Map<object, string>([
    [renderPass, 'RenderPass'],
    [bloom, 'UnrealBloomPass'],
    [output, 'OutputPass'],
    [smaa, 'SMAAPass'],
  ]);

  return {
    render: () => composer.render(),
    setSize: (w, h) => {
      composer.setSize(w, h);
      bloom.setSize(w, h);
      smaa.setSize(w, h);
    },
    dispose: () => {
      composer.dispose();
      bloom.dispose();
      smaa.dispose();
      target.dispose();
    },
  describe: () => {
    return {
      passes: composer.passes.map((pass) => LABELS.get(pass) ?? pass.constructor.name),
      exposure: renderer.toneMappingExposure,
      toneMapping: renderer.toneMapping,
      bloom: {
        strength: bloom.strength,
        radius: bloom.radius,
        threshold: bloom.threshold,
      },
      fog: scene.fog instanceof THREE.Fog
        ? { near: scene.fog.near, far: scene.fog.far, color: `#${scene.fog.color.getHexString()}` }
        : null,
    };
  },
  };
}
