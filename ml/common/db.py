"""只读数据库访问（离线批处理用）。

为什么不直接用 `app.db`：ml 脚本是离线批处理，不需要 FastAPI 的会话生命周期与
请求级事务；但**连接串必须与后端同源**，否则训练用的库和线上不是一个库，
指标再漂亮也没有意义。所以这里优先读环境变量 / .env，退路是复用 `app.config.settings`。

只读约定：本模块只暴露 `engine()`，所有查询都走 `read_sql`，不提供写入口。
写入 `anomaly_scores` 由 `ml/anomaly_detection/score.py` 单独负责。
"""

from __future__ import annotations

import os
from functools import lru_cache

from sqlalchemy import Engine, create_engine

_FALLBACK_URL = "postgresql+psycopg://sf:sf_dev_pw@localhost:5433/smartfactory"


def database_url() -> str:
    """连接串，优先级：环境变量 → .env（经 app.config） → 硬编码兜底。"""
    url = os.getenv("DATABASE_URL")
    if url:
        return url
    try:
        from app.config import settings  # 延迟导入：没装后端依赖时也能用兜底值

        return settings.database_url
    except Exception:
        return _FALLBACK_URL


@lru_cache(maxsize=1)
def engine() -> Engine:
    """进程内单例连接池。`pool_pre_ping` 让休眠后重连不用手工处理。"""
    return create_engine(database_url(), pool_pre_ping=True, future=True)


def describe() -> str:
    """把连接目标打成一行，训练日志开头打印，便于核对"我连的到底是哪台库"。"""
    url = database_url()
    # 不打印口令：只保留 用户名@主机:端口/库名
    if "://" in url and "@" in url:
        scheme, rest = url.split("://", 1)
        userinfo, tail = rest.rsplit("@", 1)
        user = userinfo.split(":")[0]
        return f"{scheme}://{user}@{tail}"
    return url
