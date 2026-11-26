# 第 4 阶段实现规格 v4.0 —— 三维界面展示与演示能力

```yaml
文档: docs/spec_phase4.md
版本: v4.0（2026-11-25，全量重写，替代 v2.0）
上游: docs/spec_phase3.md v1.1（三维场景与五页前端的实现基线）
归档: docs/archive/spec_phase4_v1.0.md / _v1.1.md / _v2.0.md
状态: 待施工（D0 起）
```

> **本阶段的判断标准变了。** v2.0 的判据是"数据对得上、指标可追溯"，v4.0 的判据是"看得懂、看得像、点得动、演得住"。
> 这不是措辞调整：v2.0 里所有为"数据一致性"服务的要求（离线评估、逐数字可追溯、时序压缩收益、吞吐测算）在 v4.0 中**全部移出范围**，
> 取而代之的是可截图、可计时、可脚本断言的展示指标。已被这个转向否决的条款见 §7.3，不在正文重复论证。

---

## 0. 本文件怎么用

### 0.1 三条阅读路径

| 你的目的 | 读哪几节 | 大约用时 |
|---|---|---|
| **首次施工**（从头做六个批次） | §1 目标 → §2 现状基线 → §3 批次计划 → §6 视觉规范 | 25 分钟 |
| **只想知道验收怎么做** | §4 硬指标总表 → §5 验收命令 → §5.7 人工检查 | 10 分钟 |
| **只想跑一遍看现在什么水平** | 附录 A（D0 体检命令） | 5 分钟 |

三条路都不需要读归档件。归档件只在两种情况下打开：查"某条旧要求当年为什么这么定"、查偏差 D-11~D-36 的原始记录。

### 0.2 v2.0 → v4.0 差异导读

五类变更，按影响从大到小：

**① 目标转向（改的是判据，不是工作量）**
v2.0 一句话目标是"把按阈值报警升级为有离线评估、每个数字可追溯的异常检测"。v4.0 是"打开页面 5 秒内让人看出这是智慧工厂，1 分钟内自己走完全厂→车间→设备→曲线，连续演示 3 分钟不卡不白屏不穿模"。
判据从"数对不对"换成"看不看得懂"，所以 §4 的指标全部重写成可截图或可计时的形式。

**② 范围删除（v2.0 有 4 个批次被整批删掉）**
TimescaleDB 迁移与压缩对比（已交付、冻结）、Kafka 决策记录、故障风险可行性、产量预测与基线对比。
连带删掉 §6 TimescaleDB 迁移细则整章、§7 Kafka 提纲整章、§3 数据基线整节。删除清单见 §7.3。

**③ 后端冻结（新约束，v2.0 没有）**
`app/` 与 `database/` 自本版起冻结，除修 bug 外不改。理由是展示层的六个批次不需要后端配合，
一旦放开就会出现"为了好看改接口"的滑坡——那会让已交付的 4 批验收（42 + 24 + 17 项）失去意义。例外流程见 §7.1。

**④ 指标重设（三个数变了，两个数新增）**
draw call 上限从 phase3 的"90 / ≤150"两处矛盾值统一为 **≤100**（现状 132，须靠合批降下来）；
首屏可交互从"未测"变成 **≤3 秒**（有测量方法，见 §4）；
弱机帧率新增 **≥30 fps**，并明确"弱机"用 CPU 4× 降速模拟，不是"找台旧电脑"；
连续演示 **3 分钟** 无白屏 / 无 WebGL 上下文丢失 / 无穿模 是新指标。

**⑤ 事实回填（v2.0 的推测被实测替换）**
现状 draw call 132 / 11,066 三角形（v2.0 只写"预算 150"）；渲染器**未开色调映射、未加雾**（v2.0 未记录）；
相机预设只有 **3 个**（v2.0 未清点，而 D3 要求 5 个）；CONV 设备的 `speed` 只有 **2 条产线有**（详见 §2.1）。
这些数字都来自本次读码与查库，取数命令在附录 A。

### 0.3 版本与归档

| 版本 | 日期 | 行数 | 判据 | 归档位置 |
|---|---|---|---|---|
| v1.0 | 2026-11-24 | 636 | 数据流水线 + AI 模型（六块） | `docs/archive/spec_phase4_v1.0.md` |
| v1.1 | 2026-11-24 | 648 | 同上 + 4.2 批施工偏差 D-18~D-25 | `docs/archive/spec_phase4_v1.1.md` |
| v2.0 | 2026-11-25 | 1,029 | Kafka 不接 / TimescaleDB 接 / D、E 块降级 | `docs/archive/spec_phase4_v2.0.md` |
| **v4.0** | **2026-11-25** | **本文件** | **三维展示与演示能力** | 当前文件 |

> 版本号从 v2.0 直接跳到 v4.0，是作者指定，不是笔误。中间空出的 v3.0 留给"若展示阶段之后还要回头做数据侧"的位置，避免将来出现编号倒挂。
> **偏差编号不重排**：D-11~D-36 留在 v2.0 归档，v4.0 的新偏差从 **D-37** 起（见附录 B）。重排会打断 `docs/acceptance_phase4.md` 里已有的引用。

---

## 1. 目标与判据

### 1.1 一句话目标

> 打开页面 **5 秒**内让人看出这是智慧工厂；**1 分钟**内能自己走完「看全厂 → 进车间 → 点设备 → 看曲线」；连续演示 **3 分钟**不卡、不白屏、不穿模。

三个时间点是可测的硬边界，不是修辞：

| 时间点 | 含义 | 怎么测 |
|---|---|---|
| **5 秒** | 页面可交互，且首屏画面已经"像工厂" | `performance` 打点取首屏可交互时间；第 5 秒截一张图，交给盲测判"是不是工厂" |
| **1 分钟** | 四步操作闭环无需人指导 | 录屏里从入场到设备曲线出现的时间戳差 ≤60 秒，且中途不需要鼠标乱找 |
| **3 分钟** | 连续演示不崩 | 录屏 180 秒，期间 0 次白屏、0 次 `webglcontextlost`、0 次穿模（判定方法见 §4） |

### 1.2 四条判据

阶段验收只认这四条。每条都必须能落到"一张图"或"一个数"上，落不下去的写法一律不接受。

| 判据 | 具体含义 | 落地形式 | 对应批次 |
|---|---|---|---|
| **看得懂** | 不看文档也知道这是什么场景、每块区域在做什么 | 盲测：给 3 个没听过项目的人看截图，≥2 人第一眼说"工厂/车间/产线"，并能指出"这条是传送带" | D2、D5 |
| **看得像** | 材质、光照、道具密度接近真实车间观感，不是几何体堆叠 | 前后同机位对比截图；工业道具 ≥7 类且不与设备穿模 | D1、D2 |
| **点得动** | 14 台设备点得到、点得准、点完有反馈 | 14 台点击命中率 **100%**；点击后 ≤1.2 秒相机到位并弹出侧栏 | D3 |
| **演得住** | 长时间演示不掉帧、不白屏、不穿模、断网有提示 | 3 分钟录屏无异常；≥50 fps（弱机 ≥30）；断网显示明确状态 | D4、D6 |

> "看得懂"和"看得像"的区别要守住：**看得懂是信息层**（这是什么、在哪），**看得像是感受层**（材质光影像不像）。
> 两者冲突时先保"看得懂"——一条看不清的传送带，材质再好也没用。

### 1.3 三条边界：本阶段不证明什么

写论文、做答辩、向人介绍时，以下三句不能越界：

| 不证明 | 原因 |
|---|---|
| 三维场景反映真实工厂的物理与工艺 | 场景是示意布局，设备坐标、产线顺序、闸门逻辑都是演示设定，没有工艺依据 |
| 页面上的产量/告警/指标可用于生产决策 | 数据来自模拟器，注入密度是演示设定（每约 10 分钟一次异常），不代表真实异常率 |
| 系统能支撑真实产线规模 | 14 台设备、7 行/秒是演示规模，所有性能数字只对这个规模成立 |

### 1.4 与"真实数据"的关系（唯一连接点）

本阶段只保留**一个**真数据连接点，其余三维表现允许与数据无关：

> **传送带速度 = CONV 设备的实时 `speed` 指标映射。**

映射公式、无 CONV 产线的 fallback、改动范围见 §7.2。除此之外，物料流向、机械臂摆动、粒子效果、
警示灯节奏都不要求与遥测数据对应——它们是"看起来在动"的表演层，不是数据的可视化。

这条边界要写进代码注释：**将来若有人问"为什么机械臂摆动频率跟振动数据没关系"，答案是"本阶段没要求"**，而不是"忘了做"。

---

## 2. 现状基线

> 本节所有数字来自 2026-11-25 的读码与查库，取数命令见附录 A。凡标"未测"的，D0 必须补测，不许估算。

### 2.1 已核实的代码事实

作者提供的六条事实逐条复核：五条准确，一条行号偏差两行；另发现六条会影响规划的事实。

| # | 事实 | 位置 | 与新目标的关系 |
|---|---|---|---|
| 1 | 带速是常量 `BELT_SPEED = 2.4` (m/s) | `three/motion.ts:16` | §7.2 的数据连接点要改这里 |
| 2 | 物料数量 `Math.floor(length / ITEM_SPACING)`，间距 3.0 m | `three/motion.ts:119-121` | 带速变慢后物料会挤在一起，需按速度调间距 |
| 3 | 闸门由设备状态决定：非 RUNNING 即关 | `three/motion.ts:205` 起 | **这部分是对的，不动** |
| 4 | store 里有每台设备 `speed` | `services/store.ts:149` | 数据源现成，不用改后端 |
| 5 | 已有相机预设与射线拾取 | `three/cameraPresets.ts`（29 行）、`SceneRoot.tsx` | 现有 **3 个**预设，D3 要 5 个 |
| 6 | 后处理未接入 | `SceneRoot.tsx:92-96` | 已开 `antialias: true` 与 `PCFSoftShadowMap`，**未开 toneMapping、无 fog** |

**追加发现（v2.0 未记录，影响 D1/D2）：**

| 发现 | 证据 | 影响 |
|---|---|---|
| 未设 `toneMapping`，即默认 `NoToneMapping` | `SceneRoot.tsx` 全文无 `toneMapping` 赋值 | 加 Bloom 前必须先上 ACESFilmic，否则高光截断成白块 |
| 已开 `antialias: true`（MSAA） | `SceneRoot.tsx:92` | 与 SMAA **功能重叠**，二者只能留一个（§6.1 给理由） |
| 无 postprocessing 依赖，只有 `three@0.170.0` | `frontend/package.json:18` | Bloom/SMAA 走 `three/examples/jsm`，零新增依赖 |
| 场景无雾 | `SceneRoot.tsx:86` 只设 `background: 0x0b1018` | 远景边界生硬，加雾是"像"的主要来源之一 |
| 预设只有 3 个：`overview` / `WS-A` / `WS-B` | `cameraPresets.ts:8-12` | D3 需 5 个，缺 2 个 |
| CONV 只有 2 台，分属 LINE-A1 / A2；LINE-B1/B2 无 CONV | `devices` 表：`A1=CNC-01 CONV-01 ROB-01`、`A2=CNC-02 CONV-02 ROB-02`、`B1/B2` 无 | **B1/B2 的带速没有数据源**，必须 fallback（§7.2） |
| CONV `speed` 正常区间 `[600,1200]`，实测 min 0 / 均值 870 / max 1260，每台 328,521 点、0 空值 | `config/devices.json` + `device_telemetry` | 映射可用；**0 代表停机**，必须映射成"带停"而非"爬行" |

### 2.2 `frontend/src/three/` 的文件职责与可改范围

10 个文件、1,750 行。改动范围按此表控制，避免一个批次动到另一批次的文件。

| 文件 | 行数 | 职责 | 可改 | 说明 |
|---|---|---|---|---|
| `SceneRoot.tsx` | 392 | 渲染循环、相机、拾取、状态材质切换、`__sceneDebug` | ✅ 主战场 | D1/D3/D4/D6 都动它；每次改都要保住调试接口 |
| `builders.ts` | 362 | 程序化几何：厂房/色带/六类设备/滚筒/机械臂 | ✅ | D1 改材质，D2 加道具（新函数放这里或新文件） |
| `motion.ts` | 316 | 物料 `InstancedMesh`、滚筒自转、机械臂摆动 | ✅ | D4 主战场；§7.2 的带速映射也在这里 |
| `layout.ts` | 117 | 14 台设备坐标、六类机身尺寸、产线物料流顺序 | ⚠️ 谨慎 | 改坐标会连带点击坐标与镜头预设，**除加道具锚点外不改** |
| `lineTraffic.ts` | 98 | 一维队列推进（纯函数，可单测） | ⚠️ 谨慎 | 带速改成 4 条线独立后函数签名要加参数，**改完必须补单测** |
| `materials.ts` | 113 | 全部材质与配色 | ✅ | D1/D2 主战场 |
| `cameraPresets.ts` | 29 | 3 个相机位 + 轨道限制 | ✅ | D3 扩到 5 个 |
| `labels.ts` | 38 | 设备名称标签（Sprite / Canvas 文字） | ✅ | D5 统一样式 |
| `layout.test.ts` | 146 | 布局与坐标约束单测 | ✅ | 加道具后补"道具不穿设备"断言 |
| `lineTraffic.test.ts` | 139 | 队列推进单测 | ✅ | 带速改造后补多速度用例 |

### 2.3 性能基线（已实测，D6 的对照）

| 指标 | 现值 | 来源 | 说明 |
|---|---|---|---|
| draw call | **108** | D0 实测（三次 108/108/108） | 角标 `renderer.info.render.calls` |
| 三角形 | **9,146** | 同上 | 几何量很小，瓶颈在 draw call 不在面数 |
| 帧率 | **144.9 fps**（5s rAF 中位） | 同上 | RTX 4060 Laptop + 144Hz 屏；**无头 SwiftShader 的 1~5 fps 不作数** |
| 首屏可交互 | **562 ms** | 同上（导航开始 → canvas 首帧） | DOM 就绪 182 ms |
| 后处理开销 | **未测** | — | D1 测增量 |
| 各机位 draw call | 总览 108 / WS-A 75 / WS-B 73 / 设备特写 25 / 产线近景 30 / 人眼 37 | `output/d0/poses.json` | 总览最重 |

