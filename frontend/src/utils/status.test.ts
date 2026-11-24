import { describe, expect, it } from 'vitest';
import { countByState, effectiveState } from './status';

describe('G-03 状态合并优先级', () => {
  it('设备级 ALARM 压过一切遥测级状态', () => {
    expect(effectiveState('ALARM', 'RUNNING')).toBe('ALARM');
    expect(effectiveState('ALARM', 'STOPPED')).toBe('ALARM');
  });

  it('MAINTENANCE 压过遥测级，但低于 ALARM', () => {
    expect(effectiveState('MAINTENANCE', 'IDLE')).toBe('MAINTENANCE');
    expect(effectiveState('MAINTENANCE', 'RUNNING')).toBe('MAINTENANCE');
  });

  it('遥测级 STOPPED 比 IDLE 优先展示', () => {
    expect(effectiveState('RUNNING', 'STOPPED')).toBe('STOPPED');
    expect(effectiveState('RUNNING', 'IDLE')).toBe('IDLE');
    expect(effectiveState('RUNNING', 'RUNNING')).toBe('RUNNING');
  });

  it('拿不到 running_status 时按 RUNNING 处理（设备级只有 RUNNING 时才可能走到这里）', () => {
    expect(effectiveState('RUNNING', null)).toBe('RUNNING');
    expect(effectiveState('RUNNING', undefined)).toBe('RUNNING');
  });

  it('countByState 统计五态', () => {
    const counts = countByState(['RUNNING', 'RUNNING', 'ALARM', 'IDLE']);
    expect(counts.RUNNING).toBe(2);
    expect(counts.ALARM).toBe(1);
    expect(counts.IDLE).toBe(1);
    expect(counts.STOPPED).toBe(0);
    expect(counts.MAINTENANCE).toBe(0);
  });
});
