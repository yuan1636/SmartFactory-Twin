# SmartFactory Twin —— 智慧工厂数字孪生与 AI 智能分析平台 V1.0

以虚拟机械加工工厂为场景（1 工厂 / 2 车间 / 4 生产线 / 14 台设备）的数字孪生演示系统。
**第一版全部数据为模拟数据，不得对外表述为真实工厂数据。**

本仓库当前处于 **第 3 阶段（前端）已完成**：五个页面全部可运行（三维总览 / 设备监控 / 生产分析 / 告警与维护 / AI 真值展示），附一键启动脚本。

## 当前进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| 第 1 阶段 | 业务底座与文档（方案、架构、数据模型、设备清单） | 已完成，见 `docs/方案.md` |
| 第 2 阶段 | 模拟器 + REST API + WebSocket 推送 + 告警判定 + 生产订单推进 | 已完成，见 `docs/spec_phase2.md`、`docs/acceptance_phase2.md` |
| **第 3 阶段** | **React + TypeScript + Three.js + ECharts 前端** | **已完成并验收**（5 个可用页 + 1 个禁用导航项；10.1 八条 + 10.2 十二项） |
| 第 4 阶段 | Kafka 接入、TimescaleDB、AI 异常检测 / 故障预测 / 产量预测 | 未开始 |

第 3 阶段的施工依据是 `docs/spec_phase3.md`（**v1.0 已冻结**），验收记录见 `docs/acceptance_phase3.md`。

## 目录结构

```
AGENTS.md                    项目协作规则（最高优先级）
docs/方案.md                 项目总体方案（实验方案 V1.0）
docs/spec_phase2.md          第 2 阶段实现规格（v1.0 冻结）
config/devices.json          14 台设备清单 + 正常区间 + 告警阈值 + 注入参数（唯一来源）
database/schema.sql          建表脚本（只建不删，可重复执行）
database/seed.sql            种子数据（2 车间 / 4 产线 / 14 设备）
database/reset.sql           清库重建（⚠️ 会清空全部数据）
database/reset_drop_only.sql 只删除表（配合分步重建）
frontend/                    第 3 阶段前端（React 18 + TS 5.6 + Vite 6 + three 0.170 + ECharts 5.5）
  src/three/layout.ts        14 台设备三维坐标 + 六类机身尺寸（唯一数据源）
  src/three/builders.ts      程序化几何：厂房 / 产线色带 / 六类设备
  src/three/SceneRoot.tsx    渲染循环、相机预设、射线拾取、状态材质切换
  src/services/              API 客户端、WS 客户端（退避重连）、模块级 store、格式化
  src/pages/                 总览 / 设备监控 / 生产分析 / 告警与维护 / AI 预测（真值展示）
  src/utils/analytics.ts     告警分级、G-10 解除文案、真值甘特分组、真值 vs 告警对比
scripts/start-all.ps1        一键启动（数据库 → 后端 → 模拟器 → 前端）
scripts/acceptance-batch2.mjs 页面级验收脚本（CDP 驱动无头浏览器真点击）
app/                         FastAPI 后端
  main.py                    应用入口（uvicorn app.main:app）
  config.py                  配置与设备配置加载
  constants.py               枚举与错误码
  db.py                      数据库连接（同步 SQLAlchemy）
  errors.py                  统一错误体
  schemas.py                 请求体模型
  routers/                   路由：health / hierarchy / devices / telemetry / alarms / orders / maintenance / anomalies / ws
  services/                  遥测写入、告警扫描与收敛、快照、WebSocket、后台任务
data_pipeline/               数据模拟器
  simulator.py               命令行入口（python -m data_pipeline.simulator）
  generator.py               指标生成公式与状态机
  injector.py                三类异常注入 + ground truth
  orders.py                  订单推进
  backfill.py                历史回填
  http_client.py             调用后端批量写入接口
ml/                          预留，本阶段不实现（第 4 阶段模型）
factory_models/              预留，本阶段不实现（第 3 阶段三维资产）
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

### 1. 启动数据库（PostgreSQL 16，宿主机端口 5433）

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

预期：8 次 `CREATE TABLE` + 11 次 `CREATE INDEX`；随后 `INSERT 0 2`、`INSERT 0 4`、`INSERT 0 14`。

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

### 6. 启动前端（第 3 阶段）

```powershell
cd frontend
npm install
npm run dev
```

打开 <http://127.0.0.1:5173/overview>（必须是 `127.0.0.1`，用 `localhost` 会因 IPv6 解析白等约 2 秒）。

- 三维总览：14 台设备随模拟器状态变化，状态灯 / 地面光环 / 告警描边可辨；
- 设备监控：`/devices/CNC-01`，四指标曲线带 WARNING / CRITICAL 参考线，1h / 6h / 24h 切换；
- REST 走 Vite 的 `/api` 代理（后端没有 CORS 中间件，浏览器直连 8000 会被拦），
  WebSocket 直连 `ws://127.0.0.1:8000`。原因见 `docs/spec_phase3.md` 偏差 D-04。