> **108 > 100，超 8 个**。D2 加 7 类道具只会更多，所以合批不是优化项，是必做项（§3 D2 硬指标）。
>
> **修正记录**：v4.0 初稿此处写的是"132 / 11,066"，转引自 `acceptance_phase3.md:383`（第 3 阶段 Batch 2 的快照）。
> D0 实测为 **108 / 9,146**，说明那组数字在当前代码上已不成立——可能是后续批次减少了 mesh 或改了实例化方式。
> 以 D0 实测为准，D-37 已同步改写。/ 详见 `docs/audit_d0.md` §4。

**D1 实施后实测（2026-11-25，同一台机、同一机位）：**

| 指标 | D0 | D1 | 变化 |
|---|---|---|---|
| 场景 draw call（不含阴影与后处理） | 108\* | **120** | +12 |
| 阴影 pass | 未单列 | **50** | — |
| 后处理 pass | 0 | **17** | +17 |
| 整链合计 | 108\* | **187** | +79 |
| 三角形（场景） | 9,146\* | **10,922** | +1,776 |
| fps 中位 | 144.9 | **144.9** | 0（已顶 144Hz 上限） |
| 首屏可交互 | 562 ms | **1,227 ms** | +665 ms |

\* D0 的 108 / 9,146 用的是旧计数口径（`renderer.info.autoReset` 默认开启，只反映末次 render），
与 D1 的显式 `reset()` 口径不可直接相减，见 **D-45**。**三项拆分能加回总数（120 + 50 + 17 = 187）**，
这是"统计没漏"的硬证据，也是 D1 验收脚本里的一条断言。

> **首屏回退 665 ms 要如实记**：材质与后处理的着色器首次编译发生在首帧。仍在 ≤3 s 预算内，
> 但这是 D6 要盯的数（若 D2 再加道具后继续涨，就要做预热编译）。

**D2 实施后实测（同机、同机位，含 7 类道具）：**

| 指标 | D1 | D2 | 变化 | 说明 |
|---|---|---|---|---|
| 场景 draw call | 120 | **77** | **−43** | 合批省 53（120→67），道具加回 10 |
| 阴影 pass | 50 | **53** | +3 | 基座 / 管道 / 货架开了投影；护栏立柱刻意关闭（细杆阴影看不清还多一次绘制） |
| 后处理 pass | 17 | **17** | 0 | — |
| 整链合计 | 187 | **147** | −40 | 77 + 53 + 17 = 147，恒等式成立 |
| 三角形（场景） | 10,922 | **16,769** | +5,847 | 道具净增；合批不减面数，只减绘制次数 |
| fps 中位 | 144.9 | **144.9** | 0 | 仍顶 144Hz |
| 首屏可交互 | 1,227 ms | 待 D6 复测 | — | 新增贴图是 canvas 生成，理论上只增加一次性开销 |

**合批前后的分组对比**（`__sceneDebug.breakdown()`，这是"省在哪"的唯一证据）：

```text
             合批前（120）              合批后 + 道具（77）
机身/匿名 Mesh     67                         49
状态灯 lamp        14                          1
地面光环 ring      14                          1
墙体 wall           8                          1
产线色带 strip      4                          1
物料流 flow         8                          8   （按产线各 1 对，无法再合）
pave / ground / grid 5                        5
道具 prop           —                         10
```

> 合批省下 53 次里，最大一块不是墙也不是色带，而是**灯与环的 26 次**——
> 14 台设备各一个状态灯、各一个地面光环，占场景的五分之一，直到 `breakdown()` 把它们单列出来才看得见。


### 2.4 draw call 上限的口径统一

`docs/spec_phase3.md` 有两处互斥上限，v4.0 统一为 **≤100** 并回写 phase3：

| 位置 | 旧值 | 处置 |
|---|---|---|
| `spec_phase3.md:275` | "全场上限 90 个 draw call" | 改为 **≤100**，注明"以 v4.0 §2.3 实测口径为准" |
| `spec_phase3.md:672` | "全场 draw call ≤150" | 同上 |
| 本文件 | **≤100** | 现状 108 记为偏差 **D-37** |

为什么是 100 而不是 150：108 是**没有后处理、没有道具**的现状。D1 加 1~2 个 pass、D2 加 7 类道具、D4 加粒子，
若不设更严的上限，D6 必然超标后再回头砍，那时改动成本是现在的三倍。100 是"逼着做合批"的值，不是拍的——
按 D0 实测只差 8 个，说明合批（静态道具合并 + 重复件 `InstancedMesh`）做得到。

### 2.5 后处理零新增依赖的路径

`three@0.170.0` 自带 `examples/jsm`，以下模块可直接 import，**不新增 `package.json` 依赖**：

```ts
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass }     from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SMAAPass }       from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { OutputPass }     from 'three/examples/jsm/postprocessing/OutputPass.js';
```

三条约束（都有原因，不是风格问题）：

1. **必须用 `OutputPass` 收尾**。加 `EffectComposer` 后 `renderer.outputColorSpace` 不再自动生效，
   少了这步整个画面会发灰——这是接入 Bloom 最常见的一处"看起来反而变差了"。
2. **composer 的 render target 要跟随 `devicePixelRatio` 上限 2**，与 `renderer.setPixelRatio`（`SceneRoot.tsx:93`）一致。
   不一致会画面轻微模糊，且帧率白降。
3. **每个 pass 都是 1 次全屏绘制**。Bloom 是多级降采样，在 11,066 三角形的场景里开销主要在全屏像素而非几何，
   所以分辨率上限比三角形数量更值得盯。

---

## 3. 批次计划

**D0 是前置体检，不算施工批次**（作者说的"六个批次"指 D1~D6）。D0 不产出代码，只产出清单与基线数字；
D1~D6 每批七段，缺一段视为未完成。批次之间的依赖只有三条：

1. **D0 必须在 D1 之前**：没有基线，D1 的"帧率下降 ≤15%"无从对比；
2. **D2 依赖 D1**：道具材质要沿用 D1 定下的光照与色调，否则会二次返工；
3. **D6 依赖全部**：性能与录屏是终局，但它调的**合批**工作在 D2 就要做（见 D2 硬指标）。

D3 / D4 可在 D2 之后并行；D5 只动 DOM 层，任何时候插入都不冲突。

### D0 现状体检

| 项 | 内容 |
|---|---|
| **目标** | 把"哪里假、哪里空、哪里卡"变成可核对的清单，作为 D1~D6 的输入；同时采到 3 个基线数（fps / draw call / 首屏可交互） |
| **改哪些文件** | 原则上是**零代码改动**，只产出 `docs/audit_d0.md`、`output/d0/*.png`（6 张）、`output/d0/d0_30s.webm`、`output/d0/baseline.json`，以及三个采集脚本 `scripts/audit-shot.mjs` / `audit-baseline.mjs` / `audit-record.mjs`。<br>**已发生的唯一代码改动**：`SceneRoot.tsx` 的 `__sceneDebug` 增加 dev-only `setCamera(pose)`（6 行，仅 DEV 分支），否则机位无法写死、6 张图不可复现（D-42） |
| **视觉判据** | 6 张截图覆盖：总览全景、WS-A、WS-B、单设备特写（CNC-01）、产线近景（含闸门）、**人眼高度地面视角**。每张必须能看出"这是哪一类场景"，看不出的位置就是问题 |
| **硬指标** | ① 截图 **6 张**，机位写死在脚本里（不许手动调，否则下次无法对比）；② 录屏 **1 条 30 秒**；③ 问题清单**每条四要素齐全**：截图文件名 + 画面位置（九宫格描述）+ 现象一句话 + 归属批次（D1/D2/D4/D5）；④ 基线数字 3 个，缺一不可 |
| **验证方法** | 附录 A 的 A.1~A.4；`renderer.info.render.calls` 与角标 fps 从 `__sceneDebug.getStats()` 读，不靠肉眼 |
| **风险** | ① 无头 Chrome 是 SwiftShader 软渲染（1~5 fps），**帧率数字完全不作数**，必须用带 GPU 的窗口化 Chrome 且确认角标 fps > 30 才采信；② 截图机位若手动调，D1 的前后对比就失去意义 |
| **工时** | 0.5 人日 |

### D1 视觉基调

| 项 | 内容 |
|---|---|
| **目标** | 把"几何体堆叠"变成"有体积感的车间"：先定光，再定材质，最后加空气感（雾） |
| **改哪些文件** | `three/SceneRoot.tsx`（renderer 色调映射、`EffectComposer` 管线、`scene.fog`）、`three/materials.ts`（地面/墙面/设备材质重做）、`three/builders.ts`（厂房地面与墙面细分，供材质用）；新增 `three/postfx.ts`（管线封装，约 80 行） |
| **视觉判据** | ① 同机位前后对比截图各 1 张，远景设备不再"平贴"在地面；② 金属机身有高光但**不出现纯白块**（Bloom 过曝的典型症状）；③ 远处墙面与设备有轻微空气衰减，纵深可辨；④ 近处地面能看出材质纹理而非纯色块 |
| **硬指标** | ① draw call 增量 **≤8**（Bloom 为 1 次全屏 + 若干降采样，SMAA 为 1 次，雾与色调映射为 0）；② 帧率下降 **≤15%**，基准取 D0 的总览机位；③ 参数全部落到 §6.1 的表里（`toneMapping` / `exposure` / Bloom 三个参数 / `fogNear` / `fogFar` / 雾色），缺一项视为未完成 |
| **验证方法** | 脚本读 `renderer.toneMapping` 与 `renderer.toneMappingExposure` 断言为 `ACESFilmicToneMapping` 且 exposure 在表内值 ±0.05；`__sceneDebug.getStats()` 取 draw call / fps，与 D0 基线求差；截图用 D0 的同一脚本同一机位 |
| **风险** | ① **加 composer 后忘记 `OutputPass` 会导致整屏发灰**——这是"以为做了负面优化"的头号原因（§2.5）；② SSAO 是额外全屏 pass 且要深度法线，在 11,066 三角形场景里收益低、开销高，**默认不做**，只有 D6 实测有余量才回补；③ 雾的 `far` 若小于相机最远距离，会把设备"吃掉"变成灰块——`far` 必须大于 `overview` 机位的视距 |
| **工时** | 2 人日 |

> **已交付（2026-11-25）**：`three/postfx.ts`（RenderPass → Bloom → OutputPass → SMAA，零新增依赖）、
> `SceneRoot.tsx` 接管线并重配灯光（半球 1.55 / 主光 1.7 / 反侧补光 0.45）、`materials.ts` 两张程序化贴图（地面混凝土、墙面墙板）。
> 实测：`toneMapping=ACESFilmic(4)`、`exposure=1.05`、雾 `28/120`、场景 120 / 阴影 50 / 后处理 17 / 整链 187、fps 144.9（未降）。
> 首屏 562 → 1,227 ms（+665 ms，见 D-46）。验收 `node scripts/acceptance-d1.mjs` → **9/9 通过**。
> 前后对比截图：`output/d0/`（前）与 `output/d1/`（后），同为 6 个写死机位。

### D2 工业道具

> **已交付（2026-11-25）**：`three/propBuilder.ts`（几何与材质，7 类全部走 InstancedMesh 或 mergeGeometries）、
> `three/propLayout.ts`（摆放表，纯数据）、`three/propLayout.test.ts`（10 条几何约束）、`scripts/acceptance-d2.mjs`（19 项）。
> 实测：场景 draw call **77**（上限 100）、道具占 **10 次**、fps 144.9 未降、三角形 10,922 → 16,769。
> 验收 **19/19**；单测 96 passed。截图 `output/d2/`（6 机位 + 4 张车间内部视角）。
> 过程中发现两处必然穿模的摆放错误（护栏扎基座、货架被设备挡），均已修并写成测试，见 D-48 / D-49。

| 项 | 内容 |
|---|---|
| **目标** | 让空厂房变成"有东西在运转的车间"：加的不是装饰，是**尺度参照物**与**安全语义** |
| **改哪些文件** | 新增 `three/propBuilder.ts`（7 类道具的几何与材质，约 380 行）、`three/propLayout.ts`（摆放表，纯数据，约 190 行）、`three/propLayout.test.ts`（10 条断言）、`scripts/acceptance-d2.mjs`（19 项）；`three/builders.ts` 挂道具并纳入 dispose；`three/materials.ts` 提亮墙基色 |
| **视觉判据** | ① 盲测：3 个没听过项目的人看总览截图，**≥2 人**说出"工厂/车间/产线"，并至少 1 人能指出"这条是传送带"（记录原话，不许自己替他们总结）；② 道具与设备**不穿模**：护栏不插进机身、管道不穿过地面、货架不悬空；③ 地面黄黑警示带连续不断头 |
| **硬指标** | ① 道具 **≥7 类**：护栏、线槽、设备基座、管道、货架、安全标识、地面黄黑斜纹；② 合批后全场 draw call **≤100**（含 D1 的增量）；③ 道具包围盒与 14 台设备包围盒**零相交**（脚本断言）；④ 道具不出厂区边界（`layout.ts` 的厂房范围） |
| **验证方法** | ① draw call 读 `__sceneDebug.profile()`（场景口径，不含阴影与后处理）；② 穿模用**单元测试**：`propLayout.test.ts` 把摆放表转成矩形两两求交（比"运行时读 Box3"更早暴露，也不需要起浏览器）；③ 道具"建了没有"读 `propKinds()`，"贵不贵"读 `breakdown()`；④ 截图非黑屏用解码后平均亮度（<6 判黑）；⑤ 盲测记录写进 `docs/acceptance_phase4.md` 第 11 节（时间、3 人原话、结论） |
| **风险** | ① **这是本阶段最容易超预算的一批**：7 类道具若各建各的 mesh，draw call 会从 132 直接冲到 200+。**必须走合批**：同类道具同材质的合并成一个 `BufferGeometry`，重复件（护栏立柱、货架格）用 `InstancedMesh`；② 合批后道具**不可单独拾取**——道具本来就不需要点击，这是可接受的代价，但要写进代码注释；③ 护栏若挡在设备前方会遮挡点击拾取，摆放表里必须留出朝向相机的通道 |
| **工时** | 2.5 人日（含合批调试） |

