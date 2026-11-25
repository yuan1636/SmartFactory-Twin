"""把训练产物登记进 model_versions 表（spec_phase4 G-07）。

为什么不把这个逻辑放进接口：**推理的唯一真相源是 `artifacts/anomaly_meta.json`**。
它由 train.py 写出，与 joblib 文件一一对应；接口启动时读它、校验 schema 哈希、
再加载模型。如果接口改读数据库，就会有两个真相源——某次训练只更新了 artifact
没登记表、或者表里指向的 joblib 已被删，都会让"页面说用的是模型 A、实际跑的是 B"。

所以这张表的定位是**版本历史 + 谁在生效**：
- 事后追溯"这条告警当初是哪个模型判的"；
- D 块（故障风险）需要按 model_id 引用历史分数；
- 换模型后仍能查到上一版的指标，做前后对比。

跑法：
    python -m ml.anomaly_detection.register_model
    python -m ml.anomaly_detection.register_model --meta artifacts/anomaly_meta.json
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path
from typing import Any

from sqlalchemy import text

from ml.common import db
from ml.common.features import BASE_DIR

DEFAULT_META = BASE_DIR / "artifacts" / "anomaly_meta.json"


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value)


def register(meta_path: Path) -> dict[str, Any]:
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    model_id = meta.get("model_id")
    if not model_id:
        raise SystemExit(f"{meta_path} 里没有 model_id，不是 train.py 的产物")

    dataset_meta = meta.get("dataset_meta") or {}
    payload = {
        "model_id": model_id,
        "task": "anomaly_binary",
        "algorithm": meta.get("algorithm", "xgboost"),
        "schema_hash": meta["schema_hash"],
        "trained_at": _parse_ts(meta.get("trained_at")),
        "dataset_rows": dataset_meta.get("rows") or meta.get("dataset_rows"),
        # 整块存四模型对比：报告里要引用"XGBoost vs 阈值规则"的差值，
        # 只存主模型的话事后就查不到基线了
        "metrics": json.dumps(meta.get("metrics") or {}, ensure_ascii=False),
        "artifact_path": str((meta_path.parent / (meta.get("files") or {}).get("binary", "")).resolve()),
    }
    if payload["trained_at"] is None:
        raise SystemExit("meta 里缺少 trained_at，拒绝登记（无法追溯训练时间）")

    with db.engine().begin() as conn:
        # 先把同 task 的其它版本失效：uq_model_active_task 是部分唯一索引，
        # 直接插入 is_active=true 会和已有生效行冲突。
        conn.execute(
            text("UPDATE model_versions SET is_active = false WHERE task = :task AND model_id <> :model_id"),
            {"task": payload["task"], "model_id": model_id},
        )
        conn.execute(
            text(
                """
                INSERT INTO model_versions
                    (model_id, task, algorithm, schema_hash, trained_at,
                     dataset_rows, metrics, artifact_path, is_active)
                VALUES
                    (:model_id, :task, :algorithm, :schema_hash, :trained_at,
                     :dataset_rows, CAST(:metrics AS jsonb), :artifact_path, true)
                ON CONFLICT (model_id) DO UPDATE SET
                    schema_hash   = EXCLUDED.schema_hash,
                    trained_at    = EXCLUDED.trained_at,
                    dataset_rows  = EXCLUDED.dataset_rows,
                    metrics       = EXCLUDED.metrics,
                    artifact_path = EXCLUDED.artifact_path,
                    is_active     = true
                """
            ),
            payload,
        )
        active = conn.execute(
            text(
                """
                SELECT model_id, trained_at, dataset_rows, artifact_path
                FROM model_versions WHERE task = 'anomaly_binary' AND is_active
                """
            )
        ).one()
        total = conn.execute(text("SELECT count(*) FROM model_versions")).scalar_one()

    return {
        "registered": model_id,
        "active": active.model_id,
        "trained_at": active.trained_at,
        "dataset_rows": int(active.dataset_rows or 0),
        "artifact": active.artifact_path,
        "total_versions": int(total),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="登记模型版本到 model_versions")
    parser.add_argument("--meta", type=Path, default=DEFAULT_META, help="训练产物元数据路径")
    args = parser.parse_args()

    result = register(args.meta)
    print("已登记到 model_versions：")
    print(f"  当前生效   {result['active']}")
    print(f"  训练时间   {result['trained_at']}")
    print(f"  训练行数   {result['dataset_rows']:,}")
    print(f"  artifact   {result['artifact']}")
    print(f"  历史版本数 {result['total_versions']}")


if __name__ == "__main__":
    main()
