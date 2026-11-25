# 第 4 阶段实现规格（数据处理流水线 + AI 模型）

```yaml
阶段: 第 4 阶段
版本: v2.0（按作者 2026-11-25 的六项决策重规划；v1.0 与 v1.1 原文已归档）
日期: 2026-11-25
上一版: v1.1（2026-11-25，4.2 批完成后升版，含偏差 D-18 ~ D-25）
归档: docs/archive/spec_phase4_v1.0.md（636 行）、docs/archive/spec_phase4_v1.1.md（648 行）
上游依据: docs/方案.md 第 170 行、docs/spec_phase2.md（L-01 / L-02 / L-12）、docs/spec_phase3.md（D-03 预留）
已完成: 4.1 批（异常检测训练）、4.2 批（后端接入 + AI 页）
剩余: 4.3 ~ 4.7
```

---

## 0. 本文件怎么用

### 0.1 三条阅读路径

不要从第 1 页读到最后一页。按你的目的选一条：

| 你的目的 | 读哪几节 | 大约多久 |
|---|---|---|
| **想知道这一版为什么改了** | §0.2 差异导读 → §1 决策变更表 | 10 分钟 |
| **要开始施工某一批** | §3 基线 → §4 那一批 → §5 那一批的验收命令 | 20 分钟 |
| **只想核对某个数字** | 附录 A 复核命令清单（每个数字都标明取数 SQL） | 按需 |

三条铁律，对全文有效：

1. **本文件是第 4 阶段的唯一施工依据。** 规格未定之处不许自行发挥，回来问。
2. **数字必须可复核。** 本文出现的每个数字，要么在 §3 有实测记录，要么在附录 A 有取数命令。写「性能显著提升」而无数值的句子一律不允许。
3. **施工与规格不一致时记偏差，不静默改规格。** 记到附录 B，并从 D-26 起编号（D-11 ~ D-25 已占用，不重排）。

### 0.2 v1.0 → v2.0 差异导读

v1.0 是"六块全做"的完整计划。v2.0 不是把 v1.0 修修补补，而是按 2026-11-25 的六项决策**重划了范围**。变化分四类，逐类说清"变了什么、为什么变"：

| 类别 | 变了什么 | 为什么 |
|---|---|---|
| **① 决策反转** | A 块 Kafka **整块废止**（原 §8 的拓扑、生产者、消费者、四条验收判据全部作废），改为只产出一份 `docs/decision_kafka.md`；依赖清单删掉 `kafka-python` | 全厂吞吐实测 7 行/秒，而当前 HTTP 直写的实测上限是 26,186 行/秒（§3.4）。在这个规模下接 Kafka，端到端只多一跳、多一个容器、多一类故障，功能零增加。**这不是"以后再做"，是判定为该做之前先证明值得做** |
| **② 范围收窄** | D 块从「规则聚合风险打分」收窄为「数据可行性评估 + 演示级指示」；E 块从「小时 × 产线预测」收窄为「两个粒度 + 与最笨基线对比」 | D 块的监督标签实测只有 **3 条维护记录**，既训不出模型也验证不了任何分数；E 块实测小时 × 产线网格 **66.7% 是空格**，天级只有 **7 个完整日**。原来的写法默认"有可预测信号"，这个前提从未被验证 |
| **③ 实现回填** | 4.1 / 4.2 两批已交付的内容，从「待施工」改为「以实现为准」：产物清单、脚本名（`score_window.py` 而非 `score`）、两张表的用途（存档而非推理源）、验收数字（pytest 24 而非 8） | 规格与实现各留一套说法，两周后必然对不上。**已实现的以实现为准，不以旧草案为准** |
| **④ 数字刷新** | §3 基线从回填前的「81.5 万行 / 32 小时 / 219 区间 / 53 告警」改为回填后的「456 万行 / 7.5 天 / 1,029 区间 / 722 告警」 | 旧基线写于回填之前。沿用会让后续每个判断都错位一个数量级 |

**一句话概括这次重规划**：v1.0 假设"数据够、管道值得建"，v2.0 先把这两个假设各自拿去实测，实测不成立的分别降级为"决策记录"和"可行性评估 + 基线对比"。

### 0.3 版本与归档

| 版本 | 日期 | 状态 | 原文位置 |
|---|---|---|---|
| v0.1 | 2026-11-24 | 草案，G 组九项待确认 | git 历史 `9ab70b7` |
| v1.0 | 2026-11-24 | 冻结，G 组按建议执行 | `docs/archive/spec_phase4_v1.0.md` |
| v1.1 | 2026-11-25 | 4.2 批后升版，补实现细节与 D-18 ~ D-25 | `docs/archive/spec_phase4_v1.1.md` |
| **v2.0** | **2026-11-25** | **本文件，按六项决策重规划** | `docs/spec_phase4.md` |

> 归档文件**只读**。以后要查"这条当初是怎么写的"，去归档里看，不要改归档。

---

## 1. 决策变更表

本章是 v1.0 → v2.0 的完整账本。**每一条都能追到"旧条款在哪、新条款是什么、为什么改"**。施工时如果发现某条旧条款没在这里出现，说明它被原样沿用，不是被漏掉。

### 1.1 块级变更

| 旧条款（**v1.0 编号，与本文同名章节不是一回事**） | 新条款（v2.0） | 变更理由 |
|---|---|---|
| 旧 §2.1 六块：C → F → B → **A** → D → E | 五块：C → F → B → D → E，外加一份 **A′ 决策记录**（不改代码、不改 compose） | A 块不是"晚点做"，是**判定为当前规模下不该做**。负载 7 行/秒，实测写入上限 26,186 行/秒，余量 3,700 倍 |
| 旧 §2.2「六块全做完才算阶段完成」 | 五块交付完成 + A′ 文档评审通过 | A′ 的产物是判断而非功能，用文档评审验收，不用脚本验收 |
| 旧 §8 A 块整节：KRaft 拓扑 / 分区方案 / `--sink` 生产者 / 消费者 / 四条判据 | **整节废止**，置换为本文 §7「Kafka 决策记录的写作提纲」；交付 `docs/decision_kafka.md` | 接上 Kafka 的净效果是「模拟器 → HTTP → Kafka → 消费者 → 同一个 `save_telemetry()`」：多一跳、多一个容器、多一类（积压/重复消费/分区不均）故障，功能零增加。而现有 HTTP 路径已经具备批量、幂等（`ON CONFLICT DO NOTHING`）、重试 |
| 旧 §9 D 块：规则聚合风险打分（0.5 / 0.3 / 0.2 加权） | 先做**数据可行性评估**，再给一个**明确标注"演示级、不具备预测能力"**的剩余寿命指示（振动趋势外推） | 维护记录实测 **3 条**（2 完成 / 1 进行中，全部集中在 11-24 同一天）。3 行数据训不出分类器；规则聚合版同样无法验证——没有任何一列可以当作"风险分数是否正确"的答案 |
| 旧 §10 E 块：小时 × 产线 + MAPE + 三个基线 | 固定 **4 小时槽位（48 格 / 42 格有单）**与**天级（8 桶 / 7 个完整日）** 两个粒度；验收标准 = **与最笨基线相比是否显著改善，不显著就如实写不显著** | 实测小时 × 产线网格 660 格中 440 格为空（**66.7%**），天级只有 7 个完整样本。原写法把"能预测"当成了已知前提 |
| 旧 §11 验收清单（含 `docker compose up -d kafka`、`--sink kafka`、两张 PNG、`ml.anomaly_detection.score`、`ml.fault_risk.train`、`ml.production_forecast.train`、`pytest 8 passed`） | 按批次重写（本文 §5）；脚本名以实际文件为准；PNG 已废止；pytest 基线 24 | 旧清单里 **3 个模块名从未存在**（`score.py` / `fault_risk/train.py` / `production_forecast/train.py`），照抄会直接 `ModuleNotFoundError`；PNG 已被偏差 D-12 废止 |
| 旧 §12 五批（4.1 ~ 4.5） | 七批（4.1 ~ 4.7），见本文 §4 | B 块拆成「迁移」与「压缩 + 查询对比」两批：换镜像要重建库，而"迁移前"的体积口径必须在换镜像之前采，混做会永久丢掉这组数字；A′ 独立成批，避免"顺手也把 Kafka 装上" |

### 1.2 G 组九项去向

作者 2026-11-24 确认的 G-01 ~ G-09 逐条处理如下。**没有一项因本次决策而彻底失效**；唯一被否掉的是 G-06 里的 Kafka 依赖。

| 编号 | 内容（v1.0） | 去向 | 理由 |
|---|---|---|---|
| **G-01** | 推理放后端进程内，lazy load + schema 校验 + 失败降级 | **保留，注明已实现** | 4.2 批已落地：artifact 缺失 / 指纹不符 / 依赖未装一律 `loaded=false` + 人话原因，接口仍返回 200；降级时告警照旧由阈值规则产生，与原意一致 |
| **G-02** | 二分类主任务 + 三分类归因辅任务 | **保留，注明已实现** | 三分类宏 F1 1.0 属"每设备只配一种异常类型"的数据集事实，不能当泛化能力，已写入验收文档 |
| **G-03** | 按时间切分 + 随机切分作反面对照 | **保留，注明已实现** | 随机切分虚高 +0.0123 已量化；偏差 D-17 修掉了跨切分区间造成的时间重叠 |
| **G-04** | 不改 WebSocket 契约 | **保留（沿用）** | 模型分数只走新增 REST 接口，WS snapshot 仍是 14 字段，前端零改动 |
| **G-05** | TimescaleDB 镜像锁 `2.17.2-pg16` | **保留，并细化** | `postgres:16` 官方镜像不含扩展这条硬约束不变；迁移参数与测量口径补在 §6 |
| **G-06** | 五个新依赖：sklearn / xgboost / joblib / pyarrow / **kafka-python** | **修订：删掉 `kafka-python==2.0.2`，其余四个保留** | Kafka 不接，依赖也不该留。留一个用不上的库，等于给"以后顺手接一下"留口子，也会让人误以为本项目具备 Kafka 能力 |
| **G-07** | 新增 `model_versions`、`anomaly_scores` 两张表 | **保留，注明已实现** | 表结构不变；用途按偏差 D-18 / D-19 修正为"历史存档"，推理真相源是 artifact |
| **G-08** | 特征按设备正常区间归一化，基线只从训练期计算 | **保留，注明已实现** | 基线存进 `anomaly_meta.json`，推理侧复用同一份，避免训练与推理各算一次 |
| **G-09** | 只用 `class_weight` / `scale_pos_weight`，不做 SMOTE | **保留，注明已实现** | 84.8 万行 × 1.68% 正例，过采样会把内存打爆（实测峰值已顶到可用内存上限） |

### 1.3 逐节条款变更

