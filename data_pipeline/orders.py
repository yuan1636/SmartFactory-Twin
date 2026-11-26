"""订单推进器（规格 6.6）。

不在这个推进器里算的：订单延期判定（DELAYED），那需要排产算法，属 L-06，本阶段固定不做。
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

from sqlalchemy import text
from sqlalchemy.orm import Session

UTC = timezone.utc

QUALIFIED_RATIO = 0.97          # 合格率固定 97%
PIECES_PER_HOUR = 30            # 额定产能 30 件/小时 → 每 2 分钟 +1 件
# 每件 120 秒。注意不要写成 3600 // PIECES_PER_HOUR * 60：同级运算从左到右，
# 那样求值是 (3600//30)*60 = 7200 秒（2 小时/件），一单 120 件要 10 天。
ADVANCE_INTERVAL_SECONDS = 3600 // PIECES_PER_HOUR  # = 120 秒
PLANNED_QUANTITY = 120
ORDER_SPAN_HOURS = 4


class OrderAdvancer:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.lines = [
            {"id": r.id, "workshop_id": r.workshop_id}
            for r in db.execute(text("SELECT id, workshop_id FROM production_lines ORDER BY id")).all()
        ]
        self.last_advance_epoch: float | None = None
        self.pieces_advanced = 0

    # ---------- 对外接口 ----------

    def ensure_orders(self, now: datetime) -> int:
        """每条产线保证有一张进行中的订单，返回新建张数。

        逾期自愈：模拟器停摆再启动时，可能留下 planned_end 已过的在制单——
        若不结算，该线永远"有在制单"，ensure_orders 不会再开新单，
        24 小时统计窗口内也没有完工单，页面会一直空。
        所以先按计划量结算（合格率同 advance 的 97% 口径），再开新单。
        """
        created = 0
        for line in self.lines:
            self._settle_overdue(line["id"], now)
            existing = self.db.execute(
                text(
                    """
                    SELECT 1 FROM production_orders
                    WHERE line_id = :line_id AND status = 'IN_PROGRESS'
                    LIMIT 1
                    """
                ),
                {"line_id": line["id"]},
            ).first()
            if existing is None:
                self._create_order(line, now, status="IN_PROGRESS")
                created += 1
        if created:
            self.db.commit()
        return created

    def _settle_overdue(self, line_id: str, now: datetime) -> int:
        """把该线 planned_end 已过的在制单按计划量结算成 COMPLETED，返回结算张数。"""
        result = self.db.execute(
            text(
                """
                UPDATE production_orders
                SET actual_quantity = planned_quantity,
                    qualified_quantity = floor(planned_quantity * :ratio),
                    status = 'COMPLETED'
                WHERE line_id = :line_id AND status = 'IN_PROGRESS' AND planned_end < :now
                """
            ),
            {"ratio": QUALIFIED_RATIO, "line_id": line_id, "now": now},
        )
        return result.rowcount

    def advance(self, now: datetime) -> int:
        """到点（120 秒）推进一次，返回本次新增的成品件数。"""
        epoch = now.timestamp()
        if self.last_advance_epoch is not None and epoch - self.last_advance_epoch < ADVANCE_INTERVAL_SECONDS:
            return 0
        self.last_advance_epoch = epoch

        advanced = 0
        for line in self.lines:
            order = self.db.execute(
                text(
                    """
                    SELECT order_id, planned_quantity, actual_quantity
                    FROM production_orders
                    WHERE line_id = :line_id AND status = 'IN_PROGRESS'
                    ORDER BY planned_start DESC LIMIT 1
                    """
                ),
                {"line_id": line["id"]},
            ).first()
            if order is None:
                self._create_order(line, now, status="IN_PROGRESS")
                continue

            actual = int(order.actual_quantity) + 1
            qualified = math.floor(actual * QUALIFIED_RATIO)  # 用累加余数法，长期稳定在 97%
            if actual >= int(order.planned_quantity):
                self.db.execute(
                    text(
                        """
                        UPDATE production_orders
                        SET actual_quantity = :actual, qualified_quantity = :qualified, status = 'COMPLETED'
                        WHERE order_id = :order_id
                        """
                    ),
                    {"actual": int(order.planned_quantity), "qualified": math.floor(int(order.planned_quantity) * QUALIFIED_RATIO), "order_id": order.order_id},
                )
                self._create_order(line, now, status="IN_PROGRESS")
            else:
                self.db.execute(
                    text(
                        """
                        UPDATE production_orders
                        SET actual_quantity = :actual, qualified_quantity = :qualified
                        WHERE order_id = :order_id
                        """
                    ),
                    {"actual": actual, "qualified": qualified, "order_id": order.order_id},
                )
            advanced += 1
        if advanced:
            self.pieces_advanced += advanced
            self.db.commit()
        return advanced

    # ---------- 内部 ----------

    def _next_order_id(self, now: datetime) -> str:
        day = now.strftime("%Y%m%d")
        prefix = f"ORD-{day}-"
        used = self.db.execute(
            text("SELECT count(*) FROM production_orders WHERE order_id LIKE :prefix"),
            {"prefix": prefix + "%"},
        ).scalar_one()
        return f"{prefix}{int(used) + 1:04d}"

    def _create_order(self, line: dict, now: datetime, status: str) -> str:
        order_id = self._next_order_id(now)
        workshop_letter = (line["workshop_id"] or "WS-A").split("-")[-1][:1] or "A"
        self.db.execute(
            text(
                """
                INSERT INTO production_orders
                    (order_id, product_id, planned_quantity, actual_quantity, qualified_quantity,
                     line_id, planned_start, planned_end, status)
                VALUES
                    (:order_id, :product_id, :planned_quantity, 0, 0,
                     :line_id, :planned_start, :planned_end, :status)
                """
            ),
            {
                "order_id": order_id,
                "product_id": f"PRD-{workshop_letter}-001",
                "planned_quantity": PLANNED_QUANTITY,
                "line_id": line["id"],
                "planned_start": now,
                "planned_end": now + timedelta(hours=ORDER_SPAN_HOURS),
                "status": status,
            },
        )
        return order_id

    def seed_history(self, days: int, end: datetime) -> int:
        """回填时倒推生成已完成的订单（6.7 第 4 条），返回生成张数。"""
        created = 0
        per_day = 6  # 720 件/天 ÷ 120 件/单 = 6 单
        for day_offset in range(days, 0, -1):
            day_end = end - timedelta(days=day_offset - 1)
            day_start = day_end - timedelta(hours=24)
            for line in self.lines:
                for index in range(per_day):
                    start = day_start + timedelta(hours=index * ORDER_SPAN_HOURS)
                    order_id = self._next_order_id(start)
                    workshop_letter = (line["workshop_id"] or "WS-A").split("-")[-1][:1] or "A"
                    self.db.execute(
                        text(
                            """
                            INSERT INTO production_orders
                                (order_id, product_id, planned_quantity, actual_quantity,
                                 qualified_quantity, line_id, planned_start, planned_end, status)
                            VALUES
                                (:order_id, :product_id, :planned_quantity, :planned_quantity,
                                 :qualified, :line_id, :planned_start, :planned_end, 'COMPLETED')
                            """
                        ),
                        {
                            "order_id": order_id,
                            "product_id": f"PRD-{workshop_letter}-001",
                            "planned_quantity": PLANNED_QUANTITY,
                            "qualified": math.floor(PLANNED_QUANTITY * QUALIFIED_RATIO),
                            "line_id": line["id"],
                            "planned_start": start,
                            "planned_end": start + timedelta(hours=ORDER_SPAN_HOURS),
                        },
                    )
                    created += 1
        if created:
            self.db.commit()
        return created
