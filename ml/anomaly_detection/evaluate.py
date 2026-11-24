"""从训练报告生成 Markdown 摘要，并对报告本身做一致性自检（spec_phase4 §5.7 / §5.8）。

为什么单独一个脚本、还要做自检：指标表是拿去写论文和答辩的东西，一旦里面有
自相矛盾的数字（混淆矩阵加起来不等于样本数、precision 和混淆矩阵对不上、
三段时间有重叠），被人当场发现比指标低十倍更难看。

本脚本只读 `*_anomaly.json`，不改模型、不重训。产物：
`ml/evaluation/reports/YYYYMMDD_anomaly.md`，可直接粘进 `docs/acceptance_phase4.md`。

不生成 PNG：规格 §5.8 原来写的是 matplotlib 出图，为避免为画两张图新增一个
第三方依赖（AGENTS.md 第 2 节），改由前端 AI 页用 ECharts 渲染同样的图，
另在终端与 Markdown 里用文本矩阵表达。见 spec_phase4 偏差 D-12。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[2]
REPORT_DIR = BASE_DIR / "ml" / "evaluation" / "reports"

ORDER = ("threshold_rule", "logistic_regression", "isolation_forest", "xgboost")


def check(condition: bool, label: str, detail: str, failures: list[str]) -> None:
    print(f"{'PASS' if condition else 'FAIL'}  {label}  · {detail}")
    if not condition:
        failures.append(f"{label}：{detail}")


def consistency_checks(report: dict) -> list[str]:
    """对报告做算术自检。返回失败项列表，空列表表示全部通过。"""
    failures: list[str] = []
    dataset = report["dataset"]
    test_rows = next(
        (item["rows"] for item in dataset["split"] if item["split"] == "test"), 0
    )
    positive_rows = next(
        (item["positive"] for item in dataset["split"] if item["split"] == "test"), 0
    )

    for key in ORDER:
        model = report["models"][key]
        confusion = model["test"]["confusion"]
        total = sum(confusion.values())
        check(
            total == test_rows,
            f"{key} 混淆矩阵行数等于测试集行数",
            f"{total} vs {test_rows}",
            failures,
        )

        tp, fp, fn = confusion["tp"], confusion["fp"], confusion["fn"]
        expected_precision = round(tp / (tp + fp), 4) if (tp + fp) else 0.0
        expected_recall = round(tp / (tp + fn), 4) if (tp + fn) else 0.0
        check(
            abs(expected_precision - model["test"]["precision"]) <= 1e-4,
            f"{key} precision 与混淆矩阵一致",
            f"{model['test']['precision']} vs 重算 {expected_precision}",
            failures,
        )
        check(
            abs(expected_recall - model["test"]["recall"]) <= 1e-4,
            f"{key} recall 与混淆矩阵一致",
            f"{model['test']['recall']} vs 重算 {expected_recall}",
            failures,
        )
        check(
            tp + fn == positive_rows,
            f"{key} 正例数与测试集一致",
            f"{tp + fn} vs {positive_rows}",
            failures,
        )

    # 时间切分三段不许重叠：训练结束必须早于验证开始，验证结束早于测试开始
    splits = {item["split"]: item for item in dataset["split"]}
    check(
        splits["train"]["end"] <= splits["val"]["start"],
        "训练段与验证段时间不重叠",
        f"{splits['train']['end']} ≤ {splits['val']['start']}",
        failures,
    )
    check(
        splits["val"]["end"] <= splits["test"]["start"],
        "验证段与测试段时间不重叠",
        f"{splits['val']['end']} ≤ {splits['test']['start']}",
        failures,
    )

    # 正例率不应出现 2 倍以上的漂移（spec §5.4 的硬要求）
    rates = {name: splits[name]["positive_rate"] for name in ("train", "val", "test")}
    worst = max(rates.values()) / max(min(rates.values()), 1e-9)
    check(
        worst <= 2.0,
        "三段正例率漂移不超过 2 倍",
        f"最大/最小 = {worst:.2f}（训练 {rates['train']:.4%} / 验证 {rates['val']:.4%} / 测试 {rates['test']:.4%}）",
        failures,
    )

    # 归因任务的样本数必须等于测试段正例数
    support_sum = sum(item["support"] for item in report["type_attribution"]["per_class"].values())
    check(
        support_sum == positive_rows,
        "三分类归因样本数等于测试段正例数",
        f"{support_sum} vs {positive_rows}",
        failures,
    )

    # 主模型阈值必须落在 (0,1)，且必须优于业务基线（否则本块没有意义）
    main = report["models"]["xgboost"]["test"]
    baseline = report["models"]["threshold_rule"]["test"]
    check(
        0.0 < report["thresholds"]["xgboost"]["threshold"] < 1.0,
        "主模型阈值在 (0,1) 区间",
        f"{report['thresholds']['xgboost']['threshold']}",
        failures,
    )
    check(
        (main["pr_auc"] or 0) > (baseline["pr_auc"] or 0),
        "主模型 PR-AUC 高于阈值规则基线",
        f"{main['pr_auc']} > {baseline['pr_auc']}",
        failures,
    )
    return failures


def to_markdown(report: dict) -> str:
    dataset = report["dataset"]
    lines: list[str] = []
    lines.append(f"# 异常检测训练报告（{report['generated_at']}）")
    lines.append("")
    lines.append(f"- 模型版本：`{report['model_id']}`")
    lines.append(f"- 特征 schema：`{report['schema_hash']}`（78 维，训练与推理共用 `ml/common/features.py`）")
    lines.append(
        f"- 数据集：{dataset['rows']:,} 行 / 正例 {dataset['positive_rows']:,}"
        f"（{dataset['positive_rate']:.2%}）/ 采样间隔 {dataset['sample_seconds']} 秒"
    )
    lines.append(f"- 时间范围：{dataset['time_range'][0]} ~ {dataset['time_range'][1]}")
    lines.append(
        f"- 误报配额：每设备每小时 ≤ {report['false_alarm_budget_per_device_hour']:g} 次（阈值在验证段选出）"
    )
    lines.append("")
    lines.append("## 三段切分")
    lines.append("")
    lines.append("| 段 | 行数 | 正例 | 正例率 | 起始 | 结束 |")
    lines.append("|---|---|---|---|---|---|")
    for item in dataset["split"]:
        lines.append(
            f"| {item['split']} | {item['rows']:,} | {item['positive']:,} | "
            f"{item['positive_rate']:.2%} | {item['start']} | {item['end']} |"
        )
    lines.append("")
    lines.append("## 四模型对比（测试段）")
    lines.append("")
    lines.append("| 模型 | PR-AUC | Precision | Recall | F1 | 区间检出率 | 误报/设备小时 | 阈值 |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for key in ORDER:
        model = report["models"][key]
        test = model["test"]
        threshold = report["thresholds"][key]["threshold"]
        lines.append(
            f"| {model['name']} | {test['pr_auc']} | {test['precision']:.4f} | {test['recall']:.4f} | "
            f"{test['f1']:.4f} | {test['interval']['detection_rate']:.2%} | "
            f"{test['false_alarms_per_device_hour']:.2f} | {threshold:.4f} |"
        )
    lines.append("")
    main = report["models"]["xgboost"]["test"]
    confusion = main["confusion"]
    lines.append("## 主模型混淆矩阵（测试段）")
    lines.append("")
    lines.append("| | 预测正常 | 预测异常 |")
    lines.append("|---|---|---|")
    lines.append(f"| 实际正常 | {confusion['tn']:,} | {confusion['fp']:,} |")
    lines.append(f"| 实际异常 | {confusion['fn']:,} | {confusion['tp']:,} |")
    lines.append("")
    interval = main["interval"]
    lines.append(
        f"区间级：测试段出现过的 {interval['intervals_with_rows']} 个注入区间中检出 "
        f"{interval['intervals_detected']} 个（{interval['detection_rate']:.2%}），"
        f"中位检测延迟 {interval['median_delay_seconds']} 秒。"
    )
    lines.append(
        f"窗口内共 {interval['intervals_in_window']} 个区间，其余因跨切分点按规格整段并入训练段，故无测试行。"
    )
    lines.append("")
    lines.append("| 异常类型 | 检出 | 区间数 | 检出率 |")
    lines.append("|---|---|---|---|")
    for name, detail in interval["by_type"].items():
        lines.append(f"| {name} | {detail['detected']} | {detail['total']} | {detail['rate']:.2%} |")
    lines.append("")
    lines.append("## 三分类归因（测试段正例）")
    lines.append("")
    lines.append("| 类型 | Precision | Recall | F1 | 样本 |")
    lines.append("|---|---|---|---|---|")
    attribution = report["type_attribution"]
    for name, detail in attribution["per_class"].items():
        lines.append(
            f"| {name} | {detail['precision']:.3f} | {detail['recall']:.3f} | "
            f"{detail['f1']:.3f} | {detail['support']:,} |"
        )
    lines.append("")
    lines.append(f"宏 F1 **{attribution['f1_macro']:.4f}**，加权 F1 **{attribution['f1_weighted']:.4f}**。")
    lines.append("")
    lines.append("## 泄漏对照：随机切分")
    lines.append("")
    control = report.get("random_split_control")
    if control:
        main_pr = report["models"]["xgboost"]["test"]["pr_auc"] or 0
        control_pr = control["test"]["pr_auc"] or 0
        lines.append(f"- 时间切分（最终结果）PR-AUC：**{main_pr}**")
        lines.append(f"- 随机切分（仅对照）PR-AUC：{control_pr}（阈值 {control['threshold']:.4f}）")
        lines.append(f"- 差值：**{control_pr - main_pr:+.4f}**")
        lines.append("")
        lines.append(
            "差值即标签泄漏的量化幅度。随机切分让同一段注入的相邻行同时落进训练与测试，"
            "模型可以靠记住这段波形得分；时间切分模拟的是「用过去判断未来」，才是上线后的真实条件。"
        )
    else:
        lines.append("本次训练跳过了随机切分对照（`--skip-random-control`）。")
    lines.append("")
    lines.append("## 特征重要性前 8")
    lines.append("")
    lines.append("| 特征 | 重要性 |")
    lines.append("|---|---|")
    for item in report["top_features"][:8]:
        lines.append(f"| {item['name']} | {item['importance']:.4f} |")
    lines.append("")
    notes = report.get("notes", {})
    if notes:
        lines.append("## 口径与边界（必须与指标一起引用）")
        lines.append("")
        for key, value in notes.items():
            lines.append(f"- **{key}**：{value}")
        lines.append("")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="生成异常检测报告的 Markdown 摘要并做一致性自检")
    parser.add_argument("--report", default=None, help="指定 *_anomaly.json，默认取最新的一个")
    args = parser.parse_args()

    if args.report:
        report_path = Path(args.report)
    else:
        candidates = sorted(REPORT_DIR.glob("*_anomaly.json"))
        if not candidates:
            raise SystemExit(f"{REPORT_DIR} 下没有报告，先跑 python -m ml.anomaly_detection.train")
        report_path = candidates[-1]

    report = json.loads(report_path.read_text(encoding="utf-8"))
    print(f"读取 {report_path}")
    print("-" * 96)
    failures = consistency_checks(report)
    print("-" * 96)

    markdown_path = report_path.with_suffix(".md")
    markdown_path.write_text(to_markdown(report), encoding="utf-8")
    print(f"已写出 {markdown_path}")

    if failures:
        print(f"\n自检失败 {len(failures)} 项：")
        for item in failures:
            print(f"  - {item}")
        raise SystemExit(1)
    print("\n自检全部通过，报告中的数字可以引用。")


if __name__ == "__main__":
    main()
