---
title: 第 2 阶段实现规格（Python 模拟器 + FastAPI + PostgreSQL）
version: v1.1（已冻结，2026-11-24 修订 7.10 判定区间与 7.14 执行前置）
date: 2026-11-24
status: 生效
读者: 代码 agent / 本项目开发者
上游文档: docs/方案.md（实验方案 V1.0）
---

# 第 2 阶段实现规格

## 0. 本文件怎么用

- 本文件是第 2 阶段的唯一施工依据。代码 agent 只按本文件写代码，不再向作者二次提问。
- 文中的每个默认值都是可直接落成 SQL / Python 的确定值；没有"视情况而定"。
- 编号规则：`G-xx` = 必须现在定的缺口，`L-xx` = 可以以后再定的缺口。**缺口一旦确认即冻结，后续章节的字段、接口、阈值全部以冻结值为准。**
- 全文结构：第 1 节缺口清单（已冻结）、第 2 节数据字典、第 3 节设备清单、第 4 节 API 契约、第 5 节 WebSocket 消息、第 6 节模拟器规格、第 7 节验收清单、第 8 节明确不做。
- 本文件不设计第 3 阶段（Three.js）与第 4 阶段（Kafka / AI 模型训练），仅在必要处标注"预留，本阶段不实现"。

**缺口判定标准**（满足任一条即进 G 组）：

1. 不定就写不出 `CREATE TABLE` 或写不出模拟器的一个数据字段；
2. 不定会导致模拟器、后端、数据库三方口径不一致，联调时对不上；
3. 定错之后要改的地方跨两个阶段（返工成本不可控）。

---

## 1. 缺口清单

共 18 项「必须现在定」、14 项「可以以后再定」。G 组按影响从大到小排序（G-18 为冻结前补充项，影响等级等同 G-01，按编号追加在末位）。

### 1.1 必须现在定（G 组）

#### G-01 采样频率与单日数据量

- **缺什么**：方案只写"数据每隔 1～3 秒产生一条"，没有定死频率，导致数据量、索引设计、保留策略都无法估算。
- **建议默认值**：每台设备 **固定 2 秒 1 条**，14 台设备 → 7 条/秒 → **604,800 行/天**，7 天约 423 万行。
- **为什么**：1 秒/条 是 120 万行/天，本机数据库的备份、全表统计、答辩现场演示都会明显变卡；2 秒在 1 小时窗口仍有 1800 个采样点，画曲线不缺精度。
- **不确定的后果**：频率确定后再改，要同步调整索引、清理任务、前端图表点数上限、模拟器节拍四处，属于跨阶段返工；若先按 1 秒写完再降频，已灌入的 100 多万行历史数据时序间隔不一致，后续统计"单位时间产量"会失真。
- **备选**：1 秒（精度高，120 万行/天）/ **2 秒（推荐，60 万行/天）** / 5 秒（24 万行/天，但一次持续 10 秒的异常只有 2 个点，异常检测容易漏）。推荐 2 秒，因为要演示的异常持续时间通常 ≥ 10 秒，2 秒采样能拿到 5 个以上异常点，既能检出又不压垮数据库。

#### G-02 车间表与生产线表缺失

- **缺什么**：方案只有 `devices.workshop_id` / `devices.line_id` 两个字符串字段，没有车间表、生产线表，也没有外键，车间和产线是"孤儿数据"。
- **建议默认值**：新建两张表 `workshops(id, name, created_at)`、`production_lines(id, name, workshop_id, rated_capacity_per_hour, created_at)`，并给 `devices` 加 `FOREIGN KEY (workshop_id) REFERENCES workshops(id)`、`FOREIGN KEY (line_id) REFERENCES production_lines(id)`；种子数据填 2 行车间、4 行产线。
- **为什么**：车间/产线名称一旦只存在于前端的硬编码映射里，改名要改代码、无法通过接口查询，第 3 阶段的"按车间聚合"也没有表可 join。
- **不确定的后果**：第 3 阶段做三维场景分组（车间 A/B → 4 条产线）时，前端只能写死 `{'WS-A': '机加工车间'}` 这类映射；后期加第 3 个车间要同时改前端、后端、数据库三处，且旧数据无法回填车间名。
- **备选**：A. 用独立的 workshops / production_lines 表（推荐，数据完整、可 join）；B. 在 `devices` 里存车间名文本（省两张表，但改名要全表 UPDATE，且无法存产线额定产能）。推荐 A，因为产线额定产能是后面算"产能利用率"的必要字段，必须有地方存。

#### G-03 数据库引擎定稿与 TimescaleDB 启用时机

- **缺什么**：技术栈写的是 PostgreSQL + TimescaleDB，但没有说第 2 阶段是否立刻用 TimescaleDB 的 hypertable（时序表分区表），而这一步直接决定建表 SQL 怎么写。
- **建议默认值**：第 2 阶段用 **PostgreSQL 16 + 普通表 + 复合索引 `(device_id, ts DESC)`**；**不安装 TimescaleDB 扩展**；迁移到 hypertable 的动作推迟到第 4 阶段（见 L-01）。同时明确：**不采用 SQLite**，数据库只保留 PostgreSQL 一条路径。
- **为什么**：420 万行对普通表和 hypertable 的查询差异在毫秒级，收益为零；而本机要额外装扩展，`init.sql` 一旦带 `CREATE EXTENSION timescaledb`，没装扩展的机器会直接建表失败、后端起不来。
- **不确定的后果**：若第 2 阶段就用 hypertable，换台电脑演示时 `psql -f schema.sql` 报 `extension "timescaledb" is not available`，整个后端无法启动，答辩现场没有数据库就等于系统不存在；若中途改回 SQLite，`CHECK` 约束、`timestamptz`、`JSONB`、`BIGSERIAL` 全部要重写。
- **备选**：A. 普通表 + 复合索引（推荐，零依赖、可随时迁移）；B. 一开始就 hypertable（第 4 阶段省一次迁移，但当前阶段纯属增加部署门槛）。推荐 A。

#### G-04 ID 编码规则

- **缺什么**：方案给了设备编号示例（CNC-01、ROB-01），但车间、产线的 ID 规则没定，模拟器、种子 SQL、API 参数三处会各写一套。
- **建议默认值**：全部采用"大写前缀 + 连字符 + 两位序号"：车间 `WS-A` / `WS-B`；产线 `LINE-A1` / `LINE-A2` / `LINE-B1` / `LINE-B2`；设备沿用方案原值 `CNC-01…CNC-04`、`ROB-01…ROB-04`、`CONV-01`、`CONV-02`、`INSP-01`、`INSP-02`、`AIR-01`、`PUMP-01`。字段统一 `VARCHAR(16)`。
- **为什么**：方案里已有 `CNC-01` 这种两位序号写法，把同一规则扩到车间和产线，种子数据、接口参数、前端筛选三处才能直接对齐，不需要任何转换函数。
- **不确定的后果**：一边写 `CNC-1`、一边写 `CNC-01`，插入时是两条不同记录，查询按 `CNC-1` 查不到数据，表现为"设备明明有数据，接口返回空列表"，排查时最容易误判成后端 bug。

#### G-05 时间与时区口径

- **缺什么**：方案只说 `TIMESTAMPTZ`，没说模拟器生成的时间是本地时间还是 UTC，也没说接口输出格式。
- **建议默认值**：数据库存 **UTC**（`TIMESTAMPTZ`，模拟器用 `datetime.now(timezone.utc)` 生成）；API 输出 **ISO 8601 带偏移**，如 `2026-11-24T02:15:30+00:00`；前端按浏览器本地时区渲染成北京时间。数据库会话统一 `SET TIME ZONE 'UTC'`。
- **为什么**：全链路单一时间基准（UTC）后，前端只要做一次时区转换，不会出现"数据库里存的是本地时间却按 UTC 解析"这种混账问题。
- **不确定的后果**：一旦把北京时间当 UTC 写进去，前端再按本地时区 +8 转换，整条曲线凭空右移 8 小时，告警时间显示成"未来";已灌入的历史数据无法区分"当初到底按哪个时区写的"，只能整表重灌。

#### G-06 枚举字段的落地方式

- **缺什么**：`status`、`alarm_type`、`alarm_level`、`order.status` 等字段的取值方案给了，但没定用什么机制约束（PG 枚举类型 / 字符串 + CHECK / 纯字符串）。
- **建议默认值**：**`VARCHAR` + `CHECK` 约束**，例如 `status VARCHAR(16) NOT NULL CHECK (status IN ('RUNNING','IDLE','STOPPED','ALARM','MAINTENANCE'))`；Python 侧用 `str, Enum` 类与之一一对应。
- **为什么**：加一个状态值（比如 `PAUSED`）只要 `ALTER TABLE ... DROP/ADD CONSTRAINT`，一条语句即可；PG 原生 ENUM 类型加值要 `ALTER TYPE ... ADD VALUE`，且在旧版本事务里不能立即使用。
- **不确定的后果**：选 ENUM 后，第 4 阶段要给告警加 `PRESSURE` 类型，会出现"加了值但同一事务内插入报错"的诡异现象，需要写重建类型 + 改列类型的迁移脚本，属于最容易翻车的 DDL 操作。

#### G-07 指标单位与字段精度

- **缺什么**：方案给了示例值（温度 65.2、振动 2.5、电流 8.6、转速 1500），但没写单位，也没定数据库字段类型与小数位。
- **建议默认值**：

| 指标 | 字段 | 单位 | 数据库类型 | API 保留小数 |
|------|------|------|-----------|-------------|
| 温度 | temperature | ℃（摄氏度） | DOUBLE PRECISION | 1 位 |
| 振动 | vibration | mm/s（振动速度有效值） | DOUBLE PRECISION | 2 位 |
| 电流 | current | A（安培） | DOUBLE PRECISION | 2 位 |
| 转速 | speed | rpm（转/分钟） | INTEGER | 0 位 |

- **为什么**：单位不写进文档，阈值就是没有意义的数字；用 `DOUBLE PRECISION` 而不是 `NUMERIC` 是为了聚合查询快，展示层再统一 `round()`。
- **不确定的后果**：振动若一处按 mm、一处按 mm/s，正常范围会差一个数量级，告警会 100% 误报或永不触发；用 `INTEGER` 存温度会把 65.2 截断成 65，第 4 阶段模型的特征分布整体偏移。

#### G-08 各设备类型的正常范围、告警阈值与配置载体

- **缺什么**：方案只给了"一台电机"的示例值，没给 5 类设备（CNC / ROBOT / CONVEYOR / INSPECTION / AUX）各自的正常范围和告警阈值，也没定这些配置存在哪（方案写"CSV/JSON"二选一）。
- **建议默认值**：配置放 **`config/devices.json`**（一个文件，含 14 台设备的 id、类型、所属车间/产线、各指标正常区间、异常注入参数）；告警阈值由正常区间机械推导：**WARNING = 正常上限 × 1.1，CRITICAL = 正常上限 × 1.25**，推导结果写回同一文件固定下来。基线示例（完整 14 行在第 3 节给）：CNC 温度 55–70℃、振动 1.5–3.0 mm/s、电流 6–10 A、转速 1200–1800 rpm；传送带温度 35–50℃、振动 2.0–4.0 mm/s、电流 2–5 A、转速 600–1200 rpm。
- **为什么**：模拟器造数据、后端判告警、第 4 阶段打标签三者都读同一份 JSON，改阈值只改一处；JSON 支持嵌套，能一设备一区间，CSV 就得拆成三张表并保证行对齐。
- **不确定的后果**：阈值散落在模拟器、后端代码、SQL 三处，改一个忘两个，演示时会出现"温度 95℃ 但告警列表为空"的尴尬，而且不知道该信哪一份。
- **备选**：A. `config/devices.json`（推荐，可嵌套、可版本管理）；B. `config/devices.csv` + `config/thresholds.csv`（Excel 能改，但两文件必须行对齐，错一行就串设备）。推荐 A。

#### G-09 告警由谁生成、如何收敛

- **缺什么**：方案定义了 alarms 表和告警等级，但没说告警判定放在模拟器还是后端，也没说同一条告警会不会每 2 秒重复写一次。
- **建议默认值**：**后端后台任务每 5 秒**扫一次各设备最新遥测，超阈值即写 `alarms`；同一 `device_id + alarm_type` 在 **5 分钟冷却期**内只写一条，超阈值状态解除时回填 `resolved_at`。
- **为什么**：判定逻辑放后端，模拟器只管造数据，第 3 阶段换成 IoT 真数据时判定代码一行不用改；冷却期是为了防止 2 秒一条的采样把告警表写爆。
- **不确定的后果**：没有冷却期时，一台设备持续超温 1 小时会写入 1800 条相同告警（2 秒一条），一天下来 alarms 表几十万行，告警页面滚不到头，答辩时看起来像系统失控。

