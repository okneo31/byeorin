import { defineBackground } from 'wxt/sandbox';
import { TTL_CHAIN } from '@nodong/wallet-sdk';
import { getActiveAccount, getTtlAdapter } from '../src/lib/wallet-service.js';
import {
  RPC_ERRORS,
  type BackgroundMessage,
  type ConnectContext,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from '../src/lib/rpc.js';
import {
  approveOrigin,
  isOriginApproved,
  normalizeOrigin,
} from '../src/lib/origins.js';

// 노동자의 지갑 백그라운드 서비스 워커.
// dApp 으로부터 들어오는 EIP-1193 RPC 를 SDK 로 라우팅한다.
//
// C1 fix: eth_requestAccounts 는 origin 별 명시적 사용자 동의를 요구한다.
//  - origin allowlist 는 chrome.storage.local('nd:approved-origins') 에만 저장.
//  - !!! 니모닉/세션은 절대 local 에 저장하지 않는다(session 전용). !!!

type PendingConnect = {
  origin: string;
  address: string;
  resolve: (decision: 'approve' | 'reject') => void;
  windowId?: number;
  timeout: ReturnType<typeof setTimeout>;
};

// requestId -> pending connect 슬롯.
const pendingConnects = new Map<string, PendingConnect>();

// 연결 동의 popup 의 유효 시한(분 단위). 시간 초과 시 자동 reject 처리.
const CONNECT_TIMEOUT_MS = 2 * 60 * 1000;

export default defineBackground({
  type: 'module',
  main() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      const m = msg as BackgroundMessage | JsonRpcRequest;

      // 구분: BackgroundMessage 는 'type' 필드를 가짐. JsonRpcRequest 는 'method' 필드를 가짐.
      // (하위 호환을 위해 raw JsonRpcRequest 도 받아들이지만, content.ts 는 항상 {type:'rpc'} 로 감싼다.)
      if (m && typeof (m as BackgroundMessage).type === 'string') {
        const bm = m as BackgroundMessage;
        if (bm.type === 'rpc') {
          handleRpc(bm.payload, sender)
            .then(sendResponse)
            .catch((err) => {
              sendResponse({
                id: bm.payload?.id ?? 0,
                error: { code: RPC_ERRORS.INTERNAL.code, message: String(err?.message ?? err) },
              } satisfies JsonRpcResponse);
            });
          return true;
        }
        if (bm.type === 'connect-result') {
          handleConnectResult(bm.requestId, bm.decision);
          sendResponse({ ok: true });
          return false;
        }
        if (bm.type === 'connect-context-get') {
          const ctx = pendingConnects.get(bm.requestId);
          const out: ConnectContext | null = ctx
            ? { requestId: bm.requestId, origin: ctx.origin, address: ctx.address }
            : null;
          sendResponse(out);
          return false;
        }
      } else {
        // 레거시: raw JsonRpcRequest
        handleRpc(m as JsonRpcRequest, sender)
          .then(sendResponse)
          .catch((err) => {
            sendResponse({
              id: (m as JsonRpcRequest)?.id ?? 0,
              error: { code: RPC_ERRORS.INTERNAL.code, message: String(err?.message ?? err) },
            } satisfies JsonRpcResponse);
          });
        return true;
      }
      return false;
    });
  },
});

function senderOrigin(sender: chrome.runtime.MessageSender): string | null {
  // MV3: sender.origin 이 우선(Chrome ≥ 80). 폴백으로 sender.url 의 origin.
  const o = (sender as { origin?: string }).origin;
  if (o) return normalizeOrigin(o);
  if (sender.url) return normalizeOrigin(sender.url);
  return null;
}

