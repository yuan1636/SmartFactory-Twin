"""特征工程：训练与推理共用同一份实现（spec_phase4 §5.3）。

为什么只有这一个入口、不写两份：训练时算的 78 维特征如果和推理时算的不一致
（窗口点数、min_periods、差分方向、列顺序任意一处不同），模型分数就是噪声。
这种错误不会抛异常，只会让线上效果莫名变差，是最难查的一类 bug。
所以推理侧必须调用本模块，并用 `feature_names()` 的哈希做一致性校验。

两条防泄漏硬约束（违反其一，指标全部作废）：

1. **归一化基线只能来自训练段**。`fit_baseline()` 用训练段的 median / MAD，
   算完存进 artifact，推理时读 artifact。用全量数据算会让测试段信息渗进特征。
2. **任何 rolling 都不许 shift(-k)**。时刻 t 的特征只用到 <= t 的读数。
   本文件里所有 rolling 都是后视的，`_rolling_slope` 用的 t 也是 0..n-1 的自增下标。
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

BASE_DIR = Path(__file__).resolve().parents[2]
DEVICES_CONFIG_PATH = BASE_DIR / "config" / "devices.json"

# 四个指标（单位口径见 AGENTS.md 规则 4，本文件不做换算）
METRIC_COLUMNS = ("temperature", "vibration", "current", "speed")

# 三档滑窗（点数，采样间隔 2 秒）：15s 抓突变、60s 抓趋势、300s 抓基线偏移。
# VIB_SPIKE 平均只持续 40 秒，没有 15s 窗口会被长窗抹平。
WINDOWS = (("w15", 8), ("w60", 30), ("w300", 150))
STATS = ("mean", "std", "min", "max", "slope")

STATUS_VALUES = ("RUNNING", "IDLE", "STOPPED")

# 只有这三个指标配了阈值；speed 没有阈值区间，不能进阈值特征
THRESHOLD_METRICS = ("temperature", "vibration", "current")

# MAD 转标准差的常数（正态分布下 1.4826 × MAD ≈ σ）
_MAD_TO_SIGMA = 1.4826


@dataclass(frozen=True)
class DeviceSpec:
    """一台设备的正常区间与告警阈值，来自 config/devices.json（唯一来源）。"""

    device_id: str
    normal_range: dict[str, tuple[float, float]]
    thresholds: dict[str, dict[str, float]]


def load_device_specs() -> dict[str, DeviceSpec]:
    raw = json.loads(DEVICES_CONFIG_PATH.read_text(encoding="utf-8"))
    specs: dict[str, DeviceSpec] = {}
    for item in raw["devices"]:
        specs[item["device_id"]] = DeviceSpec(
            device_id=item["device_id"],
            normal_range={
                metric: (float(bounds[0]), float(bounds[1]))
                for metric, bounds in item["normal_range"].items()
            },
            thresholds={
                metric: {level: float(value) for level, value in levels.items()}
                for metric, levels in item["thresholds"].items()
            },
        )
    return specs


def feature_names() -> list[str]:
    """78 维特征的固定顺序。顺序即契约，改动必须升模型版本。"""
    names: list[str] = []
    # 1) 相对正常区间的偏离度（G-08）：跨型号可比
    names += [f"{metric}_dev" for metric in METRIC_COLUMNS]
    # 2) 稳健 z-score：相对该设备自身历史
    names += [f"{metric}_rz" for metric in METRIC_COLUMNS]
    # 3) 三档滑窗 × 四指标 × 五统计量 = 60
    for metric in METRIC_COLUMNS:
        for window_name, _ in WINDOWS:
            for stat in STATS:
                names.append(f"{metric}_{window_name}_{stat}")
    # 4) 一阶差分
    names += [f"{metric}_diff" for metric in METRIC_COLUMNS]
    # 5) 超阈值程度（连续量，不是布尔开关）
    names += [f"{metric}_thr" for metric in THRESHOLD_METRICS]
    # 6) 运行状态独热
    names += [f"status_{value}" for value in STATUS_VALUES]
    return names


def schema_hash() -> str:
    """特征顺序 + 窗口配置的指纹。推理侧与 artifact 比对，不一致就降级。"""
    payload = "|".join(feature_names()) + f"#{WINDOWS}#{STATS}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def _rolling_slope(series: pd.Series, window: int) -> pd.Series:
    """窗口内最小二乘斜率，全部用 rolling sum 向量化算。

    为什么不 `.rolling().apply(np.polyfit)`：400 万行 × 12 组会跑成小时级。
    斜率对自变量平移不变，所以直接用行号 t 当 x，再用
    slope = (n·Σty − Σt·Σy) / (n·Σt² − (Σt)²) 展开成 5 个 rolling sum。
    """
    n_idx = pd.Series(np.arange(len(series), dtype="float64"), index=series.index)
    roll = dict(window=window, min_periods=2)
    n = series.rolling(**roll).count()
    sum_y = series.rolling(**roll).sum()
    sum_t = n_idx.rolling(**roll).sum()
    sum_ty = (n_idx * series).rolling(**roll).sum()
    sum_tt = (n_idx * n_idx).rolling(**roll).sum()
    denominator = n * sum_tt - sum_t * sum_t
    slope = (n * sum_ty - sum_t * sum_y) / denominator.replace(0.0, np.nan)
    return slope


def fit_baseline(frame: pd.DataFrame, spec: DeviceSpec) -> dict[str, tuple[float, float]]:
    """只用**训练段**数据计算 median 与 MAD，返回可 JSON 序列化的基线。

    用中位数 + MAD 而不是均值 + 标准差：训练段里已经混有 2.56% 的异常行，
    均值和标准差会被它们直接带偏；MAD 的崩溃点是 50%，扛得住。
    """
    baseline: dict[str, tuple[float, float]] = {}
    for metric in METRIC_COLUMNS:
        values = frame[metric].to_numpy(dtype="float64")
        median = float(np.median(values))
        mad = float(np.median(np.abs(values - median)))
        # MAD 为 0 表示这段数据几乎不变化（例如停机时 speed 恒为 0），
        # 除以 0 会把特征炸成 inf，这里退化成 1.0 并靠后续 clip 兜住。
        baseline[metric] = (median, mad if mad > 1e-9 else 1.0)
    return baseline


def build_features(
    frame: pd.DataFrame,
    spec: DeviceSpec,
    baseline: dict[str, tuple[float, float]],
) -> np.ndarray:
    """把一台设备的原始遥测转成 (n, 78) 的 float32 特征矩阵。

    调用方保证 frame 已按 ts 升序、且只含本设备。
    """
    n_rows = len(frame)
    matrix = np.zeros((n_rows, len(feature_names())), dtype="float32")
    column = 0

    # 1) 相对正常区间的偏离度：0 = 落在区间下界，1 = 落在上界，>1 即超出
    for metric in METRIC_COLUMNS:
        low, high = spec.normal_range[metric]
        span = high - low if abs(high - low) > 1e-9 else 1.0
        values = frame[metric].to_numpy(dtype="float64")
        matrix[:, column] = (values - low) / span
        column += 1

    # 2) 稳健 z-score（基线来自训练段）
    for metric in METRIC_COLUMNS:
        median, mad = baseline[metric]
        values = frame[metric].to_numpy(dtype="float64")
        matrix[:, column] = (values - median) / (_MAD_TO_SIGMA * mad)
        column += 1

    # 3) 三档滑窗统计量
    for metric in METRIC_COLUMNS:
        series = frame[metric]
        for _, window in WINDOWS:
            roll = series.rolling(window, min_periods=1)
            stat_map = {
                "mean": roll.mean(),
                "std": series.rolling(window, min_periods=2).std(),
                "min": roll.min(),
                "max": roll.max(),
                "slope": _rolling_slope(series, window),
            }
            for stat in STATS:
                matrix[:, column] = stat_map[stat].to_numpy(dtype="float64")
                column += 1

    # 4) 一阶差分：抓瞬时跳变。首行没有前值，填 0。
    for metric in METRIC_COLUMNS:
        diff = frame[metric].diff().to_numpy(dtype="float64")
        diff[0] = 0.0
        matrix[:, column] = np.nan_to_num(diff, nan=0.0)
        column += 1

    # 5) 超阈值程度：以 warning 为 1、critical 为 2 分段线性。
    #    不用 is_over_warning 这种布尔量，因为布尔量丢掉了"超多少"。
    for metric in THRESHOLD_METRICS:
        levels = spec.thresholds[metric]
        warning = levels.get("warning")
        critical = levels.get("critical")
        values = frame[metric].to_numpy(dtype="float64")
        if warning is None or critical is None or abs(critical - warning) < 1e-9:
            matrix[:, column] = 0.0
        else:
            matrix[:, column] = 1.0 + (values - warning) / (critical - warning)
        column += 1

    # 6) 运行状态独热。STOPPED 时机械指标本来就没有可比性，模型需要知道这一点。
    status = frame["running_status"].to_numpy()
    for value in STATUS_VALUES:
        matrix[:, column] = (status == value).astype("float32")
        column += 1

    # 前几行的 std / slope 是 NaN（min_periods 未满足）。统一填 0 并屏蔽 inf：
    # XGBoost 能吃 NaN，但逻辑回归不能，为了四个模型用同一份矩阵，这里统一填。
    np.nan_to_num(matrix, copy=False, nan=0.0, posinf=0.0, neginf=0.0)
    assert column == matrix.shape[1], f"特征列数不符：写了 {column} 列，声明 {matrix.shape[1]} 列"
    return matrix
