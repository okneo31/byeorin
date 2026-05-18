import {
  BYEORIN_MSG_TAG,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type WindowEnvelope,
} from '../src/lib/rpc.js';

// 페이지 MAIN world 에서 실행되는 inpage 스크립트.
// window.ethereum / window.byeorin (EIP-1193 호환) 을 노출한다.
//
// 본 스켈레톤은 최소 표면만 구현한다:
//  - request({ method, params }): Promise<unknown>
//  - on/removeListener (chainChanged/accountsChanged 이벤트 큐만 보관)
//  - isMetaMask: false, isByeorin: true
//
// H2 fix:
//  - EIP-6963 announceProvider 구현 (MetaMask 와 공존)
//  - window.ethereum 은 configurable: true 로 설정해 다른 지갑이 덮어쓸 수 있게 한다
//  - 다른 지갑이 announce 하기를 잠시 기다린 뒤에만 ethereum 슬롯을 점유한다

type Listener = (...args: unknown[]) => void;

// EIP-6963 식별자(build 별 고정 UUID — 본 빌드 표지).
const EIP6963_UUID = '6e6f646f-6e67-4e4f-444f-4e472d574c54'; // "byeorin-BYEORIN-WLT"
const EIP6963_RDNS = 'top.ttl1.byeorin';

// 작은 SVG 아이콘 — 적색 사각형 + 흰색 '노' 글자.
// data URL 화(외부 fetch 없음, < 1KB).
//
// NOTE 1: 한글 "노" (U+B178) 는 Latin1 범위를 벗어나므로 btoa() 가 InvalidCharacterError 를
//   던진다. inpage.ts 는 모듈 평가 시점에 실행되므로 그 예외가 발생하면 window.ethereum /
//   window.byeorin / EIP-6963 announce 가 *모두* 동작하지 않아 dApp 에서 지갑이 보이지 않는다.
//   따라서 base64 가 아닌 URI 인코딩 형태(`data:image/svg+xml,<encoded>`)를 사용한다.
//   EIP-6963 사양은 두 형태를 모두 허용하며 dApp 의 <img src=...> 에도 그대로 들어간다.
// NOTE 2: 한글 글자(노/벼린)는 String.fromCharCode 로 *런타임* 에 만든다.
//   vite/esbuild 는 소스의 raw 한글과 \uXXXX 이스케이프를 모두 UTF-8 바이트로 동일하게
//   출력한다. inpage.js 가 chrome-extension:// 에서 charset header 없이 페이지로 로드되면
//   그 UTF-8 이 ISO-8859-1 로 해석돼 mojibake (예: e85b8 → 'ë…¸') 가 된다.
//   정수 코드포인트를 String.fromCharCode 로 합치는 형태는 minifier 가 손대지 않으므로
//   어떤 페이지 인코딩에서도 정확히 같은 UTF-16 코드 유닛이 만들어진다.
// 비-ASCII 문자를 코드포인트 정수 배열에서 *런타임* 에 합친다.
// 단순 String.fromCharCode(0xB178) 는 vite/esbuild minifier 가 컴파일 타임에 평가해 raw
// 한글로 바꿔버리므로(=원래 문제로 회귀), 길이를 알 수 없는 입력으로 만들어 folding 을
// 피한다. .apply 경유 + 배열 우회는 vite 의 evaluate 패스가 보존한다.
function codesToString(codes: number[]): string {
  // .apply 사용은 의도적임 — fromCharCode(...codes) 도 fold 될 수 있다.
  // eslint-disable-next-line prefer-spread
  return String.fromCharCode.apply(null, codes);
}

