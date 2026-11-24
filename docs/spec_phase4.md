# 第 4 阶段实现规格（数据处理流水线 + AI 模型）

```yaml
阶段: 第 4 阶段
版本: v0.1（草案，待作者确认第 3 节缺口清单后冻结为 v1.0）
日期: 2026-11-24
上游依据: docs/方案.md 第 170 行、docs/spec_phase2.md（L-01 / L-02 / L-12）、docs/spec_phase3.md（D-03 预留）
前置阶段: 第 3 阶段 v1.1 已交付并验收
```

## 0. 本文件怎么用

1. 本文件是第 4 阶段的**唯一施工依据**。规格未定之处不许自行发挥，回来问。
2. 第 3 节「缺口清单」里 G 组的每一项都标了**建议值**；作者确认后把表格状态改成「已定」并把 v0.1 改 v1.0 冻结，之后才能动代码。
3. 第 2.1 节定了**交付顺序**（先模型后管道），第 12 节按这个顺序分批，每批单独验收。
4. 第 1 节是实测基线，规格里的所有数字都必须能从这一节或它的重跑命令复现。

## 1. 现状基线（2026-11-24 实测，作为本阶段全部决策的依据）

### 1.1 数据规模

| 项 | 实测值 | 取数命令 |
|---|---|---|
| 遥测行数 | **814,813** | `SELECT count(*) FROM device_telemetry;` |
| 表占用 | **180 MB**（含索引） | `SELECT pg_size_pretty(pg_total_relation_size('device_telemetry'));` |
| 时间跨度 | **32 小时**（11-23 04:54 ~ 11-24 13:20 UTC） | `SELECT min(ts), max(ts) FROM device_telemetry;` |
| 设备数 | 14 | `SELECT count(DISTINCT device_id) FROM device_telemetry;` |
| 注入真值 | 219 条区间 | `SELECT count(*) FROM anomaly_injection;` |
| 告警 | 53 条（TEMP 27 / VIB 15 / CURRENT 11） | `SELECT alarm_type, count(*) FROM alarms GROUP BY 1;` |
| 订单 | 52 条 | `SELECT count(*) FROM production_orders;` |

### 1.2 标签分布（决定建模方案的硬约束）

```sql
SELECT a.anomaly_type, count(DISTINCT a.id) AS 区间数, count(t.ts) AS 落入行数,
       round(avg(EXTRACT(EPOCH FROM (COALESCE(a.ended_at, now()) - a.started_at)))) AS 平均时长秒
FROM anomaly_injection a
LEFT JOIN device_telemetry t
  ON t.device_id = a.device_id AND t.ts >= a.started_at AND t.ts < COALESCE(a.ended_at, now())
GROUP BY a.anomaly_type ORDER BY 3 DESC;
```

| 类型 | 区间数 | 覆盖遥测行 | 平均时长 | 行占比 |
|---|---|---|---|---|
| TEMP_DRIFT | 81 | 16,744 | 419 s | 2.06 % |
| CURRENT_ABNORMAL | 58 | 2,509 | 89 s | 0.31 % |
| VIB_SPIKE | 80 | 1,600 | 40 s | 0.20 % |
| **合计（含重叠）** | **219** | **20,853** | — | **2.56 %** |

由此得出三条不可回避的结论，规格必须围绕它们设计：

- **结论 1：极端不均衡。** 正例 2.56%，最多类与最少类差 **10.5 倍**。用 accuracy 或 ROC-AUC 评价都会给出漂亮的假象，主指标必须是 **PR-AUC** 与**宏平均 F1**。
- **结论 2：样本必须按注入区间分组切分。** 同一段注入的相邻行高度相关，随机切分会把同一段波动同时放进训练与测试，模型只要"记住这段形状"就能刷到 95%+ 准确率。**本规格强制时间切分，并把随机切分作为反面对照实验记录差值。**
- **结论 3：注入密度是演示设定，不是真实先验。** 32 小时 219 个区间 ≈ **每 8.8 分钟一次异常**，真实机加工产线远低于此。这一点必须写进前端文案（第 6.3 节），否则模型指标会被误读为"工厂真实异常率"。

### 1.3 数据量不足的前置条件

32 小时做时间切分后，测试段只剩 4～5 小时（约 1.1 万行 / 每设备 80 行），单设备指标抖动会很大。**本阶段动工前必须先回填到 7 天**：

```powershell
python -m data_pipeline.simulator --backfill-days 7 --duration 0
```

预期约 **4.23M 行**（7 × 43,200 时刻 × 14 台），约 **0.9 GB**（按当前 180 MB / 81.5 万行折合 221 字节每行推算）。
现有 81.5 万行（32 小时）会被这 7 天覆盖并去重，所以总量是 423 万而不是 505 万——`ON CONFLICT DO NOTHING` 的 `duplicated` 计数会非零，这是正常的，不是重复写入。
这个量级也正好让第 7 节的 TimescaleDB 压缩比实测有意义。回填耗时按第 2 阶段实测（604,590 行 22~28 秒）线性外推约 **2.5~3 分钟**。

