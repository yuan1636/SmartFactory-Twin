"""模拟器命令行入口（规格第 6 节）。

用法：
    python -m data_pipeline.simulator                                  # 常驻实时，Ctrl+C 停止
    python -m data_pipeline.simulator --duration 30                    # 跑 30 秒自动退出（验收用）
    python -m data_pipeline.simulator --backfill-days 1 --duration 30  # 先补 1 天历史再跑 30 秒
    python -m data_pipeline.simulator --devices CNC-01 --rate 1        # 单设备 1 秒一条
"""

from __future__ import annotations

import argparse
import random
import signal
import sys
import time
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import text

from app.config import DeviceConfig, devices_config, settings
from app.db import SessionLocal, engine
from data_pipeline.backfill import run_backfill
from data_pipeline.generator import apply_stopped_physics, generate_metrics
from data_pipeline.http_client import ApiError, TelemetryClient
from data_pipeline.injector import RealtimeInjector, apply_active
from data_pipeline.line_pace import UNAVAILABLE_STATUSES, load_line_states
from data_pipeline.orders import PIECES_PER_HOUR, OrderAdvancer

UTC = timezone.utc

_STOP = {"requested": False}


def _handle_sigint(signum, frame) -> None:  # noqa: ARG001 信号回调必须收这两个参数
    # 只置标志位：信号回调里做数据库操作，容易把进程留在半提交状态
    _STOP["requested"] = True


@dataclass
class Stats:
    started_at: float = 0.0
    rows_written: int = 0
    ticks: int = 0
    injected_total: int = 0
    backfill_rows: int = 0
    failure_ticks: int = 0


def _display_width(text: str) -> int:
    """中文按 2 列算，统计块才能对齐（中英混排否则会歪）。"""
    return sum(2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1 for ch in text)


def _stat_line(label: str, value: str, width: int = 17) -> str:
    return f"{label}{' ' * max(0, width - _display_width(label))}: {value}"


def _print_stats(
    stats: Stats,
    advancer: OrderAdvancer,
    injector: RealtimeInjector | None,
    client: TelemetryClient,
    rate: int,
    device_count: int,
) -> None:
    elapsed = max(0.001, time.perf_counter() - stats.started_at)
    speed = stats.rows_written / elapsed
    active = injector.active_count if injector else 0
    print("==== 模拟器统计 ====")
    print(_stat_line("运行时长", f"{elapsed:.1f} s"))
    print(_stat_line("采样间隔", f"{rate} s"))
    print(_stat_line("设备数", str(device_count)))
    print(_stat_line("写入行数", str(stats.rows_written)))
    print(_stat_line("平均写入速率", f"{speed:.2f} 行/s"))
    print(_stat_line("注入事件", f"{stats.injected_total} 次（进行中 {active}）"))
    print(_stat_line("订单推进", f"{advancer.pieces_advanced} 件"))
    print(_stat_line("写入失败/重试", f"{stats.failure_ticks} / {client.retry_count}"))
    print(_stat_line("回填行数", str(stats.backfill_rows)))
    print("===================")


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m data_pipeline.simulator",
        description="SmartFactory Twin 数据模拟器（模拟数据，非真实工厂数据）",
    )
    parser.add_argument("--devices", default=None, help="逗号分隔的设备编号，默认全部 14 台")
    parser.add_argument("--rate", type=int, default=2, help="采样间隔秒数，默认 2，必须 ≥1")
    parser.add_argument("--duration", type=int, default=0, help="运行秒数，0 = 常驻直到 Ctrl+C")
    parser.add_argument("--backfill-days", type=int, default=0, help="先回填 N 天历史，0 = 不回填，上限 30")
    return parser.parse_args(argv)


