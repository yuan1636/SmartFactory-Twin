"""历史数据回填（规格 6.7 / G-18）。

为什么要回填：模拟器从当前时刻开始写，则"最近 7 天趋势""历史告警""模型训练集"全为空，
演示前只能干等几小时。回填把注入真值一起补上，第 4 阶段才有历史区间可用。

时间栅格取左闭右开 [start, end)，保证 --backfill-days 1 恰好是
43,200 个时刻 × 14 台 = 604,800 行，与 G-18 给的数据量口径一致。
"""

from __future__ import annotations

import random
import time
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.config import DeviceConfig, DevicesConfig
from data_pipeline.generator import generate_metrics
from data_pipeline.http_client import TelemetryClient
from data_pipeline.injector import InjectionWindow, insert_windows, plan_backfill_windows
from data_pipeline.orders import OrderAdvancer

BATCH_SIZE = 5000
UTC = timezone.utc


@dataclass
class BackfillResult:
    rows_accepted: int = 0
    rows_duplicated: int = 0
    windows: int = 0
    orders: int = 0
    elapsed_seconds: float = 0.0


def _log(message: str) -> None:
    print(message, flush=True)


def run_backfill(
    client: TelemetryClient,
    db: Session,
    advancer: OrderAdvancer,
    cfg: DevicesConfig,
    devices: list[DeviceConfig],
    days: int,
    interval: int,
) -> BackfillResult:
    started = time.perf_counter()
    result = BackfillResult()

    now_epoch = time.time()
    start_epoch = ((now_epoch - days * 86400) // interval) * interval
    end_epoch = (now_epoch // interval) * interval
    total_ticks = int((end_epoch - start_epoch) // interval)
    expected_rows = total_ticks * len(devices)
    _log(
        f"开始回填：{days} 天历史，{total_ticks} 个采样时刻 × {len(devices)} 台设备 "
        f"= {expected_rows} 行"
    )

    # 1) 先排注入窗口并写 ground truth：注入效果必须与真值记录落在同一区间（6.5）
    windows = plan_backfill_windows(cfg, devices, start_epoch, end_epoch, interval)
    insert_windows(db, windows)
    db.commit()
    result.windows = len(windows)
    _log(f"注入真值已写入 {len(windows)} 条（每 20 分钟一个窗口，随机 1~2 台设备）")

    # 2) 按设备分组，回填时按时间顺序命中窗口
    by_device: dict[str, list[InjectionWindow]] = {}
    for win in windows:
        by_device.setdefault(win.device_id, []).append(win)
    for list_ in by_device.values():
        list_.sort(key=lambda w: w.start_epoch)

    rng = random.Random(cfg.scheduler["seed"])
    batch: list[dict] = []
    batch_index = 0
    total_batches = (expected_rows + BATCH_SIZE - 1) // BATCH_SIZE

    epoch = float(start_epoch)
    while epoch < end_epoch:
        for dev in devices:
            values = generate_metrics(dev, epoch, rng, cfg)
            for win in by_device.get(dev.device_id, ()):
                if win.is_active(epoch):
                    win.apply(dev, values, epoch, cfg, interval, rng)
                    break  # 同一设备同一时刻只可能命中一个注入窗口
            batch.append(
                {
                    "device_id": dev.device_id,
                    "ts": datetime.fromtimestamp(epoch, tz=UTC).isoformat(),
                    "temperature": values["temperature"],
                    "vibration": values["vibration"],
                    "current": values["current"],
                    "speed": values["speed"],
                    "running_status": values["running_status"],
                }
            )
        epoch += interval

        if len(batch) >= BATCH_SIZE:
            # 每个 tick 一次加 14 行，累计值不会正好等于 5000，必须切片发送，
            # 否则会发出 5012 条被后端以 400 RANGE_TOO_LARGE 拒绝（上限 5000）
            while len(batch) >= BATCH_SIZE:
                chunk = batch[:BATCH_SIZE]
                del batch[:BATCH_SIZE]
                accepted, duplicated = _flush(client, chunk)
                result.rows_accepted += accepted
                result.rows_duplicated += duplicated
                batch_index += 1
            if batch_index % 10 == 0 or batch_index == total_batches:
                _log(
                    f"  回填进度 {batch_index}/{total_batches} 批："
                    f"已写入 {result.rows_accepted} 行，重复 {result.rows_duplicated} 行"
                )

    if batch:
        accepted, duplicated = _flush(client, batch)
        result.rows_accepted += accepted
        result.rows_duplicated += duplicated

    # 3) 倒推生成历史已完成订单
    result.orders = advancer.seed_history(days, datetime.fromtimestamp(end_epoch, tz=UTC))
    result.elapsed_seconds = time.perf_counter() - started
    _log(
        f"回填完成：写入 {result.rows_accepted} 行，重复 {result.rows_duplicated} 行，"
        f"历史订单 {result.orders} 张，耗时 {result.elapsed_seconds:.1f} 秒"
    )
    return result


def _flush(client: TelemetryClient, batch: list[dict]) -> tuple[int, int]:
    response = client.post_batch(list(batch))
    return int(response.get("accepted", 0)), int(response.get("duplicated", 0))
