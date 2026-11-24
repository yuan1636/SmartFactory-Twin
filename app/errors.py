"""统一错误体与异常处理器。

错误体结构固定为 {"code", "message", "detail"}（见 docs/spec_phase2.md 4.0），
三处来源要收敛成同一个结构：
1. 业务主动抛的 ApiError；
2. pydantic 请求体校验失败（FastAPI 默认返回 {"detail": [...]}，需要改写）；
3. 数据库连不上（必须变成 503 DB_UNAVAILABLE，而不是 500）。
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.constants import ErrorCode

logger = logging.getLogger(__name__)


class UTF8JSONResponse(JSONResponse):
    """显式带 charset=utf-8 的 JSON 响应（规格 4.0）。

    不加 charset 时，Windows PowerShell 5.1 的 Invoke-RestMethod 会按 ISO-8859-1 解码，
    中文告警文案直接变成"æ¯å¨"这种乱码，验收时看起来像数据损坏。
    """

    media_type = "application/json; charset=utf-8"


class ApiError(Exception):
    """业务异常：直接带 HTTP 状态码与错误码，由处理器转成统一错误体。"""

    def __init__(
        self,
        status_code: int,
        code: ErrorCode | str,
        message: str,
        detail: Any = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code.value if isinstance(code, ErrorCode) else code
        self.message = message
        self.detail = detail


def error_body(code: str, message: str, detail: Any = None) -> dict[str, Any]:
    return {"code": code, "message": message, "detail": detail}


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return UTF8JSONResponse(
            status_code=exc.status_code,
            content=error_body(exc.code, exc.message, exc.detail),
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        # pydantic 的 errors() 里可能带不可 JSON 序列化的对象，转成字符串
        detail = [
            {
                "field": ".".join(str(p) for p in err.get("loc", []) if p != "body"),
                "message": err.get("msg", ""),
                "type": err.get("type", ""),
            }
            for err in exc.errors()
        ]
        return UTF8JSONResponse(
            status_code=422,
            content=error_body(ErrorCode.VALIDATION_ERROR.value, "请求参数校验失败", detail),
        )

    @app.exception_handler(SQLAlchemyError)
    async def _db_error(_: Request, exc: SQLAlchemyError) -> JSONResponse:
        logger.error("数据库操作失败：%s", exc)
        return UTF8JSONResponse(
            status_code=503,
            content=error_body(ErrorCode.DB_UNAVAILABLE.value, "数据库连接失败或查询出错", None),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        # 404 / 405 这类框架级错误也套上统一结构，避免前端解析两种格式
        code = {
            404: ErrorCode.NOT_FOUND.value,
            405: ErrorCode.METHOD_NOT_ALLOWED.value,
        }.get(exc.status_code, f"HTTP_{exc.status_code}")
        return UTF8JSONResponse(
            status_code=exc.status_code,
            content=error_body(code, str(exc.detail), None),
        )
