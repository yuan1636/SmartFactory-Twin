import type { RangeKey } from '../hooks/useDeviceTelemetry';

interface RangePickerProps {
  value: RangeKey;
  onChange: (next: RangeKey) => void;
  options?: RangeKey[];
}

const LABEL: Record<RangeKey, string> = { '1h': '1 小时', '6h': '6 小时', '24h': '24 小时' };

export function RangePicker({ value, onChange, options = ['1h', '6h', '24h'] }: RangePickerProps) {
  return (
    <div className="segmented" role="group" aria-label="时间范围">
      {options.map((key) => (
        <button
          key={key}
          type="button"
          className={`segmented__item${key === value ? ' is-active' : ''}`}
          onClick={() => onChange(key)}
        >
          {LABEL[key]}
        </button>
      ))}
    </div>
  );
}
