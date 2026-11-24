/** 页面四：设备告警与维护 —— 第 3 阶段 Batch 2 交付（规格 5.5，偏差 D-01 新增页）。 */

export default function Alerts() {
  return (
    <div className="card placeholder">
      <span className="placeholder__tag">Batch 2 交付</span>
      <h2>设备告警与维护</h2>
      <p>
        本页在 Batch 2 实现，施工依据为 <code>docs/spec_phase3.md</code> 第 5.5 节：告警
        KPI、三级筛选、告警表与「解除」动作、维护记录表与新增维护表单。
      </p>
      <p className="muted">
        解除告警必须把后端返回的 <code>device_status</code> 与 <code>open_alarm_count</code>{' '}
        原样告诉用户（「已解除 1 条，该设备仍有 N 条未解除告警」），这是第 2 阶段 G-10
        规则的前端可见性，不能简写成「操作成功」。
      </p>
    </div>
  );
}