> 回填必须**连注入记录一起回填**（第 2 阶段 `--backfill-days` 已实现），否则训练集里没有标签。

### 1.4 推理侧现状

第 3 阶段 `/ai` 页只展示真值（D-03），灰色虚线框写着「异常检测模型输出 —— 预留，本阶段不实现」。这是本阶段 F 块的落点，**不需要新建页面，只替换该区域**。

## 2. 目标与范围

### 2.1 六块与交付顺序

方案原文（`docs/方案.md` 第 170 行）：「建立数据处理流水线、引入 Kafka、异常检测、训练故障风险模型、训练生产预测模型」，交付物「具备数据分析与预测能力的系统」。

作者 2026-11-24 已确认顺序为**先模型后管道**：

| 序 | 块 | 内容 | 为什么在这个位置 |
|---|---|---|---|
| 1 | **C** | 异常检测模型（三类注入，替代阈值规则） | 最能体现"分析能力"，且标签已就绪 |
| 2 | **F** | 前端 `/ai` 页落地模型输出 | 模型必须有可视落点，否则等于没做 |
| 3 | **B** | TimescaleDB hypertable + 压缩比实测 | 数据量被回填推到 500 万行，此时迁移才有实测意义 |
| 4 | **A** | Kafka 替换 HTTP 直写接入 | 工程叙事，不影响功能；放在数据量上来之后 |
| 5 | **D** | 故障风险 | 标签（53 条告警）严重不足，先做规则聚合版 |
| 6 | **E** | 产量预测 | 数据量最小（52 单），最后做，允许降级为基线对比 |

**为什么不是按方案原顺序**：按方案先做 Kafka，前 3 周看不到任何 AI 效果，且 7 条/秒的数据量下 Kafka 纯属负担（`spec_phase2.md` L-02 原文）。先做模型能把"AI 分析"这个毕设核心卖点尽早变成可截图的东西，工程管道后补不影响最终形态。

### 2.2 阶段完成判据

六块全做完才算阶段完成，且每块必须满足：

1. 有一条可复制执行的命令能产出该块的核心数字；
2. 数字写进 `docs/acceptance_phase4.md`（三列：结论 / 命令 / 实际输出）；
3. 前端或接口能消费该块的产物（B 块除外，它是存储层）。

## 3. 缺口清单

### 3.1 G 组：必须现在定

| 编号 | 缺口 | 建议值 | 待定后果 |
|---|---|---|---|
| **G-01** | 模型推理放在哪 | **后端进程内 lazy load**（`app/services/ml_anomaly.py`），启动时校验特征 schema 哈希，不匹配或加载失败则**自动降级回阈值规则**并打警告日志 | 独立 ml 服务要多一个进程 + 一套 HTTP 契约 + 一套健康检查，对毕设是纯成本；但进程内加载会把 sklearn/xgboost 加进后端依赖，需接受后端启动变慢约 1 秒 |
| **G-02** | 异常检测的任务形式 | **两个任务**：① 主任务二分类（正常 / 异常）；② 辅任务三分类（在判为异常的样本上归因到 TEMP_DRIFT / VIB_SPIKE / CURRENT_ABNORMAL） | 直接四分类会让"异常/正常"这个业务主诉求的指标被类型混淆摊薄；只做二分类则无法回答"为什么判它异常" |
| **G-03** | 训练/测试切分方式 | **按时间切分**（前 70% 训练 / 中 15% 验证 / 后 15% 测试），并额外跑一次随机切分作为**反面对照**，把两者差值写进报告 | 随机切分泄漏严重，指标虚高，答辩被问"你怎么保证不是背答案"时无话可说 |
| **G-04** | 是否改 WebSocket 契约 | **不改**。模型分数只走新增 REST 接口，WS snapshot 保持 14 字段不变 | 改 WS 要同步改前端 `types.ts`、store、以及第 3 阶段 24 项页级验收，风险远大于收益 |
| **G-05** | TimescaleDB 镜像 | **必须换成 `timescale/timescaledb:2.17.2-pg16`**（锁版本）。`postgres:16` 官方镜像**不含**该扩展，`CREATE EXTENSION timescaledb` 会报 `could not open extension control file` | 不换镜像时第 7 节整块做不了；换镜像要重建数据卷或做 dump/restore，见 7.5 |
| **G-06** | 新增 Python 依赖 | `scikit-learn==1.5.2`、`xgboost==2.1.3`、`joblib==1.4.2`、`pyarrow==18.1.0`、`kafka-python==2.0.2`（A 块用）。全部写死版本，放 `requirements-ml.txt`，**不进 `requirements.txt`** | 混进主依赖会让第 2 阶段验收环境被动变化；ml 依赖体积大（xgboost 约 200 MB），答辩机器装不上就整块废 |
| **G-07** | 是否新增数据表 | **加两张**：`model_versions`（模型版本、训练时间、指标 JSON、特征 schema 哈希）、`anomaly_scores`（device_id / ts / score / is_anomaly / label_type，供前端画曲线） | 不加表则模型没法版本化，前端画曲线要实时算，性能与可复现性都差 |
| **G-08** | 特征是否做设备归一化 | **做**。所有幅值类特征转成「相对该设备正常区间的偏离度」`(x - lo) / (hi - lo)`，基线统计量**只从训练期计算并存进 artifact** | 14 台设备 4 种型号，正常区间差一个数量级（温度 55~70 vs 35~52）。不归一化时模型学到的是"这是哪台设备"而不是"它是否异常" |
| **G-09** | 类别不均衡的处理 | **只用 `scale_pos_weight` / class_weight**，**不做 SMOTE 等过采样** | 时序过采样会造出不存在的相邻时刻，破坏滑窗特征的时间结构，验证集会因此失真 |

