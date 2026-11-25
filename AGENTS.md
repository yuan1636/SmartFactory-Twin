# AGENTS.md — SmartFactory Twin 项目协作规则

本文件是全项目（所有阶段、所有代码 agent）必须遵守的顶层约定。**优先级最高**：与本文件冲突的实现方案一律作废。
规则变更只能由项目作者发起，agent 不得自行修改本文件。

## 1. 项目事实（不可更改）

| 项 | 值 |
|---|---|
| 项目名 | SmartFactory Twin —— 智慧工厂数字孪生与 AI 智能分析平台 V1.0 |
| 业务场景 | 虚拟机械加工工厂：1 工厂 / 2 车间 / 4 生产线 / 12 台核心设备（CNC×4、ROB×4、CONV×2、INSP×2）+ 2 台辅助设备（AIR-01 空压机、PUMP-01 冷却泵），合计 14 台 |
| 开发方式 | 个人独立开发 + AI 辅助，文档驱动，分阶段验收 |
| 目标用途 | 本科毕业设计、GitHub 作品集，后续可扩展到研究生阶段 |
| 数据性质 | 第一版全部为模拟数据，禁止对外表述为真实工厂数据 |

## 2. 技术栈（锁定，不得替换）

已定：React + TypeScript、Three.js、ECharts、FastAPI、PostgreSQL + TimescaleDB、Pandas、scikit-learn + XGBoost、Docker。

- 数据库引擎固定为 **PostgreSQL**。**不采用 SQLite**，不引入 MySQL / MongoDB。
- 新增任何技术栈之外的依赖，必须先写进对应阶段规格文档并得到作者确认，不得为了"省事"直接 `pip install`。
- 第 2 阶段不启用 TimescaleDB 扩展，`device_telemetry` 用普通表 + `(device_id, ts)` 复合索引；迁移时机见规格 L-01。

## 3. 文档地图（动手前按顺序读）

| 文件 | 作用 | 状态 |
|---|---|---|
| `AGENTS.md` | 本项目协作规则（本文件） | 生效 |
| `PROGRESS.md` | **交接与进度**：做过什么 / 验证到什么程度 / 下一步做什么 | 生效（换窗口或换人先读这一页） |
| `docs/方案.md` | 项目总体方案（实验方案 V1.0）：定位、架构、数据模型、12～16 周路线、验收标准、风险边界 | 已定稿 |
| `docs/spec_phase2.md` | 第 2 阶段实现规格（模拟器 + FastAPI + PostgreSQL） | **v1.1 已冻结、生效**（2026-11-24 修订 7.10 判定区间与 7.14 执行前置），第 1～8 节齐全，是第 2 阶段的唯一施工依据；代码已按此实现并跑通验收 |
| `docs/acceptance_phase2.md` | 第 2 阶段验收回归记录（7.1～7.16 逐条结论 + 命令 + 实际输出） | 已完成：14 通过 / 0 不通过 / 1 未验证（7.15 真 Ctrl+C 待人工按一次） |
| `docs/spec_phase3.md` | 第 3 阶段实现规格（React + Three.js + ECharts） | **v1.1 生效**（v1.0 于 2026-11-24 冻结；同日增补 §6.7 产线运行动画），是第 3 阶段唯一施工依据 |
| `docs/acceptance_phase3.md` | 第 3 阶段验收记录（Batch 1 / Batch 2 / 第 3 批产线运行动画） | 10.1 八条与动画 17 项全过；Batch 2 的 24 项复跑仍全过；保留人工项：动效观感、真实帧率、滚筒停转样本 |
| `docs/spec_phase4.md` | 第 4 阶段实现规格 | **v4.0 生效**（2026-11-25 目标改为**三维界面展示与演示能力**：不做数据一致性验证、不接 Kafka、取消故障风险与产量预测、后端冻结）；偏差 D-11 ~ D-54；v1.0 / v1.1 / v2.0 归档在 `docs/archive/` |
| `docs/acceptance_phase4.md` | 第 4 阶段验收记录（按批） | 4.1（训练）、4.2（后端 + AI 页）、4.3（TimescaleDB 迁移）、4.4（压缩与查询对比）、**D1（视觉基调）、D2（工业道具）** 已完成；D2 仅缺盲测 |
| `ml/` | 第 4 阶段 AI 模型（common 公共件 + anomaly_detection） | 异常检测主模型 PR-AUC 0.9859 / Recall 0.9830 / Precision 0.9063（测试集 127,206 行，时间切分最后 15%）；三分类归因宏 F1 1.0（数据集事实，非泛化能力） |
| `requirements-ml.txt` | ml 依赖（与 `requirements.txt` 分开） | 4 个直接依赖版本写死（**已删 `kafka-python`**）；间接带 scipy / threadpoolctl（偏差 D-11） |
| `frontend/` | 前端（React 18 + TS 5.6 + Vite 6 + three 0.170 + ECharts 5.5） | 五个可用页齐全 + 三维产线运行动画 + AI 页模型输出区；`npm run test` **96 passed** |
| `scripts/` | `start-all.ps1`（一键起库/后端/模拟器/前端）、`acceptance-batch2.mjs`（CDP 页面级 24 项）、`acceptance-motion.mjs`（产线动画 17 项）、`acceptance-ai.mjs`（AI 页 42 项）、`shot.mjs`（截当前页）、`lib/cdp.mjs`（共用 CDP 底座） | 五者均已实测跑通 |
| `tests/` | 测试网（pytest + httpx，25 个用例：`test_phase2_api.py` / `test_ml_api.py`） | **25 passed**；依赖在 `requirements-dev.txt`，不进 `requirements.txt`；**跑之前先停 uvicorn**（两进程抢写告警表会让冷却用例随机失败） |

