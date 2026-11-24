"""异常注入真值查询（4.16）。

本阶段只读：数据由模拟器写入（G-12），第 4 阶段模型评估时用它当标准答案。
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db import get_db
from app.utils import iso, pagination

router = APIRouter(tags=["anomalies"])


@router.get("/anomalies", summary="异常注入真值列表（本阶段只读）")
def list_anomalies(
    device_id: str | None = Query(default=None),
    anomaly_type: str | None = Query(default=None),
    start: datetime | None = Query(default=None),
    end: datetime | None = Query(default=None),
    page: int | None = Query(default=None),
    page_size: int | None = Query(default=None),
    db: Session = Depends(get_db),
) -> dict:
    page, page_size = pagination(page, page_size)
    params = {
        "device_id": device_id,
        "anomaly_type": anomaly_type,
        "start": start,
        "end": end,
        "limit": page_size,
        "offset": (page - 1) * page_size,
    }
    where = """
        WHERE (CAST(:device_id AS varchar) IS NULL OR device_id = :device_id)
          AND (CAST(:anomaly_type AS varchar) IS NULL OR anomaly_type = :anomaly_type)
          AND (CAST(:start AS timestamptz) IS NULL OR started_at >= :start)
          AND (CAST(:end AS timestamptz) IS NULL OR started_at <= :end)
    """
    total = db.execute(text("SELECT count(*) FROM anomaly_injection " + where), params).scalar_one()
    rows = db.execute(
        text(
            """
            SELECT id, device_id, anomaly_type, started_at, ended_at, params
            FROM anomaly_injection
            """
            + where
            + " ORDER BY started_at DESC, id DESC LIMIT :limit OFFSET :offset"
        ),
        params,
    ).all()

    items = [
        {
            "id": int(r.id),
            "device_id": r.device_id,
            "anomaly_type": r.anomaly_type,
            "started_at": iso(r.started_at),
            "ended_at": iso(r.ended_at),
            "params": r.params,
        }
        for r in rows
    ]
    return {"items": items, "total": int(total), "page": page, "page_size": page_size}
