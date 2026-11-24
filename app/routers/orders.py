"""订单列表与生产统计（4.13 / 4.14）。

统计口径必须严格按 4.14 实现，否则第 3 阶段页面上的数字和这里对不上：
- 合格率 = Σ合格数 / Σ实际数
- 完成率 = Σ实际数 / Σ计划数
- 利用率 = 该产线设备 running_status='RUNNING' 的采样点数 / 总采样点数
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db import get_db
from app.utils import iso, pagination, time_range

router = APIRouter(tags=["orders"])


def _rate(numerator: int | float | None, denominator: int | float | None) -> float:
    """分母为 0 时返回 0.0，而不是抛除零异常（新库、新产线都会遇到）。"""
    if not denominator:
        return 0.0
    return round(float(numerator or 0) / float(denominator), 4)


@router.get("/orders", summary="生产订单列表")
def list_orders(
    line_id: str | None = Query(default=None),
    status: str | None = Query(default=None),
    page: int | None = Query(default=None),
    page_size: int | None = Query(default=None),
    db: Session = Depends(get_db),
) -> dict:
    page, page_size = pagination(page, page_size)
    params = {
        "line_id": line_id,
        "status": status,
        "limit": page_size,
        "offset": (page - 1) * page_size,
    }
    where = """
        WHERE (CAST(:line_id AS varchar) IS NULL OR line_id = :line_id)
          AND (CAST(:status AS varchar) IS NULL OR status = :status)
    """
    total = db.execute(text("SELECT count(*) FROM production_orders " + where), params).scalar_one()
    rows = db.execute(
        text(
            """
            SELECT order_id, product_id, line_id, planned_quantity, actual_quantity,
                   qualified_quantity, planned_start, planned_end, status
            FROM production_orders
            """
            + where
            + " ORDER BY planned_start DESC, order_id DESC LIMIT :limit OFFSET :offset"
        ),
        params,
    ).all()

    items = [
        {
            "order_id": r.order_id,
            "product_id": r.product_id,
            "line_id": r.line_id,
            "planned_quantity": int(r.planned_quantity),
            "actual_quantity": int(r.actual_quantity),
            "qualified_quantity": int(r.qualified_quantity),
            "planned_start": iso(r.planned_start),
            "planned_end": iso(r.planned_end),
            "status": r.status,
            "qualified_rate": _rate(r.qualified_quantity, r.actual_quantity),
            "completion_rate": _rate(r.actual_quantity, r.planned_quantity),
        }
        for r in rows
    ]
    return {"items": items, "total": int(total), "page": page, "page_size": page_size}


@router.get("/stats/production", summary="生产统计（合格率 / 完成率 / 设备利用率）")
def production_stats(
    line_id: str | None = Query(default=None, description="不传则统计全厂"),
    start: datetime | None = Query(default=None),
    end: datetime | None = Query(default=None),
    db: Session = Depends(get_db),
) -> dict:
    start_dt, end_dt = time_range(start, end)

    # 订单：取与时间窗有交集的订单（计划区间碰上窗口就算）
    order_stats = db.execute(
        text(
            """
            SELECT count(*) FILTER (WHERE status = 'COMPLETED')   AS completed,
                   count(*) FILTER (WHERE status = 'IN_PROGRESS') AS in_progress,
                   COALESCE(sum(planned_quantity), 0)             AS planned,
                   COALESCE(sum(actual_quantity), 0)              AS actual,
                   COALESCE(sum(qualified_quantity), 0)           AS qualified
            FROM production_orders
            WHERE (CAST(:line_id AS varchar) IS NULL OR line_id = :line_id)
              AND planned_start <= :end
              AND planned_end   >= :start
            """
        ),
        {"line_id": line_id, "start": start_dt, "end": end_dt},
    ).one()

    # 利用率：按遥测采样点算，和 G-10 的"单一写入方"规则一致
    util_row = db.execute(
        text(
            """
            SELECT count(*) FILTER (WHERE t.running_status = 'RUNNING') AS running_points,
                   count(*)                                             AS total_points
            FROM device_telemetry t
            JOIN devices d ON d.device_id = t.device_id
            WHERE (CAST(:line_id AS varchar) IS NULL OR d.line_id = :line_id)
              AND t.ts >= :start AND t.ts <= :end
            """
        ),
        {"line_id": line_id, "start": start_dt, "end": end_dt},
    ).one()

    return {
        "line_id": line_id,
        "start": iso(start_dt),
        "end": iso(end_dt),
        "orders_completed": int(order_stats.completed),
        "orders_in_progress": int(order_stats.in_progress),
        "planned_quantity": int(order_stats.planned),
        "actual_quantity": int(order_stats.actual),
        "qualified_quantity": int(order_stats.qualified),
        "qualified_rate": _rate(order_stats.qualified, order_stats.actual),
        "completion_rate": _rate(order_stats.actual, order_stats.planned),
        "utilization": _rate(util_row.running_points, util_row.total_points),
    }