### 3.2 L 组：可以以后再定

| 编号 | 缺口 | 本阶段默认 | 触发条件 |
|---|---|---|---|
| L-01 | 模型定时重训 | 不做，训练由人手工 `python -m ml.anomaly_detection.train` 触发 | 数据每周增长超过训练集一半时 |
| L-02 | Feature store | 不做，特征在训练脚本里现算，推理时同一函数复用 | 出现第二类模型需要复用同一批特征时 |
| L-03 | 模型漂移监控 | 不做，只在 `model_versions` 里存训练期指标 | 上线运行超过 1 个月 |
| L-04 | A/B 实验框架 | 不做 | 无 |
| L-05 | 在线学习 / 增量训练 | 不做 | 无 |
| L-06 | MLflow 实验跟踪 | 不做，用 JSON 报告 + git commit 代替 | 超参数搜索轮次超过 50 次时 |
| L-07 | 深度学习（LSTM / Transformer） | 不做，技术栈锁定 scikit-learn + XGBoost（AGENTS.md 第 2 节） | 无 |
| L-08 | GPU 训练 | 不做 | 无 |
| L-09 | 真实数据集对照（NASA C-MAPSS） | 可选加分项，不进验收 | 论文需要"公开数据集验证"时 |
| L-10 | SHAP 逐样本解释 | **建议做简化版**（TreeExplainer，只输出 top-5 特征贡献），作为 P1 | 答辩被问"模型可解释性"时 |

## 4. 工程与目录

### 4.1 新增依赖（`requirements-ml.txt`，版本写死）

```
scikit-learn==1.5.2
xgboost==2.1.3
joblib==1.4.2
pyarrow==18.1.0
kafka-python==2.0.2
```

已装：`pandas==2.2.3`、`numpy==2.5.5`（在 `requirements.txt` 里）。

> **兼容性注意**：本机 numpy 是 2.5.5，scikit-learn 1.5.2 依赖的 C 扩展需支持 numpy 2.x。若安装后 `import sklearn` 报 `_ARRAY_API not found`，改为 `scikit-learn==1.6.1`（首个完整支持 numpy 2 的版本）。这一条在 4.2 节「依赖自检」里固化成一条命令。

### 4.2 目录结构

```
ml/
  common/
    db.py                只读数据库连接（复用 .env，不做 ORM）
    features.py          特征工程（训练与推理共用，唯一实现）
    split.py             时间切分 / 分组切分 / 随机切分（对照组）
    metrics.py           PR-AUC、宏 F1、区间级检出率、每小时误报次数
  anomaly_detection/
    build_dataset.py     从库导出特征矩阵 + 标签，落 parquet（可重复执行）
    train.py             训练三个基线 + 主模型，写 artifacts/ 与报告
    evaluate.py          在测试段出报告与图（混淆矩阵、PR 曲线）
    score.py             批量打分写入 anomaly_scores（供前端）
  fault_risk/
    build_labels.py      从 alarms 造"未来 N 分钟是否告警"标签
    train.py             规则聚合版（见第 9 节）
  production_forecast/
    build_dataset.py     按小时聚合产量
    train.py             XGBoost 回归 + 三个基线
  evaluation/
    reports/             每次训练的 JSON + PNG 报告（进 git）
artifacts/               模型文件（.joblib），不进 git
app/services/
  ml_anomaly.py          进程内加载 + 降级（G-01）
app/routers/
  ml.py                  新增 /ml/* 接口
database/
  migrate_timescale.sql  第 7 节迁移脚本
  phase4_tables.sql      新增两张表（G-07），只建不删
```

### 4.3 依赖自检（每次动工前先跑）

```powershell
.\.venv\Scripts\Activate.ps1
pip install -r requirements-ml.txt
python -c "import sklearn, xgboost, joblib, pyarrow; print('sklearn', sklearn.__version__); print('xgboost', xgboost.__version__)"
```

预期打印两个版本号且无 warning。**报错就停下**，按 4.1 的兼容性注意调整版本，不要绕过。

## 5. C 块：异常检测

### 5.1 任务定义

