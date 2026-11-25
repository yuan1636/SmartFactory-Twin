"""异常检测模型的进程内推理服务（spec_phase4 §6.1，G-01）。

三条硬性设计约束，每一条都对应一个会被问到的问题：

1. **lazy 加载**：不在 import 时读 artifact。模型 280 KB + xgboost 初始化约 1 秒，
   放在启动路径上会让后端冷启动变慢；更实际的原因是——大多数接口根本不用模型，
   不该为它付钱。首次调用 `get_state()` 才加载。

2. **失败必须降级，不许抛**。artifact 缺失、schema 哈希不匹配、ml 依赖没装
   （requirements-ml.txt 是独立的，G-06 明确不让它进主依赖），任何一种情况都
   返回 `loaded=False` + 人话原因，接口照常 200。前端据此显示降级条，
   告警仍由 `alarm_service` 的阈值规则产生，系统功能不残缺。

3. **推理要带预热段**。特征里有 150 点（300 秒）的长窗口，只取 [start, end]
   会让开头 150 行的滑窗统计只有一半样本、方差偏大，分数系统性偏低——
   表现为"曲线开头有一段假的平静"。所以往 start 之前多取 300 秒，算完再裁掉。
   `warmup_available=False` 时说明这段时间库里没数据（例如历史起点），
   前端可以据此提示首段不可信。

为什么推理入口放在 app/ 而不是 ml/：ml/ 是可独立运行的离线训练代码，不依赖
FastAPI 与数据库连接池；app/ 侧只 import 它的纯函数（特征工程），不 import
它的训练脚本。这条边界保证"训练环境"与"服务环境"不会互相拖累。
"""

from __future__ import annotations

import json
import logging
import math
import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import text

from app.config import settings
from app.db import engine
from app.errors import ApiError
from app.constants import ErrorCode
from app.utils import iso

logger = logging.getLogger(__name__)

# 四个基线模型的展示名与顺序（顺序即前端柱子顺序，前端不再自己排）
BASELINE_ORDER: tuple[tuple[str, str], ...] = (
    ("threshold_rule", "阈值规则"),
    ("logistic_regression", "逻辑回归"),
    ("isolation_forest", "IsolationForest"),
    ("xgboost", "XGBoost"),
)


@dataclass(frozen=True)
class ModelState:
    """一次加载的结果。loaded=False 时除 degraded_reason 外的字段都可能是 None。"""

    loaded: bool
    degraded_reason: str | None = None
    model_id: str | None = None
    algorithm: str = "xgboost"
    trained_at: str | None = None
    git_commit: str | None = None
    schema_hash: str | None = None
    schema_match: bool = False
    expected_schema_hash: str | None = None
    feature_count: int = 0
    dataset_rows: int | None = None
    dataset_positive_rows: int | None = None
    positive_rate: float | None = None
    threshold: float | None = None
    type_labels: tuple[str, ...] = ()
    top_features: tuple[dict[str, Any], ...] = ()
    baselines: tuple[dict[str, Any], ...] = ()
    # 真实对象，不进 JSON 序列化路径（路由层只用上面那些标量）
    meta: dict[str, Any] = field(default_factory=dict)
    binary: Any = None
    type_model: Any = None


_STATE: ModelState | None = None
_LOCK = threading.Lock()


def reset_state() -> None:
    """测试用：丢弃已加载状态，下一次 get_state() 重新读盘。"""
    global _STATE
    with _LOCK:
        _STATE = None


def _degraded(reason: str, **extra: Any) -> ModelState:
    logger.warning("异常检测模型未加载，已降级回阈值规则：%s", reason)
    return ModelState(loaded=False, degraded_reason=reason, **extra)


