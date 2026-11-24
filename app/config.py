"""全局配置与设备配置加载。

为什么把设备清单和阈值放在 JSON 而不是代码里：模拟器造数据、后端判告警、
第 4 阶段标注三处必须读同一份阈值，否则改一个忘两个（AGENTS.md 规则 8）。
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic_settings import BaseSettings, SettingsConfigDict

# 仓库根目录（app/ 的上一级）
BASE_DIR = Path(__file__).resolve().parent.parent
DEVICES_CONFIG_PATH = BASE_DIR / "config" / "devices.json"


class Settings(BaseSettings):
    """运行期配置，优先读环境变量，其次读 .env，最后用这里的默认值。"""

    model_config = SettingsConfigDict(
        env_file=str(BASE_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # 宿主机端口固定 5433，避免与本机已装的 PostgreSQL 抢 5432
    database_url: str = "postgresql+psycopg://sf:sf_dev_pw@localhost:5433/smartfactory"
    # 用 127.0.0.1 而不是 localhost：Windows 上 localhost 会先试 IPv6(::1)，
    # 而 uvicorn 默认只监听 IPv4，每次请求会白等约 2 秒（实测 2030ms → 4ms）
    simulator_api_base: str = "http://127.0.0.1:8000/api/v1"
    app_version: str = "1.0.0"

    # 时序查询保护（G-17）
    telemetry_default_window_seconds: int = 3600
    telemetry_max_window_seconds: int = 24 * 3600
    telemetry_max_points: int = 5000
    page_size_default: int = 50
    page_size_max: int = 200

    # 告警：同一设备同一类型 5 分钟冷却（G-09）
    alarm_cooldown_minutes: int = 5
    alarm_scan_interval_seconds: int = 5
    alarm_converge_window_seconds: int = 60
    # 启动时回看多久的 inserted_at，覆盖"后端比模拟器后启动一小会儿"的场景
    alarm_scan_initial_lookback_seconds: int = 600

    # WebSocket 快照推送间隔（G-13）
    ws_snapshot_interval_seconds: int = 1


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


settings = get_settings()


class DeviceConfig:
    """单台设备的配置视图，字段与 config/devices.json 一一对应。"""

    __slots__ = (
        "device_id",
        "device_name",
        "device_type",
        "workshop_id",
        "line_id",
        "model",
        "normal_range",
        "thresholds",
        "anomaly_type",
    )

    def __init__(self, raw: dict[str, Any]) -> None:
        self.device_id: str = raw["device_id"]
        self.device_name: str = raw["device_name"]
        self.device_type: str = raw["device_type"]
        self.workshop_id: str | None = raw.get("workshop_id")
        self.line_id: str | None = raw.get("line_id")
        self.model: str | None = raw.get("model")
        self.normal_range: dict[str, list[float]] = raw["normal_range"]
        self.thresholds: dict[str, dict[str, float]] = raw["thresholds"]
        self.anomaly_type: str = raw["anomaly_type"]

    def warning(self, metric: str) -> float:
        return float(self.thresholds[metric]["warning"])

    def critical(self, metric: str) -> float:
        return float(self.thresholds[metric]["critical"])

    @property
    def metrics_normal_range(self) -> dict[str, dict[str, float]]:
        """给 /devices/{id} 用的四指标区间（含单位，前端可直接展示）。"""
        units = {"temperature": "℃", "vibration": "mm/s", "current": "A", "speed": "rpm"}
        out: dict[str, dict[str, float]] = {}
        for metric, (low, high) in self.normal_range.items():
            out[metric] = {"min": float(low), "max": float(high), "unit": units[metric]}
        return out


class DevicesConfig:
    """config/devices.json 的内存视图。"""

    def __init__(self, raw: dict[str, Any]) -> None:
        self.raw = raw
        self.version: str = raw.get("version", "1.0")
        self.sample_interval_seconds: int = int(raw["sample_interval_seconds"])
        self.drift_period_seconds: int = int(raw.get("drift_period_seconds", 600))
        self.status_machine: dict[str, int] = raw["status_machine"]
        self.scheduler: dict[str, Any] = raw["scheduler"]
        self.alarm_cooldown_minutes: int = int(raw.get("alarm_cooldown_minutes", 5))
        self.anomaly_types: dict[str, dict[str, Any]] = raw["anomaly_types"]
        self.devices: list[DeviceConfig] = [DeviceConfig(d) for d in raw["devices"]]
        self._by_id = {d.device_id: d for d in self.devices}

    def get(self, device_id: str) -> DeviceConfig | None:
        return self._by_id.get(device_id)

    def __contains__(self, device_id: str) -> bool:
        return device_id in self._by_id

    @property
    def device_ids(self) -> list[str]:
        return [d.device_id for d in self.devices]


@lru_cache(maxsize=1)
def get_devices_config() -> DevicesConfig:
    with DEVICES_CONFIG_PATH.open("r", encoding="utf-8") as fh:
        return DevicesConfig(json.load(fh))


devices_config = get_devices_config()
