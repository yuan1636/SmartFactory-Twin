"""异常检测任务（spec_phase4 §5）。

- `build_dataset.py` 导特征矩阵与标签
- `train.py`        训练四个对照模型并落 artifact
- `evaluate.py`     在测试段出报告（JSON + 文本混淆矩阵）
- `score.py`        批量打分写入 anomaly_scores（4.2 批）
"""
