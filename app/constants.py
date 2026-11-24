"""枚举与错误码常量。

枚举一律 VARCHAR + CHECK 约束（G-06），Python 侧用 str, Enum 一一对应，
这样接口里传的就是字符串本身，不需要额外转换。
"""

from __future__ import annotations

from enum import Enum


class DeviceType(str, Enum):
    CNC = "CNC"
    ROBOT = "ROBOT"
    CONVEYOR = "CONVEYOR"
    INSPECTION = "INSPECTION"
    AUX = "AUX"


class DeviceStatus(str, Enum):
    RUNNING = "RUNNING"
    IDLE = "IDLE"
    STOPPED = "STOPPED"
    ALARM = "ALARM"
    MAINTENANCE = "MAINTENANCE"


class RunningStatus(str, Enum):
    """采样点状态：不含 ALARM / MAINTENANCE，那是设备级状态（G-10）。"""

    RUNNING = "RUNNING"
    IDLE = "IDLE"
    STOPPED = "STOPPED"


class AlarmType(str, Enum):
    TEMPERATURE = "TEMPERATURE"
    VIBRATION = "VIBRATION"
    CURRENT = "CURRENT"
    STATUS = "STATUS"


class AlarmLevel(str, Enum):
    INFO = "INFO"
    WARNING = "WARNING"
    CRITICAL = "CRITICAL"


class OrderStatus(str, Enum):
    PLANNED = "PLANNED"
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETED = "COMPLETED"
    DELAYED = "DELAYED"


class MaintenanceType(str, Enum):
    ROUTINE = "ROUTINE"
    REPAIR = "REPAIR"
    INSPECTION = "INSPECTION"


class AnomalyType(str, Enum):
    TEMP_DRIFT = "TEMP_DRIFT"
    VIB_SPIKE = "VIB_SPIKE"
    CURRENT_ABNORMAL = "CURRENT_ABNORMAL"


# 告警类型 → 遥测字段名（转速不产生告警，故意不在表里）
ALARM_METRIC: dict[str, str] = {
    AlarmType.TEMPERATURE.value: "temperature",
    AlarmType.VIBRATION.value: "vibration",
    AlarmType.CURRENT.value: "current",
}

METRIC_LABEL: dict[str, str] = {
    "temperature": "温度",
    "vibration": "振动",
    "current": "电流",
}

METRIC_UNIT: dict[str, str] = {
    "temperature": "℃",
    "vibration": "mm/s",
    "current": "A",
}

# 指标 → 展示精度（响应层统一 round，数据库存原始精度，见 4.0）
METRIC_DIGITS: dict[str, int] = {
    "temperature": 1,
    "vibration": 2,
    "current": 2,
    "speed": 0,
}


class ErrorCode(str, Enum):
    INVALID_PARAM = "INVALID_PARAM"
    RANGE_TOO_LARGE = "RANGE_TOO_LARGE"
    DEVICE_NOT_FOUND = "DEVICE_NOT_FOUND"
    ALARM_NOT_FOUND = "ALARM_NOT_FOUND"
    ALARM_ALREADY_RESOLVED = "ALARM_ALREADY_RESOLVED"
    DUPLICATE_TELEMETRY = "DUPLICATE_TELEMETRY"
    DEVICE_HAS_OPEN_ALARM = "DEVICE_HAS_OPEN_ALARM"
    VALIDATION_ERROR = "VALIDATION_ERROR"
    DB_UNAVAILABLE = "DB_UNAVAILABLE"
    METHOD_NOT_ALLOWED = "METHOD_NOT_ALLOWED"
    NOT_FOUND = "NOT_FOUND"
