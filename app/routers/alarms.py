"""告警查询与人工解除（4.11 / 4.12）。"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.constants import ErrorCode
from app.db import get_db
from app.errors import ApiError
from app.utils import ensure_aware, iso, pagination, utcnow

router = APIRouter(tags=["alarms"])


@router.get("/alarms", summary="告警列表")
def list_alarms(
    device_id: str | None = Query(default=None),
    alarm_type: str | None = Query(default=None),
    alarm_level: str | None = Query(default=None),
    resolved: bool | None = Query(default=None, description="true=已解除，false=未解除"),
    start: datetime | None = Query(default=None),
    end: datetime | None = Query(default=None),
    page: int | None = Query(default=None),
    page_size: int | None = Query(default=None),
    db: Session = Depends(get_db),
) -> dict:
    page, page_size = pagination(page, page_size)

    # 告警列表不强制时间窗（否则"查全部未解除告警"会查不到），但传了就必须成对且合法
    if (start is None) != (end is None):
        raise ApiError(
            400,
            ErrorCode.INVALID_PARAM,
            "start 与 end 必须同时提供，或都不提供",
            {"start": iso(start), "end": iso(end)},
        )
    if start is not None and end is not None:
        start_dt, end_dt = ensure_aware(start), ensure_aware(end)
        if end_dt <= start_dt:
            raise ApiError(
                400,
                ErrorCode.INVALID_PARAM,
                "end 必须晚于 start",
                {"start": iso(start_dt), "end": iso(end_dt)},
            )
    else:
        start_dt = end_dt = None

    params = {
        "device_id": device_id,
        "alarm_type": alarm_type,
        "alarm_level": alarm_level,
        "resolved": resolved,
        "start": start_dt,
        "end": end_dt,
        "limit": page_size,
        "offset": (page - 1) * page_size,
    }
    where = """
        WHERE (CAST(:device_id AS varchar) IS NULL OR device_id = :device_id)
          AND (CAST(:alarm_type AS varchar) IS NULL OR alarm_type = :alarm_type)
          AND (CAST(:alarm_level AS varchar) IS NULL OR alarm_level = :alarm_level)
          AND (CAST(:resolved AS boolean) IS NULL OR (resolved_at IS NULL) = (NOT :resolved))
          AND (CAST(:start AS timestamptz) IS NULL OR detected_at >= :start)
          AND (CAST(:end AS timestamptz) IS NULL OR detected_at <= :end)
    """
    total = db.execute(text("SELECT count(*) FROM alarms " + where), params).scalar_one()
    rows = db.execute(
        text(
            """
            SELECT alarm_id, device_id, alarm_type, alarm_level, message, detected_at, resolved_at
            FROM alarms
            """
            + where
            + " ORDER BY detected_at DESC, alarm_id DESC LIMIT :limit OFFSET :offset"
        ),
        params,
    ).all()

    items = [
        {
            "alarm_id": int(r.alarm_id),
            "device_id": r.device_id,
            "alarm_type": r.alarm_type,
            "alarm_level": r.alarm_level,
            "message": r.message,
            "detected_at": iso(r.detected_at),
            "resolved_at": iso(r.resolved_at),
        }
        for r in rows
    ]
    return {"items": items, "total": int(total), "page": page, "page_size": page_size}


@router.patch("/alarms/{alarm_id}/resolve", summary="人工解除告警（按 G-10 决定设备状态）")
def resolve_alarm(alarm_id: int, db: Session = Depends(get_db)) -> dict:
    alarm = db.execute(
        text(
            """
            SELECT alarm_id, device_id, detected_at, resolved_at
            FROM alarms WHERE alarm_id = :alarm_id
            """
        ),
        {"alarm_id": alarm_id},
    ).first()
    if alarm is None:
        raise ApiError(404, ErrorCode.ALARM_NOT_FOUND, f"告警 {alarm_id} 不存在", {"alarm_id": alarm_id})
    if alarm.resolved_at is not None:
        raise ApiError(
            409,
            ErrorCode.ALARM_ALREADY_RESOLVED,
            f"告警 {alarm_id} 已于 {iso(alarm.resolved_at)} 解除",
            {"alarm_id": alarm_id, "resolved_at": iso(alarm.resolved_at)},
        )

    now = utcnow()
    resolved_at = max(now, alarm.detected_at)  # 约束要求 resolved_at >= detected_at
    db.execute(
        text("UPDATE alarms SET resolved_at = :resolved_at WHERE alarm_id = :alarm_id"),
        {"resolved_at": resolved_at, "alarm_id": alarm_id},
    )

    # G-10 修订：先数还剩多少条未解除，只有清零才把设备置回 RUNNING
    open_count = int(
        db.execute(
            text(
                """
                SELECT count(*) FROM alarms
                WHERE device_id = :device_id AND resolved_at IS NULL
                """
            ),
            {"device_id": alarm.device_id},
        ).scalar_one()
    )
    if open_count == 0:
        db.execute(
            text(
                """
                UPDATE devices SET status = 'RUNNING'
                WHERE device_id = :device_id AND status = 'ALARM'
                """
            ),
            {"device_id": alarm.device_id},
        )
    device_status = db.execute(
        text("SELECT status FROM devices WHERE device_id = :device_id"),
        {"device_id": alarm.device_id},
    ).scalar_one()
    db.commit()

    return {
        "alarm_id": alarm_id,
        "resolved_at": iso(resolved_at),
        "device_status": device_status,
        "open_alarm_count": open_count,
    }