- **主任务**：给定设备 `d` 在时刻 `t` 的特征向量，判定 `t` 是否落在该设备的任一注入区间内（二分类）。
- **辅任务**：在真实异常样本上，判定属于哪一类（三分类）。
- **明确不是提前预警**：本任务是"当前状态判定"。提前 N 分钟预警是 D 块的事，两者不可混谈。

### 5.2 标签构造

标签来源**只能是** `anomaly_injection`（第 2 阶段写入的 ground truth），不得用 `alarms` 表——那只是阈值规则的输出，用它当标签等于让模型学阈值规则，无法证明优于基线。

```sql
-- 行级标签：ts 落在该设备任一注入区间内即为正例
SELECT t.device_id, t.ts,
       COALESCE(a.anomaly_type, 'NORMAL') AS label
FROM device_telemetry t
LEFT JOIN anomaly_injection a
       ON a.device_id = t.device_id
      AND t.ts >= a.started_at
      AND t.ts <  COALESCE(a.ended_at, t.ts + INTERVAL '1 second')
```

**边界约定**：`started_at` 闭区间、`ended_at` 开区间；`ended_at IS NULL` 表示"仍在进行"，按查询时刻封口。三条规则必须与第 2 阶段 `spec_phase2.md` 的注入语义完全一致，否则标签会多算/少算。

### 5.3 特征工程（`ml/common/features.py`，训练与推理共用同一函数）

采样间隔 2 秒，按设备分组。三档滑窗：

| 窗口 | 点数 | 用途 |
|---|---|---|
| 15 s | 8 | 抓突变（VIB_SPIKE 平均只持续 40 s，长窗会把它抹平） |
| 60 s | 30 | 抓趋势（TEMP_DRIFT 是缓慢漂移） |
| 300 s | 150 | 抓基线偏移 |

每档窗口对 4 个指标（temperature / vibration / current / speed）算 5 个统计量：`mean`、`std`、`min`、`max`、`slope`（最小二乘斜率）。共 `3 × 4 × 5 = 60` 维。

再加：

| 特征组 | 维度 | 说明 |
|---|---|---|
| 一阶差分 | 4 | `x(t) - x(t-1)`，抓瞬时跳变 |
| 归一化偏离度（G-08） | 4 | `(x - lo) / (hi - lo)`，`lo/hi` 取自 `config/devices.json` 的 `normal_range` |
| 稳健 z-score | 4 | `(x - median_train) / (1.4826 × MAD_train)`，比标准差抗异常点 |
| 超阈值指示 | 3 | 是否越过 warning / critical（连续量，不是布尔的硬开关） |
| running_status 独热 | 3 | RUNNING / IDLE / STOPPED |

合计约 **78 维**。

**两条防泄漏硬约束**：

1. `median_train` / `MAD_train` **只能用训练段的数据计算**，算完存进 artifact，推理时读 artifact。用全量数据算会让测试段信息渗进特征。
2. 滑窗 `rolling(window, min_periods=1)` **不 shift**：时刻 `t` 的窗口包含 `t` 本身。这是允许的——推理时 `t` 的读数已经拿到。但**绝不能出现 `shift(-k)`**，那才是用未来数据。

### 5.4 数据切分（G-03，本节是硬约束不是建议）

```
全量时间轴:  |———— 训练 70% ————|—— 验证 15% ——|—— 测试 15% ——|
```

- 切分点按**时间**取，不按行数取，确保三段的物理时间不重叠。
- 任何跨越切分点的注入区间：**整段归入训练段**，在测试段里把它之前的部分裁掉。宁可少几个测试正例，也不能让同一段注入横跨两段。
- 三段的正例率必须分别打印并检查，若测试段正例率偏离训练段超过 2 倍，说明切分点选得不好，需重选。

**反面对照（必须做）**：同样数据用 `train_test_split(random_state=42)` 随机切分跑一遍，把两组指标并排写进报告。预期随机切分 PR-AUC 会明显高于时间切分，差值就是泄漏的量化幅度。这个对照是答辩时"你怎么证明指标不是刷出来的"的直接答案。

### 5.5 类别不均衡（G-09）

- XGBoost：`scale_pos_weight = 负例数 / 正例数`（当前约 38:1，回填 7 天后重新计算）。
- 逻辑回归 / 树基线：`class_weight='balanced'`。
- **不做** SMOTE / 随机过采样 / 随机欠采样。理由见 G-09。
- 阈值不取 0.5：在验证段扫描阈值，选一个满足「每设备每小时误报 ≤ 1 次」的最大召回点，把该阈值存进 artifact。业务上"每小时误报 1 次"是运维能接受的量级，这个约束要写进文档。

### 5.6 模型与基线

必须训练并对比四个，缺一不可：

