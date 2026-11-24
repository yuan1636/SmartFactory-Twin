"""遥测写入与时序查询（4.7 ~ 4.9）。"""

from __future__ import annotations

import math
import time
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import devices_config, settings
from app.constants import METRIC_DIGITS, ErrorCode
from app.db import get_db
from app.errors import ApiError
from app.schemas import TelemetryBatchIn, TelemetryIn
from app.services.telemetry_service import existing_device_ids, save_telemetry
from app.utils import ensure_aware, iso, round_metrics, time_range

router = APIRouter(tags=["telemetry"])


@router.post("/telemetry", status_code=201, summary="写入单条遥测")
def post_telemetry(body: TelemetryIn, db: Session = Depends(get_db)) -> dict:
    if not existing_device_ids(db, [body.device_id]):
        raise ApiError(404, ErrorCode.DEVICE_NOT_FOUND, f"设备 {body.device_id} 不存在", {"device_id": body.device_id})

    ts = ensure_aware(body.ts)
    row = {
        "device_id": body.device_id,
        "ts": ts,
        "temperature": body.temperature,
        "vibration": body.vibration,
        "current": body.current,
        "speed": body.speed,
        "running_status": body.running_status,
    }
    ids = save_telemetry(db, [row])
    if not ids:
        db.rollback()
        raise ApiError(
            409,
            ErrorCode.DUPLICATE_TELEMETRY,
            f"设备 {body.device_id} 在 {iso(ts)} 已有遥测数据",
            {"device_id": body.device_id, "ts": iso(ts)},
        )
    db.commit()
    return {"id": ids[0], "device_id": body.device_id, "ts": iso(ts), "accepted": True}


@router.post("/telemetry/batch", status_code=201, summary="批量写入遥测（模拟器 tick 与回填都走这里）")
def post_telemetry_batch(body: TelemetryBatchIn, db: Session = Depends(get_db)) -> dict:
    started = time.perf_counter()
    if len(body.items) > settings.telemetry_max_points:
        raise ApiError(
            400,
            ErrorCode.RANGE_TOO_LARGE,
            f"单次最多写入 {settings.telemetry_max_points} 条，收到 {len(body.items)} 条",
            {"count": len(body.items), "max": settings.telemetry_max_points},
        )
    if not body.items:
        return {"accepted": 0, "duplicated": 0, "rejected": 0, "elapsed_ms": 0}

    wanted = {item.device_id for item in body.items}
    found = existing_device_ids(db, sorted(wanted))
    missing = sorted(wanted - found)
    if missing:
        raise ApiError(404, ErrorCode.DEVICE_NOT_FOUND, f"设备不存在：{','.join(missing)}", {"missing": missing})

    rows = [
        {
            "device_id": item.device_id,
            "ts": ensure_aware(item.ts),
            "temperature": item.temperature,
            "vibration": item.vibration,
            "current": item.current,
            "speed": item.speed,
            "running_status": item.running_status,
        }
        for item in body.items
    ]
    ids = save_telemetry(db, rows)
    db.commit()
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    duplicated = len(rows) - len(ids)
    return {"accepted": len(ids), "duplicated": duplicated, "rejected": 0, "elapsed_ms": elapsed_ms}


@router.get("/devices/{device_id}/telemetry", summary="设备时序查询（降采样，单次最多 5000 点）")
def get_device_telemetry(
    device_id: str,
    start: datetime | None = Query(default=None, description="ISO 8601，含时区"),
    end: datetime | None = Query(default=None, description="ISO 8601，含时区"),
    limit: int | None = Query(default=None, description="返回点数上限，默认与上限均为 5000"),
    db: Session = Depends(get_db),
) -> dict:
    exists = db.execute(
        text("SELECT 1 FROM devices WHERE device_id = :device_id"), {"device_id": device_id}
    ).first()
    if exists is None:
        raise ApiError(404, ErrorCode.DEVICE_NOT_FOUND, f"设备 {device_id} 不存在", {"device_id": device_id})

    limit = settings.telemetry_max_points if limit is None else limit
    if limit < 1 or limit > settings.telemetry_max_points:
        raise ApiError(
            400,
            ErrorCode.INVALID_PARAM,
            f"limit 必须在 1~{settings.telemetry_max_points} 之间，收到 {limit}",
            {"limit": limit, "max": settings.telemetry_max_points},
        )

    start_dt, end_dt = time_range(start, end)
    params = {"device_id": device_id, "start": start_dt, "end": end_dt}

    total = db.execute(
        text(
            """
            SELECT count(*) FROM device_telemetry
            WHERE device_id = :device_id AND ts >= :start AND ts <= :end
            """
        ),
        params,
    ).scalar_one()

    # 降采样：总点数超过上限时每 step 条取 1 条（G-17）
    step = max(1, math.ceil(int(total) / limit))
    rows = db.execute(
        text(
            """
            SELECT ts, temperature, vibration, current, speed, running_status
            FROM (
                SELECT ts, temperature, vibration, current, speed, running_status,
                       row_number() OVER (ORDER BY ts) AS rn
                FROM device_telemetry
                WHERE device_id = :device_id AND ts >= :start AND ts <= :end
            ) s
            WHERE mod(rn - 1, :step) = 0
            ORDER BY ts
            """
        ),
        {**params, "step": step},
    ).all()

    points = []
    for r in rows:
        point = {"ts": iso(r.ts), "running_status": r.running_status}
        for metric in METRIC_DIGITS:
            value = getattr(r, metric)
            digits = METRIC_DIGITS[metric]
            point[metric] = None if value is None else (round(float(value), digits) if digits else int(value))
        points.append(round_metrics(point))

    return {
        "device_id": device_id,
        "start": iso(start_dt),
        "end": iso(end_dt),
        "interval_seconds": devices_config.sample_interval_seconds,
        "downsample_step": step,
        "count": len(points),
        "truncated": int(total) > limit,
        "points": points,
    }
