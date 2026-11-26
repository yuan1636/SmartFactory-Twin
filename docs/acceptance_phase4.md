# 第 4 阶段验收记录

```yaml
规格: docs/spec_phase4.md v2.0（2026-11-25 重规划版，含偏差 D-11 ~ D-36）
记录: 2026-11-24 ~ 2026-11-25，按批记录，每批三列（结论 / 命令 / 实际输出）
范围: 4.1 批（异常检测：回填 → 数据集 → 四模型 → 报告，第 1~7 节）
      4.2 批（模型接入后端 + /ml/* 接口 + AI 页落地，第 8 节）
      4.3 批（TimescaleDB 迁移）+ 4.4 批（压缩与查询对比实验），第 9 节
```

> 第 9 节的前两批（4.1 / 4.2）是按 v1.0 / v1.1 施工的，规格在 2026-11-25 重规划为 v2.0，
> 但**已完成部分以实现为准**（v2.0 §1.3 已记录这一原则）。本文件不做追溯性改写。

## 0. 本文件怎么用

- 第 1 节是 4.1 批的前置条件与实测；第 2、3、4 节是命令与原始输出。
- 第 5 节是**如实标注的边界**：哪些数字不能怎么用。这部分必须和指标一起引用。
- 第 6 节记录本批发现并修复的问题（含被自检抓到的那一个问题）。
- 第 7 节列本批明确未做的部分。

---

## 1. 前置条件：把历史补到 7 天

规格 §1.3 要求动工前先回填，否则时间切分后测试段只剩 4~5 小时，指标抖动大到无法引用。

```powershell
python -m data_pipeline.simulator --backfill-days 7 --duration 1
```

实际输出（尾部）：

```
  回填进度 840/847 批：已写入 3415104 行，重复 784896 行
回填完成：写入 3415904 行，重复 817696 行，历史订单 168 张，耗时 173.7 秒
==== 模拟器统计 ====
回填行数        : 3415904
写入失败/重试   : 0 / 0
```

回填后核对：

| 项 | 回填前 | 回填后 | 规格 §1.3 预测 |
|---|---|---|---|
| 遥测行数 | 814,813 | **4,234,945** | 4,233,600 |
| 表占用 | 180 MB | **921 MB** | 约 0.9 GB |
| 时间跨度 | 32 小时 | **168.1 小时** | 7 天 |
| 注入区间 | 219 | **967** | — |
| 订单 | 52 | **220** | — |

`写入 3,415,904 + 重复 817,696 = 4,233,600`，正好等于 7 × 43,200 时刻 × 14 台。
重复计数非零是**预期**的：原有 81.5 万行被这 7 天覆盖，`ON CONFLICT DO NOTHING` 跳过。
实测与规格预测差 0.03%，在可接受范围内。

## 2. 依赖安装与自检

```powershell
pip install -r requirements-ml.txt
python -c "import sklearn, xgboost, joblib, pyarrow; print(...)"
```

```
scikit-learn 1.5.2
xgboost 2.1.3
joblib 1.4.2
pyarrow 18.1.0
numpy 2.5.5
scipy 1.18.1
import ok
```

规格 §4.1 的「兼容性注意」**没有触发**：sklearn 1.5.2 有 cp313 wheel，numpy 2.5.5 下正常。
但出现了另一条告警（偏差 D-15）：sklearn 传 `iprint` 给新版 scipy 被拒，
`OptimizeWarning: Unknown solver options: iprint`。仅告警，逻辑回归结果与混淆矩阵自洽（见 4.2）。

## 3. 数据集导出

```powershell
python -m ml.anomaly_detection.build_dataset
```

```
数据源 : postgresql+psycopg://sf@localhost:5433/smartfactory
时间范围: 2026-11-17 13:25:06 ~ 2026-11-24 13:41:52（168.3 小时）
切分点 : 训练 < 2026-11-22 11:12:50.200000 ≤ 验证 < 2026-11-23 12:27:21.100000 ≤ 测试
抽稀步长: 每 5 个 2 秒采样取 1 个（即 10 秒一格）
------------------------------------------------------------------------------------------------
设备              原始行数      保留行数      正例      正例率     区间数     耗时s
------------------------------------------------------------------------------------------------
CNC-01        302910     60582    2272    3.75%      65     2.1
ROB-01        302905     60581     156    0.26%      54     2.4
CONV-01       302906     60582     495    0.82%      76     2.1
CNC-02        302911     60582     264    0.44%      87     2.4
ROB-02        302908     60582     450    0.74%      60     2.2
CONV-02        302909     60582     232    0.38%      71     2.2
CNC-03        302913     60583     495    0.82%      64     2.3
ROB-03        302911     60582    2184    3.61%      74     2.3
INSP-01       302913     60583    2138    3.53%      69     2.2
CNC-04        302914     60583    2352    3.89%      69     2.2
ROB-04        302914     60583     216    0.36%      65     2.3
INSP-02       302916     60583     457    0.76%      65     2.3
AIR-01        302917     60583    2354    3.89%      71     2.2
PUMP-01       302918     60584     244    0.40%      78     2.1
------------------------------------------------------------------------------------------------
总行数 848,112（原始 4,240,766，抽稀后保留 20.0%）
split   rows  positive  positive_rate               start                 end
train 593698     10048        0.01692 2026-11-17 13:25:06 2026-11-22 11:12:46
  val 127208      2043        0.01606 2026-11-22 11:12:56 2026-11-23 12:27:16
 test 127206      2175        0.01710 2026-11-23 12:27:26 2026-11-24 13:42:16
跨切分点的注入区间 3 个，其在验证/测试段的 47 行已剔除（并入训练段会造成训练段与验证段时间重叠，见 split.py 说明）
异常类型分布（占全部行数的比例）：
  TEMP_DRIFT             11,257    1.33%
  CURRENT_ABNORMAL        1,893    0.22%
  VIB_SPIKE               1,116    0.13%
```

结论：

- 三段正例率 1.692% / 1.606% / 1.710%，最大/最小 = **1.07 倍**，远低于规格 §5.4 的 2 倍红线；
- 三段物理时间严格互斥（`11:12:46 < 11:12:56`、`12:27:16 < 12:27:26`），由 4.2 的断言复核；
- 78 维特征（`feature_names()` 实测 78，schema 哈希 `15afd2a011823561`）；
- 每台设备的正例率差 15 倍（CNC-04 3.89% vs ROB-01 0.26%），这是配置里注入强度不同造成的，
  同时说明**不能用单设备的指标代表全厂**。

## 4. 训练与报告

```powershell
python -m ml.anomaly_detection.train      # 约 65 秒
python -m ml.anomaly_detection.evaluate   # 生成 Markdown 摘要 + 22 项自检
```

### 4.1 四模型对比（测试段，127,206 行 / 正例 2,175）

| 模型 | PR-AUC | Precision | Recall | F1 | 区间检出率 | 误报/设备小时 | 阈值 |
|---|---|---|---|---|---|---|---|
| 阈值规则（现有后端逻辑） | 0.9098 | **0.9909** | 0.8028 | 0.8870 | 87.90% | **0.04** | 0.5000 |
| 逻辑回归 | 0.9421 | 0.8484 | 0.9623 | 0.9018 | 97.58% | 1.06 | 0.8214 |
| IsolationForest（无监督） | 0.0670 | 0.1145 | 0.0175 | 0.0303 | 3.23% | 0.83 | 0.9433 |
| **XGBoost（主模型）** | **0.9859** | 0.9063 | **0.9830** | **0.9431** | 97.58% | 0.62 | 0.0079 |

主模型混淆矩阵（测试段）：

```
              预测正常   预测异常
实际正常        124810       221
实际异常            37      2138
```

读法（三句话，是这一批最重要的结论）：

1. **主模型把漏报从 19.7% 压到 1.7%**（recall 0.8028 → 0.9830），代价是误报从每设备每小时
   0.04 次升到 0.62 次。这个交换在运维上划算：漏一条 CRITICAL 比每小时多看半条误报贵得多。
2. **阈值规则的 precision 更高（0.9909 vs 0.9063）**，因为它只在接近 critical 时才报。
   它的问题不是报错，是**报得太晚太少**——这正是引入模型的理由。文档里不能只写"模型更好"。
3. **IsolationForest 完败（PR-AUC 0.0670）**，比阈值规则差一个数量级。原因见 5.2，不是实现 bug。

### 4.2 报告一致性自检（22 项，`evaluate.py` 输出原文）

```
PASS  threshold_rule 混淆矩阵行数等于测试集行数  · 127206 vs 127206
PASS  threshold_rule precision 与混淆矩阵一致  · 0.9909 vs 重算 0.9909
PASS  threshold_rule recall 与混淆矩阵一致  · 0.8028 vs 重算 0.8028
PASS  threshold_rule 正例数与测试集一致  · 2175 vs 2175
PASS  logistic_regression 混淆矩阵行数等于测试集行数  · 127206 vs 127206
PASS  logistic_regression precision 与混淆矩阵一致  · 0.8484 vs 重算 0.8484
PASS  logistic_regression recall 与混淆矩阵一致  · 0.9623 vs 重算 0.9623
PASS  logistic_regression 正例数与测试集一致  · 2175 vs 2175
PASS  isolation_forest 混淆矩阵行数等于测试集行数  · 127206 vs 127206
PASS  isolation_forest precision 与混淆矩阵一致  · 0.1145 vs 重算 0.1145
PASS  isolation_forest recall 与混淆矩阵一致  · 0.0175 vs 重算 0.0175
PASS  isolation_forest 正例数与测试集一致  · 2175 vs 2175
PASS  xgboost 混淆矩阵行数等于测试集行数  · 127206 vs 127206
PASS  xgboost precision 与混淆矩阵一致  · 0.9063 vs 重算 0.9063
PASS  xgboost recall 与混淆矩阵一致  · 0.9830 vs 重算 0.9830
PASS  xgboost 正例数与测试集一致  · 2175 vs 2175
PASS  训练段与验证段时间不重叠  · 2026-11-22 11:12:46 ≤ 2026-11-22 11:12:56
PASS  验证段与测试段时间不重叠  · 2026-11-23 12:27:16 ≤ 2026-11-23 12:27:26
PASS  三段正例率漂移不超过 2 倍  · 最大/最小 = 1.07（训练 1.6920% / 验证 1.6060% / 测试 1.7100%）
PASS  三分类归因样本数等于测试段正例数  · 2175 vs 2175
PASS  主模型阈值在 (0,1) 区间  · 0.007897
PASS  主模型 PR-AUC 高于阈值规则基线  · 0.9859 > 0.9098

合计 22 项，通过 22，失败 0
自检全部通过，报告中的数字可以引用。
```

为什么值得单独跑一遍自检：指标表要拿去写论文，一旦出现"混淆矩阵加起来不等于样本数"
或"precision 和混淆矩阵对不上"这种自相矛盾，被当场发现比指标低十倍更难看。
前 16 项是纯算术复核（用混淆矩阵重算 P/R，和报告里写的值比），后 6 项查切分与口径。
**这个自检在开发中真的抓到过一个 bug**（时间重叠），见 6.1。

### 4.3 区间级指标（业务口径）

```
区间级：测试窗口内 300 个注入区间，其中 174 个被同设备后续区间完全覆盖（行级单标签下无法单独判定）
  可真判且有行 124 个，检出 121 个（97.58%），中位延迟 4.0 秒
  CURRENT_ABNORMAL      34/37    91.89%
  TEMP_DRIFT            42/42   100.00%
  VIB_SPIKE             45/45   100.00%
```

| 项 | 数 |
|---|---|
| 测试窗口内区间总数 | 300 |
| 其中被同设备后续区间完全覆盖（无法单独判定） | 174 |
| 可真判且有行（分母） | 124 |
| 检出 | **121（97.58%）** |
| 中位检测延迟 | **4.0 秒** |

分母口径见偏差 D-14。为什么扣掉 174 个而不是直接算 121/300：

```sql
-- 实测：全库 967 个区间里 205 个被同设备的后续区间完全覆盖
WITH t AS (
  SELECT count(*) AS total,
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM anomaly_injection b
           WHERE b.device_id = a.device_id AND b.id <> a.id
             AND b.started_at <= a.started_at
             AND COALESCE(b.ended_at,'infinity') >= COALESCE(a.ended_at,'infinity')
             AND NOT (b.started_at = a.started_at AND b.id > a.id)
         )) AS absorbed
  FROM anomaly_injection a
)
SELECT total AS 区间总数, absorbed AS 被后续区间完全覆盖 FROM t;
```

```
 区间总数 | 被后续区间完全覆盖
----------+--------------------
      967 |                205
```

原因：TEMP_DRIFT 平均持续 419 秒，而注入间隔约 5 分钟，同一设备上的相邻区间大量重叠。
数据集是"一行一个 `interval_id`"，后写的区间会盖掉先写的，被覆盖的区间在数据里
连一个带自己 id 的行都没有——**它是否"被检出"在数据层面不可判定**，只能从分母剔除。
行级召回（98.30%）覆盖了这些区间里的所有行，所以这不是在藏问题。

### 4.4 泄漏对照

| 切分方式 | PR-AUC | 说明 |
|---|---|---|
| 时间切分（最终结果） | **0.9859** | 用过去 4.9 天训练，预测未来 1.05 天 |
| 随机切分（仅对照） | 0.9982 | 同一段注入的相邻行同时进训练与测试 |

差值 **+0.0123**。这个差值比预期小，如实记录：本数据集上异常的波形特征本身就有区分度，
模型不主要依赖记忆；但泄漏方向确实存在，换成更短、更微弱的异常（例如只持续 10~20 秒的
瞬时抖动）时差值会明显变大。**结论不是"泄漏无所谓"，而是"本数据的泄漏幅度已量化，
且时间切分的数字是唯一可引用的"。**

### 4.5 三分类归因

| 类型 | Precision | Recall | F1 | 样本 |
|---|---|---|---|---|
| TEMP_DRIFT | 1.000 | 1.000 | 1.000 | 1,682 |
| CURRENT_ABNORMAL | 1.000 | 1.000 | 1.000 | 313 |
| VIB_SPIKE | 1.000 | 1.000 | 1.000 | 180 |

宏 F1 **1.0000**。**这个满分不能当作模型能力的证据**，理由见 5.1，必须与指标一起引用。

### 4.6 特征重要性前 8（可解释性的最低交付）

| 特征 | 重要性 |
|---|---|
| temperature_dev | 0.3920 |
| temperature_thr | 0.1621 |
| vibration_dev | 0.0772 |
| current_dev | 0.0755 |
| vibration_rz | 0.0716 |
| current_rz | 0.0383 |
| temperature_rz | 0.0195 |
| temperature_w60_std | 0.0173 |

前两名的方向能对上领域直觉：`temperature_dev`（相对本设备正常区间的偏离度）与
`temperature_thr`（越过阈值多少）合计占 55% 重要性，与"温度漂移是最主要的注入类型"一致。
`vibration_rz`（稳健 z-score）排第五，说明振动突增靠"相对自身历史"识别，而不是靠绝对阈值。

### 4.7 产物