**读文档顺序**：本文件 → `docs/方案.md` → 当前阶段的 `docs/spec_phaseX.md`。规格未定的部分不许自行发挥，先回来问。

## 4. 硬性实现规则

1. **规格先行**：任何新增表、字段、接口、枚举值，先改规格文档，再改代码。代码与规格不一致时以规格为准，并修正代码。
2. **阶段边界**：不得实现未列入当前阶段的模块。第 2 阶段禁止写 Three.js、禁止接 Kafka、禁止训练 AI 模型。需要为后续阶段留的口子，只能留空函数 / 空目录，并注释"预留，本阶段不实现"。
3. **时间口径**：数据库一律 `TIMESTAMPTZ` 存 UTC（`SET TIME ZONE 'UTC'`），接口输出 ISO 8601 带时区偏移，前端负责本地化显示。禁止把本地时间当 UTC 写入。
4. **指标单位**（全局唯一口径）：温度 ℃、振动 mm/s、电流 A、转速 rpm。字段类型与小数位见规格第 2 节数据字典。
5. **枚举写法**：一律 `VARCHAR` + `CHECK` 约束，配 Python `str, Enum` 类，不使用 PostgreSQL 原生 ENUM 类型。
6. **ID 规则**：大写前缀 + 连字符 + 两位序号。车间 `WS-A`/`WS-B`，产线 `LINE-A1`/`LINE-A2`/`LINE-B1`/`LINE-B2`，设备 `CNC-01`、`ROB-01`、`CONV-01`、`INSP-01`、`AIR-01`、`PUMP-01`。禁止出现 `CNC-1` 与 `CNC-01` 混用。
7. **状态写入方单一**：`device_telemetry.running_status` 只由模拟器写；`devices.status` 只由后端（告警 / 维护）写。两边不得同时修改同一字段。
8. **配置集中**：设备清单、指标区间、告警阈值统一放 `config/devices.json`，代码里禁止出现魔法数字阈值。
9. **建表方式**：`database/schema.sql` **只建表、绝不删表**（全部 `CREATE ... IF NOT EXISTS`，文件内禁止出现 `DROP`）；`database/seed.sql` 放固定种子数据；清库重建只允许走 `database/reset.sql`，且 `README.md` 必须写明"reset.sql 会清空全部数据"。禁止同时用 ORM `create_all()` 建表，避免两套表结构分叉。
10. **查询保护**：时序接口强制时间范围（缺省最近 1 小时），单次最多 5000 点；列表接口 `page_size` 默认 50、上限 200。禁止无上限的 `SELECT *` 全表返回。
11. **中文书写**：文档、注释、README、接口描述一律中文；标识符用英文 snake_case。注释解释"为什么"，不复述"做什么"。
12. **如实标注**：模拟数据、AI 输出的辅助性质、三维模型的简化程度，在文档与界面文案里必须写明，不得美化。
13. **提交纪律（作者 2026-11-25 追加）**：**每次改完代码或文档都要提交，且必须写提交信息**，不许攒着一起交、不许裸 `git commit -m "."`。具体要求：
    - 一次提交一件事。改了两个不相干的东西就分两次提交（例：`docs(phase4): 规格升 v2.0` 与 `feat(phase4): TimescaleDB 迁移` 是两个提交）。
    - 提交信息用「类型(范围): 一句话标题 + 空行 + 正文」，类型取 `feat` / `fix` / `docs` / `refactor` / `test` / `chore`。
    - 正文写**为什么**，不写"改了哪些文件"（`git diff` 自己能说）。有实测数字的必须写进去，比如"4,570,704 行完全一致"。
    - 提交前先 `git status`，确认没有 `.env`、`backup/`、`artifacts/`、`output/`、`node_modules` 被误加（这些都在 `.gitignore` 里，正常情况不会出现，出现即说明用了 `git add -f`）。
    - 推送用 `git push`；远端有别人/自动生成的提交时用 `--force-with-lease`，**不用** `--force`。
    - 提交完在给作者的回复里报出 commit 短哈希与标题，方便回溯。