| 旧条款（v1.0 编号） | 新条款 | 理由 |
|---|---|---|
| 旧 §1 基线：81.5 万行 / 32 小时 / 219 区间 / 53 告警 / 52 订单 | 本文 §3 按当前实测全量重填 | 旧基线写于回填**之前**（见 0.2 第 ④ 类） |
| 旧 §1.3「动工前必须先回填到 7 天」 | 改为「回填已完成」+ 记录实测行数与耗时 | 前置条件已满足，不再是一条待办 |
| 旧 §4.1 依赖清单（5 行） | 4 行，删 `kafka-python` | 同 G-06 |
| 旧 §5.8 训练产物（joblib + 报告 + 两张 PNG） | 以实际产物为准：`artifacts/anomaly_xgb_<commit>.joblib`、`anomaly_meta.json`、`ml/evaluation/reports/*.json` 与 `*.md` | 偏差 D-12 已废止 PNG；实现已定型，规格不该留第二套说法 |
| 旧 §5.10 `python -m ml.anomaly_detection.score` | `python -m ml.anomaly_detection.score_window`，参数 `--hours` / `--device` / `--end` | 旧模块名从未存在；参数写错（例如误写成 `--days`）会白跑一次批量打分 |
| 旧 §6 F 块（待施工，含伪代码与改造步骤） | 标记**已交付**；正文只留三条红线与验收锚点，细节指向 `docs/acceptance_phase4.md` 第 8 节 | 规格与实现两套说法，以后必然对不上 |
| 旧 §7 B 块（迁移 + 压缩比） | 扩写为本文 §6「TimescaleDB 迁移细则」，新增**三口径体积**（表 / 索引 / 总量） | 实测索引 554 MB **大于**表 445 MB。压缩只压 heap、不压索引，只报"总量压缩比"会得出虚高数字 |
| 旧 §13 明确不做（12 条） | 本文 §8，增补 4 条（含 3 条新禁令） | 把本次决策反转固化成禁令，防止几周后被当成"顺手补一下"重新提上来 |
| 旧 §14 冻结记录（4 条，2026-11-24） | 本文附录 C，追加 2026-11-25 四条 | 决策要能追溯"谁、哪天、为什么" |
| 旧 §15 偏差表（D-11 ~ D-25） | 移入附录 B，**保留原编号不动**；新偏差从 D-26 起 | 重新编号会打断 `docs/acceptance_phase4.md` 里已有的 D-xx 引用 |

### 1.4 新增条款（旧文完全没有）

| 新增 | 内容 | 为什么必须加 |
|---|---|---|
| §5.8 人工检查单列 | 明确哪几件事脚本测不了、看什么、判定标准是什么 | 旧文把"人工确认"混在验收命令里，等于没有验收 |
| §6.5 三口径体积 | 表 / 索引 / 总量分别记；压缩比按表口径报，同时给总量 | 索引占本次数据体积的 55%，只报总量会误导 |
| §7 决策记录提纲 | 8 个章节，每章标明要回答的问题与必须带上的数字 | 决策记录最容易写成感想，用提纲把它约束成证据链 |
| §4.5 重评触发条件 | 写入规模达到 **N 倍**时重新评估，N 由实测吞吐与安全余量算出，不是拍脑袋 | "以后再说"不是决策。N 必须有可复算的来源 |

---

## 2. 阶段目标重述

**一句话**：把「按阈值报警」升级为「有离线评估、每个数字可追溯、模型挂了能降级」的异常检测，并对剩下四个工程决策（时序存储、消息队列、故障风险、产量预测）各给出一个**有实测数字支撑的判断**——做或不做都可以，但必须有理由。

本阶段**不**旨在证明以下三件事，写论文与答辩时不要越界：

| 不证明 | 原因 |
|---|---|
| 模型在真实工厂上有效 | 全部数据由模拟器生成，标签是注入真值，不是现场故障 |
| 系统能支撑真实产线规模 | 14 台设备 / 7 行每秒是演示规模，所有容量数字都只对这个规模成立 |
| 故障风险与产量能被准确预测 | D 块只有 3 条维护记录，E 块天级只有 7 个完整样本（§3.3） |

---

## 3. 数据现状基线

> **本节全部数字为 2026-11-25 02:37:30 UTC 的同一时刻快照**，取数命令见附录 A。
> 遥测表每条 tick 增长 14 行（约 7 行/秒），所以行数与会随时间变化；**其余表的量级是稳定的**。
> 复核时若行数落在 ±1% 内属正常，若量级变了（比如订单从 220 变成 2,200）说明数据被重新回填过，需要更新本节。

### 3.1 七张表的实测规模

| 表 | 行数 | 时间跨度 | 说明 |
|---|---|---|---|
| `device_telemetry` | **4,565,384** | 2026-11-17 13:25 ~ 2026-11-25 02:37（**7.55 天**） | 14 台设备 / 2 秒采样 / 7 行每秒 |
| `anomaly_injection` | **1,029** | 同上 | 三类注入真值区间，训练标签的唯一来源 |
| `alarms` | **722** | 同上 | TEMPERATURE 463 / VIBRATION 144 / CURRENT 115；**未解除 0 条**（模拟器会自动恢复） |
| `production_orders` | **220** | 计划时间 11-17 13:25 ~ 11-24 13:25（**恰好 7 天**） | 已完成 216 / 未完成 4 |
| `maintenance_records` | **3** | 2026-11-24 09:35 ~ 12:05（**同一天 2.5 小时**） | 2 完成 + 1 进行中；**模拟器不产生维护记录，只有人工点击才写** |
| `model_versions` | **1** | 2026-11-24 21:43 | 当前生效版本 `anomaly-20261124-2143-9ab70b7` |
| `anomaly_scores` | **24,851** | 2026-11-25 01:08 ~ 02:15 | 其中判为异常 588 行；**离线存档**，页面不读这张表（偏差 D-18） |

存储占用（`device_telemetry`）：**总量 1,000 MB = 表 445 MB + 索引 554 MB**。
索引比表还大——这一点直接决定了 §6.5 的压缩比必须分口径报，否则会得出虚高的数字。

### 3.2 三条硬约束（建模方案必须围绕它们设计）

来自 4.1 批的实测，不是理论推演：

| 约束 | 实测依据 | 对方案的强制要求 |
|---|---|---|
| **① 极端不均衡** | 训练集 848,112 行中正例 14,266 行（**1.68%**） | 主指标必须是 **PR-AUC** 与宏平均 F1。用 accuracy 或 ROC-AUC 会给出漂亮假象 |
| **② 相邻行高度相关** | 同一段注入覆盖几十到几百个连续采样点 | 必须**按时间切分**，随机切分只能作反面对照。实测随机切分虚高 **+0.0123**（偏差 D-17 还修掉了跨切分区间的泄漏） |
| **③ 注入密度是演示设定** | 1,029 个区间 / 7.55 天 ≈ **每 10.6 分钟一次异常** | 前端文案必须写明"注入密度为演示设定，不代表真实工厂异常率"，否则模型指标会被误读 |

### 3.3 三块数据的天花板（这是 D / E / B 三块降级的依据）

这三组数字是 v2.0 与 v1.0 最大的分歧来源。v1.0 假设"数据够用"，实测下来三块各自撞到天花板：

**D 块（故障风险）——标签只有 3 条**

```
maintenance_records：3 行
  CNC-03  REPAIR     更换 X 轴伺服驱动器  11-24 09:35 ~ 10:05
  CNC-02  ROUTINE    更换主轴润滑油      11-24 10:35 ~ 11:05
  ROB-01  INSPECTION 季度点检（进行中）   11-24 12:05 ~
```

3 行、3 台设备、同一天、三种不同类型。**既训不出分类器，也无法验证任何风险分数是否正确**——没有任何一列可以当作"这个分数对不对"的答案。用 `alarms` 当标签也不行：告警本身就是阈值规则的输出，拿它当标签等于让模型学规则。

**E 块（产量预测）——两个粒度都不宽裕**

| 粒度 | 可用样本 | 实测依据 | 判断 |
|---|---|---|---|
| 小时 × 产线 | 660 格中 **440 格为空（66.7%）** | 空格占三分之二，绝大多数格子答案是 0，模型会退化成"永远预测 0" | **不可用** |
| 固定 4 小时槽位 | **48 格，42 格有单，6 格空**；单格订单数 1~12 | 订单按每 4 小时一批、每产线 1 单生成（220 单 = 55 批） | **勉强可用**，主粒度 |
| 天级 | **8 个日历桶，7 个完整日** | 首尾两天不完整 | 可用作对照，不能单独建模 |

> 这条实测推翻了 v1.0 的隐含前提「小时级有连续产量序列」。**没有**。E 块的验收因此改成"是否显著优于最笨基线"，而不是"预测得多准"。

**B 块（TimescaleDB）——压缩口径**

> **2026-11-25 施工后按实测修正**（原判断有误，见偏差 D-28 / D-29）。原写法是"压缩只作用于 heap，索引不会变小"，
> 实测相反：压缩把索引一起压小了 6.75 倍（486 → 72 MB），并产生 94 MB 的 toast 占用。
> 因此体积口径从三个扩为**四个**：表 / 索引 / toast / 总量。

迁移与压缩的实测体积（4.57M 行，见 §6.5）：

| 状态 | 表 | 索引 | toast | 总量 |
|---|---|---|---|---|
| 普通表（迁移前） | 446 MB | 555 MB | ~0 | 1,001 MB |
| hypertable 未压缩 | 444 MB | 486 MB | 0 | 930 MB |
| hypertable 压缩后 | 67 MB | 72 MB | 94 MB | 234 MB |

两个结论必须分开说：

1. **迁移本身**（未压缩）就把 1,001 MB 降到 930 MB（-7%），原因是重建消除了堆与索引的膨胀。**这部分不算压缩收益**，所以压缩比的分母必须用 930 MB，不能用 1,001 MB。
2. **压缩**把 930 MB 降到 234 MB。按总量算 **3.97:1**，按表口径算 **6.63:1**。两个数都要报——单报表口径会忽略 toast 与索引，单报总量会被未压缩的最新块摊薄。

### 3.4 写入吞吐实测（Kafka 决策的核心依据，4.5 批直接引用）

| 项 | 数值 | 来源 |
|---|---|---|
| 设计负载 | **7 行/秒** | 14 台设备 ÷ 2 秒采样 |
| 模拟器实测平均写入速率 | **6.71 行/秒** | 模拟器退出时的统计块（运行 1,144.6 秒 / 7,686 行） |
| 单 tick 端到端延迟 | **7 ~ 34 ms**（14 行/次） | 模拟器每 tick 打印的 `latency` |
| **单请求吞吐上限** | **26,186 行/秒** | 见下 |

吞吐上限的测法（2026-11-25 实测，可复现）：

