---
title: 第 3 阶段实现规格（React 前端 + Three.js 三维场景 + ECharts）
version: v1.1（v1.0 基础上增补 §6.7 产线运行动画）
date: 2026-11-24
status: 生效 —— v1.0 于 2026-11-24 作者确认 C-1～C-3 后冻结；同日作者追加要求「三维里的产线必须能动起来」，故增补 §6.7（偏差 D-09、D-10）
读者: 代码 agent / 本项目开发者
上游文档: docs/方案.md（实验方案 V1.0）、docs/spec_phase2.md（第 2 阶段规格 v1.1）
---

# 第 3 阶段实现规格

## 0. 本文件怎么用

- 本文件是第 3 阶段的唯一施工依据。代码 agent 只按本文件写代码，不再向作者二次提问。
- 后端接口**已冻结、已验收**，前端不得要求后端改字段。所有字段名以本文第 7 节引用的真实响应为准（本文档中的 JSON 均取自 2026-11-24 实机响应）。
- 编号规则沿用第 2 阶段：`G-xx` = 必须现在定的缺口，`L-xx` = 可以以后再定的缺口。
- 本文件不设计第 4 阶段（Kafka / AI 模型训练）。凡涉及模型推理的位置一律标注「预留，本阶段不实现」，且**禁止出现任何编造的预测值或准确率**。
- 三维场景采用**程序化几何体**（作者已确认），不引入任何外部 GLB/GLTF 资产，`factory_models/` 保持占位。

---

## 1. 缺口清单

方案文档只写了「要 React + Three.js + ECharts」，没有一条能直接落成代码。以下 18 项必须先定。

### 1.1 必须现在定（G 组，按影响从大到小）

| 编号 | 缺什么 | 建议默认值 | 为什么 | 不确定的后果 |
|---|---|---|---|---|
| G-01 | 14 台设备在车间里的三维坐标 | 见第 3.3 节坐标表（固定硬编码在 `src/three/layout.ts`） | 3D 全靠它摆位，且要和产线流向一致（加工→机器人→输送/检测） | 每个模型 transform 都要改，改一次要动 14 处并重新目测，等于白做一轮 |
| G-02 | 场景单位与坐标轴约定 | 1 世界单位 = 1 米；Y 轴向上；X 正方向为东（车间从左到右）；Z 正方向为南；原点在厂区中心地面 | 所有尺寸、相机距离、移动速度都以此换算，定歪了相机永远调不顺手 | 尺寸体系失控：相机高度、灯光强度、网格间距全部要重调 |
| G-03 | `status` 与 `running_status` 两个字段怎么合并成一个视觉状态 | 优先级 `ALARM > MAINTENANCE > STOPPED > IDLE > RUNNING`（`status` 只有 RUNNING/ALARM/MAINTENANCE，`running_status` 有 RUNNING/IDLE/STOPPED） | 后端把设备级与遥测级状态分开了，前端必须有一套固定规则，否则同一台设备两个组件显示不同颜色 | 总览页显示绿、列表页显示灰，答辩时一眼被抓 |
| G-04 | 状态怎么在三维里表达 | 三处表达：①设备顶部状态灯（球，直径 0.3m）②地面光环（半径 1.2m 圆环）③选中/告警时描边；**机身保持金属灰不整体染色** | 14 台设备全染色会整厂红绿闪烁，且看不出设备本体 | 全场颜色噪声，看不出哪台异常；后期只能推翻重做材质体系 |
| G-05 | 车间与产线在场景里怎么表现 | 车间用半透明墙体（`opacity 0.12`）+ 地面色带；产线用 0.15m 高、1.2m 宽的地面色带 + 文字标签 | 不能挡住设备，又要能看出层级归属 | 无法回答「这台设备属于哪条线」，三维就退化成摆件 |
| G-06 | 六类设备的几何体尺寸 | 见第 3.4 节尺寸表 | 尺寸决定产线间距与相机距离，也是「这个数字怎么来的」的答辩依据 | 设备互相穿模、产线间距不够，只能整体缩放 |
| G-07 | 相机预设与轨道限制 | 4 个预设（总览 / WS-A / WS-B / 单设备聚焦），`minDistance 6`、`maxDistance 90`、`maxPolarAngle π/2.15`（不穿地）、`enableDamping` | 老师演示时不能靠手拖找角度，必须有「一键回到总览」 | 演示时镜头钻到地面以下或飞出场外，现场翻车 |
| G-08 | 中文标签用什么渲染 | CSS2DRenderer（HTML 覆盖层），不用 Sprite 贴图 | Sprite 中文要么模糊要么要预生成纹理；HTML 层文字清晰、可点、可用系统字体 | 标签糊成一片，且改文案要重新生成纹理 |
| G-09 | 依赖版本 | 见第 2.1 节（React 18.3 / TS 5.6 / Vite 6 / three 0.170 / echarts 5.5，全部写死不带 `^`） | 个人项目最怕「昨天还能跑今天装不上」，写死版本 + 提交 lock 文件 | 换机器重装依赖后 API 变更，编译报一堆错 |
| G-10 | 页面路由与信息架构 | 5 个可用页面 + 1 个禁用占位，见第 5.1 节 | 方案说「五个页面」但没给路由，也没给告警页 | 组件无处安放，告警功能被塞进生产分析页 |
| G-11 | 数据刷新策略 | WS 1 秒驱动实时状态；REST 按资源分档轮询（见第 7.3 节） | 全部走 WS 不现实（订单/统计不在快照里），全部走轮询又浪费 | 页面每秒发 6 个请求，或数据显示 10 分钟前的数 |
| G-12 | WS 断线怎么处理 | 指数退避 1/2/4/8/16 秒，5 次失败后固定 30 秒重试；重连成功先拉 `/devices/latest` 兜底再恢复推送 | 模拟器一停 WS 就断，演示中必现 | 页面卡在「最后一条数据」，观众以为系统挂了 |
| G-13 | 时间怎么显示 | 后端全 UTC ISO 字符串，前端用 `Intl.DateTimeFormat` 转本地时区，**禁止字符串截取** | 现在库里存 UTC，直接截取会差 8 小时 | 所有时间显示偏移 8 小时，且很难发现是哪一层错的 |
| G-14 | 视觉主题 | 深色工业风为默认，色值见第 4 节 | 监控大屏惯例，三维场景在深色下对比度最好 | 浅色下三维发灰、状态灯看不清；后期换主题要改所有组件 |
| G-15 | 图表封装方式 | 统一 `ChartCard` 组件内部持有 ECharts 实例，页面禁止直接 `echarts.init` | 5 个页面至少 7 张图，不封装会重复写 resize/dispose/主题 | 内存泄漏、窗口缩放后图表不重绘 |
| G-16 | 错误与空态 | 统一 `ErrorState` / `EmptyState` / Toast，错误码映射见第 8.3 节 | 后端有 8 个错误码，前端不给文案就只会弹 `[object Object]` | 参数错时页面白屏，看不出是接口问题还是前端问题 |
| G-17 | 性能预算 | 首屏（本机 dev）< 2.5s；14 台设备场景 ≥ 50 fps；每秒 WS 更新**不得新建材质对象** | 每秒重建 `MeshStandardMaterial` 会 GC 抖动 | 秒级掉帧，风扇狂转，演示机发烫 |
| G-18 | 验收方式 | 可自动化的用命令验（build/test/HTTP），三维与交互用固定人工检查表（第 10.2 节，12 项） | 三维效果没法断言，硬写成「通过」等于自欺 | 交付时说不清「凭什么算完成」 |