// 곡괭이 인장 마크 — 노동의 도구 + 채굴 이중 의미.
// SVG 내부에 비-ASCII 문자가 없으므로 raw string 으로 안전. 한글 글자 합성 불필요.
// 본 SVG 는 apps/extension/public/icon/icon-eip6963.svg 와 byte-equivalent 한 인장 + 교차
// 곡괭이 + 노란 印朱점 디자인. dApp picker 의 우리 아이콘 = 확장 toolbar 아이콘 = 동일 외관.
const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">' +
  '<path d="M56 22C80 18 178 18 200 24C232 30 236 56 236 80C240 110 240 152 234 178C230 210 206 234 178 236C148 240 104 240 78 234C48 232 22 208 20 178C16 148 16 104 22 78C26 48 32 26 56 22Z" fill="#c41e1e"/>' +
  '<path d="M64 36C86 32 172 32 192 38C218 42 220 64 220 84C224 110 224 148 218 172C214 200 196 218 172 220C146 224 110 224 84 218C58 216 38 196 36 172C32 146 32 108 38 86C42 60 46 38 64 36Z" fill="none" stroke="#fffaf0" stroke-width="2" opacity="0.4"/>' +
  '<g transform="translate(128 134) rotate(-45) scale(0.82)">' +
  '<path d="M-100-8C-96-11-50-10 0-10C30-10 56-9 72-7L72 7C56 9 30 10 0 10C-50 10-96 11-100 8C-103 6-103-6-100-8Z" fill="#fffaf0"/>' +
  '<path d="M78-86L96-76C100-54 100-28 100-8C106-6 108-2 108 0C108 2 106 6 100 8C100 26 102 46 104 56L88 62L76 36L70 12L66 0L70-12L76-36L78-86Z" fill="#fffaf0"/>' +
  '</g>' +
  '<g transform="translate(128 134) rotate(-135) scale(0.82)">' +
  '<path d="M-100-8C-96-11-50-10 0-10C30-10 56-9 72-7L72 7C56 9 30 10 0 10C-50 10-96 11-100 8C-103 6-103-6-100-8Z" fill="#fffaf0"/>' +
  '<path d="M78-86L96-76C100-54 100-28 100-8C106-6 108-2 108 0C108 2 106 6 100 8C100 26 102 46 104 56L88 62L76 36L70 12L66 0L70-12L76-36L78-86Z" fill="#fffaf0"/>' +
  '</g>' +
  '<circle cx="128" cy="58" r="6" fill="#f4c430"/>' +
  '<circle cx="128" cy="58" r="2" fill="#c41e1e"/>' +
  '<circle cx="102" cy="50" r="3" fill="#fffaf0"/>' +
  '<circle cx="154" cy="50" r="3" fill="#fffaf0"/>' +
  '</svg>';
const ICON_DATA_URL = 'data:image/svg+xml,' + encodeURIComponent(ICON_SVG);

// EIP-6963 표기명 — '벼린'.
//   노 U+B178 · 동 U+B3D9 · 자 U+C790 · 의 U+C758 · (공백) · 지 U+C9C0 · 갑 U+AC11
const BRAND_NAME = codesToString([0xB178, 0xB3D9, 0xC790, 0xC758, 0x20, 0xC9C0, 0xAC11]);

class ByeorinInpageProvider {
  // ── 식별 플래그 ────────────────────────────────────────────
  // 우리는 MetaMask 가 *아니다*. 사칭 금지 — 일부 dApp 이 isMetaMask 만 보고
  // legacy MM 분기를 타려고 해도 EIP-6963 / isByeorin 으로 우리를 구분해야 한다.
  readonly isMetaMask = false;
  readonly isByeorin = true;

  // ── eager (legacy) 표면 ───────────────────────────────────
  // EIP-1193 은 chainId/selectedAddress 를 *권장* 사항으로만 두지만, 실제 dApp
  // (MetaMask test-dapp 포함)이 sync property 로 읽기에 호환성 차원에서 노출한다.
  // 값은 request() 결과로 자동 갱신된다.
  chainId: string = '0x1e61';   // 7777 — TTL 메인넷
  networkVersion: string = '7777';
  selectedAddress: string | null = null;