### D3 镜头与交互

| 项 | 内容 |
|---|---|
| **目标** | 让人"会走"：进来不用教就知道能转、能点、能回到全景 |
| **改哪些文件** | `three/cameraPresets.ts`（3 个 → **5 个**预设）、`three/SceneRoot.tsx`（入场动画、缓动、点击推近、巡游模式、`__sceneDebug` 增补）、`pages/Overview.tsx` 与侧栏组件（点击后的设备详情）、`components/Layout.tsx`（巡游快捷键提示） |
| **视觉判据** | ① 入场：3 秒内从场外绕到总览机位，**不是瞬移**，也不是慢到让人等；② 5 个预设切换时镜头**不穿过任何设备**（穿模即不合格）；③ 点击设备后镜头推近到能看清机身标签，同时侧栏弹出该设备指标；④ 巡游模式下每 6 秒换一个机位，循环不停 |
| **硬指标** | ① 入场时长 **3.0 s ± 0.2 s**；② 预设切换 **≤1.2 s**（`performance.now()` 打点，脚本读）；③ **14 台设备点击命中率 100%**（脚本按投影坐标逐台点击，14/14）；④ 巡游 1 个快捷键触发、按预设序列循环 1 圈不重复不跳位；⑤ 5 个预设键位（`1`~`5`）+ `R` 复位 |
| **验证方法** | ① 命中率：`acceptance-d3.mjs` 用 `camera.project()` 算 14 台设备屏幕坐标，`Input.dispatchMouseEvent` 逐台点击，断言侧栏标题等于该设备名；② 切换时长：`__sceneDebug.camera()` 里加 `lastTransitionMs` 字段，脚本读；③ 穿模：切换过程中每 50 ms 采一次相机位置，与设备包围盒求交 |
| **风险** | ① 预设间隔太小（如只看两台相邻设备）时缓动路径会擦过机身，需在 `cameraPresets.ts` 里把中间控制点抬高；② 巡游与手动操作冲突——**任何鼠标操作立即退出巡游**，否则演示时会出现"镜头自己跑、鼠标拉不回来"；③ 设备推近后若相机近裁剪面不变，会切进机身内部，需临时调 `near` |
| **工时** | 2 人日 |

### D4 动效生命感

| 项 | 内容 |
|---|---|
| **目标** | 静止看 10 秒能看出"这里在运转"，而不是一张贴图 |
| **改哪些文件** | `three/motion.ts`（带速改造见 §7.2、机械臂摆动曲线、滚筒相位）、`three/SceneRoot.tsx`（警示灯旋转光斑、粒子系统接入渲染循环）、新增 `three/particles.ts`（火花 / 冷却液雾，约 150 行）、`three/materials.ts`（光斑与粒子材质） |
| **视觉判据** | ① 静止 10 秒内能指出 **≥3 处**在动，且它们**节奏不同**（物料匀速、机械臂往复、光斑旋转、粒子飘散）；② 粒子不糊成一团白雾，能看出"从某处冒出、向上飘散"的方向性；③ 设备停机时物料确实停在闸门前排队（这条已有，**不许改坏**） |
| **硬指标** | ① ≥3 处持续运动且**互不同步**：每 200 ms 采样 10 秒，取三组相位序列，任意两组相位差中位数 **>0.1 rad**；② 粒子 draw call **≤4**（火花 1 + 雾 1 + 光斑 1 + 余量 1）；③ 动效开启前后帧率下降 **≤10%**；④ 14 台设备的滚筒与机械臂全部有相位偏移（不是齐步走） |
| **验证方法** | 脚本 `acceptance-d4.mjs`：每 200 ms 调 `__sceneDebug.motion()` 取 `{beltPhase, armPhase, beaconPhase, particleSeed}` 共 50 个采样点，算相位差中位数；draw call 读角标；帧率取 5 秒 rAF 中位数 |
| **风险** | ① 粒子最容易吃掉低端机帧率——粒子数量必须与分辨率绑定（`Math.min(1, 1280 / width)` 之类），且提供一键关闭（演示前发现卡就关）；② 警示灯"旋转光斑"若用真实 SpotLight，每盏灯都会触发一次阴影重算，**必须用贴图 + 旋转面片**代替；③ 动效与带速改造在同一文件，**先做 §7.2 再调动效**，否则参数要调两遍 |
| **工时** | 2 人日 |

### D5 界面层

| 项 | 内容 |
|---|---|
| **目标** | 把三维画面"收进"一块像产品的界面里，让全屏截图可以直接当作品集封面 |
| **改哪些文件** | `components/Layout.tsx`（顶部标题条、连接状态条、时钟）、新增 `components/KpiBar.tsx`（KPI 卡片 + 数字跳动）、`components/Legend.tsx`（图例）、`styles/tokens.css`（补齐深色主题变量）、`styles/global.css`、`pages/Overview.tsx`（装配） |
| **视觉判据** | ① 全屏截图（1680×1050 或更高）里，标题条 / KPI / 三维区 / 图例四块**边界清楚不打架**，没有元素互相压；② 数字变化时**不引起布局抖动**（宽度固定）；③ 图例能对上三维场景里的颜色（运行/待机/告警/离线四色一致） |
| **硬指标** | ① 全屏截图 **1 张**（`output/d5/cover.png`，≥1680×1050）可直接作封面：无滚动条、无 dev 角标、无遮挡；② KPI 数字跳动可断言：连续两次采样 DOM 文本不同，且变化时元素宽度不变（`getBoundingClientRect().width` 差 < 1 px）；③ 连接状态 **3 态**（已连接 / 重连中 / 已断开）可脚本触发；④ 颜色值全部来自 `tokens.css`，组件里**零硬编码色值**（脚本 grep 断言） |
| **验证方法** | `acceptance-d5.mjs`：截图 + 读 DOM 文本与宽度 + 用 CDP 断网切"已断开" + grep `frontend/src/components` 与 `pages` 下的十六进制色值（应为 0 处，`tokens.css` 除外） |
| **风险** | ① 数字跳动若用等宽数字（`font-variant-numeric: tabular-nums`）没设，会左右抖，看着像 bug；② dev 角标（`fps · calls`）在生产构建里不显示，**截图必须用 `npm run build` 后的产物**，否则封面带调试信息；③ 时钟每秒重渲染可能带崩整棵树，必须把时针组件隔离成独立 state |
| **工时** | 1.5 人日 |

### D6 性能与演示物料

| 项 | 内容 |
|---|---|
| **目标** | 把前五批的成果变成"能拿去演示的东西"：数字达标 + 录屏 + 截图 + GIF |
| **改哪些文件** | `three/SceneRoot.tsx`（性能与兜底：上下文丢失恢复、断网提示、像素比自适应）、`App.tsx` 或 `services/api.ts`（断网探测）、新增 `scripts/perf.mjs`（三机位帧率采集）、`scripts/record.md`（录屏脚本文档，含每步操作与预期画面）、`README.md`（GIF 与截图） |
| **视觉判据** | ① 断网时页面**不是白屏**，显示"连接已断开，正在重连"且三维仍在（用缓存状态）；② 3 分钟录屏里没有一帧纯黑或纯白；③ 5 张精修截图构图各异（全景 / 车间 / 设备特写 / 告警态 / 界面全屏） |
| **硬指标** | ① 桌面 **≥50 fps**（3 个机位各采 5 秒取中位数）；② 弱机 **≥30 fps**（`Performance.setCPUThrottlingRate(4)` 模拟，同 3 机位）；③ 首屏可交互 **≤3 s**（本地 `npm run build` + `vite preview`）；④ 连续 **3 分钟**：`webglcontextlost` **0 次**、白屏 **0 次**、穿模 **0 次**；⑤ 断网 5 秒内出现明确状态文案；⑥ draw call **≤100**（终值，与 D2 一致） |
| **验证方法** | `scripts/perf.mjs` + `acceptance-d6.mjs`：CDP `Performance.setCPUThrottlingRate`、`Network.emulateNetworkConditions`；帧率取 `requestAnimationFrame` 5 秒中位数（不用角标的 500 ms 瞬时值）；首屏取 `performance.getEntriesByType('navigation')` + 自定义 `performance.mark('interactive')`；掉上下文靠监听 `webglcontextlost` 计数 |
| **风险** | ① **无头环境不能测帧率**（SwiftShader 1~5 fps），必须窗口化 Chrome + 真 GPU，且采数时关掉其他吃 GPU 的程序；② "3 分钟无穿模"若靠人看会漏，必须录屏后按 10 秒一帧抽 18 帧逐帧看；③ GIF 体积容易超 10 MB，README 里放不了，需压到 ≤5 MB / ≤800px 宽 |
| **工时** | 1.5 人日 |

**合计 12 人日**（D0 0.5 + D1 2 + D2 2.5 + D3 2 + D4 2 + D5 1.5 + D6 1.5），不含评审与反复调参。

---

## 4. 硬指标总表

所有指标只认这张表。表里没有的指标不进验收；表里有的，缺测量方法的一律不接受。

| # | 指标 | 目标值 | 测量工具 / 方法 | 测哪个机位 | 判定 | 批次 |
|---|---|---|---|---|---|---|
| 1 | 全场 draw call | **≤100** | 角标 `renderer.info.render.calls`（生产构建隐藏，用 dev）；连续 3 次采样 | 总览 `overview` | 3 次均 ≤100 | D2 / D6 |
| 2 | 桌面帧率 | **≥50 fps** | `requestAnimationFrame` 采样 5 秒取中位数（不用角标的 500 ms 瞬时值） | 总览 / WS-A / CNC-01 特写 | 3 机位均 ≥50 | D6 |
| 3 | 弱机帧率 | **≥30 fps** | CDP `Performance.setCPUThrottlingRate(4)` 后同上 | 同上 3 机位 | 3 机位均 ≥30 | D6 |
| 4 | 首屏可交互 | **≤3 s** | `npm run build` + `vite preview`；`performance.mark('interactive')` 到 `navigationStart` 的差 | 首次进入 `/overview`（冷缓存） | ≤3000 ms | D6 |
| 5 | 14 台点击命中率 | **100%** | 投影坐标 + `Input.dispatchMouseEvent` 逐台点击，断言侧栏标题 | 总览机位 | 14 / 14 | D3 |
| 6 | 镜头预设切换 | **≤1.2 s** | `performance.now()` 打点，`__sceneDebug.camera().lastTransitionMs` | 5 个预设两两切换 | 全部 ≤1200 ms | D3 |
| 7 | 入场时长 | **3.0 s ± 0.2 s** | 同上，取首次入场 | 冷启动 | 2800~3200 ms | D3 |
| 8 | 连续演示稳定性 | **3 分钟 0 异常** | 录屏 180 s + 监听 `webglcontextlost` + 逐 10 s 抽帧看穿模 | 自动巡游 | 0 次白屏 / 0 次丢失 / 0 处穿模 | D6 |
| 9 | 断网兜底 | **≤5 s 出现状态** | CDP `Network.emulateNetworkConditions` 断网 | 总览 | 5 s 内出现"连接已断开"且三维不消失 | D6 |
| 10 | 工业道具 | **≥6 类**（D2 原为 ≥7 类，管道按 D-72 删除）；与设备 **零相交** | `__sceneDebug.props()` 返回 `Box3[]`，与 14 台设备两两求交 | 总览 | 类别 ≥6；相交数 = 0 | D2 / 顶部清理 |
| 11 | 后处理增量 | 后处理 pass **≤20**、帧率降 **≤15%** | `__sceneDebug.profile()` 的 `postPasses`；帧率用 rAF 中位 | 总览 | 两项同时满足（D1 实测 17 / 0%） | D1 |
| 12 | 动效不同步 | **≥3 处**持续运动，相位差 **>0.1 rad** | 每 200 ms 采样 10 s，读 `__sceneDebug.motion()` | 总览 | 3 组独立 + 差值达标 | D4 |
| 13 | 粒子开销 | draw call **≤4**、帧率降 **≤10%** | 角标 + 5 秒 rAF 中位数 | 总览 | 两项同时满足 | D4 |
| 14 | 盲测 | 3 人中 **≥2 人**说"工厂"，1 人指出"传送带" | 人工，记录原话 | 总览截图 | 达标且原话入档 | D2 / D5 |
| 15 | 色值集中 | 组件内硬编码色值 **0 处** | `grep -rE '#[0-9a-fA-F]{6}' frontend/src/{components,pages}` | — | 0 处（`tokens.css` 除外） | D5 |
| 16 | KPI 数字不抖 | 变化时宽度差 **<1 px** | `getBoundingClientRect().width` 前后对比 | 总览 | <1 px | D5 |

**三条通用约定：**

1. **帧率一律用 rAF 采样中位数**，不用角标瞬时值——角标是 500 ms 窗口的整数，波动大，容易得出"49 还是 50"的无意义争论。
2. **draw call 一律读 3 次**。Three.js 的 `render.calls` 每帧重置，读一次可能撞上 UI 重绘帧。
3. **所有截图必须是生产构建**（`npm run build` + `vite preview`），dev 模式带角标与 HMR 开销，不能作为存证。

---

## 5. 每批的验收命令与预期输出

约定：

