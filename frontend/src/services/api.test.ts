import { describe, expect, it } from 'vitest';
import { ApiError, buildQuery, isoWindow } from './api';
import { describeError } from '../utils/errors';

describe('查询串编码（7.1 强制项）', () => {
  it('ISO 时间里的 + 被编码成 %2B，服务端不会把它当空格', () => {
    const qs = buildQuery({ start: '2026-11-24T04:58:10+08:00', end: '2026-11-24T05:58:10+08:00' });
    expect(qs).toContain('%2B');
    expect(qs).not.toContain('+');
    const params = new URLSearchParams(qs.slice(1));
    expect(params.get('start')).toBe('2026-11-24T04:58:10+08:00');
  });

  it('undefined / null 参数不出现', () => {
    const qs = buildQuery({ page: 1, page_size: undefined, workshop_id: null });
    expect(qs).toBe('?page=1');
  });

  it('没有参数时返回空串而不是 ?', () => {
    expect(buildQuery()).toBe('');
    expect(buildQuery({})).toBe('');
  });
});

describe('错误文案（8.3）', () => {
  it('VALIDATION_ERROR 指出具体字段', () => {
    const err = new ApiError('VALIDATION_ERROR', '请求参数校验失败', 422, [
      { field: 'query.start', message: 'Input should be a valid datetime' },
    ]);
    expect(describeError(err)).toContain('query.start');
  });

  it('DEVICE_NOT_FOUND 给中文提示', () => {
    expect(describeError(new ApiError('DEVICE_NOT_FOUND', '设备 AIR-09 不存在', 404))).toContain(
      '设备不存在',
    );
  });

  it('status 0（后端没起）提示检查服务', () => {
    expect(describeError(new ApiError('NETWORK_ERROR', 'fetch failed', 0))).toContain('无法连接后端');
  });
});

describe('时间窗（24 小时边界）', () => {
  it('起止基于同一次取时，跨度精确等于 N 小时，不会多出几毫秒', () => {
    const { start, end } = isoWindow(24);
    const span = new Date(end).getTime() - new Date(start).getTime();
    // 后端上限就是 86400 秒，多 1 毫秒就 400 RANGE_TOO_LARGE
    expect(span).toBe(24 * 3600 * 1000);
    expect(span).toBeLessThanOrEqual(86400 * 1000);
  });

  it('1 小时窗口同样精确', () => {
    const { start, end } = isoWindow(1);
    expect(new Date(end).getTime() - new Date(start).getTime()).toBe(3600 * 1000);
  });
});
