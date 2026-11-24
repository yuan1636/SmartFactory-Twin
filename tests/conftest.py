"""pytest 公共夹具（第 2 阶段最小测试网）。

两条约定：

1. **不 mock 数据库**：第 2 阶段只有一套 PostgreSQL 容器，测试直接打真库。
   这样才能验证"告警是后台扫描任务真的写进库里的"，mock 掉就只剩表面功夫。
2. **自己造数据、自己清数据**：不依赖库里已有的历史数据，用例重复执行结果稳定。

清理策略（两种，按数据时间区分）：
- 2020 年固定区间的数据（时序/降采样用例）：按 `ts < 2021-01-01` 一条 DELETE 清掉；
- 当前时刻附近的数据（告警用例）：只删本次用例登记过的精确时间戳，不碰其它行。
"""

from __future__ import annotations

import os
import pathlib
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# 测试专用：把告警扫描的"首扫回看窗"从默认 600 秒压到 30 秒。
# 原因：默认值会让每次 pytest 启动都重扫最近 10 分钟写入的全部遥测（回填场景下是 60 万行），
# 既慢，又会把历史异常重新判成告警，污染"恰好 N 条"这类断言。
# 必须在 import app.* 之前设置：settings 是模块级单例，导入时就固定了。
os.environ.setdefault("ALARM_SCAN_INITIAL_LOOKBACK_SECONDS", "30")

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.db import engine  # noqa: E402
from app.main import app  # noqa: E402

# 2020 年固定测试区间：既不会被"最近 1 小时 / 最近 60 秒"类逻辑命中，也方便精确清理
TEST_TS_UPPER = "2021-01-01T00:00:00+00:00"


@pytest.fixture(scope="session")
def client():
    """用 `with` 进入才会执行 lifespan —— 告警扫描/收敛后台任务必须真的在跑。"""
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(scope="session")
def db_exec():
    """直接执行 SQL 的薄封装，只给造数据、清数据用，不参与断言。

    注意：DELETE / UPDATE 不返回结果集，所以这里不能调用 `.all()`，
    否则 SQLAlchemy 会抛 ResourceClosedError。
    """

    def _exec(sql: str, params: dict | None = None):
        with engine.begin() as conn:
            conn.execute(text(sql), params or {})

    return _exec


@pytest.fixture()
def purge(db_exec):
    """清理夹具：用例开始前清一次，结束后再清一次，保证库里不留测试垃圾。

    用法：
        purge("CNC-02")                          # 清该设备 2020 区间遥测 + 全部告警 + 状态复位
        purge("CNC-02", window=(t_lo, t_hi))     # 额外删掉本次写入的这段实时数据（模拟器此时已停，
                                                 # 所以该窗口内的行一定是用例自己造的）
    """

    touched: list[str] = []

    def _purge(
        *device_ids: str,
        window: tuple[str, str] | None = None,
    ) -> None:
        for device_id in device_ids:
            if device_id not in touched:
                touched.append(device_id)
            db_exec(
                "DELETE FROM alarms WHERE device_id = :d",
                {"d": device_id},
            )
            db_exec(
                "DELETE FROM device_telemetry WHERE device_id = :d AND ts < :upper",
                {"d": device_id, "upper": TEST_TS_UPPER},
            )
            if window is not None:
                db_exec(
                    "DELETE FROM device_telemetry "
                    "WHERE device_id = :d AND ts >= :lo AND ts <= :hi",
                    {"d": device_id, "lo": window[0], "hi": window[1]},
                )
            db_exec(
                "UPDATE devices SET status = 'RUNNING' WHERE device_id = :d",
                {"d": device_id},
            )

    yield _purge

    for device_id in touched:
        _purge(device_id)