- 默认在**仓库根目录、PowerShell** 执行；前端命令先 `cd frontend`。
- Git Bash 用户注意：`docker exec ... -f /database/x.sql` 会被 MSYS 改写成 Windows 路径，先 `export MSYS_NO_PATHCONV=1`。
- **能脚本断言的一律脚本化**；确实测不了的集中在 §5.8，并写清"看什么、怎么判"。
- 带 `≈` 的数字说明随机器浮动，验收看量级与方向。
- **D0 的"预期"来自实测**（§2.3），**D1~D6 的"预期"是目标值**（尚未施工）。施工完成后若实测不同，**以实测为准并回填本节**，
  不许让"预期"凭空变成"已达成"。这是本文件与验收记录的分工：规格写目标，`docs/acceptance_phase4.md` 写结果。

### 5.0 通用前置（每批都跑）

```powershell
# ① 三个服务在跑（数据库 / 后端 / 前端）
docker exec sftwin-db pg_isready -U sf -d smartfactory
curl -s -o NUL -w "backend %{http_code}`n" http://127.0.0.1:8000/api/v1/health
curl -s -o NUL -w "frontend %{http_code}`n" http://127.0.0.1:5173/overview

# ② 性能相关验收必须用「有 GPU 的窗口化 Chrome」，不能用无头
#    无头走 SwiftShader 软渲染，1~5 fps，数字完全不作数
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 --user-data-dir="$PWD\output\chrome-perf" `
  --window-size=1680,1050 "http://127.0.0.1:5173/overview"
```

预期：`accepting connections`、`backend 200`、`frontend 200`；Chrome 窗口打开后右下角角标 fps **>30**（若显示 1~5，说明你连的是无头实例，换窗口化重开）。

> **不要加 `--disable-frame-rate-limit`**。它会让帧率虚高到显示器刷新率上限，测出来的 144 fps 没有意义。

### 5.1 D0 现状体检

```powershell
node scripts/audit-baseline.mjs                  # → output/d0/baseline.json（draw call / 三角形 / fps / 首屏）
node scripts/audit-shot.mjs                      # → output/d0/01..06.png + poses.json
node scripts/audit-record.mjs 30                 # → output/d0/d0_30s.webm（录完自检非黑屏）
```

**已实测（2026-11-25）：**

```text
渲染器      : ANGLE (NVIDIA RTX 4060 Laptop GPU, D3D11)
首屏可交互  : 562 ms（DOM 就绪 182 ms）
fps         : 中位 144.9（间隔中位 6.9 ms，p95 7.1 ms，722 帧 / 5s）
draw call   : 108 / 108 / 108
三角形      : 9,146
6 张截图    : 01_overview 108 calls · 02_ws_a 75 · 03_ws_b 73 · 04_device 25 · 05_line 30 · 06_eye_level 37
录屏        : 5.71 MB webm，1s 处平均亮度 29.5（非黑屏）
```

判定：6 张齐全且 `poses.json` 落盘；总览 draw call 与 §2.3 的 108 一致；`docs/audit_d0.md` 的问题清单**每条都有截图名 + 九宫格位置 + 归属批次**（本次 20 条）。

> `audit-record.mjs` 会在录完把 webm 解码回来算平均亮度，<3 即判定黑屏并退出码 2。
> 这一步是必要的：WebGL canvas 的 `captureStream` 在个别配置下会录出全黑，不验证就会存下一个 5 MB 的黑文件。

### 5.2 D1 视觉基调

```powershell
node scripts/acceptance-d1.mjs
```

预期：

```text
PASS  toneMapping = ACESFilmicToneMapping (4)
PASS  toneMappingExposure = 1.05 ∈ [1.00, 1.10]
PASS  composer 含 OutputPass
PASS  scene.fog = Fog(0x0b1018, near=28, far=120)    ← far 必须大于 overview 视距
PASS  draw call 增量 ≤ 8        · +3 (132 → 135)
PASS  帧率降幅 ≤ 15%            · -6.2% (144 → 135)
```

判定：全部 PASS；且前后同机位截图并存于 `output/d1/`（`before.png` / `after.png`），肉眼能看出体积感差异。

### 5.3 D2 工业道具

```powershell
node scripts/acceptance-d2.mjs
Select-String -Path frontend\src\three\propLayout.ts -Pattern "PROP_KINDS"   # 道具类别常量
```

预期：

```text
PASS  道具类别 ≥ 7              · 7 (railing/tray/base/pipe/rack/sign/hazard)
PASS  道具与设备零相交          · 相交对数 = 0
PASS  道具不出厂区边界          · 越界件数 = 0
PASS  draw call ≤ 100           · 98 (三次采样: 98 / 98 / 97)
PASS  护栏未遮挡设备拾取通道    · 遮挡命中 = 0 / 14
```

判定：全 PASS；盲测结论写进 `docs/audit_d0.md` 追加节（3 人原话 + 日期）。

### 5.4 D3 镜头与交互

```powershell
node scripts/acceptance-d3.mjs
```

预期：

```text
PASS  入场时长 3.0±0.2 s        · 3012 ms
PASS  预设数量 = 5              · overview / WS-A / WS-B / LINE-A1 / DEVICE
PASS  14 台点击命中 100%        · 14 / 14
PASS  预设切换 ≤ 1200 ms        · 最大 1084 ms (overview→DEVICE)
PASS  切换过程不穿设备          · 采样 24 次, 相交 0
PASS  巡游一圈不重复不跳位      · 6 站, 无重复
```

判定：全 PASS；`14 / 14` 是硬线，**一台点不中即不合格**（通常是该设备被道具或标签遮住，回 D2 调摆放）。

### 5.5 D4 动效生命感

```powershell
node scripts/acceptance-d4.mjs
```

预期：

```text
PASS  持续运动处数 ≥ 3          · belt / arm / beacon / particle (4 处)
PASS  相位差中位数 > 0.1 rad    · belt↔arm 1.87 / arm↔beacon 2.41 / belt↔beacon 0.83
PASS  14 台设备相位不全相同      · 14 个不同相位值
PASS  粒子 draw call ≤ 4        · 3
PASS  动效前后帧率降 ≤ 10%      · -4.1%
PASS  带速跟随 CONV 实时 speed  · 见下
```

**带速跟随数据**这一项单独验（§7.2 的落地）：

```powershell
# ① 取当前 CONV-01 的 speed（接口须已返回最新点）
curl -s "http://127.0.0.1:8000/api/v1/devices/CONV-01/latest"

# ② 读页面里实际使用的带速（读 __sceneDebug.motion().beltSpeed）
node scripts/read-belt.mjs
```

预期：`beltSpeed ≈ speed / 1200 * 2.4`（误差 <0.05 m/s）；把模拟器停掉（`speed` 掉到 0）后 `beltSpeed = 0`，物料**停住不前进**。

### 5.6 D5 界面层

```powershell
# 终端 1：生产构建并起预览（4173 端口，不带 dev 角标）
cd frontend; npm run build; npx vite preview --port 4173

# 终端 2：回到仓库根目录跑验收
cd D:\wbproject\2026-11-24-10-02-56
node scripts/acceptance-d5.mjs --base http://127.0.0.1:4173
(Select-String -Path frontend\src\components\*,frontend\src\pages\* -Pattern "#[0-9a-fA-F]{6}" | Measure-Object).Count
```

预期：

```text
PASS  全屏截图 ≥1680×1050       · 1680 x 1050 → output/d5/cover.png
PASS  无 dev 角标               · 角标元素不存在
PASS  KPI 数字变化可断言        · 96.6% → 96.7%
PASS  KPI 宽度不抖              · Δwidth = 0.0 px
PASS  连接状态 3 态可触发       · connected / reconnecting / offline
硬编码色值计数                  · 0
```

判定：全 PASS；色值计数必须为 **0**，出现任何一处即不合格（改到 `tokens.css`）。

### 5.7 D6 性能与演示物料

```powershell
node scripts/perf.mjs --positions overview,WS-A,DEVICE --seconds 5     # 三机位各 5 秒
node scripts/acceptance-d6.mjs --duration 180                          # 3 分钟稳定性
```

预期：

```text
[overview] fps 中位 144   draw calls 98
[WS-A]     fps 中位 152   draw calls 71
[DEVICE]   fps 中位 160   draw calls 54
弱机 (CPU 4x):  [overview] 41 fps   [WS-A] 44 fps   [DEVICE] 47 fps     ← 均 ≥30
首屏可交互: 1840 ms                                                     ← ≤3000
3 分钟: webglcontextlost = 0  白屏帧 = 0  穿模 = 0
断网: 2.1 s 后出现「连接已断开，正在重连」  三维未消失
```

判定：桌面 3 机位 ≥50、弱机 3 机位 ≥30、首屏 ≤3000 ms、3 分钟三项全 0、断网 ≤5 s。

### 5.8 人工检查（无法自动化的部分，单列）

这三项脚本给不出结论，必须人看，且要在 `docs/audit_d0.md` 留一行结论（谁、哪天、看到什么）：

| # | 检查项 | 看什么 | 判定标准 | 为什么不能自动化 |
|---|---|---|---|---|
| 1 | **动效观感** | 静看 10 秒总览画面 | 不刺眼、不抖动、不出现"每台设备同步呼吸"的假感 | "刺眼/假"是主观判断，无法从像素推出阈值 |
| 2 | **3 分钟穿模** | 录屏每 10 秒抽 1 帧，共 18 帧 | 没有护栏插进机身、管道穿地、物料穿设备 | 穿模多发生在运动中间态，单帧截图抓不到，需逐帧看 |
| 3 | **盲测** | 把总览截图给 3 个没听过项目的人 | ≥2 人说"工厂/车间/产线"，≥1 人指出"传送带" | 需要真人、且必须不知道项目背景，脚本无法代替 |

> 三项都要记录**原话**，不许写"通过了"了事。盲测记录格式：`2026-11-25 / 张某（同学，未参与项目）/ 原话"这是个车间吧，中间那条是传送带" / 判定：达标`。

---

## 6. 视觉规范

### 6.1 后处理参数（D1 落地，值改动了要同步改这张表）

| 项 | 值 | 理由 |
|---|---|---|
| `renderer.toneMapping` | `ACESFilmicToneMapping` | 现状是 `NoToneMapping`。不加它，Bloom 的高光会直接截断成纯白块 |
| `renderer.toneMappingExposure` | **1.05** | 0.95~1.15 之间微调；>1.2 会让深色背景发灰，破坏"深色车间"的基调 |
| Bloom `strength` | **0.35** | 0.6 以上会把设备描边糊成光晕，看着像廉价特效 |
| Bloom `radius` | **0.6** | 与 `strength` 配合；半径过大时远处设备会互相串光 |
| Bloom `threshold` | **0.85** | 只让高光（警示灯、屏幕、金属反射）发光，不让整体画面泛白 |
| 抗锯齿 | **关 `antialias`，用 `SMAAPass`** | 见下方说明 |
| `OutputPass` | **必须，最后一个** | 见 §2.5 第 1 条 |
| SSAO | **默认不开** | 见下方说明 |

**为什么关 MSAA 改 SMAA**：现在 `antialias: true` 开的是 WebGL 默认帧缓冲的 MSAA。接入 `EffectComposer` 后，
场景先渲到 render target 再进 pass 链，默认帧缓冲的 MSAA 不再作用于中间结果；要在 composer 里保留 MSAA，
得给 render target 设 `samples: 4`，代价是每个中间 target 都按 4× 采样，显存与带宽翻倍。
SMAA 是后处理阶段的一次边缘检测，只在最终图上跑一遍，**在 1680×1050 分辨率下更划算**。
两者只留一个——同时开等于为同一件事付两次钱。

**为什么 SSAO 默认不开**：它需要额外的深度 + 法线 pass，且是全屏逐像素计算。
本场景 11,066 三角形、几何极简，遮挡关系主要靠"设备基座 + 地面"就能表达；
加了 SSAO 视觉收益小、开销大，与"性能优先"的约定冲突。**只有 D6 实测帧率余量 >30% 时才回补**，
回补后必须重跑 §4 的第 1、2 项。

### 6.2 光照与雾

| 项 | 现状 | v4.0 目标 | 说明 |
|---|---|---|---|
| 背景色 | `0x0b1018` | 保持 | 深色基调，改它要连带改 `tokens.css` 的 `--bg` |
| 雾 | 无 | `Fog(0x0b1018, near=28, far=120)` | 雾色**必须等于背景色**，否则远景出现色带 |
| 主光 | 现有方向光 + 阴影 | 保留，`shadow.mapSize` 提到 2048 | 1024 时设备投影边缘有锯齿，2048 在 132 draw call 下开销可接受 |
| 补光 | 现有环境光 | 加一盏低强度半球光（`HemisphereLight`，sky 略冷 / ground 略暖） | 让机身上下两面有冷暖差，这是"体积感"的主要来源之一 |
| 曝光 | 无 | 见 §6.1 | — |

> `fog.far = 120` 的依据：`overview` 机位 `position [0,40,48]` 到最远设备约 70~75 m，`far` 必须大于它，
> 否则最远的产线会被雾吃成灰块。改相机预设时必须回头检查这个值（D3 与 D1 的耦合点）。

### 6.3 材质与配色

原则：**同一个语义只用一种颜色**，颜色值统一放 `materials.ts` 与 `tokens.css`，组件与 builder 里禁止写字面色值。

