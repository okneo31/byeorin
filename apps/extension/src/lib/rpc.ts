// EIP-1193 ↔ extension messaging contract.
//
// Page (inpage) ──postMessage──▶ content script ──chrome.runtime.sendMessage──▶ background
//                                                                                 │
// Page (inpage) ◀──postMessage── content script ◀──sendResponse──────────────────┘
//
// All RPC payloads are JSON-RPC-style { id, method, params }.

export const NODONG_MSG_TAG = 'nodong-wallet';

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
  | { tag: typeof NODONG_MSG_TAG; dir: 'page-to-cs'; payload: JsonRpcRequest }
  | { tag: typeof NODONG_MSG_TAG; dir: 'cs-to-page'; payload: JsonRpcResponse }
  | { tag: typeof NODONG_MSG_TAG; dir: 'cs-to-page-event'; event: string; data?: unknown };

// content script 가 background 로 전달하는 RPC 메시지.
// background 는 sender.origin 또는 sender.url 에서 origin 을 산출한다(MV3 sender 객체).
export type BackgroundMessage =
  | { type: 'rpc'; payload: JsonRpcRequest }
  | { type: 'connect-result'; requestId: string; decision: 'approve' | 'reject' }
  | { type: 'connect-context-get'; requestId: string };

export type ConnectContext = {
  requestId: string;
  origin: string;
  address: string;
};

export const RPC_ERRORS = {
  USER_REJECTED: { code: 4001, message: '사용자가 요청을 거부했습니다' },
  UNAUTHORIZED: { code: 4100, message: '인증되지 않은 요청' },
  UNSUPPORTED: { code: 4200, message: '구현되지 않은 메서드' },
  CHAIN_DISCONNECTED: { code: 4901, message: '체인 연결 끊김' },
  INVALID_PARAMS: { code: -32602, message: '잘못된 파라미터' },
  INTERNAL: { code: -32603, message: '내부 오류' },
} as const;
