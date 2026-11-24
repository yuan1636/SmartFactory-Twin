"""WebSocket 实时推送（4.17 / 第 5 节）。

握手时先检查数据库：连不上数据库就别让客户端连上一个永远没数据的通道，
直接用 1011 关闭，前端看到的是"服务不可用"而不是"一直在等消息"。
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.db import db_available
from app.services.snapshot import build_snapshot
from app.services.ws_manager import manager

logger = logging.getLogger(__name__)

router = APIRouter(tags=["websocket"])


@router.websocket("/ws/telemetry")
async def telemetry_stream(websocket: WebSocket) -> None:
    if not db_available():
        await websocket.close(code=1011)
        return

    await manager.connect(websocket)
    try:
        # 连上先给一条，前端不用等第一个 1 秒周期
        await websocket.send_json(await asyncio.to_thread(build_snapshot))
        # 客户端不发消息，这里只负责"挂着"以便感知断开
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception:
        logger.exception("WebSocket 连接异常")
        manager.disconnect(websocket)