  // EIP-1193 isConnected(): provider 자체가 RPC 를 받을 수 있는 상태인지.
  // 본 inpage 는 background SW 가 살아있는 한 항상 routing 가능하므로 true.
  // (계정 unlock 여부는 별개 — 이는 selectedAddress / eth_accounts 가 표현한다.)
  isConnected = (): boolean => true;

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
      if (!data || data.tag !== BYEORIN_MSG_TAG) return;
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
        // background → content → inpage 로 흘러온 푸시 이벤트
        // (예: 사용자가 popup 에서 잠금 → accountsChanged([]) 푸시).
        // 본 분기에서는 eager state 도 함께 갱신한다.
        this.applyEventSideEffects(data.event, data.data);
        this.emit(data.event, data.data);
      }
    });
  }

  async request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown> {
    if (!args || typeof args.method !== 'string') {
      // '잘못된 요청' — codesToString 로 런타임 합성 (mojibake 방지).
      //   잘 U+C798 · 못 U+BABB · 된 U+B41C · (공백) · 요 U+C694 · 청 U+CCAD
      throw Object.assign(
        new Error(codesToString([0xC798, 0xBABB, 0xB41C, 0x20, 0xC694, 0xCCAD])),
        { code: -32602 },
      );
    }
    const id = this.nextId++;
    const req: JsonRpcRequest = { id, method: args.method, params: args.params };
    const envelope: WindowEnvelope = { tag: BYEORIN_MSG_TAG, dir: 'page-to-cs', payload: req };
    const result = await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      window.postMessage(envelope, '*');
    });
    // 알려진 메서드의 결과로 eager state 갱신 + 변경 시 이벤트 발사.
    // 이로써 dApp 이 매번 chainId 를 request() 로 묻지 않아도 sync 프로퍼티만으로
    // 최신 값을 얻을 수 있다(MetaMask test-dapp Status 필드 등).
    this.absorbRequestResult(args.method, result);
    return result;
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

  // EIP-1193 deprecated alias. 일부 legacy dApp(예: 오래된 wallet-connect 데모)은
  // 여전히 enable() 만 호출한다. 표준 spec 은 eth_requestAccounts 로 동등.
  enable(): Promise<string[]> {
    return this.request({ method: 'eth_requestAccounts' }) as Promise<string[]>;
  }

  /** 외부에서 임의 이벤트를 페이지로 알려야 할 때(테스트/디버그) 호출 가능. 내부적으로는 emit 으로 통일. */
  emit(event: string, data?: unknown): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(data);
      } catch {
        // listener 예외는 무시 — 다른 listener 보호 (EIP-1193 권고).
      }
    }
  }

  /**
   * request() 의 결과를 eager state(chainId/networkVersion/selectedAddress) 에
   * 흡수하고, 변경된 경우에만 EIP-1193 이벤트를 발사한다.
   */
  private absorbRequestResult(method: string, result: unknown): void {
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
      const accounts = Array.isArray(result) ? (result as string[]) : [];
      const newSelected = accounts[0] ?? null;
      if (this.selectedAddress !== newSelected) {
        this.selectedAddress = newSelected;
        this.emit('accountsChanged', accounts);
      }
      return;
    }
    if (method === 'eth_chainId' && typeof result === 'string') {
      const newChainId = result;
      if (this.chainId !== newChainId) {
        this.chainId = newChainId;
        // networkVersion 은 10진 문자열. 0x… → number → String.
        const n = parseInt(newChainId, 16);
        this.networkVersion = Number.isFinite(n) ? String(n) : this.networkVersion;
        this.emit('chainChanged', newChainId);
      }
    }
  }

  /**
   * background → content → inpage 푸시 이벤트의 부수효과.
   * TODO: 현재 content.ts 는 background 의 chrome.runtime.onMessage 를 듣지
   * 않으므로 본 경로는 실제로 트리거되지 않는다. v0.3 에서 content 가
   * chrome.runtime.onMessage 로 'wallet-locked' / 'accounts-changed' 를
   * 수신해 'cs-to-page-event' envelope 로 포워딩하면 자동으로 활성화된다.
   */
  private applyEventSideEffects(event: string, data: unknown): void {
    if (event === 'accountsChanged') {
      const accounts = Array.isArray(data) ? (data as string[]) : [];
      this.selectedAddress = accounts[0] ?? null;
    } else if (event === 'chainChanged' && typeof data === 'string') {
      this.chainId = data;
      const n = parseInt(data, 16);
      if (Number.isFinite(n)) this.networkVersion = String(n);
    } else if (event === 'disconnect') {
      this.selectedAddress = null;
    }
  }
}

