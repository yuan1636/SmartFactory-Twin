# ml/ —— 第 4 阶段 AI 模型

施工依据 `docs/spec_phase4.md` v1.0，验收记录 `docs/acceptance_phase4.md`。

**全部数据来自模拟器注入，指标只对模拟器成立，不代表真实工厂。**

## 目录

```
common/
  db.py        只读数据库访问（连接串与后端同源）
  features.py  78 维特征工程，训练与推理共用的唯一实现
  split.py     时间切分 / 跨段区间剔除 / 随机切分对照
  metrics.py   PR-AUC、宏 F1、区间检出率、每设备每小时误报
anomaly_detection/
  build_dataset.py  导出特征矩阵与标签（逐设备处理，控制内存）
  train.py          四个对照模型 + 三分类归因 + 随机切分对照
  evaluate.py       22 项一致性自检 + 生成 Markdown 摘要
evaluation/reports/ 报告（JSON 机器可读，MD 可粘贴进验收文档），进 git
```

## 跑法

```powershell
pip install -r requirements-ml.txt
python -m ml.anomaly_detection.build_dataset   # 约 33 秒
python -m ml.anomaly_detection.train           # 约 65 秒
python -m ml.anomaly_detection.evaluate        # 自检 22 项
```

模型文件写 `artifacts/`（不进 git，可重建）。报告写 `ml/evaluation/reports/`（进 git）。

## 三条不能踩的线

1. **标签只来自 `anomaly_injection`**，不能用 `alarms`——那是阈值规则的输出，拿它当标签
   就等于让模型学规则，失去"比规则强"的立足点。
2. **归一化基线只能来自训练段**，算完存进 artifact。用全量数据算会让测试段信息渗进特征。
3. **切分必须按时间**，并保留随机切分作反面对照。随机切分的指标只能用来量化泄漏，不能当结果。

## 当前指标（2026-11-24，测试段 127,206 行 / 正例 2,175）

| 模型 | PR-AUC | Recall | 误报/设备小时 |
|---|---|---|---|
| 阈值规则（基线） | 0.9098 | 0.8028 | 0.04 |
| 逻辑回归 | 0.9421 | 0.9623 | 1.06 |
| IsolationForest | 0.0670 | 0.0175 | 0.83 |
| **XGBoost** | **0.9859** | **0.9830** | 0.62 |

三分类归因宏 F1 1.0，但这是"每台设备只配了一种异常类型"造成的数据集事实，
不能当泛化能力。详见 `docs/acceptance_phase4.md` 第 5 节。
