# SmartFactory Twin —— 智慧工厂数字孪生与 AI 智能分析平台 V1.0

以虚拟机械加工工厂为场景（1 工厂 / 2 车间 / 4 生产线 / 14 台设备）的数字孪生演示系统。
**第一版全部数据为模拟数据，不得对外表述为真实工厂数据。**

本仓库当前处于 **第 4 阶段的展示改造，D2 批已完成**：五个页面全部可运行（三维总览 / 设备监控 / 生产分析 / 告警与维护 / AI 推理），
**三维产线会随设备状态真实运行**（物料流动、闸门阻挡排队、滚筒转动、机器人摆动），
**AI 异常检测已接入页面**（模型指标 / 混淆矩阵 / 四模型对比 / 分数曲线全部来自 `/ml/*` 实时返回，页面无写死数字），
**遥测表已迁到 TimescaleDB 并启用压缩**（456 万行：普通表 1,001 MB → hypertable 压缩后 234 MB）。

第 4 阶段在 2026-11-25 按作者决策**转向展示能力**（判据是「看得懂、看得像、点得动、演得住」）：
已交付 D0 现状体检 / D1 视觉基调（后处理 + 材质）/ D2 工业道具（七类 + 场景合批 120→77）；
D3 镜头与交互 / D4 动效生命感 / D5 界面层 / D6 性能与演示物料待做。附一键启动脚本。

## 当前进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| 第 1 阶段 | 业务底座与文档（方案、架构、数据模型、设备清单） | 已完成，见 `docs/方案.md` |
| 第 2 阶段 | 模拟器 + REST API + WebSocket 推送 + 告警判定 + 生产订单推进 | 已完成，见 `docs/spec_phase2.md`、`docs/acceptance_phase2.md` |
| 第 3 阶段 | React + TypeScript + Three.js + ECharts 前端 | 已完成并验收（5 个可用页；10.1 八条 + 10.2 十二项；产线运行动画 17 项） |
| 第 4 阶段 A（数据与 AI） | 异常检测训练、后端接入 + AI 页、TimescaleDB 迁移与压缩 | 已完成（原 4.1~4.4 批，见 `docs/acceptance_phase4.md` 第 1~9 节） |
| **第 4 阶段 B（展示）** | **三维界面展示与演示能力** | **进行中：D0 体检 / D1 视觉基调 / D2 工业道具 / D3 镜头与交互已完成**；D4 动效 / D5 界面层 / D6 性能与演示物料待做 |

- 第 3 阶段的施工依据是 `docs/spec_phase3.md`（**v1.1 已冻结**，v1.1 在 v1.0 上增补 §6.7 产线运行动画），验收记录见 `docs/acceptance_phase3.md`。
- 第 4 阶段的施工依据是 `docs/spec_phase4.md`（**v4.0 生效**，2026-11-25 目标改为三维界面展示与演示能力：不做数据一致性验证、不接 Kafka、取消故障风险与产量预测、后端冻结；v1.0 / v1.1 / v2.0 原文归档在 `docs/archive/`），验收记录见 `docs/acceptance_phase4.md` 第 8~12 节。
- **交接入口是 `PROGRESS.md`**：做过什么、验证到什么程度（含可复跑命令与实测数字）、下一步 D3 怎么开工，都在那一页。

## 目录结构