def _load_from_disk() -> ModelState:
    if not settings.ml_enabled:
        return _degraded("配置 ML_ENABLED=false，强制使用阈值规则")

    artifacts = Path(settings.ml_artifacts_dir)
    meta_path = artifacts / "anomaly_meta.json"
    if not meta_path.exists():
        return _degraded(f"未找到模型元数据：{meta_path}（先跑 ml.anomaly_detection.train）")

    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return _degraded(f"模型元数据读取失败：{exc}")

    # ml 依赖是单独的 requirements-ml.txt（G-06）。没装时这里会 ImportError，
    # 而不是让整个后端起不来——这是把 import 放在函数内而不是模块顶部的唯一原因。
    try:
        import joblib
        import numpy as np
        import pandas as pd  # noqa: F401  （build_features 需要，提前暴露缺失）

        from ml.common.features import feature_names, load_device_specs, schema_hash
    except ImportError as exc:
        return _degraded(f"未安装 ml 依赖（{exc}）：pip install -r requirements-ml.txt")

    files = meta.get("files") or {}
    binary_name = files.get("binary")
    if not binary_name:
        return _degraded("模型元数据缺少 files.binary 字段，artifact 不可定位")
    binary_path = artifacts / binary_name
    if not binary_path.exists():
        return _degraded(f"模型文件不存在：{binary_path}")

    # schema 校验：训练侧与推理侧的特征定义必须逐字节一致，否则分数是噪声。
    # 这种不一致不会抛异常，只会让线上效果莫名变差，所以必须显式比对。
    expected = meta.get("schema_hash")
    current = schema_hash()
    if expected != current:
        return _degraded(
            f"特征 schema 不匹配（artifact {expected} ≠ 当前 {current}），模型已过期，请重新训练",
            expected_schema_hash=expected,
            schema_hash=current,
            model_id=meta.get("model_id"),
        )
    trained_names = list(meta.get("feature_names") or [])
    if trained_names != feature_names():
        return _degraded(
            f"特征名或顺序与 artifact 不一致（artifact {len(trained_names)} 维，当前 {len(feature_names())} 维）",
            expected_schema_hash=expected,
            schema_hash=current,
            model_id=meta.get("model_id"),
        )

    try:
        binary = joblib.load(binary_path)
        type_model = None
        type_name = files.get("type")
        if type_name and (artifacts / type_name).exists():
            type_model = joblib.load(artifacts / type_name)
    except Exception as exc:  # joblib 反序列化可能抛任何东西（版本不符、文件截断）
        return _degraded(f"模型文件加载失败：{type(exc).__name__}: {exc}", model_id=meta.get("model_id"))

    metrics = meta.get("metrics") or {}
    xgb_metrics = metrics.get("xgboost") or {}
    dataset_meta = meta.get("dataset_meta") or {}

    baselines: list[dict[str, Any]] = []
    for key, label in BASELINE_ORDER:
        item = metrics.get(key)
        if not item:
            continue
        interval = item.get("interval") or {}
        baselines.append(
            {
                "key": key,
                "label": label,
                "pr_auc": item.get("pr_auc"),
                "precision": item.get("precision"),
                "recall": item.get("recall"),
                "f1": item.get("f1"),
                "threshold": item.get("threshold"),
                "detection_rate": interval.get("detection_rate"),
                "false_alarms_per_device_hour": item.get("false_alarms_per_device_hour"),
                "is_primary": key == "xgboost",
            }
        )

    state = ModelState(
        loaded=True,
        model_id=meta.get("model_id"),
        algorithm="xgboost",
        trained_at=meta.get("trained_at"),
        git_commit=meta.get("git_commit"),
        schema_hash=current,
        schema_match=True,
        expected_schema_hash=expected,
        feature_count=len(feature_names()),
        dataset_rows=dataset_meta.get("rows") or meta.get("dataset_rows"),
        dataset_positive_rows=dataset_meta.get("positive_rows"),
        positive_rate=dataset_meta.get("positive_rate"),
        threshold=meta.get("threshold"),
        type_labels=tuple(meta.get("type_labels") or ()),
        top_features=tuple(meta.get("top_features") or ()),
        baselines=tuple(baselines),
        meta=meta,
        binary=binary,
        type_model=type_model,
    )
    assert xgb_metrics  # 只为确认字段存在于 meta；缺失时上面的 baselines 会是空列表
    logger.info(
        "异常检测模型已加载：%s（%s 维特征，阈值 %.4f）",
        state.model_id,
        state.feature_count,
        state.threshold or 0.0,
    )
    return state


