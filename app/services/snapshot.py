"""全厂快照组装（规格 5.2）。

每 1 秒推一次 14 台设备的快照：14 台全量约 2 KB，前端一次拿全厂状态，
三维场景只需要一个渲染循环，不用为每台设备维护订阅（G-13）。
"""

from __future__ import annotations

import itertools
from threading import Lock

from sqlalchemy import text

from app.constants import METRIC_DIGITS
from app.db import session_scope
from app.utils import iso, utcnow

_seq_counter = itertools.count(1)
_seq_lock = Lock()

_QUERY = text(
    """
    SELECT d.device_id, d.device_name, d.device_type, d.workshop_id, d.line_id, d.status,
           t.ts, t.temperature, t.vibration, t.current, t.speed, t.running_status,
           COALESCE(ac.open_count, 0) AS open_alarm_count,
           (an.device_id IS NOT NULL) AS in_anomaly
    FROM devices d
    LEFT JOIN LATERAL (
        SELECT ts, temperature, vibration, current, speed, running_status
        FROM device_telemetry x
        WHERE x.device_id = d.device_id
        ORDER BY x.ts DESC
        LIMIT 1
    ) t ON TRUE
    LEFT JOIN (
        SELECT device_id, count(*) AS open_count
        FROM alarms WHERE resolved_at IS NULL GROUP BY device_id
    ) ac ON ac.device_id = d.device_id
    LEFT JOIN (
        SELECT DISTINCT device_id FROM anomaly_injection WHERE ended_at IS NULL
    ) an ON an.device_id = d.device_id
    ORDER BY d.device_id
    """
)


def _next_seq() -> int:
    with _seq_lock:
        return next(_seq_counter)


def _round(value: float | None, metric: str) -> float | int | None:
    if value is None:
        return None
    digits = METRIC_DIGITS[metric]
    return round(float(value), digits) if digits else int(round(float(value)))


def build_snapshot() -> dict:
    """查库组装一条 snapshot 消息。返回结构见规格 5.2。"""
    with session_scope() as db:
        rows = db.execute(_QUERY).all()

    devices: list[dict] = []
    running = idle = stopped = alarm = maintenance = open_total = 0
    for r in rows:
        status = r.status
        if status == "RUNNING":
            running += 1
        elif status == "IDLE":
            idle += 1
        elif status == "STOPPED":
            stopped += 1
        elif status == "ALARM":
            alarm += 1
        elif status == "MAINTENANCE":
            maintenance += 1
        open_total += int(r.open_alarm_count)

        devices.append(
            {
                "device_id": r.device_id,
                "device_name": r.device_name,
                "device_type": r.device_type,
                "workshop_id": r.workshop_id,
                "line_id": r.line_id,
                "status": status,
                "open_alarm_count": int(r.open_alarm_count),
                # 设备可能还没有任何遥测（刚建库），此时 ts/metrics 为 null
                "ts": iso(r.ts),
                "metrics": None
                if r.ts is None
                else {
                    "temperature": _round(r.temperature, "temperature"),
                    "vibration": _round(r.vibration, "vibration"),
                    "current": _round(r.current, "current"),
                    "speed": _round(r.speed, "speed"),
                },
                "running_status": r.running_status,
                "in_anomaly": bool(r.in_anomaly),
            }
        )

    return {
        "type": "snapshot",
        "server_time": iso(utcnow()),
        "seq": _next_seq(),
        "device_count": len(devices),
        "summary": {
            "running": running,
            "idle": idle,
            "stopped": stopped,
            "alarm": alarm,
            "maintenance": maintenance,
            "open_alarm_count": open_total,
        },
        "devices": devices,
    }
