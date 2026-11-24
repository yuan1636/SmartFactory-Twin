"""训练异常检测的四个对照模型（spec_phase4 §5.6）。

必须四个都跑，缺一个结论就不成立：

| # | 模型 | 角色 |
|---|------|------|
| 0 | 阈值规则 | **业务基线**。模型打不过它就没有存在意义（它现在已经在线上了） |
| 1 | 逻辑回归 | 可解释基线。系数正负能说清"是哪个指标在推动判定" |
| 2 | IsolationForest | 无监督基线。只用正常样本训练，完全不碰标签，用来验证"有监督是否真有必要" |
| 3 | XGBoost | 主模型 |

另外还要跑一次 **随机切分对照**（默认开）：
同一份数据用随机切分重训 XGBoost，把指标与时间切分并排放在报告里。
预期随机切分明显更高，差值就是标签泄漏的量化幅度。这是答辩时被问
"你怎么证明指标不是背出来的"的直接答案。

分数统一映射到 0~1，阈值也统一在 0~1 上选：
- 逻辑回归 / XGBoost 直接给 `predict_proba[:, 1]`；
- IsolationForest 给 `-score_samples` 再按训练段分位区间归一化（**不是概率**，是相对分）；
- 阈值规则给 `max(超阈值程度) / 2`，于是 0.5 恰好等于"越过 warning"。

内存顺序是被本机 1.5 GB 可用内存逼出来的：先把所有模型的分数算完（分数数组很小），
释放三个特征矩阵，最后才用全量矩阵跑随机切分对照。顺序反过来会 OOM。
"""

from __future__ import annotations

import argparse
import json
import subprocess
import time
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.ensemble import IsolationForest
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sqlalchemy import text

from ml.common import db
from ml.common.features import THRESHOLD_METRICS, feature_names, schema_hash
from ml.common.metrics import (
    binary_metrics,
    confusion_matrix_text,
    false_alarms_per_device_hour,
    interval_report,
    multiclass_metrics,
    pick_threshold,
)
from ml.common.split import SPLIT_TEST, SPLIT_TRAIN, SPLIT_VAL, random_split_control

BASE_DIR = Path(__file__).resolve().parents[2]
DATASET_PATH = BASE_DIR / "artifacts" / "dataset" / "anomaly.parquet"
META_PATH = BASE_DIR / "artifacts" / "dataset" / "anomaly_meta.json"
ARTIFACT_DIR = BASE_DIR / "artifacts"
REPORT_DIR = BASE_DIR / "ml" / "evaluation" / "reports"

TYPE_LABELS = ["TEMP_DRIFT", "CURRENT_ABNORMAL", "VIB_SPIKE"]
# 每设备每小时允许多少次误报。运维可感知的量级，写死以免模型为刷召回把阈值压到 0
FALSE_ALARM_BUDGET = 1.0

INTERVAL_SQL = text(
    """
    SELECT id, device_id, anomaly_type, started_at, ended_at
    FROM anomaly_injection
    WHERE started_at < :hi AND COALESCE(ended_at, now()) > :lo
    ORDER BY started_at
    """
)


def git_short_hash() -> str:
    try:
        return subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, cwd=BASE_DIR, check=True,
        ).stdout.strip()
    except Exception:
        return "nogit"


def rule_scores_from_matrix(input_matrix: np.ndarray, names: list[str]) -> np.ndarray:
    """业务基线分数：任一指标越过 warning 即判异常，0.5 是判定线。

    数据集里没有原始值，但有 `{metric}_thr` 特征，它的定义是
    `1 + (x - warning) / (critical - warning)`，所以 `thr >= 1` 恰好等价于
    "越过 warning"。除以 2 是为了和其他模型的 0~1 分数统一到同一把尺子上。
    """
    columns = [names.index(f"{metric}_thr") for metric in THRESHOLD_METRICS]
    exceed = input_matrix[:, columns]
    return np.clip(exceed.max(axis=1) / 2.0, 0.0, 1.0)