def _select_devices(raw: str | None) -> list[DeviceConfig]:
    if not raw:
        return list(devices_config.devices)
    wanted = [item.strip() for item in raw.split(",") if item.strip()]
    unknown = [item for item in wanted if devices_config.get(item) is None]
    if unknown:
        raise ValueError(f"设备编号不存在：{','.join(unknown)}；可用编号：{','.join(devices_config.device_ids)}")
    if not wanted:
        raise ValueError("--devices 不能为空")
    return [devices_config.get(item) for item in wanted]  # type: ignore[misc]


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)

    if args.rate < 1:
        print("[错误] --rate 必须 ≥ 1", file=sys.stderr)
        return 1
    if args.duration < 0:
        print("[错误] --duration 不能为负数", file=sys.stderr)
        return 1
    if args.backfill_days < 0 or args.backfill_days > 30:
        print("[错误] --backfill-days 必须在 0~30 之间（避免误操作灌入上千万行）", file=sys.stderr)
        return 1

    try:
        devices = _select_devices(args.devices)
    except ValueError as exc:
        print(f"[错误] {exc}", file=sys.stderr)
        return 1

    # 先确认数据库可用：连不上直接退出，别跑到一半才报错
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception as exc:
        print(f"[错误] 数据库不可用：{exc}", file=sys.stderr)
        print("       请先启动数据库容器：docker compose up -d", file=sys.stderr)
        return 1

    signal.signal(signal.SIGINT, _handle_sigint)
    # Windows 下 Ctrl+Break 走的是 SIGBREAK，一起接管，两种中断都能优雅收尾
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, _handle_sigint)

    stats = Stats(started_at=time.perf_counter())
    client = TelemetryClient(settings.simulator_api_base)
    db = SessionLocal()
    advancer = OrderAdvancer(db)
    injector = RealtimeInjector(devices_config, db, args.rate)
    rng = random.Random()

    try:
        # 1) 回填历史（可选）。回填后把计时清零，让"运行时长/写入速率"只反映实时阶段
        if args.backfill_days > 0:
            result = run_backfill(
                client, db, advancer, devices_config, devices, args.backfill_days, args.rate
            )
            stats.backfill_rows = result.rows_accepted
            stats.started_at = time.perf_counter()

        # 2) 订单底座：每条产线先有一张进行中的订单
        advancer.ensure_orders(datetime.now(UTC))

        # 3) 实时循环：从"下一个 2 秒栅格点"开始，而不是从当前时刻硬插一条，
        #    否则首个 tick 落在栅格中间，会在开头补跑 1~2 个 tick（30 秒跑出 238 行而不是 210 行）
        run_started = time.perf_counter()
        first_ts = (int(time.time()) // args.rate + 1) * args.rate
        last_ts = first_ts - args.rate
        consecutive_failures = 0
        tick = 0

        while not _STOP["requested"]:
            if args.duration and (time.perf_counter() - run_started) >= args.duration:
                break

            next_ts = last_ts + args.rate
            # 等到下一个栅格点；中途被打断立刻退出，不硬等
            while time.time() < next_ts and not _STOP["requested"]:
                time.sleep(min(0.1, max(0.0, next_ts - time.time())))
            if _STOP["requested"]:
                break
            # 睡过栅格点后要再判一次时长：否则跨过 --duration 边界的那个 tick 还会多写一批，
            # 30 秒会写成 16 个 tick（224 行）而不是 15 个（210 行）
            if args.duration and (time.perf_counter() - run_started) >= args.duration:
                break

            tick += 1
            ts_epoch = next_ts
            last_ts = next_ts
            ts_dt = datetime.fromtimestamp(ts_epoch, tz=UTC)

            started_windows = injector.maybe_start(ts_epoch, devices)
            injector.finish_due(ts_epoch)
            stats.injected_total += len(started_windows)

            # 本拍各线节拍：可用率 × 异常系数，由设备状态与活跃注入算出（D-73）。
            # 与 /stats 的 utilization 同源：都等价于"该线 RUNNING 设备占比"。
            line_states, db_status = load_line_states(db, ts_epoch, devices_config, PIECES_PER_HOUR)
            produced = {
                line_id: state.pace_per_hour / 3600.0 * args.rate
                for line_id, state in line_states.items()
            }
            qualified_rates = {line_id: state.qualified_rate for line_id, state in line_states.items()}

            rows = []
            for dev in devices:
                values = generate_metrics(dev, ts_epoch, rng, devices_config)
                apply_active(
                    list(injector.active.values()), dev, values, ts_epoch, devices_config, args.rate, rng
                )
                # 人工停用（维护/停机）优先：状态机说在转也没用，遥测与节拍一起按停机处理
                if db_status.get(dev.device_id) in UNAVAILABLE_STATUSES:
                    apply_stopped_physics(dev, values)
                    values["running_status"] = "STOPPED"
                rows.append(
                    {
                        "device_id": dev.device_id,
                        "ts": ts_dt.isoformat(),
                        "temperature": values["temperature"],
                        "vibration": values["vibration"],
                        "current": values["current"],
                        "speed": values["speed"],
                        "running_status": values["running_status"],
                    }
                )

            request_started = time.perf_counter()
            error_text = ""
            try:
                response = client.post_batch(rows)
                stats.rows_written += int(response.get("accepted", 0))
                consecutive_failures = 0
            except ApiError as exc:
                stats.failure_ticks += 1
                consecutive_failures += 1
                error_text = f" error={str(exc)[:120]}"
            latency_ms = int((time.perf_counter() - request_started) * 1000)

            advanced = advancer.advance(ts_dt, produced, qualified_rates)
            stats.ticks = tick
            pace_total = sum(state.pace_per_hour for state in line_states.values())
            print(
                f"[{datetime.fromtimestamp(ts_epoch).strftime('%Y-%m-%d %H:%M:%S')}] "
                f"tick={tick} devices={len(devices)} rows={len(rows)} "
                f"injected={len(started_windows)} pace={pace_total:.0f}/h orders=+{advanced} "
                f"latency={latency_ms}ms{error_text}",
                flush=True,
            )

            if consecutive_failures >= 3:
                print("[错误] 连续 3 个 tick 写入失败，判定后端不可用，退出", file=sys.stderr)
                _safe_close(injector)
                _print_stats(stats, advancer, injector, client, args.rate, len(devices))
                return 1

        # 4) 优雅退出：收尾进行中的注入，打印统计块
        _safe_close(injector)
        _print_stats(stats, advancer, injector, client, args.rate, len(devices))
        return 0

    except KeyboardInterrupt:
        # 双保险：万一 SIGINT 以 KeyboardInterrupt 形式抛出
        _safe_close(injector)
        _print_stats(stats, advancer, injector, client, args.rate, len(devices))
        return 0
    finally:
        db.close()


def _safe_close(injector: RealtimeInjector) -> None:
    """收尾注入记录；即便数据库此刻不可用，也不能让退出流程抛异常。"""
    try:
        injector.close_all(time.time())
    except Exception as exc:  # noqa: BLE001 退出路径上只记录，不再上抛
        print(f"[警告] 收尾注入记录失败：{exc}", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
