"""设备列表 / 详情 / 状态 / 最新遥测（4.4 ~ 4.6、4.10）。

注意路由声明顺序：/devices/latest 必须写在 /devices/{device_id} 之前，
否则 latest 会被当成设备编号，返回 404。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import devices_config
from app.constants import METRIC_DIGITS, DeviceStatus, ErrorCode
from app.db import get_db
from app.errors import ApiError
from app.schemas import DeviceStatusIn
from app.utils import iso, pagination, utcnow

router = APIRouter(tags=["devices"])

# 设备列表与详情共用这一段查询：告警数与最新遥测都用子查询补齐，
# 避免 N+1 查询（14 台设备只发一次 SQL）
_DEVICE_SELECT = """
    SELECT d.device_id, d.device_name, d.device_type, d.workshop_id, d.line_id,
           d.model, d.status, d.installed_at,
           COALESCE(ac.open_count, 0) AS open_alarm_count,
           (SELECT x.ts FROM device_telemetry x
            WHERE x.device_id = d.device_id ORDER BY x.ts DESC LIMIT 1) AS latest_ts
    FROM devices d
    LEFT JOIN (
        SELECT device_id, count(*) AS open_count
        FROM alarms WHERE resolved_at IS NULL GROUP BY device_id
    ) ac ON ac.device_id = d.device_id
"""


def _device_row_to_dict(r) -> dict:
    return {
        "device_id": r.device_id,
        "device_name": r.device_name,
        "device_type": r.device_type,
        "workshop_id": r.workshop_id,
        "line_id": r.line_id,
        "model": r.model,
        "status": r.status,
        "installed_at": iso(r.installed_at),
        "open_alarm_count": int(r.open_alarm_count),
        "latest_ts": iso(r.latest_ts),
    }


@router.get("/devices", summary="设备列表（可按车间/产线/类型/状态过滤）")
def list_devices(
    workshop_id: str | None = Query(default=None),
    line_id: str | None = Query(default=None),
    device_type: str | None = Query(default=None),
    status: str | None = Query(default=None),
    page: int | None = Query(default=None),
    page_size: int | None = Query(default=None),
    db: Session = Depends(get_db),
) -> dict:
    page, page_size = pagination(page, page_size)
    params = {
        "workshop_id": workshop_id,
        "line_id": line_id,
        "device_type": device_type,
        "status": status,
        "limit": page_size,
        "offset": (page - 1) * page_size,
    }
    where = """
        WHERE (CAST(:workshop_id AS varchar) IS NULL OR d.workshop_id = :workshop_id)
          AND (CAST(:line_id AS varchar) IS NULL OR d.line_id = :line_id)
          AND (CAST(:device_type AS varchar) IS NULL OR d.device_type = :device_type)
          AND (CAST(:status AS varchar) IS NULL OR d.status = :status)
    """
    total = db.execute(text("SELECT count(*) FROM devices d " + where), params).scalar_one()
    rows = db.execute(
        text(_DEVICE_SELECT + where + " ORDER BY d.device_id LIMIT :limit OFFSET :offset"),
        params,
    ).all()
    return {
        "items": [_device_row_to_dict(r) for r in rows],
        "total": int(total),
        "page": page,
        "page_size": page_size,
    }


@router.get("/devices/latest", summary="全厂最新一条遥测（WebSocket 断线兜底）")
def latest_telemetry(db: Session = Depends(get_db)) -> dict:
    rows = db.execute(
        text(
            """
            SELECT d.device_id, d.status,
                   COALESCE(ac.open_count, 0) AS open_alarm_count,
                   t.ts, t.temperature, t.vibration, t.current, t.speed, t.running_status
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
            ORDER BY d.device_id
            """
        )
    ).all()

    items = []
    for r in rows:
        item = {
            "device_id": r.device_id,
            "status": r.status,
            "open_alarm_count": int(r.open_alarm_count),
            "ts": iso(r.ts),
            "running_status": r.running_status,
        }
        for metric in METRIC_DIGITS:
            value = getattr(r, metric, None)
            if value is None:
                item[metric] = None
            else:
                digits = METRIC_DIGITS[metric]
                item[metric] = round(float(value), digits) if digits else int(round(float(value)))
        items.append(item)
    return {"server_time": iso(utcnow()), "items": items}


@router.get("/devices/{device_id}", summary="设备详情（含四指标正常区间）")
def get_device(device_id: str, db: Session = Depends(get_db)) -> dict:
    row = db.execute(
        text(_DEVICE_SELECT + " WHERE d.device_id = :device_id"),
        {"device_id": device_id},
    ).first()
    if row is None:
        raise ApiError(404, ErrorCode.DEVICE_NOT_FOUND, f"设备 {device_id} 不存在", {"device_id": device_id})

    data = _device_row_to_dict(row)
    cfg = devices_config.get(device_id)
    data["metrics_normal_range"] = cfg.metrics_normal_range if cfg else {}
    return data


@router.patch("/devices/{device_id}/status", summary="人工设置设备状态（仅 RUNNING / MAINTENANCE）")
def patch_device_status(
    device_id: str,
    body: DeviceStatusIn,
    db: Session = Depends(get_db),
) -> dict:
    # 只允许人工设置这两个值：ALARM 由告警流程写，IDLE/STOPPED 由遥测数据驱动（G-10）
    allowed = {DeviceStatus.MAINTENANCE.value, DeviceStatus.RUNNING.value}
    if body.status not in allowed:
        raise ApiError(
            400,
            ErrorCode.INVALID_PARAM,
            f"status 只允许 {'/'.join(sorted(allowed))}，收到 {body.status}",
            {"allowed": sorted(allowed)},
        )

    exists = db.execute(
        text("SELECT 1 FROM devices WHERE device_id = :device_id"), {"device_id": device_id}
    ).first()
    if exists is None:
        raise ApiError(404, ErrorCode.DEVICE_NOT_FOUND, f"设备 {device_id} 不存在", {"device_id": device_id})

    if body.status == DeviceStatus.RUNNING.value:
        open_count = db.execute(
            text(
                """
                SELECT count(*) FROM alarms
                WHERE device_id = :device_id AND resolved_at IS NULL
                """
            ),
            {"device_id": device_id},
        ).scalar_one()
        if int(open_count) > 0:
            raise ApiError(
                409,
                ErrorCode.DEVICE_HAS_OPEN_ALARM,
                f"设备 {device_id} 还有 {int(open_count)} 条未解除告警，不能置回 RUNNING",
                {"open_alarm_count": int(open_count)},
            )

    db.execute(
        text("UPDATE devices SET status = :status WHERE device_id = :device_id"),
        {"status": body.status, "device_id": device_id},
    )
    db.commit()
    return {"device_id": device_id, "status": body.status, "updated_at": iso(utcnow())}