```
POST /api/v1/telemetry/batch，单请求 5,000 行（接口上限 settings.telemetry_max_points = 5000）
设备 CNC-01，正常区间内的值（temp 62 / vib 2.0 / current 7.5 / speed 1500），
时间戳放在 2026-10-01 之后的历史空窗（该时段无真实数据，测完按 ts 区间 DELETE 清理）
跑 3 次取中位数：

第 1 次：墙钟 190.9 ms | 接口 elapsed_ms=120 | accepted=5000
第 2 次：墙钟 154.4 ms | 接口 elapsed_ms=123 | accepted=5000
第 3 次：墙钟 202.0 ms | 接口 elapsed_ms=172 | accepted=5000

中位墙钟 190.9 ms → 26,186 行/秒
```

清理核对：测试行 15,000 → `DELETE` → 剩余 0；`min(ts)` 回到 2026-11-17；告警数仍为 722（写入的是正常值，未触发任何告警）。

**这个数说明什么**：当前 HTTP 直写的余量是设计负载的 **3,700 倍**。Kafka 要解决的问题（削峰、解耦、多消费方）在这个余量下不存在。§4.5 的决策记录与 §7 的提纲都建立在「7 行/秒 vs 26,186 行/秒」这一组对比上。

> **口径说明**：26,186 行/秒是**单连接、串行、单请求**的结果，不是并发压测。真实并发会更高，但不作承诺——本阶段的结论只需要"远大于 7 行/秒"这一个方向。

---

## 4. 批次计划 4.1 ~ 4.7

七批，每批单独验收，一批不合格不进下一批。4.1 / 4.2 已交付，这里按"实现事实"回填，**不再当作待办**。

批次之间的依赖只有一条：**4.4 必须在 4.3 之后**（要压缩，先得是 hypertable）；其余各批互不阻塞。
4.5 只产出文档，可以在任何时间插入，不影响其他批。

### 4.1 异常检测训练（已完成）

| 项 | 内容 |
|---|---|
| **目标** | 用注入真值训出替代阈值规则的异常检测模型，并证明它比规则强、且强得不是靠数据泄漏 |
| **输入** | `device_telemetry` 7 天 423 万行、`anomaly_injection` 1,029 个区间、`config/devices.json` 正常区间 |
| **交付物** | `ml/common/{db,features,split,metrics}.py`、`ml/anomaly_detection/{build_dataset,train,evaluate}.py`、`artifacts/anomaly_xgb_<commit>.joblib` + `anomaly_meta.json`、`ml/evaluation/reports/*.json` 与 `*.md` |
| **硬指标（已达成）** | 训练集 848,112 行 / 78 维 / 正例 1.68%；测试集 127,206 行 / 正例 2,175；主模型 PR-AUC **0.9859**、Recall **0.9830**、Precision 0.9063，对比阈值规则 0.9098 / 0.8028；随机切分对照虚高仅 **+0.0123**；`evaluate.py` **22 项自检全过** |
| **预计工作量** | 已完成（实测约 3.5 小时，含一次回填 173.7 秒与两次因内存重跑） |
| **风险** | 内存是最大约束（可用 1.5 GB）；已用逐设备处理 + 10 秒抽稀（偏差 D-13）解决 |

### 4.2 后端接入 + AI 页（已完成）

| 项 | 内容 |
|---|---|
| **目标** | 让模型在页面上可见，且**页面上每个数字都能追到一次接口返回** |
| **输入** | 4.1 的 artifact；第 3 阶段的 `/ai` 页（当时只有真值展示） |
| **交付物** | `app/services/ml_anomaly.py`、`app/routers/ml.py`（三接口）、`model_versions` + `anomaly_scores` 两张表、`AiInsight.tsx` 重写、`scripts/acceptance-ai.mjs`（42 项） |
| **硬指标（已达成）** | `acceptance-ai.mjs` **42/42**；降级态可复现（拦截 `/ml/model-info` 后页面切降级、无 0、无白屏、0 条 JS 异常）；同窗重放一致；前端 86 tests、后端 24 passed、无回归 |
| **预计工作量** | 已完成（实测约 4.5 小时，含 6 个缺陷的定位与修复） |
| **风险** | 已发生的风险：heatmap 缺 visualMap 导致整页白屏（D-20）、`areaStyle` 盖住真值色块（D-21） |

### 4.3 TimescaleDB 迁移

| 项 | 内容 |
|---|---|
| **目标** | 在不丢一行数据的前提下把 `device_telemetry` 换成 hypertable，并留下可回滚的备份 |
| **输入** | 4,565,384 行 / 1,000 MB 的现有库；`docker-compose.yml`（`postgres:16`） |
| **交付物** | `docker-compose.yml` 镜像改为 `timescale/timescaledb:2.17.2-pg16`；`database/migrate_timescale.sql`（可重复执行）；`backup/pre_timescale.dump`；迁移前后行数与体积对照表 |
| **硬指标** | ① 迁移前后 `count(*)` 差异 **= 0**（迁移期间须停模拟器，否则数字对不上）；② `timescaledb_information.hypertables` 中 `device_telemetry` 存在且 `num_chunks ≥ 7`；③ 抽查 14 台设备各 1 小时，`count` 与 `min/max(ts)` 与迁移前完全一致；④ dump 文件 **> 0 字节**且能 restore 到临时库（回滚路径验证）；⑤ 三条回归全过：pytest 24 / `acceptance-batch2` 24 / `acceptance-motion` 17 |
| **预计工作量** | 约 3 小时（dump/restore 约 1 小时，回归与核对约 2 小时） |
| **风险** | ① 镜像换掉后数据目录不兼容，必须 dump→重建卷→restore，**不能原地升级**；② 忘记删主键会直接报 `cannot create a unique index without the column "ts"`（§6.3）；③ restore 走 stdin 时 `pg_restore` 容易写错管道；④ 迁移期间模拟器若在写，行数校验必然不齐 |

### 4.4 TimescaleDB 压缩与查询对比实验

| 项 | 内容 |
|---|---|
| **目标** | 用同一批数据、同一组查询，量出压缩到底省了多少空间、快了多少 |
| **输入** | 4.3 完成后的 hypertable；迁移前的三口径体积（4.3 已采） |
| **交付物** | 压缩脚本（`SELECT compress_chunk(...)`）；三口径体积对照表；四个代表性查询的 `EXPLAIN (ANALYZE, BUFFERS)` 原始输出；一段人话结论 |
| **硬指标** | ① 体积必须报**三个口径**：表 / 索引 / 总量，且压缩前后各一组；② 压缩比同时给**表口径**与**总量口径**；③ 四个查询各跑 **3 次取中位数**，迁移前后各一遍，原始输出入档；④ `hypertable_compression_stats` 输出入档；⑤ 压缩后三条回归仍全过 |
| **预计工作量** | 约 2.5 小时（压缩本身快，四个查询 × 3 次 × 两遍是主要时间） |
| **风险** | ① 只报总量会把压缩比摊薄（索引占 55%），结论失真；② 压缩后若查询未走 chunk 剪枝，耗时可能反而变慢——如实记录；③ 24 小时全表查询在压缩块上可能触发解压，耗时不降反升 |

### 4.5 Kafka 可行性测算与决策记录

| 项 | 内容 |
|---|---|
| **目标** | 用实测数字回答"这个系统该不该上 Kafka"，并把答案固化成一份可被质疑的决策记录 |
| **输入** | §3.4 的吞吐实测（7 行/秒 vs 26,186 行/秒）；`docker-compose.yml` 现状（仅 db 一个服务） |
| **交付物** | **`docs/decision_kafka.md` 一份文档**。不含任何 Kafka 代码、不改 compose、不新增依赖 |
| **硬指标** | ① 文档按 §7 的 8 个章节成文，每章都回答提纲里列的问题；② 必含 4 个数字：实测单请求吞吐、设计负载、对比倍数、重评触发倍数 N；③ 必含成本清单（容器/代码/故障点/工期）四项；④ `git diff --name-only` 结果**只有 `docs/decision_kafka.md`**（这条用来证明"真的没动代码"）；⑤ 全文不得出现"可选 / 预留 / 以后可以接"这类模糊表述（用 §8 的禁令原文校验） |
| **预计工作量** | 约 2 小时（压测复跑 20 分钟 + 写作 100 分钟） |
| **风险** | ① 容易写成"Kafka 很好但我们用不上"的感想，必须用提纲约束成证据链；② Kafka 单分区容量只能引用公开资料量级，**不能伪装成本项目实测**，必须显式标注来源 |

### 4.6 D 块：数据可行性评估 + 演示级剩余寿命指示

| 项 | 内容 |
|---|---|
| **目标** | 先说清"3 条维护记录能做什么、不能做什么"，再给一个**明确标注不具备预测能力**的最小实现 |
| **输入** | `maintenance_records` 3 行、`alarms` 722 行、`anomaly_scores` 24,851 行、`device_telemetry` 振动序列 |
| **交付物** | `docs/feasibility_fault_risk.md`（可行性报告）；`ml/fault_risk/trend.py`（振动趋势外推，输出 0~1 的"趋势指示"与剩余时间估计）；`app/routers/ml.py` 新增 `/ml/fault-risk`；**AI 页新增「设备健康」区块**（§9 已确认，与模型输出同页，复用降级文案机制）；`scripts/acceptance-fault-risk.mjs`（断言两个免责文案真的渲染出来） |
| **硬指标** | ① 报告写出 4 个数：维护记录 3 条、覆盖设备 3 台、时间跨度 2.5 小时、可构造的正例上限 3；② 明确回答"为什么不做监督分类"并给出上述数字；③ 趋势脚本对 14 台设备全部产出结果，无 NaN、无负值；④ 页面上 `getByText('演示级')` 与 `getByText('不具备预测能力')` 可命中（脚本断言，不靠人工看）；⑤ pytest 与两套页面验收无回归 |
| **预计工作量** | 约 5 小时（报告 2 小时 + 实现 2 小时 + 验收脚本 1 小时） |
| **风险** | ① 最容易滑向"既然是 AI 模块就得有模型"，一旦写出准确率就是在造假；② 振动趋势外推在设备停机段会失真，必须显式排除 STOPPED 区间；③ 页面文案若漏掉"演示级"，等于默认它有预测能力 |

### 4.7 E 块：产量预测与最笨基线对比

