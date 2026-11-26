/**
 * 场景环境反射（批 1「光影与材质」，D-75）。
 *
 * 问题：现在全场景只有物体颜色，没有"可反射的环境"。金属的视觉定义就是
 * 反射周围——没有环境贴图时，three 的金属只能反射黑色（或一盏灯的镜面高光），
 * 所以 roughness 0.5 / metalness 0.6 的机床看上去和塑料没有区别。
 *
 * 做法：程序化搭一个"车间外壳"当环境源，用 PMREM 烘成预过滤的辐照度贴图：
 *  - 深青灰的四面墙 + 地面（对应场景背景色系，反射不会跳色）；
 *  - 顶部四条冷白灯带（与 LINE_STRIPS 的位置一致，金属上会出现长条高光）；
 *  - 两侧窗带（冷蓝，给侧向补一点天光反射）。
 * 这样金属反射的是"这个车间"，而不是通用影棚，也不用引入任何 HDR 资源文件。
 *
 * 为什么不用 three 自带的 RoomEnvironment：它是纯白影棚，反射出来是灰白，
 * 放在深青场景里会让机床发白、与背景脱节。自建环境源只多 30 行，且可调。
 *
 * 成本：PMREM 只烘一次（约 5~10 ms），运行时只是多一次环境贴图采样，
 * **不增加任何 draw call**。
 */

import * as THREE from 'three';

export interface SceneEnvironment {
  texture: THREE.Texture;
  dispose: () => void;
}

/** 环境源的尺寸：只要比例对，具体大小不影响反射（PMREM 会归一化） */
const ENV_BOX = { x: 120, y: 34, z: 80 };

/**
 * 搭环境源场景。注意这里**不能用受光材质**：PMREM 渲染时没有灯，
 * 用 MeshStandardMaterial 会得到全黑。一律 MeshBasicMaterial，颜色即亮度。
 */
function buildEnvScene(): THREE.Scene {
  const scene = new THREE.Scene();

  // 房间内壁（BackSide，颜色即"墙的亮度"）
  const shell = new THREE.Mesh(
    new THREE.BoxGeometry(ENV_BOX.x, ENV_BOX.y, ENV_BOX.z),
    new THREE.MeshBasicMaterial({ color: 0x22343f, side: THREE.BackSide }),
  );
  shell.position.y = ENV_BOX.y / 2;
  scene.add(shell);

  // 地面：比墙亮一档，模拟混凝土对天光的反弹
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ENV_BOX.x, ENV_BOX.z),
    new THREE.MeshBasicMaterial({ color: 0x3d464d }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.1;
  scene.add(floor);

  // 顶部灯带：pipeline 里产线是沿 X 走的四条，这里也沿 X 铺，反射落在机床上是水平长条。
  // 颜色**故意超过 1.0**（HDR）：PMREM 会把它烘进辐照度贴图，金属上才会出现真正亮的
  // 高光条。若用 sRGB 白色（≤1），金属反射出来的仍是暗环境——这是第一版"接了 IBL 却
  // 看不出变化"的直接原因（实测画面平均亮度 72.3 → 71.0，等于没变）。
  const lampGeo = new THREE.BoxGeometry(ENV_BOX.x * 0.92, 0.5, 1.6);
  const lampMat = new THREE.MeshBasicMaterial();
  lampMat.color.setRGB(7.5, 8.0, 9.0); // 线性 HDR：冷白高光
  for (const z of [-18, -6, 6, 18]) {
    const lamp = new THREE.Mesh(lampGeo, lampMat);
    lamp.position.set(0, ENV_BOX.y - 3, z);
    scene.add(lamp);
  }

  // 两侧窗带：冷蓝天光，给金属侧面一点方向性反射（同样给 HDR 值，但低于灯带）
  const winGeo = new THREE.PlaneGeometry(ENV_BOX.x * 0.8, 5);
  const winMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  winMat.color.setRGB(1.7, 2.3, 3.2);
  for (const z of [-ENV_BOX.z / 2 + 0.6, ENV_BOX.z / 2 - 0.6]) {
    const win = new THREE.Mesh(winGeo, winMat);
    win.position.set(0, 10, z);
    scene.add(win);
  }

  return scene;
}

/**
 * 生成并挂到 scene.environment。
 *
 * `intensity` 不是"环境亮度"而是"环境参与程度"：1.0 会让所有 Standard 材质的
 * 漫反射明显变亮（相当于多一盏大面光），0.6 左右才是"补反射不动整体曝光"。
 */
export function applySceneEnvironment(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  intensity: number,
): SceneEnvironment {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader(); // 提前编译，避免首帧卡顿

  const envScene = buildEnvScene();
  const target = pmrem.fromScene(envScene, 0.04);

  scene.environment = target.texture;
  scene.environmentIntensity = intensity;

  // 环境源只是为了烘焙，烘完立刻释放几何与材质
  envScene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[];
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat.dispose();
  });
  pmrem.dispose();

  return {
    texture: target.texture,
    dispose: () => {
      if (scene.environment === target.texture) scene.environment = null;
      target.dispose();
    },
  };
}
