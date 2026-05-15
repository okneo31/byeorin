import {
  NODONG_MSG_TAG,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type WindowEnvelope,
} from '../src/lib/rpc.js';

// 페이지 MAIN world 에서 실행되는 inpage 스크립트.
// window.ethereum / window.nodong (EIP-1193 호환) 을 노출한다.
//
// 본 스켈레톤은 최소 표면만 구현한다:
//  - request({ method, params }): Promise<unknown>
//  - on/removeListener (chainChanged/accountsChanged 이벤트 큐만 보관)
//  - isMetaMask: false, isNodong: true

type Listener = (...args: unknown[]) => void;

class NodongInpageProvider {
  readonly isMetaMask = false;
  readonly isNodong = true;
  readonly chainId = '0x1e61'; // 7777 — 정적 노출(부팅 직후 일부 dApp 이 동기적으로 읽음)
  readonly networkVersion = '7777';

  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor() {
    window.addEventListener('message', (event: MessageEvent<WindowEnvelope>) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.tag !== NODONG_MSG_TAG) return;
      if (data.dir === 'cs-to-page') {
        const res = data.payload as JsonRpcResponse;
        const slot = this.pending.get(res.id);
        if (!slot) return;
        this.pending.delete(res.id);
        if ('error' in res) {
          const err: Error & { code?: number; data?: unknown } = new Error(res.error.message);
          err.code = res.error.code;
          err.data = res.error.data;
          slot.reject(err);
        } else {
          slot.resolve(res.result);
        }
      } else if (data.dir === 'cs-to-page-event') {
        this.emit(data.event, data.data);
      }
    });
  }

  async request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown> {
    if (!args || typeof args.method !== 'string') {
      throw Object.assign(new Error('잘못된 요청'), { code: -32602 });
    }
    const id = this.nextId++;
    const req: JsonRpcRequest = { id, method: args.method, params: args.params };
    const envelope: WindowEnvelope = { tag: NODONG_MSG_TAG, dir: 'page-to-cs', payload: req };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      window.postMessage(envelope, '*');
    });
  }

  on(event: string, fn: Listener): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
    return this;
  }

  removeListener(event: string, fn: Listener): this {
    this.listeners.get(event)?.delete(fn);
    return this;
  }

  private emit(event: string, data?: unknown): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(data);
      } catch {
        // listener 예외는 무시 — 다른 listener 보호.
      }
    }
  }
}

export default defineUnlistedScript(() => {
  const provider = new NodongInpageProvider();

  // EIP-1193 표준 슬롯: 다른 지갑이 이미 점유했다면 우리는 nodong 으로만 노출.
  try {
    if (!(window as unknown as { ethereum?: unknown }).ethereum) {
      Object.defineProperty(window, 'ethereum', {
        value: provider,
        writable: false,
        configurable: false,
      });
    }
  } catch {
    // 일부 다른 지갑이 freeze 한 경우.
  }

  Object.defineProperty(window, 'nodong', {
    value: provider,
    writable: false,
    configurable: false,
  });

  // EIP-6963 announce 는 v0.2 에서. 우선은 ethereum 슬롯과 명시 별칭만 제공.
  window.dispatchEvent(new Event('ethereum#initialized'));
});
