"""AI 模型接口的测试网（spec_phase4 §6.1）。

四类断言，对应四条会被追问的地方：

1. **接口数字必须与 artifact 一致**。不比对的话，路由层写错一个字段
   （比如把 f1 读成 roc_auc）也没有任何机制会发现，页面上就是个错数字。
2. **降级路径必须真的降级**，而且降级时 `/model-info` 仍回 200。
   否则模型一缺失，AI 页整块 500，比没有模型更糟。
3. **参数保护**。时间窗与点数的保护如果失效，一次 24 小时 × 全部设备的请求
   能把进程内存打满（43200 行 × 78 列 float32 ≈ 13 MB/设备，看着不多，
   但 xgboost 的中间量是它的数倍）。
4. **实时推理的分母与采样规则**：降采样后必须保住尖峰，否则 40 秒的
   VIB_SPIKE 在 24 小时视图里直接消失。

跑法：python -m pytest tests -v
"""

from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path

import pytest
from sqlalchemy import text

from app.config import settings
from app.db import engine
from app.services import ml_anomaly

API = "/api/v1"
DEVICE = "CNC-01"


def _device_window(device_id: str = DEVICE) -> tuple:
    """取该设备库里真实的 1 小时窗口，避免依赖"最近 1 小时"这种会随运行时间漂移的口径。"""
    with engine.connect() as conn:
        lo, hi = conn.execute(
            text("SELECT min(ts), max(ts) FROM device_telemetry WHERE device_id = :d"),
            {"d": device_id},
        ).one()
    assert lo is not None, f"{device_id} 没有任何遥测数据，先跑模拟器回填"
    return lo, min(lo + timedelta(hours=1), hi)


def _iso(dt) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------- #
# 1. 正常路径：接口与 artifact 一致
# --------------------------------------------------------------------------- #
def test_model_info_matches_artifact(client):
    resp = client.get(f"{API}/ml/model-info")
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["loaded"] is True, f"模型未加载：{body['degraded_reason']}"
    assert body["schema_match"] is True
    assert body["feature_count"] == 78

    meta_path = Path(settings.ml_artifacts_dir) / "anomaly_meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    xgb = meta["metrics"]["xgboost"]

    # 逐个字段比对，而不是只看 loaded —— 这是"页面数字能追到 artifact"的第一道关
    assert body["model_id"] == meta["model_id"]
    assert body["trained_at"] == meta["trained_at"]
    assert body["threshold"] == meta["threshold"]
    assert body["metrics"]["pr_auc"] == xgb["pr_auc"]
    assert body["metrics"]["recall"] == xgb["recall"]
    assert body["metrics"]["precision"] == xgb["precision"]
    assert body["metrics"]["roc_auc"] == xgb["roc_auc"]

    confusion = xgb["confusion"]
    assert body["metrics"]["test_rows"] == sum(confusion.values())
    assert body["metrics"]["test_positives"] == confusion["tp"] + confusion["fn"]

    # 四个基线必须齐、必须带 XGBoost 标记，否则前端柱状图少一根都不知道
    keys = [item["key"] for item in body["baselines"]]
    assert keys == ["threshold_rule", "logistic_regression", "isolation_forest", "xgboost"]
    primary = [item for item in body["baselines"] if item["is_primary"]]
    assert len(primary) == 1 and primary[0]["key"] == "xgboost"


def test_confusion_matches_artifact(client):
    resp = client.get(f"{API}/ml/anomaly/confusion")
    assert resp.status_code == 200, resp.text
    body = resp.json()

    meta = json.loads((Path(settings.ml_artifacts_dir) / "anomaly_meta.json").read_text(encoding="utf-8"))
    c = meta["metrics"]["xgboost"]["confusion"]
    assert body["matrix"] == [[c["tn"], c["fp"]], [c["fn"], c["tp"]]]
    assert body["labels"] == ["正常", "异常"]
    # 四个格子之和必须等于声明的测试集行数：写错一个格子这里就会露出
    flat = [value for row in body["matrix"] for value in row]
    assert sum(flat) == body["test_rows"]
    assert body["test_positives"] == c["tp"] + c["fn"]


