"""订单推进器的回归测试。

背景（2026-11-26 修复）：ADVANCE_INTERVAL_SECONDS 原写成 3600 // 30 * 60 = 7200 秒，
导致 24 小时窗口内恒为 0 完工单；且模拟器停摆再启动后，逾期的在制单
会卡住 ensure_orders 不再开新单，页面一直空。

约定与 test_phase2_api.py 一致：真库、自己造数据、自己清数据。
用例只把 OrderAdvancer 的 lines 限定到 LINE-A1，不碰其它三条线的真实订单；
用例自己插入的订单用 ORD-2000 开头的日期段，与真实订单（ORD-2026xxxx）天然区分。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db import engine
from data_pipeline.orders import ADVANCE_INTERVAL_SECONDS, OrderAdvancer

UTC = timezone.utc
LINE_ID = "LINE-A1"
# 用一个不可能与真实订单撞号的 ID：日期段是 2000-01-01
INJECTED_ORDER_ID = "ORD-20000101-0001"


def test_advance_interval_is_120_seconds():
    """3600 // 30 = 120 秒/件。曾经的写法 3600 // 30 * 60 求值是 7200 秒。"""
    assert ADVANCE_INTERVAL_SECONDS == 120


@pytest.fixture()
def advancer_session():
    session = Session(engine)
    advancer = OrderAdvancer(session)
    # 只对 LINE-A1 生效：避免用例把其它三条线的真实在制单结算掉
    advancer.lines = [{"id": LINE_ID, "workshop_id": "WS-A"}]

    # 模拟器一直在推进订单，这条线很可能已经有在制单。ensure_orders 的设计是
    # 「一条线至多一张在制单」，此时它不会再开新单，用例的断言会误红（2026-11-26 实测：
    # LINE-A1 已有 ORD-20261126-0005，导致 created=0）。用例期间把已有的在制单临时
    # 标成 PLANNED（不违反 line 外键与 status CHECK），结束后恢复 IN_PROGRESS——
    # 只动 status，不动 line_id/数量/时间。
    others = [
        row.order_id
        for row in session.execute(
            text("SELECT order_id FROM production_orders WHERE line_id = :line_id AND status = 'IN_PROGRESS'"),
            {"line_id": LINE_ID},
        )
    ]
    for order_id in others:
        session.execute(
            text("UPDATE production_orders SET status = 'PLANNED' WHERE order_id = :order_id"),
            {"order_id": order_id},
        )
    if others:
        session.commit()

    try:
        yield advancer, session
    finally:
        for order_id in others:
            session.execute(
                text("UPDATE production_orders SET status = 'IN_PROGRESS' WHERE order_id = :order_id"),
                {"order_id": order_id},
            )
        if others:
            session.commit()
        session.close()


def _inject_overdue_order(session: Session, planned_end: datetime) -> None:
    session.execute(
        text(
            """
            INSERT INTO production_orders
                (order_id, product_id, planned_quantity, actual_quantity, qualified_quantity,
                 line_id, planned_start, planned_end, status)
            VALUES
                (:order_id, 'PRD-A-001', 120, 29, 0,
                 :line_id, :planned_start, :planned_end, 'IN_PROGRESS')
            """
        ),
        {
            "order_id": INJECTED_ORDER_ID,
            "line_id": LINE_ID,
            "planned_start": planned_end - timedelta(hours=4),
            "planned_end": planned_end,
        },
    )
    session.commit()


def _cleanup(session: Session, *order_ids: str) -> None:
    for order_id in order_ids:
        session.execute(
            text("DELETE FROM production_orders WHERE order_id = :order_id"),
            {"order_id": order_id},
        )
    session.commit()


def test_ensure_orders_settles_overdue_and_creates_new(advancer_session):
    """逾期在制单应被结算成 COMPLETED（actual=planned、合格 97%），且该线再开一张新单。"""
    advancer, session = advancer_session
    now = datetime.now(UTC)
    _inject_overdue_order(session, planned_end=now - timedelta(hours=1))
    new_order = None
    try:
        created = advancer.ensure_orders(now)

        settled = session.execute(
            text(
                """
                SELECT status, actual_quantity, qualified_quantity
                FROM production_orders WHERE order_id = :order_id
                """
            ),
            {"order_id": INJECTED_ORDER_ID},
        ).one()
        assert settled.status == "COMPLETED"
        assert settled.actual_quantity == 120
        assert settled.qualified_quantity == 116  # floor(120 * 0.97)

        new_order = session.execute(
            text(
                """
                SELECT order_id FROM production_orders
                WHERE line_id = :line_id AND status = 'IN_PROGRESS'
                  AND planned_start >= :now
                """
            ),
            {"line_id": LINE_ID, "now": now},
        ).first()
        assert new_order is not None, "结算逾期单后应开一张新在制单"
        assert new_order.order_id != INJECTED_ORDER_ID
        assert created >= 1
    finally:
        # 清理本用例插入的单 + ensure_orders 新开的单；
        # 逾期的真实在制单被结算成 COMPLETED 属于自愈的预期效果，保留不回滚
        _cleanup(session, INJECTED_ORDER_ID, *(new_order.order_id,) if new_order else ())


def test_ensure_orders_keeps_active_order(advancer_session):
    """未逾期的在制单不该被结算，也不该再开新单。"""
    advancer, session = advancer_session
    now = datetime.now(UTC)
    _inject_overdue_order(session, planned_end=now + timedelta(hours=2))
    try:
        created = advancer.ensure_orders(now)

        settled = session.execute(
            text("SELECT status FROM production_orders WHERE order_id = :order_id"),
            {"order_id": INJECTED_ORDER_ID},
        ).one()
        assert settled.status == "IN_PROGRESS"
        assert created == 0
    finally:
        active = session.execute(
            text(
                """
                SELECT order_id FROM production_orders
                WHERE line_id = :line_id AND status = 'IN_PROGRESS' AND planned_start >= :now
                """
            ),
            {"line_id": LINE_ID, "now": now},
        ).first()
        _cleanup(session, INJECTED_ORDER_ID, *(active.order_id,) if active else ())
