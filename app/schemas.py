"""请求体模型（响应体直接构造 dict，见各路由：这样时间格式完全可控）。"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

RunningStatusLiteral = Literal["RUNNING", "IDLE", "STOPPED"]
MaintenanceTypeLiteral = Literal["ROUTINE", "REPAIR", "INSPECTION"]


class TelemetryIn(BaseModel):
    """单条遥测。范围约束与数据库 CHECK 一致，越界统一返回 422。"""

    model_config = ConfigDict(extra="forbid")

    device_id: str = Field(min_length=1, max_length=16)
    ts: datetime
    temperature: float = Field(ge=-20, le=300, description="温度，℃")
    vibration: float = Field(ge=0, le=100, description="振动速度有效值，mm/s")
    current: float = Field(ge=0, le=500, description="电流，A")
    speed: int = Field(ge=0, description="转速，rpm")
    running_status: RunningStatusLiteral


class TelemetryBatchIn(BaseModel):
    """批量写入。条数上限在路由里判断（超限要返回 400 RANGE_TOO_LARGE，不是 422）。"""

    model_config = ConfigDict(extra="forbid")

    items: list[TelemetryIn]


class DeviceStatusIn(BaseModel):
    """只允许人工设置 MAINTENANCE / RUNNING；ALARM 由告警流程写，IDLE/STOPPED 由数据驱动。"""

    model_config = ConfigDict(extra="forbid")

    status: str
    reason: str | None = None


class MaintenanceIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    device_id: str = Field(min_length=1, max_length=16)
    maintenance_type: MaintenanceTypeLiteral
    description: str | None = None
    started_at: datetime
    finished_at: datetime | None = None
    cost: Decimal | None = Field(default=None, ge=0)
