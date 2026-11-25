import { describe, expect, it } from 'vitest';
import { advanceFlow, type FlowOptions } from './lineTraffic';

const base: FlowOptions = {
  positions: [8, 5, 2],
  gates: [],
  start: 0,
  end: 10,
  speed: 2,
  dt: 0.5,
  spacing: 3,
  stopGap: 1,
};

describe('产线物料流动（一维队列）', () => {
  it('无闸门时按 speed×dt 前进，输出与输入一一对应', () => {
    // 输入顺序是 8 / 5 / 2，输出同下标：8→9，5→6，2→3
    const { positions } = advanceFlow(base);
    expect(positions).toEqual([9, 6, 3]);
  });

  it('闸门关闭时停在上游 stopGap 处，后面的依次排队', () => {
    const { positions } = advanceFlow({ ...base, gates: [{ x: 9, deviceId: 'CNC-01' }] });
    expect(positions).toEqual([8, 5, 2]);
  });

  it('已经越过闸门的物料不再被它拦住', () => {
    const { positions } = advanceFlow({
      ...base,
      positions: [4],
      gates: [{ x: 3, deviceId: 'CNC-01' }],
    });
    expect(positions).toEqual([5]);
  });

  it('走到终点就下线回到起点重新上料', () => {
    const { positions, recycled } = advanceFlow({ ...base, positions: [9.5] });
    expect(recycled).toBe(1);
    expect(positions).toEqual([0]);
  });

  it('给了 recycleTo 时回炉落在带外（等带上有空位再进线）', () => {
    const { positions } = advanceFlow({ ...base, positions: [9.5], recycleTo: -3 });
    expect(positions).toEqual([-3]);
  });

  it('dt=0 或 speed=0 时原样返回（降级动效、暂停都靠它）', () => {
    expect(advanceFlow({ ...base, dt: 0 }).positions).toEqual([8, 5, 2]);
    expect(advanceFlow({ ...base, speed: 0 }).positions).toEqual([8, 5, 2]);
  });

  it('step 很大也不会穿过闸门（不出现"漏料"）', () => {
    const { positions } = advanceFlow({
      ...base,
      positions: [2],
      speed: 100,
      dt: 1,
      gates: [{ x: 6, deviceId: 'ROB-01' }],
    });
    expect(positions).toEqual([5]);
  });

  it('物料贴得很近又遇闸门时不会向后弹', () => {
    const { positions } = advanceFlow({
      ...base,
      positions: [5.5],
      gates: [{ x: 6, deviceId: 'ROB-01' }],
      stopGap: 2,
    });
    expect(positions).toEqual([5.5]);
  });

  it('停在闸门上的物料下一帧不会越过去（严格大于判据会漏）', () => {
    const gates = [{ x: 5, deviceId: 'ROB-01' }];
    // 正好停在闸门上
    expect(advanceFlow({ ...base, positions: [5], gates }).positions).toEqual([5]);
    // 连续跑 50 帧也不能穿过去
    let positions = [5];
    for (let i = 0; i < 50; i += 1) {
      positions = advanceFlow({ ...base, positions, gates }).positions;
    }
    expect(positions).toEqual([5]);
  });

  it('队列最终停在闸门前，后排按料距排开（真实 A1 数据）', () => {
    const gates = [
      { x: -33.8, deviceId: 'CNC-01' },
      { x: -27.2, deviceId: 'ROB-01' },
    ];
    let positions = [-34, -31, -28, -25, -22, -19, -16, -13, -10];
    for (let i = 0; i < 500; i += 1) {
      positions = advanceFlow({
        positions,
        gates,
        start: -34,
        end: -6,
        recycleTo: -37,
        speed: 2.4,
        dt: 0.1,
        spacing: 3,
        stopGap: 0,
      }).positions;
    }
    const upstreamOfRob = positions.filter((x) => x <= -27.19).sort((a, b) => b - a);
    expect(upstreamOfRob[0]).toBeCloseTo(-27.2, 1);
    expect(upstreamOfRob[1]).toBeCloseTo(-30.2, 1);
    // 没有任何物料停在闸门下游 0~0.3m 的"穿模区"
    const crossed = positions.filter((x) => x > -27.2 && x < -26.9);
    expect(crossed).toEqual([]);
    // 任意两台物料都不会重叠（料箱宽 0.9m，允许 0.05 的数值误差）
    const asc = [...positions].sort((a, b) => a - b);
    for (let i = 1; i < asc.length; i += 1) {
      expect(asc[i] - asc[i - 1], `第 ${i} 台与前一太间隔`).toBeGreaterThan(0.85);
    }
  });

  it('空产线不报错', () => {
    expect(advanceFlow({ ...base, positions: [] }).positions).toEqual([]);
  });

  it('回炉不改变下标含义：每个物料只会前进或跳回起点', () => {
    let positions = [0, 3, 6, 9];
    const seen = new Set<string>();
    for (let i = 0; i < 60; i += 1) {
      const next = advanceFlow({ ...base, positions, start: 0, end: 10, speed: 2, dt: 0.5 }).positions;
      for (let k = 0; k < positions.length; k += 1) {
        const forward = next[k] > positions[k];
        // 回炉的物料会退到带外等待位（<= start），这不算倒退
        const recycled = next[k] <= 0 + 1e-6;
        expect(forward || recycled, `第 ${i} 帧下标 ${k}：${positions[k]} → ${next[k]}`).toBe(true);
      }
      seen.add(next.map((n) => n.toFixed(1)).join(','));
      positions = next;
    }
    // 60 帧里必然发生过回炉，否则这条断言没验到东西
    expect(seen.size).toBeGreaterThan(10);
    expect(positions.every((n) => n >= 0 && n <= 10)).toBe(true);
  });
});

