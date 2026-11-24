"""三类异常注入与 ground truth 记录（规格 3.4 / 6.4 / 6.5）。

铁律：注入开始前必须先写 anomaly_injection 记录，注入结束回填 ended_at。
这是第 4 阶段算检出率的唯一对照，事后补不回来（G-12）。
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import DeviceConfig, DevicesConfig, devices_config
from data_pipeline.generator import clamp_for_write

UTC = timezone.utc

# 不同异常类型改哪几个指标（TEMP_DRIFT 只改温度，其余指标照常）
_ANOMALY_METRICS = {
    "TEMP_DRIFT": ("temperature",),
    "VIB_SPIKE": ("vibration",),
    "CURRENT_ABNORMAL": ("current", "speed"),
}


def duration_seconds(cfg: DevicesConfig, anomaly_type: str) -> float:
    spec = cfg.anomaly_types[anomaly_type]
    if anomaly_type == "TEMP_DRIFT":
        return float(spec["rise_seconds"]) + float(spec["fall_seconds"])
    return float(spec["duration_seconds"])


@dataclass
class InjectionWindow:
    """一次注入的时间区间与效果。"""

    device_id: str
    anomaly_type: str
    start_epoch: float
    end_epoch: float
    injection_id: int | None = None
    params: dict = field(default_factory=dict)

    def is_active(self, epoch: float) -> bool:
        return self.start_epoch <= epoch <= self.end_epoch

    def apply(
        self,
        dev: DeviceConfig,
        values: dict,
        epoch: float,
        cfg: DevicesConfig,
        interval: int,
        rng: random.Random,
    ) -> None:
        """把注入效果叠加到已生成的基础值上（覆盖对应指标）。"""
        spec = cfg.anomaly_types[self.anomaly_type]
        elapsed = epoch - self.start_epoch

        if self.anomaly_type == "TEMP_DRIFT":
            rise = float(spec["rise_seconds"])
            fall = float(spec["fall_seconds"])
            slope = float(spec["slope_per_tick"])
            upper = float(dev.normal_range["temperature"][1])
            base = float(values["temperature"])
            if elapsed <= rise:
                temp = upper + slope * (elapsed / interval)
            else:
                peak = upper + slope * (rise / interval)
                frac = min(1.0, (elapsed - rise) / fall)
                temp = peak + (base - peak) * frac
            values["temperature"] = temp

        elif self.anomaly_type == "VIB_SPIKE":
            # 基线之上单独叠一层大噪声：一个采样点就能顶过 CRITICAL
            values["vibration"] = float(values["vibration"]) + rng.gauss(
                float(spec["amp"]), float(spec["sigma"])
            )

        elif self.anomaly_type == "CURRENT_ABNORMAL":
            ratio = float(spec["current_ratio"])
            speed_ratio = float(spec["speed_ratio"])
            values["current"] = float(values["current"]) * ratio
            values["speed"] = float(values["speed"]) * speed_ratio

        clamp_for_write(values)


def plan_backfill_windows(
    cfg: DevicesConfig,
    devices: list[DeviceConfig],
    start_epoch: float,
    end_epoch: float,
    interval: int,
    rng: random.Random | None = None,
) -> list[InjectionWindow]:
    """为回填区间预先排好注入窗口，保证注入效果与真值记录时间一致（6.5）。"""
    rng = rng or random.Random(cfg.scheduler["seed"])
    window_len = cfg.scheduler["window_minutes"] * 60
    windows: list[InjectionWindow] = []

    window_start = (start_epoch // window_len) * window_len
    while window_start < end_epoch:
        window_index = int(window_start // window_len)
        # 与实时调度同一套种子规则，回填出来的异常分布可复现
        window_rng = random.Random(cfg.scheduler["seed"] + window_index)
        count = window_rng.randint(*cfg.scheduler["devices_per_window"])
        picked = window_rng.sample(devices, min(count, len(devices)))
        for dev in picked:
            dur = duration_seconds(cfg, dev.anomaly_type)
            latest_start = window_start + window_len - dur
            raw_start = window_rng.uniform(window_start, max(window_start, latest_start))
            start = (raw_start // interval) * interval
            finish = start + dur
            if finish > end_epoch:
                finish = end_epoch
            if start >= finish:
                continue
            windows.append(
                InjectionWindow(
                    device_id=dev.device_id,
                    anomaly_type=dev.anomaly_type,
                    start_epoch=start,
                    end_epoch=finish,
                    params=dict(cfg.anomaly_types[dev.anomaly_type]["params"]),
                )
            )
        window_start += window_len
    return windows


def insert_windows(db: Session, windows: list[InjectionWindow]) -> None:
    """把注入窗口写进 anomaly_injection，并回填 injection_id。"""
    for win in windows:
        win.injection_id = db.execute(
            text(
                """
                INSERT INTO anomaly_injection (device_id, anomaly_type, started_at, ended_at, params)
                VALUES (:device_id, :anomaly_type, :started_at, :ended_at, CAST(:params AS jsonb))
                RETURNING id
                """
            ),
            {
                "device_id": win.device_id,
                "anomaly_type": win.anomaly_type,
                "started_at": datetime.fromtimestamp(win.start_epoch, tz=UTC),
                "ended_at": datetime.fromtimestamp(win.end_epoch, tz=UTC),
                "params": _json(win.params),
            },
        ).scalar_one()


def _json(params: dict) -> str:
    import json

    return json.dumps(params, ensure_ascii=False)


class RealtimeInjector:
    """实时注入调度器：每 20 分钟一个窗口，挑 1~2 台设备注入（6.4）。"""

    def __init__(self, cfg: DevicesConfig, db: Session, interval: int) -> None:
        self.cfg = cfg
        self.db = db
        self.interval = interval
        self.active: dict[str, InjectionWindow] = {}
        self.last_window_index: int | None = None
        self.total_injections = 0

    @property
    def active_count(self) -> int:
        return len(self.active)

    def maybe_start(self, epoch: float, devices: list[DeviceConfig]) -> list[InjectionWindow]:
        """跨入新的 20 分钟窗口时挑选设备并开注入，返回本次新开的窗口。"""
        window_len = self.cfg.scheduler["window_minutes"] * 60
        window_index = int(epoch // window_len)
        if self.last_window_index == window_index:
            return []
        self.last_window_index = window_index

        rng = random.Random(self.cfg.scheduler["seed"] + window_index)
        count = rng.randint(*self.cfg.scheduler["devices_per_window"])
        candidates = [d for d in devices if d.device_id not in self.active]
        if not candidates:
            return []
        picked = rng.sample(candidates, min(count, len(candidates)))

        started: list[InjectionWindow] = []
        for dev in picked:
            dur = duration_seconds(self.cfg, dev.anomaly_type)
            win = InjectionWindow(
                device_id=dev.device_id,
                anomaly_type=dev.anomaly_type,
                start_epoch=epoch,
                end_epoch=epoch + dur,
                params=dict(self.cfg.anomaly_types[dev.anomaly_type]["params"]),
            )
            # 先写真值再开始注入（6.5）
            win.injection_id = self.db.execute(
                text(
                    """
                    INSERT INTO anomaly_injection (device_id, anomaly_type, started_at, params)
                    VALUES (:device_id, :anomaly_type, :started_at, CAST(:params AS jsonb))
                    RETURNING id
                    """
                ),
                {
                    "device_id": win.device_id,
                    "anomaly_type": win.anomaly_type,
                    "started_at": datetime.fromtimestamp(epoch, tz=UTC),
                    "params": _json(win.params),
                },
            ).scalar_one()
            self.active[win.device_id] = win
            started.append(win)
            self.total_injections += 1
        if started:
            self.db.commit()
        return started

    def finish_due(self, epoch: float) -> int:
        """到期的注入回填 ended_at 并释放设备。"""
        finished = 0
        for device_id, win in list(self.active.items()):
            if epoch <= win.end_epoch:
                continue
            if win.injection_id is not None:
                self.db.execute(
                    text("UPDATE anomaly_injection SET ended_at = :ended_at WHERE id = :id"),
                    {"ended_at": datetime.fromtimestamp(win.end_epoch, tz=UTC), "id": win.injection_id},
                )
            del self.active[device_id]
            finished += 1
        if finished:
            self.db.commit()
        return finished

    def close_all(self, epoch: float) -> None:
        """Ctrl+C / 正常退出时把进行中的注入收尾，不留 ended_at 为空的僵尸记录。"""
        for win in list(self.active.values()):
            if win.injection_id is not None:
                self.db.execute(
                    text("UPDATE anomaly_injection SET ended_at = :ended_at WHERE id = :id"),
                    {
                        "ended_at": datetime.fromtimestamp(min(epoch, win.end_epoch), tz=UTC),
                        "id": win.injection_id,
                    },
                )
        self.active.clear()
        self.db.commit()


def apply_active(
    windows: list[InjectionWindow],
    dev: DeviceConfig,
    values: dict,
    epoch: float,
    cfg: DevicesConfig,
    interval: int,
    rng: random.Random,
) -> bool:
    """把该时刻命中的注入窗口叠加到 values 上，返回是否命中。"""
    hit = False
    for win in windows:
        if win.device_id != dev.device_id:
            continue
        if win.is_active(epoch):
            win.apply(dev, values, epoch, cfg, interval, rng)
            hit = True
    return hit


def default_cfg() -> DevicesConfig:
    return devices_config