async function handleRpc(
  req: JsonRpcRequest,
  sender: chrome.runtime.MessageSender,
): Promise<JsonRpcResponse> {
  const ok = (result: unknown): JsonRpcResponse => ({ id: req.id, result });
  const fail = (code: number, message: string): JsonRpcResponse => ({
    id: req.id,
    error: { code, message },
  });

  switch (req.method) {
    // --- 읽기 전용: 동기적으로 처리 가능 -----------------------------
    case 'eth_chainId': {
      // TTL = 7777 = 0x1e61
      return ok('0x' + TTL_CHAIN.id.toString(16));
    }

    case 'net_version': {
      return ok(String(TTL_CHAIN.id));
    }

    case 'eth_accounts': {
      // EIP-1193: 미연결/잠금 상태에서는 에러가 아니라 빈 배열을 반환.
      const origin = senderOrigin(sender);
      if (!origin) return ok([]);
      const acc = await getActiveAccount();
      if (!acc) return ok([]);
      const approved = await isOriginApproved(origin);
      if (!approved) return ok([]);
      return ok([acc.address]);
    }

    case 'eth_blockNumber': {
      const adapter = getTtlAdapter();
      // EvmAdapter 내부 client 는 private — 스켈레톤 단계에서는 SDK 외부에 노출되지 않아 미구현.
      // TODO(v0.2): SDK 에 readonly RPC passthrough (eth_call/eth_blockNumber 등) 헬퍼 추가.
      void adapter;
      return fail(RPC_ERRORS.UNSUPPORTED.code, RPC_ERRORS.UNSUPPORTED.message);
    }

    // --- 사용자 확인 필요: popup 띄우고 결과 받기 ----------------------
    case 'eth_requestAccounts': {
      const origin = senderOrigin(sender);
      if (!origin) {
        return fail(RPC_ERRORS.UNAUTHORIZED.code, '요청 출처(origin)를 식별할 수 없습니다');
      }

      const acc = await getActiveAccount();
      if (!acc) {
        // 잠금 상태 — EIP-1193 에러 코드 4100.
        return fail(RPC_ERRORS.UNAUTHORIZED.code, '지갑 잠금 상태입니다');
      }

      // 이미 승인된 origin 이면 popup 없이 즉시 반환.
      if (await isOriginApproved(origin)) {
        return ok([acc.address]);
      }

      // 새 origin: 사용자 동의 popup 띄움.
      const decision = await requestUserConsent(origin, acc.address);
      if (decision === 'approve') {
        await approveOrigin(origin);
        return ok([acc.address]);
      }
      return fail(RPC_ERRORS.USER_REJECTED.code, RPC_ERRORS.USER_REJECTED.message);
    }

    case 'wallet_addEthereumChain': {
      // TTL 외 체인은 거부 — 본 확장은 TTL 전용.
      const params = Array.isArray(req.params) ? req.params : [];
      const first = params[0] as { chainId?: string } | undefined;
      const cid = first?.chainId ?? '';
      const expected = '0x' + TTL_CHAIN.id.toString(16);
      if (cid.toLowerCase() !== expected.toLowerCase()) {
        return fail(RPC_ERRORS.INVALID_PARAMS.code, 'TTL 체인만 지원합니다 (chainId=7777)');
      }
      return ok(null);
    }

    case 'wallet_switchEthereumChain': {
      const params = Array.isArray(req.params) ? req.params : [];
      const first = params[0] as { chainId?: string } | undefined;
      const cid = first?.chainId ?? '';
      const expected = '0x' + TTL_CHAIN.id.toString(16);
      if (cid.toLowerCase() !== expected.toLowerCase()) {
        return fail(RPC_ERRORS.INVALID_PARAMS.code, 'TTL 체인만 지원합니다');
      }
      return ok(null);
    }

    case 'personal_sign': {
      // TODO(v0.2): popup confirm + SoftSigner.sign 으로 personal_sign 메시지 해시 서명.
      return fail(RPC_ERRORS.UNSUPPORTED.code, 'personal_sign 미구현 (v0.2 예정)');
    }

    case 'eth_sendTransaction': {
      // TODO(v0.2): popup confirm 후 Wallet.transfer 로 전송.
      return fail(RPC_ERRORS.UNSUPPORTED.code, 'eth_sendTransaction 미구현 (v0.2 예정)');
    }

    case 'eth_signTypedData_v4': {
      return fail(RPC_ERRORS.UNSUPPORTED.code, 'eth_signTypedData_v4 미구현');
    }

    default:
      return fail(RPC_ERRORS.UNSUPPORTED.code, `메서드 미지원: ${req.method}`);
  }
}

// ── 사용자 동의 popup 흐름 ────────────────────────────────────────────
// 1) requestId 발급 → pendingConnects 에 등록
// 2) chrome.windows.create 로 connect.html 띄움
// 3) connect 화면이 background 에 'connect-context-get' 으로 컨텍스트 조회
// 4) 사용자가 Approve/Reject → 'connect-result' 메시지로 결과 전송
// 5) handleConnectResult 가 pendingConnects 슬롯의 Promise 를 resolve
// 6) 미응답 상태로 일정 시간 경과 시 timeout 으로 'reject'.

function makeRequestId(): string {
  // crypto.randomUUID 가 service worker 에서도 사용 가능(Chrome ≥ 92).
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // 폴백
  return 'req-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
}

function requestUserConsent(origin: string, address: string): Promise<'approve' | 'reject'> {
  return new Promise<'approve' | 'reject'>((resolve) => {
    const requestId = makeRequestId();
    const timeout = setTimeout(() => {
      const slot = pendingConnects.get(requestId);
      if (!slot) return;
      pendingConnects.delete(requestId);
      try {
        if (slot.windowId != null) chrome.windows.remove(slot.windowId);
      } catch {
        /* noop */
      }
      resolve('reject');
    }, CONNECT_TIMEOUT_MS);

    const slot: PendingConnect = { origin, address, resolve, timeout };
    pendingConnects.set(requestId, slot);

    const url =
      chrome.runtime.getURL('connect.html') +
      '?origin=' + encodeURIComponent(origin) +
      '&requestId=' + encodeURIComponent(requestId);

    chrome.windows.create(
      { url, type: 'popup', width: 400, height: 600 },
      (win) => {
        if (chrome.runtime.lastError || !win) {
          // popup 생성 실패: 즉시 reject 처리.
          clearTimeout(timeout);
          pendingConnects.delete(requestId);
          resolve('reject');
          return;
        }
        slot.windowId = win.id;
      },
    );

    // popup 이 닫혀버린(사용자가 X 클릭) 경우에도 reject 로 마무리.
    const onRemoved = (winId: number): void => {
      const cur = pendingConnects.get(requestId);
      if (!cur || cur.windowId !== winId) return;
      pendingConnects.delete(requestId);
      clearTimeout(cur.timeout);
      chrome.windows.onRemoved.removeListener(onRemoved);
      resolve('reject');
    };
    chrome.windows.onRemoved.addListener(onRemoved);
  });
}

function handleConnectResult(requestId: string, decision: 'approve' | 'reject'): void {
  const slot = pendingConnects.get(requestId);
  if (!slot) return;
  pendingConnects.delete(requestId);
  clearTimeout(slot.timeout);
  if (slot.windowId != null) {
    try {
      chrome.windows.remove(slot.windowId);
    } catch {
      /* noop */
    }
  }
  slot.resolve(decision);
}