| 路径 | 内容 | 是否进 git |
|---|---|---|
| `artifacts/anomaly_xgb_<hash>.joblib` | 主模型 | 否（可重建） |
| `artifacts/anomaly_logistic_<hash>.joblib` | 逻辑回归 | 否 |
| `artifacts/anomaly_isoforest_<hash>.joblib` | 无监督基线 | 否 |
| `artifacts/anomaly_type_xgb_<hash>.joblib` | 三分类归因 | 否 |
| `artifacts/anomaly_meta.json` | 阈值、特征表、schema 哈希、指标、top 特征 | 否 |
| `artifacts/dataset/anomaly.parquet` | 训练集 84.8 万行 | 否 |
| `ml/evaluation/reports/20261124_anomaly.json` | 全部指标（机器可读） | **是** |
| `ml/evaluation/reports/20261124_anomaly.md` | Markdown 摘要 | **是** |

## 5. 如实标注（必须与指标一起引用，不许单独摘数字）

### 5.1 三分类归因的 100% 是数据集事实，不是模型能力

实测：`SELECT device_id, count(DISTINCT anomaly_type) FROM anomaly_injection GROUP BY 1`，
**14 台设备的类型数全部为 1**——每台设备在 `config/devices.json` 里只被分配了一种异常类型。
于是「哪类指标在偏离」与「属于哪类异常」在本数据上是确定性映射，模型学到的是这个映射。

真实工厂里同一台设备会先后出现温度漂移、振动突增、电流异常，届时宏 F1 不会是这个数。
**该 100% 只能作为「归因链路可用」的证据，不能作为泛化能力的证据。**

### 5.2 IsolationForest 弱不是 bug

初看 PR-AUC 0.0670 疑似方向反了，实测核实：异常样本的分数中位数 **0.5163**，
正常样本 **0.4181**，方向正确。弱的原因是**问题性质不匹配**——注入异常表现为相对阈值的
持续偏移（TEMP_DRIFT 平均 419 秒），每一行的绝对取值仍在设备正常区间内，
在 78 维空间里不构成离群点，而无监督方法能找的只有离群点。

这条负结果有价值：它支持「本场景必须用有监督 + 领域特征」，也是把无监督基线放进来的意义。

### 5.3 训练集是 10 秒抽稀的，推理不是

训练用 10 秒一格（84.8 万行），推理侧仍按 2 秒。**特征始终在 2 秒原分辨率上计算**，
只是保留哪些行不同（偏差 D-13）。所以训练集里"每分钟 6 个点"是真的 6 个点，
同一套 `build_features()` 在推理时按 2 秒调用，模型见到的特征分布与推理一致。

如果直接拿 10 秒抽稀后的数据再算滑窗，15 秒窗口只剩 1.5 个点，VIB_SPIKE（平均 40 秒）
会被抹平——这正是"先算特征再抽行"的原因。

### 5.4 数据是模拟的

全部遥测与注入真值来自模拟器（`docs/方案.md` 已声明）。指标只对模拟器的注入模型成立，
不代表真实工厂。注入密度约每 8.8 分钟一次，远高于真实产线，这是演示设定。

## 6. 本批发现并修复的问题

### 6.1 被自检抓到的真 bug：三段切分时间重叠（偏差 D-17）

第一次全量训练后自检报：

```
FAIL  训练段与验证段时间不重叠  · 2026-11-22 11:12:56 ≤ 2026-11-22 11:11:16
自检失败 1 项
```

原因：规格 §5.4 初版写的是"跨切分点的区间整段归入训练段"。并入后，训练段里出现了
**晚于验证段起点**的行，三段不再是时间互斥的，验证集指标因此偏乐观（模型"见过"未来的行）。

处理：改为**剔除**跨段区间在验证/测试段的行（保留训练段部分）。代价是 3 个区间 / 47 行正例。
修正后自检通过（`11:12:46 ≤ 11:12:56`）。规格 §5.4 与偏差表 D-17 已同步。

这个 bug 隐蔽在"看起来合理"的规则里：并入训练段确实避免了同一段注入横跨两段，
但它引入了另一个更隐蔽的问题——时间重叠。**只有把"不重叠"写成断言才抓得到。**

### 6.2 其余五个

| # | 问题 | 定位 | 处理 |
|---|---|---|---|
| 1 | 训练直接 `KeyError: 'label_type'` | 为省内存从 DataFrame 抽列时漏了 `label_type` | 补进 `meta_cols` |
| 2 | 三分类指标全部 0.000，且**不报错** | `multiclass_metrics` 把字符串名 `['TEMP_DRIFT',…]` 当 labels 传给 sklearn，而 y 是 0/1/2 整数编码，sklearn 找不到匹配标签后静默返回全 0 | 签名改为 `labels`（真实取值）+ `display_names`（展示名）；并加"归因样本数等于测试段正例数"的断言，防止再次静默归零 |
| 3 | 区间检出率 40%，与行级召回 98% 自相矛盾 | 分母用了窗口内全部区间，其中大量被同设备后续区间完全覆盖 | 分母改为"可真判且有行"，四段数字全部报出（偏差 D-14） |
| 4 | 全量读入 424 万行展开 78 维特征时内存告急 | 需约 1.3 GB，本机可用仅 1.5 GB（WSL2 docker 常驻 9 GB） | ① 逐设备处理，峰值约 300 MB；② 训练集 10 秒抽稀（D-13）；③ 训练脚本按内存顺序重排：先算完四个模型的分数（数组很小）、释放三个特征矩阵，最后才用全量矩阵跑随机切分对照 |
| 5 | `train.py` 里有一段 `if False else` 的死代码占位 | 初版为省事写的临时分支，会把 `threshold_rule` 的分数算错 | 删除，改为从特征矩阵的 `*_thr` 列直接取（`1 + (x-warning)/(critical-warning)`，`≥1` 等价于越过 warning） |

另：IsolationForest 初看疑似分数反向，实测（异常中位 0.5163 > 正常 0.4181）确认方向正确，
不是 bug，写入 5.2 作为负结果解释。

## 7. 本批明确未做 / 未验证

| 项 | 状态 | 归属 |
|---|---|---|
| 模型接入后端、`/ml/*` 接口、AI 页落地 | **未做** | 4.2 批 |
| 混淆矩阵与 PR 曲线的图形版 | **未做**（本批只有文本矩阵与 Markdown 表） | 4.2 批前端 ECharts（偏差 D-12） |
| 批量打分写入 `anomaly_scores` 表 | **未做**（表与脚本都在 4.2 批） | 4.2 批 |
| SHAP 逐样本解释 | **未做**（L-10，作者已确认留 P1） | 后续 |
| TimescaleDB / Kafka / 故障风险 / 产量预测 | **未做** | 4.3 / 4.4 / 4.5 批 |
| 真实数据集上的泛化能力 | **未验证**，且本批无法验证 | 论文可选加分项（L-09） |

---

# 第 8 节：4.2 批（模型接入后端 + AI 页落地）

## 8.0 本批要证明什么

| # | 结论 | 怎么证明 |
|---|---|---|
| 1 | 模型真的被后端加载并用于推理 | `model-info` 报 `loaded=true` + `schema_match=true`；`scores` 接口实时算出非零分数 |
| 2 | **页面上的每个数字都能追到一次接口返回** | `acceptance-ai.mjs` 逐个比对 DOM 里的数字与接口 JSON，含"同窗重放" |
| 3 | 模型不可用时系统不残缺 | Fetch 域拦截 `/ml/model-info` 返回 `loaded:false`，验证降级提示、无 0、无白屏、其余区块照常 |
| 4 | 没改坏第 2、3 阶段 | `pytest` 24 项 + `acceptance-batch2.mjs` 24 项 + `acceptance-motion.mjs` 17 项全过 |
| 5 | 两张新表有真实数据、有明确用途 | `model_versions` 1 行（生效版本）；`anomaly_scores` 24,851 行（4.2 批 24,659 + 复核时追加 192） |

跑法（前后端与 CDP Chrome 都要在）：

```text
node scripts\acceptance-ai.mjs         # 42 项，需 dev 模式（依赖 data-ml-* 标记）
node scripts\acceptance-batch2.mjs     # 24 项，无回归 + 两条断言已按本批更新
node scripts\acceptance-motion.mjs     # 17 项，三维产线无回归
```

## 8.1 交付物

```text
app/services/ml_anomaly.py            进程内 lazy 加载、schema 校验、失败降级、带预热窗推理
app/routers/ml.py                     三个接口：model-info / anomaly/confusion / anomaly/scores
database/schema.sql                   +2.9 model_versions、+2.10 anomaly_scores（CREATE IF NOT EXISTS，可重跑）
ml/anomaly_detection/register_model.py 把训练产物登记进 model_versions（脚本登记，接口不读表）
ml/anomaly_detection/score_window.py   批量打分写入 anomaly_scores（离线存档，前端不读）
tests/test_ml_api.py                  14 项：接口↔artifact 一致、参数保护、三条降级路径
scripts/acceptance-ai.mjs             42 项页面级断言（含降级态拦截）
frontend/src/charts/options.ts        confusionHeatmapOption / modelCompareOption / scoreCurveOption
frontend/src/pages/AiInsight.tsx      灰色虚线框 → 模型输出区；原有真值区块保留
```

## 8.2 三个接口的实测返回

```text
GET /api/v1/ml/model-info
{"loaded": true, "degraded_reason": null, "model_id": "anomaly-20261124-2143-9ab70b7",
 "trained_at": "2026-11-24T21:43:45", "schema_hash": "15afd2a011823561", "schema_match": true,
 "feature_count": 78, "dataset_rows": 848112, "positive_rate": 0.016821, "threshold": 0.007866,
 "metrics": {"pr_auc": 0.9859, "f1_macro": 0.9431, "precision": 0.9063, "recall": 0.983,
             "roc_auc": 0.9943, "detection_rate": 0.9758, "intervals_detected": 121,
             "intervals_with_rows": 124, "median_delay_seconds": 4.0,
             "false_alarms_per_device_hour": 0.625, "test_rows": 127206, "test_positives": 2175},
 "baselines": [threshold_rule, logistic_regression, isolation_forest, xgboost]}

GET /api/v1/ml/anomaly/confusion
{"matrix": [[124810, 221], [37, 2138]], "labels": ["正常","异常"], "threshold": 0.007866,
 "test_rows": 127206, "test_positives": 2175,
 "note": "离线测试集（按时间切分的最后 15%）结果，不是页面上那台设备的实时表现"}
```

分数接口的性能（`CNC-01`，含 300 秒预热段）：

| 窗口 | 耗时 | 原始点数 | 返回点数 | 降采样 |
|---|---|---|---|---|
| 1 小时 | **229 ms** | 1,800 | 1,800 | ×1 |
| 6 小时 | 1,196 ms | 10,800 | 3,600 | ×3 |
| 24 小时 | 2,021 ms | 43,206 | 4,801 | ×9 |

降采样**按区间取峰值**（`max(score)` + `any(is_anomaly)`），不是每 step 取一条——
后者会把 40 秒的 VIB_SPIKE 整段跳过，曲线上看起来"什么都没发生"，而模型其实抓到了。

## 8.3 AI 页 42 项验收（`output/logs/phase4_ai_acceptance.log` 原文）

> 这份日志是**某一次运行**的原文，与文件逐字一致。其中"分数曲线点数 / 判为异常点数"会随模拟器持续写入而变
> （同一台设备 1 小时窗口，不同时刻跑出来是 1,769 / 1,770 点、217 / 197 / 239 个异常点都正常）。
> 真正的判据不是这些绝对数字，而是"**页面显示的数 = 同一窗口重放接口得到的数**"——这条在任何一次运行里都必须成立。
> 其余数字（模型指标、混淆矩阵四格、阈值、schema 指纹）来自 artifact，每次运行完全一致。

```text
=== 6.2 AI 页：模型输出区 ===
PASS  6.2 模型区处于 loaded 态
PASS  6.2 「预留，本阶段不实现」已消失
PASS  6.2 「本阶段不含任何模型推理」已消失
PASS  6.2 声明条写明注入密度为演示设定
PASS  6.2 声明条写明指标来自离线测试集
PASS  6.2 面包屑已同步（不再是「仅展示真值」）
PASS  6.1 接口报告模型已加载  · model_id=anomaly-20261124-2143-9ab70b7
PASS  6.2 状态条 model_id 与接口一致  · 页面「anomaly-20261124-2143-9ab70b7」/ 接口「anomaly-20261124-2143-9ab70b7」
PASS  6.2 状态条 threshold 与接口一致  · 页面「0.0079」/ 接口「0.0079」
PASS  6.2 状态条 schema_hash 与接口一致  · 页面「15afd2a011823561」/ 接口「15afd2a011823561」
PASS  6.2 指标卡 pr_auc 与接口一致  · 页面「0.9859」/ 接口「0.9859」
PASS  6.2 指标卡 recall 与接口一致  · 页面「98.30%」/ 接口「98.30%」
PASS  6.2 指标卡 detection_rate 与接口一致  · 页面「97.58%」/ 接口「97.58%」
PASS  6.2 指标卡 false_alarms 与接口一致  · 页面「0.63」/ 接口「0.63」
PASS  6.2 指标卡标注了测试集规模  · 127206 / 2175
PASS  6.2 混淆矩阵 TN 与接口一致  · 页面「TN 124,810」
PASS  6.2 混淆矩阵 FP 与接口一致  · 页面「FP 221」
PASS  6.2 混淆矩阵 FN 与接口一致  · 页面「FN 37」
PASS  6.2 混淆矩阵 TP 与接口一致  · 页面「TP 2,138」
PASS  6.1 混淆矩阵四格之和等于测试集行数  · 127206 行
PASS  6.2 四模型对比数据齐（4 个基线）  · threshold_rule,logistic_regression,isolation_forest,xgboost
PASS  6.2 主模型标记唯一且为 XGBoost
PASS  6.2 四模型对比图已渲染
PASS  6.2 分数曲线图已渲染
PASS  6.2 页面暴露了推理时间窗（可重放）  · CNC-01 2026-11-25T01:21:23+00:00 ~ 2026-11-25T02:21:23+00:00
PASS  6.2 分数曲线点数与同窗重放一致  · 页面「1770」/ 接口「1770」
PASS  6.2 分数曲线判为异常点数与同窗重放一致  · 页面「197」/ 接口「197」
PASS  6.2 分数曲线真值区间段数与同窗重放一致  · 页面「1」/ 接口「1」
PASS  6.2 曲线点数未超上限且未丢原始点  · 1770 / 1770
PASS  6.2 模型在该窗口内确实判出了异常  · 197 点，最高分 1
PASS  6.4 异常真值时间轴仍在
PASS  6.4 真值 vs 阈值告警对照仍在
PASS  6.4 异常真值列表仍在

=== 6.3 降级态：模型不可用时页面必须还能用 ===
PASS  6.3 模型不可用时页面切到降级态
PASS  6.3 降级原因对用户可见
PASS  6.3 降级时明说告警仍由阈值规则产生
PASS  6.3 降级时不显示任何模型指标（不许出现 0 或占位数字）
PASS  6.3 降级时其余区块照常（不白屏）
PASS  6.3 降级时页面没有抛异常  · 无
PASS  6.3 解除拦截后自动恢复为 loaded 态  · data-ml-state=loaded
PASS  6.3 恢复后指标卡重新出现
PASS  6.2 全程无页面运行时异常  · 无
截图已保存 output/shot_ai_acceptance.png（视口截图，整页请用 shot.mjs --full）

合计 42 项，通过 42，失败 0
```

