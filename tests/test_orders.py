"""订单推进器的回归测试。

背景（2026-11-26 修复）：ADVANCE_INTERVAL_SECONDS 原写成 3600 // 30 * 60 = 7200 秒，
导致 24 小时窗口内恒为 0 完工单；且模拟器停摆再启动后，逾期的在制单
会卡住 ensure_orders 不再开新单，页面一直空。
同日第二次改造（D-73）：推进从"每 120 秒 +1 件"的计时器改为按产出件数累加，
件数由 line_pace 按设备可用率与异常算出，本文件补 PieceAccumulator 的取整与合格件数测试。

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
from data_pipeline.orders import (
    PIECES_PER_HOUR,
    RATED_SECONDS_PER_PIECE,
    OrderAdvancer,
    PieceAccumulator,
)

UTC = timezone.utc
# 用一个不可能与真实订单撞号的 ID：日期段是 2000-01-01
INJECTED_ORDER_ID = "ORD-20000101-0001"


def test_rated_pace_is_120_seconds_per_piece():
    """3600 // 30 = 120 秒/件。曾经的写法 3600 // 30 * 60 求值是 7200 秒。"""
    assert RATED_SECONDS_PER_PIECE == 120


def test_half_useful_rate_halves_output_in_10_minutes():
    """可用率 0.5 时，10 分钟产量约为满速的一半。

    满速 30 件/小时 → 10 分钟 5 件，半速 2.5 件；整数件只能到 2（余下 0.5 件留在累加器里）。
    取整误差在半件量级，所以先断 2~3，再用 100 分钟的长窗口验证 10% 以内。
    """
    acc = PieceAccumulator()
    produced = 0
    for _ in range(600):  # 10 分钟，按 1 秒一拍模拟
        whole, _qualified = acc.add(PIECES_PER_HOUR * 0.5 / 3600, 0.97)
        produced += whole
    assert produced in (2, 3), f"半速 10 分钟应约 2.5 件，实际 {produced}"


def test_half_useful_rate_within_10_percent_over_100_minutes():
    """把窗口拉长到 100 分钟，取整误差摊薄后应落在 ±10% 内（50 件 → 25 件）。"""
    acc = PieceAccumulator()
    produced = 0
    for _ in range(6000):
        whole, _qualified = acc.add(PIECES_PER_HOUR * 0.5 / 3600, 0.97)
        produced += whole
    assert abs(produced - 25) <= 2, f"半速 100 分钟应约 25 件（±10%），实际 {produced}"


def test_accumulator_keeps_fractional_remainder():
    """2 秒一拍、满速时每拍 1/60 件，必须留余量，否则永远进不了位。"""
    acc = PieceAccumulator()
    total = 0
    for _ in range(120):  # 满速 240 秒 = 2 件
        whole, _qualified = acc.add(PIECES_PER_HOUR / 3600 * 2, 0.97)
        total += whole
    assert total == 2


def test_accumulator_applies_abnormal_qualified_rate():
    """异常期间合格率降到 92%：120 件的合格件数应为 floor(120 × 0.92) = 110，而非 116。"""
    acc = PieceAccumulator()
    whole, qualified = acc.add(120, 0.92)
    assert whole == 120
    assert qualified == 110


# --------------------------------------------------------------------------- #
# 逾期自愈（ensure_orders）—— 用临时产线 LINE-T9，不碰四条真实产线
# --------------------------------------------------------------------------- #
TEMP_LINE_ID = "LINE-T9"


@pytest.fixture()
def advancer_session():
    """建一条临时产线给用例用，结束后连同它的订单整条删掉。

    不能借用 LINE-A1：模拟器在跑，真实在制单会让"结算后应开新单"这条断言失效。
    """
    session = Session(engine)
    _drop_temp_line(session)
    session.execute(
        text("INSERT INTO production_lines (id, name, workshop_id) VALUES (:id, '测试线（可删）', 'WS-A')"),
        {"id": TEMP_LINE_ID},
    )
    session.commit()

    advancer = OrderAdvancer(session)
    advancer.lines = [{"id": TEMP_LINE_ID, "workshop_id": "WS-A"}]
    yield advancer, session

    session.rollback()
    _drop_temp_line(session)
    session.close()


def _drop_temp_line(session: Session) -> None:
    session.execute(
        text("DELETE FROM production_orders WHERE line_id = :line_id"), {"line_id": TEMP_LINE_ID}
    )
    session.execute(text("DELETE FROM production_lines WHERE id = :line_id"), {"line_id": TEMP_LINE_ID})
    session.commit()


def _inject_order(session: Session, planned_end: datetime) -> None:
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
            "line_id": TEMP_LINE_ID,
            "planned_start": planned_end - timedelta(hours=4),
            "planned_end": planned_end,
        },
    )
    session.commit()


def test_ensure_orders_settles_overdue_and_creates_new(advancer_session):
    """逾期在制单应被结算成 COMPLETED（actual=planned、合格 97%），且该线再开一张新单。"""
    advancer, session = advancer_session
    now = datetime.now(UTC)
    _inject_order(session, planned_end=now - timedelta(hours=1))

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
            """
        ),
        {"line_id": TEMP_LINE_ID},
    ).first()
    assert new_order is not None, "结算逾期单后应开一张新在制单"
    assert new_order.order_id != INJECTED_ORDER_ID
    assert created >= 1


def test_ensure_orders_keeps_active_order(advancer_session):
    """未逾期的在制单不该被结算，也不该再开新单。"""
    advancer, session = advancer_session
    now = datetime.now(UTC)
    _inject_order(session, planned_end=now + timedelta(hours=2))

    created = advancer.ensure_orders(now)

    kept = session.execute(
        text("SELECT status FROM production_orders WHERE order_id = :order_id"),
        {"order_id": INJECTED_ORDER_ID},
    ).one()
    assert kept.status == "IN_PROGRESS"
    assert created == 0