#### G-10 设备运行状态（running_status）的写入方

- **缺什么**：`devices.status`（设备当前状态）与 `device_telemetry.running_status`（采样点状态）两个字段都有，但没说谁改、什么时候改，两边可能互相覆盖。
- **建议默认值**：**单一写入方规则**——模拟器只写 `device_telemetry.running_status`（按场景给 RUNNING / IDLE / STOPPED）；后端只在两处改 `devices.status`：写告警时置 `ALARM`；**告警解除时必须先查该设备是否还有其它未解除告警（`SELECT count(*) FROM alarms WHERE device_id = :id AND resolved_at IS NULL`），计数为 0 才把 `devices.status` 置回 `RUNNING`**，计数 > 0 则保持 `ALARM`。`MAINTENANCE` 只由维护记录接口改。
- **为什么**：一个字段只能有一个主人，否则后写的覆盖先写的，前端状态灯会来回闪。
- **不确定的后果**：模拟器和后端都写 `devices.status` 时，模拟器每 2 秒把状态刷回 RUNNING，后端刚写的 ALARM 立刻被覆盖，表现为"告警列表有记录，但三维场景里设备永远是绿色"，第 3 阶段必然返工。

#### G-11 生产订单数据由谁生成、产量怎么涨

- **缺什么**：方案定义了 `production_orders` 字段，但没说什么程序创建订单、`actual_quantity` / `qualified_quantity` 如何递增。不定义这两列永远是 0。
- **建议默认值**：**模拟器内置订单推进器**：每产线初始各 1 张 `IN_PROGRESS` 订单，按额定产能 **30 件/小时**（即每 2 分钟 +1 件）累加 `actual_quantity`，合格率固定 **97%** 累加 `qualified_quantity`（用累加余数保证长期比例准确）；达到 `planned_quantity` 即置 `COMPLETED` 并自动生成下一张订单。
- **为什么**：产量、合格率、完成率、设备利用率四个指标全部依赖这两列，由模拟器统一推进可以保证任意时刻都能算出非零结果，演示可重复。
- **不确定的后果**：不定规则就只能手改数据库造数，第二次演示数字对不上；生产分析页所有图表是 0，第 1 阶段验收的"生产订单字段规范"也失去意义。

#### G-12 异常注入的标准答案（ground truth）怎么存

- **缺什么**：方案写了要注入温度漂移、振动突增、电流异常，但没定义"标准答案"存哪里，第 4 阶段算模型准确率时无从对照。
- **建议默认值**：新增 `anomaly_injection` 表：`id BIGSERIAL`、`device_id VARCHAR(16)`、`anomaly_type VARCHAR(16) CHECK IN ('TEMP_DRIFT','VIB_SPIKE','CURRENT_ABNORMAL')`、`started_at TIMESTAMPTZ`、`ended_at TIMESTAMPTZ`、`params JSONB`、`created_at`。模拟器**先写这条记录再开始注入**，注入结束回填 `ended_at`。
- **为什么**：模型评估必须拿"人工标注的真值"对比，事后无法从数据反推"当时是不是故意注入的"；写在数据库里还能用 SQL 直接算检出率。
- **不确定的后果**：第 2 阶段不记录，第 4 阶段只能拿模型输出自证准确率（"我的模型说这是异常，所以它是异常"），这是毕设答辩最容易被追问垮的一点，且无法补救——历史数据已经不知道哪段是注入的。

#### G-13 WebSocket 推送的内容与频率

- **缺什么**：方案说 WebSocket 推送实时数据，但没定推什么粒度、多久推一次。
- **建议默认值**：**每 1 秒推一次全厂快照**：一条消息含 14 台设备的最新遥测 + 当前状态 + 未解除告警数（约 2 KB），`type = "snapshot"`；告警新增/解除时额外立刻推一条 `type = "alarm"` 事件。
- **为什么**：14 台设备全量推只有 2 KB/s，前端一次拿到全厂状态，三维场景状态映射只需要一个渲染循环，不用为每台设备维护订阅。
- **不确定的后果**：若按"每设备每 2 秒单条推"，前端要维护 14 个订阅通道与各自的超时判断，第 3 阶段 Three.js 的设备状态更新逻辑要重写成事件驱动，改动量比第 2 阶段全部 WebSocket 代码还大。

#### G-14 认证与用户体系

- **缺什么**：方案架构图里有"用户管理"，但没说第 2 阶段是否要做登录鉴权。
- **建议默认值**：**第 2 阶段不做认证**，所有接口开放；`FastAPI` 里留一个空的 `verify_token` 依赖函数，函数体 `return None`，注释标注"预留，本阶段不实现"。
- **为什么**：单机演示没有多用户场景，先做 JWT + 密码哈希至少多花 3～5 天，而这 5 天在第 1 阶段验收清单里没有任何对应交付物。
- **不确定的后果**：若现在做鉴权，前端每个请求都要带 token、模拟器写数据要绕开鉴权或造一个服务账号，联调复杂度翻倍，且演示时还要先手动登录，增加现场出错点。

#### G-15 运行环境与依赖锁定

- **缺什么**：方案列了技术清单，但没定 Python 版本、依赖管理方式、数据库怎么跑。
- **建议默认值**：**Python 3.11** + **`requirements.txt`**（`fastapi`、`uvicorn[standard]`、`sqlalchemy`、`psycopg[binary]`、`pydantic-settings`、`pandas`，全部写死版本号）；PostgreSQL 16 用 **`docker compose` 单容器**启动，应用本身跑在本地虚拟环境（应用不容器化）。
- **为什么**：`requirements.txt` 对答辩评审最直观（一眼看到依赖），应用不容器化可以避免"改一行代码就要重建镜像"的慢循环。
- **不确定的后果**：不锁版本时，`pip install fastapi` 可能装到 0.115 配 pydantic v2，而教程代码是 pydantic v1 写法，报 `TypeError: __init__() takes exactly 1 positional argument`，新手会误以为是自己写错。
- **备选**：A. `requirements.txt`（推荐，零概念负担）；B. `poetry` / `uv`（依赖锁定更强，但多一层工具链，答辩老师不一定认）。推荐 A。

#### G-16 建表与迁移方式

- **缺什么**：方案的目录结构里有 `database/schema.sql` 和 `init.sql`，但没说表结构变更怎么管理，也没说种子数据放哪。
- **建议默认值**：**`database/schema.sql` 只建表、绝不删表**——全部使用 `CREATE TABLE IF NOT EXISTS` 与 `CREATE INDEX IF NOT EXISTS`，**文件内禁止出现任何 `DROP TABLE`**；清库重建单独放 **`database/reset.sql`**（先 `DROP TABLE IF EXISTS ... CASCADE` 按外键逆序删 8 张表，再 `\i schema.sql`、`\i seed.sql`），`README.md` 必须写明"reset.sql 会清空全部数据"；`database/seed.sql` 放 2 车间 + 4 产线 + 14 设备的固定数据；**本阶段不引入 Alembic**（迁移工具）。
- **为什么**：纯 SQL 可以在 `psql` 里逐句执行、报错行号直观；Alembic 需要"版本脚本 + 升降级"的概念，对新手是纯负担。
- **不确定的后果**：若同时存在"代码里 `Base.metadata.create_all()`"和手写 SQL 两套建表来源，字段会悄悄分叉（代码加了列、SQL 没加），重启后接口报 `column does not exist`，而表看起来"明明建过"。

#### G-17 时序查询的保护范围

- **缺什么**：方案说"用简单 API 查询设备和时序数据"，没定分页、默认时间窗口、单次返回上限。
- **建议默认值**：所有时序查询**必须带 `start` / `end`**（不传则默认最近 1 小时）；单次最多返回 **5000 个点**，超出按"每 N 条取 1 条"降采样（N = ceil(总点数 / 5000)）；列表类接口统一 `page` / `page_size`，`page_size` 默认 50、上限 200。
- **为什么**：2 秒采样下 1 小时 = 1800 点/设备，5000 点上限可覆盖单设备 5000 × 2 秒 ≈ **2.8 小时**，或全厂 14 台合计 5000 行 ÷ 7 条/秒 ≈ **12 分钟**，足够演示；有上限才不会一次把 400 万行拉进内存。
- **不确定的后果**：没有上限时，前端一个"查询全部历史"的请求会让 uvicorn 进程内存暴涨被系统 kill，现象是"服务用着用着自己挂了、没有任何报错"，排查方向完全跑偏。

#### G-18 历史数据冷启动

- **缺什么**：模拟器从当前时刻开始写，则系统刚启动时"最近 7 天趋势""历史告警"全为空，任何演示或模型训练前都要干等几小时；方案未定义如何补历史数据。
- **建议默认值**：模拟器提供 **`--backfill-days N`** 参数，**默认 0（= 只从当前时刻开始写）**；`N > 0` 时按 **2 秒间隔倒推生成 N 天历史数据**（先写入历史，再切回实时节奏），且该区间内注入的异常事件，其 `anomaly_injection.started_at` / `ended_at` 必须落在历史区间内，不得出现"注入记录在 3 天前、注入效果在现在"。
- **为什么**：N 天历史让趋势图、告警列表、模型训练集在系统第一次启动时就有内容，省掉"挂机等数据"的等待；把注入事件一起回填，第 4 阶段才能拿历史区间做训练/评估。
- **不确定的后果**：没有该参数时，演示前必须让模拟器连续跑够时间（7 天历史 = 604,800 行 = 不现实），只能临时改代码造数；若只回填遥测而不回填注入记录，第 4 阶段会把"历史里那段异常"当成正常数据学进去，模型准确率虚高且找不出原因。
- **数据量参考**：`--backfill-days 1` = 每设备 43,200 条 × 14 台 = **604,800 行**；`--backfill-days 7` = 4,233,600 行。回填走批量接口（每批 5000 行），1 天数据预计 60～120 秒完成。

### 1.2 可以以后再定（L 组）

以下 14 项不阻断第 2 阶段编码，先按"占位默认"实现，等触发条件出现再定稿。按影响从大到小排序。

#### L-01 TimescaleDB hypertable 迁移

- **缺什么**：什么时候把 `device_telemetry` 换成 hypertable。
- **占位默认**：第 2 阶段不启用；`CREATE TABLE` 语句结构保持"单表 + `(device_id, ts)` 复合索引"，迁移只需两条 SQL。
- **为什么**：当前 420 万行规模下 hypertable 无收益。
- **触发条件**：遥测表超过 **5000 万行**（约 80 天 2 秒采样）或单次聚合查询超过 2 秒时执行迁移。

#### L-02 Kafka 替换模拟器接入

- **缺什么**：数据接入层何时从"HTTP 直写"换成 Kafka。
- **占位默认**：模拟器直接 `POST /api/v1/telemetry`；后端写库函数 `save_telemetry()` 单独一层，将来 Kafka 消费者复用它。
- **为什么**：单机 7 条/秒用 Kafka 是纯负担（还要起 Zookeeper）。
- **触发条件**：第 4 阶段，或模拟器与后端拆到两台机器时。

#### L-03 数据保留与降采样策略

- **缺什么**：遥测数据保留多久、是否做分钟级降采样。
- **占位默认**：保留全部，不删除；清理逻辑留一个空的 `cleanup_old_telemetry()` 函数并注释"预留，本阶段不实现"。
- **为什么**：7 天 423 万行对 PostgreSQL 毫无压力，先删数据反而让演示时查不到历史。
- **触发条件**：单库超过 20 GB 或演示需要 30 天以上趋势时。

#### L-04 告警通知渠道

- **缺什么**：告警是否要发邮件 / 企业微信 / 钉钉。
- **占位默认**：只写 `alarms` 表并通过 WebSocket 推送，不对外发通知。
- **为什么**：第 2 阶段验收只要求"能查到告警"，外部通知需要额外账号与网络配置。
- **触发条件**：需要演示"手机收到告警"时。

#### L-05 Redis 缓存

- **缺什么**：最新遥测是否走缓存。
- **占位默认**：不做缓存，`/devices/latest` 直接查库（14 台设备，`DISTINCT ON` 查询毫秒级）。
- **为什么**：数据量与并发都远未到需要缓存的量级。
- **触发条件**：接口 P95 超过 200 ms，或并发客户端超过 20 个。

#### L-06 订单排产算法

- **缺什么**：多订单如何分配到 4 条产线。
- **占位默认**：**先到先服务（FCFS）** + 按空闲产线顺序分配，写在模拟器内。
- **为什么**：排产算法不是第 2 阶段验收项，先保证有数据流动。
- **触发条件**：需要演示"订单延期预警"时再设计。

