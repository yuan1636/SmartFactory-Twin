/** 页面三：生产数据分析 —— 第 3 阶段 Batch 2 交付（规格 5.4）。 */

export default function Production() {
  return (
    <div className="card placeholder">
      <span className="placeholder__tag">Batch 2 交付</span>
      <h2>生产数据分析</h2>
      <p>
        本页在 Batch 2 实现，施工依据为 <code>docs/spec_phase3.md</code> 第 5.4 节：
        4 张 KPI 卡 + 四产线产量对比柱状 + 最近 20 单合格率走势 + 订单表。
      </p>
      <p className="muted">
        现在先不展示任何数字：后端 <code>/stats/production</code> 默认窗口是最近 1
        小时，而模拟器按 30 件/小时推进，该窗口会返回全 0（第 2 阶段实测），必须显式传 24
        小时窗口才有意义。为避免给出误导性的 0，本页留空。
      </p>
    </div>
  );
}
