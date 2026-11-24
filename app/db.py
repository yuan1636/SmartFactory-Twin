"""数据库连接。

用同步 SQLAlchemy（不是 async），原因是：本项目并发极低（单机演示），
同步写法对新手排查最直观，FastAPI 会把 def 路由自动放到线程池执行。

注意：本文件只负责连接，不负责建表。表结构以 database/schema.sql 为唯一来源，
禁止用 Base.metadata.create_all() 建表（G-16）。
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings

engine: Engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,   # 容器重启后旧连接会失效，取连接前先探活
    pool_size=5,
    max_overflow=10,
    future=True,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)


def get_db() -> Iterator[Session]:
    """FastAPI 依赖：一次请求一个会话，请求结束必关。"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def session_scope() -> Iterator[Session]:
    """给后台任务 / 脚本用的会话：正常提交，异常回滚。"""
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def db_available() -> bool:
    """健康检查用：能跑通 SELECT 1 就算可用。"""
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except SQLAlchemyError:
        return False
