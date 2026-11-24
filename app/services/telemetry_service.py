"""遥测写入。

写入用 `INSERT ... SELECT FROM unnest(数组...)` + `ON CONFLICT DO NOTHING`：
- 一次请求只有 7 个绑定参数，不管多少行，不会因为 5000 行 × 7 列撑爆参数表；
- 冲突行直接跳过，回填可以重复执行（4.8 要求计入 duplicated 而不是报错）。

本函数是"数据接入层"的唯一入口（L-02）：将来换 Kafka 时，消费者调这一个函数即可。
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import text
from sqlalchemy.orm import Session

_INSERT_SQL = text(
    """
    INSERT INTO device_telemetry
        (device_id, ts, temperature, vibration, current, speed, running_status)
    SELECT * FROM unnest(
        CAST(:device_ids AS varchar[]),
        CAST(:ts AS timestamptz[]),
        CAST(:temperatures AS double precision[]),
        CAST(:vibrations AS double precision[]),
        CAST(:currents AS double precision[]),
        CAST(:speeds AS integer[]),
        CAST(:running_statuses AS varchar[])
    )
    ON CONFLICT (device_id, ts) DO NOTHING
    RETURNING id
    """
)


def save_telemetry(
    db: Session,
    rows: list[dict],
) -> list[int]:
    """写一批遥测，返回真正插入的行主键（冲突被跳过的行不返回）。

    rows 的每个元素需含：device_id / ts / temperature / vibration / current /
    speed / running_status。
    """
    if not rows:
        return []
    result = db.execute(
        _INSERT_SQL,
        {
            "device_ids": [r["device_id"] for r in rows],
            "ts": [r["ts"] for r in rows],
            "temperatures": [float(r["temperature"]) for r in rows],
            "vibrations": [float(r["vibration"]) for r in rows],
            "currents": [float(r["current"]) for r in rows],
            "speeds": [int(r["speed"]) for r in rows],
            "running_statuses": [r["running_status"] for r in rows],
        },
    )
    return [int(row[0]) for row in result.all()]


def existing_device_ids(db: Session, device_ids: list[str]) -> set[str]:
    """批量校验设备是否存在，避免靠外键报错（外键错误信息对使用者不友好）。"""
    if not device_ids:
        return set()
    rows = db.execute(
        text("SELECT device_id FROM devices WHERE device_id = ANY(:ids)"),
        {"ids": list(device_ids)},
    ).all()
    return {r[0] for r in rows}


def save_telemetry_async_placeholder() -> None:
    """预留，本阶段不实现：Kafka 消费者接入时在此封装批量落库。"""
    raise NotImplementedError("预留，本阶段不实现")
