"""预留，本阶段不实现：告警外发通知（邮件 / 企业微信 / 钉钉，见 L-04）。

第 2 阶段只把告警写进 alarms 表并通过 WebSocket 推给前端，不对外发通知。
"""

from __future__ import annotations


def notify_alarm(alarm: dict) -> None:
    """预留，本阶段不实现。"""
    return None