**「同窗重放」是怎么做的**：页面把本次推理的 `[start, end]` 写进隐藏的
`[data-ml-window]`，脚本拿同一个窗口再请求一次接口。窗口固定后结果稳定——
否则两次采样之间模拟器又写了两秒数据，数字必然对不上，那是假失败。

**降级态是真的拦截，不是改代码**：用 CDP 的 `Fetch.enable` 截住 `/ml/model-info`，
返回 `{loaded:false, degraded_reason:"验收脚本注入…"}`，验证页面切降级、指标卡消失、
真值区块仍在，然后 `Fetch.disable` 恢复。这比"手动把 artifacts 改名再重启后端"可靠得多。

## 8.4 后端 24 项测试

```text
python -m pytest tests -q
24 passed, 1 warning in 36.79s
```

新增 14 项（`tests/test_ml_api.py`）+ 2 项（扫描游标回退窗），原有 8 项不变。

**重要运行条件**：pytest 会启动自己的 lifespan（含告警扫描），与真实后端同时跑时
两者会抢写同一批告警，`test_alarm_cooldown_*` 会间歇失败（实测 2026-11-25 出现 2 条而非 1 条）。
**跑 pytest 前先停后端**，或用独立数据库。这条已写进 README 的验收说明。

## 8.5 无回归

```text
node scripts/acceptance-batch2.mjs   合计 24 项，通过 24，失败 0   （连跑两次均全过）
node scripts/acceptance-motion.mjs   合计 17 项，通过 17，失败 0
cd frontend && npm run test          9 files / 86 tests passed    （+9：三个新图表的 option 断言）
cd frontend && npm run build         ✓ built in 6.38s，0 error
```

`acceptance-batch2.mjs` 本轮改了 4 处，全部记录在偏差 D-24 / D-25：两条断言因本批取代了
第 3 阶段的现实而更新，两处竞态（维护表按索引取、KPI 数据未到就断言）修正。

## 8.6 两张新表的数据

```text
model_versions：1 行
  anomaly-20261124-2143-9ab70b7 | anomaly_binary | xgboost | 15afd2a011823561 | is_active=t | 848112

anomaly_scores：24,851 行（其中判为异常 588 行）
  4.2 批首次写入 24,659 行（09:08 ~ 10:09，14 台设备各 1 小时）
  复核脚本时又追加 192 行（CNC-01 近 15 分钟窗口，419 行提交里 227 行与已有 (device_id, ts, model_id) 撞主键被跳过）
```

追加那 192 行是**故意留的**：它同时验证了 `score_window.py` 的 `ON CONFLICT DO NOTHING` 真的生效
（打印"提交 419 / 实际新增 192 / 跳过重复 227"，三个数能对上），以及脚本可重复执行不会撑大表。
本次新增的 192 行**全是正常点**——那个窗口里的 23 个异常点此前已经存过，所以异常行数仍是 588。
这也是为什么本表不写一个死的行数当作"永久事实"——它是随打分窗口增长的存档。

两个脚本的定位已经写在偏差 D-18 / D-19 里，一句话：**接口读 artifact（唯一真相源），
表存历史与存档**。反过来做就会出现"表说是模型 A、实际跑的是模型 B"且无法判断该信谁。

## 8.7 本批发现并修复的问题（6 个，全部有实测证据）

### ① 告警扫描漏判（第 2 阶段遗留缺陷，偏差 D-23）

**现象**：往 CNC-01 写一条 94.5℃ 的遥测，25 秒内没有生成告警；同一时刻往 INSP-01 写却能生成。

**定位**：重启后端（游标重置为"回看 600 秒"）后，同一条记录立刻被判为 CRITICAL：

```text
alarm_id 1039 | CNC-01 | TEMPERATURE | CRITICAL | 2026-11-25 10:00:16.408
```

**根因**：`inserted_at` 是**事务开始时间**，不是提交时间。并发写入时先开始的事务可能后提交，
此时它的 `inserted_at` 比已经推进的游标更早，`inserted_at >= 游标` 把它永久跳过。

**修复**：`scan_from = _cursor - 30 秒`（`scan_floor()`）。回退带来的重复扫描由 5 分钟冷却挡掉。
补了 2 条回归测试（回退量正确、回退窗 < 冷却窗 / 4）。

### ② heatmap 缺 visualMap 导致整页白屏（D-20）

```text
EXC: Uncaught Error: Heatmap must use with visualMap
     at HeatmapView2.render (echarts_charts.js)
ERR: The above error occurred in the <ChartCard> component
→ body.innerText 为空，html 只有 103 字符（React 树已崩）
```

ECharts 5 的 heatmap 强制要求 visualMap。修法：加隐藏的 visualMap 满足前置条件，
颜色仍由每格的 itemStyle 按语义给（TN/FP/FN/TP 四种颜色），而不是按数值做色阶。

### ③ 面积填充盖住了真值色块与散点（D-21）

第一版给折线加了 `areaStyle`。尖峰冲顶后，面积填充把下方整个区域涂成一个灰块，
markArea 的橙色真值区间和红色散点全被压在下面，图上只剩"一个大矩形"。去掉 `areaStyle` 后正常。

### ④ 验收脚本一次往 4 台设备写数据（D-25）

注入值写死了 `vibration=2.0 / current=9.5`（按 CNC 阈值定的）。在 INSP-01 上一次注入
同时触发三条告警（该设备振动严重阈值只有 1.88）；且"15 秒没等到就换下一台"导致一次运行
连写 CNC-01/04/02/03 各一条 95℃，事后逐条清理。

修法：温度按 `该设备正常上限 × 1.35` 算，其余指标取正常区间中值；只注入一台，等不到就报失败。

### ⑤ 两处断言竞态（D-24）

- **维护记录表按索引取**：`tables[1]` 假设第一张表一定是告警表。告警为空时列表渲染的是空态，
  第一张 `.table` 其实是维护表，`tables[1]` 直接 undefined → 误报"页面上没有第二张表"。
- **生产 KPI 数据未到就断言**：卡片先渲染、数据后到，中间态是「—／等待数据」，
  结果为"页面 — / 接口 96.6%"这种假失败。

两处都改成按内容定位/等值到位，连跑两次稳定通过。

### ⑥ `reset.sql` 漏掉两张新表

**现象**：新增 `model_versions` / `anomaly_scores` 后，`reset.sql` 和 `reset_drop_only.sql` 里仍只删 8 张表。
`DROP TABLE devices CASCADE` 只会删掉指向它的外键约束，不会删表本身——于是"清库重建"后
这两张表成了没有外键约束的孤儿表，`schema.sql` 的 `CREATE TABLE IF NOT EXISTS` 也不会重建它们，
表结构和当前代码可能悄悄分叉。

**修法**：两个脚本都补上 `DROP TABLE IF EXISTS anomaly_scores`（必须排在 `devices` / `model_versions` 之前，
它是这两张表的子表）与 `DROP TABLE IF EXISTS model_versions`。

**怎么验证的**（不能拿演示库试，会真清 455 万行）：在同一个容器里建临时库 `sftwin_reset_test`，
灌 `schema.sql` + `seed.sql` → 往两张新表各插一行 → 执行完整 `reset.sql`：

```text
DROP TABLE × 10 → SET / CREATE TABLE × 10 / CREATE INDEX × 15，0 ERROR
表数 10 | 索引数 27 | 车间 2 | 产线 4 | 设备 14 | 模型行 0 | 分数行 0
```

再连跑一次 `reset.sql`，`grep -icE "error|warning"` 结果为 **0**（幂等）。临时库随后 `DROP DATABASE` 删除，
主库 `smartfactory` 复核仍为 4,555,663 行遥测 / 719 条告警 / 1 行模型 / 24,659 行分数（均为该次复核时的值），未受影响。

> 附带发现：`model_versions.task` 的 CHECK 只接受 `anomaly_binary` / `anomaly_type` / `risk_score` /
> `production_forecast` 四个值。写错值会直接 `violates check constraint`，属于预期行为，不是缺陷。

## 8.8 本批明确未做 / 未验证

| 项 | 状态 | 归属 |
|---|---|---|
| TimescaleDB 迁移与压缩比实测 | 未做 | 4.3 批 |
| Kafka 替换 HTTP 直写 | 未做 | 4.4 批 |
| D 块故障风险打分 / E 块产量预测 | 未做 | 4.5 批 |
| SHAP 逐样本解释（L-10） | 未做（P1） | 后续 |
| 模型在生产数据上的泛化 | **无法验证**：数据是模拟器造的，标签是注入真值 | 论文限定条件 |
| 24 小时窗口的交互流畅度 | **未测真机手感**：接口 2.0s，页面会等一次推理 | 人工判断项 |
| 多标签异常的归因（同一设备多种异常） | **未验证**：数据集里每台设备只配了一种异常类型（见 5.1） | 真实数据才有意义 |

## 8.9 截图与日志（均已生成在 `output/`，不进 git）

| 文件 | 内容 |
|---|---|
| `output/shot_ai_model.png` | AI 页**整页**（1680×5823）：状态条 → 四指标卡 → 混淆矩阵 + 四模型对比 → 分数曲线 → 真值统计卡 → 异常真值时间轴 → 真值 vs 阈值告警对照 → 异常真值列表 |
| `output/shot_ai_score.png` | 分数曲线特写（1662×904，视口截图）：折线 + 红色散点 + 橙色真值色块 + 阈值虚线 |
| `output/shot_ai_acceptance.png` | `acceptance-ai.mjs` 结束时自动截的视口图（脚本自己产出，与 `shot.mjs` 分开命名，避免互相覆盖） |
| `output/logs/phase4_ai_acceptance.log` | `acceptance-ai.mjs` 42 项完整日志（8.3 引用的就是它） |
| `output/logs/phase4_batch2_rerun.log` | 4.2 批后 `acceptance-batch2.mjs` 复跑日志（24 项） |
| `output/logs/phase4_motion_rerun.log` | 4.2 批后 `acceptance-motion.mjs` 复跑日志（17 项） |

截图用 `scripts/shot.mjs` 生成——它截的是**浏览器当前已打开的页面**（不接受 URL 参数），所以在跑完
`acceptance-ai.mjs`（末尾会停在 `/ai`）之后紧接着执行即可：

```powershell
node scripts\shot.mjs output\shot_ai_model.png --full
# 整页高度 5823px，按 5823px 截取
# 已保存 output/shot_ai_model.png
```

`--full` 的两个细节（都是踩过才知道的）：滚动容器是 `.content`（`.content { overflow: auto }`），
不是 `window`，所以要先把它 `scrollTo(0, 0)` 再量 `.content.scrollHeight`；否则量到的是视口高度，
截出来只有首屏。AI 页整页高 5823px，早先脚本把上限写死 4000，尾部异常真值列表会被截掉一半。

> `output/` 与 `artifacts/` 都在 `.gitignore` 里：前者是本地验收证据（截图、DOM 快照、日志），
> 后者是可由 `ml/` 下脚本重建的模型产物（体积大）。克隆仓库后这两处需要自己跑一遍才会出现。

---

# 第 9 节：4.3 批（TimescaleDB 迁移）+ 4.4 批（压缩与查询对比）

## 9.0 本批要证明什么

只有三句话：

1. **换掉存储引擎不丢一行数据**，且原有功能全部照常（回归全过）；
2. **迁移是可回滚的**——备份在、回滚路径演过、失败判据明确；
3. **压缩带来多少空间收益、多少查询收益，用同一组查询在三个状态下实测出来**，而不是引用"业界通常"。

## 9.1 交付物

| 文件 | 内容 |
|---|---|
| `docker-compose.yml` | 镜像 `postgres:16` → `timescale/timescaledb:2.17.2-pg16`（版本锁死） |
| `database/migrate_timescale.sql` | 迁移脚本，可重复执行（`IF NOT EXISTS` / `IF EXISTS` / `create_hypertable(if_not_exists)`） |
| `backup/pre_timescale.dump` | 迁移前全库备份，78,476,537 字节（**不进 git**） |
| `backup/bench_final5.sql` / `backup/parse_bench.py` | 五查询测量脚本与解析器（不进 git） |
| `app/services/ml_anomaly.py` | 修 D-34：窗口边界归整到整秒 |
| `frontend/src/pages/AiInsight.tsx` | 修 D-36：分数曲线窗口终点后退 5 秒 |
| `tests/test_ml_api.py` | 新增回归测试 `test_scores_echoed_window_matches_queried_window` |

## 9.2 迁移过程（含一次失败与修法）

**① 迁移前基线**（先停模拟器，否则行数一直在变）

```text
行数 4,570,704 | 11-17 13:25:06 ~ 11-25 02:50:10
总量 1001 MB = 表 446 MB + 索引 555 MB
```

**② 备份**

```text
pg_dump -Fc → backup/pre_timescale.dump
78,476,537 字节 | TOC Entries: 98 | Compression: gzip | Dump Version: 1.15-0
pg_restore -l 能正常列出 TOC（证明备份不是坏文件）
```

**③ 拉镜像与换镜像**

```text
docker pull timescale/timescaledb:2.17.2-pg16   耗时 8 分 59 秒
镜像内 PostgreSQL 16.6 / timescaledb 2.17.2（扩展已 installed，无需手工 CREATE EXTENSION）
```

**④ 重建库 → 建表 → 恢复数据（第一次恢复失败，值得记下）**

第一次用 `--data-only` 恢复，**报 8 个外键错误**：

```text
pg_restore: error: COPY failed for table "devices": violates foreign key constraint "fk_devices_workshop"
DETAIL:  Key (workshop_id)=(WS-A) is not present in table "workshops".
...（devices / production_lines / production_orders / maintenance_records / device_telemetry 均如此）
pg_restore: warning: errors ignored on restore: 8
```

原因：`--data-only` 的 COPY 顺序不按外键依赖排，父表还没进数据，子表就开始了。
结果只有 `workshops`(2) 与 `model_versions`(1) 进库，其余全是 0 行。

**修法**：`TRUNCATE` 全部表后，改用 `--disable-triggers`（`sf` 是超级用户）：

```powershell
docker exec -i sftwin-db pg_restore -U sf -d smartfactory --data-only --no-owner --no-privileges --disable-triggers < backup/pre_timescale.dump
```

```text
耗时 42.08 秒，退出码 0，无任何 error
```

**⑤ 执行迁移脚本**

```text
NOTICE:  migrating data to chunks
       create_hypertable
-------------------------------
 (1,public,device_telemetry,t)
ALTER TABLE
ANALYZE
 hypertable_name  | num_chunks | compression_enabled
------------------+------------+---------------------
 device_telemetry |          9 | t
耗时 2 分 3.998 秒
```