#### L-07 维护记录的自动触发

- **缺什么**：`maintenance_records` 什么时候自动生成。
- **占位默认**：只提供手工 `POST /api/v1/maintenance` 接口，不自动创建。
- **为什么**：自动触发依赖故障判定规则，属于第 4 阶段模型范畴。
- **触发条件**：故障风险模型上线后由模型输出触发。

#### L-08 前端图表刷新与降采样

- **缺什么**：图表多久刷新、多少点。
- **占位默认**：第 2 阶段不涉及前端；给第 3 阶段的建议值是"WebSocket 快照 1 秒刷新，曲线用 5 分钟窗口 150 点"。
- **为什么**：属于第 3 阶段工作。
- **触发条件**：第 3 阶段开始。

#### L-09 用户与权限角色

- **缺什么**：是否区分管理员 / 操作员。
- **占位默认**：无用户表，单用户使用。
- **为什么**：单机演示不需要。
- **触发条件**：部署到服务器供多人访问时（此时先建 `users` 表 + 角色字段）。

#### L-10 API 限流与审计日志

- **缺什么**：限流、请求审计。
- **占位默认**：不限流，只打访问日志（uvicorn 默认）。
- **为什么**：单客户端场景，限流没有实际保护对象。
- **触发条件**：公网部署前必须补。

#### L-11 三维资产与 LOD

- **缺什么**：设备模型精度分级、模型文件格式。
- **占位默认**：第 2 阶段不涉及；预留 `factory_models/` 目录。
- **为什么**：属于第 3 阶段。
- **触发条件**：第 3 阶段建模时。

#### L-12 AI 特征窗口与评估口径

- **缺什么**：异常检测用多长窗口（如 30 秒 / 5 分钟）、用哪些统计量。
- **占位默认**：第 2 阶段只保证 `device_telemetry` 与 `anomaly_injection` 数据齐全，窗口长度不定。
- **为什么**：窗口长度取决于模型选择，第 4 阶段实验确定。
- **触发条件**：第 4 阶段建模时。

#### L-13 备份与恢复

- **缺什么**：数据库备份频率与存放位置。
- **占位默认**：答辩前手工 `pg_dump` 一份到 `backup/` 目录；不写定时任务。
- **为什么**：演示数据可由模拟器重放生成，备份不是关键路径。
- **触发条件**：接入真实数据后。

#### L-14 国际化与主题

- **缺什么**：界面语言、暗色主题。
- **占位默认**：仅中文、单主题。
- **为什么**：与第 2 阶段无关。
- **触发条件**：无。

---

## 冻结记录（v1.0，2026-11-24）

第 1 节 18 项 G 组全部确认，本次冻结同时采纳 5 处修订：

1. **G-17 算术修正**：全厂 14 台合计 5000 行 ≈ 12 分钟（7 条/秒）；单设备 5000 点 = 2.8 小时。
2. **新增 G-18 历史数据冷启动**：`--backfill-days N`，默认 0。
3. **G-16 修订**：`schema.sql` 只建表、禁止 `DROP TABLE`；新增 `database/reset.sql` 专用于清库重建，README 必须警示。
4. **G-10 修订**：告警解除前必须先确认该设备没有其它未解除告警，全部解除才置回 `RUNNING`。
5. **第 6 节补模拟器运行形态**：`--devices` / `--rate` / `--duration` / `--backfill-days`，默认常驻，`Ctrl+C` 优雅退出并打印写入统计。

冻结后，第 2～8 节的全部字段、接口、阈值以此为准。任何新增或变更只能以版本升级的方式提出，不得静默修改。

---

## 修订记录（v1.1，2026-11-24）

来源：`docs/acceptance_phase2.md` 的实测回归。v1.0 中两处验收条文与代码实际行为不一致，**代码无缺陷，是条文本身有误**，故只改条文，不动任何设计决策与实现。

1. **7.10 判定区间修正（算术错误）**：v1.0 写成「604,800 + 210 + 28~42 ≈ 605,045，区间 604900~605200」，把 7.8 已写入的 210 行重复计了一次。实际那 210 行的时间戳落在本次回填的 24 小时区间内，被 `ON CONFLICT (device_id, ts)` 去重，不计入总数。正确关系为 **回填新增 604,590 + 重复 210 = 604,800**（整段栅格），再加本步实时 28~42 行，总数约 **604,828**。判定区间改为 `604800 ≤ 结果 ≤ 604900`。
2. **7.14 补执行前置**：实测发现按 v1.0 的顺序执行（7.12 注入 → 7.13 WebSocket → 7.14 解除），温度告警会在 7.14 之前被收敛任务自动解除，分支一取不到 `open_alarm_count = 1`。原因是 7.12 的第二条数据 `temperature=65.0` 低于预警阈值 70，95℃ 采样点滑出「最近 60 秒」窗口后，窗口峰值只剩 65℃。故补「必须在 7.12 注入后 45 秒内执行」的前置条件，并给出超时后的补救动作。

除上述两条外，v1.0 的其余条文全部保持不变，继续有效。

---

## 2. 数据字典

### 2.0 全表约定