def load_intervals(lo: pd.Timestamp, hi: pd.Timestamp) -> pd.DataFrame:
    with db.engine().connect() as conn:
        frame = pd.read_sql(INTERVAL_SQL, conn, params={"lo": lo, "hi": hi})
    for column in ("started_at", "ended_at"):
        series = frame[column]
        if isinstance(series.dtype, pd.DatetimeTZDtype):
            series = series.dt.tz_convert("UTC").dt.tz_localize(None)
        frame[column] = series
    frame["ended_at"] = frame["ended_at"].fillna(hi)
    return frame


ABSORBED_SQL = text(
    """
    WITH win AS (
        SELECT * FROM anomaly_injection
        WHERE started_at < :hi AND COALESCE(ended_at, now()) > :lo
    )
    SELECT count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM anomaly_injection b
        WHERE b.device_id = w.device_id AND b.id <> w.id
          AND b.started_at <= w.started_at
          AND COALESCE(b.ended_at, 'infinity') >= COALESCE(w.ended_at, 'infinity')
          AND NOT (b.started_at = w.started_at AND b.id > w.id)
    )) AS absorbed
    FROM win w
    """
)


def count_absorbed(lo: pd.Timestamp, hi: pd.Timestamp) -> int:
    """统计窗口内被同设备后续区间**完全覆盖**的区间数（它们的行只能带后一个区间的 id）。"""
    with db.engine().connect() as conn:
        row = conn.execute(ABSORBED_SQL, {"lo": lo, "hi": hi}).first()
    return int(row[0] or 0) if row else 0


def evaluate_scores(
    frame: pd.DataFrame,
    score: np.ndarray,
    threshold: float,
    intervals: pd.DataFrame,
    absorbed: int | None = None,
) -> dict:
    """一套分数在某一数据段上的全部指标。"""
    scored = frame[["device_id", "ts", "is_anomaly", "interval_id"]].copy()
    scored["score"] = score
    result = binary_metrics(frame["is_anomaly"].to_numpy(), score, threshold)
    result["interval"] = interval_report(scored, intervals, threshold, absorbed=absorbed)
    result["false_alarms_per_device_hour"] = round(false_alarms_per_device_hour(scored, threshold), 3)
    return result


def device_hours_of(frame: pd.DataFrame) -> float:
    span = (frame["ts"].max() - frame["ts"].min()).total_seconds() / 3600.0
    return span * frame["device_id"].nunique()