### 1.2 可以以后再定（L 组）

| 编号 | 项 | 占位默认 | 触发条件 |
|---|---|---|---|
| L-01 | 浅色主题 | 不做，CSS 变量已按主题分组预留 | 需要投影到亮环境或打印时 |
| L-02 | 移动端适配 | 只保证 ≥ 1280px 宽，不做响应式 | 需要手机查看 |
| L-03 | 国际化 | 仅中文 | 无 |
| L-04 | E2E 测试（Playwright） | 只做 Vitest 组件/纯函数测试 | 第 5 阶段集成测试时 |
| L-05 | 真实三维资产（GLB） | `factory_models/` 保持占位 | 观感要求提高时 |
| L-06 | 告警声音/浏览器通知 | 不做，只做视觉 | 需要值守场景 |
| L-07 | 历史回放时间轴 | 不做 | 需要「回看某天」 |
| L-08 | 导出 PDF / Excel 报告 | 不做 | 需要交周报 |
| L-09 | 地图/平面图 2D 视图 | 不做 | 三维性能不足时的降级方案 |
| L-10 | PWA / 离线缓存 | 不做 | 无 |

---

## 2. 工程与目录

### 2.1 依赖（写死版本，禁止 `^`）

```json
{
  "dependencies": {
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "react-router-dom": "6.28.0",
    "three": "0.170.0",
    "echarts": "5.5.1"
  },
  "devDependencies": {
    "typescript": "5.6.3",
    "vite": "6.0.5",
    "@vitejs/plugin-react": "4.3.4",
    "vitest": "2.1.8",
    "@testing-library/react": "16.1.0",
    "@testing-library/jest-dom": "6.6.3",
    "jsdom": "25.0.1",
    "@types/react": "18.3.17",
    "@types/react-dom": "18.3.5",
    "@types/three": "0.170.0"
  }
}
```

- 包管理器用 **npm**（本机 npm 10.9.7，registry 已指向 `registry.npmmirror.com`）。
- 必须提交 `package-lock.json`。
- 不引入 UI 组件库（Ant Design / MUI）。理由：本期只需 10 个组件，自己写可完全控样式，且少一层版本风险。
- 不引入状态管理库（Redux / zustand）。用自建模块级 store + `useSyncExternalStore`（第 7.4 节）。

### 2.2 目录结构

```text
frontend/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts            # 含 vitest 配置与 /api 代理
├── .env.development          # VITE_API_BASE / VITE_WS_URL
├── .env.production
└── src/
    ├── main.tsx
    ├── App.tsx               # 路由表
    ├── styles/
    │   ├── tokens.css        # 颜色/字号/间距 CSS 变量
    │   └── global.css
    ├── components/           # 通用组件（第 6 节）
    │   ├── Layout.tsx
    │   ├── SideNav.tsx
    │   ├── TopBar.tsx
    │   ├── StatusBadge.tsx
    │   ├── MetricCard.tsx
    │   ├── ChartCard.tsx
    │   ├── RangePicker.tsx
    │   ├── DataTable.tsx
    │   ├── EmptyState.tsx
    │   ├── ErrorState.tsx
    │   ├── LoadingBlock.tsx
    │   └── Toast.tsx
    ├── pages/
    │   ├── Overview.tsx      # 1 工厂数字孪生总览
    │   ├── DeviceMonitor.tsx # 2 设备监控中心
    │   ├── Production.tsx    # 3 生产数据分析
    │   ├── Alerts.tsx        # 4 设备告警与维护
    │   └── AiInsight.tsx     # 5 AI 预测分析（真值展示，无模型）
    ├── three/
    │   ├── SceneRoot.tsx     # React 挂载点 + 生命周期
    │   ├── layout.ts         # G-01 坐标表 + G-06 尺寸表（唯一数据源）
    │   ├── materials.ts      # 状态材质池（G-17：预创建，不每秒 new）
    │   ├── builders.ts       # 六类设备几何构建 + 厂房/产线/地面
    │   ├── cameraPresets.ts
    │   └── labels.ts         # CSS2DRenderer 封装
    ├── charts/
    │   ├── init.ts           # ECharts 主题与公共 option
    │   └── options.ts        # 四指标曲线 / 柱状 / 折线 option 工厂
    ├── services/
    │   ├── api.ts
    │   ├── ws.ts
    │   ├── store.ts
    │   └── format.ts         # 时间/数值/单位格式化（G-13）
    ├── hooks/
    │   ├── useTelemetry.ts
    │   ├── usePolling.ts
    │   └── useDeviceTelemetry.ts
    └── utils/
        ├── status.ts         # G-03 状态合并 + 颜色映射
        └── errors.ts         # G-16 错误码文案
```

### 2.3 环境变量

`.env.development`：

```ini
VITE_API_BASE=/api/v1
VITE_WS_URL=ws://127.0.0.1:8000/api/v1/ws/telemetry
```

**REST 走同源 `/api` 代理，不写绝对地址**（2026-11-24 修正，记为偏差 D-04）：后端没有挂 CORS 中间件，浏览器从 `127.0.0.1:5173` 直连 `127.0.0.1:8000` 会被拦成「无法连接后端」。规格 2.2 本来就要求 `vite.config.ts` 配 `/api` 代理，这里按代理执行。

**WS 必须用 `127.0.0.1` 而不是 `localhost`**：本机 Windows 上 `localhost` 先解析到 IPv6 `::1`，而 uvicorn 只监听 IPv4，每个请求会白等约 2 秒（第 2 阶段已实测：2030ms → 4ms）。WebSocket 不受浏览器同源策略限制，所以直连 8000 即可。

`.env.production` 同值；生产化部署（第 5 阶段）由反向代理把 `/api` 转发到后端。

### 2.4 npm scripts

