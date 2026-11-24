"""WebSocket 连接管理与广播。

只做两件事：记住当前连着的客户端、把消息发给所有人。
发送失败（客户端已断开）就把该连接摘掉，不让一个死连接拖住整轮广播。
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    def __init__(self) -> None:
        self._connections: list[WebSocket] = []

    @property
    def count(self) -> int:
        return len(self._connections)

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections.append(websocket)
        logger.info("WebSocket 连接建立，当前客户端数 %d", len(self._connections))

    def disconnect(self, websocket: WebSocket) -> None:
        if websocket in self._connections:
            self._connections.remove(websocket)
            logger.info("WebSocket 连接断开，当前客户端数 %d", len(self._connections))

    async def broadcast(self, payload: dict[str, Any]) -> None:
        if not self._connections:
            return
        for websocket in list(self._connections):
            try:
                await websocket.send_json(payload)
            except Exception:  # 连接已断 / 发送缓冲满，摘掉即可，不中断其它客户端
                self.disconnect(websocket)


manager = ConnectionManager()
