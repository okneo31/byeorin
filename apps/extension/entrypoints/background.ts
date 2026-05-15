import { defineBackground } from 'wxt/sandbox';
import {
  bytesToHex,
  concat,
  hexToBytes,
  isHex,
  keccak256,
  stringToBytes,
  type Hex,
} from 'viem';
import { TTL_CHAIN } from '@nodong/wallet-sdk';
import { getActiveAccount, getTtlAdapter, walletStore } from '../src/lib/wallet-service.js';
import {
  RPC_ERRORS,
  type BackgroundMessage,
  type ConfirmContext,
  type ConnectContext,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type PersonalSignConfirmContext,
  type SendTxConfirmContext,
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
  // 보안: popup URL 에 동봉되는 1회용 nonce. dApp 이 connect.html 을 직접 열어 우회하려 해도
  // nonce 를 알 수 없으므로 context 조회/결과 전송이 모두 거부된다.
  nonce: string;
  resolve: (decision: 'approve' | 'reject') => void;
  windowId?: number;
  timeout: ReturnType<typeof setTimeout>;
};

// requestId -> pending connect 슬롯.
const pendingConnects = new Map<string, PendingConnect>();

// 연결 동의 popup 의 유효 시한(분 단위). 시간 초과 시 자동 reject 처리.
const CONNECT_TIMEOUT_MS = 2 * 60 * 1000;

// 서명/전송 확인 popup 슬롯. ConfirmContext 자체를 들고 있고, 결과만 Promise 로 해소.
type PendingConfirm = {
  context: ConfirmContext;
  // 보안: connect 와 동일한 nonce 검증 메커니즘.
  nonce: string;
  resolve: (decision: 'approve' | 'reject') => void;
  windowId?: number;
  timeout: ReturnType<typeof setTimeout>;
};

const pendingConfirms = new Map<string, PendingConfirm>();

