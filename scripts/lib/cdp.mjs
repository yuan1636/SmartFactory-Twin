/**
 * 页面级验收的公共底座：CDP（Chrome DevTools Protocol）最小客户端 + 断言收集器。
 *
 * 为什么不用 dump-dom：点击后的 Toast、hover 后的类名、动画的中间态都只存在于运行时，
 * 静态快照拿不到。这里直接对无头浏览器派发真实输入事件并读运行时的值。
 *
 * 前提：Chrome 以 --remote-debugging-port=9222 启动，且前端跑在 127.0.0.1:5173。
 */

export const CDP = 'http://127.0.0.1:9222';
export const WEB = 'http://127.0.0.1:5173';
export const API = 'http://127.0.0.1:8000/api/v1';

export const results = [];

export function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  · ${detail}` : ''}`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pickPage() {
  for (let i = 0; i < 30; i += 1) {
    try {
      const list = await fetch(`${CDP}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // 浏览器还没起来
    }
    await sleep(300);
  }
  throw new Error('无法连上 CDP 9222');
}

export class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const out = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (out.exceptionDetails) {
      throw new Error(out.exceptionDetails.text ?? '页面内执行出错');
    }
    return out.result.value;
  }

  async goto(path) {
    await this.evaluate(`location.href = ${JSON.stringify(WEB + path)}`);
    await this.waitFor('document.readyState === "complete" && !!document.querySelector(".side-nav")', 10000);
  }

  async waitFor(expression, timeout = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await this.evaluate(`Boolean(${expression})`)) return true;
      await sleep(200);
    }
    return false;
  }
}

export async function connect() {
  const page = await pickPage();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WS 连接失败')), { once: true });
  });
  const session = new Session(ws);
  await session.send('Runtime.enable');
  return session;
}

/** 打印汇总并返回失败条数。 */
export function summarize() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
  return failed.length;
}
