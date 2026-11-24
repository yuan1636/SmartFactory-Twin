/** 单设备时序（曲线页）。切时间范围立即重取，之后 60 秒刷新一次。 */

import { useCallback } from 'react';
import { apiGet, isoAgo, isoNow } from '../services/api';
import type { TelemetryResponse } from '../services/types';
import { usePolling, type PollingState } from './usePolling';

export type RangeKey = '1h' | '6h' | '24h';

export const RANGE_HOURS: Record<RangeKey, number> = { '1h': 1, '6h': 6, '24h': 24 };

export function useDeviceTelemetry(
  deviceId: string | undefined,
  range: RangeKey,
): PollingState<TelemetryResponse> {
  const hours = RANGE_HOURS[range];
  const fetcher = useCallback(() => {
    return apiGet<TelemetryResponse>(`/devices/${deviceId}/telemetry`, {
      start: isoAgo(hours),
      end: isoNow(),
      limit: 2000,
    });
  }, [deviceId, hours]);

  return usePolling(fetcher, 60_000, { enabled: Boolean(deviceId), key: `${deviceId}-${range}` });
}