```
AGENTS.md                    项目协作规则（最高优先级）
docs/方案.md                 项目总体方案（实验方案 V1.0）
docs/spec_phase2.md          第 2 阶段实现规格（v1.1 冻结）
docs/spec_phase4.md          第 4 阶段实现规格（v4.0 生效：展示优先，含偏差 D-11～D-56）
config/devices.json          14 台设备清单 + 正常区间 + 告警阈值 + 注入参数（唯一来源）
database/schema.sql          建表脚本（10 表 / 15 索引，只建不删，可重复执行）
database/migrate_timescale.sql  device_telemetry → hypertable + 压缩设置（可重复执行）
database/seed.sql            种子数据（2 车间 / 4 产线 / 14 设备）
database/reset.sql           清库重建（⚠️ 会清空全部数据）
database/reset_drop_only.sql 只删除表（配合分步重建）
frontend/                    前端（React 18 + TS 5.6 + Vite 6 + three 0.170 + ECharts 5.5）
  src/three/layout.ts        14 台设备三维坐标 + 六类机身尺寸 + 产线物料流顺序（唯一数据源）
  src/three/builders.ts      程序化几何：厂房 / 产线色带 / 六类设备 / 滚筒 / 机械臂枢轴 / 合并后的灯与环
  src/three/postfx.ts        后处理管线（Bloom / SMAA / OutputPass / ACES）
  src/three/propLayout.ts    七类工业道具的摆放表（纯数据，10 条几何约束测试守着）
  src/three/propBuilder.ts   道具几何与材质（全部走 InstancedMesh 或 mergeGeometries）
  src/three/lineTraffic.ts   一维队列推进算法（纯函数，不依赖 three，可单测）
  src/three/motion.ts        装配产线动画：物料 InstancedMesh 矩阵、滚筒自转、机械臂摆动
  src/three/SceneRoot.tsx    渲染循环、相机预设、射线拾取、状态材质切换、动画冻结
  src/services/              API 客户端、WS 客户端（退避重连）、模块级 store、格式化
  src/charts/options.ts      ECharts 配置（含混淆矩阵热力图、四模型对比、分数曲线）
  src/pages/AiInsight.tsx    AI 页：模型输出（指标/混淆矩阵/曲线）+ 真值对照（甘特/柱/列表）
  src/utils/analytics.ts     告警分级、G-10 解除文案、真值甘特分组、真值 vs 告警对比
scripts/start-all.ps1        一键启动（数据库 → 后端 → 模拟器 → 前端）
scripts/lib/cdp.mjs          CDP 公共底座（连浏览器 / check / sleep / summarize）
scripts/acceptance-batch2.mjs 页面级验收脚本（CDP 驱动无头浏览器真点击，24 项）
scripts/acceptance-motion.mjs 产线运行动画验收脚本（17 项，读运行时快照与设备状态）
scripts/acceptance-ai.mjs    AI 页验收脚本（42 项：指标可追溯 / 同窗重放 / 降级态 / 无异常）
scripts/shot.mjs             截图工具（截浏览器当前页，`--full` 撑到整页高度）
app/                         FastAPI 后端
  main.py                    应用入口（uvicorn app.main:app）
  config.py                  配置与设备配置加载（含 ml_* 四个参数）
  constants.py               枚举与错误码（含 ML_UNAVAILABLE）
  db.py                      数据库连接（同步 SQLAlchemy）
  errors.py                  统一错误体
  schemas.py                 请求体模型
  routers/                   路由：health / hierarchy / devices / telemetry / alarms / orders / maintenance / anomalies / ml / ws
  services/                  遥测写入、告警扫描与收敛、快照、WebSocket、后台任务
    ml_anomaly.py            模型 lazy 加载 + 失败降级 + 窗口推理（/ml/* 的唯一实现）
data_pipeline/               数据模拟器
  simulator.py               命令行入口（python -m data_pipeline.simulator）
  generator.py               指标生成公式与状态机
  injector.py                三类异常注入 + ground truth
  orders.py                  订单推进
  backfill.py                历史回填
  http_client.py             调用后端批量写入接口
ml/                          第 4 阶段 AI 模型
  common/features.py         78 维特征抽取（训练与推理唯一实现，schema 指纹的来源）
  anomaly_detection/         训练 / 评估 / 二分类 + 三分类归因
    register_model.py        把 artifact 登记进 model_versions（同 task 只保留一行生效）
    score_window.py          批量打分并写入 anomaly_scores（复用 app 的 score_window）
tests/                       pytest（25 个用例：test_phase2_api.py / test_ml_api.py）
factory_models/              预留，第 6 阶段三维资产（当前为空占位）
```

