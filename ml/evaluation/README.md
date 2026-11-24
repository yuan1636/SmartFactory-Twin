# 模型评估报告

每次训练写两个文件，**都进 git**（论文与答辩要引用）：

- `YYYYMMDD_anomaly.json` 机器可读，供 4.2 批的 `/api/v1/ml/model-info` 接口直接返回；
- `YYYYMMDD_anomaly.md` 人读摘要，可直接粘进 `docs/acceptance_phase4.md`。

生成方式：

```powershell
python -m ml.anomaly_detection.evaluate
```

该命令除了写 Markdown，还会跑 **22 项一致性自检**（混淆矩阵与 P/R 互相复核、三段切分时间不重叠、
三段正例率漂移不超过 2 倍、归因样本数等于测试段正例数、主模型必须优于阈值规则基线）。
任一项失败即以退出码 1 结束——报告里的数字一旦自相矛盾，比指标低十倍更难看。

**图不在本目录**：按偏差 D-12，混淆矩阵与 PR 对比的图形版由前端 AI 页用 ECharts 渲染，
本目录只保留文本矩阵与 Markdown 表。
