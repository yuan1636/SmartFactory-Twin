---
title: 第 3 阶段验收记录（Batch 1）
date: 2026-11-24
依据: docs/spec_phase3.md v1.0 第 10 节
范围: Batch 1 —— 工程骨架 + 数据层 + 三维场景 + 总览页 + 设备监控页 + 单测
结论: 10.1 八条命令全部通过；10.2 十二项中 1～4、8、9 已核实，5～7 需人工在浏览器里看，10～12 属 Batch 2 未到期
---

# 第 3 阶段验收记录（Batch 1）

## 0. 环境与方式

| 项 | 值 |
|---|---|
| Node / npm | v22.22.2 / 10.9.7（registry = npmmirror） |
| 前端 | `frontend/`，react 18.3.1 / three 0.170.0 / echarts 5.5.1 / vite 6.0.5 |
| 后端 | uvicorn `app.main:app --port 8000`（第 2 阶段产物，零改动） |
| 数据库 | `sftwin-db`（PostgreSQL 16，宿主 5433），已回填 1 天数据 |
| 浏览器核验方式 | 无头 Chrome（`--dump-dom` 取渲染后的 DOM、`--screenshot` 取图）；WebGL 走 SwiftShader，**帧率数字不作为性能结论** |

时间：2026-11-24 19:48 ~ 20:15（UTC+8）。

---

## 1. 可自动化部分（规格 10.1）

### 10.1.1 构建

**结论：通过**

```powershell
cd D:\wbproject\2026-11-24-10-02-56\frontend
npm run build
```

实际输出：

```text
> tsc -b && vite build
vite v6.0.5 building for production...
✓ 622 modules transformed.
dist/index.html                     0.39 kB │ gzip:   0.31 kB
dist/assets/index-PbNbV3Z4.css     12.10 kB │ gzip:   2.99 kB
dist/assets/index-DqfsKPxQ.js   1,229.03 kB │ gzip: 373.12 kB
✓ built in 5.62s
```

- `tsc -b` 阶段 0 个类型错误（首轮曾报 1 个：测试文件里泛型被推断成 `never`，已修）。
- gzip 后 373 KB，低于规格第 9 节 1.2 MB 的预算。
- Vite 提示单 chunk > 500 KB。这是 three + echarts 的固有体积，属提示不是错误；未做代码分割（本阶段 5 个页面全在首包，拆了反而多一次请求）。

### 10.1.2 单元测试

**结论：通过（39 个用例，规格要求 ≥ 8）**

```powershell
npm run test
```

实际输出：

```text
 ✓ src/three/layout.test.ts (8 tests)
 ✓ src/utils/status.test.ts (5 tests)
 ✓ src/services/store.test.ts (4 tests)
 ✓ src/services/format.test.ts (6 tests)
 ✓ src/services/api.test.ts (6 tests)
 ✓ src/components/components.test.tsx (5 tests)
 ✓ src/charts/options.test.ts (5 tests)

 Test Files  7 passed (7)
      Tests  39 passed (39)
```

覆盖的硬约束：状态合并优先级（G-03）、ISO 时间按本地时区换算（G-13）、时间参数 `+` 必须编码成 `%2B`（7.1）、阈值 ×1.1 / ×1.25 与后端 config 同值、空值点不画成 0、`seq` 未变不触发订阅、14 台设备坐标与清单一一对应且不穿模、错误码文案。

### 10.1.3 开发服务可访问

**结论：通过**

```powershell
npm run dev
(Invoke-WebRequest http://127.0.0.1:5173/overview -UseBasicParsing).StatusCode
```

实际输出：`200`

### 10.1.4 五个路由都能返回 SPA 页面

**结论：通过**

```powershell
foreach ($p in "/overview","/devices","/production","/alerts","/ai") { "$p -> " + (Invoke-WebRequest "http://127.0.0.1:5173$p" -UseBasicParsing).StatusCode }
```

实际输出（含两个附加检查）：

```text
/ -> 200
/overview -> 200
/devices -> 200
/production -> 200
/alerts -> 200
/ai -> 200
/nope -> 200     # SPA 兜底，前端渲染 NotFound；后端路由不存在时表现为「页面不存在 + 返回总览」
```