## 9.3 迁移后四查（实际输出）

```text
① 行数 4,570,704 | 11-17 13:25:06 ~ 11-25 02:50:10     ← 与迁移前完全一致，差异 0
② device_telemetry | 9 chunks                          ← 跨 9 个 UTC 日历日
③ 逐设备最近 1 小时：14 行，1687 ~ 1739 点/台           ← 模拟器启停导致不足 1800
④ 约束：pkey 已删；uq_telemetry_device_ts(u) / fk_telemetry_device(f) / 5 个 CHECK 均保留
```

> **② 后来变成 10 个 chunk**，多出来的是 `range_start = 2020-03-01` 的空 chunk（0 行）。
> 原因：`test_over_5000_points_is_downsampled` 用固定时间戳 2020-03-01 造 5100 个点验证降采样，
> `purge` fixture 删了行但 TimescaleDB 不会因为 chunk 空了就回收它（D-37）。
> 所以"chunk 数"这个数只在**跑 pytest 之前**等于 9，之后是 10。判断存储是否正常时按这个规矩看。

**幂等路径验证**（这是最容易被换库破坏的东西）：拿一条**已存在**的 `(device_id, ts)` 重发

```text
{"accepted":0,"duplicated":1,"rejected":0,"elapsed_ms":9}
```

`duplicated: 1` 说明 `ON CONFLICT (device_id, ts) DO NOTHING` 在 hypertable 上照常工作。
这条路径是模拟器与 `--backfill-days` 都依赖的，一旦坏了会静默重复写入。

**压缩块可写性验证**（推翻原规格的判断，见 D-30）：往已压缩的 `_hyper_1_5_chunk`（`is_compressed=t`）插入一行

```text
INSERT 0 1
插入后可见 = 1
DELETE 1
```

三条都成功。所以"压缩块不可写"是错的，TS 2.17 支持对压缩块做 DML；真正的代价是性能。

## 9.4 压缩实验

**四口径体积**

| 状态 | 表 | 索引 | toast | 总量 |
|---|---|---|---|---|
| 普通表（迁移前） | 446 MB | 555 MB | ~0 | 1,001 MB |
| hypertable 未压缩 | 444 MB | 486 MB | 0 | 930 MB |
| **hypertable 压缩后** | **67 MB** | **72 MB** | **94 MB** | **234 MB** |

压缩比：**表口径 6.63:1**、索引口径 6.75:1、**总量口径 3.97:1**；与迁移前相比 4.28:1。

两个容易说错的地方，按实测改：

- **迁移本身（未压缩）就把 1,001 → 930 MB**（-7%），原因是重建消除了堆与索引的膨胀。这部分**不算压缩收益**，所以压缩比的分母用 930。
- **索引也一起被压小了**（486 → 72 MB）。"索引不参与压缩"在 TimescaleDB 上是错的，因为压缩块重建了更小的索引。

逐块明细（压缩后）：

```text
_hyper_1_24 2020-03-01  ~0 MB  t   ← 空 chunk，pytest 留下的（D-37），无数据
_hyper_1_4  11-17   6.8 MB  t
_hyper_1_3  11-18    15 MB  t
_hyper_1_6  11-19    15 MB  t
_hyper_1_5  11-20    15 MB  t
_hyper_1_7  11-21    15 MB  t
_hyper_1_8  11-22    15 MB  t
_hyper_1_2  11-23    15 MB  t
_hyper_1_1  11-24   123 MB  f   ← 最近 1 天，不压
_hyper_1_9  11-25    15 MB  f   ← 当前块，不压
```

**三态耗时**（协议：五个查询全部包一层 `count(*)` 只计服务端；窗口锚定 `2026-11-25 02:50:10+00`；
状态切换后先跑一轮丢弃，再跑 10 次取中位数）

| 查询 | 普通表 | hypertable 未压缩 | hypertable 压缩 | 压缩 vs 普通表 |
|---|---|---|---|---|
| Q1 单设备 1 小时明细 | 0.449 ms | 0.669 ms | 0.669 ms | +49%（+0.22 ms，可忽略） |
| Q2 全厂 1 小时均温 | 3.377 ms | 4.018 ms | 3.958 ms | +17%（+0.58 ms） |
| Q3 单设备 24 小时按分钟聚合 | 5.613 ms | 5.024 ms | 4.835 ms | **-14%** |
| Q4 全表按小时计数 | 96.774 ms | 92.928 ms | 66.525 ms | **-31%** |
| Q5 冷数据单设备一天（压缩块） | 6.084 ms | 5.937 ms | 3.227 ms | **-47%** |

每个查询的极差（10 次）：Q1 32% / Q2 16% / Q3 20% / Q4 8.7% / Q5 28.9%（压缩态）；
未压缩态 Q4 极差 27.7%；普通表 Q4 极差 9.8%。原始时间值见 `backup/final_*.txt`。

## 9.5 结论（一句话）

> 456 万行遥测在普通表占 1,001 MB，转 hypertable 并压缩后占 234 MB（**总量 3.97:1，表口径 6.63:1**）；
> 扫描类查询明显变快（全表聚合 96.8 → 66.5 ms，冷数据单设备 6.08 → 3.23 ms），
> 点查类查询无变化（单设备 1 小时 0.45 → 0.67 ms，差值 0.2 ms 量级）。

**不要写成"性能全面提升"**：点查是略慢的，只是慢得可以忽略。

## 9.6 无回归

```text
node scripts/acceptance-batch2.mjs   24 / 24
node scripts/acceptance-motion.mjs   17 / 17
node scripts/acceptance-ai.mjs       42 / 42，连跑 3 次全过
python -m pytest tests -q            25 passed（24 + 新增 1 条回归）
```

压缩态下另做了应用级验证：接口从压缩块读整天数据

```text
GET /devices/CNC-01/telemetry?start=2026-11-20T00:00:00Z&end=2026-11-20T23:59:59Z
HTTP 200，75.6 ms，4800 点，范围 00:00:00 ~ 23:59:42，样本温度 59.1
```

## 9.7 本批发现并修复的问题

### ① `/ml/anomaly/scores` 回显的窗口不是它查询的窗口（D-34，真 bug）

**现象**：`acceptance-ai.mjs` 的「分数曲线点数与同窗重放一致」约 **1/3 概率**失败，差 1 个点：

```text
FAIL  6.2 分数曲线点数与同窗重放一致  · 页面「944」/ 接口「945」
FAIL  6.2 分数曲线点数与同窗重放一致  · 页面「976」/ 接口「977」
```

**定位过程**（三步排除）：

1. 先怀疑活数据源竞态 → 给页面窗口终点加 5 秒后退，**仍然失败**；
2. 用日志里那个固定窗口连查 3 次接口 → `977 / 977 / 977`，**接口本身是确定的**，排除数据漂移；
3. 对比"带毫秒"与"整秒"两种窗口 → 同一个时刻，`end=03:25:58.437` 返回 **976**，`end=03:25:58.000` 返回 **977**。

**根因**：响应体的 `start/end` 走 `app/utils.py::iso()`，它用 `timespec="seconds"` **截掉微秒**；
而 SQL 用请求里的原始微秒精度查询。于是**回显值重放时会向下取整 `start`，把边界上那一行多算进来**。
前端 `toISOString()` 必然带毫秒，所以这个 bug 每次都会出现，只是落在采样点边界上才看得出来（约 1/3 概率）。

**修法**：`score_window()` 开头把两端归整到整秒，让"查的"和"回显的"是同一个窗口：

```python
start = start.astimezone(UTC).replace(microsecond=0)
end = end.astimezone(UTC).replace(microsecond=0)
```

**回归测试**：新增 `test_scores_echoed_window_matches_queried_window`。
验证过它真的能抓 bug——把修复注释掉后，该用例 `1 failed`；恢复后 `25 passed`。

### ② 前端窗口终点后退 5 秒（D-36）

即使修好了回显，窗口终点若取"当前时刻"，最后一行的提交时刻（实测滞后 3~30 ms）仍可能落在页面请求之后。
后退 5 秒让窗口落在已落库的数据上，同窗重放才稳定。代价是曲线末端少 5 秒，肉眼看不出。

### ③ 测量协议本身出过错（D-35，教训最大的一条）

第一版测量得出的结论是"压缩后全表扫描反而慢 5~10%"。按同一状态重复测量后发现，这个结论是**假象**，三个原因：

| 问题 | 后果 | 修法 |
|---|---|---|
| 查询没有包 `count(*)`，结果行回传给客户端 | Q4 返回 180 行、Q3 返回 1440 行，**客户端格式化时间主导了计时** | 全部包一层 `count(*)`，只计服务端 |
| 状态切换（压缩/解压）后立刻测 | 第一轮被 IO 尾流污染，同一状态两轮相差 **51%** | 切换后等 15 秒，先跑一轮丢弃 |
| Q1~Q3 窗口都在最新未压缩块 | 根本碰不到压缩块，测不出压缩的任何影响 | 新增 Q5（固定查已压缩的 11-20 全天） |

修正后三态数据自洽，"压缩让扫描更快"这个方向才站得住。

### ④ 其余规格判断被实测推翻（D-26 ~ D-33）

| 偏差 | 原判断 | 实测 |
|---|---|---|
| D-26 | dump 预期 > 100 MB | 78 MB |
| D-27 | 用 `pg_total_relation_size` 量 hypertable | 只量到父表 **24 kB**（真实 930 MB），必须用 `hypertable_detailed_size` |
| D-28 | 索引不参与压缩、压缩后几乎不变 | 486 → **72 MB**（也压了 6.75 倍） |
| D-29 | 三口径（表/索引/总量） | 压缩态 **toast 占 94 MB**，须四个口径 |
| D-30 | 压缩块不可写 | **可写**（TS 2.17 支持 DML） |
| D-31 | 四个查询即可 | Q1~Q3 不触及压缩块，须加 Q5；Q4 须测两遍 |
| D-32 | 预估 8 个 chunk | 实测 **9**（跨 9 个 UTC 日历日） |
| D-33 | 压缩比按迁移前总量算 | 迁移本身已降 7%（消除膨胀），分母须用 930 |

## 9.8 本批未做 / 未验证

| 项 | 状态 | 说明 |
|---|---|---|
| 压缩的后台 job（`add_compression_policy`） | **未做**（§8 第 16 条明确不做） | 本阶段手工压缩；自动化后若压到正在回填的块，排查成本高于手工 |
| 7 天压缩边界在真实回填下的表现 | **未验证** | 本批回填深度为 0；"回填跨压缩边界"的实际代价没有样本 |
| 保留策略（`add_retention_policy`） | **未做** | 属数据治理，不在本阶段范围 |
| `timescaledb.compress_chunk_time_interval` | **未做** | 默认按 chunk 区间，无特殊需求 |
| 24 小时窗口的页面手感 | **未测真机**（人工项，§5.8 第 2 项） | 无头环境软渲染，帧率与手感测不出 |
| 迁移耗时在更大数据量下的推算 | **未做** | 456 万行 2 分 4 秒；线性外推不可靠（chunk 搬迁有固定开销），不做承诺 |

## 9.9 人工检查（§5.8 第 1、2 项的实际结论）

| # | 检查项 | 结论 | 依据 |
|---|---|---|---|
| 1 | 压缩前后耗时的可比性 | **可信** | 最终一轮五个查询的极差 8.7% ~ 28.9%，均 < 30%。中间曾出现 51% 的异常轮次，已按 D-35 加"丢弃轮"消除 |
| 2 | 压缩后 24 小时窗口的页面手感 | **未测**（人工项仍未做） | 只测了接口耗时：1 小时 19 ms / 6 小时 78 ms / 24 小时 74 ms（24 小时返回 4,800 点 / 588 KB）。接口侧没有变慢的迹象，但"切换后多久出图"依赖浏览器渲染，无头环境给不出可信数字。**上表不得据接口数据推断页面手感** |

> 第 2 项不结案，留在人工项里。答辩前应在有显示器的环境上手动切一次 1h / 6h / 24h 并记一笔。
> 这一条宁可空着，也不拿接口耗时冒充页面手感——两者不是一回事。

---

## 10. D1 批：视觉基调（2026-11-25）

### 10.0 要证明什么

不是"变好看了"，而是四件可核对的事：

1. 后处理参数**就是**规格 §6.1 那张表（不是"接了 bloom"就算完）；
2. 场景几何**没有因为 D1 变重**（draw call 与三角形不涨，甚至应略降）；
3. 帧率与首屏**在预算内**，且回退了多少要写出来；
4. 前后对比能**同机位**复现（6 个机位写死在脚本里）。

### 10.1 交付物

| 文件 | 内容 | 规模 |
|---|---|---|
| `frontend/src/three/postfx.ts`（新增） | RenderPass → UnrealBloomPass → OutputPass → SMAAPass，零新增依赖（走 `three/examples/jsm`，SMAAPass 贴图是模块内置 base64） | 约 150 行 |
| `frontend/src/three/SceneRoot.tsx`（改） | 接管线（`renderFrame()`）、`autoReset=false` + 显式 `reset()`、ACESFilmic + exposure、`scene.fog`、灯光重配、原子探针 `profile()` | +60 行 |
| `frontend/src/three/materials.ts`（改） | 两张程序化贴图：地面混凝土（颗粒 + 6 m 分仓缝）、墙面墙板（上亮下暗 + 竖向板缝 + 踢脚线）；墙面由 12% 透明改实墙 | +110 行 |
| `scripts/acceptance-d1.mjs`（新增） | 9 项断言：参数 6 项 + 开销 3 项 | 约 120 行 |
| `output/d0/`、`output/d1/` | 同 6 机位的前后截图 + `poses.json` + `baseline.json` | 各 6 张 |

### 10.2 实测

**参数（逐项比对规格 §6.1）：**

| 项 | 规格 | 实测 |
|---|---|---|
| toneMapping | ACESFilmic | `4`（ACESFilmic） |
| exposure | 1.05 | **1.05** |
| Bloom strength / radius / threshold | 0.35 / 0.6 / 0.85 | **0.35 / 0.6 / 0.85** |
| pass 链 | Render → Bloom → Output → SMAA | **完全一致**，OutputPass 在 SMAA 之前 |
| 雾 | Fog(28, 120)，色 = 背景 `#0b1018` | **28 / 120 / #0b1018** |

**开销（D0 → D1，同一台机、同一机位）：**

| 指标 | D0 | D1 | 说明 |
|---|---|---|---|
| 场景 draw call（不含阴影/后处理） | 108\* | **120** | 墙面由透明改实墙后**少 12 次**（不再走透明队列）；D0 是旧口径，见 10.5 第 1 条 |
| 阴影 pass | 未单列 | **50** | 首次单独量出来 |
| 后处理 pass | 0 | **17** | Bloom 多级降采样 + SMAA + OutputPass |
| 整链合计 | 108\* | **187** | **120 + 50 + 17 = 187**，能加回总数 |
| 三角形（场景） | 9,146\* | **10,922** | 墙体不再走透明队列导致的重算差异，非新增几何 |
| fps 中位（5s rAF） | 144.9 | **144.9** | 已顶 144Hz 上限，降幅不可用于判断开销 |
| 首屏可交互 | 562 ms | **1,227 ms** | **+665 ms**，着色器首次编译，仍在 ≤3 s 内 |

