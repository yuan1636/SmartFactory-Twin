"""健康检查（4.1）。"""

from __future__ import annotations

from fastapi import APIRouter

from app.config import settings
from app.constants import ErrorCode
from app.db import db_available
from app.errors import ApiError
from app.utils import iso, utcnow

router = APIRouter(tags=["health"])


@router.get("/health", summary="健康检查")
def health() -> dict:
    if not db_available():
        # 数据库不可用时必须给出 503，而不是 200 + 空数据，否则前端会以为一切正常
        raise ApiError(
            503,
            ErrorCode.DB_UNAVAILABLE,
            "数据库连接失败",
            {"db": "down"},
        )
    return {
        "status": "ok",
        "db": "ok",
        "version": settings.app_version,
        "server_time": iso(utcnow()),
    }