注：`/production`、`/alerts`、`/ai` 本批次是占位页（内容明写「Batch 2 交付」与对应规格章节），不显示任何假数字。

### 10.1.5 三维设备数量

**结论：通过（14）**

```js
document.querySelectorAll('[data-device-label]').length
```

无头浏览器等价命令：

```powershell
chrome --headless=new --dump-dom http://127.0.0.1:5173/overview > overview.html
(Select-String -Path overview.html -Pattern 'data-device-label' -AllMatches).Matches.Count
```

实际输出：`14`（另有 `data-line-label` 4 个，对应 LINE-A1/A2/B1/B2）。

### 10.1.6 draw call

**结论：通过（74 / 122，均 ≤ 150）**

```js
window.__sceneDebug?.renderInfo().calls
```

实际值：默认总览视角首帧 **74**；截图那一帧（含 14 个标签、视锥更宽）**122**。
本机同一时刻页面右下角角标显示 `1 fps · 122 calls`（无头 SwiftShader 软渲染，帧率不作数）。

> 角标同时显示 fps 与 draw call 属偏差 D-05：规格第 9 节要求把 `renderer.info.render.calls` 打到控制台，
> 无头浏览器读不到控制台，写成可见角标后该条才能被脚本验收。生产构建走 `import.meta.env.DEV` 分支，不显示 calls。

### 10.1.7 后端未启动时的错误态

**结论：通过**

操作：停掉 8000 端口的 uvicorn（`Stop-Process` 监听进程），刷新 `/devices/CNC-01` 与 `/overview`。

实际输出：

```text
状态块文案：无法连接后端，请检查服务是否启动
重试按钮：存在
连接状态：重连中（第 1 次） / 已断开
页面结构：侧栏、顶栏、三维画面（14 个标签）仍在，未白屏、未无限加载
```

> 实现细节：REST 走 Vite 的 `/api` 代理，后端没起时代理回 `500 + 纯文本 Internal Server Error`（不是 JSON）。
> 前端据此判定「5xx 且解析不出 JSON」= 后端不可达，才得到上面这句文案；否则会显示成「请求失败（500）」，
> 不符合 10.1.7 的预期。

### 10.1.8 WS 重连

**结论：通过**

1. 打开 `/overview`，`ConnectionIndicator` 显示 **实时已连接**（绿）；
2. 停掉 uvicorn；
3. 7 秒内页面变为 **重连中（第 2 次）**，顶部出现降级条：
   「实时连接已断开，正在重连（第 2 次）。三维状态灯已转灰，数值停止更新 —— 数据不是当前值。」；
4. 重启 uvicorn（`python -m uvicorn app.main:app --port 8000`）；
5. 9 秒内恢复 **实时已连接**，KPI 恢复为 14 台设备的实时值，降级条消失。

补充：模拟器对后端中断的反应符合第 2 阶段设计 —— 连续 3 个 tick 写入失败后打印
「判定后端不可用，退出」并退出（本次实测 `写入失败/重试 3 / 9`），重启后端后重新拉起即可。

---

## 2. 人工检查表（规格 10.2，12 项）