```json
{
  "scripts": {
    "dev": "vite --port 5173",
    "build": "tsc -b && vite build",
    "preview": "vite preview --port 4173",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

---

## 3. 坐标系与工厂布局（G-01 / G-02 / G-05 / G-06）

### 3.1 坐标系约定

| 项 | 约定 |
|---|---|
| 单位 | 1 世界单位 = 1 米 |
| 向上轴 | Y（地面 y=0，建筑物从 y=0 向上） |
| X 正方向 | 东（画面从左到右） |
| Z 正方向 | 南（画面从远到近） |
| 原点 | 厂区中心地面 `(0, 0, 0)` |
| 旋转 | 所有设备的 `rotationY = 0`（长轴沿 X）；本阶段不做朝向变化，避免 14 处 transform 各写一遍出错 |

### 3.2 厂区与车间

| 对象 | 中心 (x, z) | 尺寸 X × Z | 高度 | 说明 |
|---|---|---|---|---|
| 厂区地面 | (0, 0) | 80 × 56 | — | 深色地面 + 2m 网格（80 格） |
| 车间 WS-A（机加工车间） | (-20, 0) | 34 × 30 | 8 | 墙体半透明 `opacity 0.12`，无顶棚（否则看不到内部） |
| 车间 WS-B（检测与装配车间） | (20, 0) | 34 × 30 | 8 | 同上 |
| 中央通道 | (0, 0) | 6 × 30 | — | 两车间之间 6m 宽，用略亮的地面色带表示 |
| 动力站（AUX 设备所在） | (0, 22) | 16 × 10 | 5 | 辅助设备不属任何车间（DB 里 `workshop_id` 为 `NULL`），统一放这里 |

### 3.3 产线与设备坐标（G-01，唯一数据源）

四条产线沿 X 方向布置，同一车间两条产线在 Z 上分居南北（±7.5）。

| 产线 | 车间 | 走向（X 范围） | 中心 Z | 设备（按物料流方向排列） |
|---|---|---|---|---|
| LINE-A1 | WS-A | -34 → -6 | -7.5 | CNC-01 → ROB-01 → CONV-01 |
| LINE-A2 | WS-A | -34 → -6 | +7.5 | CNC-02 → ROB-02 → CONV-02 |
| LINE-B1 | WS-B | +6 → +34 | -7.5 | CNC-03 → ROB-03 → INSP-01 |
| LINE-B2 | WS-B | +6 → +34 | +7.5 | CNC-04 → ROB-04 → INSP-02 |

14 台设备坐标（直接抄进 `src/three/layout.ts`）：

```ts
// src/three/layout.ts —— G-01：设备在世界坐标中的位置（单位：米）
// 约定：x 向东为正，z 向南为正，y = 0 为地面；rotationY 统一为 0
export const DEVICE_LAYOUT: Record<string, { x: number; z: number; rotationY: number }> = {
  // WS-A / LINE-A1（z = -7.5）
  'CNC-01':  { x: -31.0, z: -7.5, rotationY: 0 },
  'ROB-01':  { x: -25.5, z: -7.5, rotationY: 0 },
  'CONV-01': { x: -16.0, z: -7.5, rotationY: 0 },
  // WS-A / LINE-A2（z = +7.5）
  'CNC-02':  { x: -31.0, z:  7.5, rotationY: 0 },
  'ROB-02':  { x: -25.5, z:  7.5, rotationY: 0 },
  'CONV-02': { x: -16.0, z:  7.5, rotationY: 0 },
  // WS-B / LINE-B1（z = -7.5）
  'CNC-03':  { x:   9.0, z: -7.5, rotationY: 0 },
  'ROB-03':  { x:  14.5, z: -7.5, rotationY: 0 },
  'INSP-01': { x:  21.0, z: -7.5, rotationY: 0 },
  // WS-B / LINE-B2（z = +7.5）
  'CNC-04':  { x:   9.0, z:  7.5, rotationY: 0 },
  'ROB-04':  { x:  14.5, z:  7.5, rotationY: 0 },
  'INSP-02': { x:  21.0, z:  7.5, rotationY: 0 },
  // 动力站（z = 22，不属任何车间）
  'AIR-01':  { x:  -4.0, z: 22.0, rotationY: 0 },
  'PUMP-01': { x:   4.0, z: 22.0, rotationY: 0 },
};

// 产线地面色带（G-05）：从 x1 到 x2，宽 1.2m，高 0.15m
export const LINE_STRIPS = [
  { line_id: 'LINE-A1', x1: -34, x2: -6, z:  -7.5 },
  { line_id: 'LINE-A2', x1: -34, x2: -6, z:   7.5 },
  { line_id: 'LINE-B1', x1:   6, x2: 34, z:  -7.5 },
  { line_id: 'LINE-B2', x1:   6, x2: 34, z:   7.5 },
];
```

> 一致性要求：`layout.ts` 的 key 必须与后端 `devices.device_id` 完全一致（14 个，大小写一致）。缺一个就在控制台打 `console.warn('[layout] 缺少设备 ' + id)`，并把该设备堆在动力站旁，**不允许静默跳过**。

### 3.4 设备几何体尺寸（G-06）

机身基色统一为金属灰，**不随状态染色**（G-04：状态由状态灯 + 光环表达）。

| device_type | 几何构成 | 尺寸 X × Y × Z（米） | 基色 |
|---|---|---|---|
| `CNC` | 底座盒 + 主轴柱 + 前门薄盒 | 4.0 × 2.6 × 2.6 | `#5A6673` |
| `ROBOT` | 圆柱底座（r 0.6, h 0.35）+ 两段臂（1.6 / 1.4）+ 夹爪盒 | 总高 2.4 | `#8A7A6A` |
| `CONVEYOR` | 长盒 + 8 个滚筒圆柱（r 0.18） | 10.0 × 0.9 × 1.2 | `#3F4A57` |
| `INSPECTION` | 台面盒 + 龙门架（两根立柱 + 横梁）+ 相机盒 | 3.0 × 1.8 × 2.0 | `#4E6B7A` |
| `AUX` / `AIR-*` | 长方盒 + 顶部风扇圆盘（r 0.5） | 2.4 × 2.0 × 1.6 | `#59636E` |
| `AUX` / `PUMP-*` | 卧式圆柱（沿 X 轴，r 0.7）+ 底座盒 | 1.6 × 1.4 × 1.4 | `#59636E` |

- 所有 mesh 的 `castShadow = true`，地面 `receiveShadow = true`。
- 单台设备的 mesh 数量控制在 3～5 个；全场上限 ~~90~~ **≤100 个 draw call**（2026-11-25 按 `docs/spec_phase4.md` v4.0 §2.4 统一，原 90 与本文 §10 的 150 互相矛盾，一并作废；实测现状 108）。
- 每台设备外层包一个 `THREE.Group`，命名 `device:<device_id>`，并挂 `userData.deviceId`，用于射线拾取（第 6.4 节）。

### 3.5 相机预设（G-07）

```ts
export const CAMERA_PRESETS = {
  overview: { position: [0, 40, 48], target: [0, 0, 0] },
  'WS-A':   { position: [-20, 26, 34], target: [-20, 0, 0] },
  'WS-B':   { position: [20, 26, 34],  target: [20, 0, 0] },
};
// 单设备聚焦：position = [device.x + 6, 5, device.z + 8]，target = [device.x, 1.2, device.z]
```

OrbitControls：`minDistance = 6`、`maxDistance = 90`、`maxPolarAngle = Math.PI / 2.15`（防止穿到地面下）、`enableDamping = true`、`dampingFactor = 0.08`。

切换预设用 600ms 缓动（`lerp`），不做瞬移——瞬移会让人分不清方向。

### 3.6 光照与地面

| 项 | 值 |
|---|---|
| 半球光 | `HemisphereLight(0xffffff, 0x223044, 0.9)` |
| 平行光 | `DirectionalLight(0xffffff, 1.1)`，位置 `(30, 50, 20)`，`castShadow`，shadow map 2048×2048 |
| 地面 | `PlaneGeometry(80, 56)`，`MeshStandardMaterial({ color: 0x0F1722, roughness: 0.95 })` |
| 网格 | `GridHelper(80, 40, 0x1E2A3A, 0x141C28)`，抬高 0.01 防 z-fighting |

---

## 4. 状态语义与视觉规范（G-03 / G-04 / G-14）

### 4.1 状态合并规则（G-03）

后端给了两个字段，前端必须先合并成唯一的 `EffectiveState`：

```ts
// src/utils/status.ts
type EffectiveState = 'ALARM' | 'MAINTENANCE' | 'STOPPED' | 'IDLE' | 'RUNNING';

// 优先级从高到低；status 取设备级，running_status 取遥测级
export function effectiveState(status: string, runningStatus: string): EffectiveState {
  if (status === 'ALARM') return 'ALARM';
  if (status === 'MAINTENANCE') return 'MAINTENANCE';
  if (runningStatus === 'STOPPED') return 'STOPPED';
  if (runningStatus === 'IDLE') return 'IDLE';
  return 'RUNNING';
}
```

规则说明：`ALARM` 与 `MAINTENANCE` 是**设备级**事实（有未解除告警 / 人工置维护），优先于遥测级；遥测级里 `STOPPED` 比 `IDLE` 更"死"，优先展示。

