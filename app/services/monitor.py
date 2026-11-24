"""后台常驻任务：告警扫描、告警收敛、WebSocket 快照推送。

三个循环互不干扰：任何一个抛异常只记录日志并等下一轮，不能让整个后端挂掉。
进程启动时立刻执行一次（不等第一个周期），否则刚起服务的 5 秒内告警页是空的（4.18）。
"""

from __future__ import annotations

import asyncio
import contextlib
import logging

from app.config import settings
from app.services import alarm_service
from app.services.snapshot import build_snapshot
from app.services.ws_manager import manager

logger = logging.getLogger(__name__)


async def _alarm_scan_loop() -> None:
    while True:
        try:
            events = await asyncio.to_thread(alarm_service.scan_new_telemetry)
            for event in events:
                await manager.broadcast(event)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("告警扫描失败，%s 秒后重试", settings.alarm_scan_interval_seconds)
        await asyncio.sleep(settings.alarm_scan_interval_seconds)


async def _alarm_converge_loop() -> None:
    while True:
        try:
            events = await asyncio.to_thread(alarm_service.converge_alarms)
            for event in events:
                await manager.broadcast(event)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("告警收敛失败，%s 秒后重试", settings.alarm_scan_interval_seconds)
        await asyncio.sleep(settings.alarm_scan_interval_seconds)


async def _snapshot_loop() -> None:
    while True:
        try:
            if manager.count:  # 没人连时不查库，省掉每秒一次的空查询
                snapshot = await asyncio.to_thread(build_snapshot)
                await manager.broadcast(snapshot)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("快照推送失败，%s 秒后重试", settings.ws_snapshot_interval_seconds)
        await asyncio.sleep(settings.ws_snapshot_interval_seconds)


def start_background_tasks() -> list[asyncio.Task]:
    return [
        asyncio.create_task(_alarm_scan_loop(), name="alarm-scan"),
        asyncio.create_task(_alarm_converge_loop(), name="alarm-converge"),
        asyncio.create_task(_snapshot_loop(), name="ws-snapshot"),
    ]


async def stop_background_tasks(tasks: list[asyncio.Task]) -> None:
    for task in tasks:
        task.cancel()
    for task in tasks:
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task
