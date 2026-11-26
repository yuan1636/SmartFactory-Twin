"""产线节拍：设备可用率与活跃异常共同决定产量与合格率（偏差 D-73）。

改这个文件之前先读两条背景：

1. 订单推进曾经是纯计时器（每 120 秒每线 +1 件），完全不看设备状态，
   于是 /stats 的 utilization 是 86.7%（状态机 26/30 分钟在转），订单却按 100% 满速推进，
   两个口径自相矛盾。现在节拍由本模块算出、喂给 OrderAdvancer，两者同源。
2. 状态的来源有两个，各司其职：
   - `devices.status`（后端写：ALARM / MAINTENANCE / RUNNING）——人工停机、维护、告警；
   - 状态机 `status_at()`（模拟器按时间算：RUNNING 26 分 → IDLE 3 分 → STOPPED 1 分）。
   两者取交集：只有"状态机说在转"且"没有被停用"的设备才算可用。

口径（与 /stats/production 的 utilization 完全一致）：
    useful_rate = 可用设备数 / 该线设备数，输送机（CONV）不可用时整线为 0
    line_pace   = 额定 30 件/小时 × useful_rate × 异常系数
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import DevicesConfig
from data_pipeline.generator import status_at
from data_pipeline.injector import duration_seconds

BASE_QUALIFIED_RATE = 0.97

# 异常 → (节拍系数, 合格率)。同一线多台设备同时异常取最严的一档，不叠加（D-73）
ANOMALY_EFFECTS: dict[str, tuple[float, float]] = {
    "VIB_SPIKE": (0.85, 0.92),
    "TEMP_DRIFT": (0.75, 0.90),
    "CURRENT_ABNORMAL": (0.90, 0.94),
}

# 这些 devices.status 视为不可用。ALARM 仍算在转：异常对产量的影响走异常系数，
# 不在这里再扣一次，否则注入一次 VIB_SPIKE 会被双重惩罚（D-73）
UNAVAILABLE_STATUSES = frozenset({"STOPPED", "MAINTENANCE"})

# 输送机是产线主动脉：它不转，工件过不去，整线节拍归零（作者 2026-11-26 裁定）
CONVEYOR_PREFIX = "CONV-"


@dataclass(frozen=True)
class LineState:
    """某条产线在某一时刻的可用率、节拍与合格率。"""

    useful_rate: float
    pace_per_hour: float
    qualified_rate: float
    reason: str


def compute_line_states(
    devices: list[tuple[str, str, str]],
    epoch: float,
    cfg: DevicesConfig,
    rated_per_hour: float,
    anomalies: list[tuple[str, str]] = (),
) -> dict[str, LineState]:
    """纯函数（不碰数据库），便于单测。

    devices:   [(device_id, line_id, devices.status)]
    anomalies: [(device_id, anomaly_type)]，只应传当前活跃的注入
    """
    by_line: dict[str, list[tuple[str, str]]] = {}
    for device_id, line_id, db_status in devices:
        if not line_id:
            continue  # AIR-01 / PUMP-01 这类辅助设备不挂产线，不参与节拍
        by_line.setdefault(line_id, []).append((device_id, db_status))

    # 异常按产线聚合：只关心挂在本线上的设备
    line_of_device = {device_id: line_id for device_id, line_id, _ in devices if line_id}
    penalty: dict[str, tuple[float, float]] = {}
    for device_id, anomaly_type in anomalies:
        line_id = line_of_device.get(device_id)
        effect = ANOMALY_EFFECTS.get(anomaly_type)
        if line_id is None or effect is None:
            continue
        factor, rate = effect
        current = penalty.get(line_id)
        # 取最严：节拍系数最小、合格率最低，不连乘
        penalty[line_id] = (factor, rate) if current is None else (
            min(current[0], factor),
            min(current[1], rate),
        )

    states: dict[str, LineState] = {}
    for line_id, members in by_line.items():
        total = len(members)
        running = [device_id for device_id, db_status in members if _is_available(db_status, epoch, cfg)]
        conveyor_down = any(
            device_id.startswith(CONVEYOR_PREFIX)
            for device_id, db_status in members
            if not _is_available(db_status, epoch, cfg)
        )

        factor, qualified_rate = penalty.get(line_id, (1.0, BASE_QUALIFIED_RATE))
        if conveyor_down:
            useful = 0.0
            reason = "输送机停机 → 整线停"
        else:
            useful = len(running) / total if total else 0.0
            reason = f"{len(running)}/{total} 台在转"
            if factor < 1.0:
                reason += f"，异常系数 {factor}"
            if useful == 0.0:
                reason += "（状态机处于 IDLE/STOPPED 相位）"

        states[line_id] = LineState(
            useful_rate=useful,
            pace_per_hour=rated_per_hour * useful * factor,
            qualified_rate=qualified_rate,
            reason=reason,
        )
    return states


def _is_available(db_status: str, epoch: float, cfg: DevicesConfig) -> bool:
    if db_status in UNAVAILABLE_STATUSES:
        return False
    return status_at(epoch, cfg) == "RUNNING"


def load_line_states(
    db: Session,
    epoch: float,
    cfg: DevicesConfig,
    rated_per_hour: float,
) -> tuple[dict[str, LineState], dict[str, str]]:
    """从库里读设备状态与活跃注入，算出每条线的节拍。

    第二个返回值是 device_id → devices.status，调用方（模拟器）用它把被人工停用的
    设备遥测一并写成 STOPPED，保证 /stats 的 utilization 与节拍同源。
    """
    rows = db.execute(
        text("SELECT device_id, COALESCE(line_id, '') AS line_id, status FROM devices ORDER BY device_id")
    ).all()
    devices = [(r.device_id, r.line_id, r.status) for r in rows]

    # 活跃窗口：started_at <= now < ended_at（ended_at 为空表示仍在进行）。
    # ended_at 为空的记录要按异常自身时长兜底：模拟器被强杀时来不及回填 ended_at，
    # 否则一条僵尸记录会让该线永久扣产能（2026-11-26 实测踩到过）。
    active = db.execute(
        text(
            """
            SELECT device_id, anomaly_type, started_at, ended_at FROM anomaly_injection
            WHERE started_at <= :now AND (ended_at IS NULL OR ended_at > :now)
            """
        ),
        {"now": _to_datetime(epoch)},
    ).all()
    anomalies = [
        (r.device_id, r.anomaly_type)
        for r in active
        if r.ended_at is not None
        or epoch < r.started_at.timestamp() + duration_seconds(cfg, r.anomaly_type)
    ]

    states = compute_line_states(devices, epoch, cfg, rated_per_hour, anomalies)
    return states, {device_id: status for device_id, _, status in devices}


def _to_datetime(epoch: float):
    from datetime import datetime, timezone

    return datetime.fromtimestamp(epoch, tz=timezone.utc)
