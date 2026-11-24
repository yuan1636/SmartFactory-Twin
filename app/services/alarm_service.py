"""告警判定与收敛（规格 4.18）。

两个常驻任务：
1. scan_new_telemetry：按 `inserted_at` 增量扫描遥测（所以回填的历史数据也会被判定），
   超阈值写 alarms 并把 devices.status 置 ALARM；同一设备同一类型 5 分钟冷却。
2. converge_alarms：未解除告警的对应指标在最近 60 秒内回落到 WARNING 阈值以下时，
   回填 resolved_at；再按 G-10 规则决定设备状态（还有别的未解除告警就保持 ALARM）。

为什么判定放后端而不是模拟器：第 3 阶段换成真实数据源时，判定代码一行都不用改（G-09）。
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlalchemy import text

from app.config import devices_config, settings
from app.constants import (
    ALARM_METRIC,
    METRIC_DIGITS,
    METRIC_LABEL,
    METRIC_UNIT,
    AlarmLevel,
)
from app.db import session_scope
from app.utils import iso, utcnow

logger = logging.getLogger(__name__)

# 扫描游标：只在进程内维护，重启后按 lookback 回看一段（见 settings）
_cursor: datetime | None = None


def reset_cursor() -> None:
    """测试/排障用：把扫描游标复位成"回到起点"。"""
    global _cursor
    _cursor = None


def _within_cooldown(known: list[datetime], ts: datetime) -> bool:
    """同一设备同一类型，前后 5 分钟内已有一条告警就不再写（G-09）。"""
    window = timedelta(minutes=settings.alarm_cooldown_minutes)
    return any(abs(ts - t) <= window for t in known)


def _build_message(device_id: str, metric: str, value: float, threshold: float, level: str) -> str:
    digits = METRIC_DIGITS[metric]
    unit = METRIC_UNIT[metric]
    label = METRIC_LABEL[metric]
    level_text = "严重阈值" if level == AlarmLevel.CRITICAL.value else "预警阈值"
    return (
        f"{device_id} {label} {value:.{digits}f}{unit} "
        f"超过{level_text} {threshold:.{digits}f}{unit}"
    )


def scan_new_telemetry() -> list[dict]:
    """增量扫描并写入告警，返回需要广播的 alarm 事件列表。"""
    global _cursor
    created_events: list[dict] = []
    now = utcnow()

    with session_scope() as db:
        if _cursor is None:
            # 首次运行回看一段时间：覆盖"后端比模拟器晚启动"与回填刚写完的场景
            _cursor = now - timedelta(seconds=settings.alarm_scan_initial_lookback_seconds)
        scan_from = _cursor
        next_cursor = _cursor

        for dev in devices_config.devices:
            agg = db.execute(
                text(
                    """
                    SELECT min(ts) AS min_ts, max(ts) AS max_ts,
                           count(*) AS row_count, max(inserted_at) AS max_inserted
                    FROM device_telemetry
                    WHERE device_id = :device_id AND inserted_at >= :scan_from
                    """
                ),
                {"device_id": dev.device_id, "scan_from": scan_from},
            ).one()
            row_count = int(agg.row_count or 0)
            if row_count == 0:
                continue
            max_inserted = agg.max_inserted
            if max_inserted is not None and max_inserted > next_cursor:
                next_cursor = max_inserted

            # 只取这个时间范围内的历史告警，用来判冷却；避免把整张表读进内存
            cooldown = timedelta(minutes=settings.alarm_cooldown_minutes)
            known_rows = db.execute(
                text(
                    """
                    SELECT alarm_type, detected_at FROM alarms
                    WHERE device_id = :device_id
                      AND detected_at BETWEEN :lo AND :hi
                    """
                ),
                {
                    "device_id": dev.device_id,
                    "lo": agg.min_ts - cooldown,
                    "hi": agg.max_ts + cooldown,
                },
            ).all()
            known: dict[str, list[datetime]] = {}
            for kr in known_rows:
                known.setdefault(kr.alarm_type, []).append(kr.detected_at)

            pending: list[dict] = []
            rows = db.execute(
                text(
                    """
                    SELECT ts, temperature, vibration, current
                    FROM device_telemetry
                    WHERE device_id = :device_id AND inserted_at >= :scan_from
                    ORDER BY ts
                    """
                ),
                {"device_id": dev.device_id, "scan_from": scan_from},
                execution_options={"stream_results": True, "yield_per": 2000},
            )
            for row in rows:
                ts = row.ts
                for metric, alarm_type in (
                    ("temperature", "TEMPERATURE"),
                    ("vibration", "VIBRATION"),
                    ("current", "CURRENT"),
                ):
                    value = float(getattr(row, metric))
                    warning = dev.warning(metric)
                    if value <= warning:
                        continue
                    critical = dev.critical(metric)
                    if value > critical:
                        level = AlarmLevel.CRITICAL.value
                        threshold = critical
                    else:
                        level = AlarmLevel.WARNING.value
                        threshold = warning
                    if _within_cooldown(known.get(alarm_type, []), ts):
                        continue
                    known.setdefault(alarm_type, []).append(ts)
                    pending.append(
                        {
                            "device_id": dev.device_id,
                            "alarm_type": alarm_type,
                            "alarm_level": level,
                            "message": _build_message(dev.device_id, metric, value, threshold, level),
                            "detected_at": ts,
                        }
                    )

            if not pending:
                continue

            # 告警条数远少于遥测条数，逐条插入即可，读回自增主键用于广播
            for item in pending:
                alarm_id = db.execute(
                    text(
                        """
                        INSERT INTO alarms (device_id, alarm_type, alarm_level, message, detected_at)
                        VALUES (:device_id, :alarm_type, :alarm_level, :message, :detected_at)
                        RETURNING alarm_id
                        """
                    ),
                    item,
                ).scalar_one()
                created_events.append(
                    {
                        "type": "alarm",
                        "event": "created",
                        "server_time": iso(now),
                        "alarm": {
                            "alarm_id": alarm_id,
                            "device_id": item["device_id"],
                            "device_name": dev.device_name,
                            "alarm_type": item["alarm_type"],
                            "alarm_level": item["alarm_level"],
                            "message": item["message"],
                            "detected_at": iso(item["detected_at"]),
                            "resolved_at": None,
                        },
                    }
                )

            # G-10：告警写入时联动设备状态；维护中的设备不覆盖（MAINTENANCE 只由维护接口改）
            db.execute(
                text(
                    """
                    UPDATE devices SET status = 'ALARM'
                    WHERE device_id = ANY(:ids) AND status <> 'MAINTENANCE'
                    """
                ),
                {"ids": [item["device_id"] for item in pending]},
            )

        _cursor = next_cursor

    if created_events:
        logger.info("新写入告警 %d 条", len(created_events))
    return created_events


def converge_alarms() -> list[dict]:
    """把已恢复正常的告警置为解除，并按 G-10 决定设备状态。"""
    resolved_events: list[dict] = []
    now = utcnow()

    with session_scope() as db:
        open_alarms = db.execute(
            text(
                """
                SELECT a.alarm_id, a.device_id, a.alarm_type, a.detected_at, d.device_name
                FROM alarms a
                JOIN devices d ON d.device_id = a.device_id
                WHERE a.resolved_at IS NULL
                ORDER BY a.alarm_id
                """
            )
        ).all()
        if not open_alarms:
            return []

        # 一次查出所有设备最近 60 秒的指标峰值，避免每条告警都单独查库
        window_start = now - timedelta(seconds=settings.alarm_converge_window_seconds)
        stats_rows = db.execute(
            text(
                """
                SELECT device_id,
                       max(temperature) AS temperature,
                       max(vibration)   AS vibration,
                       max(current)     AS current
                FROM device_telemetry
                WHERE ts >= :window_start
                GROUP BY device_id
                """
            ),
            {"window_start": window_start},
        ).all()
        stats = {r.device_id: r for r in stats_rows}

        to_resolve: list[dict] = []
        for alarm in open_alarms:
            metric = ALARM_METRIC.get(alarm.alarm_type)
            if metric is None:
                continue  # STATUS 类告警没有对应指标，不自动收敛
            row = stats.get(alarm.device_id)
            if row is None:
                continue  # 最近 60 秒没有遥测，无法判断，保持现状
            peak = getattr(row, metric)
            if peak is None:
                continue
            dev = devices_config.get(alarm.device_id)
            if dev is None:
                continue
            if float(peak) >= dev.warning(metric):
                continue
            to_resolve.append(
                {
                    "alarm_id": alarm.alarm_id,
                    "device_id": alarm.device_id,
                    "device_name": alarm.device_name,
                    "alarm_type": alarm.alarm_type,
                    "detected_at": alarm.detected_at,
                }
            )

        if not to_resolve:
            return []

        db.execute(
            text(
                """
                UPDATE alarms SET resolved_at = :resolved_at
                WHERE alarm_id = ANY(:ids) AND resolved_at IS NULL
                """
            ),
            {"resolved_at": now, "ids": [a["alarm_id"] for a in to_resolve]},
        )

        affected_devices = sorted({a["device_id"] for a in to_resolve})
        device_status: dict[str, str] = {}
        for device_id in affected_devices:
            remaining = db.execute(
                text(
                    """
                    SELECT count(*) FROM alarms
                    WHERE device_id = :device_id AND resolved_at IS NULL
                    """
                ),
                {"device_id": device_id},
            ).scalar_one()
            # G-10 修订：只有该设备一条未解除告警都不剩，才能回到 RUNNING
            if remaining == 0:
                db.execute(
                    text(
                        """
                        UPDATE devices SET status = 'RUNNING'
                        WHERE device_id = :device_id AND status = 'ALARM'
                        """
                    ),
                    {"device_id": device_id},
                )
            device_status[device_id] = db.execute(
                text("SELECT status FROM devices WHERE device_id = :device_id"),
                {"device_id": device_id},
            ).scalar_one()

        for item in to_resolve:
            resolved_events.append(
                {
                    "type": "alarm",
                    "event": "resolved",
                    "server_time": iso(now),
                    "alarm": {
                        "alarm_id": item["alarm_id"],
                        "device_id": item["device_id"],
                        "device_name": item["device_name"],
                        "alarm_type": item["alarm_type"],
                        "resolved_at": iso(now),
                    },
                    "device_status": device_status.get(item["device_id"]),
                }
            )

    if resolved_events:
        logger.info("自动解除告警 %d 条", len(resolved_events))
    return resolved_events