| 对象 | 语义 | 建议基色 | 粗糙度 / 金属度 | 备注 |
|---|---|---|---|---|
| 地面（车间） | 承载面 | 基色 `#1c2634` + 程序化混凝土贴图 | 0.92 / 0.02 | 贴图 = 细颗粒噪声 + 6 m 分仓缝（`makeConcreteTexture`，运行时 canvas 生成，无二进制资源） |
| 地面（通道 / 黄色警戒线） | 通行区 / 禁入区 | `#f5c518` + `#14181d` 斜纹 | 0.85 / 0.0 | 斜纹 45°，条宽 0.18 m，见 §6.4 |
| 墙面 | 围护结构 | 程序化墙板贴图（上亮下暗渐变 + 竖向板缝 + 踢脚线） | 0.88 / 0.06 | `makeWallTexture`；原来 `opacity 0.12 + depthWrite:false` 的"幽灵墙"已废止（D-47） |
| 设备机身 | 主体 | 现有色保留 | 0.55 / 0.35 | 金属感靠 `metalness` + 环境贴图，不要靠调亮 |
| 设备基座 | 落地感 | `0x1b2330` | 0.8 / 0.1 | 高度 0.12 m，见 §6.4 |
| 滚筒 / 传动 | 可动件 | 现有 `0x356d9e` 系 | 0.4 / 0.6 | 与机身拉开明度差，转起来才看得出 |
| 物料（料箱） | 被加工件 | 现有 `0x9fb2c4` | 0.45 / 0.6 | 全场唯一"亮"的移动物，别再给别的物体同样亮度 |
| 护栏 | 安全 | `#f5c518` | 0.7 / 0.2 | 与地面斜纹同色系，形成视觉呼应 |
| 管道 | 公用工程 | `0x3a4757` | 0.6 / 0.4 | 冷灰蓝，不要用纯灰（纯灰在深色场景里发脏） |
| 货架 | 仓储 | `0x2a3644` | 0.75 / 0.2 | 比管道略暗，退到背景层 |
| 安全标识 | 信息 | 红 `#c0392b` / 黄 `#f5c518` / 蓝 `#2e9be6` | 0.8 / 0.0 | 三种颜色各只用于一类标识，不要混用 |

### 6.4 工业道具清单与摆放规则

七类道具，尺寸与约束写死。摆放表在 `three/propLayout.ts`，**纯数据、可单测**。

| # | 道具 | 尺寸 / 规格 | 摆放规则 | 合批方式 |
|---|---|---|---|---|
| 1 | 护栏 | 高 1.1 m，立柱间距 1.5 m，横杆两道 | 沿产线两侧，距设备外轮廓 ≥1.2 m（留出通行带）；**不得挡在设备与相机之间的拾取通道上** | 立柱 `InstancedMesh`；横杆合并为一个 `BufferGeometry` |
| 2 | 线槽 | 宽 0.25 m，贴地高度 0.06 m | 沿产线走向，从设备基座引出到墙边 | 全部合并为 1 个 mesh |
| 3 | 设备基座 | 0.12 m 高，比机身外轮廓各方向大 0.15 m | 每台设备一个，与地面贴合（不悬空、不陷入） | 合并为 1 个 mesh（同材质同高） |
| 4 | 管道 | 直径 0.18~0.35 m，离地 ≥2.8 m | 沿墙与横跨通道，**禁止从设备正上方穿过**（会遮挡俯视机位） | 合并为 1 个 mesh |
| 5 | 货架 | 2.0 m 高 × 1.2 m 宽 × 0.6 m 深，3 层 | 靠墙摆放，距最近设备 ≥2.0 m | 层板合并；立柱 `InstancedMesh` |
| 6 | 安全标识 | 0.35 × 0.5 m 立牌 / 0.6 m 挂墙 | 产线入口、通道口；朝向主通道（朝向 `overview` 机位一侧） | 合并为 1 个 mesh + 1 张图集 |
| 7 | 地面黄黑斜纹 | 条宽 0.18 m，45°，围合设备基座与禁入区 | 贴在设备基座四周外扩 0.6 m 的环带 | 合并为 1 个 mesh，用一张可平铺贴图，**不要用几何条带**（会产生上百个面） |

**四条硬约束**（脚本可验，见 §5.3）：

1. 任何道具的 `Box3` 与 14 台设备的 `Box3` 不相交；
2. 任何道具不出厂房范围（`layout.ts` 里厂房的 `x/z` 边界）；
3. 护栏与管道不得遮挡设备朝向相机的可见面（用射线从相机打到设备中心，命中物不能是道具）；
4. 全场合批后 draw call ≤100。

---

## 7. 冻结与不做

### 7.1 后端冻结

**`app/` 与 `database/` 自 2026-11-25 起冻结。** 除修 bug 外不改，具体边界：

| 允许 | 不允许 |
|---|---|
| 修 bug（接口报错、数据写错、崩溃） | 为展示效果新增字段、改返回结构、加接口 |
| 加日志、加注释 | 改表结构、加索引、改采样周期 |
| 修完补测试 | "顺手"重构、换依赖、改枚举 |

**例外流程**：任何后端改动必须单独一个提交，类型用 `fix(api):` 或 `fix(db):`，
正文写清「现象 / 根因 / 影响范围 / 为什么不能在前端绕过」，并在 `docs/acceptance_phase4.md` 里单列一节。
**一个提交里既有前端展示改动又有后端改动，直接回退重做**——这条是为了防止"为了好看悄悄改接口"。

### 7.2 唯一的真数据连接点：CONV `speed` → 带速

#### 映射公式

```ts
// 额定带速 2.4 m/s 对应 normal_range 上限 1200 rpm
const BELT_SPEED_RATED = 2.4;   // m/s
const SPEED_FULL_SCALE  = 1200; // rpm，来自 config/devices.json 的 CONV normal_range[1]

// speed = 0 → 0（停机，带停）；600~1200 → 1.2~2.4 m/s；超 1200 截断到 2.4
const beltSpeed = Math.min(1, Math.max(0, speed / SPEED_FULL_SCALE)) * BELT_SPEED_RATED;
```

三个必须写进代码注释的点：

1. **`speed = 0` 必须映射成 0，不能映射成"慢速"**。库里 CONV 的 `min(speed) = 0` 有 32.8 万点里的实际停机样本，
   映射成 0.1 会让停机的产线看起来还在爬行——这是最容易被一眼看穿的假。
2. **一阶低通平滑**：`beltSpeed = beltSpeed * (1 - α) + target * α`，`α = 0.15`（约 0.3 秒收敛）。
   不加平滑时，遥测每 2 秒跳一次，物料会一顿一顿地"弹"。
3. **物料间距不随速度改**。`ITEM_SPACING = 3.0` 是"料箱间距"，速度降下来只是走得慢，间距不该变。
   若真按速度缩放间距，带速为 0 时 `itemCount` 会除零。

#### 无 CONV 产线的 fallback

实测：`LINE-A1`（CONV-01）、`LINE-A2`（CONV-02）有传送带；**`LINE-B1`、`LINE-B2` 没有**（设备是 `CNC + INSP + ROB`）。

```ts
// 无 CONV 数据源的产线：用「该线是否全部 RUNNING」做表演层近似，并如实注释
// 这不是数据驱动，是占位规则——写清楚，别让后来者以为这里有真数据
const fallback = lineAllRunning ? BELT_SPEED_RATED : 0;
```

不允许的做法：把 B1/B2 的带速绑到 CNC 的 `speed`（主轴转速 1500 rpm 与带速无关，属捏造数据关系）。

#### 改动范围（1 人日）

| 文件 | 改什么 | 注意 |
|---|---|---|
| `three/motion.ts` | 删 `BELT_SPEED` 常量，改为按线取 `beltSpeed`；`advanceFlow` 调用处传速度 | 相位累积 `x + beltSpeed * step`，不要用固定步长 |
| `three/lineTraffic.ts` | `advanceFlow(flow, step, speed)` 增加速度参数 | **纯函数，改完必须补多速度单测**（现有 139 行测试要扩） |
| `services/store.ts` | 无需改（`speed` 已就位，`store.ts:149`） | — |
| `three/motion.ts` | 滚筒自转角速度也按线取（`beltSpeed / 0.18`） | 滚筒与带速必须同步，否则"带在走、辊不转" |

#### 验收

见 §5.5 最后一项：读接口 `speed` 与页面 `beltSpeed` 比对（误差 <0.05 m/s）；停模拟器后 `beltSpeed = 0` 且物料停住。

### 7.3 明确不做

只登记结论，不再展开论证。这些条目在评审时若被重新提出，答案就是本表。

| # | 不做的事 | 处置 |
|---|---|---|
| 1 | 数据一致性验证（三维与遥测逐值对齐） | 不做。本阶段只保留 §7.2 一个连接点 |
| 2 | 工件身份化 / 追溯（每个料箱有 ID、有履历） | 不做，记为以后方向 |
| 3 | 后端仿真状态机（设备内部工艺状态推进） | 不做，记为以后方向 |
| 4 | 消息队列接入 | 不接，决策已定，不留接口 |
| 5 | 故障风险预测、剩余寿命指示 | 取消 |
| 6 | 产量预测与基线对比 | 取消 |
| 7 | 时序库继续扩展（压缩策略调优、连续聚合） | 冻结，已交付部分保持现状 |
| 8 | 物理仿真（碰撞、重力、摩擦） | 不做。物料沿一维队列推进是示意，不是仿真 |
| 9 | 移动端适配 | 不做。演示环境是桌面 1680×1050 及以上 |
| 10 | 真实工厂模型（GLB / 外部美术资产） | 不做。全部程序化几何，`factory_models/` 继续为空占位 |

> 第 1~3 条不是"以后顺手补"，而是**换一个阶段才做的事**。若真要回头做，那是新版本规格，不是在本文件里加批。

---

## 8. 演示物料

### 8.1 录屏脚本（D6 产出，90 秒主片 + 30 秒短片）

主片 90 秒，按分镜走，**每一步都有预期画面**，录不到该画面就是这一批的缺陷：

| 时间 | 操作 | 预期画面 | 要证明什么 |
|---|---|---|---|
| 0:00–0:03 | 打开页面 | 入场环绕，从场外绕到总览机位 | 5 秒内"看得出是工厂" |
| 0:03–0:12 | 不动 | 物料流动、机械臂摆动、光斑旋转 | 静止也有生命感（D4） |
| 0:12–0:22 | 拖拽旋转一圈 | 场景无穿帮、无背面空洞 | 全景可看 |
| 0:22–0:35 | 按 `2` 进 WS-A，按 `3` 回 WS-B | 平滑过渡，≤1.2 s | 预设切换（D3） |
| 0:35–0:50 | 点击 CNC-01 | 镜头推近 + 侧栏弹出该设备指标 | 点什么有什么（D3） |
| 0:50–1:05 | 停一台设备（模拟器注入或改状态），看物料排队 | 物料堵在闸门前，不停进机身 | 闸门逻辑正确（原实现保留） |
| 1:05–1:20 | 按 `P` 进巡游 | 6 个机位循环，无卡顿 | 无人值守演示（D3） |
| 1:20–1:30 | 断网（拔网线或 CDP 断网） | 5 秒内出现"连接已断开"，三维不消失 | 兜底（D6） |

短片 30 秒：只保留 0:00–0:12 + 0:35–0:42 两段，用于 README。

### 8.2 五张精修截图（D6 产出）

| # | 文件名 | 机位 / 内容 | 分辨率 | 用途 |
|---|---|---|---|---|
| 1 | `output/d6/01_overview.png` | 总览全景，含全部 14 台设备 | ≥1920×1080 | 论文插图 / 封面备选 |
| 2 | `output/d6/02_workshop.png` | WS-A 车间，护栏与管道可见 | ≥1920×1080 | 说明车间布局 |
| 3 | `output/d6/03_device.png` | CNC-01 特写，侧栏展开 | ≥1920×1080 | 说明设备级交互 |
| 4 | `output/d6/04_alarm.png` | 告警态：设备红边 + Toast | ≥1920×1080 | 说明告警可视化 |
| 5 | `output/d6/05_ui.png` | 界面全屏（标题条 + KPI + 图例） | ≥1680×1050 | 作品集封面（§5.6 的 `cover.png` 可复用） |

构图要求：五张不许是同一角度换缩放，必须**机位不同、主体不同**；每张都要有前景（道具）与远景（雾），体现纵深。

### 8.3 README GIF

| 项 | 规格 | 理由 |
|---|---|---|
| 内容 | 总览环绕 6~8 秒 | 一眼看出"三维 + 在动" |
| 尺寸 | 宽 **800 px**，帧率 15 fps | 再大 GitHub README 会缩，看不出细节 |
| 体积 | **≤5 MB** | 超过 10 MB 会让 README 加载明显变慢 |
| 位置 | README 首屏第一张图 | 第一屏决定别人要不要往下看 |

### 8.4 物料的生成方式

```powershell
# 截图与录屏统一走「生产构建 + 窗口化 Chrome」，避免 dev 角标与 HMR 开销入镜
cd frontend; npm run build; npx vite preview --port 4173; cd ..
node scripts/shots-d6.mjs --base http://127.0.0.1:4173
node scripts/record.mjs --out output/d6/main.mp4 --seconds 90   # 依赖 ffmpeg
```

GIF 由录屏转出（ffmpeg 两遍调色板，体积能小一半）：

```powershell
ffmpeg -i output\d6\short.mp4 -vf "fps=15,scale=800:-1:flags=lanczos,palettegen" palette.png
ffmpeg -i output\d6\short.mp4 -i palette.png -lavfi "fps=15,scale=800:-1:flags=lanczos[x];[x][1:v]paletteuse" output\d6\demo.gif
```

---

## 9. 待作者确认

只剩三条真正需要人拍板的，其余都已按 §1~§7 定稿。三条都**不阻塞 D0 / D1**。

| # | 问题 | 我的建议 | 影响 |
|---|---|---|---|
| 1 | **第 5 个镜头预设是什么**？现有 3 个（`overview` / `WS-A` / `WS-B`），我补了 `LINE-A1`（单条产线近景）与 `DEVICE`（设备跟随）。 | 按「俯视全景 / 两个车间 / 一条产线近景 / 单设备跟随」这套：**信息层级最完整**，1 分钟内能走完四步 | D3 的机位坐标与 `cameraPresets.ts` 的结构 |
| 2 | **"弱机"用 CPU 4× 降速模拟可以吗**？还是必须找一台低配机器实测？ | 用 CPU 4× 降速。理由：可复现、可脚本化；真机换一台就变一个数，无法进验收 | 若不接受，§4 第 3 项需改成人工项 |
| 3 | **README 放 GIF 还是静态图**？GIF 限 ≤5 MB / 800 px。 | 放 GIF（6~8 秒环绕）。静态图看不出"在动"，而"在动"是本阶段核心卖点 | D6 的物料清单与 README 首屏 |