| # | 模型 | 角色 | 说明 |
|---|---|---|---|
| 0 | **现有阈值规则** | 业务基线 | 直接用后端 `alarms` 表的判定结果，不需训练。若模型打不过它，本块无意义 |
| 1 | 逻辑回归 | 可解释基线 | 系数正负能讲清"哪个指标在推动判定" |
| 2 | IsolationForest | 无监督基线 | `contamination=0.0256`（按实际正例率），只用训练段**正常样本**训练，不碰标签 |
| 3 | **XGBoost** | 主模型 | 二分类 `binary:logistic`，早停用验证段 PR-AUC |

辅任务（类型归因）：XGBoost `multi:softprob`，只在正例上训练，3 类。

超参不做大规模搜索（L-06）：固定一组合理值（`max_depth=6`、`learning_rate=0.1`、`n_estimators=400`、`subsample=0.8`、`colsample_bytree=0.8`），`early_stopping_rounds=30`。这样可复现，也够用。

### 5.7 评估指标（`ml/common/metrics.py`）

| 指标 | 为什么用它 |
|---|---|
| **PR-AUC** | 主指标。正例 2.56% 时 ROC-AUC 会给出 0.98 的假象 |
| 宏平均 F1 | 三分类归因任务用，防止大类吃掉小类 |
| 每类 precision / recall / F1 | 报告要按类列，VIB_SPIKE 只有 1,600 行，单看总体会掩盖它很差 |
| **区间级检出率** | 业务真正关心的：219 个注入区间里，有多少个至少被检出 1 行。分子分母都写进报告 |
| **每设备每小时误报次数** | 运维可感知的量。模型分数曲线上"看起来还行"和"每小时弹 30 次"是两回事 |
| 混淆矩阵 | 前端 F 块要画，直接复用 |
| 检测延迟 | 从区间 `started_at` 到首次判为异常的时间差，中位数 |

### 5.8 训练产物

```
artifacts/
  anomaly_xgb_<git短哈希>.joblib         主模型
  anomaly_isoforest_<git短哈希>.joblib   无监督基线
  anomaly_scaler_<git短哈希>.joblib      归一化基线（median/MAD/lo/hi）
  anomaly_meta.json                      阈值、特征列表、schema 哈希、训练时间
ml/evaluation/reports/
  YYYYMMDD_anomaly.json                  全部指标（机器可读，供 F 块接口返回）
  YYYYMMDD_anomaly_confusion.png
  YYYYMMDD_anomaly_pr_curve.png
```

`artifacts/` 进 `.gitignore`（模型文件太大），**报告 JSON 与 PNG 进 git**（论文与答辩要引用）。

### 5.9 推理接入与降级（G-01）

`app/services/ml_anomaly.py`：

```python
# 伪代码，说明契约
def load() -> Model | None:
    """启动时调用一次。返回 None 表示降级。"""

def score_rows(rows: list[dict]) -> list[float] | None:
    """返回 None 表示本批不评分，调用方保持原阈值规则行为。"""
```

降级条件（任一满足即降级，**不抛异常、不影响后端启动**）：

1. `artifacts/` 下找不到模型文件；
2. `joblib.load` 失败（sklearn 版本不匹配是最常见原因）；
3. 计算出的特征向量维度或顺序与 artifact 里的 schema 哈希不一致；
4. 评分过程中出现任何异常（捕获后记 warning 日志）。

**降级必须是静默且可观测的**：接口 `/api/v1/ml/model-info` 返回 `{"loaded": false, "reason": "..."}`，前端据此显示「模型未加载，当前为阈值规则」而不是假装有模型。

### 5.10 批量打分写入 `anomaly_scores`

```sql
CREATE TABLE IF NOT EXISTS anomaly_scores (
  device_id  VARCHAR(16) NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  ts         TIMESTAMPTZ NOT NULL,
  score      DOUBLE PRECISION NOT NULL,        -- 0~1
  is_anomaly BOOLEAN NOT NULL,
  label_type VARCHAR(24),                       -- 归因结果，NULL 表示判为正常
  model_id   VARCHAR(64) NOT NULL,              -- 对应 model_versions.model_id
  PRIMARY KEY (device_id, ts)
);
```

**只写测试段的分数**（占 15% 时间），不全量回写——目的是给前端画曲线和核对指标，不是给生产用。写之前先 `TRUNCATE`，保证可重复执行。

## 6. F 块：前端落地

### 6.1 新增接口契约

| 接口 | 返回 | 用途 |
|---|---|---|
| `GET /api/v1/ml/model-info` | `{loaded, model_id, trained_at, dataset_rows, metrics:{pr_auc, f1_macro, precision, recall}, degraded_reason}` | AI 页顶部指标卡 |
| `GET /api/v1/ml/anomaly/scores?device_id&start&end` | `{device_id, start, end, points:[{ts, score, is_anomaly, label_type}], max_points}` | AI 页分数曲线 |
| `GET /api/v1/ml/anomaly/confusion` | `{matrix:[[..]], labels:[..], threshold}` | AI 页混淆矩阵 |

三条都遵守 `spec_phase2.md` 的查询保护（时间范围必填、单次最多 5000 点）。