### 10.3 验收日志（`output/logs/d1_acceptance.log` 节选）

> 节选：省去脚本开头打印的参数 JSON（23 行），断言与数字一行未改。完整文件见 `output/logs/d1_acceptance.log`。

```text
PASS  toneMapping 为 ACESFilmic（4）  · 实际 4
PASS  曝光在 1.00~1.10  · 实际 1.05
PASS  pass 链为 RenderPass → UnrealBloomPass → OutputPass → SMAAPass  · RenderPass → UnrealBloomPass → OutputPass → SMAAPass
PASS  OutputPass 在 SMAA 之前（LDR 上做边缘检测）
PASS  Bloom 三项与规格一致（0.35 / 0.6 / 0.85）  · 0.35 / 0.6 / 0.85
PASS  雾为 Fog(near=28, far=120) 且雾色等于背景 #0b1018  · #0b1018 28~120
场景 draw call   : 108 → 120（Δ 12）
  ├ 阴影 pass    : 50
  ├ 后处理 pass  : 17
  └ 整链合计     : 187
三角形           : 9146 → 10922
fps 中位         : 144.9 → 144.9
PASS  场景 draw call 仍在可合批范围（≤ 140）  · 实际 120，D2 目标 ≤100
PASS  场景 + 阴影 + 后处理 = 整链 draw call  · 120 + 50 + 17 = 187（整链 187）
PASS  fps 降幅 ≤ 15%  · 实际 0.0%
合计 9 项，通过 9，失败 0
```

> "场景 + 阴影 + 后处理 = 整链"这条断言是**为了防统计漏项**才加的。D1 调试中真的出现过
> `120 + 50 + 45 = 215 ≠ 187`：因为分三次读、每次都跨帧，`sceneCalls` 被上一次测量改写。
> 改成一次读齐的原子探针 `profile()` 后才对上——这类错误不写成断言，下次还会犯。

### 10.4 前后对比截图

| 机位 | 前（D0） | 后（D1） | 可见变化 |
|---|---|---|---|
| 总览 | `output/d0/01_overview.png` | `output/d1/01_overview.png` | 出现车间墙体、地面分格缝、远景空气衰减 |
| WS-A | `output/d0/02_ws_a.png` | `output/d1/02_ws_a.png` | 墙面竖向板缝可见，车间成为"有围护的空间" |
| 设备特写 | `output/d0/04_device.png` | `output/d1/04_device.png` | 机身明暗层次出现，面板凹槽可辨，无过曝白块 |
| 人眼高度 | `output/d0/06_eye_level.png` | `output/d1/06_eye_level.png` | 背景由纯黑虚空变为墙体，地平线不再悬空 |

### 10.5 三个发现（都已回写规格）

1. **计数口径必须重定义**（D-45）。D0 的 108 / 9,146 用的是 `renderer.info.autoReset` 默认行为（只反映末次 render），
   D1 改为每帧显式 `reset()` 并把场景/阴影/后处理分开。两组数**不可相减**，所以 D1 起一律用 `profile()` 的同口径数字。
2. **首屏回退 665 ms**（D-46）。材质与后处理的着色器首帧编译所致。仍在预算内，但列为 D6 观察项。
3. **"幽灵墙"是 D0 问题 #1 的真因**（D-47）。墙面原本 `opacity 0.12 + depthWrite:false`，
   在深色背景上几乎不可见；改为不透明实墙 + 墙板贴图后，**场景 draw call 反而少 12 次**——
   因为墙体不再进入透明队列。这条不是回归，是修正。

### 10.6 无回归

```text
cd frontend && npm run test -- --run    → 9 files / 86 tests passed（5.62 s）
cd frontend && npm run build            → ✓ built in 6.36 s，0 error
npx tsc --noEmit                        → 0 error
```

`__sceneDebug` 新增的 `postfx / profile / measureSceneCalls` 与 D0 的 `setCamera` 一样只在 DEV 分支，
生产包内 `grep` 命中 0 处。

### 10.7 未做

| 项 | 原因 | 何时做 |
|---|---|---|
| 盲测（"这是工厂吗"） | D1 只定了基调，道具与界面还没上；现在测大概率得到"这是个模型" | D2 之后 |
| 3 分钟稳定性 | 需要完整录屏与逐帧检查 | D6 |
| 弱机帧率 | 统一协议在 D6 执行（CPU 4× 降速） | D6 |
| 动态分辨率 | D1 未做，避免与后处理的 RT 尺寸互相干扰；若 D6 弱机不达标再引入 | D6 |

---

## 11. D2 批：工业道具（2026-11-25）

### 11.0 要证明什么

不是"加了些东西"，而是四件可核对的事：

1. **加得起**：draw call 在预算内（≤100），且道具只占个位数到十几次数；
2. **放得对**：道具与 14 台设备包围盒零相交（可算，不靠看图）；
3. **看得见**：每类道具都能在某个机位被认出来，而不是建在墙里；
4. **没退化**：D1 的后处理参数、fps、单测保持。

### 11.1 这一批其实是两步

D1 结束时场景 draw call 是 **120**，而 D2 的上限是 **100**——加道具之前必须先"欠"出预算，
否则做完必然是 135+ 再返工。所以 D2 拆成：先合批（只降不升），再加道具。

**第一步：合批 120 → 67（省 53）**

| 对象 | 手段 | 前 | 后 | 省 |
|---|---|---|---|---|
| 状态灯 | `InstancedMesh` + `instanceColor` | 14 | 1 | 13 |
| 地面光环 | 同上 + 实例矩阵 scale 隐藏 | 14 | 1 | 13 |
| 墙体 | `mergeGeometries`（世界变换烘进顶点） | 8 | 1 | 7 |
| 产线色带 | `mergeGeometries` | 4 | 1 | 3 |
| 其它（阴影口径修正等） | — | — | — | 17 |

灯与环的合并改变了状态表达方式，这是这一批最大的技术决定：

- 原来"换材质引用"表示状态（每状态一个共享材质，`opacity` 做呼吸/闪烁）；
- 合并后材质只有一份，颜色改由 `instanceColor` 逐实例写，呼吸/闪烁折成"颜色亮度"；
- STOPPED / WS 断开时环不能逐实例 `visible`，改用实例矩阵 `scale` 缩到 0；
- `frustumCulled = false`：实例散布全场而父级只有一个 mesh，默认包围球会把整批误剔除。

> 顺带删掉了已不参与渲染的状态材质池（10 个材质）。留着它会让后来人以为"换材质还能生效"。

**第二步：加道具 67 → 77（+10）**

| 类别 | 数量 | 手段 | draw call |
|---|---|---|---|
| 设备基座 | 14 | `InstancedMesh` + scale | 1 |
| 护栏立柱 | ~120 根 | `InstancedMesh` | 1 |
| 护栏横杆 | 16 根 | `InstancedMesh` | 1 |
| 地面黄黑警示带 | 6 段 | 合并（逐段改 UV 保住斜纹比例） | 1 |
| 线槽 | 8 段 | 合并 | 1 |
| 架空管道 | 12 根 | 合并 | 1 |
| 货架 | 4 个 × 7 件 | 合并 | 1 |
| 安全标识 | 5 块 × 3 种贴图 | 按种类合并 | 3 |

### 11.2 实测

| 指标 | D1 | D2 | 说明 |
|---|---|---|---|
| 场景 draw call | 120 | **77** | 上限 100 |
| 阴影 pass | 50 | **53** | 基座/管道/货架开了投影；护栏立柱刻意关闭 |
| 后处理 pass | 17 | **17** | 未动 |
| 整链 | 187 | **147** | 77 + 53 + 17 = 147 |
| 三角形（场景） | 10,922 | **16,769** | 合批不减面数，只减绘制次数 |
| fps 中位 | 144.9 | **144.9** | 未降 |
| 道具占 draw call | — | **10** | 7 类道具 |

### 11.3 验收日志（`output/logs/d2_acceptance.log` 节选）

> 节选：省去脚本开头的道具类别与分组打印，断言与数字一行未改。完整文件见 `output/logs/d2_acceptance.log`。

```text
PASS  道具类别包含 plinth  · ok
PASS  道具类别包含 railing  · ok
PASS  道具类别包含 hazard  · ok
PASS  道具类别包含 tray  · ok
PASS  道具类别包含 pipe  · ok
PASS  道具类别包含 rack  · ok
PASS  道具类别包含 sign  · ok
PASS  道具类别 ≥7  · 实际 7 类
PASS  场景 draw call ≤ 100  · 实际 77
PASS  场景 + 阴影 + 后处理 = 整链  · 147 vs 147
PASS  道具 draw call ≤ 14（7 类道具靠 InstancedMesh/合并压到个位数）  · 实际 10
PASS  fps 中位 ≥ 50  · 实际 144.9
PASS  01_overview 非空白  · 1662×904, 345 KB, 平均亮度 22.6
PASS  02_ws_a 非空白  · 1662×904, 338 KB, 平均亮度 23.7
PASS  03_ws_b 非空白  · 1662×904, 336 KB, 平均亮度 24.2
PASS  04_device 非空白  · 1662×904, 276 KB, 平均亮度 27.3
PASS  05_line 非空白  · 1662×904, 178 KB, 平均亮度 25.5
PASS  06_eye_level 非空白  · 1662×904, 175 KB, 平均亮度 25.2
PASS  全程无页面运行时异常  · 0 条
合计 19 项，通过 19，失败 0
```

截图那条断言不是形式主义：它读文件大小**并且**把 PNG 交给页面解码算平均亮度（<6 判黑）。
"6 张文件都在、但全是黑屏"这种情况，只查文件存在是抓不到的。

### 11.4 截图为证

| 机位 | 文件 | 能看到什么 |
|---|---|---|
| 总览 | `output/d2/01_overview.png` | 两道架空管道贯穿车间、黄黑警示带围住动力站、护栏沿产线、墙面标识 |
| WS-A | `output/d2/02_ws_a.png` | 墙板竖缝、管道、护栏、基座、通道警示带同框 |
| 设备特写 | `output/d2/04_device.png` | 基座台面、状态灯、机身明暗层次 |
| 车间内通道 | `output/d2/07_in_aisle.png` | 站在车间里看两道护栏与设备的纵深关系 |
| 车间内货架 | `output/d2/07_in_rack.png` | 橙色三层货架立在墙边，未插墙、未悬空 |
| 车间内管道 | `output/d2/07_in_pipe.png` | 抬头看到圆柱管道横跨，有高光 |

> 后 4 张是**补充机位**（不在 6 个固定机位里），专门为了验证"建在墙里"与穿模。
> 第一次拍货架时机位撞进了 CNC-02 内部，什么都没看到——这类错误只有真看图才会发现。

### 11.5 两处必然穿模的摆放错误（都已修，且写成了测试）

**① 护栏扎进基座（D-48）**

护栏偏移最初取 1.5 m。而 CNC 机身深 2.6 m，加了 0.5 m 外扩的基座后占地半深是 **1.8 m**——
1.5 意味着护栏立柱直接扎在基座里。截图上表现为"护栏从设备底下穿过去"。

改 2.0 m。并且**反向验证过测试有效**：把常量改回 1.5，测试立刻失败并指名道姓：

```text
× 护栏不扎进任何设备基座 → LINE-A1 的护栏（z=-9）压住了 CNC-01 的占地
× 护栏偏移必须大于「最宽设备的基座半深」，否则必然穿模
```

**② 货架被设备挡死（D-49）**

货架原本放在东西墙中段（z = +7.5），与 LINE-A2 的设备连成一线。从车间中部看西墙货架，
视线正好穿过 CNC-02——拍出来是 CNC-02 的机箱特写。改到对角角落。

### 11.6 一处为了"不空"而改的光照参数（D-50）

D1 那版墙面在车间内部抬头看时，y > 3 m 是**纯黑**的，车间像个空箱子。
原因不是灯不够亮，是半球光对竖直法线的贡献本就低，再乘 D1 的深色贴图就归零了。

墙贴图基色提亮约 25%（`#28384a → #3a4f68` 起）。总览截图的平均亮度 22.6，没有过曝。

### 11.7 无回归

```text
cd frontend && npm run test -- --run   → 10 files / 96 tests passed（新增 10 条道具约束）
cd frontend && npm run build           → ✓ built in 7.84s，0 error
npx tsc --noEmit                       → 0 error
node scripts/acceptance-d1.mjs         → 9/9（后处理参数与 fps 未受影响）
```

### 11.8 未做

| 项 | 原因 | 何时做 |
|---|---|---|
| **盲测**（3 人、≥2 人说"工厂"） | 需要真人，脚本代替不了。这是 D2 唯一的硬指标缺口 | 由作者找 3 位没参与项目的人看图，原话记在本节 |
| 车间顶部（桁架 / 屋面板） | 总览机位在 y=40 俯视，实心屋顶会挡住全部设备。加**桁架梁**可行但属新增范围（D-53） | 若 D6 觉得"抬头像空箱"再补 |
| 道具的独立拾取 | 合批后不可单独点选。道具本就不需要点击（D2 风险 ②） | 不做 |
| 传送带结构细化（侧板 / 支腿） | D0 问题 #4，属"设备本体建模"，与本批的"环境道具"是两件事 | D4 或 D6 |

-----

# 第 12 节：D3 批：镜头与交互（2026-11-25）

## 12.0 本批要证明什么

进来不用教，就知道能转、能点、能回全景；切镜头不穿设备。
对应规格 §3 D3 与 §4 硬指标表第 5 / 6 / 7 条。

## 12.1 交付物

| 文件 | 内容 |
|---|---|
| `frontend/src/three/cameraPresets.ts` | 预设 3 → **5**（新增 `LINE-A1` 单产线近景、`DEVICE` 设备跟随）+ 入场起点/路径参数 + `PRESET_ORDER`（键位 1~5 与巡游序列的唯一顺序源） |
| `frontend/src/three/SceneRoot.tsx` | 入场 3 s 球面环绕、预设切换二次贝塞尔缓动（中点抬高防擦机身）、巡游模式（6 s/站、手动操作即退）、键位 `1`~`5` / `R` / `P`、`__sceneDebug` 增补（`lastTransitionMs` / `transitionSeq` / `presets` / `deviceBoxes` / `deviceAnchors` / `tour`） |
| `frontend/src/pages/Overview.tsx` | 侧栏设备详情卡（实时快照四项指标 + 查看监控页按钮）、巡游按钮；三维点击不再跳转监控页（偏差 D-55） |
| `frontend/src/styles/global.css` | `.viewport__tour` 巡游角标、`.device-detail` 详情卡样式（纯 DOM，不占 draw call） |
| `frontend/src/three/cameraPresets.test.ts` | 5 条预设约束单测（数量/顺序/轨道限制/DEVICE 位姿一致性/入场起点） |
| `frontend/src/three/layout.ts` | `deviceTypeOf` / `deviceBox`（由 ID 推包围盒，供脚本断言穿模） |
| `scripts/acceptance-d3.mjs` | 11 项验收 |
| `scripts/acceptance-batch2.mjs` | 10.2-6 断言按 D-55 改写（点击 → 详情卡，不再跳转） |