| 项 | 内容 |
|---|---|
| **目标** | 回答"这点数据到底能不能预测产量"，答案很可能是"不能"，但那也要有对比表支撑 |
| **输入** | `production_orders` 220 单（计划时间恰好 7 天）；两个粒度：4 小时槽位 48 格 / 42 格有单，天级 7 个完整日 |
| **交付物** | `ml/production_forecast/{dataset,baselines,evaluate}.py`；对比表（模型 vs 至少 3 个最笨基线）；一段结论，含"是否显著"的明确判断 |
| **硬指标** | ① 基线不少于 3 个，且必须包含**全局均值**与**上一槽位值（persistence）**这两个最笨的；② 报告 MAPE 与 MAE，且**模型与每个基线并排**；③ 给出显著性判断：能检验就报检验统计量与 p 值，样本不足以检验就**明确写"样本量不足，无法判断显著性"**；④ 结论必须直说"显著 / 不显著"，不显著时**禁止**用"趋势向好""具备参考价值"等模糊措辞替代；⑤ 若最终结论是"模型未优于基线"，报告里必须保留该结论，不得删表 |
| **预计工作量** | 约 5 小时（数据集与基线 2 小时 + 评估 1 小时 + 结论与文档 2 小时） |
| **风险** | ① 42 个样本做时间序列，任何调参都极易过拟合，**禁止按测试集调参**；② 4 小时槽位单格订单数 1~12 波动大，MAPE 在真值为 0 或极小时会爆炸，需先定义分母为 0 的处理规则；③ 最大风险是"为了让数字好看而反复试模型"，本批的验收标准明确为"对比表完整 + 结论诚实"，不是"指标高" |

---

## 5. 每批的验收命令与预期输出

约定：

- 命令默认在**仓库根目录、PowerShell** 中执行；数据库命令假设容器名 `sftwin-db`、库名 `smartfactory`、用户 `sf`。
- **Git Bash 用户注意**：`/database/xxx.sql` 会被 MSYS 当成 Windows 路径改写，需先 `export MSYS_NO_PATHCONV=1`，或写成 `//database/xxx.sql`。这是本机实测踩过的坑。
- 凡是脚本能断言的，**不许写"人工确认"**；确实无法自动化的集中在 §5.8。
- 预期输出里带 `≈` 或给出区间的，说明该数字随时间或机器状态浮动，验收看量级与方向，不看最后一位。

### 5.1 4.1 批：异常检测训练（已完成，复跑用）

```powershell
cd D:\wbproject\2026-11-24-10-02-56
.\.venv\Scripts\Activate.ps1
python -m ml.anomaly_detection.build_dataset      # 约 33 秒
python -m ml.anomaly_detection.train              # 约 65 秒
python -m ml.anomaly_detection.evaluate           # 22 项自检
```

预期：

```text
build_dataset：导出 848,112 行 × 78 列 parquet
train        ：四模型指标表 + artifacts/anomaly_xgb_<commit>.joblib + anomaly_meta.json
evaluate     ：22 项自检全部 PASS；主模型 PR-AUC ≈ 0.9859、Recall ≈ 0.9830
```

判定：`evaluate` **退出码 0**，且输出里 `FAIL` 出现 0 次。出现任何 FAIL 说明训练产物与报告不自洽，不许继续用该 artifact。

### 5.2 4.2 批：后端接入 + AI 页（已完成，复跑用）

前置：后端、模拟器、前端、CDP Chrome（`--remote-debugging-port=9222`）都在跑。

```powershell
node scripts\acceptance-ai.mjs
node scripts\acceptance-batch2.mjs
node scripts\acceptance-motion.mjs
cd frontend; npm run test; cd ..
```

预期：

```text
acceptance-ai.mjs       合计 42 项，通过 42，失败 0
acceptance-batch2.mjs   合计 24 项，通过 24，失败 0
acceptance-motion.mjs   合计 17 项，通过 17，失败 0
npm run test            9 files / 86 tests passed
```

判定：三个脚本退出码均为 0 且"失败 0"。`acceptance-ai.mjs` 里「全程无页面运行时异常」必须 PASS——它专门抓 heatmap 缺 visualMap 这类渲染期崩溃（偏差 D-20）。

### 5.3 4.3 批：TimescaleDB 迁移

**第一步：迁移前先采基线（此时还没换镜像）**

```powershell
# 先停模拟器，否则迁移期间还有新行进来，行数校验永远对不上
docker exec sftwin-db psql -U sf -d smartfactory -c "SELECT count(*), min(ts), max(ts) FROM device_telemetry;"
docker exec sftwin-db psql -U sf -d smartfactory -c "SELECT pg_size_pretty(pg_total_relation_size('device_telemetry')) AS total, pg_size_pretty(pg_relation_size('device_telemetry')) AS tbl, pg_size_pretty(pg_indexes_size('device_telemetry')) AS idx;"
```

预期（当前基线）：

```text
 count     |             min           |             max
-----------+---------------------------+---------------------------
 4,565,384 | 2026-11-17 13:25:06+00    | 2026-11-25 02:37:30+00
 total   |  tbl   |  idx
---------+--------+--------
 1000 MB | 445 MB | 554 MB
```

**第二步：备份并校验备份不是空的**

```powershell
docker exec sftwin-db pg_dump -U sf -d smartfactory -Fc > backup\pre_timescale.dump
(Get-Item backup\pre_timescale.dump).Length
```

预期：**实测 78,476,537 字节（约 75 MB）**，custom + gzip 格式。
判据：**> 10 MB**，且 `pg_restore -l` 能列出 TOC（98 个条目）。接近 0 或列不出 TOC，立刻停手——回滚路径已经断了。

> 初稿把预期写成「> 100 MB」是估的，实际 78 MB：遥测数据重复度高，gzip 后压得很狠。见偏差 D-26。

**第三步：换镜像并重建库**

```powershell
docker compose down
docker volume ls                                   # 确认真实卷名，不要照抄占位名
docker volume rm <上一步看到的卷名>
docker compose up -d
docker exec sftwin-db pg_isready -U sf -d smartfactory
```

预期：`/var/run/postgresql:5432 - accepting connections`

**第四步：建表 → 恢复数据 → 执行迁移脚本**

```powershell
Get-Content database\schema.sql | docker exec -i sftwin-db psql -U sf -d smartfactory
docker exec -i sftwin-db pg_restore -U sf -d smartfactory --data-only < backup\pre_timescale.dump
Get-Content database\migrate_timescale.sql | docker exec -i sftwin-db psql -U sf -d smartfactory
```

预期：restore 无 `ERROR`；迁移脚本打印 `CREATE EXTENSION`、`ALTER TABLE`，`create_hypertable` 返回 hypertable 的 id。

**第五步：校验（四查）**

```powershell
# ① 行数与时间范围必须与第一步完全一致
docker exec sftwin-db psql -U sf -d smartfactory -c "SELECT count(*), min(ts), max(ts) FROM device_telemetry;"

# ② hypertable 与分块数
docker exec sftwin-db psql -U sf -d smartfactory -c "SELECT hypertable_name, num_chunks FROM timescaledb_information.hypertables WHERE hypertable_name='device_telemetry';"

# ③ 逐设备抽查：14 台各取最近 1 小时，行数应接近 1800（1 小时 ÷ 2 秒）
docker exec sftwin-db psql -U sf -d smartfactory -c "SELECT device_id, count(*) FROM device_telemetry WHERE ts >= now() - INTERVAL '1 hour' GROUP BY 1 ORDER BY 1;"

# ④ 主键已删、唯一约束仍在（迁移能成功的前提，见 §6.3）
docker exec sftwin-db psql -U sf -d smartfactory -c "SELECT conname, contype FROM pg_constraint WHERE conrelid='device_telemetry'::regclass ORDER BY conname;"
```

预期：

```text
① 行数 = 第一步的数字（差异 0）；min/max(ts) 完全一致
② device_telemetry | 9        （数据跨 9 个 UTC 日历日 → 9 个 chunk，实测值）
③ 14 行，计数在 1700~1800 之间（模拟器启停会少几个点）
④ 只剩 uq_telemetry_device_ts（contype = u）与 fk_telemetry_device（contype = f），没有 device_telemetry_pkey
```

> ② 的 9 而不是 8：chunk 按 UTC 日界切分，数据从 11-17 13:25 到 11-25 02:50，横跨 9 个日历日（首尾两天不完整）。
>
> **跑过 pytest 之后会变成 10**，且多出一个 `range_start = 2020-03-01` 的空 chunk。这不是数据异常：
> `test_over_5000_points_is_downsampled` 用固定时间戳 2020-03-01 造 5100 个点验证降采样，
> `purge` fixture 只删行、不删 chunk，TimescaleDB 也不会因为它空了就自动回收（偏差 D-37）。
> 判断"chunk 数对不对"时要先看这个空 chunk 在不在。

**第六步：三条回归必须全过**

```powershell
python -m pytest tests -q          # 先停 uvicorn！见下方注意
node scripts\acceptance-batch2.mjs
node scripts\acceptance-motion.mjs
```

预期：`24 passed`、`24 / 24`、`17 / 17`。

> ⚠️ 跑 pytest 前必须停掉 uvicorn：两个进程抢写告警表会让冷却类用例随机失败（实测出现过 `assert 2 == 1`）。这不是代码 bug。

### 5.4 4.4 批：压缩与查询对比

```powershell
# ① 迁移后、压缩前的四口径体积（注意用 hypertable_detailed_size，不是 pg_*，见 §6.5）
docker exec sftwin-db psql -U sf -d smartfactory -c "SELECT pg_size_pretty(table_bytes) AS 表, pg_size_pretty(index_bytes) AS 索引, pg_size_pretty(toast_bytes) AS toast, pg_size_pretty(total_bytes) AS 总量 FROM hypertable_detailed_size('device_telemetry');"

# ② 压缩「1 天以前」的块（本阶段手工调用，不装后台 job）
#    压缩块在 TS 2.17 上其实可写，但会让回填重写已压好的历史块、压缩率下降（§6.4）
docker exec sftwin-db psql -U sf -d smartfactory -c "SELECT count(*) FROM (SELECT compress_chunk(c) FROM show_chunks('device_telemetry', older_than => INTERVAL '1 day') c) t;"

# ③ 压缩后再采一次四口径 + 逐块明细
docker exec sftwin-db psql -U sf -d smartfactory -c "SELECT pg_size_pretty(table_bytes) AS 表, pg_size_pretty(index_bytes) AS 索引, pg_size_pretty(toast_bytes) AS toast, pg_size_pretty(total_bytes) AS 总量 FROM hypertable_detailed_size('device_telemetry');"
docker exec sftwin-db psql -U sf -d smartfactory -c "SELECT chunk_name, range_start::date AS 起, pg_size_pretty(total_bytes) AS 大小, is_compressed FROM chunks_detailed_size('device_telemetry') c JOIN timescaledb_information.chunks i USING (chunk_name) ORDER BY range_start;"
```

预期（实测值，4.57M 行）：

```text
压缩前：表 444 MB / 索引 486 MB / toast 0      / 总量 930 MB
压缩后：表  67 MB / 索引  72 MB / toast 94 MB / 总量 234 MB
逐块：7 个旧块 is_compressed=t（各约 7~15 MB），最新 2 个块仍为 f
```