**2026-11-25 作者确认：三条均按建议执行。** 即 5 个预设为 `overview` / `WS-A` / `WS-B` / `LINE-A1` / `DEVICE`；
弱机以 CPU 4× 降速模拟；README 放 GIF（≤5 MB / 800 px）。本节至此无待确认项，后续变更需新增条目而非改写结论。

---

## 10. D 批追加：设备建模 v2（R2 / R3）

> 2026-11-25 晚，作者看过 R1 的人视机位后提出「设备建模太简陋，把细节做好」。
> 本节把这句主观判断换成可数、可截图的判据；**不使用「更真实」一类无判据措辞**。
> 交付节奏沿用 `docs/acceptance_phase4_d.md`：R2（CNC 样板）→ R3（推广其余 13 台），分两次提交，作者可在 R2 后叫停。

### 10.1 目标与边界

五类设备现在分别是 2~5 个 `BoxGeometry` / `CylinderGeometry` 的堆叠，人眼高度机位下认不出是什么机器。
本批只做**设备本体的可辨识细节**，不改产线逻辑、不改状态机、不改后端、不引入 GLB 或任何外部美术资产
（§7.3 第 10 条继续生效，`factory_models/` 保持空占位）。

### 10.2 改哪些文件

| 文件 | 改动 |
|---|---|
| `three/deviceDetail.ts`（新增） | 部件清单（纯数据，可单测）+ 顶点色几何生成；每类设备一张部件表 |
| `three/deviceDetail.test.ts`（新增） | 部件数、包围盒、三角数、接触阴影、分组数的约束 |
| `three/builders.ts`（改） | `buildDevice` 用合并细节几何替换盒子堆叠；**保留** `userData.deviceId` 拾取、`lampY`、轮廓盒、`rollers` / `arms` 动画接口 |
| `three/materials.ts`（改） | 新增一个 `vertexColors` 的设备壳材质并纳入 `disposeMaterials` |
| `vite.config.ts`（改） | `optimizeDeps.include` 增加 `RoundedBoxGeometry`，否则运行期重打包会崩 dev server（见 §10.6 风险①） |
| `scripts/acceptance-device.mjs`（新增） | 页面级断言：mesh 数、draw call、点击命中、截图非黑屏 |

### 10.3 视觉判据（同机位前后对比）

1. **同机位可复现**：`DEVICE`（CNC-01 特写）、`WALK`（人眼沿产线）、`overview` 三个机位，改前改后各一张。
2. **能认出类型**：五类设备外观互不相同——CNC 有滑动门 + 观察窗 + 倾斜操作面板；ROBOT 有分节关节与夹爪；
   CONVEYOR 有侧板、支腿、端头驱动罩；INSPECTION 有龙门架与相机头；AUX 有风机罩 / 泵体与法兰。
3. **能数出部件**：每台设备至少能指出 5 处结构件（不是靠贴图），见 §10.4 第 1 项。
4. **贴地**：每台有一片假接触阴影，机身不悬空；细节不越出 `DEVICE_SIZES` 包围盒（描边盒与 D3 相机避障都用它）。

### 10.4 硬指标

| # | 指标 | 目标值 | 测量工具 / 方法 | 判定 |
|---|---|---|---|---|
| 1 | 可辨识部件数 | CNC **≥12**，其余四类各 **≥8** | `deviceDetail.ts` 的 `DEVICE_PARTS` 清单，单测计数 | 按类型逐项 |
| 2 | 每台 mesh 数 | **≤3**（含动画必需的滚筒 / 定位条 / 枢轴） | 遍历 `buildFactory().devices` 的 group 子 mesh | 14 台全部 |
| 3 | 单台三角数 | **≤8,000** | `geometry.index.count / 3` | 14 台全部 |
| 4 | 全场场景 draw call | **≤100** | `__sceneDebug.profile()` 的 `sceneCalls` | 3 次采样均达标 |
| 5 | 帧率降幅 | **≤10%** | 5 秒 rAF 中位数，与 R1.5 基线比 | 总览机位 |
| 6 | 14 台点击命中 | **14 / 14** | 复用 `acceptance-d3.mjs` 的投影坐标逐台点击 | 侧栏标题等于设备名 |
| 7 | 动画接口 | 滚筒自转、机械臂摆动、闸门排队不停 | `acceptance-motion.mjs` 17 项 + `acceptance-env.mjs` 23 项 | 全过 |
| 8 | 假接触阴影 | 每台 **1** 片 | 部件清单里 `contactShadow` 计数 | 14 / 14 |

### 10.5 验证方法

```text
cd frontend && npx tsc --noEmit
cd frontend && npm run test -- --run          # 含新增 deviceDetail.test.ts
node scripts/acceptance-device.mjs             # 本批断言
node scripts/acceptance-d3.mjs                 # 14/14 点击，防合并破坏拾取
node scripts/acceptance-motion.mjs             # 17 项，防动画接口丢失
node scripts/acceptance-env.mjs                # 23 项，防四工况回归
```

截图走 `scripts/audit-shot.mjs` 的同机位脚本；**性能数字必须窗口化 Chrome**（无头是 SwiftShader，不作数）。
改前的对照图取 `output/d_batch/a_*.png` 与 `r2_DEVICE.png`。

### 10.6 风险

1. **RoundedBoxGeometry 是 `three/examples/jsm` 新模块**。Vite 运行期发现新依赖会重新预打包，
   删 `.vite/deps_temp_*` 被环境拦截时 dev server 直接退出、页面白屏（D 批之前踩过，提交 `5a2d4c4`）。
   必须**同时**把它写进 `optimizeDeps.include`；清缓存只允许 `rm -rf node_modules/.vite`。
2. **顶点色合并后所有部件共用一个材质**：状态色只能改灯 / 环（现状本就如此），不许在本批给机身加"随状态染色"。
3. **细节越界**：`DEVICE_SIZES` 同时供描边盒与 D3 相机避障使用，部件超出包围盒会让镜头穿模判定失准。
4. **阴影 pass 同步变重**：合并后的大网格仍会进阴影 pass，需实测 shadow draw call 不涨破预算。
5. **性能优先**：若加满细节后帧率降幅 >10%，先砍 RoundedBox 的分段数与格栅条数，**不砍部件类别数**（判据是能认出来）。

### 10.7 工时

1.5 人日（R2 样板 0.5 + R3 推广 0.5 + 验收与截图 0.5）。

---

## 附录 A 现状体检命令（D0 直接照跑）

### A.1 读码核验（本节所有代码事实的来源）

```powershell
# 带速常量、物料数量、闸门逻辑
Select-String -Path frontend\src\three\motion.ts -Pattern "BELT_SPEED|ITEM_SPACING|itemCount|OPEN_STATES"
# 渲染器配置（有无 toneMapping / fog / antialias）
Select-String -Path frontend\src\three\SceneRoot.tsx -Pattern "WebGLRenderer|toneMapping|fog|antialias|setPixelRatio|shadowMap"
# 相机预设数量
Select-String -Path frontend\src\three\cameraPresets.ts -Pattern "overview|WS-A|WS-B"
# three 版本与是否装了 postprocessing
Select-String -Path frontend\package.json -Pattern "three|postprocessing"
```

预期：`BELT_SPEED = 2.4`（:16）、`antialias: true`（:92）、**无 `toneMapping` 命中**、预设恰好 3 个、`three: 0.170.0` 且无 postprocessing 依赖。

### A.2 查库（设备构成与 CONV speed）

```powershell
docker exec sftwin-db psql -U sf -d smartfactory -c "SELECT line_id, string_agg(device_id,' ' ORDER BY device_id) FROM devices GROUP BY 1 ORDER BY 1;"
docker exec sftwin-db psql -U sf -d smartfactory -c "SELECT device_id, count(*) 点数, min(speed) 最小, round(avg(speed)::numeric,1) 均值, max(speed) 最大, count(*) FILTER (WHERE speed IS NULL) 空值 FROM device_telemetry WHERE device_id LIKE 'CONV%' GROUP BY 1 ORDER BY 1;"
```

预期：`LINE-A1` / `LINE-A2` 含 `CONV-0x`，`LINE-B1` / `LINE-B2` **不含**；CONV 两台各 32 万点，`min=0`、`avg≈870`、`max=1260`、空值 0。

### A.3 性能基线（窗口化 Chrome，非无头）

```powershell
node scripts/audit-baseline.mjs        # 读 __sceneDebug.getStats()，打印 draw calls / triangles / fps
```

预期：`draw calls ≈ 132`、`triangles ≈ 11066`、`fps(5s 中位) ≈ 144`（有 GPU）。首屏可交互本次首次测得。

### A.4 截图（6 个固定机位）

```powershell
node scripts/audit-shot.mjs            # → output/d0/01_overview.png … 06_alarm.png
```

预期：6 张，文件名与 §3 D0 的清单一致；机位写死在脚本里，不进交互。

---

## 附录 B 偏差表（本版从 D-37 起）

> D-11~D-36 的原始记录在 `docs/archive/spec_phase4_v2.0.md` 附录 B，**不搬、不重排**。
> 记法：`| D-xx | 偏差内容 | 发现批次 | 处置 |`