## 5. 每阶段的收尾要求

一个阶段只有同时满足以下三条才算完成：

1. 规格文档里该阶段的字段、接口、验收命令全部落地；
2. 验收命令能复制执行并产生规格中写明的输出（不是"看起来能跑"）；
3. `README.md` 的"当前进度 / 如何运行"两节同步更新。

## 6. 当前状态

- 第 1 阶段（业务底座与文档）：已完成（需求文档、架构图、数据库设计、设备清单）。
- **第 2 阶段（Python 模拟器 + FastAPI + PostgreSQL）：已完成并按第 7 节验收（14 通过 / 1 未验证）。**
  交付物：`app/`（18 节接口 + 告警扫描/收敛 + WebSocket）、`data_pipeline/`（模拟器 4 参数 + 三类注入 + 订单推进 + 回填）、
  `database/`（schema / seed / reset）、`config/devices.json`、`tests/`。
- **第 3 阶段已完成并验收**（2026-11-24，三批）：Batch 1 工程骨架、数据层、三维场景、总览页、设备监控页；Batch 2 生产分析页、告警与维护页、AI 真值页、一键启动脚本；第 3 批三维产线运行动画。Batch 2 的 24 项与动画 17 项全过，记录见 `docs/acceptance_phase3.md`。
- **第 4 阶段 A（数据与 AI，已交付）**：4.1 异常检测训练 → 4.2 后端接入 + AI 页 → 4.3 TimescaleDB 迁移 → 4.4 压缩与查询对比。
  - 4.1：回填 7 天（423 万行）→ 78 维特征 → 84.8 万行训练集 → 四模型对比；主模型 XGBoost PR-AUC 0.9859 / Recall 0.9830，对比阈值规则 0.9098 / 0.8028；随机切分对照虚高 +0.0123。`evaluate.py` 22 项自检全过（"时间不重叠"断言抓到一个真 bug，D-17）。
  - 4.2：`app/services/ml_anomaly.py` + `/ml/*` 三接口 + `model_versions` / `anomaly_scores` 两表 + AI 页模型输出区；`acceptance-ai.mjs` 42 项。红线：**AI 页每个数字都能追到一次真实返回**。
  - 4.3 / 4.4：镜像换 `timescale/timescaledb:2.17.2-pg16`，`device_telemetry` 转 hypertable，迁移前后 **4,570,704 行完全一致**；压缩后 1,001 MB → **234 MB**（总量 3.97:1 / 表口径 6.63:1）；查询收益分类型——扫描类 -31%~-47%，点查类基本不变。顺带修掉接口真 bug D-34（回显窗口截到整秒导致同窗重放差 1 行）。
- **当前阶段：第 4 阶段 B（展示改造），D0 / D1 / D2 已交付（规格 v4.0）。**
  - **目标已转向展示**：判据是「看得懂、看得像、点得动、演得住」，不再追求数据一致性。数据一致性验证 / 工件身份化 / 后端仿真状态机**不做**；Kafka 不接；故障风险与产量预测**取消**；`app/`、`database/` **冻结**（除修 bug）。
  - D0 现状体检：20 条「假 / 空 / 卡」问题清单 + 基线（144.9 fps / 108 draw call / 首屏 562 ms），见 `docs/audit_d0.md`。
  - D1 视觉基调：后处理（ACES + Bloom + OutputPass + SMAA，零新增依赖）+ 程序化地面/墙板贴图 + 雾；场景 120 draw call、9/9 验收。
  - D2 工业道具：七类道具 + **场景合批 120 → 77**、10 条几何约束测试、19/19 验收。合批手法：灯/环 `InstancedMesh` + `instanceColor`、墙体与色带 `mergeGeometries`。
  - 待做：D3 镜头与交互（入场 3 s、5 预设、14 台点击 100%）、D4 动效生命感、D5 界面层、D6 性能与演示物料。
  - **D2 唯一的指标缺口是盲测**（3 人、≥2 人说"工厂"），需真人，脚本不代替。
