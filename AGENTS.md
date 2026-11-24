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
| `docs/方案.md` | 项目总体方案（实验方案 V1.0）：定位、架构、数据模型、12～16 周路线、验收标准、风险边界 | 已定稿 |
| `docs/spec_phase2.md` | 第 2 阶段实现规格（模拟器 + FastAPI + PostgreSQL） | **v1.1 已冻结、生效**（2026-11-24 修订 7.10 判定区间与 7.14 执行前置），第 1～8 节齐全，是第 2 阶段的唯一施工依据；代码已按此实现并跑通验收 |
| `docs/acceptance_phase2.md` | 第 2 阶段验收回归记录（7.1～7.16 逐条结论 + 命令 + 实际输出） | 已完成：14 通过 / 0 不通过 / 1 未验证（7.15 真 Ctrl+C 待人工按一次） |
| `docs/spec_phase3.md` | 第 3 阶段实现规格（React + Three.js + ECharts） | **v1.0 已冻结、生效**（2026-11-24 作者确认 C-1～C-3），第 1～13 节齐全，是第 3 阶段唯一施工依据 |
| `docs/acceptance_phase3.md` | 第 3 阶段 Batch 1 验收记录（10.1 八条命令 + 10.2 十二项人工检查） | 8 条命令全过；人工检查 1～4、8、9 已核实，5～7 待人工，10～12 属 Batch 2 |
| `frontend/` | 第 3 阶段前端（React 18 + TS 5.6 + Vite 6 + three 0.170 + ECharts 5.5） | Batch 1：三维总览 + 设备监控；`npm run test` 39 passed |
| `tests/` | 最小测试网（pytest + httpx，8 个用例） | 8 passed；依赖在 `requirements-dev.txt`，不进 `requirements.txt` |

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

## 5. 每阶段的收尾要求

一个阶段只有同时满足以下三条才算完成：

1. 规格文档里该阶段的字段、接口、验收命令全部落地；
2. 验收命令能复制执行并产生规格中写明的输出（不是"看起来能跑"）；
3. `README.md` 的"当前进度 / 如何运行"两节同步更新。

## 6. 当前状态

- 第 1 阶段（业务底座与文档）：已完成（需求文档、架构图、数据库设计、设备清单）。
- **第 2 阶段（Python 模拟器 + FastAPI + PostgreSQL）：已完成并按第 7 节验收（14 通过 / 1 未验证）。**
  交付物：`app/`（18 节接口 + 告警扫描/收敛 + WebSocket）、`data_pipeline/`（模拟器 4 参数 + 三类注入 + 订单推进 + 回填）、
  `database/`（schema / seed / reset）、`config/devices.json`、`tests/`（8 用例）。
- 当前阶段：**第 3 阶段（React + Three.js + ECharts 前端）**，施工依据 `docs/spec_phase3.md`（**v1.0 已冻结**）。分批交付见该文件第 11 节。
- **第 3 阶段 Batch 1 已完成并验收**（2026-11-24）：`frontend/` 工程骨架、数据层（api/ws/store/format）、三维场景（程序化几何 + 状态材质池 + CSS2D 标签 + 射线拾取 + 相机预设）、总览页、设备监控页、39 个前端单测。8 条验收命令全过，记录见 `docs/acceptance_phase3.md`。
- 第 3 阶段实施中产生的两处偏差已写入 `docs/spec_phase3.md` 第 12 节：**D-04** REST 改走 Vite `/api` 代理（后端无 CORS，直连必失败）、**D-05** dev 角标显示 draw call（便于脚本验收 10.1.6）。
- 已裁定并写入 `docs/spec_phase2.md`（v1.1 冻结）的决策：采样 2 秒、新增 `workshops` / `production_lines` / `anomaly_injection` 三张表、第 2 阶段不启用 TimescaleDB、不做认证、告警 5 分钟冷却与 G-10 解除规则、`--backfill-days` 冷启动参数。实现与规格冲突时以规格为准。
- **7.10 与 7.14 的口径问题已在 v1.1 修正**（7.10 判定区间改为 `604800 ≤ 总数 ≤ 604900`；7.14 补「7.12 注入后 45 秒内执行」前置）。代码零改动。
- **唯一未验证项 7.15**：Windows 下无法程序化投递真 Ctrl+C，需作者手工按一次后回填结论。