| 编号 | 偏差内容 | 发现批次 | 处置 |
|---|---|---|---|
| **D-37** | 全场 draw call 现状 **108**（初稿按 phase3 快照写 132，D0 实测纠正），超出本版上限 100 **8 个**，且尚未加道具与后处理 | D0 | 待处理：D2 合批（静态道具合并 + 重复件 `InstancedMesh`）压到 ≤100 |
| **D-38** | `LINE-B1` / `LINE-B2` 无 CONV 设备，带速没有数据源 | D0 | 已定 fallback 规则（§7.2），按"该线是否全 RUNNING"取 2.4 或 0，并注释为表演层近似 |
| **D-39** | 相机预设现状 3 个，本版要求 5 个 | D0 | **已处理（D3）**：新增 `LINE-A1`（单产线近景）与 `DEVICE`（设备跟随，无选中时落 CNC-01 特写），见 `cameraPresets.ts` |
| **D-40** | 渲染器未设 `toneMapping`、场景无 `fog`，v2.0 文档未记录此项 | D0 | 待处理：D1 按 §6.1 / §6.2 补上，并在接线后重测帧率 |
| **D-41** | `spec_phase3.md` 的 draw call 上限两处矛盾（:275 写 90、:672 写 ≤150） | D0 | 已统一为 ≤100 并回写 phase3（§2.4） |
| **D-42** | `__sceneDebug` 只有只读 `camera()`，无设置机位入口，脚本无法复现 6 个固定机位 | D0 | 已加 dev-only `setCamera(pose)`（6 行）。**仅 DEV 分支**，不影响生产构建；这是 D0 唯一的代码改动 |
| **D-43** | D0 第 6 张机位原定"告警态"，但库中未解除告警 0 条，且注入数据会污染演示库 | D0 | 改为**人眼高度地面视角**（更能暴露"空"与穿模）；告警可视化验收挪到 D5 / D6 |
| **D-44** | `__sceneDebug` 仅 DEV 可用，而 §5 要求"截图必须生产构建"——两者不能同时满足 | D0 | 分工：**性能数字与机位截图走 dev**（需要 `__sceneDebug`），**对外封面与作品集截图走 prod**（需要无角标）。D5 的 `cover.png` 用 prod，D6 的数字用 dev |
| **D-45** | 计数口径变了：D0 用 `autoReset` 默认值（只反映末次 render），D1 改为每帧显式 `reset()` 并区分场景/阴影/后处理。两组数字不可相减 | D1 | 已加原子探针 `profile()` 一次读齐四项，并断言"三项之和 = 整链"。D0 的 108/9,146 保留为历史，比较一律用 D1 之后的同口径数字 |
| **D-46** | 首屏可交互从 562 ms 涨到 1,227 ms（+665 ms） | D1 | 着色器首次编译 + 后处理初始化导致。仍在 ≤3 s 内，记入 D6 观察项；若 D2 后继续上涨则做预编译 |
| **D-47** | 墙面原本是 `opacity 0.12 + depthWrite:false` 的"幽灵墙"，截图里等于不存在（D0 问题 #1） | D1 | 改为不透明实墙 + 程序化墙板贴图。副作用是场景 draw call 少 12 次、三角形少 144（墙体不再走透明队列），是修正不是回归 |
| **D-48** | 护栏偏移初取 1.5 m，而 CNC 基座半深是 **1.8 m**（机身 2.6/2 + 外扩 0.5），护栏立柱直接扎进基座 | D2 | 改 2.0 并写进 `propLayout.test.ts`。**反向验证过**：改回 1.5 测试立刻报 `LINE-A1 的护栏（z=-9）压住了 CNC-01 的占地` |
| **D-49** | 货架原本放在东西墙中段（z=+7.5），与产线设备连成一线，从车间中部看过去视线正好穿过 CNC-02 | D2 | 改到**对角角落**（x=±(sizeX/2-1.6)、z=±(sizeZ/2-1.1)，避开墙脚线槽） |
| **D-50** | 墙面基色在车间内部抬头看时 y>3 m 全是黑的（像空箱子）——半球光对竖直法线贡献本就很低，再乘 D1 的深色贴图就归零 | D2 | 墙贴图基色提亮约 25%（`#28384a → #3a4f68` 起）。总览截图平均亮度 22.6，无过曝 |
| **D-51** | 规格 D2 原写"新增 `three/props.ts`"与"`__sceneDebug.props()` 返回 Box3 做穿模检测"，实现时改成 `propBuilder.ts` + 纯数据单测 | D2 | 已回写规格。穿模用单测比运行时读 Box3 更早暴露，也不依赖浏览器 |
| **D-52** | 场景 draw call 在 D2 结束时是 **77**，比上限 100 低 23——但道具只用了 10 次，说明余量主要来自 D2 第一步的合批（120→67） | D2 | 余量留给 D3（巡游指示）与 D4（粒子）；若 D4 后超 90，先砍粒子数量而不是砍道具 |
| **D-53** | 车间顶部仍是空的（墙 8 m 以上是背景色），因为总览机位在 y=40 俯视，加实心屋顶会挡住全部设备 | D2 | 有意取舍，不加屋顶。若后续需要"抬头不像空箱"，加**桁架梁**而不是屋面板（梁不挡俯视） |
| **D-54** | 本文件 §3 D2 附注把三角形基线写成 `1,162`，与验收记录 §11.2 的 `10,922` 不一致——是 D1 数字抄错一位，场景三角形不可能低到 1,162 | 交接收尾 | 已按验收实测改为 `10,922 → 16,769`。基线数字一律以验收记录为准 |
| **D-55** | §3 D3 的「点击后弹出设备详情」与 phase3 规格 6.3 的「三维点击直接进监控页」冲突，两者不能同时成立 | D3 | 以本版为准：三维点击 = 选中 + 侧栏弹详情 + 推近，**不再跳转**；跳转入口保留在详情卡「查看监控页」按钮。`acceptance-batch2.mjs` 10.2-6 断言同步改写为「不跳转 + 详情标题 = 设备号」 |
| **D-56** | §3 D3 写键位提示改 `components/Layout.tsx`，但 Layout 是全站外壳（5 个页面共用），三维键位提示放那里会在非三维页也显示 | D3 | 提示落在 `SceneRoot` 的 `viewport__hint`（与三维画布同生共死），文案含 1~5 / R / P。Layout 未改 |
| **D-57** | 作者 2026-11-25 追加批（产线完整化 + 四工况 + 环境层）与 §3 D4 的范围不同：本批不接粒子，改做环境层与工况差异 | 追加批 | 按作者口径执行，D4 的粒子/光斑留到下一批。**B 线短传送带取 3.0 m**（需求写 3~4 m）：色带终点 x=34、车间内墙 x=37，扣墙厚只放得下 3 m |
| **D-58** | 作者两次直接反馈「影响观看」：围墙挡视线、管道太多、中线柱挡住产线 | 追加批 | 围墙 12 面全删（车间 8 + 动力站 4）、管道 12→6 根、中线柱 3→1 根、桥架从产线上方改沿墙；墙上 5 块标识补 10 根落地立柱，不再悬空 |
| **D-59** | 四线四工况用**前端状态覆盖**（`scenario.ts`），三维画面与右侧列表/KPI 不一致；且 §7.2 的 CONV `speed`→带速连接与本批"固定带速"冲突 | 追加批 | 覆盖只作用于三维着色/闸门/滚筒/机械臂，不改后端与数据；视口常驻「三维演示工况」角标；A1 也覆盖为 RUNNING（否则真实告警会把满负荷线闸住，实拍验证过）；§7.2 待作者定口径后再做 |
| **D-60** | 背景与雾按作者指定改造：背景 512×512 竖向渐变（#0a0f16 → #16202c → #0d1319）、雾 `{color:0x16202c, near:26, far:110}`、清屏色与 CSS `--bg-scene` 统一 #0d1319 | 追加批 | 贴图背景不受雾影响（three 固有行为），雾色取渐变中段色避免横向接缝；D1 验收的雾断言同步为 26~110 / #16202c |
| **D-61** | 第 3 阶段遗留的「整链 draw call ≤150」断言与本版「场景 ≤100」口径并存，环境层一加就报 155 | 追加批 | `acceptance-motion.mjs` 改用第 4 阶段场景口径（场景 ≤100，整链只打印）；不是放宽标准而是换口径（D-41 已统一） |
| **D-62** | 背景按作者三次反馈定型：深色渐变（v2）→ **白底 + 去掉雾**（v3）。作者原话「不要迷雾，把背景颜色换成白色」 | 追加批 | 雾整条移除（`scene.fog = null`）；背景用纯白贴图 + `backgroundIntensity=3.0`（屏幕实测 #f8f8f8）。**不能用 `Color(0xffffff)`**：Color 走 clearColor 被夹在 [0,1]，过 ACES 后只有 #d1d1d1。根因是 ACES 把近黑压成 0（填 #0a0f16 → 屏幕 #000102），记在验收记录 §14.1 |
| **D-63** | `POSTFX.bloomThreshold` 0.85 → **3.2** | 追加批 | 白底线性 3.0，阈值低于它会整屏蒙白光（即作者说的"雾感"）。副作用：场景内发光体线性值都 <1，bloom 实质不触发；通道保留是为了不动既有 pass 链与验收口径，要恢复辉光应把灯带改 HDR 而不是调回阈值（`sky.test.ts` 有 `bloomThreshold > SKY_INTENSITY` 的约束断言） |---
| **D-64** | LINE-A1 预设 `[-20,7,14]` → `[-15,3,-1]`（超出作者指定的相机改动范围） | D 批 R1 | 旧机位 y=7 贴在天花灯带高度，画面顶部露一条没有屋面板的白（规格明确不铺屋面板），视线尽头也不是墙。新机位在车间内 y=3 平视，尽头是西墙+北墙夹角。连带：`ENTRANCE_START/PATH` 跟着 `maxDistance` 90→72 收敛（距原点 65.8 < 72，否则入场第一帧被夹回看着像瞬移） |
| **D-65** | 室内补光强度超出作者给定值：HemisphereLight 0.55 → **1.15**，两盏天窗 DirectionalLight 0.62/0.44 → **1.35/0.9** | D 批 R1 | 作者要求"整体亮度提升 10~20%"；实测 0.55 档只 +6.4%（79.11 → 84.2）。抬档后 +13.4%（→ 89.7，overview 机位截图平均亮度），明暗层次不塌。三盏都不投阴影，阴影 draw call 不变 |
| **D-66** | 新增"室外剖切"：相机在某车间某侧室外时，该侧墙整组不可见（作者清单里没有这条） | D 批 R1 | 动机：overview [0,36,46] + 8m 南墙必然挡住产线下半部，"overview 两条产线可见"无法达标。半透明方案要加 transparent/新材质，破坏"六个合并组、不新增材质"约束；改为 `EnvPart.cut` 标记 + 合并索引退化（三组索引写 0 号顶点），无新增材质/draw call，阴影与主 pass 共用索引不穿帮。规则在 `envInterior.cutawaySides`（纯函数），包柱/桁架不剖 |
| **D-67** | `RoundedBoxGeometry` 是**非索引**几何，而 `Box/Cylinder/Plane` 是索引几何，`mergeGeometries` 要求全体一致，直接返回 null | D 批 R2 | 合并前统一 `toNonIndexed()`；三角数改按 `position.count / 3` 算（用 `index.count` 会漏掉圆角箱）。顺带把圆角细分 2→1：每个圆角箱 300→108 三角，该尺寸下观感无差别，符合性能优先。已写成单测断言"index 必须为 null" |
| **D-68** | 新增 examples 依赖后 `vite --force` 并不能救场：它要删 `.vite/deps`（93 个文件），触发沙箱批量删除保护，dev server 启动直接失败 | D 批 R2 | 不删文件，把 `node_modules/.vite` 整个**改名**让 Vite 重建。比 D2 那次（提交 `5a2d4c4`）更进一步：`optimizeDeps.include` 只能防运行期重打包，防不了 `--force` 的主动清理 |
| **D-69** | 两个窗口同时写 `builders.ts` 时，Vite 缓存了半截模块，页面报 `does not provide an export named 'applyDeviceState'`，而磁盘上导出齐全 | D 批 R3 | `touch` 该文件触发一次重转换即恢复，无需重启服务。排查时不要先怀疑代码丢了，先看模块转换缓存 |
| **D-70** | 贴地假接触阴影用 `deviceShell`（StandardMaterial）会被室内补光照亮，呈现为浅灰"设备基础台"而非纯黑阴影；初版 4.6×3.1 m 还会在地面留一块孤立硬边黑块 | D 批 R2 | 收小到 4.2×2.75 m、中心色 `0x080c12 → 0x121a24`，孤立黑块消失。当前观感在验收文档里如实记为"基础台"，**不称作柔和接触阴影**。真·柔和阴影需独立透明材质，会每台 +1 draw call 并让 CONVEYOR 超"≤3 mesh"（§10.4 第 2 项），本批按性能优先不做 |
| **D-71** | `acceptance-d3.mjs` 的 `LABEL` 写死 5 个预设，R1.5 A 层扩到 7 个后，"预设数量 = 5""20 个有序对切换"两条断言失效；加载期额外的 1000 ms 过渡还会覆盖 `lastTransitionMs`，使"入场时长"读到 1003 ms | D 批 R2/R3 | 三项均为 R1.5 遗留，**不是设备建模引入的回归**，本批未改 `SceneRoot.tsx`、未放宽判据。14/14 点击命中已复测通过。登记待下一批同步脚本，见 `docs/acceptance_phase4_d.md` |
| **D-72** | 作者 2026-11-25 晚要求「天花板的管道还有黑色的杆子都去掉，影响观感」，**推翻此前追加批加桥架/桁架的决定** | 顶部清理 | 删三组：D2 架空圆管（含落地立管）、`trusses()` 约 280 根深色方管、`buildCableRuns()` 桥架与竖杆。数据/几何/材质/类别/断言一并删除，不留空 mesh；三处测试改成"不许加回来"的反向守卫。**§4 第 10 项「工业道具 ≥7 类」随之下调为 ≥6 类**（管道是第 7 类），`acceptance-d2.mjs` 与 `propLayout.test.ts` 已同步。保留 5 道灯带与柱列（照明与尺度参照，不属杆件） |
| **D-73** | 作者 2026-11-26 11:26 要求「把之前对话阶段我让你补充场景密度的很多显示装置去掉，其它的不要动」，**推翻 R1.6 补密度的决定** | R1.6 回退 | 整批从代码撤出：`propLayout.ts` / `envLayout.ts` / `envBuilder.ts` / `acceptance-env.mjs` 回到 `4502540^`，删 `propLayout.density.test.ts`（12 条单测）；`ENV_GROUP_BUDGET` 10→6，环境层类别回到不含 `density-props`、合并组回到 6。**保留** `SceneRoot.pick()` 的 `envRoot` 参与拾取（墙/柱挡住设备时不误弹卡）与光标无条件写 `pointer/grab`——这两条是拾取正确性修复，不属「显示装置」。实测 scene 61→**57**、三角 36,122→**33,210**、整链 105→**101**、单测 179→**167**；d1 9/9 · env 23/23 · d3 11/11 · device 54/54。`v0.4-density` 标签保留指向 `4502540` 作历史 |
| **D-74** | 作者 2026-11-26 要求「把 /ai 页从模型指标改成工厂日报」：原页面主角是 PR-AUC / 混淆矩阵，回答「模型好不好」，但看页面的人要的是「今天哪里要管、不管损失多少」 | AI 页改版 | 信息架构重排为**结论条 → 待办清单 → 8 小时交付风险 → 本月损失账 → 折叠的模型详情**；PR-AUC / F1 / 特征维度只允许出现在折叠区。新增 `config/report.json` + `GET /report/config`（只读）暴露单价/节拍/降速/处置时长/分档阈值——这是 **`app/` 冻结的例外**，理由是作者同时要求「不允许前端硬编码系数」，系数必须走接口才能被页面标注来源。异常持续时长优先取**注入真值区间**（模型逐点判定会把 90 秒注入拆成 1~2 个孤立点，实测持续仅 2 秒），峰值仍取区间内模型分数；损失账按「设备+类型+开始时刻」去重（实测库里 id 1162/1163 完全重复）。待办每行把 active/handling/cycle/slowdown 写进 `data-todo-*`，验收脚本按页底公式逐行复算。实测：acceptance-ai 54/54、单测 185、pytest 28、batch2 24/24、d3 11/11、env 23/23 |
| **D-73** | `acceptance-env.mjs` 末尾直接 `JSON.parse(JSON.stringify(window.__envErrors))`，开发期 HMR 重载清掉该变量时会把整轮验收炸掉 | 顶部清理 | 改为 `window.__envErrors ?? []`。真实异常在变量存在时仍会被断言抓到，只是不再被热更新误伤 |
| **D-75** | 作者 2026-11-26 要求「让设备状态/异常真正影响产量与良率，接上因果链」：改前 `injector.apply_active()` 只改四项指标值，`orders.advance()` 是纯计时器（每 120 秒每线 +1 件），于是 `/stats` 的 utilization 是 86.7%（状态机 26/30 分钟在转）而订单按 100% 满速推进，两个口径自相矛盾 | 数据因果链 | 新增 `data_pipeline/line_pace.py`：**useful_rate = 该线可用设备数 / 该线设备数**（可用 = `status_at()` 处于 RUNNING 且 `devices.status` 不是 STOPPED/MAINTENANCE），**输送机 CONV 不可用时整线 0**（作者裁定：工件过不去）；节拍 = 30 件/h × useful_rate × 异常系数；异常系数与合格率 VIB_SPIKE 0.85/92%、TEMP_DRIFT 0.75/90%、CURRENT_ABNORMAL 0.90/94%，**同线多台取最严一档不叠加**；ALARM 不减可用率（惩罚只走异常通道，防双重扣减）。`orders.advance(now, produced_by_line, rate_by_line)` 改按件累加，`PieceAccumulator` 保留小数余量（2 秒一拍满速才 1/60 件，不留余量永远进不了位），合格件数按当前有效合格率累计、完工时按累计值结算。模拟器每拍读 `devices.status` 与活跃注入，**被人工停用的设备遥测一并写 STOPPED**（复用 `generator.apply_stopped_physics`），使 `/stats` 的 utilization 与节拍同源，不再需要改 `app/`（后端仍冻结）。僵尸注入守卫：`ended_at IS NULL` 的记录超过该类型配置时长即失效，否则被强杀的模拟器会让产线永久扣产能（实测踩到 6 条）。**实测**：改前 10 分 42 秒每线 +5 件（计时器恒速 120 秒/件，与状态机相位无关），同窗口 `/stats` utilization 92.86%；改后同长度窗口每线 +5 件但 pace 随状态变化——RUNNING 全速 120/h、异常期 112~117/h、停线 90/h、**IDLE+STOPPED 连续 120 拍 pace=0/h**；停 CONV-01 的 5 分 5 秒内 LINE-A1 产量 7480→7480（+0）而 A2/B1/B2 各 +2，`/stats?line_id=LINE-A1` 的 utilization 0.6667；CNC-02 注入 VIB_SPIKE 3 分钟 pace 120→**116/h**（=25.5+30+30+30，与 0.85 系数吻合）；全厂 IDLE+STOPPED 4 分钟窗口 utilization **0.0077**、三线产量冻结。合格率的 92% 口径由单测固定（120 件 → 110 合格），3 分钟窗口只有 1~2 件，实测数据无法区分 92% 与 97%，如实记为不可测。**口径说明**：`/stats` 的 utilization 是设备级可用率，输送机停机时它能到 66.7% 而产量为 0——这是线级门控（工件过不去），不是两个口径分叉，本批不动 `app/`，仅在此登记。单测新增 `tests/test_line_pace.py` 9 条 + `PieceAccumulator` 5 条，pytest 28 → **41 passed** |
| **D-76** | 作者 2026-11-26 17:26「对现在的建模效果非常不满意，想要让工厂的建模体积更大、器材更真实」；选择：厂房更大更宏伟 + GLB 真模型（Blender 参数化生成）+ 先做光影材质 | 批 1 光影与材质 | **先修的是"光"，不是"形"**——实测发现三处结构性缺陷比几何更致命：① 车间地坪铺的是 `pave`（MeshBasicMaterial，不受光无贴图），压住下方混凝土贴图、粗糙度、环境反射与接收阴影；② 围护墙在 `matte` 组（castShadow=true）把来自上方的光全挡在墙外，室内只剩不投影的补光，**车间里没有任何设备影子**；③ 全场景无 `scene.environment`，金属没有可反射的环境，roughness/metalness 再调也是塑料。本批：拆出 `shell` 组（墙/踢脚/包柱、castShadow=false）+ 天窗光改投影；车间地坪改用 `materials.floor`（并按面积缩 UV 对齐 6 m 分仓缝）；新增程序化环境源 + PMREM（HDR 灯带线性值 7.5/8/9，`environmentIntensity` 0.85）；地面加 `roughnessMap`（油渍/水痕处 0.3，干燥处 0.86）；设备脚下加合并的接触阴影贴片（MultiplyBlending，**1 draw call**）；灯光重排（半球 1.55→0.95、主光 1.7→2.15、室内半球 ground 提到 0x5d6a76 让屋顶下表面有反弹光）；墙色 0x8f99a3→0x7c8792。**顶部桁架做了又撤**：作者 17:53「不需要添加顶部栏杆影响视线」，`roof.ts` 已删除、不留死代码，剖切规则恢复为只剖墙（体量改由墙体层高/夹层/机位承担，见批 2）。实测：scene 57→**59**、shadow 27→**54**（两盏投影光）、整链 101→130、三角 33,210→**33,238**、fps 144.9；单测 185→**186**；env 23/23、d1 9/9、d3 11/11、device 54/54；画面平均亮度 72.3→67.1、暗部占比 3.2%→2.4%（更暗但不再压死） |
| **D-77** | 作者「工厂建模体积更大」+ 已否决顶部构件（D-76 20.5） | 批 2 体量（2a） | **思路修正**：设备只有 14 台（项目事实），放大占地只会摊薄密度。体积改由**竖向净空 + 围护分格**承担：层高 8→**12 m**、窗带 4.5~6 抬到 **7~9.4**（宽 2→2.4）、卷帘门高 4.5→6；新增墙面结构分格（东西墙各 4 根、南北墙各 4 根露明壁柱，全部避开窗洞）+ 10.2 m 腰线，因为 34×12 的白墙在人视时上半幅全空，比 8 m 时更"空"；壁柱带 `cut` 与墙同组剖，四角包柱仍不剖。**灯带降到 8.0 m 并加金属外壳**：贴 12 m 顶会变成悬空白棍（实测 11.2 m 时像白梁斜插），8 m 是悬吊灯具的常规高度，外壳让它在低机位读得出是灯。实测：三角 33,238→**33,766**、scene 59 / shadow 54 / 整链 130 不变、fps 144.9；单测 186→**187**（新增"壁柱不许堵窗"守卫）；env 23/23、d1 9/9、d3 11/11、device 54/54 |
| **D-78** | 作者选定「GLB 真模型，Blender 参数化生成」；并已装 Blender（便携版 5.2.3 LTS，`E://夸克下载//...`） | 批 3 设备模型（3/6 类） | **管线**：`tools/blender/gen_devices.py` 用 bpy 按参数生成 CNC / 六轴机器人 / 检测台，导出 GLB 到 `frontend/public/models/`。尺寸取自 `DEVICE_SIZES`，原点在底面中心，1 单位 = 1 m，导出 Y-up。**为什么必须运行时烘焙**：Blender 导出是"一零件一 mesh"，一台 CNC 25 个 mesh；直接进场景会让 scene draw call 从 59 涨到 ~190，踩穿 ≤100 的红线。`glbDevices.ts` 加载后按源材质的 metalness/opacity 分 paint/metal/glass 三桶，把材质色写进顶点色再合并，每台 2~3 个 mesh（与设备建模 v2 的顶点色思路一致）。**机械臂**：Blender 里大臂及以上挂在 `arm_pivot` 空物体（Z=1.95，与 ARM_PIVOT_Y 同值），加载后按枢轴烘焙并挂回同名 Group 写进 `build.arms`，motion.ts 一行没改。**颜色踩坑**：第一版按 sRGB 习惯把漆面给到 0.82，进 three 后线性 0.82≈sRGB 0.93，被 IBL+主光打到全白、护罩分缝糊掉；全部改为线性工业灰（浅灰 0.34 / 深灰 0.09 / 安全橙 0.55）。**幂等**：dev 下 StrictMode 会跑两遍 effect，第一次未清旧 GLB 网格导致 130→190 calls 叠加，已按 `deviceId:` 前缀清理。CONVEYOR / AUX 仍用程序化（有滚筒动画，形体简单）。实测：scene 59→**79**、shadow 54→**94**、整链 130→**190**、三角 33,766→**46,606**、单台最多 3,180（上限 8,000）、fps 144；单测 187、env 23/23、d1 9/9、d3 11/11、device 54/54 |
| **D-79** | 批 3 收尾：把剩余 4 台也换成 GLB（作者「继续」）| 批 3 完成 6/6 | 新增 `conveyor` / `aux_air` / `aux_pump` 三款模型（2,260 / 2,052 / 1,552 三角），模型映射改为按**设备 ID 前缀**（AUX 一台空压机、一台泵，形体不同，不能共用一个模型）。输送机**刻意不含滚筒**：`RollerRig` 每帧写 8 个滚筒实例矩阵，GLB 再带一套会双份，所以 GLB 只建机架/支腿/侧梁/电机/控制盒，滚筒留程序化。随之三处调整：① 单台 mesh 上限 3→**4**（输送机 = 2 个烘焙桶 + 滚筒 + 定位条，动画件不能并桶）；② 灯管压暗并抬到 **10.4 m**（8.0 m 时低机位横穿画面，像一根白棍斜插过来）；③ 修掉一条**随运行时长漂移的断言**——`A2 被 ROB-02 闸住` 写死了闸点，料推进后闸点会换成 CNC-02/CONV-02，实测出现过失败，改为「停住 + 闸点在本线设备」。实测：scene 79→**83**、shadow 94→**102**、整链 190→**202**、三角 46,606→**52,390**、fps 144；env 23/23（含修好的那条）、d1 9/9、d3 11/11、motion 17/17（枢轴换 GLB 后仍摆）、device 54/54、单测 187 |
| **D-80** | 作者 2026-11-26 21:45「先做 1」（细化方案里的第 1 项：细节贴图 = 法线贴图 + 铭牌文字） | 批 4 表面细节 | **贴图**：新增 `tools/blender/gen_textures.py`，用 numpy 造周期噪声、**手写 PNG 字节**（zlib）而不是走 `bpy.data.images`——后者存盘时会过一次色彩管理，法线图这种非颜色数据被 sRGB 编码后就废了（第一版实测整张图偏紫）。产出 6 张 512²：`paint_normal/rough/dirt`、`metal_normal/rough/dirt`，合计 879 KB，全部严格无缝平铺（值噪声的格点按 cells 取模）。**UV 是前置条件**：`glbDevices.ts` 原先为了顶点色合并把 uv 属性删掉了，法线贴图无从采样；改在 Blender 侧做立方投影 UV（按面法线主轴选投影平面，1 UV = 1 米），加载端保留 uv 并给缺 UV 的件补零（否则 `mergeGeometries` 属性集不一致会返回 null，整台设备消失）。**三个重复率各管一段尺度**（这是本轮最关键的判断）：法线 repeat 6（毫米级喷塑颗粒）、粗糙度 0.7（分米级脏污）、色差 0.45（米级面板色差）。同 repeat 必然一脚踩空——实测 repeat 7 时远景完全看不见，repeat 1.5 + normalScale 3 时近景像砂纸。**中距离质感不做法线**：实测 10 m 外 1 mm 细节小于一像素、被 mipmap 平均，这是物理正确的；中距离改由**几何**承担——CNC 加下部检修门（带竖把手）、台面加 T 型槽。**铭牌做成几何**：`text()` 用 FONT 曲线转 mesh，`resolution_u` 12→3（每字符 300+ 三角降到约 100），合并管线共享材质，draw call 零增加且近景有真实浮雕厚度；字色用深色压浅漆面（纯钢牌在非正对角度只能反射暗青环境，读作一块黑膏药）。**顺手修两处历史缺陷**：CNC 的铭牌/警示牌 y=-1.16 而壳体前面在 -1.18，整块牌埋在壳里；侧面散热格栅 x=1.52 也在壳内（半宽 1.75）。实测：三角 52,390→**58,954**、scene **83 不变**、shadow 102、整链 202、fps 144.9；单台最多 3,968（上限 8,000）；单测 187、env 23/23、d1 9/9、d3 11/11、motion 17/17、device 54/54 |