| # | 检查项 | 结论 | 依据 / 说明 |
|---|---|---|---|
| 1 | 厂区完整可见 | 通过 | 截图 `output/shot_overview.png`：2 个车间、4 条产线色带、14 台设备、动力站（AIR-01 + PUMP-01）齐全 |
| 2 | 层级可辨 | 通过 | 机床（底座+主轴柱+前门）、机器人（底座+两段臂+夹爪）、输送机（长框+8 滚筒）、检测台（台面+龙门架+相机）、空压机（方箱+风扇）、冷却泵（卧式圆柱）形态可区分 |
| 3 | 标签清晰 | 通过（有一条备注） | 14 个编号标签清晰可读、不重叠；近距离拉到设备跟前时相邻标签会略显拥挤，不影响识别。中文设备名在右侧列表与设备页展示，三维里只放编号（避免 14 个中文标签互相压） |
| 4 | 状态对比 | 通过 | 五态颜色肉眼可分；截图当刻 AIR-01 处于告警（红点 + 告警数 1），标签自动加白底强调 |
| 5 | 动效 | **未验证** | 已实现：RUNNING 呼吸（2 秒周期）、ALARM 1 Hz 闪烁、MAINTENANCE 0.5 Hz 慢闪，且遵循 `prefers-reduced-motion`。无头截图无法呈现动效，需人工在浏览器看 1 秒确认无频闪刺眼 |
| 6 | 交互 | **未验证** | 已实现：hover 白色描边 + 标签加粗、click 跳 `/devices/{id}` 并聚焦镜头、拖动超过 4px 不判为点击。需人工点一次确认 |
| 7 | 镜头 | 部分通过 | 三个预设 + 重置视角按钮已接线，切换走 600ms 缓动；`maxPolarAngle = π/2.15` 已限制钻地。缓动手感需人工确认 |
| 8 | 曲线 | 通过 | 截图 `output/shot_devices.png`：四指标曲线、WARNING/CRITICAL 参考线、时间轴正常；1h/6h/24h 切换后数据窗口随之变化（实测 1h = 1,787 点、24h = 1,964 点抽样） |
| 9 | 降采样 | 通过 | 24h：接口返回 `downsample_step=22, truncated=true`，页面出现黄色提示「当前为抽样展示：每 22 个点取 1 个，共 1,964 点」（临时把默认范围改成 24h 实测，验证后已改回 1h） |
| 10 | 告警解除 | 未到期 | 属 Batch 2（`/alerts` 页） |
| 11 | 生产页 | 未到期 | 属 Batch 2（`/production` 页） |
| 12 | AI 页 | 未到期 | 属 Batch 2（`/ai` 页） |

截图证据（均已生成在 `output/`，不进 git）：

- `output/shot_overview.png`：总览页（三维 + KPI + 设备列表 + 图例）
- `output/shot_devices.png`：设备监控页（设备卡 + 四张曲线）
- `output/overview_dom.html` / `output/devices_dom.html`：渲染后的 DOM 快照

---

## 3. 本批次发现并修复的问题

| # | 问题 | 处理 |
|---|---|---|
| 1 | 规格 2.3 的绝对地址 `http://127.0.0.1:8000/api/v1` 在浏览器里必然失败：后端没有 CORS 中间件，页面报「无法连接后端」 | 改为同源 `/api/v1` 走 Vite 代理，记偏差 **D-04**（规格第 12 节）；WS 仍直连 8000（不受同源策略限制） |
| 2 | 转速图出现了 WARNING/CRITICAL 参考线，但文案写「转速无阈值」——因为 `metrics_normal_range` 里也有 speed | 后端 config 只给温度/振动/电流配了 thresholds，前端新增 `THRESHOLD_METRICS` 白名单，只对这三项画线，并补单测锁住 |
| 3 | 温度图的 WARNING 77 落在坐标轴范围外被裁掉，看不见线 | `yAxis.max` 改为「数据最大值与 CRITICAL 的较大者 × 1.05」，保证两条参考线始终在视野内 |
| 4 | WS 兜底路径（`/devices/latest`）没有设备名，列表只显示编号 | store 增加 `catalog` 缓存；总览页 10 秒轮询 `/devices` 灌入台账，兜底时也显示中文设备名 |
| 5 | 无头浏览器 rAF 被节流，draw call 读不到 | 场景初始化后同步渲染一帧并写角标，同时保留 `window.__sceneDebug.renderInfo()` |

---

## 4. 未验证项汇总（不改判为通过）

1. **10.2-5 动效**：需人工在浏览器看 RUNNING 呼吸 / ALARM 1 Hz / MAINTENANCE 慢闪是否刺眼。
2. **10.2-6 交互**：需人工 hover 与点击各一次，确认描边、跳转、镜头聚焦。
3. **10.2-7 镜头缓动**：预设切换的 600ms 缓动手感需人工确认（钻地限制已由 `maxPolarAngle` 保证）。
4. **真实帧率**：无头环境是 SwiftShader 软渲染（1～5 fps），规格「≥ 50 fps」需在有 GPU 的浏览器里看角标确认，本记录不下结论。