### 4.2 颜色（G-04 / G-14）

> **颜色语义声明**：本项目是工业监控，红 = 故障/告警、绿 = 正常，与国际工业惯例一致，**与股市红涨绿跌无关**。评审时若有人质疑"为什么正常是绿的"，以此条为准。

| 语义 | 变量 | 色值 | 用途 |
|---|---|---|---|
| 背景（场景） | `--bg-scene` | `#0B1018` | 三维画布、页面底 |
| 背景（面板） | `--bg-panel` | `#131C28` | 卡片、侧边栏 |
| 背景（次级） | `--bg-panel-alt` | `#182333` | 表头、hover |
| 边框 | `--border` | `#243449` | 卡片描边、分割线 |
| 主文字 | `--text-primary` | `#E8EEF6` | 正文 |
| 次文字 | `--text-secondary` | `#94A6BD` | 标签、单位 |
| 弱文字 | `--text-muted` | `#64748B` | 时间戳、占位 |
| 品牌/主按钮 | `--accent` | `#2E9BE6` | 主按钮、选中态、链接 |
| 状态 RUNNING | `--st-running` | `#22C55E` | 运行中 |
| 状态 IDLE | `--st-idle` | `#F2B233` | 待机 |
| 状态 STOPPED | `--st-stopped` | `#64748B` | 停机 |
| 状态 ALARM | `--st-alarm` | `#EF4444` | 告警 |
| 状态 MAINTENANCE | `--st-maint` | `#3B82F6` | 维护中 |
| 指标 温度 | `--m-temp` | `#F97316` | 曲线 |
| 指标 振动 | `--m-vib` | `#A855F7` | 曲线 |
| 指标 电流 | `--m-current` | `#3B82F6` | 曲线 |
| 指标 转速 | `--m-speed` | `#14B8A6` | 曲线 |
| 阈值 WARNING | `--th-warn` | `#F2B233` | 参考线（虚线 `[6,4]`） |
| 阈值 CRITICAL | `--th-crit` | `#EF4444` | 参考线（虚线 `[6,4]`） |

### 4.3 动效（G-04）

| 状态 | 状态灯 | 地面光环 | 动效 |
|---|---|---|---|
| RUNNING | 绿常亮 + 呼吸（opacity 0.75↔1.0，周期 2s） | 绿，opacity 0.18 | 呼吸 |
| IDLE | 琥珀常亮 | 琥珀，opacity 0.12 | 无 |
| STOPPED | 灰常亮 | 无 | 无 |
| ALARM | 红，闪烁 1 Hz（0.35↔1.0） | 红，opacity 0.25，同步闪烁 | 闪烁 |
| MAINTENANCE | 蓝，慢闪 0.5 Hz | 蓝，opacity 0.15 | 慢闪 |
| 选中（任意状态） | 加白色描边 `#FFFFFF`，edge 强度 0.6 | — | 无 |

- 闪烁频率**上限 1 Hz**（光敏安全），禁止更快。
- 遵循 `prefers-reduced-motion: reduce`：把所有周期动效降为常亮（只保留颜色差异）。
- 状态灯与光环用**预创建的共享材质**（5 态 × 2 处 = 10 个 `MeshBasicMaterial`），切换时只换引用，不新建（G-17）。

### 4.4 排版与间距

| 项 | 值 |
|---|---|
| 中文栈 | `"PingFang SC", "Microsoft YaHei", "Source Han Sans SC", system-ui, sans-serif` |
| 数字 | `font-variant-numeric: tabular-nums`（表格与指标对齐） |
| 字号 | 12（辅助）/ 13（表格）/ 14（正文）/ 16（小标题）/ 20（卡片标题）/ 28（KPI 数值） |
| 间距 | 4 / 8 / 12 / 16 / 24 / 32（8pt 栅格） |
| 圆角 | 卡片 8px，按钮 6px，标签 4px |
| 布局 | 左侧导航固定 200px，顶部条 56px，内容区 `padding: 24px` |

---

## 5. 页面与信息架构（G-10）

### 5.1 路由表

| # | 路由 | 页面 | 对应方案 | 本阶段 |
|---|---|---|---|---|
| 1 | `/overview` | 工厂数字孪生总览 | 页面一 | 做（Batch 1） |
| 2 | `/devices`、`/devices/:deviceId` | 设备监控中心 | 页面二 | 做（Batch 1） |
| 3 | `/production` | 生产数据分析 | 页面三 | 做（Batch 2） |
| 4 | `/alerts` | 设备告警与维护 | 模块五（方案未单列页面） | 做（Batch 2） |
| 5 | `/ai` | AI 预测分析 | 页面四 | 做（Batch 2，仅真值展示） |
| 6 | `/assistant` | AI 工业助手 | 页面五（方案标注「进阶」） | **不做**，导航灰显 + tooltip「预留，本阶段不实现」 |

- 默认路由 `/` 重定向到 `/overview`。
- 未知路径渲染 `NotFound`（显示"页面不存在" + 返回总览按钮），不做静默重定向。
- **页面 4 是本次新增**：方案把告警归在「模块五」，但没给页面，而模块五（告警记录、维护记录）必须有落点。已在第 12 节记为 D-01 偏差。

### 5.2 页面一：工厂数字孪生总览 `/overview`

| 区块 | 内容 | 数据来源 |
|---|---|---|
| A. 三维视口（占内容区 70% 高） | 厂房/产线/14 台设备；右上角视口切换（总览 / WS-A / WS-B）+ 重置视角按钮 | 静态布局 `layout.ts` + WS snapshot |
| B. 顶部 KPI（4 张卡） | 运行中 / 告警设备 / 异常中设备 / 未解除告警数 | WS `summary`（`running` / `alarm` / `open_alarm_count`）+ 前端统计 `in_anomaly` |
| C. 右侧设备列表（280px 宽） | 14 行：状态点 + device_id + 设备名 + 温度；点击定位镜头并高亮 | WS snapshot |
| D. 层级筛选 | 车间下拉（全部 / WS-A / WS-B / 动力站） | `GET /workshops` |

- 三维视口下方固定一行图例：五态色块 + 含义。
- 设备标签（CSS2D）显示 `device_id`，字号 11px，选中时变白加粗。

### 5.3 页面二：设备监控中心 `/devices/:deviceId?`

| 区块 | 内容 | 数据来源 |
|---|---|---|
| 左栏（240px） | 设备列表，支持按车间/类型筛选、按 device_id 搜索 | `GET /devices?page=1&page_size=50`，10 秒轮询 |
| 右上 设备卡 | 设备名、型号、类型、所属车间/产线、当前状态徽章、未解除告警数、正常区间（四指标） | `GET /devices/{id}`（进入页面拉一次）+ WS 覆盖实时值 |
| 右下 四张曲线卡 | 温度 / 振动 / 电流 / 转速，各自独立 ChartCard；叠加 WARNING/CRITICAL 参考线；x 轴时间 | `GET /devices/{id}/telemetry?start&end&limit=2000` |
| 时间范围 | 1h / 6h / 24h 三档（默认 1h） | 切换时重新请求 |
| 降采样提示 | 当 `downsample_step > 1` 或 `truncated === true` 时显示黄色提示条：「当前为抽样展示：每 N 个点取 1 个，共 M 点」 | 响应字段 |

进入 `/devices`（无 deviceId）时默认选中列表第一个设备，并把地址改为 `/devices/CNC-01`（可分享链接）。

### 5.4 页面三：生产数据分析 `/production`