> 压缩后**索引也一起变小了**（486 → 72 MB）。这与"索引不参与压缩"的直觉相反，实测如此，写报告时按实测写。

**④ 查询耗时：固定窗口 + 四次执行 + 五个查询**

窗口**锚定在固定时间戳**（本阶段用迁移前的 `max(ts)` = `2026-11-25 02:50:10+00`），不用 `now()`，否则三个状态之间窗口会漂移。每个查询跑 4 次：第 1 次预热不计，后 3 次取中位数。

```powershell
docker exec -it sftwin-db psql -U sf -d smartfactory
```

```sql
\timing on
-- Q1 单设备最近 1 小时曲线（前端最常用）
SELECT ts, temperature, vibration, current, speed FROM device_telemetry
WHERE device_id='CNC-01' AND ts >= '2026-11-25 02:50:10+00'::timestamptz - INTERVAL '1 hour' ORDER BY ts;

-- Q2 全厂最近 1 小时平均温度（总览 KPI）
SELECT device_id, avg(temperature) FROM device_telemetry
WHERE ts >= '2026-11-25 02:50:10+00'::timestamptz - INTERVAL '1 hour' GROUP BY device_id;

-- Q3 某设备 24 小时按分钟聚合（生产页）
SELECT time_bucket('1 minute', ts) AS m, avg(temperature) FROM device_telemetry
WHERE device_id='CNC-01' AND ts >= '2026-11-25 02:50:10+00'::timestamptz - INTERVAL '24 hours' GROUP BY 1 ORDER BY 1;

-- Q4 全表按小时计数（回填校验用）
SELECT time_bucket('1 hour', ts) AS h, count(*) FROM device_telemetry GROUP BY 1 ORDER BY 1;

-- Q5 【必须有】冷数据查询：固定查 2026-11-20 全天，该块在压缩态下是压缩块
SELECT time_bucket('1 hour', ts) AS h, avg(temperature), max(vibration), count(*)
FROM device_telemetry
WHERE device_id='CNC-01' AND ts >= '2026-11-20 00:00:00+00' AND ts < '2026-11-21 00:00:00+00'
GROUP BY 1 ORDER BY 1;
```

> **Q5 不是可选项。** Q1~Q3 的窗口都落在最新的未压缩块上，根本碰不到压缩块；只测这四个会得出"压缩对查询毫无影响"的错误结论。
> 实测 Q5 三态中位数：**6.08 ms（普通表）/ 5.94 ms（hypertable 未压缩）/ 3.23 ms（压缩）**，
> 压缩相对普通表 **-47%**，而 hypertable 本身几乎没变——压缩的查询收益全在这个查询上体现。

预期：五个查询各 4 个 `Time:` 值（1 预热 + 3 计），**20 个原始值全部入档**；三个状态各一遍，共 60 个值。

判定：

1. 四个体积口径**都记录了**，缺任何一个视为未完成；
2. 每个查询三次的波动 **< 30%**；超过说明环境不干净，需重测（§5.8 第 1 项）。**Q4 波动可达 17%，必须测两遍**；
3. 结论一句话里必须同时出现"压缩前 X MB / 压缩后 Y MB / 压缩比 Z:1 / 查询从 A ms 到 B ms"四个数；
4. 必须说明趋势方向，**分查询类型**（实测结论，见 §6.5）：
   - **扫描类查询**：压缩明确变快——Q4 全表聚合 96.77 → 66.53 ms（**-31%**）、Q5 冷数据单设备 6.08 → 3.23 ms（**-47%**）；
   - **点查类查询**：压缩没有收益甚至略慢——Q1 单设备 1 小时 0.45 → 0.67 ms、Q2 全厂均温 3.38 → 3.96 ms，但绝对差 ≤ 0.6 ms，工程上可忽略；
   - **Q3（24 小时聚合）**：5.61 → 4.84 ms（-14%），介于两者之间。
   不许笼统写"性能提升"，必须按上面的分类写清楚"哪类查询快多少、哪类没有变化"。

### 5.5 4.5 批：Kafka 决策记录

```powershell
# ① 文档存在且按提纲成文（二级标题数应为 8）
(Select-String -Path docs\decision_kafka.md -Pattern '^## ').Count

# ② 四个必需数字逐个数（每个都应 ≥ 1；不合并计数，避免两个数字同处一行时漏判）
'26,186','7 行/秒','3,700','1,200' | ForEach-Object {
  "{0} → {1}" -f $_, (Select-String -Path docs\decision_kafka.md -Pattern $_ -SimpleMatch).Count
}

# ③ 验证"真的没动代码"：本次改动只应有这一个新文件
git status --porcelain

# ④ 验证没有模糊表述残留（应输出 0 行）
(Select-String -Path docs\decision_kafka.md -Pattern '可选地接|预留接口|以后可以接|未来可接|可选方案').Count
```

预期：

```text
① 8
② 26,186 → ≥1   7 行/秒 → ≥1   3,700 → ≥1   1,200 → ≥1
③ ?? docs/decision_kafka.md      ← 只有这一行；不得出现 M app/  M data_pipeline/  M docker-compose.yml
④ 0
```

判定：③ 是关键。只要 `git status` 里出现 `docker-compose.yml` 或 `data_pipeline/` 的改动，本批即不合格——那说明"只写文档"没做到。

### 5.6 4.6 批：D 块可行性 + 演示级指示

```powershell
# ① 可行性报告存在且含关键数字（命中数应 ≥ 3）
(Select-String -Path docs\feasibility_fault_risk.md -Pattern '3 条|3 台|2.5 小时').Count

# ② 趋势脚本对 14 台设备全部产出，无 NaN、无负值
python -m ml.fault_risk.trend --all

# ③ 接口可用
curl "http://127.0.0.1:8000/api/v1/ml/fault-risk?device_id=CNC-01"

# ④ 页面上的"演示级""不具备预测能力"必须真的渲染出来（脚本断言，不靠肉眼）
node scripts\acceptance-fault-risk.mjs
```

预期：

```text
① ≥ 3
② 14 行输出，每行含 device_id + 趋势指示(0~1) + 依据窗口；无 nan / inf / 负值
③ HTTP 200，JSON 含 "disclaimer":"演示级，不具备预测能力"
④ 合计 N 项，通过 N，失败 0
```

判定：④ 里必须有两条断言分别命中"演示级"与"不具备预测能力"。**这两条不许删**——它们是这块唯一能防止被误读的机制。

### 5.7 4.7 批：E 块产量预测与基线对比

```powershell
python -m ml.production_forecast.evaluate
```

预期输出必须包含（缺一项即不合格）：

```text
【粒度】4 小时槽位：48 格 / 42 格有单；天级：8 桶 / 7 个完整日
【对比表】列 = 基线名 | MAPE | MAE，至少四行：
  全局均值（最笨基线） / 上一槽位值 persistence（最笨基线） / 最近 3 槽移动平均 / 模型
【显著性】检验统计量与 p 值；或「样本量不足（n=42），无法判断显著性」
【结论】显著 / 不显著（二选一）
```

判定：

1. 基线 ≥ 3 个，且必须含 `全局均值` 与 `persistence`；
2. 模型与每个基线**在同一张表**里并排；
3. 结论句必须是"显著"或"不显著"之一。**模型没赢时，对比表一行都不许删**；
4. 全文不得出现"趋势向好 / 初步有效 / 具备参考价值 / 有一定指导意义"这类替代词（`Select-String` 校验，命中即不合格）。

### 5.8 人工检查（无法自动化的部分，单列）

以下三项脚本给不出结论，必须人看。**每项都写清看什么、怎么判**：

| # | 检查项 | 看什么 | 判定标准 | 为什么不能自动化 |
|---|---|---|---|---|
| 1 | 压缩前后耗时的**可比性** | §5.4 里每个查询的 3 个原始时间值 | 三次波动 < 30% 才可信；超过则重测 | 机器负载（Docker / WSL / Chrome）影响耗时，脚本无法判断"这一轮环境是否干净" |
| 2 | 压缩后 **24 小时窗口的页面手感** | 设备监控页切 1h / 6h / 24h | 切换后 < 2 秒出图、无长时间白屏 | 无头环境是软渲染，帧率与手感测不出真实值 |
| 3 | D 块趋势指示的**语义合理性** | 把 CNC-01 的振动曲线与该设备的趋势指示并排看 | 指示值升高时肉眼也能看出振动在爬升；不允许"曲线平稳但指示接近 1" | 演示级外推没有真值可比，只能靠人判断"讲不讲得通" |

> 这三项要在验收文档里各留一行人工结论（谁、哪天、看到什么），不能空着。

---

## 6. TimescaleDB 迁移细则

### 6.1 镜像版本与替换路径

| 项 | 值 | 理由 |
|---|---|---|
| 镜像 | **`timescale/timescaledb:2.17.2-pg16`** | 锁到小版本，不用 `latest`。`postgres:16` 官方镜像**不含** timescaledb 扩展，`CREATE EXTENSION timescaledb` 会报 `could not open extension control file` |
| 扩展预加载 | 官方镜像已设 `shared_preload_libraries=timescaledb` | 若换自建镜像，必须自己加，否则 `CREATE EXTENSION` 报 "must be loaded via shared_preload_libraries" |
| 替换方式 | **dump → 重建卷 → restore**，不做原地升级 | 镜像换了，数据目录格式与 WAL 兼容性无法保证。原地升级失败时旧数据也一起坏 |

> 版本号在动工当天再确认一次镜像可拉取（`docker pull timescale/timescaledb:2.17.2-pg16`）。拉不到就换同 major 的可用 tag，并记进偏差表——**不许悄悄改成 `latest`**。

### 6.2 `create_hypertable` 的写法与 `migrate_data` 的含义

```sql
SELECT create_hypertable(
         'device_telemetry',        -- 表名
         'ts',                      -- 时间分区列
         chunk_time_interval => INTERVAL '1 day',
         migrate_data => true
       );
```

三个参数各自的理由：

| 参数 | 取值 | 为什么 |
|---|---|---|
| 时间列 | `ts` | 唯一单调递增的列。`id` 虽然近似递增，但语义上是代理键，且回填时乱序写入，不能当分区键 |
| `chunk_time_interval` | **1 天** | 当前 7.55 天 ≈ 8 个 chunk（实测 §5.3 预期 `num_chunks = 8`）。太小（1 小时）→ 180 个 chunk，查询规划开销大；太大（7 天）→ 只有 1~2 个 chunk，压缩粒度粗、chunk 剪枝失效 |
| `migrate_data` | **`true`，必须** | 表里已有 456 万行。对非空表不设 `true`，`create_hypertable` 会拒绝执行（多数版本报 `table is not empty`）；即便某个版本容忍，已有行也不会被搬进 chunk，会出现"数据还在、hypertable 里查不到"的怪状态。这一项没有第二种选择 |