## 12.2 验收原文（`output/logs/d3_acceptance.log`，与最终代码同一次运行）

```text
PASS  入场时长 3.0±0.2 s  · 3003.6999999284744 ms
PASS  入场终点位姿 = overview 预设（绕到了总览，不是半路停住）  · 0.0,40.0,48.0
PASS  预设数量 = 5  · overview / WS-A / WS-B / LINE-A1 / DEVICE
PASS  14 台点击命中 100%  · 14 / 14
PASS  预设切换 ≤ 1200 ms（20 个有序对）  · 最大 1004.6999999284744 ms (overview→WS-B)
PASS  切换过程不穿设备  · 采样 121 次, 相交 0
PASS  巡游一圈不重复不跳位  · 6 站: overview → WS-A → WS-B → LINE-A1 → DEVICE → overview
PASS  鼠标点击立即退出巡游  · 已退出
PASS  场景 draw call ≤ 100（D2 预算守卫）  · 实际 78
PASS  fps 中位 ≥ 50  · 实际 144.9
PASS  全程无页面运行时异常  · 0 条

合计 11 项，通过 11，失败 0
```

要点说明：

- **入场**是球面插值（方位角 -72°→0°、半径 62→48、高 60→40），不是直线瞬移；`lastTransitionMs` 记录的是实际耗时，冷启动实测 3003.7 ms，落在 2800~3200 ms 判定带内。
- **切换 ≤1200 ms**：20 个有序对全测，最大 1004.7 ms——计划时长 1000 ms + 一帧的量化误差，没有超差风险。
- **不穿设备**：取三条最易擦机身的路径（overview→DEVICE、WS-A→DEVICE、LINE-A1→WS-B），每 50 ms 采一次相机位置，与 14 台设备包围盒（外扩 0.4 m）求交，121 个采样点相交 0。防擦机身靠的是贝塞尔中点抬高（≤10 m），不是碰运气。
- **巡游**：5 预设循环 + 回卷 = 6 站（与规格 §5.4 预期输出的「6 站」一致）；鼠标按下立即退出（规格点名的风险 ②）。
- **draw call 77 → 78 的原因已实测**：干净加载（无任何点击）读 `profile()` 得 sceneCalls = **77**，与 D2 完全一致（147 = 77 场景 + 53 阴影 + 17 后处理）；验收读到 78 是因为脚本先点了 14 台设备、巡游退出点击又选中了画面中央的设备，**选中描边**多 1 次 draw call。是交互状态不是场景增量，预算判定（≤100）不受影响，D-52 余量仍为 23 次。

## 12.3 截图为证（真看过，不是只查文件存在）

| 图 | 文件 | 能看到什么 |
|---|---|---|
| 点击详情 | `output/d3/click_detail.png` | CNC-01 推近特写（护栏/基座/传送带同框，无穿模），右侧详情卡：CNC-01 数控机床 1、温度 61.1 ℃ / 振动 2.064 mm/s / 电流 6.9 A / 转速 1376 rpm、查看监控页按钮 |
| 巡游角标 | `output/d3/tour_badge.png` | 左上角「巡游中 · 第 1/5 站 · 按 P 或点击画面退出」，不遮挡右上角预设按钮；预设按钮排 5 + 巡游 + 重置视角齐全 |

初版角标放画面顶部居中，实拍发现压住了「总览 / WS-A」按钮，已移到左上角（这就是 §12.3 存在的理由：截图必须真看图）。

## 12.4 本批发现并修复的问题（3 个，全部有实测证据）

1. **验收脚本第一版 14 台只命中 6 台**——不是场景问题，是脚本把 14 个投影坐标算一次就连点，而每次点击后相机都推近了，后续点全落在旧画面上。改为「每台先回总览、重算投影再点」（规格本来就指定测总览机位），14/14。
2. **DEVICE 预设带着残留选中跑偏**——点击阶段选中的 PUMP-01 残留，`setPreset('DEVICE')` 落到 PUMP-01 特写而非静态位姿，切换对超时。切换阶段前先清选中。这暴露了 DEVICE 语义：「跟随选中设备」本身是对的（规格问答原文），脚本必须按语义测。
3. **用耗时变化判断过渡完成不可靠**——两次过渡耗时在帧量化下可能恰好相等（WS-A→WS-B 那次挂在这），`__sceneDebug.camera()` 增加 `transitionSeq` 单调计数，脚本改为等计数变化 + 终点位姿双重确认。

## 12.5 无回归

```text
cd frontend && npx tsc --noEmit          → 0 error
cd frontend && npm run test -- --run     → 11 files / 101 tests passed（新增 5 条预设约束）
node scripts/acceptance-batch2.mjs       → 24/24（10.2-6 已按 D-55 改写）
node scripts/acceptance-d1.mjs           → 9/9
node scripts/acceptance-d2.mjs           → 19/19
```

## 12.6 未做 / 未验证

| 项 | 原因 | 何时做 |
|---|---|---|
| D2 盲测（3 人） | 仍是 D2 遗留的人工项，与本批无关 | 由作者组织，记回 §11.8 |
| 真实人手的「手感」判断（缓动快慢、巡游节奏是否舒服） | 脚本只能断言 ≤1200 ms 与 6 s/站，观感需作者真人过一遍 | D6 录屏评审时一并看 |
| 弱机 / 生产构建下的入场与切换时长 | 本批数字全部来自 dev（`__sceneDebug` 只在 dev 存在，D-44 口径） | D6 统一协议 |

-----

# 第 13 节：产线完整化 + 四工况 + 环境层（作者 2026-11-25 追加）

## 13.0 本批要证明什么

三条：① 任取一条线，画面从「上料 → 加工 → 搬运 → 输送/检测 → 下料」连续贯通，中间没有无解释的空地；
② 四条线的物料密度、颜色、运动状态肉眼可辨地不同，且不同相；③ 厂房有室内感（柱/桁架/灯带/地坪/桥架/纵深），
而 draw call 仍 ≤100、帧率不低于本批前。

## 13.1 每条线补了什么、为什么（一句话版）

| 线 | 上游补 | 下游补 | 为什么 |
|---|---|---|---|
| LINE-A1 | 三层上料架（4 箱）+ 托盘堆（2 箱） | 检测工位台 + 下料滑台 | A 线末端是 CONV，料下线后必须有"检验 → 下料"两个动作，否则传送带尽头是断的 |
| LINE-A2 | 三层上料架（2 箱）+ 托盘堆（空） | 检测工位台 + 下料滑台 | 同上；托盘只摆空板，对应"轻微堵料、上料节奏被打断" |
| LINE-B1 | 三层上料架（1 箱）+ 托盘堆（空） | 3.0 m 短传送带段 + 侧向下料滑台 | B 线末端是 INSP，检测完要"送出工位"，短带 + 侧滑台就是这个出口；检修锥/工具车/「维修中」挂在这条线上 |
| LINE-B2 | 三层上料架（空架）+ 空托盘堆 | 3.0 m 短传送带段 + 侧向下料滑台 | 换型待料 = 架子还在、料没上：空架 + 空托盘是这条线最直接的语义 |

> B 线短传送带取 3.0 m 而不是 3~4 m：色带终点 x=34、车间内墙 x=37，扣墙厚只剩 3 m（记偏差 D-57）。

## 13.2 四工况（差异必须写在数据里，不靠调参）

| 线 | 工况 | 料数 | 物料色 | 带速 | 停顿 | 设备状态（视觉覆盖） |
|---|---|---|---|---|---|---|
| LINE-A1 | 满负荷 | **9** | `#9fb2c4` 冷灰蓝 | 2.40 m/s | 0.25 s | 三台 RUNNING（保证"运动流畅"） |
| LINE-A2 | 轻微堵料 | **8** | `#bd8a52` 暖褐 | 1.80 m/s | 0.30 s | ROB-02 ALARM → 闸门关 → 队列堆 3 件 |
| LINE-B1 | 检修中 | **6** | `#7b838d` 灰 | **0** | 0.30 s | 三台 MAINTENANCE，整线冻结 |
| LINE-B2 | 换型待料 | **5** | `#c6d3e2` 浅白 | 0.84 m/s | 0.30 s | 三台 IDLE（黄），料稀疏 |

四条线的纹路初相位由各自种子决定（实测 -33.98 / -33.14 / 6.22 / 6.93），不会同步起步。

**边界（必须一起引用）**：三维按工况着色，页面右侧设备列表与 KPI 仍是真实 WS 数据。
两者不一致是**有意为之**（演示需要四种可辨工况），视口左下角常驻「三维演示工况 · LINE-A1 满负荷 …」角标。
为什么 A1 也要覆盖：真实数据里 CNC-01 一旦告警，A1 会被闸住、堆料，演示时看着像卡死（实拍验证过）——所以四条线统一由工况表着色，想看真实状态看列表。

## 13.3 验收原文（`output/logs/env_acceptance.log`）

```text
PASS  环境层类别 ≥ 9  · columns, trusses, light-strips, floor-paint, cable-tray, office,
                        outer-racks, sign-posts, safety, inspection-table, unload-slide,
                        short-conveyor, maintenance-kit, feeder-rack, pallet-stack
PASS  环境层合并组 ≤ 6  · matte×1 metal×1 paint×1 emissive×1 glass×1 labels×1
PASS  场景 draw call ≤ 100（总览机位）  · 84 场景 + 54 阴影 + 17 后处理 = 155
PASS  fps 中位 ≥ 50  · 实际 144.9（本批前基线 144.9）
PASS  四条线四种工况  · LINE-A1:满负荷 · LINE-A2:轻微堵料 · LINE-B1:检修中 · LINE-B2:换型待料
PASS  工况的 itemTint / itemCount / speedFactor 四条线两两不同   · 9/8/6/5、1/0.75/0/0.35
PASS  A1 满负荷：全速且通畅  · speed=2.4 running=true
PASS  A2 轻微堵料：被 ROB-02 闸住  · blockedBy=ROB-02
PASS  B1 检修：带速 0 且停住  · speed=0 running=false
PASS  B2 换型待料：慢速且在线稀疏  · speed=0.84
PASS  四条线料数各不相同  · LINE-A1=9 LINE-A2=8 LINE-B1=6 LINE-B2=5
PASS  四条线纹路相位不同（禁止同步起步）  · -33.98 / -33.14 / 6.22 / 6.93
PASS  物料偏转 ≤±2°、错位 ≤10% 料距  · 全部合规
PASS  每条线的物料都不在一条直线上（确有抖动）  · A1 dx=-0.11 / A2 -0.06 / B1 0.15 / B2 -0.21
PASS  B1 全部物料速度为 0（停住而不是慢放）  · velocities=0,0,0,0,0,0
PASS  A1 物料有速度记录（动力学在跑，不是瞬移）  · velocities=1.78,1.73,1.70,2.06…
PASS  01_overview / 02_a1_full / 03_b1_maintenance / 04_b2_changeover 非空白（亮度 25.3~28.3）
PASS  全程无页面运行时异常  · 0 条
合计 23 项，通过 23，失败 0
```

## 13.4 draw call 与帧率：前后对比

同一台机、同一机位（总览 `[0,40,48] → [0,0,0]`）、同一口径（`profile()` 原子读四项）：

| 指标 | 本批前（D3 收尾） | 本批后 | 变化 | 上限 |
|---|---|---|---|---|
| 场景 draw call | 77 | **84** | +7 | ≤100 |
| 阴影 pass | 53 | 54 | +1 | — |
| 后处理 pass | 17 | 17 | 0 | ≤20 |
| 整链合计 | 147 | **155** | +8 | 三项相加 = 总数 |
| 三角形（场景） | 13,704 | **18,518** | +4,814 | — |
| fps 中位（5 s rAF） | 144.9 | **144.9** | 0 | ≥50（顶 144 Hz 屏上限） |

口径说明：+7 里能确定的 6 次是环境层六个合并组，−1 是围墙整组合并体被移除；剩下 1 次的差异来自
`breakdown()` 里 49 个无名前缀的机身部件在同一机位下的可见集合（逐件归因的成本高于收益，如实记录不硬凑）。
有设备被选中时实测 85（选中描边 +1），干净加载是 84。

**为什么没超**：环境层全部走「顶点色 + 按材质合并」，15 类道具/结构只占 6 次绘制；
道具量（柱子 22、桁架杆件 130+、灯带 5、地坪涂装 20+、桥架/立牌/安全件/产线补齐件 100+）全部是几何量，不是 draw call 量。

## 13.5 环境层清单（按作者给的优先级）

| 优先级 | 落地内容 | 落在哪 |
|---|---|---|
| 1 | 柱子 22 根（车间周边 20 + 中线 2）、屋顶桁架 10 榀（上下弦 + 110 根腹杆 + 10 道檩条）、顶部灯带 5 道 | `envLayout.buildColumns/buildTrusses/buildLightStrips` |
| 2 | 地坪涂装：中央人行道（压暗的绿）、两侧黄线、两道斑马线（各 7 条）、14 块工位编号 + 4 块产线名牌 | `buildFloorPaint/buildStationLabels` |
| 3 | 桥架：沿车间南北内墙各 1 道（共 4 段）+ 每条线 1 根短支线（4 根） | `buildCableRuns` |
| 4 | 玻璃隔断办公室 13×7.5×3.2（玻璃单独一组）+ 6 处托盘堆 + 2 处货架 + 叉车 | `buildOffice/buildOuterProps` |
| 5 | 灭火器 6 具、废料箱 4 只、落地标识立牌 5 座（围墙移除后不再悬空）、B1 警戒锥 6 个 + 工具车 + 「维修中」标签 | `buildSafetyItems/buildSignPosts/buildLineProps` |

## 13.6 本批修掉的问题（都是真看图和真跑数发现的）

1. **A1 满负荷被真实告警闸住**——第一版 A1 不覆盖设备状态，实拍时 CNC-01 恰好告警，A1 在机前堆料、看着像卡死。改成 A1 也由工况表着色（偏差 D-59）。
2. **A2 的堵点看不见**——堵在 CNC-02 时闸门坐标 x=-33.8 紧贴色带起点，队列几乎全在带外。改堵 ROB-02（闸门 -27.2），队列 3 件（-27.2/-30.2/-33.2）全在带内。
3. **B1 停住但没有"停线现场"**——带速 0 时物料永远不会自己走到机前。给 B1 加"停机快照"初始位（`initialOffsets`），画面才有料停在 CNC 出口与 ROB 闸门前。
4. **地面编号被横向拉宽 3 倍**——图集单元是正方形、牌面是 3:1。图集改成 256×80 单元，牌面 1.6×0.5，字正了。
5. **通道绿漆像草坪**——0x1b3a2c 太艳，压暗到 0x18241c。
6. **中线柱挡产线**——z=±9 的两根离产线只有 1.5 m，斜侧机位正挡住半条线，只留 z=0 一根（偏差 D-58）。
7. **警戒锥做成了圆柱**——`cyl` 上下同径，加 `cone` 形状（底 0.16 / 顶 0.03）。
8. **围墙与管道**（作者直接提出）：围墙 12 面全删（车间 8 + 动力站 4），管道 12 根减到 6 根（每车间 1 主管 + 2 立管），桥架从产线上方改沿墙（偏差 D-57）。
9. **门架/立牌悬空**——围墙删掉后墙上的 5 块标识无处依附，补了 10 根落地立柱。