// personal_sign / eth_sendTransaction 동의 popup 유효 시한. connect 와 동일하게 2분.
const CONFIRM_TIMEOUT_MS = 2 * 60 * 1000;

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
          // RPC 는 content script(=웹 페이지에 주입된) 에서 온다 — sender.id 는 본 확장이며 sender.tab 이 존재.
          // 본 분기에서는 sender.id 검증 후, senderOrigin 으로 dApp origin 을 산출한다.
          if (sender.id !== chrome.runtime.id) {
            sendResponse({
              id: bm.payload?.id ?? 0,
              error: { code: RPC_ERRORS.UNAUTHORIZED.code, message: '미인증 발신자' },
            } satisfies JsonRpcResponse);
            return false;
          }
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
        // 이하 connect/confirm 메시지는 우리 확장의 popup(connect.html / confirm.html) 에서만 와야 한다.
        // sender.id 는 항상 본 확장의 id 이어야 하며(외부 확장 격리), nonce 도 일치해야 한다.
        if (sender.id !== chrome.runtime.id) {
          sendResponse(null);
          return false;
        }
        if (bm.type === 'connect-result') {
          handleConnectResult(bm.requestId, bm.nonce, bm.decision);
          sendResponse({ ok: true });
          return false;
        }
        if (bm.type === 'connect-context-get') {
          const ctx = pendingConnects.get(bm.requestId);
          // nonce 가 일치하지 않으면(또는 슬롯이 없으면) 컨텍스트를 노출하지 않는다.
          // dApp 이 chrome-extension://<id>/connect.html?requestId=... 을 직접 연 경우의 핵심 차단점.
          const out: ConnectContext | null =
            ctx && ctx.nonce === bm.nonce
              ? { requestId: bm.requestId, origin: ctx.origin, address: ctx.address }
              : null;
          sendResponse(out);
          return false;
        }
        if (bm.type === 'confirm-result') {
          handleConfirmResult(bm.requestId, bm.nonce, bm.decision);
          sendResponse({ ok: true });
          return false;
        }
        if (bm.type === 'confirm-context-get') {
          const slot = pendingConfirms.get(bm.requestId);
          sendResponse(slot && slot.nonce === bm.nonce ? slot.context : null);
          return false;
        }
      } else {
        // 레거시: raw JsonRpcRequest. content script 경유 외에는 신뢰하지 않는다.
        if (sender.id !== chrome.runtime.id) {
          sendResponse({
            id: (m as JsonRpcRequest)?.id ?? 0,
            error: { code: RPC_ERRORS.UNAUTHORIZED.code, message: '미인증 발신자' },
          } satisfies JsonRpcResponse);
          return false;
        }
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

    // SW 종료 안전망 — 휴면 직전 모든 대기 슬롯을 reject 한다.
    // MV3 service worker 는 짧게 살므로 popup 미응답 상태에서 SW 가 잠들면
    // pending Promise 가 영영 해소되지 않는다(=dApp 요청이 hang).
    // onSuspend 는 모든 환경에서 보장되지는 않으나, 보장되는 경우 깔끔히 거절한다.
    // (보장되지 않는 경우에도, 재기동 시 메모리는 비어있어 새 요청은 정상 흐름을 탄다.)
    chrome.runtime.onSuspend.addListener(() => {
      rejectAllPending('SW 종료로 인한 요청 취소');
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
      // EIP-191 prefixed signing. params 순서는 [messageHex, address] (MetaMask 규약 — eth_sign 과 반대).
      const params = Array.isArray(req.params) ? req.params : [];
      const a = params[0];
      const b = params[1];
      if (typeof a !== 'string' || typeof b !== 'string') {
        return fail(RPC_ERRORS.INVALID_PARAMS.code, 'personal_sign 파라미터 형식 오류');
      }
      // 일부 dApp 은 (address, message) 순서로 보내므로 휴리스틱으로 보정.
      // - 둘 다 hex 인 경우: 더 짧은(20바이트=42자) 쪽을 address 로 간주.
      // - 한쪽만 hex 인 경우: hex 가 message, 다른 쪽이 address.
      let messageHex: string;
      let claimedAddress: string;
      const aIsAddr = /^0x[0-9a-fA-F]{40}$/.test(a);
      const bIsAddr = /^0x[0-9a-fA-F]{40}$/.test(b);
      if (aIsAddr && !bIsAddr) {
        // (address, message) 순서
        claimedAddress = a;
        messageHex = b;
      } else {
        // 표준: (message, address)
        messageHex = a;
        claimedAddress = b;
      }
      if (!isHex(messageHex)) {
        return fail(RPC_ERRORS.INVALID_PARAMS.code, '메시지 hex 가 아닙니다');
      }

      const origin = senderOrigin(sender);
      if (!origin || !(await isOriginApproved(origin))) {
        return fail(RPC_ERRORS.UNAUTHORIZED.code, '연결되지 않은 dApp');
      }
      if (!walletStore.isUnlocked()) {
        // tryAutoRestore 는 getActiveAccount 가 수행하므로 여기까지 와서 false 라면 진짜 잠금.
        const acc0 = await getActiveAccount();
        if (!acc0) return fail(RPC_ERRORS.UNAUTHORIZED.code, '지갑 잠금 상태입니다');
      }
      const acc = await getActiveAccount();
      if (!acc) return fail(RPC_ERRORS.UNAUTHORIZED.code, '지갑 잠금 상태입니다');
      if (claimedAddress.toLowerCase() !== acc.address.toLowerCase()) {
        return fail(RPC_ERRORS.INVALID_PARAMS.code, '주소 불일치');
      }

      // 메시지 디코드 시도 — popup 에서 텍스트로도 보여줄 수 있도록 컨텍스트에 동봉.
      let messageUtf8: string | null = null;
      try {
        const bytes = hexToBytes(messageHex as Hex);
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        // 출력 가능 문자만 허용(개행/탭/CR 예외).
        let printable = true;
        for (let i = 0; i < decoded.length; i++) {
          const c = decoded.charCodeAt(i);
          if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) {
            printable = false;
            break;
          }
        }
        if (printable) messageUtf8 = decoded;
      } catch {
        messageUtf8 = null;
      }

      const context: PersonalSignConfirmContext = {
        requestId: '', // openConfirm 내부에서 할당
        method: 'personal_sign',
        origin,
        address: acc.address,
        message: messageHex,
        messageUtf8,
      };
      const decision = await openConfirm(context);
      if (decision !== 'approve') {
        return fail(RPC_ERRORS.USER_REJECTED.code, RPC_ERRORS.USER_REJECTED.message);
      }

      // EIP-191: keccak256("\x19Ethereum Signed Message:\n" + len + message)
      const msgBytes = hexToBytes(messageHex as Hex);
      const prefix = stringToBytes(`\x19Ethereum Signed Message:\n${msgBytes.length}`);
      const digestHex = keccak256(concat([prefix, msgBytes]));
      const sig = await acc.signer.sign(hexToBytes(digestHex));
      if (sig.length !== 65) {
        return fail(RPC_ERRORS.INTERNAL.code, '서명 길이 오류');
      }
      // SoftSigner 출력: r(32) || s(32) || recovery(1)  →  EIP-191 은 v ∈ {27, 28}.
      const r = sig.subarray(0, 32);
      const s = sig.subarray(32, 64);
      const recovery = sig[64]!;
      const v = recovery + 27;
      const sigHex =
        '0x' +
        bytesToHex(r).slice(2) +
        bytesToHex(s).slice(2) +
        v.toString(16).padStart(2, '0');
      return ok(sigHex);
    }

    case 'eth_sendTransaction': {
      const params = Array.isArray(req.params) ? req.params : [];
      const tx = params[0] as
        | {
            from?: string;
            to?: string;
            value?: string;
            data?: string;
            gas?: string;
            gasPrice?: string;
            maxFeePerGas?: string;
            maxPriorityFeePerGas?: string;
            nonce?: string;
            chainId?: string;
          }
        | undefined;
      if (!tx || typeof tx !== 'object') {
        return fail(RPC_ERRORS.INVALID_PARAMS.code, 'eth_sendTransaction 파라미터 누락');
      }

      const origin = senderOrigin(sender);
      if (!origin || !(await isOriginApproved(origin))) {
        return fail(RPC_ERRORS.UNAUTHORIZED.code, '연결되지 않은 dApp');
      }
      const acc = await getActiveAccount();
      if (!acc) return fail(RPC_ERRORS.UNAUTHORIZED.code, '지갑 잠금 상태입니다');
      if (tx.from && tx.from.toLowerCase() !== acc.address.toLowerCase()) {
        return fail(RPC_ERRORS.INVALID_PARAMS.code, 'from 주소 불일치');
      }
      if (!tx.to || typeof tx.to !== 'string') {
        return fail(RPC_ERRORS.INVALID_PARAMS.code, 'to 주소 누락');
      }

      // chainId 가드 — 명시되었다면 TTL(7777) 이어야 한다.
      // v0.2 정책: chainId 미지정 시 TTL 로 간주한다 — 본 확장은 단일 체인(TTL) 전용이므로 안전.
      // TODO(v0.3): 멀티체인 도입 시, chainId 미지정 요청은 "현재 활성 체인" 으로 라우팅하되
      // dApp 이 명시적 chainId 를 보내도록 유도하는 경고를 confirm popup 에 표시한다.
      if (tx.chainId) {
        let cid: number;
        try {
          cid = parseInt(tx.chainId, 16);
        } catch {
          return fail(RPC_ERRORS.INVALID_PARAMS.code, `잘못된 chainId: ${tx.chainId}`);
        }
        if (!Number.isFinite(cid) || cid !== TTL_CHAIN.id) {
          return fail(RPC_ERRORS.INVALID_PARAMS.code, `지원하지 않는 chainId: ${tx.chainId}`);
        }
      }

      // 계약 호출(0x 이외의 data) 은 v0.3 으로 연기.
      const dataHex = tx.data ?? '0x';
      if (dataHex !== '0x' && dataHex !== '') {
        return fail(RPC_ERRORS.UNSUPPORTED.code, '계약 호출(data)은 v0.3 예정');
      }

      const valueHex = tx.value ?? '0x0';
      let valueWei: bigint;
      try {
        valueWei = BigInt(valueHex);
      } catch {
        return fail(RPC_ERRORS.INVALID_PARAMS.code, '잘못된 value');
      }
      if (valueWei < 0n) {
        return fail(RPC_ERRORS.INVALID_PARAMS.code, 'value 음수');
      }

      const context: SendTxConfirmContext = {
        requestId: '', // openConfirm 내부에서 할당
        method: 'eth_sendTransaction',
        origin,
        from: acc.address,
        to: tx.to,
        value: valueHex,
        data: dataHex,
        gas: tx.gas ?? null,
        gasPrice: tx.gasPrice ?? null,
        maxFeePerGas: tx.maxFeePerGas ?? null,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? null,
        nonce: tx.nonce ?? null,
        chainId: tx.chainId ?? null,
      };
      const decision = await openConfirm(context);
      if (decision !== 'approve') {
        return fail(RPC_ERRORS.USER_REJECTED.code, RPC_ERRORS.USER_REJECTED.message);
      }

      try {
        const txHash = await walletStore.transfer({ to: tx.to, amount: valueWei });
        return ok(txHash);
      } catch (err) {
        return fail(RPC_ERRORS.INTERNAL.code, `전송 실패: ${(err as Error)?.message ?? err}`);
      }
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

/**
 * popup 접근을 검증하기 위한 1회용 nonce.
 * crypto.getRandomValues 로 16바이트(=128bit) 무작위, hex 32자.
 * dApp 이 chrome-extension://<id>/{connect,confirm}.html?requestId=... 를 직접 열어 우회 시
 * URL 의 nonce 가 일치해야만 context 조회/결정 전송이 허용된다.
 */
function makeNonce(): string {
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    let hex = '';
    for (let i = 0; i < buf.length; i++) {
      hex += buf[i]!.toString(16).padStart(2, '0');
    }
    return hex;
  }
  // 폴백 — crypto 가 없으면 약하지만 randomUUID 로 대체.
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** SW 종료 등 비정상 경로에서 모든 대기 슬롯을 reject. */
function rejectAllPending(reason: string): void {
  for (const [, slot] of pendingConnects) {
    clearTimeout(slot.timeout);
    try {
      if (slot.windowId != null) chrome.windows.remove(slot.windowId);
    } catch {
      /* noop */
    }
    slot.resolve('reject');
  }
  pendingConnects.clear();
  for (const [, slot] of pendingConfirms) {
    clearTimeout(slot.timeout);
    try {
      if (slot.windowId != null) chrome.windows.remove(slot.windowId);
    } catch {
      /* noop */
    }
    slot.resolve('reject');
  }
  pendingConfirms.clear();
  // 명시적으로 reason 을 로깅(개발자 도구) — 외부에 노출되지 않음.
  console.warn('[nodong] pending 요청 정리:', reason);
}

function requestUserConsent(origin: string, address: string): Promise<'approve' | 'reject'> {
  return new Promise<'approve' | 'reject'>((resolve) => {
    const requestId = makeRequestId();
    const nonce = makeNonce();
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

    const slot: PendingConnect = { origin, address, nonce, resolve, timeout };
    pendingConnects.set(requestId, slot);

    // nonce 를 URL 에 동봉. popup 은 이 값을 그대로 message 에 실어 background 로 보낸다.
    const url =
      chrome.runtime.getURL('connect.html') +
      '?origin=' + encodeURIComponent(origin) +
      '&requestId=' + encodeURIComponent(requestId) +
      '&nonce=' + encodeURIComponent(nonce);

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

function handleConnectResult(
  requestId: string,
  nonce: string,
  decision: 'approve' | 'reject',
): void {
  const slot = pendingConnects.get(requestId);
  if (!slot) return;
  // 보안: nonce 불일치 시 결과를 무시. 어떤 슬롯도 종료하지 않는다(우회 시도 차단).
  if (slot.nonce !== nonce) return;
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

// ── 서명/전송 확인 popup 흐름 ──────────────────────────────────────────
// connect 흐름과 동일한 패턴: requestId 발급 → pendingConfirms 슬롯 → popup → 결과 메시지 → resolve.
// 차이: 컨텍스트 자체(ConfirmContext)를 슬롯에 저장해 confirm-context-get 응답으로 그대로 돌려준다.
//
// 정책(v0.2):
//  - "1시간 기억" 같은 origin 별 자동 승인은 제공하지 않는다(악용 방지). 매 호출마다 사용자 동의.
//  - timeout(2분) 경과 시 또는 사용자가 popup 을 직접 닫으면 자동 reject.

function openConfirm(ctxInput: ConfirmContext): Promise<'approve' | 'reject'> {
  return new Promise<'approve' | 'reject'>((resolve) => {
    const requestId = makeRequestId();
    const nonce = makeNonce();
    const context: ConfirmContext = { ...ctxInput, requestId };

    const timeout = setTimeout(() => {
      const slot = pendingConfirms.get(requestId);
      if (!slot) return;
      pendingConfirms.delete(requestId);
      try {
        if (slot.windowId != null) chrome.windows.remove(slot.windowId);
      } catch {
        /* noop */
      }
      resolve('reject');
    }, CONFIRM_TIMEOUT_MS);

    const slot: PendingConfirm = { context, nonce, resolve, timeout };
    pendingConfirms.set(requestId, slot);

    const url =
      chrome.runtime.getURL('confirm.html') +
      '?requestId=' + encodeURIComponent(requestId) +
      '&nonce=' + encodeURIComponent(nonce);

    chrome.windows.create(
      { url, type: 'popup', width: 420, height: 640 },
      (win) => {
        if (chrome.runtime.lastError || !win) {
          clearTimeout(timeout);
          pendingConfirms.delete(requestId);
          resolve('reject');
          return;
        }
        slot.windowId = win.id;
      },
    );

    const onRemoved = (winId: number): void => {
      const cur = pendingConfirms.get(requestId);
      if (!cur || cur.windowId !== winId) return;
      pendingConfirms.delete(requestId);
      clearTimeout(cur.timeout);
      chrome.windows.onRemoved.removeListener(onRemoved);
      resolve('reject');
    };
    chrome.windows.onRemoved.addListener(onRemoved);
  });
}

function handleConfirmResult(
  requestId: string,
  nonce: string,
  decision: 'approve' | 'reject',
): void {
  const slot = pendingConfirms.get(requestId);
  if (!slot) return;
  if (slot.nonce !== nonce) return;
  pendingConfirms.delete(requestId);
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