### 6.2 AI 页改造（`frontend/src/pages/AiInsight.tsx`）

把第 456 行的灰色虚线框替换为「模型输出」区，新布局自上而下：

1. **声明条（改写，不是新增）**：从「本阶段不含任何模型推理」改成
   「模型基于模拟器注入真值训练，指标为离线测试集结果；注入密度为演示设定，不代表真实工厂异常率。」
   —— 这段文案把第 1.2 节的结论 3 直接摊在页面上，是合规要求（AGENTS.md 规则 12）。
2. **模型指标卡 ×4**：PR-AUC / 宏 F1 / 检出率 / 每小时误报。每张卡下角标 `测试集 N 行 / 正例 M 行`。
3. **混淆矩阵**：ECharts heatmap，标出选定的阈值。
4. **四模型对比柱**：阈值规则 / 逻辑回归 / IsolationForest / XGBoost 的 PR-AUC 并排，让"为什么用 XGBoost"一眼可见。
5. **异常分数曲线**：选一台设备，折线是 score，背景色块是注入真值区间。这张图是全页最有说服力的——能直接看到"模型抓到的和真值为准的区域是否对得上"。
6. **保留原有真值甘特与真值 vs 告警对比柱**，不删。它们是模型的对照物，删了就没法复核。

**红线**：页面上出现的每一个数字，都必须能追到 `/ml/*` 接口的一次真实返回。不许有写死的指标，不许有"示意"数字。第 3 阶段 10.2-12 已经用脚本断言过这一条，本阶段沿用同一个断言并加强。

### 6.3 降级态

`model-info` 返回 `loaded: false` 时，整个模型区换成一行提示「模型未加载（原因：xxx），当前告警仍由阈值规则产生」，其余真值区块照常显示。**不许白屏，不许显示 0**。

## 7. B 块：TimescaleDB 迁移与压缩比实测

### 7.1 镜像替换（G-05）

`postgres:16` 不含扩展，必须换。`docker-compose.yml` 改：

```yaml
services:
  db:
    image: timescale/timescaledb:2.17.2-pg16   # 锁版本，不用 latest
```

**迁移方式：dump → 换镜像 → restore**，不用数据卷原地升级（镜像变了，数据目录格式可能不兼容）：

```powershell
docker exec sftwin-db pg_dump -U sf -d smartfactory -Fc > backup\pre_timescale.dump
docker compose down
docker volume rm <项目名>_sftwin_pgdata
docker compose up -d
Get-Content database\schema.sql | docker exec -i sftwin-db psql -U sf -d smartfactory
docker exec -i sftwin-db pg_restore -U sf -d smartfactory --data-only < backup\pre_timescale.dump
```

> `pg_restore` 走 stdin 时要用 `docker exec -i ... pg_restore -` 或先把备份 `docker cp` 进容器。实测时确认这一点，别写错。

### 7.2 迁移 SQL（`database/migrate_timescale.sql`）

**关键前置：必须先删主键。** hypertable 要求所有唯一索引都包含分区列 `ts`，而现有 `device_telemetry` 的主键是 `id`（不含 `ts`），直接 `create_hypertable` 会报
`cannot create a unique index without the column "ts" (used in partitioning)`。

已核实：后端 `app/services/telemetry_service.py` 是裸 SQL（`INSERT ... RETURNING id`），没有 ORM 模型依赖主键约束，所以删主键安全；`RETURNING id` 仍然可用（`id` 列与序列保留，只是不再唯一约束）。

```sql
-- 1) 换扩展
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- 2) 去掉不含 ts 的主键（唯一性由 uq_telemetry_device_ts 保证，它含 ts）
ALTER TABLE device_telemetry DROP CONSTRAINT IF EXISTS device_telemetry_pkey;

-- 3) 转 hypertable，按天分块
SELECT create_hypertable('device_telemetry', 'ts',
         chunk_time_interval => INTERVAL '1 day',
         migrate_data => true);

-- 4) 压缩：按设备分组、按时间倒序
ALTER TABLE device_telemetry SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'device_id',
  timescaledb.compress_orderby   = 'ts DESC'
);

-- 5) 7 天前的块自动压缩（本阶段手工调用，不装后台 job）
-- SELECT compress_chunk(c) FROM show_chunks('device_telemetry', older_than => INTERVAL '7 days') c;
```

脚本必须**可重复执行**（全部 `IF EXISTS` / `IF NOT EXISTS`），且第 2 步要先查一次 `pg_constraint` 判断主键是否已删。

### 7.3 压缩比实测方案

在**回填 7 天（约 500 万行）之后**做，这个量级下压缩才有意义。记录四组数字：

| 阶段 | 命令 | 记什么 |
|---|---|---|
| 迁移前（普通表） | `pg_total_relation_size` / `pg_relation_size` / `pg_indexes_size` | 三行 |
| 迁移后未压缩 | 同上 | 三行 |
| 全量压缩后 | 同上 + `SELECT * FROM hypertable_compression_stats('device_telemetry')` | 三行 + 压缩前后 chunk 数 |
| 查询耗时 | 见 7.4 | 四个查询 × 3 次中位数 |