- 表名、字段名一律 snake_case（小写 + 下划线）；主键统一命名 `<表名单数>_id`，自增主键统一 `BIGSERIAL`。
- 时间一律 `TIMESTAMPTZ` 存 UTC；金额 `NUMERIC(10,2)`；测量值 `DOUBLE PRECISION`（转速用 `INTEGER`）。
- 所有建表语句用 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`，**schema.sql 内禁止出现 `DROP`**（见 G-16）。
- **与方案文档的一处字段改名（必须知道）**：方案里 `device_telemetry.timestamp` 在本规格中改名为 **`ts`**。原因：`timestamp` 是 SQL 保留字，写查询必须写成 `"timestamp"` 加双引号，漏引号就报语法错误，新手排查成本极高。语义不变。
- 相比方案新增三张表：`workshops`、`production_lines`（G-02 补全层级）、`anomaly_injection`（G-12 存异常真值）。

### 2.1 workshops（车间表）

| 字段名 | 类型 | 可空 | 默认 | 约束 | 说明 | 示例 |
|---|---|---|---|---|---|---|
| id | VARCHAR(16) | 否 | — | PRIMARY KEY | 车间编号，规则见 G-04 | `WS-A` |
| name | VARCHAR(64) | 否 | — | — | 车间名称 | `机加工车间` |
| created_at | TIMESTAMPTZ | 否 | `now()` | — | 创建时间（UTC） | `2026-11-24T02:15:30+00:00` |

```sql
CREATE TABLE IF NOT EXISTS workshops (
    id          VARCHAR(16)  PRIMARY KEY,
    name        VARCHAR(64)  NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
COMMENT ON TABLE  workshops        IS '车间表';
COMMENT ON COLUMN workshops.id     IS '车间编号，如 WS-A';
COMMENT ON COLUMN workshops.name   IS '车间名称';
```

### 2.2 production_lines（生产线表）

| 字段名 | 类型 | 可空 | 默认 | 约束 | 说明 | 示例 |
|---|---|---|---|---|---|---|
| id | VARCHAR(16) | 否 | — | PRIMARY KEY | 产线编号 | `LINE-A1` |
| name | VARCHAR(64) | 否 | — | — | 产线名称 | `生产线 A1` |
| workshop_id | VARCHAR(16) | 否 | — | FK → workshops(id) | 所属车间 | `WS-A` |
| rated_capacity_per_hour | INTEGER | 否 | 30 | CHECK > 0 | 额定产能（件/小时），用于算产能利用率 | `30` |
| created_at | TIMESTAMPTZ | 否 | `now()` | — | 创建时间 | `2026-11-24T02:15:30+00:00` |

```sql
CREATE TABLE IF NOT EXISTS production_lines (
    id                       VARCHAR(16)  PRIMARY KEY,
    name                     VARCHAR(64)  NOT NULL,
    workshop_id              VARCHAR(16)  NOT NULL,
    rated_capacity_per_hour  INTEGER      NOT NULL DEFAULT 30
                             CHECK (rated_capacity_per_hour > 0),
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT fk_lines_workshop FOREIGN KEY (workshop_id)
        REFERENCES workshops (id) ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_lines_workshop ON production_lines (workshop_id);
COMMENT ON TABLE  production_lines                          IS '生产线表';
COMMENT ON COLUMN production_lines.rated_capacity_per_hour  IS '额定产能，件/小时';
```

### 2.3 devices（设备基础表）

| 字段名 | 类型 | 可空 | 默认 | 约束 | 说明 | 示例 |
|---|---|---|---|---|---|---|
| device_id | VARCHAR(16) | 否 | — | PRIMARY KEY | 设备编号 | `CNC-01` |
| device_name | VARCHAR(64) | 否 | — | — | 设备名称 | `数控机床 1` |
| device_type | VARCHAR(16) | 否 | — | CHECK 枚举 | 设备类型 | `CNC` |
| workshop_id | VARCHAR(16) | 是 | NULL | FK → workshops(id) | 所属车间；辅助设备为 NULL | `WS-A` |
| line_id | VARCHAR(16) | 是 | NULL | FK → production_lines(id) | 所属产线；辅助设备为 NULL | `LINE-A1` |
| model | VARCHAR(64) | 是 | NULL | — | 设备型号 | `VMC-850` |
| status | VARCHAR(16) | 否 | `IDLE` | CHECK 枚举 | 设备当前状态（只由后端改，见 G-10） | `RUNNING` |
| installed_at | TIMESTAMPTZ | 是 | NULL | — | 安装时间 | `2025-06-01T00:00:00+00:00` |
| created_at | TIMESTAMPTZ | 否 | `now()` | — | 创建时间 | `2026-11-24T02:15:30+00:00` |

`device_type` 枚举：`CNC`（数控机床）、`ROBOT`（机械臂）、`CONVEYOR`（传送带）、`INSPECTION`（自动检测台）、`AUX`（辅助设备）。
`status` 枚举：`RUNNING`、`IDLE`、`STOPPED`、`ALARM`、`MAINTENANCE`。

```sql
CREATE TABLE IF NOT EXISTS devices (
    device_id     VARCHAR(16)  PRIMARY KEY,
    device_name   VARCHAR(64)  NOT NULL,
    device_type   VARCHAR(16)  NOT NULL
                  CHECK (device_type IN ('CNC','ROBOT','CONVEYOR','INSPECTION','AUX')),
    workshop_id   VARCHAR(16)  NULL,
    line_id       VARCHAR(16)  NULL,
    model         VARCHAR(64)  NULL,
    status        VARCHAR(16)  NOT NULL DEFAULT 'IDLE'
                  CHECK (status IN ('RUNNING','IDLE','STOPPED','ALARM','MAINTENANCE')),
    installed_at  TIMESTAMPTZ  NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT fk_devices_workshop FOREIGN KEY (workshop_id)
        REFERENCES workshops (id) ON UPDATE CASCADE,
    CONSTRAINT fk_devices_line FOREIGN KEY (line_id)
        REFERENCES production_lines (id) ON UPDATE CASCADE,
    CONSTRAINT ck_devices_aux_no_line CHECK (device_type <> 'AUX' OR line_id IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_devices_line     ON devices (line_id);
CREATE INDEX IF NOT EXISTS idx_devices_workshop ON devices (workshop_id);
CREATE INDEX IF NOT EXISTS idx_devices_status   ON devices (status);
COMMENT ON TABLE  devices             IS '设备基础表，14 台';
COMMENT ON COLUMN devices.status      IS '当前状态，仅后端可写：告警置 ALARM，全部告警解除回 RUNNING，维护记录置 MAINTENANCE';
COMMENT ON COLUMN devices.workshop_id IS '辅助设备（AIR-01/PUMP-01）为全厂公用，此处为 NULL';
```

### 2.4 device_telemetry（设备时序数据表）

| 字段名 | 类型 | 可空 | 默认 | 约束 | 说明 | 示例 |
|---|---|---|---|---|---|---|
| id | BIGSERIAL | 否 | 自增 | PRIMARY KEY | 主键 | `123456` |
| device_id | VARCHAR(16) | 否 | — | FK → devices(device_id) | 设备编号 | `CNC-01` |
| ts | TIMESTAMPTZ | 否 | — | UNIQUE(device_id, ts) | 采集时间（UTC，2 秒栅格） | `2026-11-24T02:15:30+00:00` |
| temperature | DOUBLE PRECISION | 否 | — | CHECK −20 ~ 300 | 温度，单位 ℃，API 保留 1 位 | `65.2` |
| vibration | DOUBLE PRECISION | 否 | — | CHECK 0 ~ 100 | 振动速度有效值，单位 mm/s，API 保留 2 位 | `2.50` |
| current | DOUBLE PRECISION | 否 | — | CHECK 0 ~ 500 | 电流，单位 A，API 保留 2 位 | `8.62` |
| speed | INTEGER | 否 | — | CHECK ≥ 0 | 转速，单位 rpm | `1500` |
| running_status | VARCHAR(16) | 否 | — | CHECK 枚举 | 采样点状态（只由模拟器写） | `RUNNING` |
| inserted_at | TIMESTAMPTZ | 否 | `now()` | — | 写入数据库的时间，用于排查延迟 | `2026-11-24T02:15:31+00:00` |

`running_status` 枚举：`RUNNING`、`IDLE`、`STOPPED`（注意：采样点状态不含 `ALARM` / `MAINTENANCE`，那两个是设备级状态，见 G-10）。

```sql
CREATE TABLE IF NOT EXISTS device_telemetry (
    id              BIGSERIAL        PRIMARY KEY,
    device_id       VARCHAR(16)      NOT NULL,
    ts              TIMESTAMPTZ      NOT NULL,
    temperature     DOUBLE PRECISION NOT NULL CHECK (temperature BETWEEN -20 AND 300),
    vibration       DOUBLE PRECISION NOT NULL CHECK (vibration BETWEEN 0 AND 100),
    current         DOUBLE PRECISION NOT NULL CHECK (current BETWEEN 0 AND 500),
    speed           INTEGER          NOT NULL CHECK (speed >= 0),
    running_status  VARCHAR(16)      NOT NULL
                    CHECK (running_status IN ('RUNNING','IDLE','STOPPED')),
    inserted_at     TIMESTAMPTZ      NOT NULL DEFAULT now(),
    CONSTRAINT fk_telemetry_device FOREIGN KEY (device_id)
        REFERENCES devices (device_id) ON DELETE CASCADE,
    CONSTRAINT uq_telemetry_device_ts UNIQUE (device_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_telemetry_device_ts ON device_telemetry (device_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_ts        ON device_telemetry (ts DESC);
COMMENT ON TABLE  device_telemetry      IS '设备时序数据，2 秒一条，本阶段为普通表（未启用 hypertable，见 L-01）';
COMMENT ON COLUMN device_telemetry.ts   IS '采样时间，UTC；原方案字段名 timestamp 因是保留字改为 ts';
COMMENT ON COLUMN device_telemetry.vibration IS '振动速度有效值 mm/s';
```

### 2.5 production_orders（生产订单表）

| 字段名 | 类型 | 可空 | 默认 | 约束 | 说明 | 示例 |
|---|---|---|---|---|---|---|
| order_id | VARCHAR(32) | 否 | — | PRIMARY KEY | 订单编号 | `ORD-20261124-0001` |
| product_id | VARCHAR(32) | 否 | — | — | 产品编号 | `PRD-A-001` |
| planned_quantity | INTEGER | 否 | — | CHECK > 0 | 计划数量（件） | `120` |
| actual_quantity | INTEGER | 否 | 0 | CHECK ≥ 0 | 实际数量（件） | `87` |
| qualified_quantity | INTEGER | 否 | 0 | CHECK 0 ~ actual | 合格数量（件） | `84` |
| line_id | VARCHAR(16) | 否 | — | FK → production_lines(id) | 生产线 | `LINE-A1` |
| planned_start | TIMESTAMPTZ | 否 | — | — | 计划开始 | `2026-11-24T00:00:00+00:00` |
| planned_end | TIMESTAMPTZ | 否 | — | CHECK > planned_start | 计划结束 | `2026-11-24T04:00:00+00:00` |
| status | VARCHAR(16) | 否 | `PLANNED` | CHECK 枚举 | 订单状态 | `IN_PROGRESS` |
| created_at | TIMESTAMPTZ | 否 | `now()` | — | 创建时间 | `2026-11-24T02:15:30+00:00` |

`status` 枚举：`PLANNED`、`IN_PROGRESS`、`COMPLETED`、`DELAYED`。

```sql
CREATE TABLE IF NOT EXISTS production_orders (
    order_id            VARCHAR(32)  PRIMARY KEY,
    product_id          VARCHAR(32)  NOT NULL,
    planned_quantity    INTEGER      NOT NULL CHECK (planned_quantity > 0),
    actual_quantity     INTEGER      NOT NULL DEFAULT 0 CHECK (actual_quantity >= 0),
    qualified_quantity  INTEGER      NOT NULL DEFAULT 0 CHECK (qualified_quantity >= 0),
    line_id             VARCHAR(16)  NOT NULL,
    planned_start       TIMESTAMPTZ  NOT NULL,
    planned_end         TIMESTAMPTZ  NOT NULL,
    status              VARCHAR(16)  NOT NULL DEFAULT 'PLANNED'
                        CHECK (status IN ('PLANNED','IN_PROGRESS','COMPLETED','DELAYED')),
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT fk_orders_line FOREIGN KEY (line_id)
        REFERENCES production_lines (id) ON UPDATE CASCADE,
    CONSTRAINT ck_orders_qty  CHECK (qualified_quantity <= actual_quantity),
    CONSTRAINT ck_orders_time CHECK (planned_end > planned_start)
);
CREATE INDEX IF NOT EXISTS idx_orders_line_status ON production_orders (line_id, status);
COMMENT ON TABLE production_orders IS '生产订单表，由模拟器订单推进器维护计数';
```

### 2.6 alarms（告警表）

| 字段名 | 类型 | 可空 | 默认 | 约束 | 说明 | 示例 |
|---|---|---|---|---|---|---|
| alarm_id | BIGSERIAL | 否 | 自增 | PRIMARY KEY | 告警编号 | `12` |
| device_id | VARCHAR(16) | 否 | — | FK → devices(device_id) | 设备编号 | `CNC-01` |
| alarm_type | VARCHAR(24) | 否 | — | CHECK 枚举 | 告警类型 | `TEMPERATURE` |
| alarm_level | VARCHAR(16) | 否 | — | CHECK 枚举 | 告警等级 | `WARNING` |
| message | TEXT | 否 | — | — | 告警说明（中文，可读） | `CNC-01 温度 78.4℃ 超过预警阈值 77.0℃` |
| detected_at | TIMESTAMPTZ | 否 | `now()` | — | 检出时间 | `2026-11-24T02:20:00+00:00` |
| resolved_at | TIMESTAMPTZ | 是 | NULL | CHECK ≥ detected_at | 解除时间，NULL = 未解除 | `2026-11-24T02:26:00+00:00` |

`alarm_type` 枚举：`TEMPERATURE`、`VIBRATION`、`CURRENT`、`STATUS`（**转速不产生告警**，仅用于图表）。
`alarm_level` 枚举：`INFO`、`WARNING`、`CRITICAL`。

```sql
CREATE TABLE IF NOT EXISTS alarms (
    alarm_id     BIGSERIAL    PRIMARY KEY,
    device_id    VARCHAR(16)  NOT NULL,
    alarm_type   VARCHAR(24)  NOT NULL
                 CHECK (alarm_type IN ('TEMPERATURE','VIBRATION','CURRENT','STATUS')),
    alarm_level  VARCHAR(16)  NOT NULL
                 CHECK (alarm_level IN ('INFO','WARNING','CRITICAL')),
    message      TEXT         NOT NULL,
    detected_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    resolved_at  TIMESTAMPTZ  NULL,
    CONSTRAINT fk_alarms_device FOREIGN KEY (device_id)
        REFERENCES devices (device_id) ON DELETE CASCADE,
    CONSTRAINT ck_alarms_resolved CHECK (resolved_at IS NULL OR resolved_at >= detected_at)
);
CREATE INDEX IF NOT EXISTS idx_alarms_open ON alarms (device_id, alarm_type) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_alarms_time ON alarms (detected_at DESC);
COMMENT ON TABLE alarms IS '告警表，同一设备同一类型 5 分钟冷却（见 G-09）';
```

### 2.7 maintenance_records（维护记录表）

| 字段名 | 类型 | 可空 | 默认 | 约束 | 说明 | 示例 |
|---|---|---|---|---|---|---|
| record_id | BIGSERIAL | 否 | 自增 | PRIMARY KEY | 记录编号 | `5` |
| device_id | VARCHAR(16) | 否 | — | FK → devices(device_id) | 设备编号 | `ROB-02` |
| maintenance_type | VARCHAR(16) | 否 | — | CHECK 枚举 | 维护类型 | `ROUTINE` |
| description | TEXT | 是 | NULL | — | 维护说明 | `更换 3 号关节润滑脂` |
| started_at | TIMESTAMPTZ | 否 | — | — | 开始时间 | `2026-11-24T01:00:00+00:00` |
| finished_at | TIMESTAMPTZ | 是 | NULL | CHECK ≥ started_at | 结束时间，NULL = 进行中 | `2026-11-24T02:30:00+00:00` |
| cost | NUMERIC(10,2) | 是 | NULL | CHECK ≥ 0 | 维护成本（元） | `1200.00` |
| created_at | TIMESTAMPTZ | 否 | `now()` | — | 创建时间 | `2026-11-24T01:00:05+00:00` |

`maintenance_type` 枚举：`ROUTINE`（例行保养）、`REPAIR`（维修）、`INSPECTION`（点检）。

```sql
CREATE TABLE IF NOT EXISTS maintenance_records (
    record_id         BIGSERIAL     PRIMARY KEY,
    device_id         VARCHAR(16)   NOT NULL,
    maintenance_type  VARCHAR(16)   NOT NULL
                      CHECK (maintenance_type IN ('ROUTINE','REPAIR','INSPECTION')),
    description       TEXT          NULL,
    started_at        TIMESTAMPTZ   NOT NULL,
    finished_at       TIMESTAMPTZ   NULL,
    cost              NUMERIC(10,2) NULL CHECK (cost >= 0),
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT fk_maint_device FOREIGN KEY (device_id)
        REFERENCES devices (device_id) ON DELETE CASCADE,
    CONSTRAINT ck_maint_time CHECK (finished_at IS NULL OR finished_at >= started_at)
);
CREATE INDEX IF NOT EXISTS idx_maint_device ON maintenance_records (device_id, started_at DESC);
COMMENT ON TABLE maintenance_records IS '维护记录表，本阶段仅手工写入（自动触发预留，见 L-07）';
```

### 2.8 anomaly_injection（异常注入真值表）

| 字段名 | 类型 | 可空 | 默认 | 约束 | 说明 | 示例 |
|---|---|---|---|---|---|---|
| id | BIGSERIAL | 否 | 自增 | PRIMARY KEY | 记录编号 | `3` |
| device_id | VARCHAR(16) | 否 | — | FK → devices(device_id) | 设备编号 | `CNC-02` |
| anomaly_type | VARCHAR(24) | 否 | — | CHECK 枚举 | 异常类型 | `VIB_SPIKE` |
| started_at | TIMESTAMPTZ | 否 | — | — | 注入开始 | `2026-11-24T02:10:00+00:00` |
| ended_at | TIMESTAMPTZ | 是 | NULL | CHECK ≥ started_at | 注入结束，NULL = 进行中 | `2026-11-24T02:10:40+00:00` |
| params | JSONB | 否 | `'{}'` | — | 注入参数（幅度、时长等） | `{"amp": 5.0, "sigma": 0.8}` |
| created_at | TIMESTAMPTZ | 否 | `now()` | — | 创建时间 | `2026-11-24T02:09:58+00:00` |

`anomaly_type` 枚举：`TEMP_DRIFT`、`VIB_SPIKE`、`CURRENT_ABNORMAL`（参数定义见 3.3）。

```sql
CREATE TABLE IF NOT EXISTS anomaly_injection (
    id            BIGSERIAL    PRIMARY KEY,
    device_id     VARCHAR(16)  NOT NULL,
    anomaly_type  VARCHAR(24)  NOT NULL
                  CHECK (anomaly_type IN ('TEMP_DRIFT','VIB_SPIKE','CURRENT_ABNORMAL')),
    started_at    TIMESTAMPTZ  NOT NULL,
    ended_at      TIMESTAMPTZ  NULL,
    params        JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT fk_anomaly_device FOREIGN KEY (device_id)
        REFERENCES devices (device_id) ON DELETE CASCADE,
    CONSTRAINT ck_anomaly_time CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX IF NOT EXISTS idx_anomaly_device_time ON anomaly_injection (device_id, started_at);
COMMENT ON TABLE anomaly_injection IS '异常注入真值表，第 4 阶段模型评估的对照标签，本阶段只写不用';
```

### 2.9 种子数据（database/seed.sql）

外键顺序：workshops → production_lines → devices。全部用 `ON CONFLICT DO NOTHING`，可重复执行。

```sql
-- 1) 车间
INSERT INTO workshops (id, name) VALUES
    ('WS-A', '机加工车间'),
    ('WS-B', '检测与装配车间')
ON CONFLICT (id) DO NOTHING;

-- 2) 生产线
INSERT INTO production_lines (id, name, workshop_id, rated_capacity_per_hour) VALUES
    ('LINE-A1', '生产线 A1', 'WS-A', 30),
    ('LINE-A2', '生产线 A2', 'WS-A', 30),
    ('LINE-B1', '生产线 B1', 'WS-B', 30),
    ('LINE-B2', '生产线 B2', 'WS-B', 30)
ON CONFLICT (id) DO NOTHING;

-- 3) 设备（14 台：12 台核心 + 2 台辅助）
INSERT INTO devices (device_id, device_name, device_type, workshop_id, line_id, model, status, installed_at) VALUES
    ('CNC-01',  '数控机床 1',   'CNC',        'WS-A', 'LINE-A1', 'VMC-850',  'RUNNING', '2025-06-01T00:00:00+00:00'),
    ('ROB-01',  '机械臂 1',     'ROBOT',      'WS-A', 'LINE-A1', 'IRB-1200', 'RUNNING', '2025-06-01T00:00:00+00:00'),
    ('CONV-01', '传送带 1',     'CONVEYOR',   'WS-A', 'LINE-A1', 'BELT-6M',  'RUNNING', '2025-06-01T00:00:00+00:00'),
    ('CNC-02',  '数控机床 2',   'CNC',        'WS-A', 'LINE-A2', 'VMC-850',  'RUNNING', '2025-06-01T00:00:00+00:00'),
    ('ROB-02',  '机械臂 2',     'ROBOT',      'WS-A', 'LINE-A2', 'IRB-1200', 'RUNNING', '2025-06-01T00:00:00+00:00'),
    ('CONV-02', '传送带 2',     'CONVEYOR',   'WS-A', 'LINE-A2', 'BELT-6M',  'RUNNING', '2025-06-01T00:00:00+00:00'),
    ('CNC-03',  '数控机床 3',   'CNC',        'WS-B', 'LINE-B1', 'VMC-850',  'RUNNING', '2025-06-01T00:00:00+00:00'),
    ('ROB-03',  '机械臂 3',     'ROBOT',      'WS-B', 'LINE-B1', 'IRB-1200', 'RUNNING', '2025-06-01T00:00:00+00:00'),
    ('INSP-01', '自动检测台 1', 'INSPECTION', 'WS-B', 'LINE-B1', 'VIS-200',  'RUNNING', '2025-06-01T00:00:00+00:00'),
    ('CNC-04',  '数控机床 4',   'CNC',        'WS-B', 'LINE-B2', 'VMC-850',  'RUNNING', '2025-06-01T00:00:00+00:00'),
    ('ROB-04',  '机械臂 4',     'ROBOT',      'WS-B', 'LINE-B2', 'IRB-1200', 'RUNNING', '2025-06-01T00:00:00+00:00'),
    ('INSP-02', '自动检测台 2', 'INSPECTION', 'WS-B', 'LINE-B2', 'VIS-200',  'RUNNING', '2025-06-01T00:00:00+00:00'),
    ('AIR-01',  '空压机',       'AUX',        NULL,   NULL,      'GA-15',    'RUNNING', '2025-06-01T00:00:00+00:00'),
    ('PUMP-01', '冷却泵',       'AUX',        NULL,   NULL,      'CP-50',    'RUNNING', '2025-06-01T00:00:00+00:00')
ON CONFLICT (device_id) DO NOTHING;
```

> 初始 `status` 统一置 `RUNNING`：模拟器不写该字段（G-10），若初始置 `IDLE`，在第一次告警发生之前设备会一直显示为停机型状态，演示效果不对。

## 3. 设备清单

### 3.1 口径说明

- 正常区间 = 设备**健康运行时**的目标波动范围，模拟器按此生成数据；它不是安全标准，也不是告警阈值。
- 告警阈值 = **正常上限 × 1.1（WARNING）** 与 **正常上限 × 1.25（CRITICAL）**，见 3.2 推导表。
- 单位：温度 ℃、振动 mm/s、电流 A、转速 rpm。**转速只做图表，不产生告警**。
- 14 台设备分属 5 种类型（AUX 下分空压机与冷却泵两种基线）。

### 3.2 设备总表

| device_id | 类型 | 车间 | 产线 | 温度 ℃ | 振动 mm/s | 电流 A | 转速 rpm | 异常注入方式 |
|---|---|---|---|---|---|---|---|---|
| CNC-01 | CNC 数控机床 | WS-A | LINE-A1 | 55–70 | 1.5–3.0 | 6–10 | 1200–1800 | TEMP_DRIFT |
| ROB-01 | ROBOT 机械臂 | WS-A | LINE-A1 | 40–55 | 1.0–2.5 | 3–6 | 15–45 | VIB_SPIKE |
| CONV-01 | CONVEYOR 传送带 | WS-A | LINE-A1 | 35–50 | 2.0–4.0 | 2–5 | 600–1200 | CURRENT_ABNORMAL |
| CNC-02 | CNC 数控机床 | WS-A | LINE-A2 | 55–70 | 1.5–3.0 | 6–10 | 1200–1800 | VIB_SPIKE |
| ROB-02 | ROBOT 机械臂 | WS-A | LINE-A2 | 40–55 | 1.0–2.5 | 3–6 | 15–45 | CURRENT_ABNORMAL |
| CONV-02 | CONVEYOR 传送带 | WS-A | LINE-A2 | 35–50 | 2.0–4.0 | 2–5 | 600–1200 | VIB_SPIKE |
| CNC-03 | CNC 数控机床 | WS-B | LINE-B1 | 55–70 | 1.5–3.0 | 6–10 | 1200–1800 | CURRENT_ABNORMAL |
| ROB-03 | ROBOT 机械臂 | WS-B | LINE-B1 | 40–55 | 1.0–2.5 | 3–6 | 15–45 | TEMP_DRIFT |
| INSP-01 | INSPECTION 检测台 | WS-B | LINE-B1 | 30–45 | 0.5–1.5 | 1–3 | 5–20 | TEMP_DRIFT |
| CNC-04 | CNC 数控机床 | WS-B | LINE-B2 | 55–70 | 1.5–3.0 | 6–10 | 1200–1800 | TEMP_DRIFT |
| ROB-04 | ROBOT 机械臂 | WS-B | LINE-B2 | 40–55 | 1.0–2.5 | 3–6 | 15–45 | VIB_SPIKE |
| INSP-02 | INSPECTION 检测台 | WS-B | LINE-B2 | 30–45 | 0.5–1.5 | 1–3 | 5–20 | CURRENT_ABNORMAL |
| AIR-01 | AUX 空压机 | —（全厂） | — | 60–85 | 2.5–5.0 | 10–18 | 1400–2900 | TEMP_DRIFT |
| PUMP-01 | AUX 冷却泵 | —（全厂） | — | 30–50 | 1.5–3.5 | 3–8 | 1400–2900 | VIB_SPIKE |

三类异常在 14 台设备上的覆盖：`TEMP_DRIFT` 5 台、`VIB_SPIKE` 5 台、`CURRENT_ABNORMAL` 4 台，保证第 4 阶段每类样本量接近。

### 3.3 告警阈值推导表（按类型）

| 类型 | 指标 | 正常上限 | WARNING（×1.1） | CRITICAL（×1.25） |
|---|---|---|---|---|
| CNC | 温度 ℃ | 70 | 77.0 | 87.5 |
| CNC | 振动 mm/s | 3.0 | 3.30 | 3.75 |
| CNC | 电流 A | 10 | 11.00 | 12.50 |
| ROBOT | 温度 ℃ | 55 | 60.5 | 68.8 |
| ROBOT | 振动 mm/s | 2.5 | 2.75 | 3.13 |
| ROBOT | 电流 A | 6 | 6.60 | 7.50 |
| CONVEYOR | 温度 ℃ | 50 | 55.0 | 62.5 |
| CONVEYOR | 振动 mm/s | 4.0 | 4.40 | 5.00 |
| CONVEYOR | 电流 A | 5 | 5.50 | 6.25 |
| INSPECTION | 温度 ℃ | 45 | 49.5 | 56.3 |
| INSPECTION | 振动 mm/s | 1.5 | 1.65 | 1.88 |
| INSPECTION | 电流 A | 3 | 3.30 | 3.75 |
| AUX-空压机 | 温度 ℃ | 85 | 93.5 | 106.3 |
| AUX-空压机 | 振动 mm/s | 5.0 | 5.50 | 6.25 |
| AUX-空压机 | 电流 A | 18 | 19.80 | 22.50 |
| AUX-冷却泵 | 温度 ℃ | 50 | 55.0 | 62.5 |
| AUX-冷却泵 | 振动 mm/s | 3.5 | 3.85 | 4.38 |
| AUX-冷却泵 | 电流 A | 8 | 8.80 | 10.00 |

> 上表数值直接写进 `config/devices.json`（`thresholds` 段），代码里**禁止**再出现 ×1.1 这类计算式，避免两处推导结果不一致。

### 3.4 三类异常注入定义

| 异常类型 | 物理含义 | 注入参数 | 持续时长 | 预期效果 |
|---|---|---|---|---|
| TEMP_DRIFT | 温度漂移（如散热不良、轴承磨损） | 从正常上限起，每 2 秒 +0.4℃，`params = {"slope_per_tick": 0.4, "start_from": "upper"}` | 300 秒（+60℃），随后 120 秒线性回落 | 约 18 秒后进入 WARNING，约 44 秒后进入 CRITICAL，可稳定产生 2 级告警 |
| VIB_SPIKE | 振动突增（如刀具磨损、联轴器松动） | 基线叠加 `N(5.0, 0.8)` mm/s，`params = {"amp": 5.0, "sigma": 0.8}` | 40 秒后立即恢复 | 一个采样点即越过 CRITICAL，产生短促尖峰 |
| CURRENT_ABNORMAL | 电流异常（如负载突增、缺相） | 电流阶跃 +45%，同时转速下降 15%，`params = {"current_ratio": 1.45, "speed_ratio": 0.85}` | 90 秒后恢复 | 电流稳定越过 WARNING，部分设备越过 CRITICAL |

调度规则（写在模拟器内，保证演示可复现）：随机种子固定 `20261124`；每 **20 分钟**从设备表随机挑 1～2 台，按 3.2 表分配的异常类型注入，同一时刻处于注入态的设备不超过 2 台。

## 4. API 契约

### 4.0 通用约定

- 基础地址：`http://localhost:8000/api/v1`，所有接口前缀统一 `/api/v1`。
- 请求与响应均为 `application/json; charset=utf-8`。
- 时间字段一律 ISO 8601 带偏移（UTC，形如 `2026-11-24T02:15:30+00:00`）。
- 数值精度在**响应层**处理：温度 1 位小数、振动 2 位、电流 2 位、转速整数（数据库存原始精度）。
- 分页响应统一结构：`{"items": [...], "total": 14, "page": 1, "page_size": 50}`；`page_size` 默认 50、上限 200。
- 统一错误体：`{"code": "DEVICE_NOT_FOUND", "message": "设备 CNC-99 不存在", "detail": null}`。
- 错误码表：

| HTTP | code | 触发场景 |
|---|---|---|
| 400 | `INVALID_PARAM` | 参数类型/取值非法（如 `page_size=500`、`end <= start`） |
| 400 | `RANGE_TOO_LARGE` | 时间窗超过 24 小时，或批量写入超过 5000 条 |
| 404 | `DEVICE_NOT_FOUND` | 设备编号不存在 |
| 404 | `ALARM_NOT_FOUND` | 告警编号不存在 |
| 409 | `DUPLICATE_TELEMETRY` | 同一 `(device_id, ts)` 重复写入 |
| 409 | `DEVICE_HAS_OPEN_ALARM` | 有未解除告警时试图把设备置回 `RUNNING` |
| 422 | `VALIDATION_ERROR` | 请求体字段校验失败（由 pydantic 返回） |
| 503 | `DB_UNAVAILABLE` | 数据库连接失败 |

### 4.1 `GET /health`

- **参数**：无
- **成功 200**：
```json
{"status": "ok", "db": "ok", "version": "1.0.0", "server_time": "2026-11-24T02:15:30+00:00"}
```
- **错误**：`503 DB_UNAVAILABLE`（`db` 字段为 `"down"`）

### 4.2 `GET /workshops`

- **参数**：无
- **成功 200**：
```json
{
  "items": [
    {"id": "WS-A", "name": "机加工车间", "line_count": 2, "device_count": 6},
    {"id": "WS-B", "name": "检测与装配车间", "line_count": 2, "device_count": 6}
  ],
  "total": 2
}
```
- **错误**：`503 DB_UNAVAILABLE`

### 4.3 `GET /lines`

- **参数**：`workshop_id`（可选，如 `WS-A`）
- **成功 200**：
```json
{
  "items": [
    {"id": "LINE-A1", "name": "生产线 A1", "workshop_id": "WS-A", "rated_capacity_per_hour": 30, "device_count": 3}
  ],
  "total": 2
}
```
- **错误**：`400 INVALID_PARAM`（`workshop_id` 不存在时不报错，返回空列表）

### 4.4 `GET /devices`

- **参数**：`workshop_id`、`line_id`、`device_type`、`status`（均可选）、`page`（默认 1）、`page_size`（默认 50，上限 200）
- **成功 200**：
```json
{
  "items": [
    {
      "device_id": "CNC-01", "device_name": "数控机床 1", "device_type": "CNC",
      "workshop_id": "WS-A", "line_id": "LINE-A1", "model": "VMC-850",
      "status": "RUNNING", "installed_at": "2025-06-01T00:00:00+00:00",
      "open_alarm_count": 0, "latest_ts": "2026-11-24T02:15:30+00:00"
    }
  ],
  "total": 14, "page": 1, "page_size": 50
}
```
- **错误**：`400 INVALID_PARAM`（`page_size > 200`）、`503 DB_UNAVAILABLE`

### 4.5 `GET /devices/{device_id}`

- **参数**：路径参数 `device_id`
- **成功 200**：同 4.4 单项，另加 `"metrics_normal_range"`（从 config 读出的四指标区间）
- **错误**：`404 DEVICE_NOT_FOUND`

### 4.6 `PATCH /devices/{device_id}/status`

- **参数**：路径参数 `device_id`
- **请求体**：
```json
{"status": "MAINTENANCE", "reason": "更换主轴轴承"}
```
仅允许 `MAINTENANCE` 与 `RUNNING` 两个值（`ALARM` 由告警流程写，`IDLE` / `STOPPED` 由模拟器数据驱动，均不接受人工设置）。
- **成功 200**：
```json
{"device_id": "CNC-01", "status": "MAINTENANCE", "updated_at": "2026-11-24T02:20:00+00:00"}
```
- **错误**：`404 DEVICE_NOT_FOUND`、`400 INVALID_PARAM`（status 非法）、`409 DEVICE_HAS_OPEN_ALARM`（置 `RUNNING` 但仍有未解除告警）

### 4.7 `POST /telemetry`（单条写入）

- **参数**：请求体
```json
{
  "device_id": "CNC-01",
  "ts": "2026-11-24T02:15:30+00:00",
  "temperature": 65.2, "vibration": 2.5, "current": 8.6, "speed": 1500,
  "running_status": "RUNNING"
}
```
- **成功 201**：
```json
{"id": 123456, "device_id": "CNC-01", "ts": "2026-11-24T02:15:30+00:00", "accepted": true}
```
- **错误**：`404 DEVICE_NOT_FOUND`、`409 DUPLICATE_TELEMETRY`、`422 VALIDATION_ERROR`

### 4.8 `POST /telemetry/batch`（批量写入，`--backfill-days` 与实时 tick 都用它）

- **参数**：请求体 `{"items": [ ...单条结构... ]}`，**单次上限 5000 条**
- **成功 201**：
```json
{"accepted": 5000, "duplicated": 0, "rejected": 0, "elapsed_ms": 412}
```
重复数据按 `ON CONFLICT (device_id, ts) DO NOTHING` 处理，计入 `duplicated` 而不报错（保证回填可重复执行）。
- **错误**：`400 RANGE_TOO_LARGE`（>5000 条）、`422 VALIDATION_ERROR`

### 4.9 `GET /devices/{device_id}/telemetry`

- **参数**：`start`、`end`（**必填或都不填**，都不填默认最近 1 小时；两者都填且跨度 > 24 小时报错）、`limit`（默认 5000，上限 5000）
- **降采样规则**：总点数 > `limit` 时按 `step = ceil(总点数 / limit)` 等间隔取点，响应里返回实际步长
- **成功 200**：
```json
{
  "device_id": "CNC-01",
  "start": "2026-11-24T01:15:30+00:00", "end": "2026-11-24T02:15:30+00:00",
  "interval_seconds": 2, "downsample_step": 1, "count": 1800, "truncated": false,
  "points": [
    {"ts": "2026-11-24T02:15:30+00:00", "temperature": 65.2, "vibration": 2.50,
     "current": 8.62, "speed": 1500, "running_status": "RUNNING"}
  ]
}
```
- **错误**：`404 DEVICE_NOT_FOUND`、`400 INVALID_PARAM`（`end <= start`）、`400 RANGE_TOO_LARGE`（跨度 > 24 小时）

### 4.10 `GET /devices/latest`

- **参数**：无（WebSocket 断线时的兜底接口）
- **成功 200**：
```json
{
  "server_time": "2026-11-24T02:15:30+00:00",
  "items": [
    {"device_id": "CNC-01", "status": "RUNNING", "open_alarm_count": 0,
     "ts": "2026-11-24T02:15:30+00:00", "temperature": 65.2,
     "vibration": 2.50, "current": 8.62, "speed": 1500, "running_status": "RUNNING"}
  ]
}
```
- **错误**：`503 DB_UNAVAILABLE`

### 4.11 `GET /alarms`

- **参数**：`device_id`、`alarm_type`、`alarm_level`、`resolved`（`true`/`false`）、`start`、`end`、`page`、`page_size`
- **成功 200**：
```json
{
  "items": [
    {"alarm_id": 12, "device_id": "CNC-01", "alarm_type": "TEMPERATURE", "alarm_level": "WARNING",
     "message": "CNC-01 温度 78.4℃ 超过预警阈值 77.0℃",
     "detected_at": "2026-11-24T02:20:00+00:00", "resolved_at": null}
  ],
  "total": 1, "page": 1, "page_size": 50
}
```
- **错误**：`400 INVALID_PARAM`、`503 DB_UNAVAILABLE`

### 4.12 `PATCH /alarms/{alarm_id}/resolve`

- **参数**：路径参数 `alarm_id`
- **成功 200**（注意 `device_status`：仍有其它未解除告警时保持 `ALARM`，这是 G-10 修订的落地表现）：
```json
{"alarm_id": 12, "resolved_at": "2026-11-24T02:26:00+00:00", "device_status": "ALARM", "open_alarm_count": 1}
```
- **错误**：`404 ALARM_NOT_FOUND`、`409`（该告警已解除时返回 `{"code": "ALARM_ALREADY_RESOLVED"}`）

### 4.13 `GET /orders`

- **参数**：`line_id`、`status`、`page`、`page_size`
- **成功 200**：
```json
{
  "items": [
    {"order_id": "ORD-20261124-0001", "product_id": "PRD-A-001", "line_id": "LINE-A1",
     "planned_quantity": 120, "actual_quantity": 87, "qualified_quantity": 84,
     "planned_start": "2026-11-24T00:00:00+00:00", "planned_end": "2026-11-24T04:00:00+00:00",
     "status": "IN_PROGRESS", "qualified_rate": 0.9655, "completion_rate": 0.7250}
  ],
  "total": 4, "page": 1, "page_size": 50
}
```
- **错误**：`400 INVALID_PARAM`、`503 DB_UNAVAILABLE`

### 4.14 `GET /stats/production`

- **参数**：`line_id`（可选，不传则全厂）、`start`、`end`（默认最近 1 小时）
- **统计口径**（必须按此实现，否则第 3 阶段页面数字对不上）：
  - `qualified_rate = Σ qualified_quantity / Σ actual_quantity`
  - `completion_rate = Σ actual_quantity / Σ planned_quantity`
  - `utilization = 该产线设备 running_status='RUNNING' 的采样点数 / 该产线设备总采样点数`（`device_telemetry` 按时间窗聚合）
- **成功 200**：
```json
{
  "line_id": "LINE-A1", "start": "2026-11-24T01:15:30+00:00", "end": "2026-11-24T02:15:30+00:00",
  "orders_completed": 0, "orders_in_progress": 1,
  "planned_quantity": 120, "actual_quantity": 87, "qualified_quantity": 84,
  "qualified_rate": 0.9655, "completion_rate": 0.7250, "utilization": 0.8612
}
```
- **错误**：`400 INVALID_PARAM`、`400 RANGE_TOO_LARGE`、`503 DB_UNAVAILABLE`

### 4.15 `GET /maintenance` / `POST /maintenance`

- **GET 参数**：`device_id`、`page`、`page_size`
- **POST 请求体**：
```json
{"device_id": "ROB-02", "maintenance_type": "ROUTINE", "description": "更换 3 号关节润滑脂",
 "started_at": "2026-11-24T01:00:00+00:00", "cost": 1200.00}
```
`finished_at` 省略表示维护进行中；此时后端把 `devices.status` 置 `MAINTENANCE`。
- **成功 201**：
```json
{"record_id": 5, "device_id": "ROB-02", "maintenance_type": "ROUTINE",
 "started_at": "2026-11-24T01:00:00+00:00", "finished_at": null,
 "cost": 1200.00, "device_status": "MAINTENANCE"}
```
- **错误**：`404 DEVICE_NOT_FOUND`、`422 VALIDATION_ERROR`

### 4.16 `GET /anomalies`（注入真值查询，本阶段只读）

- **参数**：`device_id`、`anomaly_type`、`start`、`end`、`page`、`page_size`
- **成功 200**：
```json
{
  "items": [
    {"id": 3, "device_id": "CNC-02", "anomaly_type": "VIB_SPIKE",
     "started_at": "2026-11-24T02:10:00+00:00", "ended_at": "2026-11-24T02:10:40+00:00",
     "params": {"amp": 5.0, "sigma": 0.8}}
  ],
  "total": 1, "page": 1, "page_size": 50
}
```
- **错误**：`400 INVALID_PARAM`、`503 DB_UNAVAILABLE`

### 4.17 `GET /ws/telemetry`（WebSocket，协议见第 5 节）

- **地址**：`ws://localhost:8000/api/v1/ws/telemetry`
- **参数**：无（全厂推送，订阅过滤预留，本阶段不实现）
- **错误**：握手阶段数据库不可用则拒绝连接（关闭码 `1011`）

### 4.18 后台任务（不是 API，但必须实现）

告警不是接口触发的，由两个常驻后台任务产生，行为固定如下：

| 任务 | 周期 | 行为 |
|---|---|---|
| 告警扫描 | 5 秒 | 扫描 `device_telemetry` 中 `inserted_at >= 上次扫描时间` 的行（**增量扫描，因此回填的历史数据也会被判定**），按 3.3 阈值判定温度/振动/电流三类；命中则写 `alarms` 并把 `devices.status` 置 `ALARM`；同一 `device_id + alarm_type` 在 5 分钟内只写一条（冷却以 `ts` 为准，回填时按历史时间自然分布） |
| 告警收敛 | 5 秒 | 对未解除告警，检查其设备最近 60 秒遥测是否已回落到 WARNING 阈值以下；是则回填 `resolved_at`，并按 G-10 规则决定 `devices.status`（仍有其它未解除告警则保持 `ALARM`） |

两个任务都通过 WebSocket 广播 `alarm` 事件（5.3），并在进程启动时立即执行一次（不等第一个周期）。

## 5. WebSocket 消息

### 5.1 连接与心跳

- 服务端每 1 秒推一条 `snapshot`；告警新增或解除时额外立刻推一条 `alarm`。
- 服务端每 30 秒发一次 WebSocket 协议层 ping，客户端 60 秒无任何消息则重连（前端第 3 阶段实现）。
- 单条消息上限 64 KB（14 台设备快照约 2 KB，远低于上限）。

### 5.2 `snapshot` 完整示例（字段齐全，14 台设备同构）

```json
{
  "type": "snapshot",
  "server_time": "2026-11-24T02:15:30+00:00",
  "seq": 1042,
  "device_count": 14,
  "summary": {
    "running": 12,
    "idle": 1,
    "stopped": 0,
    "alarm": 1,
    "maintenance": 0,
    "open_alarm_count": 1
  },
  "devices": [
    {
      "device_id": "CNC-01",
      "device_name": "数控机床 1",
      "device_type": "CNC",
      "workshop_id": "WS-A",
      "line_id": "LINE-A1",
      "status": "RUNNING",
      "open_alarm_count": 0,
      "ts": "2026-11-24T02:15:30+00:00",
      "metrics": {
        "temperature": 65.2,
        "vibration": 2.50,
        "current": 8.62,
        "speed": 1500
      },
      "running_status": "RUNNING",
      "in_anomaly": false
    },
    {
      "device_id": "CNC-02",
      "device_name": "数控机床 2",
      "device_type": "CNC",
      "workshop_id": "WS-A",
      "line_id": "LINE-A2",
      "status": "ALARM",
      "open_alarm_count": 1,
      "ts": "2026-11-24T02:15:30+00:00",
      "metrics": {
        "temperature": 61.4,
        "vibration": 7.83,
        "current": 9.10,
        "speed": 1450
      },
      "running_status": "RUNNING",
      "in_anomaly": true
    }
  ]
}
```

> 示例只列 2 台设备以控制篇幅，实际消息 `devices` 数组固定 14 条，字段与上述完全一致。`in_anomaly` 表示该设备当前处于注入区间内（查 `anomaly_injection` 未结束记录），供前端标红，第 4 阶段可直接复用为"疑似异常"标记。

### 5.3 `alarm` 事件示例

```json
{
  "type": "alarm",
  "event": "created",
  "server_time": "2026-11-24T02:20:00+00:00",
  "alarm": {
    "alarm_id": 12,
    "device_id": "CNC-01",
    "device_name": "数控机床 1",
    "alarm_type": "TEMPERATURE",
    "alarm_level": "WARNING",
    "message": "CNC-01 温度 78.4℃ 超过预警阈值 77.0℃",
    "detected_at": "2026-11-24T02:20:00+00:00",
    "resolved_at": null
  }
}
```
`event` 取 `created` 或 `resolved`；`resolved` 时 `resolved_at` 非空，并附带 `"device_status"` 字段表示该设备状态（可能是 `ALARM`，因为还有其它未解除告警）。

## 6. 模拟器规格

### 6.1 运行形态（命令行）

模拟器是独立进程，模块入口 `python -m data_pipeline.simulator`，**默认常驻运行**，`Ctrl+C` 触发优雅退出。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `--devices` | 字符串 | 全部 14 台 | 逗号分隔的设备编号，如 `--devices CNC-01,CNC-02`；用于单设备调试 |
| `--rate` | 整数（秒） | 2 | 采样间隔，必须 ≥1；与 G-01 口径一致，改这个值等于改全系统数据密度 |
| `--duration` | 整数（秒） | 0 | 运行时长，`0` = 常驻运行直到 `Ctrl+C` |
| `--backfill-days` | 整数（天） | 0 | 先按 2 秒栅格倒推生成 N 天历史，再切实时；`0` = 不回填（G-18） |

典型用法：

```text
python -m data_pipeline.simulator                                  # 常驻实时，Ctrl+C 停止
python -m data_pipeline.simulator --duration 30                    # 跑 30 秒自动退出（验收用）
python -m data_pipeline.simulator --backfill-days 1 --duration 30  # 先补 1 天历史再跑 30 秒
python -m data_pipeline.simulator --devices CNC-01 --rate 1        # 单设备 1 秒一条
```

**优雅退出要求**：

1. 捕获 `SIGINT`（`Ctrl+C`，Windows 下用 `signal.signal(signal.SIGINT, ...)` 与 `KeyboardInterrupt` 双保险），停止 tick 循环，**不丢当前 tick 已生成的数据**；
2. 打印统计块，字段固定如下（便于验收比对）：

```text
==== 模拟器统计 ====
运行时长         : 30.2 s
采样间隔         : 2 s
设备数           : 14
写入行数         : 210
平均写入速率     : 6.95 行/s
注入事件         : 0 次（进行中 0）
订单推进         : 15 件
写入失败/重试    : 0 / 0
回填行数         : 0
===================
```

3. 退出码：正常 `0`，数据库不可达等致命错误 `1`。

### 6.2 生成节拍与写入方式

- 每 `--rate` 秒一个 tick，一个 tick 内为**每台被选中的设备各生成 1 条**（默认 14 条），用一次 `POST /telemetry/batch` 提交。
- 写入失败重试 3 次，退避 1s / 2s / 4s；连续 3 个 tick 全部失败则判定后端不可用，打印错误并退出（退出码 1）。
- 时间戳取 tick 开始时刻对齐到 2 秒栅格（`ts = floor(now / rate) * rate`），保证同一栅格重复运行不会产生重复行（被 `uq_telemetry_device_ts` 挡住，计入 `duplicated`）。

### 6.3 各指标的数据分布

对每台设备、每个指标：

```text
中心值 center = (正常下限 + 正常上限) / 2
标准差 sigma  = (正常上限 - 正常下限) / 8      # 3 sigma 覆盖约 75% 半幅，越界极少
基础值 base   = center + N(0, sigma)           # 正态噪声
慢漂移 drift  = (正常上限 - 正常下限) / 6 * sin(2π * t / 600)   # 10 分钟周期缓慢起伏
最终值 value  = base + drift，并 clamp 到 [下限 × 0.9, 上限 × 1.05]
```

以 CNC 温度为例（下限 55、上限 70）：`center = 62.5`、`sigma = 1.875`、`drift` 幅度 ±2.5℃，绝大多数点落在 56～69 之间。

转速用同一公式后取整；`running_status` 由状态机给出：每 30 分钟为一个周期，`RUNNING` 26 分钟 → `IDLE` 3 分钟 → `STOPPED` 1 分钟。`STOPPED` 期间 `speed = 0`、`current` 取正常下限的 10%、`vibration` 取正常下限的 30%。

### 6.4 三类异常的注入实现

按 3.4 的参数执行，注入期间**覆盖**上述正常生成逻辑：

| 类型 | 实现要点 |
|---|---|
| TEMP_DRIFT | 只改 `temperature`：`t0` 时刻起每 tick +0.4℃（上限 300℃ 硬夹断），300 秒后进入 120 秒线性回落，回落结束清除注入态 |
| VIB_SPIKE | 只改 `vibration`：`baseline + N(5.0, 0.8)`，持续 40 秒后立即恢复基线；其余指标不受影响 |
| CURRENT_ABNORMAL | 同时改两列：`current × 1.45`、`speed × 0.85`（取整），持续 90 秒后恢复 |

注入调度：种子固定 `20261124`；每 20 分钟随机挑 1～2 台（按 3.2 表分配的异常类型），同时处于注入态的设备 ≤ 2 台；被挑中设备若正在注入则跳过。

### 6.5 ground truth 写入规则

- 注入**开始前**先 `INSERT INTO anomaly_injection (device_id, anomaly_type, started_at, params)`，`params` 写实际使用的参数。
- 注入结束时 `UPDATE anomaly_injection SET ended_at = now() WHERE id = :id`。
- 进程被 `Ctrl+C` 中断时，把仍在进行中的记录的 `ended_at` 置为中断时刻（不留下永远为 NULL 的僵尸记录），并在统计块里报告 `进行中 0`。
- 回填（`--backfill-days`）时，注入事件的时间必须落在历史区间内：在 `[now - N 天, now]` 内随机生成注入窗口，`started_at` / `ended_at` 与生成的遥测行时间严格对齐到 2 秒栅格。

### 6.6 订单推进

- 每条产线初始 1 张 `IN_PROGRESS` 订单，`planned_quantity = 120`、`product_id = PRD-<车间字母>-001`。
- 每 120 秒（= 30 件/小时）执行一次推进：`actual_quantity += 1`；合格数按累加余数法维持 97%：
  ```text
  qualified_quantity = floor(actual_quantity * 0.97)
  ```
  这样长期合格率稳定在 97%，且不会出现"小数累积丢失"。
- `actual_quantity >= planned_quantity` 时：置 `COMPLETED`，同产线立即新建下一张订单（`order_id` 尾号 +1，`planned_start` = 当前时刻，`planned_end` = 当前 + 4 小时）。
- **不做**：`DELAYED` 状态的自动判定（需排产算法，见 L-06）。

### 6.7 回填（`--backfill-days N`）行为

1. 校验参数：`N ≥ 0`、`N ≤ 30`（超过 30 天拒绝启动，避免误操作灌入 1800 万行）。
2. 生成时间栅格：从 `now - N*86400` 到 `now`，步长 `--rate` 秒；按每设备 43,200 条/天计算总量。
3. 分块提交：每批 5000 条调 `POST /telemetry/batch`，批间不 sleep（后端限流预留，本阶段不实现）。
4. 回填期间**同步生成** `anomaly_injection` 记录（每 20 分钟一个窗口，规则同 6.4）与 `production_orders` 历史订单（按天倒推生成已完成订单）。
5. 回填完成后打印 `回填行数`，再进入实时 tick 循环。

### 6.8 日志格式

每 tick 一行，字段固定（便于 `Select-String` 过滤）：

```text
[2026-11-24 10:15:32] tick=1 devices=14 rows=14 injected=0 orders=+1 latency=12ms
```

`injected` 为该 tick 新开始的注入台数（0/1/2），失败时追加 `error=<原因>`。

## 7. 验收清单

前提：操作系统 Windows + PowerShell 5.1，项目根目录为仓库根（下称"根目录"）。逐条复制执行，**每条都给出应看到的输出**。

### 7.1 数据库容器

```powershell
docker run -d --name sftwin-db -e POSTGRES_DB=smartfactory -e POSTGRES_USER=sf -e POSTGRES_PASSWORD=sf_dev_pw -p 5433:5432 postgres:16
```
预期：输出一行 64 位容器 ID（十六进制字符串）。端口用 5433 是为了避免与本机已装的 PostgreSQL 抢占 5432。

```powershell
docker exec sftwin-db pg_isready -U sf -d smartfactory
```
预期：`/var/run/postgresql:5432 - accepting connections`

### 7.2 依赖安装

```powershell
python -m venv .venv; .\.venv\Scripts\Activate.ps1; pip install -r requirements.txt
```
预期：最后一行 `Successfully installed fastapi-... uvicorn-... sqlalchemy-... psycopg-...`（版本号与本规格 G-15 锁定值一致）。

### 7.3 建表（schema.sql 不含 DROP）

```powershell
Select-String -Path database\schema.sql -Pattern "DROP" | Measure-Object | Select-Object -ExpandProperty Count
```
预期：`0`（G-16 修订的机器校验，出现非 0 即验收不通过）。

```powershell
Get-Content database\schema.sql | docker exec -i sftwin-db psql -U sf -d smartfactory
```
预期：连续 8 次 `CREATE TABLE` 与 11 次 `CREATE INDEX`，**没有任何 `ERROR`**；末尾无 `DROP` 相关输出。

### 7.4 种子数据

```powershell
Get-Content database\seed.sql | docker exec -i sftwin-db psql -U sf -d smartfactory
```
预期：`INSERT 0 2`、`INSERT 0 4`、`INSERT 0 14`（依次为车间、产线、设备）。

```powershell
docker exec sftwin-db psql -U sf -d smartfactory -t -c "SELECT device_type, count(*) FROM devices GROUP BY device_type ORDER BY device_type;"
```
预期（含空格的原始输出，共 5 行）：
```text
 AUX        | 2
 CNC        | 4
 CONVEYOR   | 2
 INSPECTION | 2
 ROBOT      | 4
```

### 7.5 服务启动与健康检查

```powershell
uvicorn app.main:app --port 8000
```
预期：`INFO:     Application startup complete.` 与 `INFO:     Uvicorn running on http://127.0.0.1:8000`。
（保持该窗口不关，后续命令另开一个 PowerShell 窗口执行。）

```powershell
Invoke-RestMethod http://localhost:8000/api/v1/health | ConvertTo-Json
```
预期：
```json
{"status": "ok", "db": "ok", "version": "1.0.0", "server_time": "2026-11-24T02:15:30+00:00"}
```

### 7.6 设备与层级接口

```powershell
(Invoke-RestMethod "http://localhost:8000/api/v1/devices?page=1&page_size=50").total
```
预期：`14`

```powershell
(Invoke-RestMethod "http://localhost:8000/api/v1/devices?device_type=CNC").items.device_id -join ","
```
预期：`CNC-01,CNC-02,CNC-03,CNC-04`

```powershell
(Invoke-RestMethod "http://localhost:8000/api/v1/lines?workshop_id=WS-A").items.id -join ","
```
预期：`LINE-A1,LINE-A2`

### 7.7 参数校验（错误分支必须有反应）

```powershell
try { Invoke-RestMethod "http://localhost:8000/api/v1/devices?page_size=500" } catch { $_.ErrorDetails.Message }
```
预期：包含 `"code":"INVALID_PARAM"` 的 JSON。

```powershell
try { Invoke-RestMethod "http://localhost:8000/api/v1/devices/CNC-99" } catch { $_.ErrorDetails.Message }
```
预期：包含 `"code":"DEVICE_NOT_FOUND"`。

### 7.8 模拟器跑通 30 秒

```powershell
python -m data_pipeline.simulator --duration 30
```
预期：逐 tick 打印日志，最后打印统计块，其中 `写入行数 : 210`（30 秒 ÷ 2 秒 × 14 台 = 210，允许 ±2 的边界误差），`写入失败/重试 : 0 / 0`，退出码 0。

```powershell
docker exec sftwin-db psql -U sf -d smartfactory -t -c "SELECT count(*) FROM device_telemetry;" | ForEach-Object { $_.Trim() }
```
预期：`210`（与上一行的 `写入行数` 完全一致，不一致说明写入有静默丢失）。

### 7.9 时序查询与降采样

```powershell
(Invoke-RestMethod "http://localhost:8000/api/v1/devices/CNC-01/telemetry").count
```
预期：`≤ 1800`（默认最近 1 小时，2 秒一条；刚跑 30 秒时约为 `15`）。

```powershell
(Invoke-RestMethod "http://localhost:8000/api/v1/devices/CNC-01/telemetry").points[0].temperature
```
预期：55～70 之间的浮点数（1 位小数），说明数据落在正常区间。

### 7.10 回填 1 天历史 + 数据量校验

```powershell
python -m data_pipeline.simulator --backfill-days 1 --duration 5
```
预期：先打印分批写入进度，统计块中 `回填行数 : 604800`，随后实时 tick 5 秒，退出码 0。整段耗时 60～120 秒。

```powershell
docker exec sftwin-db psql -U sf -d smartfactory -t -c "SELECT count(*) FROM device_telemetry;" | ForEach-Object { $_.Trim() }
```
预期：`604,800` 是本次回填覆盖的**整段栅格**，其中 7.8 已写入的 210 行落在该区间内、被 `ON CONFLICT (device_id, ts)` 去重，所以统计块应打印 `回填行数 : 604590` + `重复行数 : 210`，两者相加正好 604,800。再加本步 5 秒实时写入的 `28~42` 行，总数约 **604,828**，判定区间 `604800 ≤ 结果 ≤ 604900`。

（v1.1 修正：v1.0 曾把 210 行与 604,800 重复相加写成约 605,045，属算术错误，见「修订记录 v1.1」第 1 条。）

```powershell
docker exec sftwin-db psql -U sf -d smartfactory -t -c "SELECT min(ts) FROM device_telemetry;" | ForEach-Object { $_.Trim() }
```
预期：时间不晚于"当前时间 − 23 小时"，即历史确实回填到了 1 天前。

### 7.11 异常真值（回填产生）

```powershell
docker exec sftwin-db psql -U sf -d smartfactory -t -c "SELECT anomaly_type, count(*) FROM anomaly_injection GROUP BY anomaly_type ORDER BY anomaly_type;" | ForEach-Object { $_.Trim() }
```
预期：3 行，形如 `CURRENT_ABNORMAL | 26`、`TEMP_DRIFT | 31`、`VIB_SPIKE | 28`，每种类型 `≥ 20`（1 天 = 72 个 20 分钟窗口，随机分给 14 台设备）。

### 7.12 告警链路确定性触发

先把告警表清空、设备状态复位，制造一个干净起点（这是唯一允许写库的操作，仅用于验收）：

```powershell
docker exec sftwin-db psql -U sf -d smartfactory -c "DELETE FROM alarms; UPDATE devices SET status = 'RUNNING';"
```
预期：`DELETE 0` 或 `DELETE n`，随后 `UPDATE 14`。

提交两条超限数据（温度 95℃ 越过 CNC 的 CRITICAL 87.5；振动 9.0 越过 CRITICAL 3.75）：

```powershell
$ts1 = (Get-Date).AddSeconds(-4).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss+00:00")
$ts2 = (Get-Date).AddSeconds(-2).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss+00:00")
$b1 = @{ device_id="CNC-01"; ts=$ts1; temperature=95.0; vibration=2.5; current=8.6; speed=1500; running_status="RUNNING" } | ConvertTo-Json
$b2 = @{ device_id="CNC-01"; ts=$ts2; temperature=65.0; vibration=9.0; current=8.6; speed=1500; running_status="RUNNING" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://localhost:8000/api/v1/telemetry" -ContentType "application/json" -Body $b1
Invoke-RestMethod -Method Post -Uri "http://localhost:8000/api/v1/telemetry" -ContentType "application/json" -Body $b2
```
预期：两次都返回 `accepted : True`，各带一个 `id`。两条数据的时间戳相差 2 秒，不会触发 `409 DUPLICATE_TELEMETRY`。

```powershell
Start-Sleep -Seconds 7
(Invoke-RestMethod "http://localhost:8000/api/v1/alarms?device_id=CNC-01&resolved=false").total
```
预期：`2`（温度、振动各一条；扫描周期 5 秒 + 余量）。**检查需在模拟器停止状态下进行**，否则收敛任务会在后续正常遥测到达时把告警自动解除。

```powershell
(Invoke-RestMethod "http://localhost:8000/api/v1/alarms?device_id=CNC-01&resolved=false").items.alarm_level -join ","
```
预期：`CRITICAL,CRITICAL`

```powershell
(Invoke-RestMethod "http://localhost:8000/api/v1/devices/CNC-01").status
```
预期：`ALARM`（G-10：告警写入时联动设备状态）

### 7.13 WebSocket 推送

```powershell
python -m websockets ws://localhost:8000/api/v1/ws/telemetry
```
预期：约每秒打印一行 JSON，首字段为 `{"type": "snapshot", "server_time": ...}`，`devices` 数组长度 14；CNC-01 的 `status` 为 `"ALARM"`、`open_alarm_count` 为 `2`。按 `Ctrl+C` 结束。

### 7.14 告警解除的 G-10 逻辑（两个分支都要过）

**执行前置（v1.1 补充，必须遵守）**：本节必须在 7.12 注入后 **45 秒内**跑完。原因：收敛任务 5 秒一次，当 95℃ 的采样点滑出「最近 60 秒」窗口（注入后约 60 秒），窗口峰值只剩 65℃，低于预警阈值 70℃，温度告警会被**自动解除**，分支一就取不到 `open_alarm_count = 1`。实测中该告警在注入后 61 秒被自动解除（`detected 04:55:45 → resolved 04:56:46`）。若已超时，重跑 7.12 的「清空告警 + 注入两条」后再执行本节，**不要在超时状态下判本项失败**。

```powershell
$id1 = (Invoke-RestMethod "http://localhost:8000/api/v1/alarms?device_id=CNC-01&resolved=false&alarm_type=TEMPERATURE").items[0].alarm_id
Invoke-RestMethod -Method Patch "http://localhost:8000/api/v1/alarms/$id1/resolve" | ConvertTo-Json
```
预期：`"device_status": "ALARM"`、`"open_alarm_count": 1` —— **还有振动告警未解除，设备不能回到 RUNNING**（这正是第 1 节 G-10 修订的验收点）。

```powershell
$id2 = (Invoke-RestMethod "http://localhost:8000/api/v1/alarms?device_id=CNC-01&resolved=false").items[0].alarm_id
Invoke-RestMethod -Method Patch "http://localhost:8000/api/v1/alarms/$id2/resolve" | ConvertTo-Json
```
预期：`"device_status": "RUNNING"`、`"open_alarm_count": 0` —— 全部解除后才复位。

### 7.15 优雅退出

在 7.13 的运行窗口（或重新执行 `python -m data_pipeline.simulator` 后）按 `Ctrl+C`。
预期：打印 `==== 模拟器统计 ====` 统计块（字段与 6.1 一致），进程正常结束、不抛 `Traceback`，`注入事件 ... （进行中 0）`。

### 7.16 验收判定汇总

| 编号 | 验收项 | 通过标准 |
|---|---|---|
| 7.1 | 数据库容器 | `accepting connections` |
| 7.3 | schema 无 DROP | `Select-String` 计数为 0，8 表 11 索引无 ERROR |
| 7.4 | 种子数据 | 2 / 4 / 14，类型分布 4-4-2-2-2 |
| 7.6 | 设备接口 | total = 14，CNC 四台齐全 |
| 7.7 | 参数校验 | `INVALID_PARAM` 与 `DEVICE_NOT_FOUND` 都出现 |
| 7.8 | 模拟器实时 | 写入 210 行且与库内计数一致 |
| 7.9 | 时序查询 | 点在正常区间，`count ≤ 1800` |
| 7.10 | 回填 | 约 604,828 行（区间 604800～604900），`回填+重复 = 604800`，最早时间早于 23 小时前 |
| 7.11 | 异常真值 | 三类型各 ≥ 20 |
| 7.12 | 告警链路 | 2 条 CRITICAL 未解除告警，`devices.status = ALARM` |
| 7.13 | WebSocket | 每秒一条 snapshot，14 台设备，CNC-01 状态 ALARM |
| 7.14 | 告警解除 | 先 `ALARM`（open=1），后 `RUNNING`（open=0） |
| 7.15 | 优雅退出 | 打印统计块、无 Traceback |

以上 13 项全绿，第 2 阶段视为完成。

> **2026-11-24 补注（不影响本节任何判据）**：7.3 里「8 表 11 索引」是第 2 阶段**当时**的期望值。
> 第 4 阶段 4.2 批新增 `model_versions` / `anomaly_scores` 两张表（见 `docs/spec_phase4.md` §6）后，
> `schema.sql` 实际是 **10 表 15 索引**，`reset.sql` 也同步删 10 张表。今天重跑 7.3，
> 数量请按 10 / 15 判，其余判据（`schema.sql` 内 `DROP` 计数为 0）不变。

## 8. 明确不做（第 2 阶段范围外）

### 8.1 禁止实现的模块

| 模块 | 为什么本阶段不做 | 预留方式 |
|---|---|---|
| React / TypeScript 前端页面 | 属第 3 阶段，本阶段接口用 `Invoke-RestMethod` 验证即可 | 无代码，仅接口契约（第 4 节） |
| Three.js 三维场景 | 属第 3 阶段 | 无 |
| ECharts 图表 | 属第 3 阶段 | 无 |
| Kafka 消息队列 | 7 条/秒用不上，属第 4 阶段 | `save_telemetry()` 单独成函数，注释「预留，本阶段不实现」 |
| Redis 缓存 | 无并发压力（L-05） | 无 |
| TimescaleDB 扩展与 hypertable | 见 G-03 / L-01 | `device_telemetry` 保持普通表，注释「预留，本阶段不实现」 |
| AI 模型训练与推理（异常检测 / 故障预测 / 产量预测） | 属第 4 阶段 | `ml/` 空目录；`anomaly_injection` 表已就位供第 4 阶段用 |
| AI 工业助手 / 自然语言查询 | 属进阶模块 | 无 |
| 用户表与登录鉴权（JWT / 密码哈希） | 见 G-14 | `verify_token()` 空实现，注释「预留，本阶段不实现」 |
| 告警外发通知（邮件 / 企微 / 钉钉） | 见 L-04 | `notify_alarm()` 空函数，注释「预留，本阶段不实现」 |
| 数据清理 / 归档 / 降采样定时任务 | 见 L-03 | `cleanup_old_telemetry()` 空函数，注释「预留，本阶段不实现」 |
| Alembic 数据库迁移 | 见 G-16 | 仅 `schema.sql` / `seed.sql` / `reset.sql` |
| 应用 Docker 容器化（Dockerfile / compose 中的应用服务） | 只用容器跑数据库，应用跑本地 venv（G-15） | 无 |
| 订单排产算法（多单分配、延期判定） | 见 L-06 | 模拟器内固定 FCFS + 单产线串行 |
| 真实 IoT / MQTT 接入 | 属第 3 阶段之后的可选项 | 接入层为 `POST /telemetry`，替换点已隔离 |
| 报表导出（PDF / Excel）与打印 | 不在第 2 阶段验收 | 无 |
| 模型评估脚本（精确率 / 召回率计算） | 属第 4 阶段 | `ml/evaluation/` 空目录 |
| 性能压测、API 限流、审计日志 | 见 L-10 | 无 |
| 数据库备份定时任务 | 见 L-13 | README 写手工 `pg_dump` 命令 |

### 8.2 防范围蔓延的三条规则

1. **单次改动只服务本阶段验收清单**：任何"顺手把前端画出来""顺手接个 Kafka 试试"的改动一律拒绝，写进后续阶段待办。
2. **发现规格外的需求，先改规格再改代码**：本文件版本号不动就不许动实现（v1.1 才允许变更）。
3. **不提前抽象**：不要为"以后可能要换数据库""以后可能要上 Kafka"设计抽象层，只保留 8.1 表里明确列出的空函数占位，其余按当前需求直写。
