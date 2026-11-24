"""指标生成公式与设备状态机（规格 6.3）。

公式是三段叠加：正态噪声打底 + 10 分钟正弦慢漂移 + 状态机修正。
这样曲线既不会像随机数那样抖动成一团，也不会平直得像假数据，
但仍然是模拟数据，不得对外表述为真实工厂数据（AGENTS.md 规则 12）。
"""

from __future__ import annotations

import math
import random

from app.config import DeviceConfig, DevicesConfig

METRICS = ("temperature", "vibration", "current", "speed")

# 各指标写入数据库前的硬边界，与 schema.sql 的 CHECK 一致
_HARD_LIMITS = {
    "temperature": (-20.0, 300.0),
    "vibration": (0.0, 100.0),
    "current": (0.0, 500.0),
    "speed": (0, 100000),
}


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def status_at(epoch: float, cfg: DevicesConfig) -> str:
    """状态机：每 30 分钟一个周期，RUNNING 26 分钟 → IDLE 3 分钟 → STOPPED 1 分钟。"""
    sm = cfg.status_machine
    cycle = sm["cycle_minutes"] * 60
    running_end = sm["running_minutes"] * 60
    idle_end = running_end + sm["idle_minutes"] * 60
    pos = epoch % cycle
    if pos < running_end:
        return "RUNNING"
    if pos < idle_end:
        return "IDLE"
    return "STOPPED"


def generate_metrics(
    dev: DeviceConfig,
    epoch: float,
    rng: random.Random,
    cfg: DevicesConfig,
) -> dict[str, float | int]:
    """生成一台设备某时刻的四项指标（未叠加异常注入）。"""
    values: dict[str, float] = {}
    for metric in METRICS:
        low, high = (float(x) for x in dev.normal_range[metric])
        center = (low + high) / 2
        sigma = (high - low) / 8          # 3 sigma 覆盖约 75% 半幅，越界极少
        base = center + rng.gauss(0, sigma)
        drift = (high - low) / 6 * math.sin(2 * math.pi * epoch / cfg.drift_period_seconds)
        value = clamp(base + drift, low * 0.9, high * 1.05)
        values[metric] = value

    status = status_at(epoch, cfg)
    if status == "STOPPED":
        # 停机时的物理表现：不转、几乎不吃电、几乎不振动
        low_current = float(dev.normal_range["current"][0])
        low_vibration = float(dev.normal_range["vibration"][0])
        values["speed"] = 0.0
        values["current"] = low_current * 0.10
        values["vibration"] = low_vibration * 0.30

    # 转速取整（数据库是 INTEGER），其余指标保留原始精度，展示时再 round
    result: dict[str, float | int] = {
        "temperature": round(clamp(values["temperature"], *_HARD_LIMITS["temperature"]), 3),
        "vibration": round(clamp(values["vibration"], *_HARD_LIMITS["vibration"]), 3),
        "current": round(clamp(values["current"], *_HARD_LIMITS["current"]), 3),
        "speed": int(round(clamp(values["speed"], *_HARD_LIMITS["speed"]))),
    }
    result["running_status"] = status
    return result


def clamp_for_write(values: dict) -> dict:
    """注入后的兜底夹断，防止某个参数写错把 CHECK 约束撞崩。"""
    values["temperature"] = round(clamp(float(values["temperature"]), *_HARD_LIMITS["temperature"]), 3)
    values["vibration"] = round(clamp(float(values["vibration"]), *_HARD_LIMITS["vibration"]), 3)
    values["current"] = round(clamp(float(values["current"]), *_HARD_LIMITS["current"]), 3)
    values["speed"] = int(round(clamp(float(values["speed"]), *_HARD_LIMITS["speed"])))
    return values
