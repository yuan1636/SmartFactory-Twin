"""FastAPI 应用入口。

启动命令（仓库根目录）：uvicorn app.main:app --port 8000
所有接口统一前缀 /api/v1（4.0）。
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI

from app.config import settings
from app.db import db_available
from app.errors import UTF8JSONResponse, register_exception_handlers
from app.routers import alarms, anomalies, devices, health, hierarchy, maintenance, ml, orders, report, telemetry, ws
from app.services import monitor

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not db_available():
        # 不直接退出：让 /health 明确报 503，比进程一起就崩更好排查
        logger.warning("数据库当前不可用，服务仍启动；/health 会返回 503，后台任务会自动重试")
    tasks = monitor.start_background_tasks()
    logger.info("后台任务已启动：告警扫描 / 告警收敛 / 快照推送")
    try:
        yield
    finally:
        await monitor.stop_background_tasks(tasks)
        logger.info("后台任务已停止")


app = FastAPI(
    title="SmartFactory Twin API",
    version=settings.app_version,
    description="智慧工厂数字孪生与 AI 智能分析平台 —— 第 2 阶段后端（模拟数据）",
    lifespan=lifespan,
    # 统一响应头 application/json; charset=utf-8，中文文案在 PowerShell 里才不会乱码
    default_response_class=UTF8JSONResponse,
)

register_exception_handlers(app)

api = APIRouter(prefix="/api/v1")
api.include_router(health.router)
api.include_router(hierarchy.router)
api.include_router(devices.router)
api.include_router(telemetry.router)
api.include_router(alarms.router)
api.include_router(orders.router)
api.include_router(maintenance.router)
api.include_router(anomalies.router)
api.include_router(ml.router)
api.include_router(report.router)
api.include_router(ws.router)

app.include_router(api)


@app.get("/", include_in_schema=False)
def root() -> dict:
    return {
        "name": "SmartFactory Twin API",
        "version": settings.app_version,
        "docs": "/docs",
        "api_prefix": "/api/v1",
    }