前端单测（39 个用例）：

```powershell
cd frontend
npm run test
```

预期：`Test Files 7 passed`、`Tests 39 passed`。

## ⚠️ 关于 reset.sql

`database/reset.sql` 会 **删除全部 8 张表及其所有数据**（遥测、订单、告警、维护记录、异常真值全部清空，不可恢复）。
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

### 第 3 阶段（已完成）

规格第 10 节的 8 条命令 + 12 项人工检查，逐条记录在 **`docs/acceptance_phase3.md`**
（三列：结论 / 命令 / 实际输出）。10.1 八条命令全过；10.2 十二项中 9 项已由脚本断言，
仅「动效是否刺眼」「真实帧率」两项保留为人工判断。

若要自己复跑：

```powershell
cd frontend
npm run build      # 预期 ✓ built in ...，0 error
npm run test       # 预期 8 files / 60 tests passed
npm run dev        # 另开窗口后访问 /overview、/devices 等
```

页面级验收（Chrome 需用 `--remote-debugging-port=9222` 启动，前端在 5173）：

```powershell
node scripts\acceptance-batch2.mjs
```

该脚本做 24 项断言：三维 hover 高亮 / 点击跳转 / 相机缓动、告警解除 Toast 的 G-10 文案、
生产页数字与接口自洽、AI 页无编造指标。

注意：验「解除告警」前必须有未解除告警。没有时先注入一条超温遥测（时间戳带毫秒，
避免与模拟器的整 2 秒栅格撞主键），命令见 `docs/acceptance_phase3.md` 第 5.1 节。

### 第 2 阶段

第 2 阶段的 15 项验收命令与预期输出见 `docs/spec_phase2.md` 第 7 节，逐条可复制执行。
**回归记录见 `docs/acceptance_phase2.md`**（每条都带"结论 / 命令 / 实际输出"三列，2026-11-24 实测：
13 通过、1 不通过（7.10 判定区间，属文档口径）、1 未验证（7.15 真 Ctrl+C 无法程序化投递））。

自动化回归（8 个用例，约 27 秒）：

```powershell
pip install -r requirements-dev.txt
python -m pytest tests -v
```

预期：`8 passed`。
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
| 建表 | 8 表 / 11 索引，无 ERROR |
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

## 第 2 阶段明确不做

前端页面 / Three.js / ECharts、Kafka、Redis、TimescaleDB 与 hypertable、AI 模型训练与推理、
用户与登录鉴权、告警外发通知、数据清理定时任务、Alembic 迁移、应用容器化、
订单排产算法、真实 IoT 接入、报表导出、模型评估脚本、性能压测与限流。

完整列表见 `docs/spec_phase2.md` 8.1。需要预留的点位只留空函数并注释「预留，本阶段不实现」。