结论写成一句人话：「500 万行遥测在普通表占 X MB，转 hypertable 并压缩后占 Y MB，压缩比 Z:1，同一查询从 A ms 降到 B ms」。这句话进 README 与论文。

### 7.4 查询耗时对比（四个代表性查询）

```sql
-- Q1 单设备最近 1 小时曲线（前端最常用）
SELECT ts, temperature, vibration, current, speed FROM device_telemetry
WHERE device_id='CNC-01' AND ts >= now() - INTERVAL '1 hour' ORDER BY ts;
-- Q2 全厂最近 1 小时平均温度（总览 KPI）
SELECT device_id, avg(temperature) FROM device_telemetry
WHERE ts >= now() - INTERVAL '1 hour' GROUP BY device_id;
-- Q3 某设备 24 小时按分钟聚合（生产页）
SELECT time_bucket('1 minute', ts), avg(temperature) FROM device_telemetry
WHERE device_id='CNC-01' AND ts >= now() - INTERVAL '24 hours' GROUP BY 1 ORDER BY 1;
-- Q4 全表按小时计数（回填校验用）
SELECT time_bucket('1 hour', ts) h, count(*) FROM device_telemetry GROUP BY 1 ORDER BY 1;
```

每个查询用 `EXPLAIN (ANALYZE, BUFFERS)` 跑 3 次取中位数，**迁移前后各一遍**，原始输出贴进验收文档。

### 7.5 回滚

保留 `backup/pre_timescale.dump`。回滚 = 换回 `postgres:16` 镜像 + 重建卷 + restore。**迁移前必须确认 dump 文件大小正常**（不是 0 字节），否则回滚路径断了。

## 8. A 块：Kafka

### 8.1 拓扑

```
模拟器 --produce--> [factory.telemetry, 3 分区, key=device_id] --consume--> telemetry_consumer
                                                                              |
                                                                              v
                                                              save_telemetry()（复用，不改）
```

- 镜像 `apache/kafka:3.9.0`，**KRaft 模式**（不装 Zookeeper，少一个容器）。
- 分区数 3，按 `device_id` 哈希：同一设备的数据严格有序（滑窗特征依赖顺序）。
- 副本 1（单机）。

### 8.2 生产者改造

模拟器加参数 `--sink {http,kafka}`，**默认仍是 `http`**。这样第 2 阶段的所有验收命令、`start-all.ps1` 全部零改动，Kafka 是显式开关而不是默认路径。

`data_pipeline/kafka_sink.py` 负责 produce，`data_pipeline/http_client.py` 保持不动。

### 8.3 消费者

`data_pipeline/consumers/telemetry_consumer.py`：

- `enable_auto_commit=False`，处理成功后才 `commit`（至少一次语义）。
- 批量取 `max_poll_records=100` 或攒 500 ms，然后调一次 `save_telemetry()`。
- 重复投递由 `ON CONFLICT (device_id, ts) DO NOTHING` 兜住，天然幂等——这是第 2 阶段设计留下的红利，要在文档里点明。

### 8.4 验收判据

| 判据 | 命令/方法 | 阈值 |
|---|---|---|
| 数据量不丢 | 切 sink 前后各测 60 秒，库内增量行数对比 | 差 ≤ 1 个 tick |
| 端到端延迟 | 生产者带 `produced_at`，消费者落库时间减之 | P95 < 1000 ms |
| 积压可恢复 | 停消费者 2 分钟再启 | 积压清零，无数据丢失 |
| HTTP 路径未被破坏 | 第 2 阶段 7.8 命令原样重跑 | 与改前一致 |

## 9. D 块：故障风险

### 9.1 标签现实（这是本块降级的理由）

「未来 N 分钟内该设备是否会进 ALARM」的标签只能来自 `alarms` 表：**全库只有 53 条**（TEMP 27 / VIB 15 / CURRENT 11），分布在 14 台设备 32 小时上。回填 7 天后约 300~400 条，对逐设备监督学习仍然严重不足（单设备只有 20~30 个正例）。

### 9.2 第一版做法（不做监督学习）

**规则聚合版风险打分**，输入是 C 块的异常分数与阈值规则输出：

```
risk(d, t) = 0.5 × 异常分数(近 5 分钟最大值)
           + 0.3 × 近 1 小时内该设备告警次数归一化
           + 0.2 × 该设备当前是否已处于 WARNING
```

输出 0~1，分三档（低 / 中 / 高）。**必须在页面上写明「规则聚合，不是监督模型」**，与 C 块明确区分。

若回填后单设备正例超过 100 条，再考虑上监督模型 —— 这是 L 组，不阻断。

### 9.3 为什么坚持这个降级

用 53 条标签训出来的"故障预测模型"在测试集上大概率能报出漂亮的数字（因为测试集也就十几条），但那是噪音。答辩被问"你的样本量够吗"，答"不够，所以我退成规则聚合并写清了边界"，比硬上一个假模型强。这条判断要写进论文的局限性章节。