## 13.7 无回归

```text
cd frontend && npx tsc --noEmit          → 0 error
cd frontend && npm run test -- --run     → 13 files / 126 tests passed（新增 21 条）
node scripts/acceptance-env.mjs          → 23/23
node scripts/acceptance-motion.mjs       → 17/17（改为工况感知：冻结线不参与排队断言、纹路按本线带速）
node scripts/acceptance-batch2.mjs       → 24/24
node scripts/acceptance-d1.mjs           → 9/9（雾断言同步为 26~110 / #16202c）
node scripts/acceptance-d2.mjs           → 19/19
node scripts/acceptance-d3.mjs           → 11/11
```

## 13.8 本批没做 / 边界

| 项 | 原因 |
|---|---|
| 粒子（火花 / 冷却液雾）与旋转光斑 | 规格 D4 的剩余部分；本批重点是产线与环境层，粒子留到下一批（预算余量 16 次） |
| §7.2 的 CONV `speed` → 带速数据连接 | 与"四工况固定带速"冲突：真实 CONV speed 可能是 0，A1 就不叫满负荷了。留到作者决定口径后再做（偏差 D-59） |
| 三维与列表的一致性 | 有意不一致，视口有角标说明（D-59） |
| 盲测（D2 遗留） | 仍需真人，脚本不代替 |

-----

# 第 14 节：背景改白底 + 去雾（作者 2026-11-25 第三次追加）

## 14.0 为什么单独记一节

作者在同一批里连提三次背景问题：先给两个色值做渐变，然后「背景颜色不要黑色的，换成亮一点的颜色」，
最后「不要迷雾，把背景颜色换成白色」。三次都不是审美口味，而是**前两版都没生效**——
查下来是 ACES 色调映射把近黑区压到了 0，填什么深色都是黑。这节记的是这个坑和最终口径。

## 14.1 根因：ACES 把近黑压成 0（不是配色问题）

整帧要过 `OutputPass` 的 `ACESFilmicToneMapping`（曝光 1.05），ACES 在近黑区斜率远小于 1：

| 填进贴图 | ACES 后屏幕实测 |
|---|---|
| `#0a0f16`（作者最初给的顶部色） | `#000102` |
| `#16202c`（最初给的中段色） | `#03070f` |
| `#0d1319`（最初给的底部色） | `#010203` |

所以「背景是黑的」与色值无关，深浅都救不回来——必须按显示色反解，或把值推到 HDR 空间。

## 14.2 最终口径

| 项 | 值 | 说明 |
|---|---|---|
| 雾 | **移除**（`scene.fog = null`） | 作者明确「不要迷雾」。远景不再淡出，靠白底与阴影拉层次 |
| 背景 | 纯白贴图 + `scene.backgroundIntensity = 3.0` | 屏幕实测 `#f8f8f8` |
| 清屏色 / `.viewport` 底色 | `#ffffff` | 圆角裁切与首帧不露深色 |
| bloom 阈值 | `0.85` → **`3.2`** | 白底线性 3.0，阈值低于它整屏蒙白光——那层白光就是"雾感" |
| 覆盖层文字 | 深色 `#47566a`；预设按钮改半透明白底 + 深色字 | 白底上原 ghost 样式（浅灰字）读不清 |

**为什么不用 `scene.background = new THREE.Color(0xffffff)`**：
Color 背景走 `gl.clearColor`，值被夹在 [0,1]；线性 1.0 过 ACES 后只有 `#d1d1d1`（浅灰）。
贴图背景才有 `backgroundIntensity` 可推过 1 —— 实测 1.0 → `#d1d1d1`，2.0 → `#e9e9e9`，3.0 → `#f1f1f1`。

## 14.3 验证（ACES 正算 + 截图取像素，两条独立路径）

```text
# 单测（frontend/src/three/sky.test.ts，131 条里新增 5 条）
贴着 intensity=1 只有 #d1d1d1                    PASS
按 SKY_INTENSITY=3.0 推亮后 ≥ #ee                  PASS
bloomThreshold(3.2) > SKY_INTENSITY(3.0)，白底不泛光  PASS

# 截图取像素（output/env/white_overview.png）
画布左上 / 右上 / 顶部中 / 左中：均为 #f8f8f8（16 处采样一致，无渐变残留、无横向色带）
```

## 14.4 无回归

```text
cd frontend && npx tsc --noEmit          → 0 error
cd frontend && npm run test -- --run     → 14 files / 131 tests passed
node scripts/acceptance-d1.mjs           → 9/9（"雾参数对不对"改为"雾确实没了"；bloom 阈值 3.2）
node scripts/acceptance-env.mjs          → 23/23（draw call 仍 84，fps 144.9）
node scripts/acceptance-motion.mjs       → 17/17
node scripts/acceptance-batch2.mjs       → 24/24
node scripts/acceptance-d2.mjs           → 19/19
node scripts/acceptance-d3.mjs           → 11/11
```

draw call 与帧率不受影响：背景本来就是一次贴图平面，改成白底不增加绘制体（84 / 54 / 17 = 155，fps 144.9）。
四张交付截图的平均亮度从 25.3~28.3 升到 38.8~59.6（白底带来的，属预期）。

## 14.5 已知取舍

| 项 | 现状 | 如果要改 |
|---|---|---|
| bloom 实质不触发 | 阈值 3.2 高于场景内所有发光体（线性 <1），灯带不再有辉光 | 需要辉光时：把灯带材质改成 HDR（emissiveIntensity > 3.2），别把阈值调回去（会让白底泛白） |
| 白底与深色 UI 的反差 | 画布纯白、外壳深色，观感偏"产品图" | 若要整套浅色主题，属于 D5 界面层的范围，本批不动 |
| 场景内部偏暗 | 去掉雾后远景不再被提亮，暗部更实 | 需要提亮就调光照/环境光，不要加回雾（作者已明确不要） |

-----

# 第 15 节：D 批 R1 —— 车间室内化（作者 2026-11-25 追加，v0.4-indoor）

完整明细（改了什么 / 数字阶梯 / 截图路径 / 未做项）在 **`docs/acceptance_phase4_d.md`**，本节是验收口径的收口。代码提交 `ffea59c`，文档 `034b55e`。

## 15.1 交付口径

