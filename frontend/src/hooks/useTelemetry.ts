/** 状态读取（7.4）。selector 只返回原始值时才能用，避免每次快照变化都全量重渲染。 */

import { useSyncExternalStore } from 'react';
import { getSnapshot, getDevice, subscribe, type DeviceView, type StoreSnapshot } from '../services/store';

export function useStore(): StoreSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useStoreSelector<T>(selector: (s: StoreSnapshot) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(getSnapshot()),
    () => selector(getSnapshot()),
  );
}

export function useDeviceView(deviceId: string | undefined): DeviceView | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (deviceId ? getDevice(deviceId) : undefined),
    () => (deviceId ? getDevice(deviceId) : undefined),
  );
}

/** 直接从 store 更新三维场景用，不经过 React（G-17）。 */
export { subscribe as subscribeStore, getSnapshot as readStore };
