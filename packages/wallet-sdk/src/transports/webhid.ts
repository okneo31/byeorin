// WebHID transport wrapper.
//
// `@ledgerhq/hw-transport-webhid` 는 브라우저(WebExtension/일반 페이지)에서 Ledger
// 디바이스를 잡는 표준 통로다. 동적 import 로 끌어쓰는 이유는 두 가지:
//
//   1) 본 SDK 는 Node/브라우저 양쪽 환경에서 import 가능해야 한다. WebHID 는
//      브라우저에만 존재한다.
//   2) `@ledgerhq/*` 미설치 시에도 SDK typecheck/build 가 성공해야 한다(미설치
//      환경의 Node-only 사용자에게 부담을 주지 않는다).

import type { HwTransport } from '../signers/hw.js';

export interface WebHidOpenOptions {
  /**
   * 사용자에게 다시 디바이스 선택 다이얼로그를 띄울지 여부.
   * - false(기본): 권한이 있는 첫 디바이스에 자동 연결. 권한이 없으면 한 번 묻는다.
   * - true: 항상 chooser 를 띄움 — 멀티 디바이스 환경에서 유용.
   */
  forceRequest?: boolean;
  /** open 호출의 사용자 제스처 핸들러 안에서만 호출되어야 함(브라우저 정책). */
  scrambleKey?: string;
}

/**
 * Ledger WebHID 트랜스포트를 우리 `HwTransport` 형태로 노출하는 얇은 어댑터.
 *
 * 사용 예 (브라우저):
 * ```ts
 * const transport = await WebHidTransport.open();
 * const signer = new HwSigner({ transport, appName: 'solana', derivationPath: "m/44'/501'/0'/0'" });
 * ```
 *
 * 권한 흐름: 사용자 제스처(클릭) → `navigator.hid.requestDevice` 프롬프트 →
 * 디바이스 선택 → 로컬 권한 저장 → 이후 같은 출처에서는 재프롬프트 없이 자동 연결.
 */
export class WebHidTransport implements HwTransport {
  private readonly inner: InnerTransport;

  private constructor(inner: InnerTransport) {
    this.inner = inner;
  }

  static async open(opts: WebHidOpenOptions = {}): Promise<WebHidTransport> {
    assertWebHidAvailable();
    const mod = await loadWebHid();
    // hw-transport-webhid 는 정적 `request()` 및 `openConnected()` 를 제공한다.
    // - request(): 항상 chooser 를 띄움(사용자 제스처 안에서만 동작).
    // - openConnected(): 권한이 이미 부여된 디바이스에 자동 재연결.
    const transport = opts.forceRequest
      ? await mod.request()
      : (await mod.openConnected()) ?? (await mod.request());
    return new WebHidTransport(transport);
  }

  async send(
    cla: number,
    ins: number,
    p1: number,
    p2: number,
    data?: Uint8Array,
  ): Promise<Uint8Array> {
    const buf = await this.inner.send(cla, ins, p1, p2, data);
    return buf instanceof Uint8Array ? buf : new Uint8Array(buf as ArrayLike<number>);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  /** 내부 트랜스포트 — `@ledgerhq/hw-app-*` 가 직접 받아야 할 때 사용. */
  raw(): unknown {
    return this.inner;
  }
}

// ── 내부 ─────────────────────────────────────────────────────────────────

interface InnerTransport {
  send(
    cla: number,
    ins: number,
    p1: number,
    p2: number,
    data?: Uint8Array,
  ): Promise<Uint8Array | ArrayLike<number>>;
  close(): Promise<void>;
}

interface WebHidModule {
  default: {
    request(): Promise<InnerTransport>;
    openConnected(): Promise<InnerTransport | null>;
  };
}

function assertWebHidAvailable(): void {
  const nav = (globalThis as { navigator?: { hid?: unknown } }).navigator;
  if (!nav || !nav.hid) {
    throw new Error(
      'WebHidTransport: navigator.hid is unavailable. ' +
        'WebHID requires Chrome/Edge/Brave (or a Tauri webview with WebHID enabled) ' +
        'and a secure context (https or localhost).',
    );
  }
}

async function loadWebHid(): Promise<WebHidModule['default']> {
  try {
    const mod = (await import(
      /* @vite-ignore */ '@ledgerhq/hw-transport-webhid'
    )) as WebHidModule;
    return mod.default;
  } catch (e) {
    throw new Error(
      'WebHidTransport: @ledgerhq/hw-transport-webhid is not installed. ' +
        `(${e instanceof Error ? e.message : String(e)})`,
    );
  }
}