def get_state() -> ModelState:
    """当前模型状态。首次调用时加载，之后走内存；加载失败也缓存（不反复读盘）。"""
    global _STATE
    if _STATE is not None:
        return _STATE
    with _LOCK:
        if _STATE is None:
            try:
                _STATE = _load_from_disk()
            except Exception as exc:  # 兜底：任何未预料的异常都不许冒到接口层
                _STATE = _degraded(f"模型加载过程异常：{type(exc).__name__}: {exc}")
        return _STATE


# --------------------------------------------------------------------------- #
# 对外三个载荷
# --------------------------------------------------------------------------- #
def model_info() -> dict[str, Any]:
    """AI 页顶部指标卡的数据源。降级时也返回 200，只是 loaded=false。"""
    state = get_state()
    payload: dict[str, Any] = {
        "loaded": state.loaded,
        "degraded_reason": state.degraded_reason,
        "model_id": state.model_id,
        "algorithm": state.algorithm,
        "trained_at": state.trained_at,
        "git_commit": state.git_commit,
        "schema_hash": state.schema_hash,
        "schema_match": state.schema_match,
        "feature_count": state.feature_count,
        "dataset_rows": state.dataset_rows,
        "dataset_positive_rows": state.dataset_positive_rows,
        "positive_rate": state.positive_rate,
        "threshold": state.threshold,
        "type_labels": list(state.type_labels),
        "top_features": list(state.top_features[:8]),
        "baselines": list(state.baselines),
        "artifacts_dir": settings.ml_artifacts_dir,
    }
    if not state.loaded:
        payload["metrics"] = None
        return payload

    primary = next((item for item in state.baselines if item["key"] == "xgboost"), None)
    metrics_meta = (state.meta.get("metrics") or {}).get("xgboost") or {}
    confusion = metrics_meta.get("confusion") or {}
    interval = metrics_meta.get("interval") or {}
    test_rows = sum(int(confusion.get(k) or 0) for k in ("tn", "fp", "fn", "tp"))
    payload["metrics"] = {
        "pr_auc": (primary or {}).get("pr_auc"),
        "f1_macro": (primary or {}).get("f1"),
        "precision": (primary or {}).get("precision"),
        "recall": (primary or {}).get("recall"),
        "roc_auc": metrics_meta.get("roc_auc"),
        "detection_rate": interval.get("detection_rate"),
        "intervals_detected": interval.get("intervals_detected"),
        "intervals_with_rows": interval.get("intervals_with_rows"),
        "median_delay_seconds": interval.get("median_delay_seconds"),
        "false_alarms_per_device_hour": (primary or {}).get("false_alarms_per_device_hour"),
        "test_rows": test_rows,
        "test_positives": int(confusion.get("tp") or 0) + int(confusion.get("fn") or 0),
    }
    return payload


def confusion() -> dict[str, Any]:
    """混淆矩阵。取自训练时的离线测试集，不是实时结果——页面上必须标明这一点。"""
    state = get_state()
    if not state.loaded:
        raise ApiError(
            503,
            ErrorCode.ML_UNAVAILABLE,
            f"模型未加载，无混淆矩阵：{state.degraded_reason}",
            {"degraded_reason": state.degraded_reason},
        )
    metrics_meta = (state.meta.get("metrics") or {}).get("xgboost") or {}
    c = metrics_meta.get("confusion") or {}
    tn, fp, fn, tp = (int(c.get(k) or 0) for k in ("tn", "fp", "fn", "tp"))
    return {
        "model_id": state.model_id,
        "matrix": [[tn, fp], [fn, tp]],
        "labels": ["正常", "异常"],
        "threshold": state.threshold,
        "pr_auc": metrics_meta.get("pr_auc"),
        "roc_auc": metrics_meta.get("roc_auc"),
        "test_rows": tn + fp + fn + tp,
        "test_positives": tp + fn,
        "note": "离线测试集（按时间切分的最后 15%）结果，不是页面上那台设备的实时表现",
    }


SCORE_SQL = """
SELECT ts, temperature, vibration, current, speed, running_status
FROM device_telemetry
WHERE device_id = :device_id AND ts >= :start AND ts <= :end
ORDER BY ts
"""