## 快速开始

以下命令在仓库根目录、PowerShell 中执行。

### 0. 一键启动（推荐）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1
```

按顺序做四件事，每步打印 `[1/4] …`，任一步失败会打印退出码并停下：

1. `docker compose up -d` 并等 `pg_isready`（最多 60 秒）
2. 新窗口起后端 `uvicorn app.main:app --port 8000`，等 `/api/v1/health` 返回 200
3. 新窗口起模拟器 `python -m data_pipeline.simulator`
4. 新窗口起前端 `npm run dev`，等 5173 可访问

三个服务窗口请保持打开。8000 已被占用时会跳过后端启动（避免端口冲突），此时沿用已有进程。

### 1. 启动数据库（TimescaleDB 2.17.2 / PostgreSQL 16，宿主机端口 5433）

> 第 4 阶段 4.3 批把镜像从 `postgres:16` 换成了 `timescale/timescaledb:2.17.2-pg16`。
> `postgres:16` 官方镜像不含 timescaledb 扩展，`CREATE EXTENSION` 会直接报错。

```powershell
docker compose up -d
docker exec sftwin-db pg_isready -U sf -d smartfactory
```

预期：`/var/run/postgresql:5432 - accepting connections`

> 端口用 5433 是为了避免与本机已安装的 PostgreSQL 抢 5432。
> 不想用 compose 也可以直接 `docker run`，命令见 `docs/spec_phase2.md` 7.1。

### 2. 安装依赖

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

依赖版本已在 `requirements.txt` 锁定（见规格 G-15）。
规格要求 **Python 3.11**；本机实测用的是 **Python 3.13.14**，上面锁定的依赖版本在 3.13 下全部有 wheel、可直接安装并跑通验收。
如果你的机器是 3.11，同样按这份 `requirements.txt` 安装即可，无需改版本号。

数据库口令等配置可复制 `.env.example` 为 `.env` 后修改。

### 3. 建表与种子数据

```powershell
Get-Content database\schema.sql | docker exec -i sftwin-db psql -U sf -d smartfactory
Get-Content database\seed.sql   | docker exec -i sftwin-db psql -U sf -d smartfactory
```

预期：10 次 `CREATE TABLE` + 15 次 `CREATE INDEX`；随后 `INSERT 0 2`、`INSERT 0 4`、`INSERT 0 14`。
（`model_versions` / `anomaly_scores` 两张表在 4.2 批新增，见 `docs/spec_phase4.md` §6。它们是**离线存档**：
页面上的曲线走 `/ml/anomaly/scores` 实时推理，不读这张表。）

### 4. 启动后端

```powershell
uvicorn app.main:app --port 8000
```

预期：`Application startup complete.`；接口文档在 <http://localhost:8000/docs>。
该窗口保持不关，后续命令另开窗口执行。

```powershell
Invoke-RestMethod http://localhost:8000/api/v1/health | ConvertTo-Json
```

### 5. 启动模拟器

```powershell
python -m data_pipeline.simulator --duration 30                 # 跑 30 秒
python -m data_pipeline.simulator --backfill-days 1 --duration 30  # 先补 1 天历史
python -m data_pipeline.simulator                                # 常驻，Ctrl+C 退出
```

预期：每个 tick 打印一行日志，退出时打印 `==== 模拟器统计 ====` 统计块。

### 6. 启动前端

```powershell
cd frontend
npm install
npm run dev
```

打开 <http://127.0.0.1:5173/overview>（必须是 `127.0.0.1`，用 `localhost` 会因 IPv6 解析白等约 2 秒）。

- 三维总览：14 台设备随模拟器状态变化，状态灯 / 地面光环 / 告警描边可辨；产线物料持续流动，
  设备停机时物料堵在它上游排队，WebSocket 断开时整场动画冻结；
- 设备监控：`/devices/CNC-01`，四指标曲线带 WARNING / CRITICAL 参考线，1h / 6h / 24h 切换；
- AI 页（`/ai`）：上层是模型输出（状态条 / 四指标卡 / 混淆矩阵 / 四模型对比 / 分数曲线），
  下层是真值对照（甘特图 / 对比柱 / 列表）。**页面上每个数字都能追到 `/ml/*` 的一次真实返回**；
  模型 artifact 缺失时会整栏切换到降级态并写明原因，不显示任何占位数字；
- REST 走 Vite 的 `/api` 代理（后端没有 CORS 中间件，浏览器直连 8000 会被拦），
  WebSocket 直连 `ws://127.0.0.1:8000`。原因见 `docs/spec_phase3.md` 偏差 D-04。

前端单测（86 个用例）：

```powershell
cd frontend
npm run test
```

预期：`Test Files 9 passed`、`Tests 86 passed`。

## ⚠️ 关于 reset.sql

`database/reset.sql` 会 **删除全部 10 张表及其所有数据**（遥测、订单、告警、维护记录、异常真值、模型版本、分数存档全部清空，不可恢复）。
只在需要从零重来时执行：

```powershell
docker exec -i sftwin-db psql -U sf -d smartfactory -f /database/reset.sql
```

日常建表请用 `database/schema.sql`（它不删任何东西）。

## 备份

答辩前手工导出一份（本阶段不做定时备份，见规格 L-13）：

```powershell
docker exec sftwin-db pg_dump -U sf -d smartfactory > backup\smartfactory.sql
```

恢复：

```powershell
Get-Content backup\smartfactory.sql | docker exec -i sftwin-db psql -U sf -d smartfactory
```

## 验收

### 第 4 阶段 4.2 批（AI 接入，已完成）

完整记录见 **`docs/acceptance_phase4.md` 第 8 节**（含 42 项脚本日志原文、三接口实测返回与耗时、
两张表数据、五个仍未解决的问题）。要证明的核心只有一句：**AI 页上的每个数字都能追到一次接口返回**。

前置：数据库 + 后端 + 模拟器 + 前端都在跑，Chrome 用 `--remote-debugging-port=9222` 启动。

```powershell
node scripts\acceptance-ai.mjs
```

42 项断言，分六组：

| 组 | 断言内容 |
|---|---|
| 指标可追溯 | 状态条 `model_id` / `threshold` / `schema_hash`、四张指标卡，逐字段与 `/ml/model-info` 比对 |
| 混淆矩阵 | 四格数字与 `/ml/anomaly/confusion` 逐一相等，且四格之和 = 样本数 |
| 分数曲线 | 页面上报出的点数 / 预测异常数 / 区间数 = 接口返回；**同窗重放**：脚本取页面 `[data-ml-window]` 记录的窗口重发一次 `/ml/anomaly/scores`，两次结果必须完全一致 |
| 四模型对比 | 四组柱子的 PR-AUC 与 artifact 里的 `baselines` 一致 |
| 降级态 | 用 CDP `Fetch` 域拦截 `/ml/model-info` 返回 `loaded:false`，断言页面切降级、写明原因、不出现 0 或占位数字，随后 `Fetch.disable` 恢复 |
| 无异常 | 全程收集 `Runtime.exceptionThrown`，必须 0 条（含 heatmap 缺 visualMap 这类渲染期崩溃） |

后端：

```powershell
# ⚠️ 跑之前先停掉 uvicorn，否则两个进程抢写告警表，冷却类用例会随机失败
python -m pytest tests -q
```

预期：`25 passed`。其中 `tests/test_ml_api.py` 12 个函数 / 15 个用例（含 3 条降级用例与 1 条窗口回显回归）
（`ml_enabled=False`、schema 哈希不匹配、artifact 目录缺失），每条都断言"接口仍 200、`loaded=false`、
另两个接口返回 503 `ML_UNAVAILABLE`"。

两张新表的数据是可重建的（`reset.sql` 会一并清掉）：

```powershell
python -m ml.anomaly_detection.register_model            # 登记 artifact → model_versions（1 行生效版本）
python -m ml.anomaly_detection.score_window --hours 168  # 批量打分 → anomaly_scores（默认 1 小时）
```

### 第 4 阶段 4.3 / 4.4 批（TimescaleDB 迁移与压缩，已完成）

完整记录见 **`docs/acceptance_phase4.md` 第 9 节**。要证明的三件事：换存储引擎不丢数据、迁移可回滚、
压缩的收益用同一组查询在三态实测出来。

```powershell
# 迁移（详见 docs/spec_phase4.md §5.3，共六步：基线 → 备份 → 换镜像 → 建表恢复 → 迁移 → 四查 + 回归）
Get-Content database\migrate_timescale.sql | docker exec -i sftwin-db psql -U sf -d smartfactory

# 体积四口径（注意用 hypertable_detailed_size，不是 pg_*）
docker exec sftwin-db psql -U sf -d smartfactory -c "SELECT pg_size_pretty(table_bytes) AS 表, pg_size_pretty(index_bytes) AS 索引, pg_size_pretty(toast_bytes) AS toast, pg_size_pretty(total_bytes) AS 总量 FROM hypertable_detailed_size('device_telemetry');"

# 压缩（只压 1 天前的块，压缩块可写但重写代价高）
docker exec sftwin-db psql -U sf -d smartfactory -c "SELECT count(*) FROM (SELECT compress_chunk(c) FROM show_chunks('device_telemetry', older_than => INTERVAL '1 day') c) t;"
```

实测（4,570,704 行 / 1.55 GB 环境）：

| 状态 | 表 | 索引 | toast | 总量 |
|---|---|---|---|---|
| 普通表（迁移前） | 446 MB | 555 MB | ~0 | 1,001 MB |
| hypertable 未压缩 | 444 MB | 486 MB | 0 | 930 MB |
| **hypertable 压缩后** | **67 MB** | **72 MB** | **94 MB** | **234 MB** |

压缩比：表口径 **6.63:1**、总量口径 **3.97:1**。查询侧按类型看（10 次取中位数）：
扫描类变快（全表聚合 96.8 → 66.5 ms，冷数据单设备 6.08 → 3.23 ms），点查类基本不变
（单设备 1 小时 0.45 → 0.67 ms，差 0.2 ms 量级）。**不要写成"性能全面提升"**。

迁移后三条页面验收 24/24、17/17、42/42，后端 25 passed。

### 第 3 阶段（已完成）

规格第 10 节的 8 条命令 + 12 项人工检查，逐条记录在 **`docs/acceptance_phase3.md`**
（三列：结论 / 命令 / 实际输出）。10.1 八条命令全过；10.2 十二项中 9 项已由脚本断言，
仅「动效是否刺眼」「真实帧率」两项保留为人工判断。

若要自己复跑：

```powershell
cd frontend
npm run build      # 预期 ✓ built in ...，0 error
npm run test       # 预期 9 files / 86 tests passed
npm run dev        # 另开窗口后访问 /overview、/devices 等
```

页面级验收（Chrome 需用 `--remote-debugging-port=9222` 启动，前端在 5173）：

```powershell
node scripts\acceptance-batch2.mjs
```

该脚本做 24 项断言：三维 hover 高亮 / 点击跳转 / 相机缓动、告警解除 Toast 的 G-10 文案、
生产页数字与接口自洽、AI 页无编造指标。

注意：验「解除告警」前必须有未解除告警。没有时脚本会自动注入一条——先排除 5 分钟内报过温度告警的设备
（避开 5 分钟冷却），温度取该设备正常上限 ×1.35，其余指标取正常区间中值（否则一次注入会连带触发多条告警），
且只注入一台；25 秒仍未生成就报失败，不静默跳过。

### 产线运行动画（第 3 阶段补做，2026-11-24）

```powershell
node scripts\acceptance-motion.mjs
```

17 项断言，分五组：闸门位置与初始状态、物料确实在动且方向正确、停机设备上游确实堵住且不穿模、
滚筒角速度与机械臂摆动幅度、`prefers-reduced-motion` 下完全静止。

期望值不写死：脚本先读 `__sceneDebug.deviceStates()`，实时判断哪条线该堵、哪台设备是闸门，
再断言该闸门上游确实堆积、下游确实通畅。后端停机时另做一次冻结复验（`paused=true`、两次采样完全一致）。

> 该脚本依赖 dev 构建下的 `window.__sceneDebug`（`import.meta.env.DEV` 分支）。
> `npm run build` 的产物里没有这个对象，所以只能在 `npm run dev` 下跑。

### 第 2 阶段

第 2 阶段的 15 项验收命令与预期输出见 `docs/spec_phase2.md` 第 7 节，逐条可复制执行。
**回归记录见 `docs/acceptance_phase2.md`**（每条都带"结论 / 命令 / 实际输出"三列，2026-11-24 实测：
13 通过、1 不通过（7.10 判定区间，属文档口径）、1 未验证（7.15 真 Ctrl+C 无法程序化投递））。

自动化回归（24 个用例，约 40 秒）：

```powershell
pip install -r requirements-dev.txt
python -m pytest tests -v
```

预期：`25 passed`（`test_phase2_api.py` 10 个函数 / 10 个用例 + `test_ml_api.py` 12 个函数 / 15 个用例）。

> ⚠️ **跑 pytest 前必须停掉 uvicorn**。用例会写告警表验证冷却逻辑，后端同时在扫同一张表，
> 两个进程交替插入会让 `assert 2 == 1` 随机出现——这不是代码 bug，是测试环境问题。

本机实测结果（2026-11-24）：**13 项中有 12 项与文档预期完全一致，7.10 的数字需要按下面的口径理解。**

**7.10 数据量口径说明**：`--backfill-days 1` 回填的是 `[now-24h, now)` 整段 2 秒栅格，
共 43,200 个时刻 × 14 台 = **604,800 行**，这一段**已经包含** 7.8 写过的 210 行（同一 `(device_id, ts)`，
被 `ON CONFLICT DO NOTHING` 去重，计入 `duplicated`）。因此回填后库内总数 =
**604,800 + 7.10 自己跑的那几个实时 tick 行数**，实测 `604,828`（= 604,800 + 28）。
规格 7.10 里写的「604,800 + 210 + 28~42 ≈ 605,045」把 210 行重复计了一次，属文档算术问题，不是代码丢数据，
`回填行数 : 604590` 与 `重复 210` 两条打印可以互相印证（604,590 + 210 = 604,800）。

## 本机实测记录（2026-11-24）

| 项 | 实测值 |
|---|---|
| 建表 | 10 表 / 15 索引，无 ERROR |
| 种子 | 2 车间 / 4 产线 / 14 设备，类型分布 4-4-2-2-2 |
| 模拟器 30 秒 | 15 tick × 14 台 = 210 行，库内 210，失败/重试 0/0，退出码 0 |
| 单 tick 写入延迟 | 7~34 ms（14 行） |
| 回填 1 天 | 604,590 新增 + 210 重复，耗时 22~28 秒 |
| 回填后总数 | 604,828（= 604,800 + 28 实时行） |
| 异常真值 | TEMP_DRIFT 41 / VIB_SPIKE 36 / CURRENT_ABNORMAL 24 |
| 告警联动 | 2 条 CRITICAL 未解除，`devices.status = ALARM` |
| 告警解除 | 先 `ALARM`(open=1) → 再 `RUNNING`(open=0) |
| WebSocket | 每秒 1 条 snapshot，14 台设备，约 2.5 KB |
| 优雅退出 | 打印统计块，退出码 0，无 Traceback |

第 3 阶段前端与产线动画实测（同一台机器，2026-11-24）：

| 项 | 实测值 |
|---|---|
| `npm run build` | `✓ built in 6.19s`，0 error（仅 chunk > 500 kB 的体积提示） |
| `npm run test` | 9 files / **86 tests passed**（4.2 批新增 9 个：图表配置 5 + 类型守卫 4） |
| `acceptance-batch2.mjs` | **24 / 24 通过**（4.2 批后连跑两次仍全过） |
| `acceptance-motion.mjs` | **17 / 17 通过** |
| `acceptance-ai.mjs` | **42 / 42 通过** |
| 渲染开销 | 该值已过时：当前为 **场景 77 draw call**（不含阴影与后处理）/ 16,769 triangles，口径见 `docs/spec_phase4.md` §2.3 |
| 产线闸门 | 4 条产线 × 3 台设备，闸门坐标全部落在色带内，带宽可容 8 个料位 |
| 停机实测 | WS 断开后 `paused=true`，两次采样物料位置完全一致，恢复后自动续跑 |
| 后端回归 | `pytest` **25 passed** |

第 4 阶段 4.2 批实测（2026-11-24，三个接口现场调用；前两项的值来自 artifact，稳定可复现；
`scores` 的数字随模拟器写入而变，下表是某一次调用的值）：

| 项 | 实测值 |
|---|---|
| `/ml/model-info` | 2.7 ms；`model_id=anomaly-20261124-2143-9ab70b7`、`schema_hash=15afd2a011823561`（与训练侧一致）、`threshold=0.007866`、78 维特征 |
| 训练集规模 | 848,112 行 / 正样本 14,266（1.68%） |
| `/ml/anomaly/confusion` | 2.8 ms；测试集 127,206 行 / 正样本 2,175；混淆矩阵 TN 124,810 / FP 221 / FN 37 / TP 2,138 |
| 模型指标（离线测试集，按时间切分的最后 15%） | PR-AUC 0.9859 / Recall 0.9830 / Precision 0.9063 / ROC-AUC 0.9943 / F1 0.9431；区间召回 121/124、中位延迟 4.0 s、误报 0.625 次每设备每小时 |
| `/ml/anomaly/scores`（CNC-01，1 小时，默认 `limit`） | 页面与接口同为 1,770 点、降采样 ×1、判为异常 239 点、真值区间 1 段；预热 150 行取自库里真实数据（`warmup_available=true`）。耗时随窗口涨：1h 229 ms / 6h 1,196 ms（×3）/ 24h 2,021 ms（×9），见验收文档 8.2 |
| 上述「异常点数」为何每次都不同 | 模拟器一直在写新数据、按设计约每 9 分钟注入一次异常，所以同一台设备同一窗口长度，昨天 217 点、今天 239 点都正常。指标类数字（PR-AUC 等）来自 artifact 才稳定 |
| `model_versions` | 1 行生效版本，`dataset_rows=848112` |
| `anomaly_scores` | 24,851 行，其中 588 条 `is_anomaly=true`（随打分窗口增长，不是固定值） |
| 降级态 | 拦截 `/ml/model-info` 后页面切降级条，`data-ml-state="degraded"`，无 0、无白屏、0 条 JS 异常 |

## 第 2 阶段明确不做

前端页面 / Three.js / ECharts、Kafka、Redis、TimescaleDB 与 hypertable、AI 模型训练与推理、
用户与登录鉴权、告警外发通知、数据清理定时任务、Alembic 迁移、应用容器化、
订单排产算法、真实 IoT 接入、报表导出、模型评估脚本、性能压测与限流。

完整列表见 `docs/spec_phase2.md` 8.1。需要预留的点位只留空函数并注释「预留，本阶段不实现」。
