"""车间与生产线（4.2 / 4.3）。

两张表是第 2 阶段新补的（G-02）：没有它们，第 3 阶段按车间分组只能在前端写死映射。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db import get_db

router = APIRouter(tags=["hierarchy"])


@router.get("/workshops", summary="车间列表（含产线数、设备数）")
def list_workshops(db: Session = Depends(get_db)) -> dict:
    rows = db.execute(
        text(
            """
            SELECT w.id, w.name,
                   (SELECT count(*) FROM production_lines l WHERE l.workshop_id = w.id) AS line_count,
                   (SELECT count(*) FROM devices d WHERE d.workshop_id = w.id) AS device_count
            FROM workshops w
            ORDER BY w.id
            """
        )
    ).all()
    items = [
        {
            "id": r.id,
            "name": r.name,
            "line_count": int(r.line_count),
            "device_count": int(r.device_count),
        }
        for r in rows
    ]
    return {"items": items, "total": len(items)}


@router.get("/lines", summary="生产线列表（可按车间过滤）")
def list_lines(
    workshop_id: str | None = Query(default=None, description="车间编号，如 WS-A"),
    db: Session = Depends(get_db),
) -> dict:
    # workshop_id 不存在时返回空列表而不是报错：筛选条件查不到东西是正常语义
    rows = db.execute(
        text(
            """
            SELECT l.id, l.name, l.workshop_id, l.rated_capacity_per_hour,
                   (SELECT count(*) FROM devices d WHERE d.line_id = l.id) AS device_count
            FROM production_lines l
            WHERE (CAST(:workshop_id AS varchar) IS NULL OR l.workshop_id = :workshop_id)
            ORDER BY l.id
            """
        ),
        {"workshop_id": workshop_id},
    ).all()
    items = [
        {
            "id": r.id,
            "name": r.name,
            "workshop_id": r.workshop_id,
            "rated_capacity_per_hour": int(r.rated_capacity_per_hour),
            "device_count": int(r.device_count),
        }
        for r in rows
    ]
    return {"items": items, "total": len(items)}