describe('物料动力学：起步加速 / 到位减速 / 停顿（本批新增）', () => {
  const dynBase: FlowOptions = {
    positions: [0],
    gates: [],
    start: 0,
    end: 1000,
    recycleTo: -3,
    speed: 2,
    dt: 0.1,
    spacing: 3,
    stopGap: 0,
    velocities: [0],
    dwell: [0],
    targetSpeed: 2,
    accel: 1.6,
    decel: 2.4,
    dwellSeconds: 0.25,
  };

  const step = (opt: FlowOptions) => {
    const r = advanceFlow(opt);
    return { ...opt, positions: r.positions, velocities: r.velocities, dwell: r.dwell };
  };

  it('从静止起步只走 accel×dt，不是立刻全速', () => {
    const r = advanceFlow(dynBase);
    expect(r.velocities[0]).toBeCloseTo(0.16, 3);
    expect(r.positions[0]).toBeCloseTo(0.016, 3);
  });

  it('加速到目标速度后不再增加（约 1.3 秒达到 2 m/s）', () => {
    let s = dynBase;
    for (let i = 0; i < 30; i += 1) s = step(s);
    expect((s.velocities as number[])[0]).toBeCloseTo(2, 2);
    const before = s.positions[0];
    s = step(s);
    expect(s.positions[0] - before).toBeCloseTo(0.2, 2);
  });

  it('到位前按刹车距离减速（v ≤ √(2·a·余量)），不是到了才急停', () => {
    const r = advanceFlow({
      ...dynBase,
      positions: [99.5],
      velocities: [2],
      gates: [{ x: 100, deviceId: 'CNC-01' }],
    });
    expect(r.velocities[0]).toBeLessThan(2);
    expect(r.velocities[0]).toBeLessThanOrEqual(Math.sqrt(2 * 2.4 * 0.5) + 1e-6);
    expect(r.positions[0]).toBeGreaterThan(99.5);
    expect(r.positions[0]).toBeLessThanOrEqual(100);
  });

  it('停在限制位后停顿 0.2~0.3 秒，闸门开了也要先停够', () => {
    let s: FlowOptions = {
      ...dynBase,
      positions: [99.9],
      velocities: [2],
      gates: [{ x: 100, deviceId: 'CNC-01' }],
    };
    // 先跑到位
    for (let i = 0; i < 30; i += 1) s = step(s);
    expect(s.positions[0]).toBeCloseTo(100, 2);
    expect((s.dwell as number[])[0]).toBeCloseTo(0.25, 2);

    // 闸门打开，但停顿期内不许动
    const open: FlowOptions = { ...s, gates: [] };
    const a = step(open);
    expect(a.positions[0]).toBeCloseTo(100, 3);
    const b = step(a);
    expect(b.positions[0]).toBeCloseTo(100, 3);
    // 三帧后（0.3 s > 0.25 s）开始重新加速
    const c = step(b);
    const d = step(c);
    expect(d.positions[0]).toBeGreaterThan(100);
  });

  it('带速为 0（检修）时物料完全不动', () => {
    let s: FlowOptions = { ...dynBase, targetSpeed: 0, speed: 0, positions: [5], velocities: [0] };
    for (let i = 0; i < 20; i += 1) s = step(s);
    expect(s.positions[0]).toBeCloseTo(5, 5);
    expect((s.velocities as number[])[0]).toBe(0);
  });

  it('动力学下两台料也不会穿过闸门或叠在一起', () => {
    let s: FlowOptions = {
      ...dynBase,
      positions: [98, 95],
      velocities: [2, 2],
      dwell: [0, 0],
      gates: [{ x: 100, deviceId: 'CNC-01' }],
    };
    for (let i = 0; i < 300; i += 1) s = step(s);
    const [head, tail] = s.positions;
    expect(head).toBeCloseTo(100, 1);
    expect(tail).toBeCloseTo(97, 1); // 按料距 3 m 排队
  });
});