| 区块 | 内容 | 数据来源 |
|---|---|---|
| KPI（4 卡） | 已完成订单 / 计划产量 / 实际产量 / 合格率 / 设备利用率（5 项取 4 张主卡 + 1 张副卡） | `GET /stats/production?start&end` |
| 图表 1 柱状 | 四条产线产量对比（计划 vs 实际） | 逐产线调 `GET /stats/production?start&end&line_id=LINE-A1` 等 4 次，前端合并 |
| 图表 2 折线 | 最近 20 单的合格率与完成率走势 | `GET /orders?page_size=20` |
| 表格 | 订单列表：订单号 / 产线 / 计划数 / 实际数 / 合格率 / 完成率 / 状态 | `GET /orders?page=1&page_size=20` |
| 口径说明 | 底部灰字：「统计窗口 {start} ~ {end}，合格率 = 合格数 / 实际数」 | 后端返回的 `start` / `end` |

- **必须显式传时间窗，不能吃后端默认值**：后端 `/stats/production` 不带参数时窗口是「最近 1 小时」，而模拟器按 30 件/小时推进、订单跨数小时才完成，实测该窗口返回全 0（`orders_completed=0`、`qualified_rate=0.0`），页面会变成四张 0 卡片。同一时刻改用 24 小时窗口实测为：`orders_completed=20`、`planned=2880`、`actual=2412`、`qualified_rate=0.9652`、`utilization=0.8679`。故页面默认传 `start = now - 24h`、`end = now`，并提供 1h / 24h 切换；空数据时显示 `EmptyState`「当前窗口内没有已完工订单」，而不是显示 0% 合格率。
- 4 个产线请求必须并行（`Promise.all`），串行会让 30 秒轮询变成 4 次接续等待。

### 5.5 页面四：设备告警与维护 `/alerts`

| 区块 | 内容 | 数据来源 |
|---|---|---|
| 告警 KPI | 未解除总数、CRITICAL 数、WARNING 数 | `GET /alarms?resolved=false` 的 `total` + 前端按等级统计 |
| 筛选条 | 设备（下拉，14 台）/ 等级（全部 / CRITICAL / WARNING）/ 状态（未解除 / 已解除 / 全部） | — |
| 告警表 | 时间 / 设备 / 类型 / 等级 / 文案 / 状态 / 操作（解除） | `GET /alarms?page&page_size&device_id&alarm_level&resolved` |
| 解除动作 | `PATCH /alarms/{id}/resolve`；成功后 Toast 展示返回的 `device_status` 与 `open_alarm_count`，并刷新列表 | — |
| 维护记录表 | 设备 / 类型 / 描述 / 开始 / 结束 / 成本 | `GET /maintenance?page&page_size` |
| 新增维护表单 | device_id（下拉）、maintenance_type（ROUTINE/REPAIR/INSPECTION）、description、started_at、ended_at（可空）、cost | `POST /maintenance` |

- **解除按钮必须展示 G-10 语义**：若返回 `device_status` 仍为 `ALARM`，Toast 写「已解除 1 条，该设备仍有 N 条未解除告警，状态保持 ALARM」。这正是第 2 阶段 G-10 规则的前端可见性。
- 未填 `ended_at` 的新增维护会让设备转 `MAINTENANCE`，表单需给出提示文案：「未填结束时间将把设备置为维护中」。

### 5.6 页面五：AI 预测分析 `/ai`（本阶段无模型）

| 区块 | 内容 | 数据来源 |
|---|---|---|
| 声明条（醒目） | 「本阶段不含任何模型推理。以下数据来自模拟器写入的异常真值与阈值告警规则，不是模型预测结果。」 | 静态 |
| 图表 真值时间轴 | 三类异常（TEMP_DRIFT / VIB_SPIKE / CURRENT_ABNORMAL）按时间区间画甘特条，按设备分行 | `GET /anomalies?page=1&page_size=100` |
| 图表 真值 vs 告警 | 按类型统计真值条数 vs 对应类型告警条数（分组柱状），用于说明"阈值规则会漏、会误" | `/anomalies` + `/alarms` 前端聚合 |
| 表格 | 真值列表：设备 / 类型 / 开始 / 结束 / 参数（JSON 展开为键值） | `GET /anomalies` |
| 预留区 | 灰色虚线框，文案「异常检测模型输出 —— 预留，本阶段不实现」 | — |

**硬性禁止**：本页不得出现任何形如「准确率 92%」「预计故障概率」的数字。没有模型就没有这些数字。

---

## 6. 组件规格

### 6.1 通用组件契约

| 组件 | props | 行为 |
|---|---|---|
| `StatusBadge` | `state: EffectiveState`, `size?: 'sm'\|'md'` | 圆点 + 中文名（运行中/待机/停机/告警/维护中），颜色取 4.2 表 |
| `MetricCard` | `label`, `value`, `unit?`, `delta?`, `tone?: 'normal'\|'warn'\|'crit'` | 数值用 28px tabular-nums；`tone` 只影响数值颜色 |
| `ChartCard` | `title`, `option`, `height?`, `loading?`, `empty?`, `footnote?` | 内部 `echarts.init`，`ResizeObserver` 自适应，卸载时 `dispose`；`option` 变化走 `setOption(option, false)` 增量更新 |
| `DataTable` | `columns`, `rows`, `rowKey`, `empty?`, `loading?` | 无虚拟滚动（行数 ≤ 100）；空态显示 `EmptyState` |
| `RangePicker` | `value: '1h'\|'6h'\|'24h'`, `onChange` | 分段按钮 |
| `EmptyState` | `title`, `hint?`, `action?` | 居中文案 + 可选按钮 |
| `ErrorState` | `error: ApiError`, `onRetry` | 显示错误码中文文案 + 「重试」按钮 |
| `LoadingBlock` | `rows?` | 骨架条，不用转圈（转圈看不出进度） |
| `Toast` | 命令式 `toast.success/error/info(msg)` | 右下角，3 秒自动消失，最多同时 3 条 |
| `ConnectionIndicator` | 读 store 的 `wsStatus` | 顶部条右侧：已连接（绿点）/ 重连中（黄点 + 第 n 次）/ 已断开（红点） |

### 6.2 三维场景组件

| 组件 | 职责 | 注意 |
|---|---|---|
| `SceneRoot` | 创建 `WebGLRenderer` / `Scene` / `Camera` / `OrbitControls`，`ResizeObserver` 自适应，卸载时 `renderer.dispose()` + 销毁材质与几何 | React 严格模式会挂载两次，必须在 cleanup 里彻底释放，否则出现两个画布 |
| `builders.ts` | `buildFactory()` 返回 `{ scene, deviceGroups: Map<string, Group> }` | 纯函数，不依赖 React |
| `materials.ts` | `STATE_MATERIALS`（10 个共享材质）、`BODY_MATERIALS`（6 类机身） | 关键性能点：状态切换只换 `mesh.material` 引用 |
| `labels.ts` | `CSS2DRenderer` 单例 + `makeLabel(text)` | 标签 DOM 挂 `data-device-label` 属性，供验收脚本计数 |

### 6.3 射线拾取与交互

- 在 `renderer.domElement` 上监听 `pointermove`（节流 80ms）与 `click`。
- `Raycaster` 命中 `deviceGroups` 的任意子 mesh，取 `userData.deviceId`。
- hover：把该设备的描边材质置为白色，标签加粗；移出还原。
- click：`navigate('/devices/' + id)`，同时在 store 里记 `focusedDeviceId`，返回总览时保持选中。
- 禁止在 hover 里改 `scale`（会破环阴影与拾取盒）。

