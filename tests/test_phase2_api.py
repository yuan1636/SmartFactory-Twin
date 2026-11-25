"""第 2 阶段最小测试网 —— 8 个用例。

覆盖要求（第 3 步）：
1. 健康检查 1 个
2. 设备列表 1 个
3. 参数校验 2 个（非法 page_size / start>end）
4. 时序边界 2 个（超 5000 点强制降采样 / 缺时间范围走默认窗口）
5. 告警冷却 1 个（同一设备同一类型 5 分钟内不重复写）
6. G-10 两分支 1 个（只解一条保持 ALARM → 全解才 RUNNING）

跑法：
    pip install -r requirements-dev.txt
    python -m pytest tests -v
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

API = "/api/v1"
UTC = timezone.utc


# --------------------------------------------------------------------------- #
# 小工具
# --------------------------------------------------------------------------- #
def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat(timespec="seconds")


def _wait_until(fn, timeout: float = 25.0, interval: float = 0.5):
    """轮询等待条件成立（告警由 5 秒周期的后台任务写入，只能等）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = fn()
        if value:
            return value
        time.sleep(interval)
    return fn()


def _open_alarms(client, device_id: str) -> dict:
    resp = client.get(f"{API}/alarms", params={"device_id": device_id, "resolved": "false"})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _wait_total(client, device_id: str, expected: int, timeout: float = 25.0) -> int:
    """等到该设备未解除告警数 >= expected，返回最终条数（等不到就返回实际值，让断言去失败）。"""

    def _check():
        total = _open_alarms(client, device_id)["total"]
        return total if total >= expected else None

    return _wait_until(_check, timeout=timeout) or _open_alarms(client, device_id)["total"]