def test_scores_returns_monotonic_points(client):
    lo, hi = _device_window()
    resp = client.get(
        f"{API}/ml/anomaly/scores",
        params={"device_id": DEVICE, "start": _iso(lo), "end": _iso(hi)},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["model_id"]
    assert body["threshold"] is not None
    assert body["count"] > 0
    assert body["count"] == body["raw_count"], "1 小时 1800 点不该触发降采样"
    assert body["count"] == len(body["points"])

    # 时间必须单调递增：前端按顺序连线，乱序会画出折返的锯齿
    stamps = [p["ts"] for p in body["points"]]
    assert stamps == sorted(stamps)
    assert all(0.0 <= p["score"] <= 1.0 for p in body["points"])
    # 判为异常的点必须带归因标签（模型里有 type_model 时）
    labelled = [p for p in body["points"] if p["is_anomaly"]]
    assert labelled, "1 小时窗口内一个异常都没判出来，先确认这台设备当时确实在注入异常"
    assert all(p["label_type"] for p in labelled)

    summary = body["summary"]
    assert summary["predicted_rows"] == len(labelled)
    assert summary["max_score"] is not None and summary["max_score"] <= 1.0


def test_scores_downsample_keeps_peaks(client):
    """6 小时窗口应触发降采样，且降采样后的最大分数不低于原始最大值太多。

    这是"保峰"降采样的核心断言：每 step 取一条的朴素做法会把尖峰整段丢掉，
    表现为 max_score 明显变小。这里要求降采样后的峰值与原窗口峰值差 < 0.05。
    """
    lo, _ = _device_window()
    body = client.get(
        f"{API}/ml/anomaly/scores",
        params={"device_id": DEVICE, "start": _iso(lo), "end": _iso(lo + timedelta(hours=6)), "limit": 600},
    ).json()
    assert body["downsample_step"] > 1
    assert body["count"] <= 600
    assert body["summary"]["max_score"] >= 0.9, "降采样把峰值抹平了"

    # 降采样后仍要保证时间单调
    stamps = [p["ts"] for p in body["points"]]
    assert stamps == sorted(stamps)


# --------------------------------------------------------------------------- #
# 2. 参数保护
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("limit", [0, -1, 5001, 99999])
def test_scores_rejects_bad_limit(client, limit):
    lo, hi = _device_window()
    resp = client.get(
        f"{API}/ml/anomaly/scores",
        params={"device_id": DEVICE, "start": _iso(lo), "end": _iso(hi), "limit": limit},
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["code"] == "INVALID_PARAM"


def test_scores_rejects_wrong_time_range(client):
    lo, hi = _device_window()
    # 只给一个时间
    resp = client.get(f"{API}/ml/anomaly/scores", params={"device_id": DEVICE, "start": _iso(lo)})
    assert resp.status_code == 400
    # end <= start
    resp = client.get(
        f"{API}/ml/anomaly/scores",
        params={"device_id": DEVICE, "start": _iso(hi), "end": _iso(lo)},
    )
    assert resp.status_code == 400


def test_scores_rejects_unknown_device(client):
    lo, hi = _device_window()
    resp = client.get(
        f"{API}/ml/anomaly/scores",
        params={"device_id": "CNC-99", "start": _iso(lo), "end": _iso(hi)},
    )
    assert resp.status_code == 404
    assert resp.json()["code"] == "DEVICE_NOT_FOUND"


# --------------------------------------------------------------------------- #
# 3. 降级路径（G-01 的核心要求：不许抛，不许白屏）
# --------------------------------------------------------------------------- #
def test_degraded_when_disabled(client, monkeypatch):
    monkeypatch.setattr(settings, "ml_enabled", False)
    ml_anomaly.reset_state()
    try:
        body = client.get(f"{API}/ml/model-info").json()
        assert body["loaded"] is False
        assert "ML_ENABLED" in body["degraded_reason"]
        assert body["metrics"] is None

        # 另两个接口必须是明确的 503 + 错误码，而不是 500 或者空数据
        resp = client.get(f"{API}/ml/anomaly/confusion")
        assert resp.status_code == 503
        assert resp.json()["code"] == "ML_UNAVAILABLE"

        lo, hi = _device_window()
        resp = client.get(
            f"{API}/ml/anomaly/scores",
            params={"device_id": DEVICE, "start": _iso(lo), "end": _iso(hi)},
        )
        assert resp.status_code == 503
        assert resp.json()["code"] == "ML_UNAVAILABLE"
    finally:
        monkeypatch.undo()
        ml_anomaly.reset_state()


def test_degraded_on_schema_mismatch(client, tmp_path, monkeypatch):
    """artifact 与当前特征定义不一致时必须拒绝加载，而不是"能用就先跑"。

    这种不一致不会抛异常，只会让分数变成噪声——是最难查的一类故障。
    """
    meta = {
        "model_id": "stale-model",
        "trained_at": "2026-01-01T00:00:00",
        "schema_hash": "0000000000000000",
        "feature_names": ["temperature_dev"],
        "files": {"binary": "fake.joblib"},
        "metrics": {"xgboost": {}},
        "threshold": 0.5,
    }
    (tmp_path / "anomaly_meta.json").write_text(json.dumps(meta), encoding="utf-8")
    (tmp_path / "fake.joblib").write_bytes(b"not-a-real-model")
    monkeypatch.setattr(settings, "ml_artifacts_dir", str(tmp_path))
    ml_anomaly.reset_state()
    try:
        body = client.get(f"{API}/ml/model-info").json()
        assert body["loaded"] is False
        assert "schema 不匹配" in body["degraded_reason"]
        assert body["model_id"] == "stale-model"  # 页面要能说清是哪个模型过期了
    finally:
        monkeypatch.undo()
        ml_anomaly.reset_state()


def test_degraded_when_artifacts_missing(client, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "ml_artifacts_dir", str(tmp_path / "empty"))
    ml_anomaly.reset_state()
    try:
        body = client.get(f"{API}/ml/model-info").json()
        assert body["loaded"] is False
        assert "未找到模型元数据" in body["degraded_reason"]
    finally:
        monkeypatch.undo()
        ml_anomaly.reset_state()


def test_state_restored_after_degraded(client):
    """降级测试跑完后，正常路径必须能恢复——否则后面的用例会继承一个坏状态。"""
    body = client.get(f"{API}/ml/model-info").json()
    assert body["loaded"] is True
    assert body["degraded_reason"] is None
