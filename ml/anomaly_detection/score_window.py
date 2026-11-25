"""批量打分并写入 anomaly_scores（spec_phase4 G-07）。

定位是**离线存档**，不是前端的数据源：
- 前端曲线走 `/ml/anomaly/scores` 实时推理，保证页面反映"当前模型 + 当前数据"；
- 这张表服务于 D 块（故障风险打分）、论文复现、以及"三个月前那条告警当初是
  哪个模型、打了多少分"这类事后追溯。

反过来说，为什么不让前端读表：批处理是快照，页面就成了"上次跑批时的样子"，
换个模型或补一段数据都要重跑批，而页面上看不出这份数据有多旧。

本脚本**复用** `app/services/ml_anomaly.py` 的推理入口，而不是在 ml/ 里重写一遍：
特征与预热逻辑只能有一份实现，两份必然漂移（这正是 features.py 顶部那条约定的由来）。

跑法：
    python -m ml.anomaly_detection.register_model        # 先把模型登记进 model_versions
    python -m ml.anomaly_detection.score_window --hours 1
    python -m ml.anomaly_detection.score_window --hours 1 --device CNC-01
"""

from __future__ import annotations

import argparse
import time
from datetime import UTC, datetime, timedelta

from sqlalchemy import text

from app.config import settings
from app.constants import ErrorCode
from app.errors import ApiError
from app.services import ml_anomaly
from ml.common import db

INSERT_SQL = """
INSERT INTO anomaly_scores (device_id, ts, model_id, score, is_anomaly, label_type, interval_id)
VALUES (:device_id, :ts, :model_id, :score, :is_anomaly, :label_type, NULL)
ON CONFLICT (device_id, ts, model_id) DO NOTHING
"""


def active_model_id() -> str:
    with db.engine().connect() as conn:
        row = conn.execute(
            text(
                """
                SELECT model_id FROM model_versions
                WHERE task = 'anomaly_binary' AND is_active
                """
            )
        ).first()
    if row is None:
        raise SystemExit("model_versions 里没有生效版本，先跑 python -m ml.anomaly_detection.register_model")
    return row.model_id


def device_ids() -> list[str]:
    with db.engine().connect() as conn:
        rows = conn.execute(text("SELECT device_id FROM devices ORDER BY device_id")).all()
    return [r.device_id for r in rows]


def score_device(device_id: str, start: datetime, end: datetime, model_id: str) -> tuple[int, int, float]:
    """返回（写入行数, 判为异常点数, 耗时秒）。"""
    started = time.perf_counter()
    try:
        payload = ml_anomaly.score_window(device_id, start, end, settings.ml_max_rows)
    except ApiError as exc:
        if exc.code == ErrorCode.DEVICE_NOT_FOUND.value:
            return 0, 0, 0.0
        raise
    elapsed = time.perf_counter() - started

    points = payload["points"]
    if not points:
        return 0, 0, elapsed

    rows = [
        {
            "device_id": device_id,
            # 接口输出是 ISO 8601 带 +00:00 偏移，psycopg 直接收 datetime
            "ts": datetime.fromisoformat(point["ts"]),
            "model_id": model_id,
            "score": float(point["score"]),
            "is_anomaly": bool(point["is_anomaly"]),
            "label_type": point["label_type"],
        }
        for point in points
    ]
    with db.engine().begin() as conn:
        conn.execute(text(INSERT_SQL), rows)
    anomalies = sum(1 for row in rows if row["is_anomaly"])
    return len(rows), anomalies, elapsed


def main() -> None:
    parser = argparse.ArgumentParser(description="批量打分写入 anomaly_scores")
    parser.add_argument("--hours", type=float, default=1.0, help="回看小时数（默认 1）")
    parser.add_argument("--device", default=None, help="只打分这一台设备（默认全部）")
    parser.add_argument(
        "--end",
        default=None,
        help="窗口终点（ISO 8601），默认现在。指定固定终点可复现同一批结果",
    )
    args = parser.parse_args()

    model_id = active_model_id()
    end = datetime.fromisoformat(args.end).astimezone(UTC) if args.end else datetime.now(UTC)
    start = end - timedelta(hours=args.hours)
    targets = [args.device] if args.device else device_ids()

    with db.engine().connect() as conn:
        before = conn.execute(
            text("SELECT count(*) FROM anomaly_scores WHERE model_id = :m"), {"m": model_id}
        ).scalar_one()

    print(f"模型 {model_id}")
    print(f"窗口 {start.isoformat(timespec='seconds')} ~ {end.isoformat(timespec='seconds')}（{args.hours} 小时）")
    print(f"设备 {len(targets)} 台\n")

    total_rows = total_anomalies = 0
    slowest = (0.0, "")
    for device_id in targets:
        rows, anomalies, elapsed = score_device(device_id, start, end, model_id)
        total_rows += rows
        total_anomalies += anomalies
        if elapsed > slowest[0]:
            slowest = (elapsed, device_id)
        if rows:
            print(f"  {device_id:<10} {rows:>6} 行  异常 {anomalies:>4} 点  {elapsed * 1000:>6.0f} ms")

    with db.engine().connect() as conn:
        after = conn.execute(
            text("SELECT count(*) FROM anomaly_scores WHERE model_id = :m"), {"m": model_id}
        ).scalar_one()
    inserted = after - before
    # 提交行数与新增行数可能不等：ON CONFLICT DO NOTHING 会跳过分区键完全相同的行
    # （同一设备同一毫秒出现两次）。两个数都报出来，免得对数时以为丢数据。
    print(
        f"\n提交 {total_rows:,} 行（异常 {total_anomalies:,} 点），"
        f"实际新增 {inserted:,} 行，跳过重复 {total_rows - inserted} 行；"
        f"最慢 {slowest[1]} {slowest[0] * 1000:.0f} ms（含首次加载模型）"
    )
    print(f"该模型在库内的分数行数：{after:,}")


if __name__ == "__main__":
    main()
