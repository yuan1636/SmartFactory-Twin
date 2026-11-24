---
title: 第 3 阶段验收记录（Batch 1 + Batch 2）
date: 2026-11-24
依据: docs/spec_phase3.md v1.0 第 10 节
范围: Batch 1 —— 工程骨架 + 数据层 + 三维场景 + 总览页 + 设备监控页 + 单测；Batch 2 —— 生产分析 / 告警与维护 / AI 真值页 + 一键启动脚本
结论: 10.1 八条命令全部通过（Batch 2 后复验仍全过）；10.2 十二项中 9 项由脚本断言通过，2 项（动效观感、真实帧率）保留人工判断，1 项（状态对比）沿用 Batch 1 截图
---

# 第 3 阶段验收记录（Batch 1 + Batch 2）

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
| 5 | 动效 | 实现已确认，观感**待人工** | 已实现：RUNNING 呼吸（2 秒周期）、ALARM 1 Hz 闪烁、MAINTENANCE 0.5 Hz 慢闪，且遵循 `prefers-reduced-motion`。脚本无法判断「是否刺眼」，这一条始终留给人眼 |
| 6 | 交互 | 通过（Batch 2 脚本断言） | 用 CDP 在设备标签坐标上派发真实鼠标事件：hover 后该标签出现 `is-active`（描边+加粗），click 后路径变为 `/devices/CNC-01`。Batch 1 时缺跳转（只做聚焦），已按规格 6.3 补上并复验 |
| 7 | 镜头 | 通过（Batch 2 脚本断言） | 点「WS-A」后读数：150ms 时 `(-11.6, 31.9, 39.9)` 既非起点也非终点（说明在缓动而非瞬移），1.05s 后落在 `(-20.0, 26.0, 34.0)` 与预设一致，`y > 0` 未钻地 |
| 8 | 曲线 | 通过 | 截图 `output/shot_devices.png`：四指标曲线、WARNING/CRITICAL 参考线、时间轴正常；1h/6h/24h 切换后数据窗口随之变化（实测 1h = 1,787 点、24h = 1,964 点抽样） |
| 9 | 降采样 | 通过 | 24h：接口返回 `downsample_step=22, truncated=true`，页面出现黄色提示「当前为抽样展示：每 22 个点取 1 个，共 1,964 点」（临时把默认范围改成 24h 实测，验证后已改回 1h） |
| 10 | 告警解除 | 通过（Batch 2 脚本断言） | 两个分支都实测：还有残留时 Toast「已解除 1 条；该设备仍有 1 条未解除告警，状态保持「告警」」；清零时「已解除 1 条；该设备已无未解除告警，状态为「运行中」」 |
| 11 | 生产页 | 通过（Batch 2 脚本断言） | 页面合格率 96.6% = 接口 96.6%；已完成订单 44 = 接口 44；订单首行 `ORD-20261124-0016` 与接口一致；20 行表格 + 2 张图均渲染 |
| 12 | AI 页 | 通过（Batch 2 脚本断言） | 声明条含「本阶段不含任何模型推理」；全文正则扫 `准确率|故障概率|预计故障|模型置信度` 无命中；预留虚线框存在；两张图 + 100 行真值表 |

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

## 4. 未验证项汇总（Batch 1 结束时，共 4 项）

> 其中第 2、3 项已在 Batch 2 由脚本断言通过（见第 5 节），第 1、4 项永久保留人工判断。

1. **10.2-5 动效**：需人工在浏览器看 RUNNING 呼吸 / ALARM 1 Hz / MAINTENANCE 慢闪是否刺眼。
2. **10.2-6 交互**：需人工 hover 与点击各一次，确认描边、跳转、镜头聚焦。
3. **10.2-7 镜头缓动**：预设切换的 600ms 缓动手感需人工确认（钻地限制已由 `maxPolarAngle` 保证）。
4. **真实帧率**：无头环境是 SwiftShader 软渲染（1～5 fps），规格「≥ 50 fps」需在有 GPU 的浏览器里看角标确认，本记录不下结论。

---

## 5. Batch 2 交付与复验（2026-11-24 20:26 ~ 20:45）

### 5.0 本批交付物

| 交付物 | 位置 | 依据 |
|---|---|---|
| 生产数据分析页 | `frontend/src/pages/Production.tsx` | 规格 5.4 |
| 设备告警与维护页 | `frontend/src/pages/Alerts.tsx` | 规格 5.5 |
| AI 预测分析页（仅真值） | `frontend/src/pages/AiInsight.tsx` | 规格 5.6 |
| 页面级验收脚本 | `scripts/acceptance-batch2.mjs` | 规格 10.2 的自动化替代 |
| 一键启动脚本 | `scripts/start-all.ps1` | 规格第 11 节 |
| 纯计算与图表工厂 | `frontend/src/utils/analytics.ts`、`frontend/src/charts/options.ts` | 可单测的部分从页面里抽出来 |

