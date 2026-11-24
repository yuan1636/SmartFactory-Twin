"""维护记录（4.15）。

本阶段只有手工写入，不自动触发（自动触发依赖故障判定模型，属第 4 阶段，见 L-07）。
MAINTENANCE 状态只由这里改（G-10 单一写入方）。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.constants import DeviceStatus, ErrorCode
from app.db import get_db
from app.errors import ApiError
from app.schemas import MaintenanceIn
from app.utils import ensure_aware, iso, pagination

router = APIRouter(tags=["maintenance"])


@router.get("/maintenance", summary="维护记录列表")
def list_maintenance(
    device_id: str | None = Query(default=None),
    page: int | None = Query(default=None),
    page_size: int | None = Query(default=None),
    db: Session = Depends(get_db),
) -> dict:
    page, page_size = pagination(page, page_size)
    params = {
        "device_id": device_id,
        "limit": page_size,
        "offset": (page - 1) * page_size,
    }
    where = " WHERE (CAST(:device_id AS varchar) IS NULL OR device_id = :device_id)"
    total = db.execute(text("SELECT count(*) FROM maintenance_records" + where), params).scalar_one()
    rows = db.execute(
        text(
            """
            SELECT record_id, device_id, maintenance_type, description,
                   started_at, finished_at, cost
            FROM maintenance_records
            """
            + where
            + " ORDER BY started_at DESC, record_id DESC LIMIT :limit OFFSET :offset"
        ),
        params,
    ).all()
    items = [
        {
            "record_id": int(r.record_id),
            "device_id": r.device_id,
            "maintenance_type": r.maintenance_type,
            "description": r.description,
            "started_at": iso(r.started_at),
            "finished_at": iso(r.finished_at),
            "cost": float(r.cost) if r.cost is not None else None,
        }
        for r in rows
    ]
    return {"items": items, "total": int(total), "page": page, "page_size": page_size}


@router.post("/maintenance", status_code=201, summary="新增维护记录（未填结束时间则设备转 MAINTENANCE）")
def create_maintenance(body: MaintenanceIn, db: Session = Depends(get_db)) -> dict:
    exists = db.execute(
        text("SELECT 1 FROM devices WHERE device_id = :device_id"), {"device_id": body.device_id}
    ).first()
    if exists is None:
        raise ApiError(404, ErrorCode.DEVICE_NOT_FOUND, f"设备 {body.device_id} 不存在", {"device_id": body.device_id})

    started_at = ensure_aware(body.started_at)
    finished_at = ensure_aware(body.finished_at)
    if finished_at is not None and finished_at < started_at:
        raise ApiError(400, ErrorCode.INVALID_PARAM, "finished_at 不能早于 started_at", None)

    record_id = db.execute(
        text(
            """
            INSERT INTO maintenance_records
                (device_id, maintenance_type, description, started_at, finished_at, cost)
            VALUES (:device_id, :maintenance_type, :description, :started_at, :finished_at, :cost)
            RETURNING record_id
            """
        ),
        {
            "device_id": body.device_id,
            "maintenance_type": body.maintenance_type,
            "description": body.description,
            "started_at": started_at,
            "finished_at": finished_at,
            "cost": body.cost,
        },
    ).scalar_one()

    # 维护进行中 → 设备置 MAINTENANCE；维护结束 → 没有未解除告警才允许回 RUNNING
    if finished_at is None:
        db.execute(
            text("UPDATE devices SET status = :status WHERE device_id = :device_id"),
            {"status": DeviceStatus.MAINTENANCE.value, "device_id": body.device_id},
        )
    else:
        open_count = db.execute(
            text(
                """
                SELECT count(*) FROM alarms
                WHERE device_id = :device_id AND resolved_at IS NULL
                """
            ),
            {"device_id": body.device_id},
        ).scalar_one()
        if int(open_count) == 0:
            db.execute(
                text(
                    """
                    UPDATE devices SET status = 'RUNNING'
                    WHERE device_id = :device_id AND status = 'MAINTENANCE'
                    """
                ),
                {"device_id": body.device_id},
            )
    device_status = db.execute(
        text("SELECT status FROM devices WHERE device_id = :device_id"),
        {"device_id": body.device_id},
    ).scalar_one()
    db.commit()

    return {
        "record_id": int(record_id),
        "device_id": body.device_id,
        "maintenance_type": body.maintenance_type,
        "started_at": iso(started_at),
        "finished_at": iso(finished_at),
        "cost": float(body.cost) if body.cost is not None else None,
        "device_status": device_status,
    }