## 10. E 块：产量预测

- 数据：`production_orders` 52 单，按**小时 × 产线**聚合实际产量。
- 目标：预测未来 1~4 小时的产量。
- 基线三个：① 昨日同时段；② 最近 3 小时移动平均；③ 该产线历史均值。
- 主模型：XGBoost 回归（`reg:squarederror`）。
- 指标：**MAPE** + MAE，且必须与三个基线并排。模型打不过移动平均时**如实写进文档**，不美化。
- 特征：小时（0-23）、星期几、产线 one-hot、过去 1/3/6 小时产量、过去 1 小时该产线平均设备利用率、过去 1 小时告警数。

> 52 单的样本量做时间序列预测非常勉强。本块的验收标准是"流程与对比表完整"，不是"预测很准"。这一点提前写清，避免最后为了数字好看去调参过拟合。

## 11. 验收清单

每块一条命令，输出必须能贴进验收文档。

```powershell
# C 块：训练（可重复，固定随机种子）
python -m ml.anomaly_detection.build_dataset      # 预期：导出 N 行 × 78 列 parquet
python -m ml.anomaly_detection.train              # 预期：四个模型指标表 + artifacts/
python -m ml.anomaly_detection.evaluate           # 预期：报告 JSON + 2 张 PNG
python -m ml.anomaly_detection.score              # 预期：anomaly_scores 写入 M 行

# F 块：接口与页面
curl http://127.0.0.1:8000/api/v1/ml/model-info
node scripts\acceptance-ai.mjs                    # 新增，断言页面上每个数字都能追到接口

# B 块：迁移与压缩
docker exec -i sftwin-db psql -U sf -d smartfactory -f /database/migrate_timescale.sql
docker exec sftwin-db psql -U sf -d smartfactory -c "SELECT * FROM hypertable_compression_stats('device_telemetry');"

# A 块：Kafka
docker compose up -d kafka
python -m data_pipeline.simulator --sink kafka --duration 60
python -m data_pipeline.consumers.telemetry_consumer --duration 60

# D 块 / E 块
python -m ml.fault_risk.train
python -m ml.production_forecast.train
```

**全阶段回归**：第 3 阶段的 `acceptance-batch2.mjs`（24 项）与 `acceptance-motion.mjs`（17 项）必须仍全过；后端 `pytest` 8 passed。B 块换镜像后尤其要重跑这一遍——数据库换了，什么都可能变。

## 12. 分批交付

按 2.1 的顺序，每批单独验收，一批不合格不进下一批。

| 批 | 内容 | 交付物 | 预估 |
|---|---|---|---|
| **4.1** | 回填 7 天 + `ml/common/*` + C 块三个基线 + 主模型 + 报告 | 指标表、PR 曲线、混淆矩阵 | 本阶段最大的一块，也是核心 |
| **4.2** | 两张新表 + `ml_anomaly.py` 降级 + `/ml/*` 三个接口 + AI 页改造 + `acceptance-ai.mjs` | 页面截图 + 脚本全过 | 让模型可见 |
| **4.3** | TimescaleDB 换镜像 + 迁移 + 压缩比与四个查询耗时实测 | 迁移前后对比表 | 换镜像要重建库，必须单独一批做 |
| **4.4** | Kafka KRaft + 生产者 `--sink` + 消费者 + 四条判据 | 延迟与积压实测 | 不动现有默认路径 |
| **4.5** | D 块规则聚合 + E 块预测与基线对比 | 两张对比表 | 允许指标不好看，如实记录 |

## 13. 明确不做（第 4 阶段范围外）

1. 深度学习（LSTM / Transformer / AutoEncoder）；
2. GPU 训练与推理；
3. 模型在线服务化（独立 ml 服务、gRPC、模型网关）；
4. 定时重训、模型漂移监控、A/B 实验；
5. MLflow 等实验跟踪平台；
6. 特征存储（feature store）；
7. 真实数据集训练（NASA C-MAPSS 可作为论文加分对照，不进验收）；
8. 真实 IoT 接入、MQTT；
9. 用户鉴权、多租户；
10. 三维资产细化（`factory_models/` 仍空占位，属第 6 阶段，作者已确认）；
11. `/assistant` 页面（方案标注"进阶"，导航继续灰显）；
12. 移动端适配、浅色主题、国际化（第 3 阶段 L-01/02/03 维持不做）。

## 14. 待确认记录

| 日期 | 项 | 作者决定 |
|---|---|---|
| 2026-11-24 | 第 4 阶段顺序 | **先模型后管道**：C → F → B → A → D → E |
| 2026-11-24 | TimescaleDB | **迁，并做压缩比实测**（不是最小动作，也不是不迁） |
| 2026-11-24 | G-01 ~ G-09 | 待确认 |
| 2026-11-24 | 是否做 L-10（SHAP 简化版） | 待确认 |