`migrate_data => true` 的两个实际影响，动工前必须知道：

1. **会取 ACCESS EXCLUSIVE 锁**，整个搬迁期间该表不可读不可写。456 万行的搬迁时间在几十秒到几分钟量级——**必须先停模拟器**，否则后端写入会被阻塞甚至超时。
2. **搬迁不是事务回滚安全的**。脚本中途失败会留下"部分已转 chunk"的状态。所以迁移脚本必须可重复执行（全部 `IF EXISTS` / `IF NOT EXISTS`），失败后直接从 dump 重来，不要在半个状态上打补丁。

### 6.3 为什么 `uq_telemetry_device_ts` 允许直接转换，而主键必须先删

这是整个迁移唯一的硬门槛，写清楚免得后来人反复踩。

**规则**：hypertable 上的**每一个唯一索引/唯一约束，都必须包含全部分区列**。本项目分区列是 `ts`。

对照现有两个约束：

| 约束 | 定义 | 含 `ts`？ | 结果 |
|---|---|---|---|
| `device_telemetry_pkey` | `PRIMARY KEY (id)` | ❌ | **必须先删**，否则 `create_hypertable` 报 `cannot create a unique index without the column "ts" (used in partitioning)` |
| `uq_telemetry_device_ts` | `UNIQUE (device_id, ts)` | ✅ | **可以直接转换**，不用动 |

**为什么含 `ts` 就真的能保证全局唯一**（不是"TimescaleDB 网开一面"）：

hypertable 的唯一索引是**按 chunk 各自建立**的，不是全局一个 B 树。看起来这会破坏唯一性，但 chunk 是按 `ts` 的区间切分的——**同一个 `ts` 只可能落在唯一一个 chunk 里**。
所以 `(device_id, ts)` 的重复项如果存在，必然出现在同一个 chunk 内，而该 chunk 内的唯一索引会挡住它。
结论：只要唯一键包含分区列，跨 chunk 的唯一性由"时间区间互不重叠"天然保证。

反例（说明规则的边界）：假如唯一键是 `(device_id, running_status)` 这种不含 `ts` 的组合，同一个值可能散落在多个 chunk，任何单 chunk 内的索引都管不到别的 chunk，全局唯一就无法实现——TimescaleDB 因此直接拒绝，不是保守。

**顺带说清三件相关的事**：

1. **删主键不影响 `RETURNING id`**。后端 `telemetry_service.py` 是裸 SQL `INSERT ... RETURNING id`，`id` 列、`NOT NULL`、序列默认值都保留，只是不再有唯一约束。已核实代码没有 ORM 模型依赖主键。
2. **`ON CONFLICT (device_id, ts) DO NOTHING` 依然可用**。后端批量写入与回填都依赖这个幂等路径，迁移后必须重跑一次写入验证（第 2 阶段 7.8 那条命令），确认 `duplicated` 计数仍正常。
3. **外键方向可以保留，反向不行**。`fk_telemetry_device` 是「hypertable → 普通表 `devices`」方向，TimescaleDB 支持；反过来（普通表的外键**指向** hypertable）不支持。所以以后若有表想引用遥测表，方案要重做，不能直接加外键。迁移后 `\d device_telemetry` 要能看到 `fk_telemetry_device` 仍在。

### 6.4 压缩策略

```sql
ALTER TABLE device_telemetry SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'device_id',
  timescaledb.compress_orderby   = 'ts DESC'
);
```

| 参数 | 取值 | 选择依据 |
|---|---|---|
| `compress_segmentby` | `device_id` | 按设备分段。前端与接口的查询**几乎都带 `device_id`**（`/devices/{id}/telemetry`、`/ml/anomaly/scores`），分段后能按段剪枝，只需解压命中的那几段。若不分段，任何查询都要解压整个 chunk |
| `compress_orderby` | `ts DESC` | 段内按时间倒序。前端查"最近 N 条"时能顺序读到最近的记录，不必解压全段；时间戳单调，delta 编码的压缩率也最高 |
| 不加 `running_status` 到 segmentby | — | 只有 3 个取值，加进去会让段数翻三倍、每段变小，压缩率下降；而本系统没有"按状态查时序"的需求 |

**压缩块可写入，但不是免费的**（2026-11-25 实测修正，见偏差 D-30）：

- TimescaleDB 2.17 **支持**对压缩块做 INSERT / UPDATE / DELETE。实测往已压缩的 `_hyper_1_5_chunk`（`is_compressed=t`）插入一行，语句返回 `INSERT 0 1`，查询立刻可见，删除也正常（验证后已清理，行数回到 0）。
- 所以"回填跨进压缩边界会失败"这个说法**不成立**。真正的代价是**性能**：写入压缩块需要定位并重写压缩批次，比写普通块慢，且会打乱压缩率。
- 结论不变但要改理由：压缩边界仍应设成 7 天，目的不是"避免报错"，而是**避免让回填去重写已经压好的历史块**（重写后压缩率下降、还可能留下碎片）。大批量回填历史时，先 `decompress_chunk` 再回填、回填完重新压，仍然是更快更干净的做法。

**本阶段不装后台 job**（`add_compression_policy` 不做）。理由是压缩策略一旦自动化，出问题（比如把正在回填的块压掉）时排查成本远高于每天手工跑一次。这条记在 §8 的"明确不做"里。

**迁移后必须 `ANALYZE`**：

```sql
ANALYZE device_telemetry;
```

不做这一步，`pg_statistic` 还停留在迁移前的普通表状态，chunk 剪枝与连接顺序可能选错，查询耗时对比会得到一组没有意义的结果。§5.4 的所有耗时测量**必须在 `ANALYZE` 之后**进行。

### 6.5 压缩前后的测量方法

**体积：四个口径，且分两个阶段用不同函数**

第一阶段（迁移前，普通表）——用 `pg_*`：

```sql
SELECT pg_size_pretty(pg_total_relation_size('device_telemetry')) AS 总量,
       pg_size_pretty(pg_relation_size('device_telemetry'))       AS 表,
       pg_size_pretty(pg_indexes_size('device_telemetry'))        AS 索引;
```

第二阶段（迁移后，hypertable）——**必须改用 `hypertable_detailed_size()`**：

```sql
SELECT pg_size_pretty(table_bytes) AS 表,
       pg_size_pretty(index_bytes) AS 索引,
       pg_size_pretty(toast_bytes) AS toast,
       pg_size_pretty(total_bytes) AS 总量
FROM hypertable_detailed_size('device_telemetry');
```

> **为什么必须换函数**（实测踩到，偏差 D-27）：转成 hypertable 后，数据都在 chunk 里，父表只是一个空壳。
> `pg_total_relation_size('device_telemetry')` 返回 **24 kB**、`pg_relation_size` 返回 **0 bytes**，
> 而 `hypertable_size()` 返回 930 MB。继续用 `pg_*` 会得出"迁移后体积缩小 40000 倍"这种荒谬结论。

四个口径各自回答什么：

| 口径 | 回答什么问题 | 为什么必须单独记 |
|---|---|---|
| 表（`table_bytes`） | 压缩算法本身的效果 | 用它与表口径压缩前相比，得到 6.63:1 |
| 索引（`index_bytes`） | 索引占了多少 | **实测压缩会把索引一起压小**（486 → 72 MB），这与"索引不参与压缩"的常识相反 |
| toast（`toast_bytes`） | 压缩数据落在哪 | 压缩态下 94 MB 全在 toast 里。漏掉这一项，表 + 索引 139 MB 加起来对不上总量 234 MB |
| 总量（`total_bytes`） | 磁盘实际省了多少 | 答辩与 README 用这个数，但它被"未压缩的最新块"摊薄 |

**耗时：固定窗口 + 四次执行 + 两次测量**

规则（每条都有原因）：

1. **窗口必须锚定在固定时间戳**，不能用 `now()`。实测中 `now()` 会随测量推进而漂移，三个状态之间窗口不一致，结果无法比较。本阶段锚定 `'2026-11-25 02:50:10+00'`（迁移前的 `max(ts)`）。
2. **同一 SQL 文本、同一连接**，改一个空格都是另一个查询。
3. **四次执行**：第一次是冷缓存，排除；后三次取中位数。
4. **Q1~Q4 之外必须加一个 Q5（冷数据查询）**。实测发现 Q1~Q3 的窗口都落在最新的未压缩块上，**根本不会碰到压缩块**，只用这四个查询会得出"压缩对查询毫无影响"的错误结论。Q5 固定查 `2026-11-20` 全天（该块已压缩）。
5. **Q4 必须测两遍**。全表扫描的波动实测可达 17%（同一状态两次测量 216.8 ms 与 252.9 ms），单次中位数不足以下结论。

判定门槛见 §5.4：每个查询三次波动 **< 30%** 才可信。

### 6.6 回滚与失败判定

**回滚路径**（迁移前就已确定，不临时想）：

```powershell
docker compose down
# 把 docker-compose.yml 的 image 改回 postgres:16
docker volume rm <卷名>
docker compose up -d
Get-Content database\schema.sql | docker exec -i sftwin-db psql -U sf -d smartfactory
docker exec -i sftwin-db pg_restore -U sf -d smartfactory --data-only < backup\pre_timescale.dump
```

**满足以下任意一条，立即回滚，不许"再试试看"**：

| 失败信号 | 含义 |
|---|---|
| 迁移后 `count(*)` 与迁移前**不一致** | 数据丢了或重复了，压缩比再好看也没意义 |
| `timescaledb_information.hypertables` 里查不到 `device_telemetry` | 迁移根本没成功 |
| 后端批量写入报错（尤其 `ON CONFLICT` 相关） | 幂等路径断了，回填与模拟器都会炸 |
| 三条回归（pytest 24 / batch2 24 / motion 17）任一失败 | 数据库换了确实会影响别处，必须先恢复再排查 |
| dump 文件为 0 或 restore 失败 | 回滚路径已断——**这一步要在迁移前就验，不能等出事才发现** |

回滚不是失败，是正常路径。**在迁移前把回滚演练一遍**（restore 到临时库、查一次行数、删掉临时库），比出事时现学要省一小时。

---

## 7. Kafka 决策记录的写作提纲

**本节只有提纲，不含正文。** 正文在 4.5 批产出，文件为 `docs/decision_kafka.md`，共 8 个二级章节。
每章规定"要回答什么问题"和"必须带上哪个数字"——缺数字的章节视为未完成。

