"""模拟器 → 后端的 HTTP 客户端（标准库 urllib，不额外引依赖）。

为什么不让模拟器直接写遥测表：数据接入点是接口（POST /telemetry/batch），
这样第 3 阶段换成真实网关时，模拟器整个可以扔掉，接口不用改（L-02）。
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request


class ApiError(Exception):
    def __init__(self, message: str, status: int | None = None, body: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.body = body


class TelemetryClient:
    def __init__(self, base_url: str, retries: int = 3, timeout: float = 120.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.retries = retries
        self.timeout = timeout
        self.retry_count = 0
        self.failure_count = 0

    def post_batch(self, items: list[dict]) -> dict:
        """提交一批遥测；失败按 1s / 2s / 4s 退避重试。"""
        payload = json.dumps({"items": items}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        url = f"{self.base_url}/telemetry/batch"

        last_error: Exception | None = None
        for attempt in range(self.retries + 1):
            try:
                return self._post(url, payload)
            except ApiError as exc:
                # 4xx 是数据本身有问题，重试也不会变好，直接抛给调用方
                if exc.status is not None and 400 <= exc.status < 500:
                    self.failure_count += 1
                    raise
                last_error = exc
            except Exception as exc:  # 网络层异常（连接拒绝、超时等）
                last_error = exc

            if attempt < self.retries:
                self.retry_count += 1
                time.sleep(2**attempt)  # 1s, 2s, 4s

        self.failure_count += 1
        raise ApiError(f"批量写入失败（已重试 {self.retries} 次）：{last_error}")

    def _post(self, url: str, payload: bytes) -> dict:
        request = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise ApiError(f"HTTP {exc.code}: {body[:300]}", status=exc.code, body=body) from exc
        except urllib.error.URLError as exc:
            raise ApiError(f"无法连接后端 {url}：{exc.reason}") from exc