// EIP-6963 announce 도우미.
//
// 보안 — announce 이벤트는 provider 객체와 식별 정보(name/icon/rdns/uuid) 만 노출한다.
// 페이지가 announce 만 듣고 있다고 해서 계정 주소나 origin 이 누설되지는 않는다.
// 모든 EIP-1193 메서드(eth_requestAccounts 등)는 여전히 background 의 per-origin 동의를
// 거쳐야 한다. provider.chainId 와 networkVersion 만 정적 노출되며, 이는 우리가 지원하는
// 체인(TTL=7777) 의 상수일 뿐이라 노출되어도 무방하다.
function announceEip6963(provider: ByeorinInpageProvider): void {
  const info = Object.freeze({
    uuid: EIP6963_UUID,
    name: BRAND_NAME,
    icon: ICON_DATA_URL,
    rdns: EIP6963_RDNS,
  });
  const detail = Object.freeze({ info, provider });
  try {
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', { detail }),
    );
  } catch {
    // 일부 페이지에서 CustomEvent 미지원 시 무시.
  }
}

export default defineUnlistedScript(() => {
  const provider = new ByeorinInpageProvider();

  // EIP-6963: 자기 announce 및 dApp 의 requestProvider 에 대한 응답.
  announceEip6963(provider);
  window.addEventListener('eip6963:requestProvider', () => announceEip6963(provider));

  // window.byeorin — 브랜드 별칭은 우리 namespace 이므로 고정 가능.
  try {
    Object.defineProperty(window, 'byeorin', {
      value: provider,
      writable: false,
      configurable: false,
    });
  } catch {
    // 재선언 시도 무시.
  }

  // EIP-1193 표준 슬롯: 다른 지갑(MetaMask 등)이 이미 점유했다면 건드리지 않는다.
  // 점유돼 있지 않더라도 200ms 정도 양보해 다른 지갑이 announce 할 기회를 준다.
  // H2 fix: configurable: true 로 설정해 후속 지갑이 덮어쓸 수 있게 한다(공존성).
  const claimEthereumSlot = (): void => {
    const w = window as unknown as { ethereum?: unknown };
    if (w.ethereum) return;
    try {
      Object.defineProperty(window, 'ethereum', {
        value: provider,
        writable: true,
        configurable: true,
      });
    } catch {
      // freeze 등 실패 시 무시 — EIP-6963 경로로 발견 가능.
    }
  };

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () => {
      setTimeout(claimEthereumSlot, 200);
    }, { once: true });
  } else {
    setTimeout(claimEthereumSlot, 200);
  }

  // 즉시 호출 dApp(부팅 시 ethereum 을 동기적으로 찾는 케이스) 대응: 비어있다면 일단 즉시 채워둔다.
  // 단, configurable: true 이므로 나중에 MetaMask 가 덮어써도 무방하다.
  if (!(window as unknown as { ethereum?: unknown }).ethereum) {
    try {
      Object.defineProperty(window, 'ethereum', {
        value: provider,
        writable: true,
        configurable: true,
      });
    } catch {
      /* noop */
    }
  }

  window.dispatchEvent(new Event('ethereum#initialized'));

  // EIP-1193: provider 가 RPC 처리 준비를 마치면 'connect' 이벤트를 발사해야 한다.
  // chainId 가 이미 eager 노출돼 있으므로 listener 가 등록되기 *전* 발사되어도
  // 동기 property 로 안전하게 fallback 가능. setTimeout(0) 으로 dApp 의
  // ethereum#initialized 핸들러가 먼저 on('connect',...) 을 걸 기회를 준다.
  setTimeout(() => provider.emit('connect', { chainId: provider.chainId }), 0);
});
