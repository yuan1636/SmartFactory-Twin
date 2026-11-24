"""时间、分页、数值格式化的公共工具。

时间口径（G-05）：数据库存 UTC，接口输出 ISO 8601 带 +00:00 偏移。
这里统一收口格式化，避免各路由各写一套、有的返回 Z 有的返回 +00:00。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.config import settings
from app.constants import ErrorCode, METRIC_DIGITS
from app.errors import ApiError

UTC = timezone.utc


def utcnow() -> datetime:
    return datetime.now(UTC)


def iso(dt: datetime | None) -> str | None:
    """统一输出形如 2026-11-24T02:15:30+00:00（秒精度，够用且短）。"""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC).isoformat(timespec="seconds")


def ensure_aware(dt: datetime | None) -> datetime | None:
    """不带时区的时间按 UTC 解释：宁可显式假定，也不要让数据库按服务器时区猜。"""
    if dt is None:
        return None
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt


def round_metrics(row: dict) -> dict:
    """响应层按指标规定的小数位取整（数据库存原始精度，见 4.0）。"""
    out = dict(row)
    for metric, digits in METRIC_DIGITS.items():
        if metric in out and out[metric] is not None:
            out[metric] = round(float(out[metric]), digits) if digits else int(round(float(out[metric])))
    return out


def pagination(page: int | None, page_size: int | None) -> tuple[int, int]:
    """校验分页参数：非法值必须报 400 INVALID_PARAM，不能静默纠正。"""
    page = 1 if page is None else page
    page_size = settings.page_size_default if page_size is None else page_size
    if page < 1:
        raise ApiError(400, ErrorCode.INVALID_PARAM, f"page 必须 ≥ 1，收到 {page}", {"page": page})
    if page_size < 1 or page_size > settings.page_size_max:
        raise ApiError(
            400,
            ErrorCode.INVALID_PARAM,
            f"page_size 必须在 1~{settings.page_size_max} 之间，收到 {page_size}",
            {"page_size": page_size, "max": settings.page_size_max},
        )
    return page, page_size


def time_range(start: datetime | None, end: datetime | None) -> tuple[datetime, datetime]:
    """时序查询的时间窗校验（G-17）。

    - 都不传：默认最近 1 小时；
    - 只传一个：400 INVALID_PARAM（避免"以为传了就生效"的误判）；
    - end <= start：400 INVALID_PARAM；
    - 跨度 > 24 小时：400 RANGE_TOO_LARGE。
    """
    if start is None and end is None:
        end_dt = utcnow()
        return end_dt - timedelta(seconds=settings.telemetry_default_window_seconds), end_dt
    if start is None or end is None:
        raise ApiError(
            400,
            ErrorCode.INVALID_PARAM,
            "start 与 end 必须同时提供，或都不提供（都不提供时默认最近 1 小时）",
            {"start": iso(start), "end": iso(end)},
        )
    start_dt = ensure_aware(start)
    end_dt = ensure_aware(end)
    assert start_dt is not None and end_dt is not None
    if end_dt <= start_dt:
        raise ApiError(400, ErrorCode.INVALID_PARAM, "end 必须晚于 start", {"start": iso(start_dt), "end": iso(end_dt)})
    span = (end_dt - start_dt).total_seconds()
    if span > settings.telemetry_max_window_seconds:
        raise ApiError(
            400,
            ErrorCode.RANGE_TOO_LARGE,
            f"时间跨度不能超过 {settings.telemetry_max_window_seconds // 3600} 小时，收到 {span / 3600:.1f} 小时",
            {"span_seconds": span, "max_seconds": settings.telemetry_max_window_seconds},
        )
    return start_dt, end_dt
