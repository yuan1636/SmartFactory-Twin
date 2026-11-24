/** G-16：后端 8 个错误码 → 中文文案。前端自造 TIMEOUT 单独处理。 */

import type { ApiError } from '../services/api';

interface ErrorDetail {
  field?: string;
  message?: string;
}

const CODE_TEXT: Record<string, string> = {
  INVALID_PARAM: '请求参数不合法',
  VALIDATION_ERROR: '参数格式错误',
  DEVICE_NOT_FOUND: '设备不存在，请检查设备编号',
  ALARM_NOT_FOUND: '告警不存在或已被处理',
  ORDER_NOT_FOUND: '订单不存在',
  DUPLICATE_TELEMETRY: '该时刻数据已存在',
  DUPLICATE_ORDER: '订单编号重复',
  DEVICE_HAS_OPEN_ALARM: '该设备仍有未解除告警，无法置为运行中',
  RANGE_TOO_LARGE: '查询时间跨度超过 24 小时，请缩小范围',
  TIMEOUT: '请求超时，请检查后端是否启动',
};

/** 把错误对象翻译成一句可直接显示给用户的话。 */
export function describeError(err: unknown): string {
  if (err instanceof Error && 'code' in err) {
    const apiErr = err as ApiError;
    // VALIDATION_ERROR 的 detail[0] 能指出具体哪个参数写错，比笼统文案有用得多
    if (apiErr.code === 'VALIDATION_ERROR' && apiErr.detail?.length) {
      const d = apiErr.detail[0] as ErrorDetail;
      const where = d.field ? `${d.field} ` : '';
      return `参数格式错误：${where}${d.message ?? ''}（多为时间参数未编码）`.trim();
    }
    const base = CODE_TEXT[apiErr.code];
    if (base) {
      return apiErr.message && apiErr.code === 'INVALID_PARAM' ? `${base}：${apiErr.message}` : base;
    }
    if (apiErr.status === 0) return '无法连接后端，请检查服务是否启动';
    return `请求失败（${apiErr.status}），请稍后重试`;
  }
  if (err instanceof Error) return err.message;
  return '发生未知错误';
}
