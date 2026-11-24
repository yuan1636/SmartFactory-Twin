"""导出异常检测的训练集（spec_phase4 §5.2 / §5.3 / §5.4）。

产物：
- `artifacts/dataset/anomaly.parquet`   训练集（含 label / interval_id / split）
- `artifacts/dataset/anomaly_meta.json` 特征名、schema 哈希、降采样步长、切分点、归一化基线

设计取舍（都是被实测约束逼出来的，不是随手写的）：

1. **逐设备处理，不一次性读全库。** 7 天全量 423 万行，全部读进 pandas 再展开
   78 维 float32 特征要 1.3 GB 以上，而本机可用内存只有 0.7 GB（WSL2 的 docker
   就占了 9 GB）。逐设备处理峰值约 300 MB。
2. **特征在 2 秒原分辨率上算，取样时按 `--stride` 抽稀。** 先抽稀再算滑窗会把
   15 秒窗口缩成 3 个点，VIB_SPIKE 这种平均 40 秒的短事件直接被抹平。抽稀只
   影响"保留哪些行"，不影响"每行特征怎么算"，因此不构成信息泄漏。
   每个注入区间平均 419 秒，按 10 秒抽稀后仍有 40 个点，最少的区间也不少于 4 个。
3. **标签只来自 `anomaly_injection`**，不用 `alarms` 表——那是阈值规则的输出，
   拿它当标签等于让模型去学阈值规则，就失去了"证明比阈值规则强"的立足点。

时间口径：全部转成 **UTC-naive** 再参与比较。`timestamptz` 读进来是带时区的
datetime64，和 `np.datetime64` 混算容易踩坑，统一去时区后比较，语义不变（都是 UTC）。
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
from sqlalchemy import text

from ml.common import db
from ml.common.features import (
    build_features,
    feature_names,
    fit_baseline,
    load_device_specs,
    schema_hash,
)
from ml.common.split import (
    SPLIT_TEST,
    SPLIT_TRAIN,
    SPLIT_VAL,
    assign_time_split,
    describe_splits,
    drop_spanning_interval_rows,
    global_cuts,
)

BASE_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BASE_DIR / "artifacts" / "dataset"
DEFAULT_PARQUET = DATA_DIR / "anomaly.parquet"
DEFAULT_META = DATA_DIR / "anomaly_meta.json"

TRAIN_RATIO = 0.70
VAL_RATIO = 0.15

TELEMETRY_SQL = text(
    """
    SELECT device_id, ts, temperature, vibration, current, speed, running_status
    FROM device_telemetry
    WHERE device_id = :device_id
    ORDER BY ts
    """
)
INTERVAL_SQL = text(
    """
    SELECT id, device_id, anomaly_type, started_at, ended_at
    FROM anomaly_injection
    ORDER BY device_id, started_at
    """
)
BOUNDS_SQL = text("SELECT min(ts) AS lo, max(ts) AS hi FROM device_telemetry")


def _to_naive_utc(series: pd.Series) -> pd.Series:
    """timestamptz → UTC-naive。数据库整体存 UTC（AGENTS.md 规则 3），去时区不改变语义。"""
    if isinstance(series.dtype, pd.DatetimeTZDtype):
        return series.dt.tz_convert("UTC").dt.tz_localize(None)
    return series


def _naive(value) -> pd.Timestamp:
    """单个时间值 → UTC-naive Timestamp。"""
    stamp = pd.Timestamp(value)
    return stamp.tz_convert("UTC").tz_localize(None) if stamp.tzinfo else stamp


def load_intervals() -> pd.DataFrame:
    with db.engine().connect() as conn:
        frame = pd.read_sql(INTERVAL_SQL, conn)
    frame["started_at"] = _to_naive_utc(frame["started_at"])
    # ended_at 为 NULL 表示"仍在进行"，按当前时刻封口（与 spec_phase4 §5.2 约定一致）
    now = pd.Timestamp.utcnow().tz_localize(None)
    frame["ended_at"] = _to_naive_utc(frame["ended_at"]).fillna(now)
    return frame


def label_device(ts_values: np.ndarray, intervals: pd.DataFrame) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """给一台设备的时间戳数组打标签。

    返回 (is_anomaly, interval_id, label_type)：
    - is_anomaly: int8，1 表示落在任一注入区间内
    - interval_id: int32，-1 表示正常
    - label_type: object，三类异常之一或 'NORMAL'
    """
    n_rows = len(ts_values)
    is_anomaly = np.zeros(n_rows, dtype="int8")
    interval_id = np.full(n_rows, -1, dtype="int32")
    label_type = np.full(n_rows, "NORMAL", dtype=object)

    for row in intervals.itertuples():
        mask = (ts_values >= row.started_at) & (ts_values < row.ended_at)
        if not mask.any():
            continue
        is_anomaly[mask] = 1
        interval_id[mask] = row.id
        label_type[mask] = row.anomaly_type
    return is_anomaly, interval_id, label_type


def build(args: argparse.Namespace) -> None:
    started = time.perf_counter()
    specs = load_device_specs()
    intervals_all = load_intervals()

    with db.engine().connect() as conn:
        bounds = pd.read_sql(BOUNDS_SQL, conn)
    lo = _naive(bounds["lo"].iloc[0])
    hi = _naive(bounds["hi"].iloc[0])
    cuts = global_cuts(lo, hi, TRAIN_RATIO, VAL_RATIO)

    print(f"数据源 : {db.describe()}")
    print(f"时间范围: {lo} ~ {hi}（{(hi - lo).total_seconds() / 3600:.1f} 小时）")
    print(f"切分点 : 训练 < {cuts[0]} ≤ 验证 < {cuts[1]} ≤ 测试")
    print(f"抽稀步长: 每 {args.stride} 个 2 秒采样取 1 个（即 {args.stride * 2} 秒一格）")
    print("-" * 96)
    print(f"{'设备':<10}{'原始行数':>10}{'保留行数':>10}{'正例':>8}{'正例率':>9}{'区间数':>8}{'耗时s':>8}")
    print("-" * 96)

    device_ids = list(specs.keys())
    if args.limit_devices:
        device_ids = device_ids[: args.limit_devices]

    parts: list[pd.DataFrame] = []
    baselines: dict[str, dict[str, list[float]]] = {}
    total_raw = 0

    for device_id in device_ids:
        device_started = time.perf_counter()
        spec = specs[device_id]
        with db.engine().connect() as conn:
            raw = pd.read_sql(TELEMETRY_SQL, conn, params={"device_id": device_id})

        if raw.empty:
            print(f"{device_id:<10}  无数据，跳过")
            continue

        raw["ts"] = _to_naive_utc(raw["ts"])
        raw = raw.sort_values("ts").reset_index(drop=True)
        n_raw = len(raw)
        total_raw += n_raw

        # 归一化基线：只用训练段（G-08 防泄漏）
        train_mask = raw["ts"] < cuts[0]
        baseline = fit_baseline(raw.loc[train_mask] if train_mask.any() else raw, spec)
        baselines[device_id] = {k: [v[0], v[1]] for k, v in baseline.items()}

        matrix = build_features(raw, spec, baseline)

        intervals = intervals_all[intervals_all["device_id"] == device_id]
        is_anomaly, interval_id, label_type = label_device(raw["ts"].to_numpy(), intervals)

        take = np.arange(0, n_raw, args.stride)
        part = pd.DataFrame(
            {
                "device_id": pd.Categorical([device_id] * len(take)),
                "ts": raw["ts"].to_numpy()[take],
                "is_anomaly": is_anomaly[take],
                "label_type": pd.Categorical(label_type[take]),
                "interval_id": interval_id[take],
            }
        )
        feature_frame = pd.DataFrame(matrix[take], columns=feature_names())
        part = pd.concat([part, feature_frame], axis=1)
        parts.append(part)

        print(
            f"{device_id:<10}{n_raw:>10}{len(take):>10}{int(is_anomaly[take].sum()):>8}"
            f"{is_anomaly[take].mean():>9.2%}{len(intervals):>8}{time.perf_counter() - device_started:>8.1f}"
        )
        del raw, matrix, feature_frame, part  # 及时释放，峰值内存才压得住

    if not parts:
        raise SystemExit("没有取到任何设备数据，检查数据库是否已回填")

    dataset = pd.concat(parts, ignore_index=True)
    del parts
    dataset = dataset.sort_values(["ts", "device_id"]).reset_index(drop=True)

    split = assign_time_split(dataset, TRAIN_RATIO, VAL_RATIO, cuts=cuts)
    keep_mask, split, spanning_count = drop_spanning_interval_rows(dataset, split)
    dropped_rows = int((~keep_mask).sum())
    if dropped_rows:
        dataset = dataset.loc[keep_mask].reset_index(drop=True)
        split = split.loc[keep_mask].reset_index(drop=True)
    dataset["split"] = split

    summary = describe_splits(dataset, dataset["split"])
    print("-" * 96)
    print(f"总行数 {len(dataset):,}（原始 {total_raw:,}，抽稀后保留 {len(dataset) / total_raw:.1%}）")
    print(summary.to_string(index=False))
    if spanning_count:
        print(
            f"跨切分点的注入区间 {spanning_count} 个，其在验证/测试段的 {dropped_rows:,} 行已剔除"
            "（并入训练段会造成训练段与验证段时间重叠，见 split.py 说明）"
        )

    positive_rate = dataset["is_anomaly"].mean()
    train_rate = float(summary.loc[summary["split"] == SPLIT_TRAIN, "positive_rate"].iloc[0])
    test_rate = float(summary.loc[summary["split"] == SPLIT_TEST, "positive_rate"].iloc[0])
    if train_rate > 0 and (test_rate > 2 * train_rate or test_rate < 0.5 * train_rate):
        print(
            f"⚠ 测试段正例率 {test_rate:.2%} 偏离训练段 {train_rate:.2%} 超过 2 倍，"
            "按 spec §5.4 需要重选切分点（本次仅提示，不阻断）"
        )

    by_type = dataset.loc[dataset["is_anomaly"] == 1, "label_type"].value_counts()
    print("异常类型分布（占全部行数的比例）：")
    for label, count in by_type.items():
        print(f"  {label:<20}{count:>9,}  {count / len(dataset):>7.2%}")

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    dataset.to_parquet(DEFAULT_PARQUET if args.out is None else Path(args.out), index=False, compression="snappy")

    meta = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "source": db.describe(),
        "feature_names": feature_names(),
        "schema_hash": schema_hash(),
        "stride": args.stride,
        "sample_seconds": 2 * args.stride,
        "rows": int(len(dataset)),
        "raw_rows": int(total_raw),
        "positive_rows": int(dataset["is_anomaly"].sum()),
        "positive_rate": round(positive_rate, 6),
        "time_range": [str(lo), str(hi)],
        "cuts": [str(cuts[0]), str(cuts[1])],
        "split_summary": summary.to_dict(orient="records"),
        "spanning_intervals": spanning_count,
        "spanning_rows_dropped": dropped_rows,
        "baseline_train_only": baselines,
        "parquet": str(DEFAULT_PARQUET if args.out is None else Path(args.out)),
    }
    meta_path = DEFAULT_META if args.meta is None else Path(args.meta)
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n已写出 {meta['parquet']}")
    print(f"已写出 {meta_path}")
    print(f"总耗时 {time.perf_counter() - started:.1f} 秒")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="导出异常检测训练集（模拟数据，非真实工厂数据）")
    parser.add_argument("--stride", type=int, default=5, help="抽稀步长，默认 5（10 秒一格）")
    parser.add_argument("--out", default=None, help="parquet 输出路径")
    parser.add_argument("--meta", default=None, help="meta JSON 输出路径")
    parser.add_argument("--limit-devices", type=int, default=0, help="只处理前 N 台设备，用于冒烟测试")
    return parser.parse_args()


if __name__ == "__main__":
    build(parse_args())
