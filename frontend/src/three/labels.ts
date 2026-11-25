/** CSS2D 标签（G-08）：用 HTML 覆盖层渲染中文，不用 Sprite 贴图。 */

import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

/** 标签 DOM 上带 data-device-label，验收脚本靠它数设备数量（10.1.5）。 */
export function makeDeviceLabel(deviceId: string): CSS2DObject {
  const el = document.createElement('div');
  el.className = 'device-label';
  el.dataset.deviceLabel = deviceId;
  el.textContent = deviceId;
  const obj = new CSS2DObject(el);
  obj.center.set(0.5, 1);
  return obj;
}

export function makeLineLabel(text: string): CSS2DObject {
  const el = document.createElement('div');
  el.className = 'device-label';
  el.dataset.lineLabel = text;
  el.textContent = text;
  el.style.opacity = '0.75';
  const obj = new CSS2DObject(el);
  obj.center.set(0.5, 1);
  return obj;
}

/**
 * 场景级说明标签（本批：B1 的「维修中」）。
 * 为什么用 HTML 而不是贴图：canvas 画中文依赖系统字体，跨机器会糊/变豆腐块；
 * CSS2D 是 DOM，字体由页面统一提供，稳定且不占 draw call。
 */
export function makeScenarioLabel(text: string): CSS2DObject {
  const el = document.createElement('div');
  el.className = 'device-label scenario-label';
  el.dataset.scenarioLabel = text;
  el.textContent = text;
  const obj = new CSS2DObject(el);
  obj.center.set(0.5, 1);
  return obj;
}

export function setLabelActive(label: CSS2DObject, active: boolean): void {
  label.element.classList.toggle('is-active', active);
}

export function createLabelRenderer(): CSS2DRenderer {
  const renderer = new CSS2DRenderer();
  renderer.domElement.style.position = 'absolute';
  renderer.domElement.style.top = '0';
  renderer.domElement.style.left = '0';
  renderer.domElement.style.pointerEvents = 'none';
  return renderer;
}
