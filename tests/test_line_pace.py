"""产线节拍（line_pace）的口径测试 —— D-73。

三个必须钉住的规则：
1. useful_rate = 可用设备数 / 该线设备数，状态机不在 RUNNING 相位时为 0；
2. 输送机（CONV）不可用时整线节拍为 0（作者 2026-11-26 裁定，工件过不去）；
3. 异常对节拍的惩罚取最严一档，不连乘；ALARM 不减可用率（惩罚走异常通道，防双重扣减）。

纯函数 compute_line_states 不碰数据库，用对齐到状态机相位的 epoch 控制 RUNNING/IDLE/STOPPED。
"""

from __future__ import annotations

import pytest

from app.config import devices_config
from data_pipeline.line_pace import (
    ANOMALY_EFFECTS,
    BASE_QUALIFIED_RATE,
    compute_line_states,
)

RATED = 30.0
CYCLE = devices_config.status_machine["cycle_minutes"] * 60
RUNNING_END = devices_config.status_machine["running_minutes"] * 60
IDLE_END = RUNNING_END + devices_config.status_machine["idle_minutes"] * 60

# 三个对齐到状态机相位的时刻（同一个周期内）：1 分钟处 RUNNING、27 分钟处 IDLE、29.5 分钟处 STOPPED
EPOCH_RUNNING = CYCLE * 1000 + 60
EPOCH_IDLE = CYCLE * 1000 + (RUNNING_END + IDLE_END) / 2
EPOCH_STOPPED = CYCLE * 1000 + (IDLE_END + CYCLE) / 2

LINE_DEVICES = [
    ("CNC-01", "LINE-A1", "RUNNING"),
    ("CONV-01", "LINE-A1", "RUNNING"),
    ("ROB-01", "LINE-A1", "RUNNING"),
]


def _states(devices, epoch=EPOCH_RUNNING, anomalies=()):
    return compute_line_states(devices, epoch, devices_config, RATED, list(anomalies))


def test_all_running_full_pace():
    state = _states(LINE_DEVICES)["LINE-A1"]
    assert state.useful_rate == pytest.approx(1.0)
    assert state.pace_per_hour == pytest.approx(RATED)
    assert state.qualified_rate == pytest.approx(BASE_QUALIFIED_RATE)


def test_one_device_maintenance_gives_two_thirds():
    devices = [("CNC-01", "LINE-A1", "RUNNING"), ("CONV-01", "LINE-A1", "RUNNING"),
               ("ROB-01", "LINE-A1", "MAINTENANCE")]
    state = _states(devices)["LINE-A1"]
    assert state.useful_rate == pytest.approx(2 / 3)
    assert state.pace_per_hour == pytest.approx(RATED * 2 / 3)


def test_conveyor_down_stops_whole_line():
    """输送机停 → 整线 0，即便另外两台还在转。"""
    devices = [("CNC-01", "LINE-A1", "RUNNING"), ("CONV-01", "LINE-A1", "MAINTENANCE"),
               ("ROB-01", "LINE-A1", "RUNNING")]
    state = _states(devices)["LINE-A1"]
    assert state.useful_rate == 0.0
    assert state.pace_per_hour == 0.0
    assert "输送机" in state.reason


def test_alarm_status_still_available():
    """ALARM 只表示在报警，设备仍在转；异常惩罚由异常通道负责，避免双重扣减。"""
    devices = [("CNC-01", "LINE-A1", "ALARM"), ("CONV-01", "LINE-A1", "RUNNING"),
               ("ROB-01", "LINE-A1", "RUNNING")]
    state = _states(devices)["LINE-A1"]
    assert state.useful_rate == pytest.approx(1.0)


def test_idle_phase_has_no_output():
    state = _states(LINE_DEVICES, epoch=EPOCH_IDLE)["LINE-A1"]
    assert state.useful_rate == 0.0


def test_stopped_phase_has_no_output():
    state = _states(LINE_DEVICES, epoch=EPOCH_STOPPED)["LINE-A1"]
    assert state.useful_rate == 0.0


def test_vib_spike_penalty():
    factor, rate = ANOMALY_EFFECTS["VIB_SPIKE"]
    state = _states(LINE_DEVICES, anomalies=[("CNC-01", "VIB_SPIKE")])["LINE-A1"]
    assert state.pace_per_hour == pytest.approx(RATED * factor)
    assert state.qualified_rate == pytest.approx(rate)


def test_strictest_anomaly_wins_without_stacking():
    """同一线同时 VIB_SPIKE 与 TEMP_DRIFT：取更严的 0.75 / 0.90，而不是 0.85×0.75。"""
    anomalies = [("CNC-01", "VIB_SPIKE"), ("ROB-01", "TEMP_DRIFT")]
    state = _states(LINE_DEVICES, anomalies=anomalies)["LINE-A1"]
    assert state.pace_per_hour == pytest.approx(RATED * 0.75)
    assert state.qualified_rate == pytest.approx(0.90)


def test_auxiliary_devices_do_not_affect_lines():
    devices = LINE_DEVICES + [("AIR-01", "", "MAINTENANCE"), ("PUMP-01", "", "STOPPED")]
    states = _states(devices)
    assert set(states) == {"LINE-A1"}
    assert states["LINE-A1"].useful_rate == pytest.approx(1.0)