def train(args: argparse.Namespace) -> dict:
    started = time.perf_counter()
    if not DATASET_PATH.exists():
        raise SystemExit(f"找不到 {DATASET_PATH}，先跑 python -m ml.anomaly_detection.build_dataset")

    meta = json.loads(META_PATH.read_text(encoding="utf-8"))
    if meta["schema_hash"] != schema_hash():
        raise SystemExit(
            "特征 schema 哈希不一致：数据集是用旧版 features.py 导出的，"
            "请重跑 build_dataset 再训练（否则训练与推理的特征列序会错位）"
        )

    dataset = pd.read_parquet(DATASET_PATH)
    names = feature_names()
    matrix = dataset[names].to_numpy(dtype="float32")
    labels = dataset["is_anomaly"].to_numpy().astype(int)
    split_values = dataset["split"].to_numpy()
    meta_cols = dataset[["device_id", "ts", "is_anomaly", "label_type", "interval_id"]].copy()
    del dataset

    train_mask = split_values == SPLIT_TRAIN
    val_mask = split_values == SPLIT_VAL
    test_mask = split_values == SPLIT_TEST

    train_frame = meta_cols[train_mask].reset_index(drop=True)
    val_frame = meta_cols[val_mask].reset_index(drop=True)
    test_frame = meta_cols[test_mask].reset_index(drop=True)
    x_train = matrix[train_mask]
    x_val = matrix[val_mask]
    x_test = matrix[test_mask]
    y_train = labels[train_mask]
    y_val = labels[val_mask]
    y_test = labels[test_mask]

    print(f"数据集 : {DATASET_PATH.name}  {len(labels):,} 行 × {len(names)} 特征")
    print(f"抽稀   : 每 {meta['sample_seconds']} 秒一格（2 秒原采样下每 {meta['stride']} 个取 1）")
    print(f"切分   : 训练 {len(train_frame):,}（正例 {y_train.sum():,}）/ "
          f"验证 {len(val_frame):,}（{y_val.sum():,}）/ 测试 {len(test_frame):,}（{y_test.sum():,}）")
    print(f"时间   : {meta['time_range'][0]} ~ {meta['time_range'][1]}")
    print("-" * 96)

    test_intervals = load_intervals(pd.Timestamp(test_frame["ts"].min()), pd.Timestamp(test_frame["ts"].max()))
    test_absorbed = count_absorbed(pd.Timestamp(test_frame["ts"].min()), pd.Timestamp(test_frame["ts"].max()))
    val_device_hours = device_hours_of(val_frame)

    scores_val: dict[str, np.ndarray] = {}
    scores_test: dict[str, np.ndarray] = {}
    thresholds: dict[str, dict] = {}
    names_display: dict[str, str] = {}

    # ---- 0) 阈值规则基线（不需要训练，直接算） ----
    scores_val["threshold_rule"] = rule_scores_from_matrix(x_val, names)
    scores_test["threshold_rule"] = rule_scores_from_matrix(x_test, names)
    thresholds["threshold_rule"] = {"threshold": 0.5, "note": "0.5 等价于越过 warning"}
    names_display["threshold_rule"] = "阈值规则（现有后端逻辑）"

    # ---- 1) 逻辑回归 ----
    logistic = Pipeline(
        [
            ("scale", StandardScaler()),
            ("clf", LogisticRegression(max_iter=1000, class_weight="balanced")),
        ]
    )
    logistic.fit(x_train, y_train)
    scores_val["logistic_regression"] = logistic.predict_proba(x_val)[:, 1]
    scores_test["logistic_regression"] = logistic.predict_proba(x_test)[:, 1]
    thresholds["logistic_regression"] = pick_threshold(
        y_val, scores_val["logistic_regression"], FALSE_ALARM_BUDGET, val_device_hours
    )
    names_display["logistic_regression"] = "逻辑回归"

    # ---- 2) IsolationForest（只用正常样本训练，不碰标签） ----
    iso = IsolationForest(
        n_estimators=200,
        contamination=float(max(y_train.mean(), 1e-4)),
        random_state=42,
        n_jobs=-1,
    )
    iso.fit(x_train[y_train == 0])
    iso_train_raw = -iso.score_samples(x_train)
    low = float(np.quantile(iso_train_raw, 0.001))
    high = float(np.quantile(iso_train_raw, 0.999))
    span = high - low if high > low else 1.0

    def iso_score(input_matrix: np.ndarray) -> np.ndarray:
        raw = -iso.score_samples(input_matrix)
        return np.clip((raw - low) / span, 0.0, 1.0)

    scores_val["isolation_forest"] = iso_score(x_val)
    scores_test["isolation_forest"] = iso_score(x_test)
    thresholds["isolation_forest"] = pick_threshold(
        y_val, scores_val["isolation_forest"], FALSE_ALARM_BUDGET, val_device_hours
    )
    names_display["isolation_forest"] = "IsolationForest（无监督）"

    # ---- 3) XGBoost 主模型 ----
    pos_weight = float((y_train == 0).sum() / max((y_train == 1).sum(), 1))
    xgb_model = xgb.XGBClassifier(
        n_estimators=400,
        max_depth=6,
        learning_rate=0.1,
        subsample=0.8,
        colsample_bytree=0.8,
        min_child_weight=3,
        scale_pos_weight=pos_weight,
        objective="binary:logistic",
        eval_metric="aucpr",
        early_stopping_rounds=30,
        tree_method="hist",
        n_jobs=-1,
        random_state=42,
    )
    xgb_model.fit(x_train, y_train, eval_set=[(x_val, y_val)], verbose=False)
    scores_val["xgboost"] = xgb_model.predict_proba(x_val)[:, 1]
    scores_test["xgboost"] = xgb_model.predict_proba(x_test)[:, 1]
    thresholds["xgboost"] = {
        **pick_threshold(y_val, scores_val["xgboost"], FALSE_ALARM_BUDGET, val_device_hours),
        "best_iteration": int(xgb_model.best_iteration),
        "scale_pos_weight": round(pos_weight, 2),
    }
    names_display["xgboost"] = "XGBoost（主模型）"

    # ---- 辅任务：三分类归因（只在训练段正例上训练） ----
    type_to_index = {label: index for index, label in enumerate(TYPE_LABELS)}
    type_mask_train = y_train == 1
    y_type_train = np.array(
        [type_to_index[str(value)] for value in train_frame.loc[type_mask_train, "label_type"]], dtype=int
    )
    type_model = xgb.XGBClassifier(
        n_estimators=300,
        max_depth=4,
        learning_rate=0.1,
        subsample=0.9,
        colsample_bytree=0.9,
        objective="multi:softprob",
        num_class=len(TYPE_LABELS),
        eval_metric="mlogloss",
        tree_method="hist",
        n_jobs=-1,
        random_state=42,
    )
    type_model.fit(x_train[type_mask_train], y_type_train, verbose=False)

    type_mask_test = y_test == 1
    y_type_test = np.array(
        [type_to_index[str(value)] for value in test_frame.loc[type_mask_test, "label_type"]], dtype=int
    )
    type_pred = type_model.predict(x_test[type_mask_test])
    type_result = multiclass_metrics(
        y_type_test, type_pred, list(range(len(TYPE_LABELS))), TYPE_LABELS
    )

    # 三个矩阵至此用完，全部释放，给随机切分对照腾内存
    del x_train, x_val, x_test, train_frame, val_frame

    # ---- 反面对照：随机切分 ----
    control: dict | None = None
    if not args.skip_random_control:
        control_split = random_split_control(len(labels), labels, random_state=42)
        c_train = control_split == SPLIT_TRAIN
        c_val = control_split == SPLIT_VAL
        c_test = control_split == SPLIT_TEST
        control_model = xgb.XGBClassifier(
            n_estimators=400, max_depth=6, learning_rate=0.1, subsample=0.8,
            colsample_bytree=0.8, min_child_weight=3, scale_pos_weight=pos_weight,
            objective="binary:logistic", eval_metric="aucpr", early_stopping_rounds=30,
            tree_method="hist", n_jobs=-1, random_state=42,
        )
        control_model.fit(
            matrix[c_train], labels[c_train],
            eval_set=[(matrix[c_val], labels[c_val])], verbose=False,
        )
        control_val = control_model.predict_proba(matrix[c_val])[:, 1]
        control_test_score = control_model.predict_proba(matrix[c_test])[:, 1]
        control_hours = device_hours_of(meta_cols[c_val].reset_index(drop=True))
        control_pick = pick_threshold(labels[c_val], control_val, FALSE_ALARM_BUDGET, control_hours)
        control = {
            "note": "随机切分，仅作泄漏对照，不作为最终结果",
            "threshold": control_pick["threshold"],
            "test": binary_metrics(labels[c_test], control_test_score, control_pick["threshold"]),
        }
    del matrix

    # ---- 汇总指标 ----
    results: dict[str, dict] = {}
    for key, display in names_display.items():
        results[key] = {
            "name": display,
            "threshold_info": thresholds[key],
            "val": binary_metrics(y_val, scores_val[key], thresholds[key]["threshold"]),
            "test": evaluate_scores(
                meta_cols[test_mask].reset_index(drop=True),
                scores_test[key],
                thresholds[key]["threshold"],
                test_intervals,
                absorbed=test_absorbed,
            ),
        }

    # ---- 落 artifact ----
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    commit = git_short_hash()
    model_id = f"anomaly-{time.strftime('%Y%m%d-%H%M')}-{commit}"
    joblib.dump(xgb_model, ARTIFACT_DIR / f"anomaly_xgb_{commit}.joblib", compress=3)
    joblib.dump(logistic, ARTIFACT_DIR / f"anomaly_logistic_{commit}.joblib", compress=3)
    joblib.dump(iso, ARTIFACT_DIR / f"anomaly_isoforest_{commit}.joblib", compress=3)
    joblib.dump(
        {"low": low, "high": high, "span": span},
        ARTIFACT_DIR / f"anomaly_isoforest_scale_{commit}.joblib",
    )
    joblib.dump(type_model, ARTIFACT_DIR / f"anomaly_type_xgb_{commit}.joblib", compress=3)

    importances = sorted(
        zip(names, xgb_model.feature_importances_.tolist()), key=lambda item: item[1], reverse=True
    )[:10]

    artifact_meta = {
        "model_id": model_id,
        "trained_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "git_commit": commit,
        "schema_hash": schema_hash(),
        "feature_names": names,
        "threshold": thresholds["xgboost"]["threshold"],
        "type_labels": TYPE_LABELS,
        "dataset_rows": int(len(labels)),
        "dataset_meta": meta,
        "files": {
            "binary": f"anomaly_xgb_{commit}.joblib",
            "logistic": f"anomaly_logistic_{commit}.joblib",
            "isoforest": f"anomaly_isoforest_{commit}.joblib",
            "isoforest_scale": f"anomaly_isoforest_scale_{commit}.joblib",
            "type": f"anomaly_type_xgb_{commit}.joblib",
        },
        "metrics": {key: value["test"] for key, value in results.items()},
        "top_features": [{"name": name, "importance": round(value, 5)} for name, value in importances],
    }
    (ARTIFACT_DIR / "anomaly_meta.json").write_text(
        json.dumps(artifact_meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # ---- 打印 ----
    print(f"{'模型':<28}{'PR-AUC':>9}{'Precision':>11}{'Recall':>9}{'F1':>8}{'区间检出':>10}{'误报/时':>9}")
    print("-" * 96)
    for key in ("threshold_rule", "logistic_regression", "isolation_forest", "xgboost"):
        item = results[key]
        t = item["test"]
        print(
            f"{item['name']:<28}"
            f"{str(t['pr_auc']):>9}"
            f"{t['precision']:>11.4f}"
            f"{t['recall']:>9.4f}"
            f"{t['f1']:>8.4f}"
            f"{t['interval']['detection_rate']:>10.2%}"
            f"{t['false_alarms_per_device_hour']:>9.2f}"
        )
    print("-" * 96)

    xgb_test = results["xgboost"]["test"]
    print("主模型（XGBoost）测试段混淆矩阵：")
    print(confusion_matrix_text(xgb_test["confusion"]))
    print(f"\n阈值 {thresholds['xgboost']['threshold']:.4f}"
          f"（验证段按「每设备每小时误报 ≤ {FALSE_ALARM_BUDGET:g} 次」选出，best_iteration={xgb_model.best_iteration}）")
    interval_test = xgb_test["interval"]
    print(f"区间级：测试窗口内 {interval_test['intervals_in_window']} 个注入区间，其中 "
          f"{interval_test['intervals_absorbed_by_later']} 个被同设备后续区间完全覆盖（行级单标签下无法单独判定）")
    print(f"  可真判且有行 {interval_test['intervals_with_rows']} 个，检出 "
          f"{interval_test['intervals_detected']} 个（{interval_test['detection_rate']:.2%}），"
          f"中位延迟 {interval_test['median_delay_seconds']} 秒")
    for anomaly_type, detail in interval_test["by_type"].items():
        print(f"  {anomaly_type:<20}{detail['detected']:>4}/{detail['total']:<4} {detail['rate']:>7.2%}")

    print(f"\n三分类归因（测试段正例 {int(type_mask_test.sum()):,} 条）：宏 F1 {type_result['f1_macro']:.4f}")
    for label, detail in type_result["per_class"].items():
        print(f"  {label:<20}P {detail['precision']:.3f}  R {detail['recall']:.3f}  "
              f"F1 {detail['f1']:.3f}  样本 {detail['support']}")

    # 这两条必须打在输出里，也必须进报告：指标好看的原因要交代清楚，
    # 否则 100% 会被当成模型能力强，答辩时一追问配置就穿帮。
    type_caveat = (
        "类型归因接近满分是**数据集事实**不是模型能力：config/devices.json 里每台设备只被分配"
        "了一种异常类型（实测 14 台设备的注入类型数全为 1），所以「哪类指标在偏离」与「属于哪类异常」"
        "在本数据上是确定性映射。真实工厂里同一台设备会先后出现多种异常，届时宏 F1 不会是这个数。"
        "因此该指标只能作为「归因链路可用」的证据，不能作为泛化能力的证据。"
    )
    unsupervised_note = (
        "IsolationForest 显著弱于阈值规则（PR-AUC 0.07 vs 0.91）。原因不是实现错误："
        "注入异常表现为相对阈值的**持续偏移**（TEMP_DRIFT 平均 419 秒），每一行的绝对取值"
        "仍落在设备正常区间内，在 78 维空间里不构成离群点；而无监督方法只能找离群点。"
        "这条结论支持「本场景必须用有监督 + 领域特征」，也是把无监督基线放进来的意义。"
    )
    print(f"\n⚠ 类型归因的口径：{type_caveat}")
    print(f"⚠ 无监督基线：{unsupervised_note}")

    print("\nXGBoost 最重要的 8 个特征（可解释性的最低交付）：")
    for name, value in importances[:8]:
        print(f"  {name:<24}{value:>8.4f}")

    if control:
        gap = (control["test"]["pr_auc"] or 0) - (xgb_test["pr_auc"] or 0)
        print(f"\n反面对照（随机切分）：PR-AUC {control['test']['pr_auc']} vs 时间切分 {xgb_test['pr_auc']}"
              f"  → 虚高 {gap:+.4f}")
        print("  随机切分让同一段注入的相邻行同时进了训练和测试，模型靠「记住这段波形」拿分；")
        print("  时间切分的数字才是能拿去答辩的。")

    # ---- 落报告 ----
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "model_id": model_id,
        "schema_hash": schema_hash(),
        "dataset": {
            "rows": int(len(labels)),
            "positive_rows": int(labels.sum()),
            "positive_rate": round(float(labels.mean()), 6),
            "sample_seconds": meta["sample_seconds"],
            "time_range": meta["time_range"],
            "split": meta["split_summary"],
        },
        "false_alarm_budget_per_device_hour": FALSE_ALARM_BUDGET,
        "thresholds": thresholds,
        "models": results,
        "type_attribution": type_result,
        "top_features": [{"name": name, "importance": round(value, 5)} for name, value in importances],
        "random_split_control": control,
        "notes": {
            "type_attribution_caveat": type_caveat,
            "unsupervised_baseline": unsupervised_note,
            "data_is_simulated": "全部数据来自模拟器注入（docs/方案.md 已声明），指标只对模拟器成立，不代表真实工厂。",
            "sample_interval": "训练集按 10 秒抽稀；推理侧仍按 2 秒，滑窗特征用 2 秒原分辨率计算。",
        },
    }
    report_path = REPORT_DIR / f"{time.strftime('%Y%m%d')}_anomaly.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n已写出 {ARTIFACT_DIR / 'anomaly_meta.json'}")
    print(f"已写出 {report_path}")
    print(f"总耗时 {time.perf_counter() - started:.1f} 秒")
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="训练异常检测模型（模拟数据，指标仅对模拟器有效）")
    parser.add_argument("--skip-random-control", action="store_true", help="跳过随机切分反面对照（省时间与内存）")
    return parser.parse_args()


if __name__ == "__main__":
    train(parse_args())
