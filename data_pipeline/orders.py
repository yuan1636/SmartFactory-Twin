"""订单推进器（规格 6.6 / 偏差 D-73）。

推进方式：按"本 tick 各线应产件数"累加，件数由 data_pipeline.line_pace 按设备状态算出，
本模块只负责记账（含小数余量）与完工结算。2026-11-26 之前这里是纯计时器
（每 120 秒每线 +1 件），与设备状态脱钩，导致"利用率 86.7% 但产量满速"的矛盾。

不在这个推进器里算的：订单延期判定（DELAYED），那需要排产算法，属 L-06，本阶段固定不做。
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

from sqlalchemy import text
from sqlalchemy.orm import Session

UTC = timezone.utc

QUALIFIED_RATIO = 0.97          # 默认合格率 97%；异常期间的更高不良由 line_pace 给出
PIECES_PER_HOUR = 30            # 额定产能 30 件/小时
# 满速每件 120 秒。注意不要写成 3600 // PIECES_PER_HOUR * 60：同级运算从左到右，
# 那样求值是 (3600//30)*60 = 7200 秒。此常量只用于文档/测试，推进不再用它当计时器。
RATED_SECONDS_PER_PIECE = 3600 // PIECES_PER_HOUR  # = 120 秒
PLANNED_QUANTITY = 120
ORDER_SPAN_HOURS = 4


class PieceAccumulator:
    """把"每 tick 应产件数"累成整件，并保留小数余量。

    默认采样 2 秒一拍、满速 30 件/小时时每拍只有 1/60 件，
    不保留余量的话永远不会进位（这是改造前不敢按件数推进的原因之一，D-73）。
    """

    def __init__(self) -> None:
        self._pieces = 0.0
        self._qualified = 0.0

    def add(self, pieces: float, qualified_rate: float) -> tuple[int, int]:
        """累加本拍应产件数，返回本次可结算的（整件数, 其中的合格件数）。"""
        if pieces <= 0:
            return 0, 0
        self._pieces += pieces
        whole = math.floor(self._pieces)
        if whole <= 0:
            return 0, 0
        self._pieces -= whole
        self._qualified += whole * max(0.0, min(1.0, qualified_rate))
        qualified = min(whole, math.floor(self._qualified))
        self._qualified -= qualified
        return whole, qualified

    def push_back(self, pieces: int) -> None:
        """订单装不下（完工）时把多出来的整件退回余量，下一拍继续用。"""
        self._pieces += pieces


class OrderAdvancer:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.lines = [
            {"id": r.id, "workshop_id": r.workshop_id}
            for r in db.execute(text("SELECT id, workshop_id FROM production_lines ORDER BY id")).all()
        ]
        self.pieces_advanced = 0
        self._accumulators: dict[str, PieceAccumulator] = {}

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

    def advance(
        self,
        now: datetime,
        produced_by_line: dict[str, float],
        qualified_rate_by_line: dict[str, float] | None = None,
    ) -> int:
        """按本拍各线应产件数推进订单，返回本次实际结算的成品件数。

        produced_by_line 与 qualified_rate_by_line 都由 line_pace.load_line_states() 给出，
        本方法只做记账：累加、进位（保留小数余量）、完工结算、开新单。
        """
        rates = qualified_rate_by_line or {}
        advanced = 0
        for line in self.lines:
            pieces = float(produced_by_line.get(line["id"], 0.0))
            if pieces <= 0:
                continue

            acc = self._accumulators.setdefault(line["id"], PieceAccumulator())
            whole, qualified = acc.add(pieces, rates.get(line["id"], QUALIFIED_RATIO))
            if whole <= 0:
                continue  # 不足 1 件，余量留着，别丢

            order = self.db.execute(
                text(
                    """
                    SELECT order_id, planned_quantity, actual_quantity, qualified_quantity
                    FROM production_orders
                    WHERE line_id = :line_id AND status = 'IN_PROGRESS'
                    ORDER BY planned_start DESC LIMIT 1
                    """
                ),
                {"line_id": line["id"]},
            ).first()
            if order is None:
                acc.push_back(whole)  # 没有在制单：先把件退回去，开好新单下一拍再记
                self._create_order(line, now, status="IN_PROGRESS")
                continue

            planned = int(order.planned_quantity)
            room = planned - int(order.actual_quantity)
            applied = min(whole, room)
            if applied < whole:
                acc.push_back(whole - applied)  # 本单装不下的余量留到下一单
            new_actual = int(order.actual_quantity) + applied
            # 合格件数不得超过实际件数（异常期间合格率更低，取整可能越界）
            new_qualified = min(int(order.qualified_quantity) + min(qualified, applied), new_actual)

            if new_actual >= planned:
                self.db.execute(
                    text(
                        """
                        UPDATE production_orders
                        SET actual_quantity = :actual, qualified_quantity = :qualified, status = 'COMPLETED'
                        WHERE order_id = :order_id
                        """
                    ),
                    {"actual": planned, "qualified": new_qualified, "order_id": order.order_id},
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
                    {"actual": new_actual, "qualified": new_qualified, "order_id": order.order_id},
                )
            advanced += applied
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