### 6.7 产线运行动画（v1.1 增补）

作者在 v1.0 交付后提出「工程流水线要能动起来」：输送带在转、物料从上一道工序流到下一道、
设备挡住时料会堆在它前面。这不是物理仿真，是**视觉动画 + 状态映射**，所以不违反第 12 节第 15 条
（该条禁止的是物理引擎、碰撞检测、真实运动学）。

**几何（程序化，不引入任何外部资产）**

| 对象 | 形状 | 位置 | 数量 | draw call |
|---|---|---|---|---|
| 料箱 | `BoxGeometry(0.9, 0.5, 0.9)` | 色带面 y=0.15 上（中心 0.40） | 每条线 `floor(28/3)=9` 个 | 每线 1 个 InstancedMesh |
| 带面纹路 | `BoxGeometry(0.09, 0.05, 1.0)` | y=0.175 | 每条线 `floor(28/1.4)+1=21` 个 | 每线 1 个 InstancedMesh |
| 滚筒定位条 | `BoxGeometry(0.07, 0.07, 1.14)` | 绕滚筒轴心 r=0.13 公转 | 每台输送机 8 个 | 每台 1 个 |

物料与纹路藏在设备机身内部时由不透明机身自然遮挡，不做额外裁剪。新增 10 个 draw call。

**六条规则（每条都可被脚本断言，禁止"看起来在动"）**

| # | 规则 | 判定依据 |
|---|---|---|
| 1 | 带面纹路恒速滚动 = 皮带在转 | 纹路坐标随时间前移，越界回头 |
| 2 | 物料沿流向匀速前进，遇关闭的闸门停在设备入口前 `0.8m`，后面的按 `3.0m` 料距排队 | 队首坐标 == 闸门坐标 |
| 3 | 闸门关闭判据：设备状态 ∉ {RUNNING, IDLE}（即 ALARM / STOPPED / MAINTENANCE / 无数据） | 与 `deviceStates()` 逐台核对 |
| 4 | 输送机滚筒只在本机 RUNNING/IDLE 时自转，ω = 带速 / 0.18 | 角度增量 > 0 |
| 5 | 机器人只在本机 RUNNING/IDLE 时摆动（±0.42 rad，周期约 11s），停机冻结在当前姿态 | 角度增量 == 0 |
| 6 | WS 断开或 `prefers-reduced-motion` 时整线冻结（dt 归零），但画面照常渲染 | 两次采样完全一致 |

**闸门坐标** = 设备入口（上游侧）+ 0.8m，即 `x - 机身宽/2 - 0.8`。四条产线各 3 个闸门，共 12 个；
`AIR-01` / `PUMP-01` 属动力站，不在任何产线上（`layout.ts` 的 `LINE_DEVICES` 是唯一数据源）。

**边界行为（写清楚是为了不被当成 bug）**

- 物料走到色带尽头就"下线"，回到起点上游一个料距的等待位；带上有空位才重新进线，
  堵料时多台料在带外按料距排开（带外不可见，不会飘在车间地面上）。
- 首台设备就是上料口：它停下时上料停止，产线会逐渐跑空——这是正确表现，不是动画丢了。
- 物料尺寸 0.9m、料距 3.0m：任意两台料不会重叠（有单测守着）。

**纯计算与渲染分离**：一维队列算法放在 `lineTraffic.ts`（不 import three，可单测），
`motion.ts` 只负责把结果写进 InstancedMesh 矩阵。11 个单测覆盖排队、回炉、不穿透、不倒退、不重叠。

**调试面（仅 dev）**：`window.__sceneDebug.lineMotion()` 返回每条线的 `running / blockedBy / items /
visibleItems / cleat / gates`；`window.__sceneDebug.deviceStates()` 返回实时状态表。
验收脚本用这两个钩子推导期望值，不写死"哪条线该堵"。

---

## 7. 数据接入层

### 7.1 API 客户端 `src/services/api.ts`

```ts
export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}

export async function apiGet<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T>
```

- base = `import.meta.env.VITE_API_BASE`。
- 超时 8 秒（`AbortController`），超时抛 `ApiError('TIMEOUT', '请求超时', 0)`。
- **时间参数必须走 `URLSearchParams` / `encodeURIComponent`**（强制）。后端要的是 ISO 8601，形如 `2026-11-23T11:41:35+00:00`，那个 `+` 若不编码，服务端会解析成空格并直接返回 `422 VALIDATION_ERROR`（2026-11-24 实测踩到）。`new URLSearchParams({start, end})` 会把 `+` 编成 `%2B`，用它拼参数即可，**禁止手写字符串拼接 URL**。
- 后端错误体有两种形态，都要解析：
  - 业务错误：`{ "code": "...", "message": "..." }`；
  - 参数校验错误：`{ "code": "VALIDATION_ERROR", "message": "请求参数校验失败", "detail": [{ "field": "query.start", "message": "...", "type": "..." }] }`。此时前端文案取 `detail[0].field + '：' + detail[0].message`，便于定位是哪个参数写错。
- 不做自动重试（除 WS 外）。重试交给页面显式「重试」按钮，避免雪崩。

### 7.2 WebSocket 客户端 `src/services/ws.ts`

```ts
type Snapshot = {
  type: 'snapshot'; server_time: string; seq: number; device_count: number;
  summary: { running: number; idle: number; stopped: number; alarm: number; maintenance: number; open_alarm_count: number };
  devices: Array<{
    device_id: string; device_name: string; device_type: string;
    workshop_id: string | null; line_id: string | null;
    status: 'RUNNING' | 'ALARM' | 'MAINTENANCE';
    open_alarm_count: number; ts: string;
    metrics: { temperature: number; vibration: number; current: number; speed: number };
    running_status: 'RUNNING' | 'IDLE' | 'STOPPED';
    in_anomaly: boolean;
  }>;
};
```

（以上为 2026-11-24 实机快照的真实结构，单条约 4.5 KB。）

重连策略（G-12）：`onclose`/`onerror` → 退避 `[1,2,4,8,16]` 秒，第 5 次失败后固定 30 秒；每次重连成功先 `GET /devices/latest` 覆盖一次状态，再接推送。组件卸载时 `close()` 并清定时器，禁止"幽灵重连"。

### 7.3 轮询策略（G-11）

| 资源 | 频率 | 说明 |
|---|---|---|
| WS snapshot | 1 秒（服务端推） | 驱动设备状态、KPI、三维场景 |
| `/devices` | 10 秒 | 左栏列表（含 `open_alarm_count`） |
| `/alarms` | 10 秒 | 告警页与顶部告警计数；WS 快照里只有计数没有明细 |
| `/orders` | 30 秒 | 订单表与合格率折线 |
| `/stats/production` | 30 秒 | 生产 KPI（逐产线 4 次并行请求，显式传 24h 窗口，见 5.4） |
| `/maintenance` | 60 秒 | 维护记录 |
| `/anomalies` | 60 秒 | 真值（模拟器每 20 分钟才产生一条，1 分钟足够） |
| `/devices/{id}/telemetry` | 切范围时拉一次 + 60 秒 | 曲线不需要秒级 |

- 页面不可见（`document.hidden`）时全部暂停轮询，可见时立即补一次。
- 同一资源同一时刻只允许一个在途请求（用 `inFlight` 标记丢弃重复）。

### 7.4 状态存储 `src/services/store.ts`

不引入状态库，用模块级 store + `useSyncExternalStore`：