INTERVAL_SQL = """
SELECT id, anomaly_type, started_at, ended_at
FROM anomaly_injection
WHERE device_id = :device_id
  AND started_at <= :end
  AND COALESCE(ended_at, :end) >= :start
ORDER BY started_at
"""


def _load_raw(device_id: str, start: datetime, end: datetime) -> Any:
    import pandas as pd

    with engine.connect() as conn:
        frame = pd.read_sql(
            text(SCORE_SQL), conn, params={"device_id": device_id, "start": start, "end": end}
        )
    return frame


def _load_intervals(device_id: str, start: datetime, end: datetime) -> list[dict[str, Any]]:
    with engine.connect() as conn:
        rows = conn.execute(
            text(INTERVAL_SQL), {"device_id": device_id, "start": start, "end": end}
        ).all()
    return [
        {
            "id": int(r.id),
            "anomaly_type": r.anomaly_type,
            "started_at": iso(max(r.started_at, start)),
            "ended_at": iso(min(r.ended_at, end) if r.ended_at else end),
        }
        for r in rows
    ]


def _baseline_for(meta: dict[str, Any], device_id: str) -> dict[str, tuple[float, float]] | None:
    raw = ((meta.get("dataset_meta") or {}).get("baseline_train_only") or {}).get(device_id)
    if not raw:
        return None
    return {metric: (float(pair[0]), float(pair[1])) for metric, pair in raw.items()}


def _predict(frame: Any, spec: Any, baseline: dict[str, tuple[float, float]], state: ModelState) -> tuple[Any, Any, list[str | None]]:
    """返回（分数, 是否判为异常, 归因标签）。标签只在判为异常时有值。"""
    import numpy as np

    from ml.common.features import build_features

    matrix = build_features(frame, spec, baseline)
    probabilities = state.binary.predict_proba(matrix)
    scores = np.asarray(probabilities[:, 1], dtype="float64")
    threshold = float(state.threshold or 0.5)
    flags = scores >= threshold

    labels: list[str | None] = [None] * len(scores)
    if state.type_model is not None and bool(flags.any()):
        idx = np.flatnonzero(flags)
        predicted = state.type_model.predict(matrix[idx])
        for position, code in zip(idx.tolist(), predicted.tolist()):
            code_int = int(code)
            if 0 <= code_int < len(state.type_labels):
                labels[position] = state.type_labels[code_int]
    return scores, flags, labels


def _downsample(
    ts_list: list[Any], scores: Any, flags: Any, labels: list[str | None], limit: int
) -> tuple[list[dict[str, Any]], int]:
    """超过点数上限时按"区间取峰值"降采样。

    不能简单地每 step 取一条：那样 40 秒的 VIB_SPIKE 会被整段跳过，
    曲线看起来"什么都没发生"，而模型其实抓到了。所以按组取 max(score)、
    any(is_anomaly)、第一个非空标签——保住尖峰，只压缩平坦段。
    """
    import pandas as pd

    total = len(scores)
    step = max(1, math.ceil(total / limit))
    if step == 1:
        points = [
            {
                "ts": iso(ts),
                "score": round(float(score), 6),
                "is_anomaly": bool(flag),
                "label_type": label,
            }
            for ts, score, flag, label in zip(ts_list, scores, flags, labels)
        ]
        return points, 1

    frame = pd.DataFrame(
        {"ts": ts_list, "score": scores, "is_anomaly": flags, "label_type": labels}
    )
    frame["bucket"] = range(total)
    frame["bucket"] //= step
    grouped = frame.groupby("bucket", sort=True)
    points = []
    for _, group in grouped:
        first_label = next((v for v in group["label_type"].tolist() if v), None)
        peak = group.loc[group["score"].idxmax()]
        points.append(
            {
                "ts": iso(peak["ts"]),
                "score": round(float(peak["score"]), 6),
                "is_anomaly": bool(group["is_anomaly"].any()),
                "label_type": first_label,
            }
        )
    return points, step


