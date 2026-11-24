/** 错误态（G-16）：错误码中文文案 + 重试。任何接口失败都不许整页白屏。 */

import { describeError } from '../utils/errors';

interface ErrorStateProps {
  error: unknown;
  onRetry?: () => void;
}

export function ErrorState({ error, onRetry }: ErrorStateProps) {
  return (
    <div className="state-block state-block--error">
      <div className="state-block__title">{describeError(error)}</div>
      <div className="state-block__hint">
        请确认后端已启动（127.0.0.1:8000）后点重试。若错误码是 VALIDATION_ERROR，多为时间参数里的 “+”
        没有做 URL 编码。
      </div>
      {onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}
