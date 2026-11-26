"""工厂日报配置（只读，spec_phase4 偏差 D-74）。

为什么单独一个接口：AI 页改成「价值导向」后需要单价、每线产能节拍、异常降速与
处置时长这些**假设系数**。AGENTS 规则 8 要求配置集中、代码里不许出现魔法数字；
同时页面要求「每个数字都能追到接口」，所以这些系数不能写在前端常量里，必须由后端
从 `config/report.json` 吐出来，并带上 source 说明它是假设值。

为什么不缓存：文件只有几百字节，本地读一次的成本远低于「改了单价页面不生效」的
排查成本；验收脚本会直接把 unit_price 改成 0 验证「未配置单价」分支。
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter

from app.config import BASE_DIR

router = APIRouter(tags=["report"])

REPORT_CONFIG_PATH = BASE_DIR / "config" / "report.json"


@router.get("/report/config", summary="工厂日报的假设参数（单价/节拍/降速/处置时长）")
def get_report_config() -> dict:
    data = json.loads(Path(REPORT_CONFIG_PATH).read_text(encoding="utf-8"))
    data["source"] = {"file": "config/report.json", "kind": "assumption"}
    return data