| 章 | 标题 | 必须回答的问题 | 必须带的数字 |
|---|---|---|---|
| **7.1** | 结论与适用范围 | 接不接？这个结论对什么规模成立、对什么规模不成立 | 一句话结论 + 结论适用的写入量上限 |
| **7.2** | 负载现状 | 现在的真实写入速率与延迟是多少，怎么测的 | **7 行/秒**（14 台 ÷ 2 秒）、单 tick **7 ~ 34 ms**、6.71 行/秒（模拟器统计块均值） |
| **7.3** | 实测写入上限 | 这套架构在当前机器上最多能吞多少，是怎么测的（含清理方式） | **26,186 行/秒**（5,000 行 / 190.9 ms 中位数）、三次原始墙钟值与 `elapsed_ms` |
| **7.4** | 与 Kafka 单分区容量的对比 | 一个分区能吞多少，与本项目的差距是多少倍 | 单分区吞吐量级（**必须标注来源**）÷ 本项目 7 行/秒 = 倍数；同时给出"本项目自己测得的上限已落在单分区量级内"这一对比 |
| **7.5** | 上 Kafka 的成本清单 | 要付出什么：容器、代码、故障点、工期，四项都要具体 | 新增容器数 1；新增代码模块 2（生产者 + 消费者）；新增故障类型 ≥ 3（积压 / 重复消费 / 分区不均）；工期估算（人日） |
| **7.6** | 不接的决策与替代 | 不接之后，靠什么满足削峰与可靠性；现有机制已经具备什么 | 现有 HTTP 路径的能力清单：批量（单请求 5,000 行）、幂等（`ON CONFLICT DO NOTHING`）、重试（3 次退避） |
| **7.7** | 何时重新评估：N 的推导 | 写入规模达到多少倍时必须重新考虑，这个倍数是怎么算出来的 | **N ≈ 1,200 倍**，推导见下方公式；换算的设备台数 |
| **7.8** | 这个结论在什么情况下不成立 | 哪些场景与吞吐无关，但会让消息队列变得必要 | 至少 2 个场景（多消费方 / 跨机房），并说明它们在本项目中是否成立 |

### 附注 1 · 关于 7.7：N 必须这样推导（不许拍脑袋）

```
实测单请求吞吐        T_peak = 26,186 行/秒
可持续稳态（留 3× 余量） T_safe = T_peak / 3 = 8,729 行/秒
当前设计负载          L      = 7 行/秒
重评倍数              N      = T_safe / L = 1,247 ≈ 1,200 倍
```

换算成可感知的规模，让 N 有意义：

| 扩张方式 | N = 1,200 倍意味着 |
|---|---|
| 设备数不变、提高采样率 | 采样间隔从 2 秒降到 **1.6 毫秒**——物理上不可能，说明真正的扩张只能靠加设备 |
| 采样率不变、加设备 | 设备数从 14 台增加到 **约 16,800 台** |

**结论应写成**："当全厂设备规模达到 **1.5 万台**量级（或等价的设备数 × 采样率乘积）时，需要重新评估消息队列；在此之前，瓶颈不在写入路径。"

> 这里的 3 倍余量是保守取值，不是测出来的。若有人质疑，正确的回应是"改成 1 倍会得到 N≈3,700，结论不变"——**倍数怎么取都不影响"现在不该接"这个结论**，这才是决策稳健的证据。

### 附注 2 · 关于 7.4：一个诚实性要求

Kafka 的单分区容量**本项目无法实测**（不装就没有数）。因此 7.4 必须写成两句不同性质的话：

- "Kafka 单分区在常见硬件上的公开量级约为 X MB/s"——**标注为公开资料，不是本项目实测**；
- "按本项目每行约 230 字节折算，X MB/s 相当于约 Y 行/秒"——**这是换算，不是测量**。

不许把第二句写成"实测"或"我们测过"。**测不了就说测不了，这本身就是"不接"的理由之一**：为了写一份决策记录而先装一套 Kafka，等于用成本证明成本。

---

## 8. 明确不做（第 4 阶段范围外）

前 12 条沿用 v1.0（编号不变），后 4 条是本次新增的**禁令**——写进来是为了防止几周后被当成"顺手补一下"重新提上来。

| # | 不做 | 说明 |
|---|---|---|
| 1 | 深度学习（LSTM / Transformer / AutoEncoder） | 技术栈锁定 scikit-learn + XGBoost（AGENTS.md 第 2 节） |
| 2 | GPU 训练与推理 | 无需求，本机也没有可用 GPU |
| 3 | 模型在线服务化（独立 ml 服务 / gRPC / 模型网关） | 进程内加载已够用（G-01） |
| 4 | 定时重训、模型漂移监控、A/B 实验 | 数据每周增长不超过训练集一半（L-01） |
| 5 | MLflow 等实验跟踪平台 | 用 JSON 报告 + git commit 代替（L-06） |
| 6 | 特征存储（feature store） | 训练与推理复用同一函数即可（L-02） |
| 7 | 真实数据集训练 | NASA C-MAPSS 可作论文加分对照，不进验收（L-09） |
| 8 | 真实 IoT 接入、MQTT | 无硬件 |
| 9 | 用户鉴权、多租户 | 单机演示 |
| 10 | 三维资产细化 | `factory_models/` 仍空占位，属第 6 阶段，作者已确认 |
| 11 | `/assistant` 页面 | 方案标注"进阶"，导航继续灰显 |
| 12 | 移动端适配、浅色主题、国际化 | 第 3 阶段 L-01/02/03 维持不做 |
| **13** | **Kafka 接入的任何形式** | 包括：`docker-compose.yml` 里的 kafka 服务、`data_pipeline/kafka_sink.py`、`consumers/`、`--sink` 参数、分区与副本配置、"预留生产者接口"。**唯一的产物是 `docs/decision_kafka.md`** |
| **14** | **D 块的监督学习模型** | 不许出现"故障预测准确率 / AUC / F1"这类指标。3 条维护记录不足以上报任何准确率，报出来就是造假 |
| **15** | **E 块的精度承诺** | 不许写"预测精度达到 X%"。只能写"与基线对比的结果"，且不显著时如实写不显著 |
| **16** | **压缩的后台 job**（`add_compression_policy`） | 压缩策略自动化后，若把正在回填的块压掉，排查成本远高于每天手工跑一次（§6.4） |

---

## 9. 待作者确认

> **2026-11-25 作者已确认：三条全部按建议执行**（a / a / a）。本节保留问题与理由，供追溯。
> 已生效的取值：压缩边界 **7 天**；D 块呈现位置 **AI 页新增「设备健康」区块**；E 块结论不显著时 **保留完整对比表与代码**。

只剩三条真正需要人拍板的。其余都已按实测与既有决策定稿，不再回问。

| # | 待确认 | 选项 | 我的建议 | 不确认的后果 |
|---|---|---|---|---|
| **1** | TimescaleDB 压缩边界取多少 | (a) 7 天（回填深度上限也就是 7 天，刚好够）<br>(b) 15 天（更保守，但只有约 1 个块可压缩，压缩比样本太小）<br>(c) 1 天（压缩收益最大，但回填一跨边界就会失败） | **(a) 7 天** | 定不下来 4.3 的迁移脚本就写不出最终版；实验可先用 1 天，但生产值必须定 |
| **2** | D 块的呈现位置 | (a) AI 页新增一个"设备健康"区块<br>(b) 设备监控页每台设备加一条指示条<br>(c) 只做接口不做页面 | **(a)**：与模型输出同页，且降级态可以复用同一套文案机制 | 影响 4.6 的页面工作量（约 ±2 小时），也影响验收脚本要断言哪些文案 |
| **3** | E 块结论若为"不显著"，模块怎么处理 | (a) 保留完整对比表与代码，作为"我们验证过"的证据<br>(b) 只保留报告，删掉代码<br>(c) 不加模块，把结论写进文档 | **(a)**：一个被证伪的假设比一句"没做"有价值得多，也是论文局限性章节的素材 | 决定 4.7 是否要建 `ml/production_forecast/` 目录 |

> 这三条不阻塞 4.3——4.3 只跟第 1 条有关，且实验阶段可先按 1 天做。**第 2、3 条最晚在 4.6 / 4.7 动工前给出即可。**

---

## 附录 A 复核命令清单

§3 里每个数字对应的取数命令。**改规格或写论文前，先跑一遍这一节**，确认基线没漂。

```sql
-- A1 各表规模与时间跨度（一条 SQL 出全部，保证同一时刻快照）
SELECT 'telemetry' AS t, count(*)::text AS n, min(ts)::text AS lo, max(ts)::text AS hi FROM device_telemetry
UNION ALL SELECT 'injection', count(*)::text, min(started_at)::text, max(started_at)::text FROM anomaly_injection
UNION ALL SELECT 'alarms',    count(*)::text, min(detected_at)::text, max(detected_at)::text FROM alarms
UNION ALL SELECT 'orders',    count(*)::text, min(planned_start)::text, max(planned_start)::text FROM production_orders
UNION ALL SELECT 'maint',     count(*)::text, min(started_at)::text, max(started_at)::text FROM maintenance_records
UNION ALL SELECT 'models',    count(*)::text, min(trained_at)::text, max(trained_at)::text FROM model_versions
UNION ALL SELECT 'scores',    count(*)::text, min(ts)::text, max(ts)::text FROM anomaly_scores;

-- A2 存储三口径
SELECT pg_size_pretty(pg_total_relation_size('device_telemetry')) AS 总量,
       pg_size_pretty(pg_relation_size('device_telemetry'))       AS 表,
       pg_size_pretty(pg_indexes_size('device_telemetry'))        AS 索引;

-- A3 告警按类型（同时看未解除数）
SELECT alarm_type, count(*) AS n, count(*) FILTER (WHERE resolved_at IS NULL) AS 未解除
FROM alarms GROUP BY 1 ORDER BY 2 DESC;

-- A4 订单按天分布（验证"7 天、每 4 小时一批"这个生成机理）
SELECT date_trunc('day', planned_start)::date AS 日期, count(*) AS 订单数,
       count(DISTINCT date_trunc('hour', planned_start)) AS 有单小时数
FROM production_orders GROUP BY 1 ORDER BY 1;

-- A5 小时 × 产线网格的空缺率（E 块降级的依据，§3.3）
WITH h AS (SELECT date_trunc('hour', planned_start) hh, line_id, count(*) n
           FROM production_orders GROUP BY 1,2),
grid AS (SELECT g.hh, l.line_id
         FROM generate_series(date_trunc('hour',(SELECT min(planned_start) FROM production_orders)),
                              date_trunc('hour',(SELECT max(planned_start) FROM production_orders)),
                              INTERVAL '1 hour') g(hh)
         CROSS JOIN (SELECT DISTINCT line_id FROM production_orders) l)
SELECT count(*) AS 网格数, count(*) FILTER (WHERE h.n IS NULL) AS 空格,
       round(100.0*count(*) FILTER (WHERE h.n IS NULL)/count(*),1) AS 空缺率
FROM grid LEFT JOIN h ON h.hh=grid.hh AND h.line_id=grid.line_id;

-- A6 维护记录全量（D 块降级的依据，就 3 行，直接看）
SELECT record_id, device_id, maintenance_type, started_at, finished_at FROM maintenance_records ORDER BY started_at;
```