def _post_telemetry(client, device_id: str, ts: str, temperature: float,
                    vibration: float, current: float, speed: int = 1500) -> None:
    resp = client.post(
        f"{API}/telemetry",
        json={
            "device_id": device_id,
            "ts": ts,
            "temperature": temperature,
            "vibration": vibration,
            "current": current,
            "speed": speed,
            "running_status": "RUNNING",
        },
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["accepted"] is True


# --------------------------------------------------------------------------- #
# 1. 健康检查
# --------------------------------------------------------------------------- #
def test_health_ok_and_json_is_utf8(client):
    resp = client.get(f"{API}/health")
    assert resp.status_code == 200
    # 规格 4.0：响应头必须带 charset，否则 PowerShell 里中文字段会乱码
    assert "charset=utf-8" in resp.headers["content-type"].lower()

    body = resp.json()
    assert body["status"] == "ok"
    assert body["db"] == "ok"
    assert body["version"] == "1.0.0"
    assert body["server_time"].endswith("+00:00")  # G-05：统一 UTC 偏移


# --------------------------------------------------------------------------- #
# 2. 设备列表
# --------------------------------------------------------------------------- #
def test_device_list_has_14_seeded_devices(client):
    resp = client.get(f"{API}/devices", params={"page": 1, "page_size": 50})
    assert resp.status_code == 200

    body = resp.json()
    assert body["total"] == 14
    assert body["page"] == 1
    assert body["page_size"] == 50
    assert len(body["items"]) == 14

    ids = {item["device_id"] for item in body["items"]}
    assert {"CNC-01", "CNC-04", "ROB-01", "ROB-04"} <= ids
    assert {"CONV-01", "CONV-02", "INSP-01", "INSP-02"} <= ids
    # 2 台辅助设备是 AIR-01（空压机）与 PUMP-01（冷却泵），没有 AIR-02 / PUMP-02
    assert {"AIR-01", "PUMP-01"} <= ids
    assert len(ids) == 14


# --------------------------------------------------------------------------- #
# 3. 参数校验（两个错误分支）
# --------------------------------------------------------------------------- #
def test_invalid_page_size_is_rejected_not_silently_clamped(client):
    resp = client.get(f"{API}/devices", params={"page_size": 500})
    assert resp.status_code == 400

    body = resp.json()
    assert body["code"] == "INVALID_PARAM"
    assert body["detail"]["max"] == 200


def test_time_range_start_after_end_is_rejected(client):
    resp = client.get(
        f"{API}/devices/CNC-01/telemetry",
        params={"start": "2026-11-24T03:00:00+00:00", "end": "2026-11-24T02:00:00+00:00"},
    )
    assert resp.status_code == 400

    body = resp.json()
    assert body["code"] == "INVALID_PARAM"
    assert "end 必须晚于 start" in body["message"]


# --------------------------------------------------------------------------- #
# 4. 时序边界（缺省窗口 / 超 5000 点降采样）
# --------------------------------------------------------------------------- #
def test_telemetry_without_range_uses_last_hour_window(client):
    resp = client.get(f"{API}/devices/CNC-01/telemetry")
    assert resp.status_code == 200

    body = resp.json()
    start = datetime.fromisoformat(body["start"])
    end = datetime.fromisoformat(body["end"])
    # 缺省 = 最近 1 小时（settings.telemetry_default_window_seconds = 3600）
    assert abs((end - start).total_seconds() - 3600) <= 2
    assert body["interval_seconds"] == 2      # G-01：固定 2 秒采样
    assert body["count"] == len(body["points"])
    assert body["count"] <= 5000              # 任何情况下都不许超过上限


def test_over_5000_points_is_downsampled(client, purge):
    """造 5100 个点，验证 G-17 的强制降采样与 truncated 标记。"""
    device_id = "CONV-02"
    purge(device_id)

    base = datetime(2020, 3, 1, tzinfo=UTC)
    total = 5100                              # 5100 × 2 秒 = 2.8 小时，跨度 < 24 小时上限
    rows = [
        {
            "device_id": device_id,
            "ts": _iso(base + timedelta(seconds=2 * i)),
            # 全部落在正常区间内，避免顺带触发告警干扰本用例
            "temperature": 40.0,
            "vibration": 3.0,
            "current": 4.0,
            "speed": 800,
            "running_status": "RUNNING",
        }
        for i in range(total)
    ]
    for offset in range(0, total, 5000):      # 单批上限 5000，分两批发
        chunk = rows[offset:offset + 5000]
        resp = client.post(f"{API}/telemetry/batch", json={"items": chunk})
        assert resp.status_code == 201, resp.text
        assert resp.json()["accepted"] == len(chunk)

    resp = client.get(
        f"{API}/devices/{device_id}/telemetry",
        params={"start": _iso(base), "end": _iso(base + timedelta(seconds=2 * total))},
    )
    assert resp.status_code == 200

    body = resp.json()
    assert body["truncated"] is True
    assert body["downsample_step"] == 2       # ceil(5100 / 5000) = 2
    assert body["count"] <= 5000
    assert body["points"][0]["temperature"] == 40.0
    assert body["points"][0]["running_status"] == "RUNNING"


# --------------------------------------------------------------------------- #
# 5. 告警冷却（G-09：同设备同类型 5 分钟内不重复写）
# --------------------------------------------------------------------------- #
def test_alarm_cooldown_suppresses_duplicate_within_5_minutes(client, purge):
    device_id = "CNC-02"                      # 阈值：温度 WARNING 77 / CRITICAL 87.5
    purge(device_id)

    started = datetime.now(UTC)
    lo, hi = _iso(started - timedelta(seconds=30)), _iso(started + timedelta(minutes=10))
    purge(device_id, window=(lo, hi))

    t0 = started - timedelta(seconds=6)
    _post_telemetry(client, device_id, _iso(t0), temperature=95.0, vibration=2.0, current=9.0)

    # 5 秒扫描周期 + 余量：第一条超限必须写出 1 条 CRITICAL
    assert _wait_total(client, device_id, 1) == 1
    items = _open_alarms(client, device_id)["items"]
    assert items[0]["alarm_type"] == "TEMPERATURE"
    assert items[0]["alarm_level"] == "CRITICAL"
    # G-10：写告警同时把设备状态置 ALARM
    assert client.get(f"{API}/devices/{device_id}").json()["status"] == "ALARM"

    # 冷却窗口内第二条超限（+2 秒）：不许新增
    _post_telemetry(client, device_id, _iso(t0 + timedelta(seconds=2)),
                    temperature=96.0, vibration=2.0, current=9.0)
    time.sleep(11)                            # 至少跨过两个扫描周期
    assert _open_alarms(client, device_id)["total"] == 1

    # 超出 5 分钟冷却窗（+7 分钟）：应当再写出一条，证明冷却是有时限的、不是永久去重
    _post_telemetry(client, device_id, _iso(t0 + timedelta(minutes=7)),
                    temperature=98.0, vibration=2.0, current=9.0)
    assert _wait_total(client, device_id, 2) == 2

    purge(device_id, window=(lo, hi))


# --------------------------------------------------------------------------- #
# 6. G-10 两个分支（同一条用例内连续验证）
# --------------------------------------------------------------------------- #
def test_resolve_alarm_follows_g10_two_branches(client, purge):
    device_id = "CNC-03"                      # 阈值：温度 87.5 / 振动 3.75（均为 CRITICAL）
    purge(device_id)

    started = datetime.now(UTC)
    lo, hi = _iso(started - timedelta(seconds=30)), _iso(started + timedelta(minutes=10))
    purge(device_id, window=(lo, hi))

    t0 = started - timedelta(seconds=6)
    _post_telemetry(client, device_id, _iso(t0), temperature=95.0, vibration=2.0, current=9.0)
    _post_telemetry(client, device_id, _iso(t0 + timedelta(seconds=2)),
                    temperature=60.0, vibration=9.0, current=9.0)

    # 两条 CRITICAL：温度 + 振动
    assert _wait_total(client, device_id, 2) == 2
    items = _open_alarms(client, device_id)["items"]
    assert {item["alarm_type"] for item in items} == {"TEMPERATURE", "VIBRATION"}

    # 分支一：只解温度 —— 还有振动告警没解，设备必须保持 ALARM
    temperature_alarm_id = next(
        item["alarm_id"] for item in items if item["alarm_type"] == "TEMPERATURE"
    )
    first = client.patch(f"{API}/alarms/{temperature_alarm_id}/resolve").json()
    assert first["open_alarm_count"] == 1
    assert first["device_status"] == "ALARM"

    # 分支二：解掉最后一条 —— 未解除数归零后才允许回 RUNNING
    remaining = _open_alarms(client, device_id)["items"]
    assert len(remaining) == 1
    second = client.patch(f"{API}/alarms/{remaining[0]['alarm_id']}/resolve").json()
    assert second["open_alarm_count"] == 0
    assert second["device_status"] == "RUNNING"

    purge(device_id, window=(lo, hi))


# --------------------------------------------------------------------------- #
# 增量扫描的回退窗（2026-11-25 修的真实缺陷）
# --------------------------------------------------------------------------- #
def test_scan_floor_rewinds_cursor():
    """扫描下界必须比游标更早，否则"早开始、晚可见"的事务会被永久跳过。

    缺陷现场：`inserted_at` 是事务开始时间，并发写入时先开始的事务可能后提交。
    若扫描恰好在两者之间跑过，游标被推到较晚的 inserted_at，较早那条再用
    `inserted_at >= 游标` 就永远查不到。实测后果：POST 的单条 94.5℃ 遥测没有
    生成告警，重启后端（游标重置为回看 600 秒）才补判出来。
    """
    from app.services.alarm_service import _CURSOR_OVERLAP, scan_floor

    cursor = datetime(2026, 11, 25, 2, 0, 0, tzinfo=UTC)
    floor = scan_floor(cursor)
    assert floor < cursor, "扫描下界没有回退，并发写入会被漏判"
    assert (cursor - floor) == _CURSOR_OVERLAP


def test_scan_overlap_does_not_defeat_cooldown():
    """回退窗必须明显小于告警冷却窗，否则重复扫描会把冷却失效掉。

    冷却 5 分钟，回退 30 秒：同一批数据最多被重复看 30 秒，落到冷却窗口里被挡掉。
    如果哪天有人把回退窗调到比冷却窗还大，这个断言会先失败。
    """
    from app.config import settings
    from app.services.alarm_service import _CURSOR_OVERLAP

    cooldown = timedelta(minutes=settings.alarm_cooldown_minutes)
    assert _CURSOR_OVERLAP < cooldown / 4, (
        f"回退窗 {_CURSOR_OVERLAP} 相对冷却窗 {cooldown} 太大，"
        "重复扫描可能绕过冷却重复写告警"
    )