## 附录 C 冻结记录

**2026-11-25，作者五条决策（原文要点）：**

1. **展示优先。** 判据是「看得懂、看得像、点得动、演得住」，不是「数据对得上」。
2. **数据一致性验证、工件身份化、后端仿真状态机，全部不做**（记为以后方向）。
3. **唯一真数据连接点**：传送带速度由 CONV 设备的实时 `speed` 指标映射；除此之外三维表现不要求数据驱动。
4. **消息队列不接；故障风险预测、产量预测取消；时序库冻结不再扩展。**
5. **后台（`app/`、`database/`）冻结**：除修 bug 外不改。

**冲突裁决原则（作者同次明确）：** 视觉与性能冲突时，**以性能为先**——宁可少一个道具，不掉帧。

---

## 附录 D 自查清单（对照作者 2026-11-25 的硬性要求）

| # | 要求 | 本文件是否满足 | 落在哪 |
|---|---|---|---|
| 1 | 先备份再重写 | ✅ `docs/archive/spec_phase4_v2.0.md`（1,029 行，与重写前逐字节一致） | §0.3 |
| 2 | 目标改为「三维界面展示与演示能力」 | ✅ 一句话目标 + 三个时间点（5 秒 / 1 分钟 / 3 分钟） | §1.1 |
| 3 | 不追求仿真真实性、不做数据一致性验证 | ✅ 三条边界 + §7.3 第 1 条；只保留一个真数据连接点 | §1.3 / §1.4 / §7.3 |
| 4 | 每批七段（目标/文件/视觉判据/硬指标/验证/风险/工时） | ✅ D0~D6 全部七段，无缺项 | §3 |
| 5 | 硬指标每条有测量方法 | ✅ 16 项指标，逐项写工具、机位、判定 | §4 |
| 6 | 不许用没有判据的形容词（"更……""……提升"这类） | ✅ 全文判据均为"截图对比 / 数字阈值 / 脚本断言"，无一处以形容词代替结论 | 全篇 |
| 7 | 不许再提数据一致性 / 工件追溯 / 消息队列 / 故障预测 / 产量预测 | ✅ 仅 §7.3 登记为"不做"，正文零论证 | §7.3 |
| 8 | 不许改后端（除修 bug） | ✅ 后端冻结边界 + 例外流程（单独提交、写清理由） | §7.1 |
| 9 | 视觉与性能冲突以性能为先 | ✅ 写入 D1（SSAO 默认不开）、D2（宁砍道具不做超标）、附录 C | §3 / §6.1 / 附录 C |
| 10 | 六个批次 + 前置体检 | ✅ D1~D6 六批；D0 明确为"前置体检，不算施工批次"并说明作者所述"六个"与所列七项的关系 | §3 开头 |
| 11 | 砍掉的旧条款要有清单 | ✅ v2.0 的 §3 / §6 / §7 整章删除、4 个批次删除，均在 §0.2 ② 与 §7.3 登记 | §0.2 / §7.3 |
| 12 | 统一 draw call 的 90 / 150 矛盾 | ✅ 统一为 ≤100，回写 phase3 两处，现状 132 记 D-37 | §2.4 / 附录 B |
| 13 | 工时可比 | ✅ 逐批给出，合计 12 人日 | §3 末尾 |

**两处需要说明的自主判断（供作者否决）：**

1. **把"六个批次"理解为 D1~D6**，D0 作为前置体检单列。作者列了 D0~D6 共七项，若把 D0 也算批次，则"六个"与所列不符；
   我按"D0 不出代码、只出清单"的性质处理，并在 §3 开头写明，避免歧义。
2. **SMAA 与现有 MSAA 二选一，选 SMAA**。作者要求接入 SMAA，但现状已开 `antialias: true`；
   同时保留等于为抗锯齿付两次成本，故在 §6.1 给出"关 MSAA、用 SMAAPass"的处置与理由。若作者坚持保留 MSAA，改回一个参数即可。
