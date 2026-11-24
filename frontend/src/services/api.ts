/** API 客户端（规格 7.1）。 */

export class ApiError extends Error {
  code: string;
  status: number;
  detail?: unknown[];

  constructor(code: string, message: string, status: number, detail?: unknown[]) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

const BASE: string = import.meta.env.VITE_API_BASE ?? '/api/v1';
const TIMEOUT_MS = 8000;

export type QueryParams = Record<string, string | number | boolean | undefined | null>;

/**
 * 拼查询串。必须走 URLSearchParams：后端要 ISO 8601 带时区的时间，
 * 那个 "+" 若原样拼进 URL 会被服务端解析成空格并直接返回 422（2026-11-24 实测踩到）。
 */
export function buildQuery(params?: QueryParams): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const raw = await response.text();
    let payload: unknown = null;
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      // Vite 代理在后端没起时会回 500 + 纯文本 "Internal Server Error"（不是 JSON）。
      // 真正的后端错误都带 JSON 体，所以「5xx 且解析不出 JSON」按"后端不可达"处理，
      // 这样 10.1.7 的文案才是「无法连接后端」而不是「请求失败（500）」。
      if (response.status >= 500 && payload === null) {
        throw new ApiError('BACKEND_UNAVAILABLE', '后端不可达', 0);
      }
      const err = (payload ?? {}) as { code?: string; message?: string; detail?: unknown[] };
      throw new ApiError(
        err.code ?? 'UNKNOWN',
        err.message ?? `HTTP ${response.status}`,
        response.status,
        err.detail,
      );
    }
    return payload as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new ApiError('TIMEOUT', '请求超时', 0);
    }
    // 网络层失败（后端没起、端口不通）统一成 status 0，页面据此显示「无法连接后端」
    throw new ApiError('NETWORK_ERROR', e instanceof Error ? e.message : '网络错误', 0);
  } finally {
    clearTimeout(timer);
  }
}

export function apiGet<T>(path: string, params?: QueryParams): Promise<T> {
  return request<T>('GET', path + buildQuery(params));
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('POST', path, body);
}

export function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('PATCH', path, body);
}

/** ISO 8601 起始时间：后端要求带时区，这里统一用带 Z 的 UTC。 */
export function isoAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

export function isoNow(): string {
  return new Date().toISOString();
}