def score_window(device_id: str, start: datetime, end: datetime, limit: int) -> dict[str, Any]:
    """对一台设备的一个时间窗做实时推理。

    为什么实时算而不是查缓存表：页面上的曲线必须反映"当前模型 + 当前数据"。
    缓存表（`anomaly_scores`）是离线存档，两者职责不同，见 schema.sql 的注释。

    **窗口边界先归整到整秒**：响应体里的 start/end 走 `iso()`，它按 `timespec="seconds"` 输出，
    会把微秒截掉。如果查询用原始微秒精度，就会出现"回显的窗口"与"实际查询的窗口"不是同一个，
    拿回显值重放会多算或少算边界上的那一行（实测 976 vs 977）。
    这里先归整再查，保证「回显的就是查过的」。
    """
    start = start.astimezone(UTC).replace(microsecond=0)
    end = end.astimezone(UTC).replace(microsecond=0)

    state = get_state()
    if not state.loaded:
        raise ApiError(
            503,
            ErrorCode.ML_UNAVAILABLE,
            f"模型未加载，无法实时推理：{state.degraded_reason}",
            {"degraded_reason": state.degraded_reason},
        )

    import pandas as pd

    from ml.common.features import load_device_specs

    specs = load_device_specs()
    spec = specs.get(device_id)
    if spec is None:
        raise ApiError(404, ErrorCode.DEVICE_NOT_FOUND, f"设备 {device_id} 不在设备配置里", {"device_id": device_id})

    baseline = _baseline_for(state.meta, device_id)
    if baseline is None:
        raise ApiError(
            422,
            ErrorCode.INVALID_PARAM,
            f"模型 artifact 里没有 {device_id} 的训练基线，无法归一化",
            {"device_id": device_id},
        )

    warm_start = start - timedelta(seconds=settings.ml_warmup_seconds)
    frame = _load_raw(device_id, warm_start, end)
    if len(frame) > settings.ml_max_rows:
        raise ApiError(
            400,
            ErrorCode.RANGE_TOO_LARGE,
            f"该窗口有 {len(frame)} 行读数，超过单次推理上限 {settings.ml_max_rows}，请缩短时间范围",
            {"rows": len(frame), "max": settings.ml_max_rows},
        )
    if frame.empty:
        return {
            "device_id": device_id,
            "start": iso(start),
            "end": iso(end),
            "model_id": state.model_id,
            "threshold": state.threshold,
            "generated_at": iso(datetime.now(UTC)),
            "warmup_rows": 0,
            "warmup_available": False,
            "raw_count": 0,
            "downsample_step": 1,
            "count": 0,
            "points": [],
            "summary": {"predicted_rows": 0, "predicted_rate": 0.0, "max_score": None, "mean_score": None},
            "intervals": [],
        }

    frame["ts"] = pd.to_datetime(frame["ts"], utc=True)

    # 预热段与目标段的切分：warm 段只参与特征计算，不返回。
    mask = (frame["ts"] >= start).to_numpy()
    warmup_rows = int((~mask).sum())
    scores, flags, labels = _predict(frame, spec, baseline, state)

    # build_features 返回的矩阵与 frame 行一一对应，所以可以直接按布尔掩码对齐。
    target_scores = scores[mask]
    target_flags = flags[mask]
    target_labels = [label for label, keep in zip(labels, mask.tolist()) if keep]
    target_ts = frame.loc[mask, "ts"].tolist()

    points, step = _downsample(target_ts, target_scores, target_flags, target_labels, limit)
    total = len(target_scores)
    return {
        "device_id": device_id,
        "start": iso(start),
        "end": iso(end),
        "model_id": state.model_id,
        "threshold": state.threshold,
        "generated_at": iso(datetime.now(UTC)),
        "warmup_rows": warmup_rows,
        "warmup_available": warmup_rows >= (settings.ml_warmup_seconds // 2),
        "raw_count": total,
        "downsample_step": step,
        "count": len(points),
        "points": points,
        "summary": {
            "predicted_rows": int(target_flags.sum()),
            "predicted_rate": round(float(target_flags.sum()) / total, 4) if total else 0.0,
            "max_score": round(float(target_scores.max()), 6) if total else None,
            "mean_score": round(float(target_scores.mean()), 6) if total else None,
        },
        "intervals": _load_intervals(device_id, start, end),
    }