```ts
// 对外暴露
export const telemetryStore = {
  subscribe(cb: () => void): () => void,
  getSnapshot(): StoreSnapshot,        // 整体快照（引用稳定，变化才换新对象）
  getDevice(id: string): DeviceView | undefined,  // 单设备选择器，避免全量重渲染
  setSnapshot(s: Snapshot): void,
  setWsStatus(s: 'connected' | 'reconnecting' | 'disconnected', attempt?: number): void,
};
```

要求：`setSnapshot` 在值未变时**不触发订阅**（浅比较 `seq` 即可），否则每秒 14 个组件重渲染。三维场景不走 React 渲染，直接订阅 store 后调 `updateDeviceState()`。

### 7.5 格式化 `src/services/format.ts`（G-13）

| 函数 | 规则 | 示例 |
|---|---|---|
| `formatTime(iso)` | `Intl.DateTimeFormat('zh-CN', { hour12: false })` 转本地 | `2026-11-24T04:58:10Z` → `2026-11-24 12:58:10` |
| `formatTimeShort(iso)` | 只到分 | `11-24 12:58` |
| `formatNumber(v, digits)` | 千分位 + 固定小数 | `604828` → `604,828` |
| `formatPercent(v)` | 后端给 0~1 的小数，乘 100 保留 1 位 | `0.6667` → `66.7%` |
| `formatMetric(key, v)` | 带单位：`℃` / `mm/s` / `A` / `rpm` | `96.0` → `96.0 ℃` |

**禁止**对 ISO 字符串做 `slice(11, 19)` —— 后端存 UTC，截取会得到 8 小时前的时间。

---

## 8. 异常态与文案（G-16）

### 8.1 四种页面态

| 态 | 触发 | 表现 |
|---|---|---|
| Loading | 首次请求未返回 | 骨架屏，不阻塞侧边导航 |
| Empty | 200 且 `items.length === 0` | `EmptyState`：「暂无告警记录」/「暂无维护记录」，不报错 |
| Error | 请求失败 | `ErrorState`：错误文案 + 重试按钮；**不允许整页白屏** |
| Degraded | WS 断开但 REST 可用 | 顶部黄条「实时连接已断开，正在重连（第 n 次）」；三维场景状态灯转灰，数值停更并模糊处理 |

### 8.2 WS 断开时的三维场景

- 所有状态灯转 `#64748B`，光环隐藏，禁止继续按最后一条 snapshot 闪烁（会让人误以为设备还在告警）。
- 恢复后立即按新快照重建状态，不做过渡动画。

### 8.3 错误码文案映射

| code | HTTP | 前端文案 |
|---|---|---|
| `INVALID_PARAM` | 400 | 请求参数不合法：{message} |
| `VALIDATION_ERROR` | 422 | 参数格式错误：{detail[0].field} {detail[0].message}（多为时间参数未编码） |
| `DEVICE_NOT_FOUND` | 404 | 设备不存在，请检查设备编号 |
| `ALARM_NOT_FOUND` | 404 | 告警不存在或已被处理 |
| `ORDER_NOT_FOUND` | 404 | 订单不存在 |
| `DUPLICATE_TELEMETRY` | 409 | 该时刻数据已存在（前端一般不触发） |
| `DUPLICATE_ORDER` | 409 | 订单编号重复 |
| `DEVICE_HAS_OPEN_ALARM` | 409 | 该设备仍有未解除告警，无法置为运行中 |
| `RANGE_TOO_LARGE` | 400 | 查询时间跨度超过 24 小时，请缩小范围 |
| `TIMEOUT`（前端自造） | — | 请求超时，请检查后端是否启动 |
| 其他 | — | 请求失败（{status}），请稍后重试 |

---

## 9. 性能预算（G-17）

| 指标 | 目标 | 验证方式 |
|---|---|---|
| 首屏可交互（dev，本机） | < 2.5s | 浏览器 Performance 面板，`DOMContentLoaded` 到首帧三维渲染 |
| 三维帧率（14 台设备，默认视角） | ≥ 50 fps | 页面右上角 FPS 角标（dev 环境显示） |
| WS 每秒更新耗时 | < 8ms | `performance.now()` 包裹 `updateDeviceState()` |
| 全场 draw call | **≤ 100** | `renderer.info.render.calls` 打印到控制台（dev）。2026-11-25 按 `docs/spec_phase4.md` v4.0 §2.4 统一：本条原为 ≤150，与 §3.4 的 90 矛盾，两处一并作废；D0 实测现状 108 |
| 图表切换范围重绘 | < 300ms | 人工观察 |
| 打包体积（gzip） | < 1.2 MB | `vite build` 输出 |

硬性约束：每秒快照更新**不得**创建新的 `Material` / `Geometry` / `Vector3`（复用临时对象），否则 GC 抖动必然掉帧。

---

## 10. 验收清单（G-18）

### 10.1 可自动化部分（命令 + 预期输出）

**10.1.1 构建**

```powershell
cd D:\wbproject\2026-11-24-10-02-56\frontend
npm run build
```

预期：`✓ built in ...`，**0 个 error**，`dist/` 生成；`tsc -b` 阶段无类型错误。

**10.1.2 单元测试**

```powershell
npm run test
```

预期：`Test Files  N passed`、`Tests  ≥ 8 passed`，0 failed。

**10.1.3 开发服务可访问**

```powershell
npm run dev
# 另开一个窗口
(Invoke-WebRequest http://127.0.0.1:5173/overview -UseBasicParsing).StatusCode
```

预期：`200`。

**10.1.4 五个路由都能返回 SPA 页面**

```powershell
foreach ($p in "/overview","/devices","/production","/alerts","/ai") { "$p -> " + (Invoke-WebRequest "http://127.0.0.1:5173$p" -UseBasicParsing).StatusCode }
```

预期：5 行全部 `200`。

**10.1.5 三维设备数量（浏览器控制台执行）**

```js
document.querySelectorAll('[data-device-label]').length
```

预期：`14`。少于 14 说明 `layout.ts` 与后端设备清单不一致。

**10.1.6 draw call（控制台执行）**

```js
window.__sceneDebug?.renderInfo().calls
```

预期：`≤ 150`（dev 环境把 `renderer.info.render.calls` 暴露到 `window.__sceneDebug`）。

**10.1.7 后端未启动时的错误态**

停掉 uvicorn，刷新页面。

预期：页面显示 `ErrorState`（「无法连接后端，请检查服务是否启动」）+ 重试按钮，**不是白屏、不是无限加载**。

**10.1.8 WS 重连**

1. 页面打开 `/overview`，确认 `ConnectionIndicator` 为绿；
2. 停掉 uvicorn；
3. 预期 1 秒内变黄并显示「重连中（第 1 次）」，三维状态灯转灰；
4. 重新启动 uvicorn；
5. 预期 30 秒内自动恢复绿，设备状态灯按真实状态恢复。

### 10.2 人工检查表（12 项，逐条打勾）

三维与交互无法自动断言，按此表验收并在 `docs/acceptance_phase3.md` 里逐条贴截图或描述。

