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

// ── Ledger 모듈 prefetch (Chrome MV3 popup user-gesture 함정 회피) ───────────
//
// 문제: popup 의 click → connectHardware → WebHidTransport.open → loadWebHid 의
// `await import('@ledgerhq/hw-transport-webhid')` 가 *첫* await 라면 Chrome 이
// "user gesture 만료" 판정해 navigator.hid.requestDevice() 의 chooser 가
// 안 뜬다 (조용히 실패).
//
// 해결: webhid.ts 가 import 되는 시점(=popup mount)에 ledger 모듈을 한 번
// 미리 import 해 캐시에 올려둔다. 사용자 click 시점의 `await import(...)` 는
// 모듈 캐시 hit 으로 *동기적으로* resolve → gesture chain 이 끊기지 않는다.
//
// sideEffects:false 패키지에서도 top-level 함수 호출은 side effect 로 보존된다.
let _webhidPrefetch: Promise<unknown> | null = null;
function prefetchWebHidModule(): void {
  if (_webhidPrefetch !== null) return;
  // 브라우저 환경에서만 prefetch (node 테스트/SSR 에서 모듈이 없을 수 있음).
  const nav = (globalThis as { navigator?: unknown }).navigator;
  if (!nav) return;
  _webhidPrefetch = import(
    /* @vite-ignore */ '@ledgerhq/hw-transport-webhid'
  ).catch(() => null);
}
prefetchWebHidModule();

/**
 * Ledger WebHID transport 모듈을 명시적으로 prefetch 한다.
 *
 * webhid.ts 가 import 되는 시점에도 자동 prefetch 가 동작하지만, 컨슈머
 * (예: extension popup) 가 별도 mount lifecycle 에서 한 번 더 부르고 싶을
 * 때 사용. 이미 시작된 prefetch 는 재호출해도 같은 promise 를 공유.
 */
export function prefetchWebHidTransport(): Promise<unknown> | null {
  prefetchWebHidModule();
  return _webhidPrefetch;
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
  let mod: unknown;
  try {
    mod = await import(/* @vite-ignore */ '@ledgerhq/hw-transport-webhid');
  } catch (e) {
    throw new Error(
      'WebHidTransport: @ledgerhq/hw-transport-webhid is not installed. ' +
        `(${e instanceof Error ? e.message : String(e)})`,
    );
  }
  // hw-transport-webhid 의 default export 는 `class TransportWebHID` 자체이고
  // 정적 메서드 `request()` / `openConnected()` 를 갖는다. ESM/CJS interop
  // 에 따라 module shape 이 다음 중 하나가 될 수 있다:
  //   - `mod`               (순수 ESM, default 없음)
  //   - `mod.default`       (CJS → ESM 일반 변환)
  //   - `mod.default.default` (CJS `module.exports = { default: X }` 이중 wrap)
  // 각 후보를 순서대로 본 뒤 `.request` 가 함수인 첫 객체를 채택한다.
  // `class` 의 typeof 는 'function' 이므로 type-narrowing 없이 그대로 검사.
  type HidShape = { request?: unknown; openConnected?: unknown; default?: unknown };
  const candidates: HidShape[] = [
    mod as HidShape,
    (mod as HidShape).default as HidShape,
    ((mod as HidShape).default as HidShape | undefined)?.default as HidShape,
  ];
  for (const c of candidates) {
    if (c && typeof c.request === 'function') {
      return c as unknown as WebHidModule['default'];
    }
  }
  // 그래도 못 찾으면 어디서 막힌 건지 keys 를 모두 노출해 후속 unwrap 규칙 작성에 활용.
  const topKeys = mod && typeof mod === 'object' ? Object.keys(mod) : [];
  const defObj = (mod as HidShape | null)?.default;
  const defKeys = defObj && typeof defObj === 'object' ? Object.keys(defObj) : [];
  throw new Error(
    `WebHidTransport: hw-transport-webhid module shape unexpected — ` +
      `top-level keys=[${topKeys.join(',')}] (typeof default=${typeof defObj}), ` +
      `default keys=[${defKeys.length ? defKeys.join(',') : '<none>'}]. ` +
      `Expected .request() on one of mod / mod.default / mod.default.default.`,
  );
}
