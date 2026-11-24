"""数据切分（spec_phase4 §5.4，G-03）。

本模块只做三件事，但每一件都关系到指标是否可信：

1. `time_split_frames()`：按时间切成 训练/验证/测试 三段，**物理时间不重叠**；
2. `drop_spanning_interval_rows()`：跨切分点的注入区间，把它在验证/测试段的行**剔除**，
   保证同一段注入不横跨两段。**不是**"整段并入训练段"——那样训练段会出现晚于
   验证段起点的行，三段就不再互斥（v0.1 规格的写法已按偏差 D-17 修正）；
3. `random_split_control()`：随机切分，作为**反面对照**。
   它存在的唯一目的是量化"如果乱切，指标会虚高多少"，不作为最终结果。

随机切分的结果必须和随机种子一起记录，否则不可复现。
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.model_selection import train_test_split

SPLIT_TRAIN = "train"
SPLIT_VAL = "val"
SPLIT_TEST = "test"


def _cut_points(timestamps: pd.Series, train_ratio: float, val_ratio: float) -> tuple:
    """按**时间**（不是行数）取两个切分点。"""
    unique = np.sort(timestamps.unique())
    if len(unique) < 10:
        raise ValueError(f"时间点太少（{len(unique)} 个），无法切分")
    train_idx = int(len(unique) * train_ratio)
    val_idx = int(len(unique) * (train_ratio + val_ratio))
    return unique[train_idx], unique[val_idx]


def assign_time_split(
    frame: pd.DataFrame,
    train_ratio: float = 0.70,
    val_ratio: float = 0.15,
    cuts: tuple | None = None,
) -> pd.Series:
    """给每行打上 train / val / test 标签（按 ts 先后，不看行序）。

    `cuts` 由外部传入时（例如先查全库 min/max 再按比例插值），逐设备处理也能
    落在同一条时间轴上。不传时按本帧自身的时间点分位数取。
    """
    if cuts is None:
        cut_train, cut_val = _cut_points(frame["ts"], train_ratio, val_ratio)
    else:
        cut_train, cut_val = cuts
    split = pd.Series(SPLIT_TRAIN, index=frame.index, dtype="object")
    split.loc[frame["ts"] >= cut_train] = SPLIT_VAL
    split.loc[frame["ts"] >= cut_val] = SPLIT_TEST
    return split


def global_cuts(
    start: pd.Timestamp,
    end: pd.Timestamp,
    train_ratio: float = 0.70,
    val_ratio: float = 0.15,
) -> tuple[pd.Timestamp, pd.Timestamp]:
    """按时间跨度插值出两个切分点。

    数据是 2 秒等间隔栅格，按跨度插值与按时间点分位数取的结果一致，
    但前者只要一次 `min/max` 查询，不必把 400 万个时间点拉进内存排序。
    """
    span = end - start
    return (
        start + span * train_ratio,
        start + span * (train_ratio + val_ratio),
    )


def cut_points_from_frame(
    frame: pd.DataFrame,
    train_ratio: float = 0.70,
    val_ratio: float = 0.15,
) -> tuple:
    return _cut_points(frame["ts"], train_ratio, val_ratio)


def drop_spanning_interval_rows(
    frame: pd.DataFrame,
    split: pd.Series,
) -> tuple[pd.Series, pd.Series, int]:
    """把**跨切分点**的注入区间在验证/测试段里的行整段剔除。

    返回 `(保留掩码, 调整后的 split, 受影响区间数)`。

    为什么是"剔除"而不是"并入训练段"：v0.1 规格 §5.4 写的是并入训练段，实测发现
    并入会让训练段里出现**晚于验证段起点**的行——训练段与验证段在时间上重叠，
    这既违反"物理时间不重叠"，又让验证集指标偏乐观（模型见过未来的行）。
    剔除的代价是损失少量正例，但换来三段严格互斥，这个交换必须做。

    跨段的区间本来就无法同时满足"不跨段"和"全部保留"，任何处理都会损失点什么，
    关键是损失要说清楚：剔除的区间数与行数都写进 `anomaly_meta.json`。
    """
    if "interval_id" not in frame.columns:
        return pd.Series(True, index=frame.index), split, 0

    in_interval = frame["interval_id"] >= 0
    if not in_interval.any():
        return pd.Series(True, index=frame.index), split, 0

    span_count = (
        pd.DataFrame(
            {"interval_id": frame.loc[in_interval, "interval_id"], "split": split[in_interval]}
        )
        .groupby("interval_id")["split"]
        .nunique()
    )
    spanning = span_count[span_count > 1].index
    if len(spanning) == 0:
        return pd.Series(True, index=frame.index), split, 0

    # 只剔除落在验证/测试段的那部分行；训练段里的行照常保留
    dropped_mask = frame["interval_id"].isin(spanning) & (split != SPLIT_TRAIN)
    keep_mask = ~dropped_mask
    return keep_mask, split, int(len(spanning))


def random_split_control(
    n_rows: int,
    labels: np.ndarray,
    random_state: int = 42,
) -> np.ndarray:
    """反面对照：按行随机切 70/15/15，不做任何时间与区间约束。

    预期它给出的指标会明显高于时间切分，差值就是泄漏的量化幅度。
    """
    indices = np.arange(n_rows)
    train_idx, rest_idx = train_test_split(
        indices, test_size=0.30, random_state=random_state, stratify=labels
    )
    val_idx, test_idx = train_test_split(
        rest_idx, test_size=0.50, random_state=random_state, stratify=labels[rest_idx]
    )
    split = np.full(n_rows, SPLIT_TRAIN, dtype=object)
    split[val_idx] = SPLIT_VAL
    split[test_idx] = SPLIT_TEST
    return split


def describe_splits(frame: pd.DataFrame, split: pd.Series) -> pd.DataFrame:
    """三段的行数、时间范围、正例率。正例率偏离过大说明切分点选得不好。"""
    work = pd.DataFrame(
        {
            "split": split,
            "ts": frame["ts"],
            "is_anomaly": frame["is_anomaly"],
        }
    )
    rows = []
    for name in (SPLIT_TRAIN, SPLIT_VAL, SPLIT_TEST):
        part = work[work["split"] == name]
        rows.append(
            {
                "split": name,
                "rows": len(part),
                "positive": int(part["is_anomaly"].sum()),
                "positive_rate": round(float(part["is_anomaly"].mean()) if len(part) else 0.0, 5),
                "start": str(part["ts"].min()),
                "end": str(part["ts"].max()),
            }
        )
    return pd.DataFrame(rows)