```powershell
# A7 写入吞吐（§3.4 的方法，跑完必须清理，否则污染基线）
#     用 python 脚本发 3 次 5000 行请求，时间戳放在 2026-10-01 之后的历史空窗
#     清理：
docker exec sftwin-db psql -U sf -d smartfactory -c "DELETE FROM device_telemetry WHERE ts < '2026-11-01';"
#     核对：应返回 0；min(ts) 应回到 2026-11-17
docker exec sftwin-db psql -U sf -d smartfactory -c "SELECT count(*) FROM device_telemetry WHERE ts < '2026-11-01';"

# A8 基线漂移自检：行数落在 ±1% 内视为正常，量级变了要更新 §3.1
```

---

## 附录 B 偏差表

D-11 ~ D-25 是 v1.0 / v1.1 施工期产生的，**保留原编号，不重排**（`docs/acceptance_phase4.md` 里大量引用这些编号）。
完整原文见 `docs/archive/spec_phase4_v1.1.md` 第 15 节；这里只留一句话摘要，供查阅时定位。

| 编号 | 一句话 | 批次 | 状态 |
|---|---|---|---|
| D-11 | `requirements-ml.txt` 多了 scipy / threadpoolctl 两个间接依赖 | 4.1 | 已知，无需处理 |
| D-12 | 训练报告的两张 PNG 改为 Markdown + 前端 ECharts（不引 matplotlib） | 4.1 | 生效中 |
| D-13 | 训练集按 10 秒抽稀（特征仍在 2 秒分辨率上算） | 4.1 | 生效中 |
| D-14 | 区间检出率的分母改为「可真判且有行」，四个数全报 | 4.1 | 生效中 |
| D-15 | sklearn + scipy 报 `OptimizeWarning: iprint`，仅告警 | 4.1 | 已知 |
| D-16 | 新增 `--limit-devices` / `--skip-random-control` 两个开关 | 4.1 | 生效中 |
| D-17 | 跨切分区间改为剔除其验证/测试段的行（原为整段并入训练段） | 4.1 | 已修复 |
| D-18 | `anomaly_scores` 改为离线存档，页面走实时推理 | 4.2 | 生效中 |
| D-19 | `model_versions` 由脚本登记，接口不读写，真相源是 artifact | 4.2 | 生效中 |
| D-20 | heatmap 必须配隐藏 visualMap + 逐格语义色 | 4.2 | 生效中 |
| D-21 | 分数曲线去掉 `areaStyle`，纵轴保持线性 | 4.2 | 生效中 |
| D-22 | `/ml/anomaly/scores` 不传时间范围时默认最近 1 小时 | 4.2 | 生效中 |
| D-23 | 修第 2 阶段遗留缺陷：告警扫描游标回退 30 秒 | 4.2 | 已修复 |
| D-24 | `acceptance-batch2` 两条断言更新 + 两处竞态修正 | 4.2 | 已修复 |
| D-25 | `acceptance-batch2` 注入值按设备区间取值、只注入一台 | 4.2 | 已修复 |
| **D-26** | §5.3 的 dump 体积判据由「> 100 MB」改为「> 10 MB」，实测 78 MB | 4.3 | 已修正 |
| **D-27** | 迁移后体积测量改用 `hypertable_detailed_size()`，不再用 `pg_*` | 4.3 | 已修正 |
| **D-28** | 压缩会把**索引一起压小**（486 → 72 MB），原「索引不参与压缩、几乎不变」判断错误 | 4.4 | 已修正 |
| **D-29** | 压缩态出现 **94 MB toast 占用**，体积口径由三个扩为**四个**（表/索引/toast/总量） | 4.4 | 已修正 |
| **D-30** | 压缩块**可写入**（TS 2.17 支持 DML，实测插入成功），原「压缩块不可写」判断错误；限制是性能而非报错 | 4.4 | 已修正 |
| **D-31** | 耗时对比新增 **Q5 冷数据查询**；Q4 波动达 17%，须测两遍；窗口须锚定固定时间戳 | 4.4 | 已修正 |
| **D-32** | `num_chunks` 实测 **9**（按 UTC 日界切分），规格预估 8 | 4.3 | 已修正 |
| **D-33** | 迁移本身（未压缩）已把 1,001 MB 降到 930 MB（-7%，消除膨胀），压缩比的分母须用 930 而非 1,001 | 4.4 | 已记录 |
| **D-34** | **修接口 bug**：`/ml/anomaly/scores` 回显的 `start/end` 被 `iso()` 截到整秒，而 SQL 用原始微秒查询——回显窗口 ≠ 实际查询窗口，用回显值重放会差 1 行（实测 976 vs 977，约 1/3 概率）。修法：查询前把两端归整到整秒；补 1 条回归测试（撤掉修复后该测试确实失败，已验证） | 4.4 | 已修复 |
| **D-35** | 查询耗时测量协议修正：① 查询必须包一层 `count(*)`，只计服务端，否则客户端行格式化会主导计时；② 状态切换后必须先跑一轮丢弃（缓存/IO 尾流）；③ Q1~Q3 不触及压缩块，必须新增 Q5。**第一版"压缩后全表扫描变慢"是上述三个问题造成的假象，该结论作废** | 4.4 | 已修正 |
| **D-36** | 前端分数曲线窗口终点后退 5 秒（`SCORE_WINDOW_SETTLE_MS`） | 4.4 | 已实施 |
| **D-37** | 跑 pytest 后 hypertable 多出一个 `2020-03-01` 的**空 chunk**（`num_chunks` 9 → 10） | 4.4 | 已记录 |

**新偏差从 D-26 起编号。** 记法：`| D-26 | 偏差内容 | 原因 | 影响 |`，并同步进对应批次的验收文档。

---

## 附录 C 冻结记录

| 日期 | 项 | 作者决定 |
|---|---|---|
| 2026-11-24 | 第 4 阶段顺序 | 先模型后管道：C → F → B → A → D → E（**已被 2026-11-25 的 A 块降级取代**） |
| 2026-11-24 | TimescaleDB | 迁，并做压缩比实测（不是最小动作，也不是不迁） |
| 2026-11-24 | G-01 ~ G-09 | 按建议值执行（逐项去向见 §1.2） |
| 2026-11-24 | L-10（SHAP 简化版） | 暂不做，留 P1；先出 `feature_importances_` 作为可解释性最低交付 |
| **2026-11-25** | **Kafka** | **不接。** A 块从「接入」改为「可行性测算 + 决策记录」（`docs/decision_kafka.md`），不含任何 Kafka 代码，不改 compose |
| **2026-11-25** | **TimescaleDB** | **接。** 保留 B 块，但必须写成可验收的迁移步骤 + 对比实验（拆为 4.3 / 4.4 两批） |
| **2026-11-25** | **D 块（故障风险）** | **先做数据可行性评估**；删除一切"训练监督分类模型"的写法；改为可行性报告 + 明确标注「演示级、不具备预测能力」的最小实现 |
| **2026-11-25** | **E 块（产量预测）** | **必须有基线对比**；写清可用的最小预测粒度；验收标准是「与最笨的基线相比是否有显著改善」，不显著就如实写不显著 |

---

## 附录 D 自查清单（对照作者 2026-11-25 的硬性要求）

| # | 硬性要求 | 本文件是否满足 | 在哪一节 |
|---|---|---|---|
| 1 | 只改文档，不动代码、不跑迁移、不提交 git | ✅ 仅新增 `docs/archive/` 两个归档与本文件；未执行迁移、未 commit | 全文 |
| 2 | 所有数字来自实测或给出测量方法 | ✅ §3 全部实测；§3.4 给了吞吐测法与清理方式；§7.4 明确区分"公开资料量级"与"本项目实测" | §3、§5、§7.4 |
| 3 | 禁止"性能显著提升"这类无数值说法 | ✅ §5.4 判定第 3 条要求结论必须含四个数字；§5.7 禁止"趋势向好"等替代词 | §5.4、§5.7 |
| 4 | Kafka 不许以任何形式写回计划 | ✅ A 块整节废止；依赖删 `kafka-python`；§8 第 13 条把"预留接口"也明确列为禁止 | §1.1、§1.2、§8 |
| 5 | 不承诺 D 块有预测能力 | ✅ 目标是"可行性评估 + 演示级指示"；§8 第 14 条禁止任何准确率指标；§5.6 强制断言"不具备预测能力"文案 | §4.6、§5.6、§8 |
| 6 | 不承诺 E 块精度 | ✅ 验收标准是"是否显著优于最笨基线"；§8 第 15 条禁止写精度；§5.7 要求结论二选一 | §4.7、§5.7、§8 |
| 7 | G-01 ~ G-09 逐条处理，不整段照抄 | ✅ 九条逐项给出"保留 / 修订 / 废止 + 一句理由"；其中 G-06 修订、其余保留并注明已实现；未出现整段照抄 | §1.2 |
| 8 | 4.1 批已实现部分以实现为准 | ✅ §4.1 / §4.2 标注"已完成"并按实现事实回填（脚本名 `score_window`、pytest 24、PNG 废止） | §1.3、§4.1、§4.2 |
| 9 | 保留 v1.0 原文 | ✅ `docs/archive/spec_phase4_v1.0.md`（636 行，取自 git `4d86124`）；另存 v1.1（648 行） | §0.3 |
| 10 | 目录含 §0 ~ §9 + 人工检查单列 + 附录 | ✅ 0 / 1 / 2 / 3 / 4 / 5（含 5.8）/ 6 / 7 / 8 / 9 + 附录 A~D | 全文 |
| 11 | 批次 4.1 ~ 4.7，每批六项齐全 | ✅ 目标 / 输入 / 交付物 / 硬指标 / 预计工作量 / 风险 | §4 |
| 12 | 验收命令可复制，不写"人工确认"了事 | ✅ §5.1 ~ §5.7 全为可复制命令 + 预期输出 + 判定条件；无法自动化的三项单列 §5.8 并写清"看什么、怎么判" | §5 |
| 13 | §6 六个必备要素 | ✅ 镜像版本 / create_hypertable 与 migrate_data / 唯一索引为何允许 / 压缩策略 / 三口径体积 / 三次中位数 | §6.1 ~ §6.5 |
| 14 | §7 提纲为章节级、不含正文 | ✅ 8 章，只给"要回答什么 + 必须带什么数字"，无正文 | §7 |
| 15 | §9 待确认 ≤ 3 条 | ✅ 恰好 3 条，且都不阻塞 4.3 | §9 |