- **作者 2026-11-24 的后续要求已登记**：①「三维产线要能动起来」→ 已实现（§6.7，17 项断言全过）；②「模型太粗糙」→ 作者确认**按计划留到第 6 阶段「优化与展示」**，`factory_models/` 继续为空占位，任何提前引入 GLB 的动作都属超范围。
- **代码托管（2026-11-25 起）**：`origin` → GitHub **`git@github.com:yuan1636/SmartFactory-Twin.git`**（公开仓库，默认分支 `main`）。
  建仓时作者填的中文名「数字孪生」未被 GitHub 接受，一度存成连字符 `-`；作者随后在 Settings 改名为 `SmartFactory-Twin`，本地 `remote` 已同步，旧链接 `github.com/yuan1636/-` 由 GitHub 自动重定向（历史不受影响）。
  首次推送时远端只有一个自动生成的 `Initial commit`（README 内容为一行 `# -`），已用 `--force-with-lease` 覆盖。
  共 18 个提交、147 个跟踪文件，仓库 `.git` 体积 1.6 MB（历史中最大对象 0.14 MB，无大文件）。**每次改动都要提交，见 §4 规则 13。**
- 第 3 阶段实施中产生的偏差已写入 `docs/spec_phase3.md` 第 12 节：**D-04** REST 改走 Vite `/api` 代理（后端无 CORS，直连必失败）；**D-05** dev 角标显示 draw call（便于脚本验收 10.1.6）；**D-06** 时间窗改用 `isoWindow()` 单次取时（否则 24h 窗口会因多出几毫秒被判 `RANGE_TOO_LARGE`）；**D-07** 4 个 DTO 按实机响应重写；**D-08** `__sceneDebug.camera()`（仅 dev，供脚本验缓动与不钻地）；**D-09** 增补 §6.7 产线运行动画（视觉动画不属于第 12 节禁止的物理仿真）；**D-10** `__sceneDebug.lineMotion()` / `deviceStates()`（仅 dev，供脚本断言闸门、队列与冻结）。
- 第 3 阶段验收后仍保留两条人工判断项：动效观感（RUNNING 呼吸 / ALARM 闪烁是否刺眼）、真实帧率（无头环境是软渲染，不作结论）。
- 第 4 阶段 4.2 批实施中产生的偏差已写入 `docs/spec_phase4.md` **附录 B**：**D-18/D-19** artifact 是推理唯一真相源、数据库表只存历史（反过来会出现"表说模型 A、实际跑模型 B"）；**D-20** heatmap 强制 visualMap（缺了渲染期抛异常、整页白屏）；**D-21** 分数曲线不加 `areaStyle`（会盖住真值色块与散点）；**D-22** 推理预热窗往 start 前多取 300 秒再裁掉（否则开头分数系统性偏低）；**D-23** 告警游标回退 30 秒（`inserted_at` 是事务开始时间，单点游标会永久跳过并发后提交的记录）；**D-24** 验收脚本按内容而非索引定位、等值到位再断言；**D-25** 注入值与目标设备匹配且只注入一台。
- **4.3 / 4.4 批的偏差 D-26 ~ D-36 同样在附录 B**。其中三条是**规格判断被实测推翻**，不记下来以后一定会再错一次：
  **D-27** hypertable 的 `pg_total_relation_size` 只量父表（24 kB，真实 930 MB），必须用 `hypertable_detailed_size`；
  **D-28** 压缩会把索引一起压小（486 → 72 MB），"索引不参与压缩"是错的；**D-30** 压缩块**可写**（TS 2.17 支持 DML）。
  **D-35** 记录了测量协议本身出过的错：查询不包 `count(*)` 时客户端格式化主导计时，据此得出的"压缩后全表扫描变慢"是假象，已作废。
- **`docs/spec_phase4.md` v0.1 草案已由作者确认 G 组九项并升 v1.0 冻结**，4.2 批后升 v1.1；后续批次按第 12 节顺序施工。
- 已裁定并写入 `docs/spec_phase2.md`（v1.1 冻结）的决策：采样 2 秒、新增 `workshops` / `production_lines` / `anomaly_injection` 三张表、第 2 阶段不启用 TimescaleDB、不做认证、告警 5 分钟冷却与 G-10 解除规则、`--backfill-days` 冷启动参数。实现与规格冲突时以规格为准。
- **7.10 与 7.14 的口径问题已在 v1.1 修正**（7.10 判定区间改为 `604800 ≤ 总数 ≤ 604900`；7.14 补「7.12 注入后 45 秒内执行」前置）。代码零改动。
- **唯一未验证项 7.15**：Windows 下无法程序化投递真 Ctrl+C，需作者手工按一次后回填结论。