### 5.1 验收前准备：造数据

告警页与维护页在真机上是空的（`/alarms?resolved=false` = 0 条、`/maintenance` = 0 条），
没有对象可点就无法验 10.2-10。经作者同意后写入以下测试数据（全部走正常 API）。

**① 注入告警**（时间戳必须带毫秒，否则与模拟器的整 2 秒栅格撞主键，返回 409 DUPLICATE_TELEMETRY）：

```powershell
$ts = (Get-Date).ToUniversalTime().AddSeconds(-7.5).ToString('yyyy-MM-ddTHH:mm:ss.fff+00:00')
$body = @{ device_id='CNC-01'; ts=$ts; temperature=95.0; vibration=2.0; current=9.5; speed=1500; running_status='RUNNING' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/api/v1/telemetry -ContentType 'application/json' -Body $body
```

CNC-01 温度上限 70℃，严重阈值 87.5℃ → 95.0 触发 1 条 CRITICAL。扫描任务约 3～6 秒后落库。
**注意同设备同类型 5 分钟冷却**：重复注入同一台会被静默跳过，要连测就换设备
（本轮依次用了 CNC-01 / CNC-04 / CNC-02 / CNC-03 / INSP-01）。

**② 维护记录**（2 条已完成 + 1 条进行中）：

```powershell
$m1 = @{ device_id='CNC-02'; maintenance_type='ROUTINE'; description='更换主轴润滑油'; started_at='2026-11-24T10:35:00+00:00'; finished_at='2026-11-24T11:05:00+00:00'; cost=1200 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/api/v1/maintenance -ContentType 'application/json' -Body $m1

$m2 = @{ device_id='ROB-01'; maintenance_type='INSPECTION'; description='季度点检（进行中）'; started_at='2026-11-24T12:05:00+00:00'; finished_at=$null; cost=$null } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8000/api/v1/maintenance -ContentType 'application/json' -Body $m2
```

第二条不填结束时间，按 G-10 让 ROB-01 转 `MAINTENANCE`，顺带给 10.2-4（五态对比）提供真实样本。
**恢复方法**：再为 ROB-01 提交一条带 `finished_at` 的维护记录，设备即回 `RUNNING`（前提是无未解除告警）。

### 5.2 页面级验收（24 项，`scripts/acceptance-batch2.mjs`）

方式：Chrome 以 `--headless=new --remote-debugging-port=9222` 启动，脚本走 CDP
派发**真实鼠标事件**并读取渲染后的 DOM（不是 dump-dom 静态快照，所以点击后的 Toast 拿得到）。

```text
PASS  三维设备标签 14 个  · 14 个
PASS  相机调试钩子可用
PASS  相机预设按钮存在
PASS  10.2-7 预设切换到 WS-A 的终点位姿正确  · 终点 -20.0,26.0,34.0
PASS  10.2-7 切换过程有缓动（非瞬移）  · 中途 -11.6,31.9,39.9
PASS  10.2-7 镜头不低于地面  · y=26.0
PASS  10.2-6 hover 有高亮反馈  · 标签 CNC-01
PASS  10.2-6 点击设备跳转到监控页  · 当前路径 /devices/CNC-01
PASS  告警页渲染
  告警 KPI： [{"label":"未解除告警（全厂）","value":"5条"},{"label":"其中 CRITICAL","value":"3条"},{"label":"其中 WARNING","value":"2条"}]
PASS  维护记录表有数据  · 3 行
PASS  解除按钮存在
  Toast： 已解除 1 条；该设备已无未解除告警，状态为「运行中」
PASS  10.2-10 解除 Toast 复述 G-10 结果  · 已解除 1 条；该设备已无未解除告警，状态为「运行中」
PASS  生产页 KPI 渲染
  生产 KPI： [{"label":"已完成订单","value":"44","delta":"在制 4 单"},{"label":"实际产量","value":"5,300","delta":"计划 5,760 件 · 完成率 92.0%"},{"label":"合格率","value":"96.6%","delta":"合格 5,120 / 实际 5,300"},{"label":"设备利用率","value":"86.7%","delta":"按遥测采样点中 RUNNING 的占比"}]
PASS  10.2-11 合格率与后端一致  · 页面 96.6% / 接口 96.6%
PASS  10.2-11 已完成订单与后端一致  · 页面 44 / 接口 44
PASS  订单表有数据  · 20 行
PASS  订单首行与接口一致  · 页面 ORD-20261124-0016 / 接口 ORD-20261124-0016
PASS  两张图表已绘制  · 2 个 canvas
PASS  AI 页声明条存在
PASS  10.2-12 声明条说明「不含模型推理」  · 本阶段不含任何模型推理。以下数据来自模拟器写入的异常真值与阈值告警规则，不是模型
PASS  10.2-12 页面无编造的模型指标  · 未发现
PASS  10.2-12 预留虚线框存在
PASS  AI 页两张图已绘制  · 2 个 canvas
PASS  真值表有数据  · 100 行

合计 24 项，通过 24，失败 0
```

