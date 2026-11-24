/** 页面五：AI 预测分析 —— 第 3 阶段 Batch 2 交付（规格 5.6，只展示真值，无模型）。 */

export default function AiInsight() {
  return (
    <div className="card placeholder">
      <span className="placeholder__tag">Batch 2 交付</span>
      <h2>AI 预测分析</h2>
      <p>
        本页在 Batch 2 实现，施工依据为 <code>docs/spec_phase3.md</code> 第 5.6 节：醒目声明条 +
        异常真值时间轴（甘特）+ 真值与告警的对比柱状 + 真值表 + 模型输出预留区。
      </p>
      <p className="muted">
        本阶段不含任何模型推理，因此本页不会出现「准确率」「预测故障概率」这类数字。
        所有数据来自模拟器写入的异常真值与阈值规则。
      </p>
    </div>
  );
}
