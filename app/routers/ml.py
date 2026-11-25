"""AI 模型接口（spec_phase4 §6.1）。

三个接口的分工：
- `/ml/model-info`：模型是谁、什么时候训的、指标多少。AI 页指标卡的唯一数据源。
- `/ml/anomaly/confusion`：训练时的离线混淆矩阵，页面画热力图用。
- `/ml/anomaly/scores`：对指定设备的指定时间窗做**实时推理**，页面画分数曲线用。

红线（spec_phase4 §6.2）：页面上出现的每一个数字都必须来自这里的一次真实返回。
所以这三个接口不做任何"兜底假数据"——模型没加载时 model-info 明确回 loaded=false，
另外两个回 503 ML_UNAVAILABLE，前端显示降级条而不是编数字。
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Query

from app.config import settings
from app.constants import ErrorCode
from app.errors import ApiError
from app.services import ml_anomaly
from app.utils import time_range

router = APIRouter(tags=["ml"])


@router.get("/ml/model-info", summary="当前异常检测模型信息与离线指标")
def get_model_info() -> dict:
    return ml_anomaly.model_info()


@router.get("/ml/anomaly/confusion", summary="离线测试集混淆矩阵")
def get_confusion() -> dict:
    return ml_anomaly.confusion()


@router.get("/ml/anomaly/scores", summary="设备异常分数曲线（实时推理，单次最多 5000 点）")
def get_anomaly_scores(
    device_id: str = Query(description="设备编号，如 CNC-01"),
    start: datetime | None = Query(default=None, description="ISO 8601，含时区；不传则默认最近 1 小时"),
    end: datetime | None = Query(default=None, description="ISO 8601，含时区"),
    limit: int | None = Query(default=None, description="返回点数上限，默认与上限均为 5000"),
) -> dict:
    limit = settings.telemetry_max_points if limit is None else limit
    if limit < 1 or limit > settings.telemetry_max_points:
        raise ApiError(
            400,
            ErrorCode.INVALID_PARAM,
            f"limit 必须在 1~{settings.telemetry_max_points} 之间，收到 {limit}",
            {"limit": limit, "max": settings.telemetry_max_points},
        )
    start_dt, end_dt = time_range(start, end)
    return ml_anomaly.score_window(device_id, start_dt, end_dt, limit)