「仍有 N 条」那半个分支在上一轮单独验过，原文：
`已解除 1 条；该设备仍有 1 条未解除告警，状态保持「告警」`（当时 CNC-01 有 2 条 CRITICAL）。

截图：`output/shot_production.png`、`output/shot_alerts.png`、`output/shot_ai.png`。

### 5.3 规格 10.1 全量复验

| 项 | 结论 | 实际输出 |
|---|---|---|
| 10.1.1 构建 | 通过 | `✓ built in 5.89s`，0 error；gzip 386.25 kB（Batch 1 为 373 kB，增加的是 custom 系列与三个页面） |
| 10.1.2 单测 | 通过 | `8 files / 60 tests passed`（Batch 1 的 39 个 + 本批 21 个） |
| 10.1.3 / 10.1.4 路由 | 通过 | `/`、`/overview`、`/devices`、`/devices/CNC-01`、`/production`、`/alerts`、`/ai`、`/nope` 全部 200 |
| 10.1.5 设备标签 | 通过 | DOM 中 `data-device-label` = 14 |
| 10.1.6 draw call | 通过 | 角标 `74 calls`（≤ 150 预算） |
| 10.1.7 后端停机错误态 | 通过 | 停掉 8000 后 `/devices/CNC-01` 显示「无法连接后端，请检查服务是否启动」+ 重试按钮 |
| 10.1.8 WS 重连 | 通过 | 停机时「重连中（第 2 次）」+ 降级条；后端恢复后回到「实时已连接」，降级条消失 |

### 5.4 Batch 2 发现并修复的问题

| # | 问题 | 处理 |
|---|---|---|
| 1 | **24 小时窗口时好时坏**：`start = isoAgo(24)`、`end = isoNow()` 两次取时间跨 1～2ms，后端按「跨度 > 86400 秒」判 `RANGE_TOO_LARGE` 返回 400 | 新增 `isoWindow(hours)`，起止基于同一次 `Date.now()`；生产页四条产线共用同一窗口；补单测断言跨度精确等于 24×3600×1000。记偏差 **D-06** |
| 2 | `types.ts` 里 4 个 DTO 与后端真实响应不符（`id` vs `alarm_id`、`triggered_at` vs `detected_at`、`finished_at` vs `ended_at`、`product_name` vs `product_id`） | 按实机响应重写；Batch 1 只跑占位页所以没暴露，接真实数据前必须先对齐。记偏差 **D-07** |
| 3 | 三维里点击设备只做镜头聚焦、没有跳转，与规格 6.3「click 跳 `/devices/{id}`」不符 | 总览页 `onSelectDevice` 改为 `navigate('/devices/'+id)`；右侧列表行仍按 5.2 只做聚焦，两者语义按规格区分 |
| 4 | 生产页折线图 20 个订单号横轴标签挤成一团，订单号单元格换行 | 轴标签改 `hideOverlap` 自动隔点；订单号列宽 150→172 |
| 5 | 工期外的坑：`POST /telemetry` 用整秒时间戳必然撞模拟器的 2 秒栅格，返回 409 | 验收命令改用带毫秒的时间戳（见 5.1），不涉及产品代码 |

### 5.5 最终未验证项（不改判为通过）

1. **10.2-5 动效观感**：RUNNING 呼吸 / ALARM 1 Hz / MAINTENANCE 0.5 Hz 的「是否刺眼」只能人眼看，脚本不断言。
2. **真实帧率**：无头环境是 SwiftShader 软渲染（本轮 2～8 fps），规格「≥ 50 fps」需在有 GPU 的浏览器里看角标，本记录不下结论。

### 5.6 验收后环境状态（留档）

- 未解除告警仍有若干条（多轮注入的残留，最后一轮为 5 条），作为告警页演示数据保留；
  要清空可在页面上逐条「解除」，或等收敛任务在指标回落后自动解除。
- ROB-01 处于 `MAINTENANCE`（第 3 条维护记录未填结束时间），保留用于演示五态；恢复方法见 5.1。
- 后端 8000、模拟器、前端 5173 均在运行（10.1.7 / 10.1.8 停机验证后已重启）。
