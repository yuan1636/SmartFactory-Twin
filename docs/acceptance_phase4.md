# 第 4 阶段验收记录

```yaml
规格: docs/spec_phase4.md v1.1（v1.0 冻结版 + 4.2 批施工细节，含偏差 D-11 ~ D-25）
记录: 2026-11-24 ~ 2026-11-25，按批记录，每批三列（结论 / 命令 / 实际输出）
范围: 4.1 批（异常检测：回填 → 数据集 → 四模型 → 报告，第 1~7 节）
      4.2 批（模型接入后端 + /ml/* 接口 + AI 页落地，第 8 节）
```

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