| # | 检查项 | 通过标准 |
|---|---|---|
| 1 | 厂区完整可见 | 默认视角能看到 2 个车间、4 条产线色带、14 台设备、动力站 |
| 2 | 层级可辨 | 能一眼看出 CNC/机器人/输送（检测）/辅助 四类设备形态不同 |
| 3 | 标签清晰 | 14 个中文/编号标签不重叠、不发糊，缩放后仍可读 |
| 4 | 状态对比 | 五态颜色肉眼可分；告警设备一眼能找到 |
| 5 | 动效 | RUNNING 呼吸、ALARM 1Hz 闪烁、MAINTENANCE 慢闪；无频闪刺眼 |
| 6 | 交互 | hover 有描边、click 跳到设备监控页且带 device_id |
| 7 | 镜头 | 三个预设切换有缓动；镜头钻不到地面以下 |
| 8 | 曲线 | 四指标曲线与阈值线正确；切 1h/6h/24h 数据变化合理 |
| 9 | 降采样 | 24h 范围出现黄色抽样提示条（`downsample_step > 1`） |
| 10 | 告警解除 | 解除后 Toast 文案正确反映"仍有 N 条"或"已恢复运行" |
| 11 | 生产页 | KPI 与订单表数字自洽（合格率 = 合格数/实际数） |
| 12 | AI 页 | 声明条醒目；页面无任何编造的模型指标 |

### 10.3 验收判定

`10.1` 八条命令全过 + `10.2` 十二项全勾 = 第 3 阶段完成。任何一条不过，写进 `docs/acceptance_phase3.md` 并标注原因，不得改判为"通过"。

---

## 11. 分批交付

| 批次 | 范围 | 交付物 | 验收 |
|---|---|---|---|
| **Batch 1** | 第 1～4 节冻结 + 工程初始化 + 数据层 + 三维场景 + 总览页 + 设备监控页 + 单测 | 可在浏览器看到三维工厂，14 台设备随模拟器状态变化；设备曲线可查 | 10.1.1～10.1.8 + 10.2 第 1～9 项 |
| **Batch 2** | 生产分析页 + 告警与维护页 + AI 预测页 + 一键启动脚本 + 验收报告 | 五页齐全，告警可解除，一键起全链路 | 10.2 第 10～12 项 + 全量复验 |

一键启动脚本（Batch 2）：`scripts/start-all.ps1`，顺序为「docker compose up -d → 等 pg_isready → 起 uvicorn（新窗口）→ 起模拟器（新窗口）→ npm run dev（新窗口）」，每步打印 `[1/4] ...` 进度与失败退出码。

---

## 12. 明确不做（第 3 阶段范围外）

**禁止实现**（写了就是超范围，会被打回）：

1. AI 工业助手页（自然语言查询 / LLM 调用）——方案标注「进阶」，第 5 阶段以后；
2. 任何模型的训练、推理、预测曲线、准确率数字；
3. Kafka、Redis、消息队列；
4. 登录、注册、JWT、权限控制（第 2 阶段已定不做，本阶段延续）；
5. 移动端 / 响应式布局（只保证 ≥ 1280px）；
6. 浅色主题、主题切换开关；
7. 外部 GLB/GLTF 模型、贴图资源、CDN 字体；
8. 历史回放时间轴、录像导出；
9. 告警声音、浏览器通知、邮件；
10. 导出 PDF / Excel / 图片报告；
11. 国际化、多语言；
12. PWA、Service Worker、离线缓存；
13. 后端任何改动（含"顺手加个字段"）——需改后端时先提规格变更；
14. Playwright/Cypress E2E（L-04 已推迟）；
15. 三维物理仿真、碰撞检测、真实运动学（机器人臂只做静态姿态 + 轻微摆动）。
    —— 注意：**视觉动画不算物理仿真**，物料流动与滚筒转动见 §6.7，属于允许范围。

**偏差记录**：

| 编号 | 偏差 | 理由 |
|---|---|---|
| D-01 | 新增页面 `/alerts`（方案未单列） | 方案模块五有告警与维护记录，但五页面里没有落点；不新增则该模块无处安放 |
| D-02 | 方案页面五「AI 工业助手」本阶段不做，仅留禁用导航项 | 方案自身标注为「进阶」，且需要 LLM，与"不训练模型"的阶段边界一致 |
| D-03 | 页面四「AI 预测分析」不含模型，只展示真值与阈值规则 | 模型属第 4 阶段，本阶段若编造预测值会构成虚假数据 |
| D-04 | `VITE_API_BASE` 由绝对地址 `http://127.0.0.1:8000/api/v1` 改为同源 `/api/v1`，REST 走 Vite 代理 | 后端未挂 CORS 中间件，浏览器直连必然失败（实测报「无法连接后端」）；规格第 12 节第 13 条禁止改后端，故只能前端侧走代理。WS 仍直连 8000（不受同源策略限制） |
| D-05 | dev 环境三维视口右下角角标同时显示 `fps · draw call` | 规格第 9 节要求把 `renderer.info.render.calls` 打到控制台；无头浏览器读不到控制台，写成可见角标后 10.1.6 才能被脚本验收，且不影响生产构建（`import.meta.env.DEV` 分支） |
| D-06 | 时间窗统一走 `isoWindow(hours)`，不再用 `isoAgo(h)+isoNow()` 拼窗口 | 两次取时间会跨几毫秒，24 小时变成 86400.002 秒，后端按「> 86400」判 `RANGE_TOO_LARGE` 直接 400。表现是「24 小时窗口时好时坏、1 小时永远正常」，属隐蔽 bug（Batch 2 验收时暴露） |
| D-07 | `src/services/types.ts` 的 4 个 DTO 按实机响应重写（`alarm_id`/`detected_at`、`record_id`/`finished_at`、`ended_at`、`product_id`/`qualified_rate`） | Batch 1 只写占位页，DTO 是照规格臆测的字段名，与后端真实响应不符；Batch 2 接真实数据前必须先对齐，否则页面全显示 `—` |
| D-09 | v1.1 增补 §6.7 产线运行动画（滚筒自转 + 带面纹路 + 物料流动 + 排队堵料 + 机器人摆动） | 作者 v1.0 交付后追加要求「流水线要能动起来」；属规格外新增，故连编号与正文一并补上。原第 12 节第 15 条只禁止物理仿真/碰撞检测，视觉动画不在其内 |
| D-10 | `window.__sceneDebug` 增加 `lineMotion()` 与 `deviceStates()`（仅 dev） | 6.7 的六条规则若只靠人眼看，等于没有验收；暴露运行时快照后，队列位置、闸门开合、冻结行为都能被 `scripts/acceptance-motion.mjs` 逐条断言 |
| D-08 | `window.__sceneDebug` 增加只读 `camera()`（仅 dev） | 10.2-7「预设切换有缓动、镜头不钻地」与 10.2-6「hover/点击」原本只能人工判断。暴露只读位姿后，由 `scripts/acceptance-batch2.mjs` 断言，生产构建会被 `import.meta.env.DEV` 分支清掉 |

---

## 13. 冻结记录（2026-11-24，v0.9 → v1.0）

三项待确认项已由作者全部同意，规格冻结。后续实现与本节冲突时以本节为准。

| # | 事项 | 作者裁定 | 落地位置 |
|---|---|---|---|
| C-1 | 新增 `/alerts` 页面（偏差 D-01），本阶段实际交付 5 个可用页面 + 1 个禁用导航项 | **同意** | 第 5.1 节路由表、第 5.5 节页面四 |
| C-2 | 深色工业风为唯一主题，不做浅色、不做切换开关 | **同意** | 第 4.2 节色值表、第 12 节第 6 条禁止项、L-01 |
| C-3 | 设备机身不随状态染色，状态只用「顶部状态灯 + 地面光环 + 选中描边」表达 | **同意** | 第 4.3 节动效表、第 3.4 节「机身基色统一金属灰」、G-04 |

冻结后的版本约束：本文件 v1.0 生效期内，第 3 阶段任何实现不得偏离第 1～12 节；确需变更时先由作者修订本文件并升版本号，不得在代码里私自处理。
