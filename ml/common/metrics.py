"""评估指标（spec_phase4 §5.7）。

为什么主指标是 PR-AUC 不是 ROC-AUC：正例只占 2.56%，负例是正例的 38 倍，
一个把所有样本都判为正常、或者特征完全随机的模型，ROC-AUC 依然能到 0.95 以上。
PR-AUC 只关心"被判为正的那部分里有多少是真的"，负例再多也稀释不掉它。

除了模型指标，这里还提供两个**业务指标**，它们才是运维真正感知到的东西：
- 区间级检出率：219 个注入区间里，有多少个至少被检出 1 行；
- 每设备每小时误报次数：模型分数曲线"看起来还行"和"每小时弹 30 次"是两回事。
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.metrics import (
    average_precision_score,
    confusion_matrix,
    f1_score,
    precision_recall_fscore_support,
    roc_auc_score,
)


def binary_metrics(y_true: np.ndarray, y_score: np.ndarray, threshold: float) -> dict:
    """二分类（正常 / 异常）在给定阈值下的全部指标。"""
    y_true = np.asarray(y_true).astype(int)
    y_score = np.asarray(y_score, dtype="float64")
    y_pred = (y_score >= threshold).astype(int)

    if y_true.min() == y_true.max():
        # 只有一类时 PR-AUC / ROC-AUC 无定义，直接返回 NaN 而不是编一个数
        pr_auc = roc_auc = float("nan")
    else:
        pr_auc = float(average_precision_score(y_true, y_score))
        roc_auc = float(roc_auc_score(y_true, y_score))

    tn, fp, fn, tp = confusion_matrix(y_true, y_pred, labels=[0, 1]).ravel()
    precision = float(tp / (tp + fp)) if (tp + fp) else 0.0
    recall = float(tp / (tp + fn)) if (tp + fn) else 0.0
    f1 = float(2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
    return {
        "threshold": round(float(threshold), 6),
        "pr_auc": round(pr_auc, 4) if pr_auc == pr_auc else None,
        "roc_auc": round(roc_auc, 4) if roc_auc == roc_auc else None,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "confusion": {"tn": int(tn), "fp": int(fp), "fn": int(fn), "tp": int(tp)},
    }


def multiclass_metrics(
    y_true: np.ndarray,
    y_pred_label: np.ndarray,
    labels: list,
    display_names: list[str] | None = None,
) -> dict:
    """三分类归因：宏平均 F1 为主，按类分列（VIB_SPIKE 样本最少，最容易被掩盖）。

    `labels` 必须是 **y 里真实出现的取值**（这里是 0/1/2 的整数编码），
    `display_names` 只用于展示。早先的版本把字符串名字当 labels 传进来，
    sklearn 找不到匹配标签，所有指标静默变成 0——这种错不会抛异常，只会输出一张
    全是 0 的表，比报错更难发现。
    """
    display_names = display_names or [str(value) for value in labels]
    macro = precision_recall_fscore_support(
        y_true, y_pred_label, labels=labels, average="macro", zero_division=0
    )
    per_class = precision_recall_fscore_support(
        y_true, y_pred_label, labels=labels, average=None, zero_division=0
    )
    support = pd.Series(y_true).value_counts()
    return {
        "f1_macro": round(float(macro[2]), 4),
        "precision_macro": round(float(macro[0]), 4),
        "recall_macro": round(float(macro[1]), 4),
        "f1_weighted": round(
            float(f1_score(y_true, y_pred_label, labels=labels, average="weighted", zero_division=0)), 4
        ),
        "n_samples": int(len(y_true)),
        "per_class": {
            display_names[i]: {
                "precision": round(float(per_class[0][i]), 4),
                "recall": round(float(per_class[1][i]), 4),
                "f1": round(float(per_class[2][i]), 4),
                "support": int(support.get(label, 0)),
            }
            for i, label in enumerate(labels)
        },
    }


def device_hours(frame: pd.DataFrame) -> float:
    """总设备小时数，用来把误报次数换算成"每设备每小时"。"""
    if len(frame) == 0:
        return 0.0
    span_hours = (frame["ts"].max() - frame["ts"].min()).total_seconds() / 3600.0
    n_devices = frame["device_id"].nunique()
    return max(span_hours * n_devices, 1e-6)


def false_alarms_per_device_hour(frame: pd.DataFrame, threshold: float) -> float:
    """未处于注入区间、却被判为异常的行 / 设备小时数。"""
    predicted = frame["score"] >= threshold
    false_alarms = int((predicted & (~frame["is_anomaly"].astype(bool))).sum())
    return float(false_alarms / device_hours(frame))


def pick_threshold(
    y_true: np.ndarray,
    y_score: np.ndarray,
    allowed_false_alarms_per_device_hour: float,
    hours: float,
    grid_size: int = 200,
) -> dict:
    """在验证段扫描阈值：在"误报不超过配额"的前提下取召回最高的那个点。

    业务上"每设备每小时误报 ≤ 1 次"是运维能接受的量级——这个约束写死，
    否则模型会为了刷召回把阈值压到 0，线上每小时弹几百条告警。
    """
    y_true = np.asarray(y_true).astype(int)
    y_score = np.asarray(y_score, dtype="float64")
    negatives = int((y_true == 0).sum())
    budget = max(int(allowed_false_alarms_per_device_hour * hours), 1)

    candidates = np.unique(np.quantile(y_score, np.linspace(0.50, 0.9999, grid_size)))
    best = {"threshold": 0.5, "recall": -1.0, "precision": 0.0, "false_alarms": 0}
    for threshold in candidates:
        predicted = y_score >= threshold
        fp = int((predicted & (y_true == 0)).sum())
        if negatives and fp > budget:
            continue
        tp = int((predicted & (y_true == 1)).sum())
        positives = int((y_true == 1).sum())
        recall = tp / positives if positives else 0.0
        precision = tp / (tp + fp) if (tp + fp) else 0.0
        if recall > best["recall"]:
            best = {
                "threshold": float(threshold),
                "recall": float(recall),
                "precision": float(precision),
                "false_alarms": fp,
            }
    return {
        "threshold": round(best["threshold"], 6),
        "val_recall": round(best["recall"], 4),
        "val_precision": round(best["precision"], 4),
        "val_false_alarms": best["false_alarms"],
        "budget_per_device_hour": allowed_false_alarms_per_device_hour,
        "budget_total": budget,
    }


def interval_report(
    scored: pd.DataFrame,
    intervals: pd.DataFrame,
    threshold: float,
    absorbed: int | None = None,
) -> dict:
    """区间级检出率与检测延迟。

    `scored` 需含 device_id / ts / score / is_anomaly / interval_id；
    `intervals` 需含 id / device_id / anomaly_type / started_at / ended_at。
    只要某区间内有一行被判为异常，该区间即算检出——这是业务口径。

    **分母只算"可真判且在被评数据段里真有行"的区间**，两个原因分别扣掉：

    1. `absorbed`：同一设备上下一个注入区间把前一个**完全覆盖**了。数据集是"一行一个
       interval_id"，后写的区间会盖掉先写的，被覆盖的区间在数据里连一个带自己 id 的行
       都没有，无法判定检出与否。实测全库 967 个区间里 205 个属于这种情况
       （TEMP_DRIFT 平均持续 419 秒，而注入间隔约 5 分钟，重叠是常态）。
    2. 抽样：#1 之外还有极少数区间落在 10 秒抽样点之间，一行不剩。

    早先版本拿窗口内全部区间当分母，把检出率压到 40%，与行级 98% 的召回自相矛盾。
    现在四段拆开报：窗口内总数 / 被覆盖 / 有行 / 检出，任何一个数字都能对上。
    """
    predicted = scored.loc[scored["score"] >= threshold]
    hit = predicted.loc[predicted["interval_id"] >= 0].groupby("interval_id")["ts"].min()

    present_ids = set(scored.loc[scored["interval_id"] >= 0, "interval_id"].unique().tolist())
    relevant = intervals[intervals["id"].isin(present_ids)]

    by_type: dict[str, dict[str, int]] = {}
    delays: list[float] = []
    for row in relevant.itertuples():
        key = row.anomaly_type
        bucket = by_type.setdefault(key, {"total": 0, "detected": 0})
        bucket["total"] += 1
        if row.id in hit.index:
            bucket["detected"] += 1
            delay = (hit.loc[row.id] - row.started_at).total_seconds()
            delays.append(float(delay))

    detected = len(hit.index.intersection(pd.Index(list(present_ids))))
    total = len(relevant)
    return {
        "intervals_in_window": int(len(intervals)),
        "intervals_absorbed_by_later": int(absorbed) if absorbed is not None else None,
        "intervals_with_rows": int(total),
        "intervals_detected": int(detected),
        "detection_rate": round(detected / total, 4) if total else 0.0,
        "median_delay_seconds": round(float(np.median(delays)), 1) if delays else None,
        "by_type": {
            key: {
                **value,
                "rate": round(value["detected"] / value["total"], 4) if value["total"] else 0.0,
            }
            for key, value in sorted(by_type.items())
        },
    }


def confusion_matrix_text(confusion: dict) -> str:
    """把混淆矩阵打成 2×2 文本，贴进日志与验收文档用（不引 matplotlib）。"""
    return (
        f"              预测正常   预测异常\n"
        f"实际正常      {confusion['tn']:>8}  {confusion['fp']:>8}\n"
        f"实际异常      {confusion['fn']:>8}  {confusion['tp']:>8}"
    )