| 项 | 值 |
|---|---|
| 室内壳 | 四面外墙 8m×0.25 + 踢脚线 0.8m + 包柱 0.4×0.4 + 南墙 6×4.5 卷帘门洞 + 东西墙各 3 个 2×1.5 高窗洞（0.12 窗框+玻璃）+ 桁架每 6m 一榀 + 灯带 5 道；全部顶点色并入既有 6 组，**不新增材质/draw call**（`envInterior.ts`） |
| 相机 | `maxDistance` 90→72；overview `[0,40,48]`→`[0,36,46]`；LINE-A1 → 车间内平视 `[-15,3,-1]`（偏差 D-64）；入场起点/路径同步收敛 |
| 补光 | hemi(#9fb2c4,#1f2b3a) 1.15 + 天窗两盏 1.35/0.9，均不投影（偏差 D-65：作者给的 0.55 档实测只 +6.4%） |
| 室外剖切 | 相机在某车间某侧室外时该侧墙整组退化（合并索引写 0，阴影共用索引；偏差 D-66） |

## 15.2 验收数字（2026-11-25 实测）

```text
亮度阶梯（overview 机位截图平均亮度）：
  改前（无围墙，[0,40,48]）        94.2
  有墙、补光=0（[0,36,46]）        79.11
  补光 0.55 档                     84.2（+6.4%，不达标）
  最终 1.15/1.35/0.9 + 剖切        89.7（+13.4%，达标 10~20%）
draw call：scene 84 / shadow 54 / post 17 = 155（与改前一致）
三角面 21,470；fps 144.2
单测 153 条全过；回归 d1 9/9、env 23/23、motion 17/17、batch2 24/24、d2 19/19、d3 11/11
截图：output/d_batch/（before_overview / compare_overview / r2_overview / r2_WS-A / r2_WS-B / r2_LINE-A1 / r2_DEVICE / r2_topdown）
```

## 15.3 遗留（等作者表态）

① 顶部按规格不铺屋面板，平视/仰视会从桁架间看到白背景；② LINE-A1 前景地面偏暗；③ 高窗玻璃透出的白背景在深色墙上是亮斑。


-----

# 第 18 节：R1.6 补场景密度（作者 2026-11-26 追加，v0.4-density；**已于同日回退，见 §18.6**）

## 18.1 改了什么

| 层 | 内容 |
|---|---|
| 数据 | `propLayout.ts` 新增 `buildDensityProps(): EnvPart[]`（纯数据、不 import three、可单测）；`densityColor()` 做饱和度 ×0.85 / 明度 ×0.9 |
| 实例化 | 配电柜 / 托盘堆 / 周转箱堆 / 气瓶四类各一个 `InstancedMesh`（作者指定）：单位几何 + 逐实例缩放/`instanceColor`，**复用 matte 材质**（白顶点色打底），不新增材质；不投阴影（保住阴影 pass 开销） |
| 合并 | 其余密度件（货架/工具车/消防柜/管廊/WIP 料架/卷料架/天车轨道）按顶点色并入既有 matte 组 |
| 拾取遮挡 | `SceneRoot.pick()` 把 `envRoot` 与设备组一起交给 raycaster，**最近命中决定结果**：装饰件挡住的射线不再透到设备（这是「点装饰件 0 弹卡」的完整语义——只把 env 排除出白名单挡不住"隔着装饰件点设备"）；光标改为无条件写 `default/pointer`（原来只在 id 变化时写，首帧悬停装饰件时 cursor 一直 auto） |
| 预算断言 | `acceptance-env.mjs` 的 `ENV_GROUP_BUDGET` 6→10（6 合并组 + 4 实例化网格） |

## 18.2 每车间可辨识物体清单（6 设备 + 47 密度件 = 53 ≥ 22）

| 层 | 物件 | 数量 |
|---|---|---|
| 设备 | CNC×2 + ROB×2 + CONV×2（两条线） | 6 |
| 贴墙层 | 配电柜（0.9×0.6×2.0，间距 1.2，北墙） | 6 |
| 贴墙层 | 备件货架（3.0×0.8×2.4，南墙门两侧） | 4 |
| 贴墙层 | 工具车（东西墙各一） | 2 |
| 贴墙层 | 气瓶架（4 瓶，东墙） | 1 |
| 贴墙层 | 消防柜（北墙两端） | 2 |
| 贴墙层 | 管廊 2 条通长（y=5.5，2 管 + 5 支架） | 2 |
| 物料层 | 在制品料架（每线 2，z=±12.5） | 4 |
| 物料层 | 托盘堆（3~5 层，实例化） | 12 |
| 物料层 | 周转箱堆（实例化） | 8 |
| 物料层 | 卷料立架（南墙中段） | 2 |
| 纵深层 | 桥式起重机（2 工字钢轨道 y=7.0 + 2 天车小车） | 4 |

## 18.3 五条铁律（全部进单测 `propLayout.density.test.ts`，179 条全过）

1. 贴墙 1.5m 内：每车间 ≥40 个贴墙件（实测 42），且有"高件必须贴墙"的反向守卫；
2. 与 `deviceFootprints()`（含基座外扩 0.5）零相交；
3. 中央通道 `|x|<2` 或 `|z|<2` 零侵入；
4. 高度 ≤6m（天车轨道/小车豁免，且 ≤7.9m 断言）；
5. 距产线 3m 内物件高度 ≤1.5m（气瓶架因此从 1.5m 柜体压到 1.44m）。

额外守卫：与既有道具（墙脚线槽/护栏/上料架/线头托盘堆/角落货架/下游工位台/短传送带/B1 检修件）零 2D 相交——架空件（管廊 y5.5、天车 y7）按"底面高于 3m"豁免。

## 18.4 实测数字（2026-11-26）

```text
profile：scene 61 / shadow 27 / post 17 = 105 calls（增量 +4 = 4 个实例化网格，≤6 ✓）
三角面 36,122（增量 +3,212，总量 ≤50k ✓）；fps 144.4（遮挡 raycast 无感）
装饰件点击 30 次（≥20）：详情卡 0 次 ✓，光标全部 default ✓
设备点击 14/14：详情卡全部正常弹出 ✓
单测 179 全过（新增 12 条）
回归：d1 9/9、env 23/23、motion 17/17、d2 19/19、d3 11/11、device 54/54；
batch2 20/24 —— 4 项失败为生产页"统计窗口无已完工订单"的数据空态 + 一次告警注入 422，
与本批无关（本批只动 three/ 环境层，见 §13 色调批的同一说明）。
截图：output/d_batch/dens_overview.png / dens_WALK.png / dens_AISLE.png / dens_WS-A.png / dens_DEVICE.png
```

## 18.5 已知取舍

- 环境层参与拾取后，pointermove 每次要做一次全场合并网格的 raycast（~36k 三角、无 BVH），节流 80ms 下实测 fps 144.4 无感；若未来卡顿，引入 three-mesh-bvh 即可。
- 隔着玻璃办公室看设备时，玻璃面会先命中（设备仍可点击，因为玻璃与设备不相交的视角下设备更近）；实拍未发现误挡。

## 18.6 回退（作者 2026-11-26 11:26 要求）

作者原话：「把之前对话阶段我让你补充场景密度的很多显示装置去掉，其它的不要动」。§18.1~18.5 的**代码已全部撤出**，本节保留作为历史记录（原判断并非实现错误，而是作者看过实际效果后不需要这些装饰件）。

| 撤掉了什么 | 怎么撤的 |
|---|---|
| `propLayout.buildDensityProps()` 及 `densityColor` / `DENSITY_BASE_COLORS` / `DENSITY_UNIT_SHAPE` / `WALL_FACE_*` / `TRAY_Z` / `COLUMN_OFFSET`（47 件/车间） | `propLayout.ts` 整文件回到 `4502540^` |
| `EnvPart.inst` 标记、`buildDensityProps()` 调用、`'density-props'` 类别 | `envLayout.ts` 回到 `4502540^` |
| 4 个 InstancedMesh 聚合块、`instancedMeshList` 释放、`drawables` 的 `'instanced'` 分支 | `envBuilder.ts` 回到 `4502540^` |
| `ENV_GROUP_BUDGET` 10 → 6 | `scripts/acceptance-env.mjs` 回到 `4502540^` |
| 12 条密度铁律单测 | 删除 `propLayout.density.test.ts` |

**保留未动**（不属于"显示装置"，是拾取正确性修复，删掉反而会退化）：

- `SceneRoot.pick()` 把 `envRoot` 与设备组一起进 raycaster —— 墙/柱在设备前面时不再"透过去误弹卡"；
- 光标无条件写 `pointer / grab`（原来只在 id 变化时写，首帧会卡在 `auto`）。

回退后实测（2026-11-26 11:30）：

```text
profile：scene 57 / shadow 27 / post 17 = 101 calls（密度批为 105，−4 个实例化网格）
三角面 33,210（密度批 36,122，−2,912）；fps 144.9
单测 167 全过（179 − 12 条密度用例）；tsc -b 0 error
env 23/23（合并组回到 6、环境层类别回到 9 类非密度口径）
d1 9/9 · d3 11/11（7 预设、8 站巡游、14 台命中 100%）· device 54/54
截图：output/env-after-revert/01_overview.png（靠墙层/物料层/天车均已消失，墙柱/产线/标线完整）
```

`v0.4-density` 标签仍指向 `4502540`，保留为"密度批曾有过的样子"，不删不改。

-----

# 第 19 节：AI 页改「工厂日报」（D-74，2026-11-26）

## 19.1 为什么改

原 /ai 页的主角是模型指标（PR-AUC、召回、混淆矩阵、四模型对比）。它回答的是「模型好不好」，
但作者要的是「**今天哪里要管、不管会损失多少**」。指标不是没用，而是不该占首屏——所以整页重排，
指标降级为折叠区的证据链，默认不出现。

| 层 | 内容 |
|---|---|
| 1 结论条 | 一句话建议 + 高风险设备数 / 预计影响件数 / 建议处理时限 |
| 2 待办清单 | 只列需要动作的设备，按影响件数降序、最多 5 行；列：设备 / 产线 / 现象 / 预计影响件数 / 建议动作 |
| 3 交付风险 | 在制订单按当前节拍外推，与 planned_end 比较，只列未来 8 小时内会延期的单 |
| 4 本月损失账 | 异常次数（去重）/ 影响产量 / 不良件数 / 折合金额；单价 ≤0 时显示「未配置单价」 |
| 5 折叠区 | `<details>` 默认收起：4 张模型指标卡 + 混淆矩阵 + 四模型对比 + 分数曲线 + 真值三卡/甘特/对比/列表 |
| 页底 | 公式与数据来源（8 条），以及全部假设系数 |

## 19.2 计算口径（与页面底部公式区逐条对应）

| 量 | 算式 | 来源 |
|---|---|---|
| 节拍 | 该线最新订单 planned_quantity ÷ (planned_end − planned_start)；取不到用 config | /orders、/report/config |
| 异常持续分钟 | 真值区间 ended_at − started_at（无区间时退回最后一段连续异常点） | /ml/anomaly/scores → intervals |
| 峰值 | 该区间内 points[].score 的最大值 | /ml/anomaly/scores → points |
| 风险分 | 峰值 × 异常持续分钟 | 上两行 |
| 预计影响件数 | round((异常持续分钟 + 处置分钟) × 节拍 × 降速比例) | /report/config → anomaly_handling |
| 建议动作 | 影响 >15 停机；5~15 今日下班后；<5 继续观察 | /report/config → action_thresholds |
| 外推完成时间 | 现在 + 剩余件数 ÷ (计划节拍 × (1 − 该线最严重降速)) | /orders、/report/config |
| 本月影响产量 | Σ 真值区间分钟 × 节拍 × 降速；不良 = 影响产量 × 不良率；金额 = 不良 × 单价 | /anomalies、/report/config |

系数全部在 `config/report.json`：单价 850 元/件、不良率 3%、每线 0.5 件/分、
处置时长（温度 45 / 振动 60 / 电流 30 分钟）、降速（25% / 50% / 35%）、
分档 15/5、风险分高风险线 3、巡检窗口 120 分钟、交付视界 8 小时。
**全部标注为假设值**，页面页脚与卡片 delta 都写了，不冒充实测财务数据。

## 19.3 三个实现判断（都不是随手写的）

1. **异常持续时长优先用真值区间，不用模型连续判真点。** 模型是逐点阈值判定，一次 90 秒的注入
   常常只判出 1~2 个孤立点（实测 CONV-01 最后一段只有 1 个点 → 持续 2 秒 → 影响 0.03 分钟），
   拿它算时长会让风险分永远趋近 0、页面永远「无需停机」。改用真值区间起止当时长，峰值仍取
   区间内的模型分数，「峰值 × 持续时长」两个因子都真实。区间内没有模型点时**不采用**该区间，
   换下一段或退回模型连续点——不猜。
2. **影响件数的「时长」含预计处置时长。** 只用异常持续会得出 0.5 件这种没有决策意义的数；
   处置本身也在占产能。口径写在页面公式区第 4 条。
3. **损失账按「设备 + 类型 + 开始时刻」去重。** 实测库里同一次注入被写两遍（id 1162/1163
   字段完全一致），不去重会把次数与产量整体放大一倍。
4. **现象取区间内峰值，不取此刻读数。** 异常往往发生在十几分钟前，拿当前值会写出
   「振动 1.69 mm/s，正常上限 2.5 mm/s」这种自相矛盾的描述。峰值由
   `/devices/{id}/telemetry` 在异常区间内取 max 得到。

## 19.4 实测（2026-11-26 13:20 前后快照）

```text
页面默认可见区块：conclusion / todo / delivery / loss（恰好 4 块），[data-ml-metric] = 0
结论条：1 台高风险 · 预计影响 49 件 · 建议处理时限 ≤ 8 h
待办 5 行（影响件数）：15 / 15 / 7 / 6 / 6 —— 逐行复算 5/5 一致
  例：round((0.67 + 60) × 0.5 × 0.5) = 15
交付风险 3 单：延期 2.8 h / 2.8 h / 0.7 h
损失账：954 次异常（去重后）/ 影响产量 504 件 / 不良 15 件 / ¥12,750
acceptance-ai.mjs：54/54（含单价改 0 → 「未配置单价」、折叠区展开后指标与接口逐项一致）
单测：17 文件 / 185 passed（dailyReport 18 条）；tsc -b 0 error
pytest：28 passed
回归：batch2 24/24（AI 页断言已按新 IA 更新）、d3 11/11、env 23/23、device 54/54
```

截图：`output/report_full.png`（整页默认态）、`output/report_acceptance.png`（验收后收起态）。

## 19.5 已知取舍

- **短注入 + 长处置导致「立即停机」很少触发。** 演示数据里注入区间多为 40 秒~7 分钟，
  VIB 类 15 件刚好卡在「>15 才停机」的边界上，所以待办多为「今日下班后处理」。
  这不是 bug，是节拍 0.5 件/分与阈值 15 件的组合结果；要看到停机档，把 config 的
  `action_thresholds.stop` 调小或在注入器里加长区间即可。
- **本月损失账的节拍用「当前订单」反推。** 历史月份的订单已结算，接口只保留最近 200 条，
  用当前订单反推更接近本线产能；若某线彻底没有订单，会退回 config 假设值并在页脚注明。
- **`app/` 冻结的唯一例外**：新增只读 `GET /report/config`。不加这个接口，单价与节拍
  就只能写死在前端，直接违反「不允许前端硬编码系数」。
- **待办只算前 6 台有异常的设备**（按窗口内异常条数排序）。14 台各发一次实时推理会让首屏多等
  数秒；6 台并发实测 1 秒内完成。超过 6 台时页面不报错，只是最不可能有动作的几台不进待办
  ——若将来需要全量，应该做后端聚合而不是加并发。

-----

# 第 20 节：批 1「光影与材质」（D-76，2026-11-26）

## 20.1 起因与顺序判断

作者对建模效果不满意，要求「厂房体积更大、器材更真实」，路线选定：厂房放大 + GLB 真模型（Blender 参数化生成），
但**第一批先做光影材质**。这条顺序不是随手排的：先精修几何，在平光下仍然像塑料；先把光与材质做对，
后面加几何才有意义，而且 IBL / 环境遮蔽对将来的 GLB 同样有效，不会白做。

## 20.2 三个比几何更致命的缺陷（本轮实测发现）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | 车间地面是一块均匀浅灰板，没有颗粒、不接影子 | 车间地坪铺的是 `pave`（`MeshBasicMaterial`，不受光），压在带贴图的 `floor` 之上 4 mm，把贴图/粗糙度/反射/接收阴影全盖掉 | 车间改用 `materials.floor`，并按面积缩放 UV 对齐 6 m 分仓缝 |
| 2 | **车间内部一点影子都没有**，设备像贴纸 | 围护墙在 `matte` 组（`castShadow=true`），把来自上方的光全挡在墙外；剩下两盏补光 `castShadow=false` | 拆 `shell` 组（墙/踢脚/包柱，不投影）＋天窗光 1 改为投影 |
| 3 | 金属像塑料 | 没有 `scene.environment`，金属无物可反射 | 程序化环境源（HDR 灯带）＋ PMREM，见 `environment.ts` |

## 20.3 本批改动清单

- `environment.ts`（新增）：搭一个"本车间"的环境源（深青墙 + 四条 HDR 灯带 + 两侧窗带），`PMREMGenerator.fromScene` 烘成辐照度贴图。
  灯带颜色**故意超过 1.0**（线性 7.5/8/9）：第一版用 sRGB 白色，金属反射出来仍是暗环境，画面亮度 72.3 → 71.0，等于没做。
- `contactShadow.ts`（新增）：14 台设备各一片径向渐变贴片，`MultiplyBlending` 压暗地面，合并成 **1 个 mesh**。
  抬 2 cm、`depthWrite=false`、`polygonOffset` 防 z-fighting；不进 `envRoot`，所以点设备不会点到影子上。
- `materials.ts`：地面加 `roughnessMap`（底 0.88，油渍/水痕 0.25~0.45）＋ `envMapIntensity` 1.15；`deviceShell` 粗糙度 0.58→0.5。
- `envBuilder.ts` / `envLayout.ts`：新增 `shell` 组（顶点色 + 一份 Standard 材质，`castShadow=false`、`receiveShadow=true`）。
- `SceneRoot.tsx`：IBL 接入；灯光重排；天窗光 1 投影并配 `normalBias 0.03 / bias -0.0004`；`profile()` 同时开关两盏投影光，
  否则天窗光的阴影 pass 会被算进 `sceneCalls`，指标失真。
- `builders.ts`：车间地坪换受光材质。

## 20.4 实测

```text
scene draw call  57 → 59（+shell 组 +接触阴影）
shadow draw call 27 → 54（两盏投影光）
整链             101 → 130
三角             33,210 → 33,238
fps              144.9（未降）
画面平均亮度     72.29 → 67.05；暗部(<28) 3.2% → 2.4%；高光(>200) 1.2% → 1.3%
单测            185 → 186（新增「围护墙必须在 shell 组」反向守卫）
env 23/23 · d1 9/9 · d3 11/11（14 台命中 100%）· device 54/54
```

截图：`output/model-upgrade/before_overview.png`（改造前）／`after_overview.png`、`after_line.png`（改造后）。

## 20.5 作者当场否决项

**顶部桁架**：17:26 方案里我加了 192 件屋面构件（每 6 m 一榀、10 个节间），17:53 作者说「不需要添加顶部栏杆影响视线」。
已整批撤出，`roof.ts` 删除、剖切规则回退，不留死代码。结论：**顶部不加任何杆件**，
后续批 2 的体积必须靠「墙体层高、二层夹层、动力站独立体量、机位」来做，不能靠屋架。

## 20.6 已知取舍

- **阴影 pass 翻倍**（27→54）：这是"室内终于有影子"的代价。若将来掉帧，先降 `skylight1.shadow.mapSize` 到 1024。
- **接触阴影在总览距离几乎看不见**（36 m 高空俯视）。它的价值在设备特写与低机位，那里设备与地面的贴合明显更实。
- **墙面仍是纯色**：本批没做贴图，因为墙面是顶点色合并几何、没有 UV。批 2 放大厂房时一起处理（可加竖向板肋的几何细节，比贴图更抗近景）。
- **IBL 只能近似**：没有体积光，也没有屏幕空间反射。图里那种湿地面倒影目前只能到"油渍处有灯带高光"的程度。

-----

# 第 21 节：批 2a「体量——层高与围护分格」（D-77，2026-11-26）

## 21.1 为什么不是"把厂房放大"

设备只有 14 台，这是 `AGENTS.md` 锁死的项目事实。把 80×56 的厂区直接放大到 116×78，
设备占比只会更小，画面更空——参考图里的"体量感"来自**净空高度与围护节奏**，不是空地面积。
所以这一批不动平面尺寸（车间仍 34×30，设备密度不变），只做三件事：

| 项 | 前 | 后 | 依据 |
|---|---|---|---|
| 层高 | 8 m | **12 m** | 带行车/大件吊装的机加车间常规 10~14 m |
| 高窗带 | y 4.5~6，宽 2.0 | **y 7.0~9.4，宽 2.4** | 抬层高后原窗缩在墙中偏下，人视像小气窗 |
| 卷帘门高 | 4.5 m | **6 m** | 与层高匹配，门洞不再像"狗洞" |
| 灯具标高 | 7.42 m | **8.0 m + 金属外壳** | 贴 12 m 顶会成悬空白棍；8 m 是悬吊灯具常规高度 |

## 21.2 墙面分格（这一批的重点）

34 m 长 × 12 m 高的墙如果是一块整板，人视时上半幅全空，比 8 m 时更"空"——这是抬高后第一版的真实问题。
真实厂房围护是"一格墙板 + 一根露明壁柱"，重复构件本身就是尺度参照。所以加：

- 东西墙各 4 根壁柱（dz = ±12 / ±4），南北墙各 4 根（dx = ±13 / ±8.5）
- 10.2 m 一圈腰线（0.25 高），把墙面分成"下部大板 + 上部檐口"
- **避窗是硬约束**：窗在 dz = -8 / 0 / 8、半宽 1.2，壁柱若压上去就把洞堵死；
  单测 `墙面壁柱不许堵住窗洞` 是这条的反向守卫
- 壁柱带 `cut` 标识，跟所在墙同组剖切；四角包柱仍不带 `cut`（车间轮廓靠它）

## 21.3 实测

```text
三角            33,238 → 33,766（壁柱 + 腰线 + 灯具外壳）
scene draw call 59（未变，全部并进 shell / metal 组）
shadow          54（未变）
整链            130
fps             144.9（未降）
单测            186 → 187
env 23/23 · d1 9/9 · d3 11/11 · device 54/54
```

截图：`output/model-upgrade/b2_overview.png`、`b2_line.png`。

## 21.4 还没解决的问题（留给 2b / 批 3）

- **空旷感只解了一半**：净空抬起来后，车间里 3 台设备显得更孤立。真正要补的是"内容"——
  二层夹层/办公、独立动力站体量、仓储跨，这些不做，12 m 净空只会放大"空"。
- **墙面仍是纯色**：壁柱解决"尺度"，没解决"材质"。墙面是顶点色合并几何、没有 UV，
  贴图方案要单独设计（或改成按墙板分格的几何缝隙）。
- **设备本体仍是盒子**：这一批完全没碰设备。观感上限卡在批 3（GLB）。
