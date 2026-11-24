import { describe, expect, it } from 'vitest';
import { formatMetric, formatNumber, formatPercent, formatTime, secondsSince } from './format';

const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);

describe('G-13 时间格式化', () => {
  it('UTC 输入按本地时区显示，不是截字符串', () => {
    const iso = '2026-11-24T04:58:10Z';
    const d = new Date(iso);
    const expected = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
      d.getHours(),
    )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    expect(formatTime(iso)).toBe(expected);
  });

  it('非法输入显示占位符而不是 Invalid Date', () => {
    expect(formatTime('not-a-date')).toBe('—');
    expect(formatTime(null)).toBe('—');
  });

  it('secondsSince 对旧时间返回正数', () => {
    const value = secondsSince(new Date(Date.now() - 5000).toISOString());
    expect(value).not.toBeNull();
    expect(value as number).toBeGreaterThanOrEqual(4);
  });
});

describe('数值与单位', () => {
  it('千分位', () => {
    expect(formatNumber(604828)).toBe('604,828');
  });

  it('0~1 小数转百分比', () => {
    expect(formatPercent(0.9652)).toBe('96.5%');
    expect(formatPercent(0)).toBe('0.0%');
  });

  it('指标带单位，转速不带小数', () => {
    expect(formatMetric('temperature', 96)).toBe('96.0 ℃');
    expect(formatMetric('speed', 1476.4)).toBe('1,476 rpm');
    expect(formatMetric('vibration', null)).toBe('—');
  });
});
