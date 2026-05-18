// EIP-1193 ↔ extension messaging contract.
//
// Page (inpage) ──postMessage──▶ content script ──chrome.runtime.sendMessage──▶ background
//                                                                                 │
// Page (inpage) ◀──postMessage── content script ◀──sendResponse──────────────────┘
//
// All RPC payloads are JSON-RPC-style { id, method, params }.

export const BYEORIN_MSG_TAG = 'byeorin-wallet';

export type JsonRpcRequest = {
  id: number;
  method: string;
  params?: unknown[] | Record<string, unknown>;
};

export type JsonRpcSuccess = {
  id: number;
  result: unknown;
};

export type JsonRpcError = {
  id: number;
  error: { code: number; message: string; data?: unknown };
};

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

// Window message envelope between inpage <-> content script.
export type WindowEnvelope =
  | { tag: typeof BYEORIN_MSG_TAG; dir: 'page-to-cs'; payload: JsonRpcRequest }
  | { tag: typeof BYEORIN_MSG_TAG; dir: 'cs-to-page'; payload: JsonRpcResponse }
  | { tag: typeof BYEORIN_MSG_TAG; dir: 'cs-to-page-event'; event: string; data?: unknown };

// content script 가 background 로 전달하는 RPC 메시지.
// background 는 sender.origin 또는 sender.url 에서 origin 을 산출한다(MV3 sender 객체).
//
// 보안 — connect/confirm 메시지는 모두 background 가 popup 을 띄울 때 발급한 nonce 를 동반한다.
// dApp 이 직접 chrome-extension://<id>/connect.html?requestId=... 을 열어 우회 시도할 경우,
// nonce 가 없거나 일치하지 않으므로 context 조회가 실패한다.
export type BackgroundMessage =
  | { type: 'rpc'; payload: JsonRpcRequest }
  | { type: 'connect-result'; requestId: string; nonce: string; decision: 'approve' | 'reject' }
  | { type: 'connect-context-get'; requestId: string; nonce: string }
  | {
      type: 'confirm-result';
      requestId: string;
      nonce: string;
      decision: 'approve' | 'reject';
      // 사용자가 confirm popup 에서 "이 사이트에서 1시간 동안 자동 승인" 을 체크했는지.
      // background 는 decision==='approve' 이고 본 필드가 true 일 때만 grant 를 발급한다.
      rememberFor1h?: boolean;
    }
  | { type: 'confirm-context-get'; requestId: string; nonce: string };

export type ConnectContext = {
  requestId: string;
  origin: string;
  address: string;
};

/**
 * personal_sign 확인 popup 컨텍스트.
 * message 는 dApp 이 보낸 hex 문자열, messageUtf8 은 UTF-8 디코딩이 가능했을 때만 채워진다.
 */
export type PersonalSignConfirmContext = {
  requestId: string;
  method: 'personal_sign';
  origin: string;
  address: string;
  message: string;
  messageUtf8: string | null;
};

/**
 * eth_sendTransaction 확인 popup 컨텍스트.
 * 모든 수치 필드는 dApp 이 보낸 hex 그대로(0x… ) — UI 가 표시 직전 viem 으로 파싱한다.
 * gas/gasPrice/fee 는 적용 가능한 값만 채운다(레거시 vs EIP-1559 혼합 가능).
 */
export type SendTxConfirmContext = {
  requestId: string;
  method: 'eth_sendTransaction';
  origin: string;
  from: string;
  to: string;
  value: string;            // hex wei (e.g. '0x0', '0xde0b6b3a7640000')
  data: string;             // hex (빈 호출은 '0x')
  gas: string | null;       // hex 또는 null(추정 미수행)
  gasPrice: string | null;
  maxFeePerGas: string | null;
  maxPriorityFeePerGas: string | null;
  nonce: string | null;
  chainId: string | null;
};

/**
 * EIP-712 typed data 의 domain 부분. spec 상 모든 필드가 옵셔널이므로 ?-로 받는다.
 * salt 는 32바이트 hex(있다면) — 그대로 표시한다.
 */
export type EIP712Domain = {
  name?: string;
  version?: string;
  chainId?: number | string;
  verifyingContract?: string;
  salt?: string;
};

/**
 * eth_signTypedData_v4 확인 popup 컨텍스트.
 * - domain: 원본 typedData.domain 그대로(요약은 UI 가 추출).
 * - typesJson: types 객체 직렬화(UI 가 옵셔널로 보여줌).
 * - primaryType: 서명 대상 root type 명.
 * - messageJson: typedData.message 의 pretty-printed JSON 문자열.
 * - digest: 0x… 32바이트 EIP-712 해시(viem.hashTypedData 결과). 사용자가 보고 검증 가능.
 */
export type SignTypedDataConfirmContext = {
  requestId: string;
  method: 'eth_signTypedData_v4';
  origin: string;
  address: string;
  domain: EIP712Domain;
  primaryType: string;
  typesJson: string;
  messageJson: string;
  digest: string;
};

/**
 * wallet_watchAsset 확인 popup 컨텍스트.
 *
 * EIP-747: dApp 이 ERC-20/721/1155 토큰을 본 지갑의 watch-list 에 등록 요청.
 * 본 컨텍스트는 popup 이 "어느 사이트가 어느 토큰을 어떤 심볼/소수자리로 추가하려는지"
 * 사용자에게 보여주기 위한 최소 정보만 담는다.
 *
 * 보안 메모:
 *  - `address` 필드는 ConfirmContext 공통 필드이지만 watch-asset 은 활성 계정에
 *    묶이지 않는 동작이므로 빈 문자열로 보낸다 — popup 은 이 메서드에서 address
 *    행을 그리지 않는다.
 *  - `tokenAddress` 는 메타데이터 검증 결과(EIP-55 체크섬 케이스) 와 무관하게
 *    dApp 이 보낸 raw 값을 그대로 사용자에게 노출한다 (스푸핑 인지 보조).
 *  - decimals 는 0..36 범위에서 자유. dApp 이 무리한 값을 보내면 background 가
 *    먼저 거절한다.
 */
export type WatchAssetConfirmContext = {
  requestId: string;
  method: 'wallet_watchAsset';
  origin: string;
  /** 공통 ConfirmContext shape 호환용 placeholder — 본 메서드에서는 사용되지 않는다. */
  address: string;
  /** 토큰 표준 (ERC20 / ERC721 / ERC1155). v0.3 는 ERC20 만 실질적으로 표시. */
  type: string;
  tokenAddress: string;
  symbol: string;
  decimals: number;
  image: string | null;
};

export type ConfirmContext =
  | PersonalSignConfirmContext
  | SendTxConfirmContext
  | SignTypedDataConfirmContext
  | WatchAssetConfirmContext;

export const RPC_ERRORS = {
  USER_REJECTED: { code: 4001, message: '사용자가 요청을 거부했습니다' },
  UNAUTHORIZED: { code: 4100, message: '인증되지 않은 요청' },
  UNSUPPORTED: { code: 4200, message: '구현되지 않은 메서드' },
  CHAIN_DISCONNECTED: { code: 4901, message: '체인 연결 끊김' },
  INVALID_PARAMS: { code: -32602, message: '잘못된 파라미터' },
  INTERNAL: { code: -32603, message: '내부 오류' },
} as const;
