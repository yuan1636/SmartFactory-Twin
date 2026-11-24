/**
 * 产线物料流动的纯计算，不依赖 three（可直接单测）。
 *
 * 模型是一维队列：设备是"闸门"，闸门关着时物料停在它上游，后面的物料依次排队；
 * 物料走到产线终点就下线、回到起点重新上料。之所以要这套约束而不是简单平移，
 * 是因为「某台设备告警/维护 → 物料在它前面堆积」才是数字孪生该有的表现，
 * 否则一停线所有物料同时消失、一开线同时出现，看着像播放器而不是工厂。
 */

export interface Gate {
  /** 闸门坐标（设备入口，沿流向） */
  x: number;
  /** 挡路的设备，给调试面板与验收脚本看 */
  deviceId: string;
}

export interface FlowOptions {
  /** 物料坐标，顺序不限（内部按流向排序） */
  positions: number[];
  /** 已关闭的闸门，按 x 升序 */
  gates: Gate[];
  start: number;
  end: number;
  /**
   * 回炉落点，默认 = start。
   * 传 start - spacing 时，回炉的物料先停在色带外排队，等带上有空位再进线，
   * 否则它会生成在"正好停在闸门口的物料"屁股后面（只差 0.2m，视觉上直接穿模）。
   */
  recycleTo?: number;
  /** m/s，恒为正：流向固定为 start → end */
  speed: number;
  dt: number;
  /** 物料最小间距（米） */
  spacing: number;
  /** 停在闸门前多少米（留出设备入口余量） */
  stopGap: number;
}

export interface FlowResult {
  /**
   * 与输入**一一对应**的新位置（同一个物料还在同一个下标）。
   * 不在这里排序：排序会让"下标 i"每隔十几秒就换成另一个物料，
   * 调试面板和验收脚本按下标比较时就会看到"物料在倒退"的假象。
   */
  positions: number[];
  /** 本次到终点下线、回起点重上料的物料数 */
  recycled: number;
}

export function advanceFlow(options: FlowOptions): FlowResult {
  const { positions, gates, start, end, recycleTo, speed, dt, spacing, stopGap } = options;
  if (dt <= 0 || speed <= 0 || positions.length === 0) {
    return { positions: [...positions], recycled: 0 };
  }

  const step = speed * dt;
  // 队首（最靠近终点）先走，后面的只能走到前车再往上游 spacing 处
  const order = positions.map((x, index) => ({ x, index })).sort((a, b) => b.x - a.x);
  const next = new Array<number>(positions.length);
  let upstreamLimit = end;
  const recycledIndexes: number[] = [];

  for (const { x, index } of order) {
    // 只认前方的闸门：已经越过的闸门不该再拦它。
    // 判据必须是 ">= x"，不能是 "> x"：物料正好停在闸门坐标上时，
    // 严格大于会把闸门判成"已越过"，下一帧就放行，料会凭空穿过关着的设备。
    const gate = gates.find((g) => g.x >= x - 1e-6);
    const cap = gate ? Math.min(upstreamLimit, gate.x - stopGap) : upstreamLimit;
    // 闸门关得很近时也不允许倒退（否则物体会向后弹，看着像 bug）
    const value = Math.max(x, Math.min(x + step, cap));

    if (value >= end - 1e-6) {
      // 下线回炉：它已经不属于队首，不该再把后面的物料顶住
      recycledIndexes.push(index);
      continue;
    }

    next[index] = value;
    upstreamLimit = value - spacing;
  }

  // 回炉：先都落在等待位，再由下面的"带外排队"统一按料距排开
  for (const index of recycledIndexes) next[index] = recycleTo ?? start;

  // 带外等待区（x < start）按料距从近到远排开：
  // 堵料时会有好几台料在带外等上料，不能让它们叠在同一个坐标上。
  const upstream = next
    .map((x, index) => ({ x, index }))
    .filter((item) => item.x < start + 1e-6)
    .sort((a, b) => b.x - a.x);
  for (let i = 1; i < upstream.length; i += 1) {
    const limit = upstream[i - 1].x - spacing;
    if (upstream[i].x > limit) upstream[i].x = limit;
  }
  for (const item of upstream) next[item.index] = item.x;

  return { positions: next, recycled: recycledIndexes.length };
}
