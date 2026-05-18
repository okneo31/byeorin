import { defineBackground } from 'wxt/sandbox';
import {
  bytesToHex,
  hashTypedData,
  hexToBytes,
  isHex,
  type Hex,
} from 'viem';
// 좁은 subpath — background SW 는 EVM(TTL) 만 라우팅한다.
// wallet-sdk 의 메인 barrel 을 import 하면 cosmos/ton/xrp/... 까지 함께 끌려오므로
// background bundle 도 popup 과 같은 6MB chunk 에 공유돼 SW boot 가 무거워진다.
import { signEvmMessage, TTL_CHAIN } from '@byeorin/wallet-sdk/evm';
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
  type SignTypedDataConfirmContext,
  type WatchAssetConfirmContext,
  type EIP712Domain,
} from '../src/lib/rpc.js';
import {
  approveOrigin,
  isOriginApproved,
  normalizeOrigin,
} from '../src/lib/origins.js';
import { addGrant, hasGrant, type GrantMethod } from '../src/lib/grants.js';

// 벼린 백그라운드 서비스 워커.
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
type ConfirmDecision = { decision: 'approve' | 'reject'; rememberFor1h: boolean };

type PendingConfirm = {
  context: ConfirmContext;
  // 보안: connect 와 동일한 nonce 검증 메커니즘.
  nonce: string;
  resolve: (d: ConfirmDecision) => void;
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
          handleConfirmResult(bm.requestId, bm.nonce, bm.decision, bm.rememberFor1h === true);
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

    // --- 읽기 전용 RPC passthrough -----------------------------------
    // EvmAdapter 의 private `client` (viem PublicClient) 로 직접 위임. 잔액/블록/
    // 호출/가스 추정 등은 사용자 동의가 필요 없으므로 popup 없이 즉시 처리.
    // dApp 이 connected 상태(=origin approved)일 때만 응답한다 — 미연결 dApp 에
    // 게는 EIP-1193 보안 원칙대로 식별 가능한 정보를 노출하지 않는다.
    case 'eth_blockNumber':
    case 'eth_getBalance':
    case 'eth_call':
    case 'eth_estimateGas':
    case 'eth_getTransactionByHash':
    case 'eth_getTransactionReceipt': {
      const origin = senderOrigin(sender);
      if (!origin || !(await isOriginApproved(origin))) {
        return fail(RPC_ERRORS.UNAUTHORIZED.code, '연결되지 않은 dApp');
      }
      // EvmAdapter.client 는 private — TS 가 인터섹션을 never 로 좁히므로 unknown
      // 경유로 캐스팅한다. v0.3 readonly passthrough 가 사용 가능해질 때까지의
      // 임시 접근. (SDK 측 read-only 헬퍼가 노출되면 본 우회는 제거 가능.)
      const adapter = getTtlAdapter() as unknown as { client?: unknown };
      // viem PublicClient 의 메서드를 동적으로 부른다. 직접 import 하지 않고
      // adapter 의 private client 를 그대로 노출한다 — viem 클라이언트는 RPC 결과를
      // 표준 JSON-RPC hex 형식으로 반환하므로 EIP-1193 호환.
      type PC = {
        getBlockNumber(): Promise<bigint>;
        getBalance(args: { address: `0x${string}` }): Promise<bigint>;
        call(args: {
          to: `0x${string}`;
          data?: `0x${string}`;
          account?: `0x${string}`;
        }): Promise<{ data?: `0x${string}` }>;
        estimateGas(args: {
          to: `0x${string}`;
          data?: `0x${string}`;
          value?: bigint;
          account?: `0x${string}`;
        }): Promise<bigint>;
        getTransaction(args: { hash: `0x${string}` }): Promise<unknown>;
        getTransactionReceipt(args: { hash: `0x${string}` }): Promise<unknown>;
      };
      const client = adapter.client as PC | undefined;
      if (!client) {
        return fail(RPC_ERRORS.INTERNAL.code, 'public client 미초기화');
      }
      const params = Array.isArray(req.params) ? req.params : [];
      try {
        switch (req.method) {
          case 'eth_blockNumber': {
            const n = await client.getBlockNumber();
            return ok('0x' + n.toString(16));
          }
          case 'eth_getBalance': {
            const addr = String(params[0] ?? '');
            if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
              return fail(RPC_ERRORS.INVALID_PARAMS.code, '주소 형식 오류');
            }
            const v = await client.getBalance({ address: addr as `0x${string}` });
            return ok('0x' + v.toString(16));
          }
          case 'eth_call': {
            const call = params[0] as
              | { to?: string; data?: string; from?: string }
              | undefined;
            if (!call?.to) {
              return fail(RPC_ERRORS.INVALID_PARAMS.code, 'to 누락');
            }
            const out = await client.call({
              to: call.to as `0x${string}`,
              data: (call.data ?? '0x') as `0x${string}`,
              ...(call.from ? { account: call.from as `0x${string}` } : {}),
            });
            return ok(out.data ?? '0x');
          }
          case 'eth_estimateGas': {
            const call = params[0] as
              | {
                  to?: string;
                  data?: string;
                  value?: string;
                  from?: string;
                }
              | undefined;
            if (!call?.to) {
              return fail(RPC_ERRORS.INVALID_PARAMS.code, 'to 누락');
            }
            const gas = await client.estimateGas({
              to: call.to as `0x${string}`,
              ...(call.data ? { data: call.data as `0x${string}` } : {}),
              ...(call.value ? { value: BigInt(call.value) } : {}),
              ...(call.from ? { account: call.from as `0x${string}` } : {}),
            });
            return ok('0x' + gas.toString(16));
          }
          case 'eth_getTransactionByHash': {
            const h = String(params[0] ?? '');
            if (!/^0x[0-9a-fA-F]{64}$/.test(h)) {
              return fail(RPC_ERRORS.INVALID_PARAMS.code, 'txHash 형식 오류');
            }
            return ok(await client.getTransaction({ hash: h as `0x${string}` }));
          }
          case 'eth_getTransactionReceipt': {
            const h = String(params[0] ?? '');
            if (!/^0x[0-9a-fA-F]{64}$/.test(h)) {
              return fail(RPC_ERRORS.INVALID_PARAMS.code, 'txHash 형식 오류');
            }
            try {
              return ok(await client.getTransactionReceipt({ hash: h as `0x${string}` }));
            } catch {
              // viem throws if not yet mined; JSON-RPC convention returns null.
              return ok(null);
            }
          }
        }
      } catch (err) {
        return fail(RPC_ERRORS.INTERNAL.code, `RPC 호출 실패: ${(err as Error)?.message ?? err}`);
      }
      return fail(RPC_ERRORS.INTERNAL.code, '도달 불가');
    }

    // wallet_watchAsset: dApp 이 ERC-20/721/1155 토큰을 본 지갑에 등록 요청.
    // EIP-747 형식: { type, options: { address, symbol, decimals, image? } }
    // v0.3 정책:
    //  - origin 이 미승인이면 거부 (서명·송금과 동일 게이트).
    //  - confirm popup 으로 사용자 동의 — 메서드별 grant 발급 가능.
    //  - 승인 시 chrome.storage.session 의 'nd:watched-assets' 에 origin 단위
    //    allowlist 로 적재. 본 데이터는 비-수탁 정보(주소·심볼) 라 손실되어도
    //    잔액·서명에는 영향이 없다.
    case 'wallet_watchAsset': {
      const origin = senderOrigin(sender);
      if (!origin || !(await isOriginApproved(origin))) {
        return fail(RPC_ERRORS.UNAUTHORIZED.code, '연결되지 않은 dApp');
      }
      // EIP-747 은 params 가 객체일 수 있으며(`{ type, options }`) 배열 [obj] 형태도
      // 일부 dApp 이 사용한다. 둘 다 받아들인다.
      const raw = Array.isArray(req.params) ? req.params[0] : req.params;
      const p = raw as
        | {
            type?: string;
            options?: {
              address?: string;
              symbol?: string;
              decimals?: number;
              image?: string;
            };
          }
        | undefined;
      const type = p?.type ?? 'ERC20';
      const addr = p?.options?.address ?? '';
      const symbol = p?.options?.symbol ?? '';
      const decimals = p?.options?.decimals ?? 18;
      if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
        return fail(RPC_ERRORS.INVALID_PARAMS.code, '토큰 주소 형식 오류');
      }
      if (!symbol || symbol.length > 11) {
        return fail(RPC_ERRORS.INVALID_PARAMS.code, '심볼 누락 또는 11자 초과');
      }
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
        return fail(RPC_ERRORS.INVALID_PARAMS.code, 'decimals 범위 오류');
      }

      const context: WatchAssetConfirmContext = {
        requestId: '',
        method: 'wallet_watchAsset',
        origin,
        address: '',
        type,
        tokenAddress: addr,
        symbol,
        decimals,
        image: p?.options?.image ?? null,
      };
      const decision = await openConfirm(context);
      if (decision !== 'approve') {
        return fail(RPC_ERRORS.USER_REJECTED.code, RPC_ERRORS.USER_REJECTED.message);
      }
      // session storage 에 origin → token 목록으로 누적 저장. 실패해도 dApp 에는
      // true 를 반환 — UX 상 "사용자가 승인했음" 의 의미가 더 중요하다.
      try {
        const KEY = 'nd:watched-assets';
        const cur = ((await chrome.storage.session.get(KEY))[KEY] as
          | Record<string, Array<{ address: string; symbol: string; decimals: number }>>
          | undefined) ?? {};
        const slot = cur[origin] ?? [];
        if (!slot.some((t) => t.address.toLowerCase() === addr.toLowerCase())) {
          slot.push({ address: addr, symbol, decimals });
        }
        cur[origin] = slot;
        await chrome.storage.session.set({ [KEY]: cur });
      } catch {
        /* 저장 실패는 무시 — 사용자가 명시적으로 승인했으므로 */
      }
      return ok(true);
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

      // EIP-191 prefix + keccak + recovery 정규화는 SDK 의 signEvmMessage 에 위임.
      // 본 분기는 dApp 이 보낸 hex 를 raw bytes 로 디코드해 전달한다 — 헬퍼가 길이
      // 프리픽스를 알아서 붙인다.
      try {
        const sigHex = await signEvmMessage(
          acc.signer,
          acc.address,
          hexToBytes(messageHex as Hex),
        );
        return ok(sigHex);
      } catch (err) {
        return fail(RPC_ERRORS.INTERNAL.code, `서명 실패: ${(err as Error)?.message ?? err}`);
      }
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

      // 계약 호출(data ≠ '0x') 도 v0.3 부터 지원. SDK 측 TransferIntent.data 를 통해
      // unsigned tx 의 data 필드로 그대로 전파한다. 빈 data 는 native 전송과 동일 경로.
      const dataHexRaw = tx.data ?? '0x';
      const dataHex: Hex = dataHexRaw === '' ? '0x' : (dataHexRaw as Hex);
      if (!isHex(dataHex)) {
        return fail(RPC_ERRORS.INVALID_PARAMS.code, '잘못된 data hex');
      }
      // hex 길이는 0x + 짝수 자리.
      if (dataHex !== '0x' && dataHex.length % 2 !== 0) {
        return fail(RPC_ERRORS.INVALID_PARAMS.code, 'data hex 길이 홀수');
      }
      // 보안: 셀렉터 4바이트 미만(=0x + 8 hex chars 미만, 단 '0x' 자체는 제외)인
      // calldata 는 거부. 1~3바이트는 어떤 표준 함수 호출에도 해당하지 않으며,
      // 노출되면 사용자가 confirm popup 에서 어떤 함수가 호출되는지 알 수 없다.
      // (어떤 dApp 이든 '0x12' 같은 데이터를 보낼 정상적 이유가 없다.)
      if (dataHex !== '0x' && dataHex.length < 10) {
        return fail(
          RPC_ERRORS.INVALID_PARAMS.code,
          'calldata 가 셀렉터(4바이트) 보다 짧습니다',
        );
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
        // calldata 가 있으면 TransferIntent.data 로 SDK 에 전파. 어댑터가 가스 추정
        // 시점에 data 를 반영하므로 contract-call 의 OOG 위험은 native 와 동일하게
        // 어댑터 내부에서 처리된다.
        const intent =
          dataHex === '0x'
            ? { to: tx.to, amount: valueWei }
            : { to: tx.to, amount: valueWei, data: dataHex };
        const txHash = await walletStore.transfer(intent);
        return ok(txHash);
      } catch (err) {
        return fail(RPC_ERRORS.INTERNAL.code, `전송 실패: ${(err as Error)?.message ?? err}`);
      }
    }

    case 'eth_signTypedData_v3':
    case 'eth_signTypedData_v4': {
      // EIP-712 typed-data 서명.
      // params 형식: [address, typedData] — typedData 는 JSON 문자열 또는 객체.
      //
      // v3 vs v4:
      //   - v3 는 legacy MetaMask 변형으로, 중첩 struct 배열 (nested struct[])
      //     을 지원하지 않는 점만 다르다. 다이제스트 산출 자체는 동일한
      //     EIP-712 해시이므로 본 핸들러가 v4 와 동일 경로로 처리한다.
      //   - viem.hashTypedData 는 v4 사양을 따른다. 사용자 입력이 v3 호환이면
      //     동일 해시가 나오고, v4-전용 구조(중첩 struct[])이면 viem 이 거절한다.
      //     이 시점에 잘못된 v3 요청은 INVALID_PARAMS 로 떨어진다.
      //   - 일부 dApp 은 v3 만 호출하므로 method 별칭으로 받아들여 호환성을 확보한다.
      if (req.method === 'eth_signTypedData_v3') {
        console.warn(
          '[byeorin] eth_signTypedData_v3 is deprecated; routing through v4 path',
        );
      }
      const params = Array.isArray(req.params) ? req.params : [];
      const a = params[0];
      const b = params[1];
      if (typeof a !== 'string') {
        return fail(RPC_ERRORS.INVALID_PARAMS.code, '주소 누락');
      }
      if (b === undefined || b === null) {
        return fail(RPC_ERRORS.INVALID_PARAMS.code, 'typedData 누락');
      }

      let typedData: {
        domain?: EIP712Domain;
        types?: Record<string, Array<{ name: string; type: string }>>;
        primaryType?: string;
        message?: Record<string, unknown>;
      };
      try {
        typedData = typeof b === 'string' ? JSON.parse(b) : (b as typeof typedData);
      } catch (err) {
        return fail(
          RPC_ERRORS.INVALID_PARAMS.code,
          `typedData JSON 파싱 실패: ${(err as Error)?.message ?? err}`,
        );
      }
      if (
        !typedData ||
        typeof typedData !== 'object' ||
        !typedData.types ||
        !typedData.primaryType ||
        !typedData.message
      ) {
        return fail(RPC_ERRORS.INVALID_PARAMS.code, 'typedData 구조 불완전');
      }

      const domain: EIP712Domain = typedData.domain ?? {};
      // chainId 가드 — 명시되었으면 TTL(7777) 이어야 한다.
      if (domain.chainId !== undefined && domain.chainId !== null) {
        let cid: number;
        if (typeof domain.chainId === 'number') {
          cid = domain.chainId;
        } else if (typeof domain.chainId === 'string') {
          try {
            // hex(0x..) 또는 10진 모두 허용.
            cid = domain.chainId.startsWith('0x')
              ? parseInt(domain.chainId, 16)
              : parseInt(domain.chainId, 10);
          } catch {
            return fail(RPC_ERRORS.INVALID_PARAMS.code, `잘못된 domain.chainId: ${domain.chainId}`);
          }
        } else {
          return fail(RPC_ERRORS.INVALID_PARAMS.code, 'domain.chainId 타입 오류');
        }
        if (!Number.isFinite(cid) || cid !== TTL_CHAIN.id) {
          return fail(
            RPC_ERRORS.INVALID_PARAMS.code,
            `지원하지 않는 chainId: ${domain.chainId} (TTL=${TTL_CHAIN.id})`,
          );
        }
      }

      const origin = senderOrigin(sender);
      if (!origin || !(await isOriginApproved(origin))) {
        return fail(RPC_ERRORS.UNAUTHORIZED.code, '연결되지 않은 dApp');
      }
      const acc = await getActiveAccount();
      if (!acc) return fail(RPC_ERRORS.UNAUTHORIZED.code, '지갑 잠금 상태입니다');
      if (a.toLowerCase() !== acc.address.toLowerCase()) {
        return fail(RPC_ERRORS.INVALID_PARAMS.code, '주소 불일치');
      }

      // viem.hashTypedData 는 EIP-712 의 keccak256 digest(32B)를 반환. 본 digest 를
      // raw 로 서명하면 ecrecover 가능 한 65바이트 시그니처가 나온다.
      // 동적 입력이라 abitype 의 정밀 제네릭을 만족시킬 수 없어 인자 통째로 캐스팅한다 —
      // viem 내부의 ValidateTypedData 가 런타임 검증을 수행하므로 안전성은 보장된다.
      let digest: Hex;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        digest = hashTypedData({
          domain,
          types: typedData.types,
          primaryType: typedData.primaryType,
          message: typedData.message,
        } as unknown as Parameters<typeof hashTypedData>[0]);
      } catch (err) {
        return fail(
          RPC_ERRORS.INVALID_PARAMS.code,
          `typedData 해시 실패: ${(err as Error)?.message ?? err}`,
        );
      }

      // pretty-print — popup 의 JSON preview 용. 직렬화 불가(BigInt 등) 시 안전한 폴백.
      const safeStringify = (v: unknown): string => {
        try {
          return JSON.stringify(
            v,
            (_k, val) => (typeof val === 'bigint' ? val.toString() : val),
            2,
          );
        } catch {
          return String(v);
        }
      };

      const context: SignTypedDataConfirmContext = {
        requestId: '',
        method: 'eth_signTypedData_v4',
        origin,
        address: acc.address,
        domain,
        primaryType: typedData.primaryType,
        typesJson: safeStringify(typedData.types),
        messageJson: safeStringify(typedData.message),
        digest,
      };

      const decision = await openConfirm(context);
      if (decision !== 'approve') {
        return fail(RPC_ERRORS.USER_REJECTED.code, RPC_ERRORS.USER_REJECTED.message);
      }

      // digest 를 raw 로 서명 → 65바이트 (r||s||recovery). recovery 0|1 → v 27|28.
      try {
        const sig = await acc.signer.sign(hexToBytes(digest));
        if (sig.length !== 65) {
          return fail(RPC_ERRORS.INTERNAL.code, '서명 길이 오류');
        }
        const recovery = sig[64] as number;
        let v: number;
        if (recovery === 0 || recovery === 1) v = recovery + 27;
        else if (recovery === 27 || recovery === 28) v = recovery;
        else return fail(RPC_ERRORS.INTERNAL.code, `잘못된 recovery byte: ${recovery}`);
        const out = new Uint8Array(65);
        out.set(sig.subarray(0, 64), 0);
        out[64] = v;
        return ok(bytesToHex(out));
      } catch (err) {
        return fail(RPC_ERRORS.INTERNAL.code, `서명 실패: ${(err as Error)?.message ?? err}`);
      }
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
    slot.resolve({ decision: 'reject', rememberFor1h: false });
  }
  pendingConfirms.clear();
  // 명시적으로 reason 을 로깅(개발자 도구) — 외부에 노출되지 않음.
  console.warn('[byeorin] pending 요청 정리:', reason);
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

/**
 * 사용자 동의 popup 흐름.
 *
 * v0.3 정책: origin+method 별 "1시간 자동 승인" grant 가 존재하면 popup 을 띄우지
 * 않고 즉시 'approve' 로 통과. grant 발급 자체는 사용자가 popup 의 체크박스를
 * 켰을 때만 일어나며, 본 함수가 그 결과(rememberFor1h)를 받아 storage 에 기록한다.
 *
 * 보안 메모:
 *  - grant 는 chrome.storage.session 에만 — 브라우저 재시작/잠금 시 자동 무효화.
 *  - grant 가 있어도 origin 자체가 미승인(=isOriginApproved false) 이면 어차피
 *    상위 분기에서 거절되므로, grant 는 보조 게이트일 뿐 권한 격상이 아니다.
 *  - grant 는 메서드 호출 자체를 자동승인할 뿐 서명 대상(메시지 내용)에 묶이지 않음.
 *    UX 상 사용자에게 "임의 메시지 자동 서명 가능" 임을 popup 에 명시 경고.
 */
/**
 * grant 키에 박을 계정 주소 추출. eth_sendTransaction 은 `from`, 그 외는 `address`.
 * 추출 실패(주소가 비어있거나 잘못된 형식) 시 null — 호출부는 grant 경로 자체를
 * 건너뛰고 popup 으로 폴백한다.
 */
function grantSubject(ctx: ConfirmContext): string | null {
  const addr =
    ctx.method === 'eth_sendTransaction' ? ctx.from : ctx.address;
  if (typeof addr !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return null;
  return addr.toLowerCase();
}

function openConfirm(ctxInput: ConfirmContext): Promise<'approve' | 'reject'> {
  return new Promise<'approve' | 'reject'>((resolve) => {
    const requestId = makeRequestId();
    const nonce = makeNonce();
    const context: ConfirmContext = { ...ctxInput, requestId };

    // 자동 승인 path: origin+method+address 유효 grant 가 있으면 popup 건너뛰고 즉시 통과.
    // grant 체크 자체는 async — 비동기로 검사한 뒤, 결과에 따라 popup 을 띄울지 결정.
    //
    // address 는 ctxInput 의 메서드별 필드에서 추출. eth_sendTransaction 은 from,
    // 그 외는 address. 누락된 경우는 grant 체크를 건너뛰고(=popup 표시) 보수적으로 처리.
    const grantAddress = grantSubject(ctxInput);
    void (async () => {
      try {
        if (grantAddress) {
          const ok = await hasGrant(
            ctxInput.origin,
            ctxInput.method as GrantMethod,
            grantAddress,
          );
          if (ok) {
            resolve('approve');
            return;
          }
        }
      } catch {
        // storage 조회 실패는 보수적으로 popup 으로 폴백.
      }

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

      const slotResolve = (d: ConfirmDecision): void => {
        // grant 발급은 approve 이고 rememberFor1h 가 true 이고 address 가 확보된 경우에만.
        if (d.decision === 'approve' && d.rememberFor1h && grantAddress) {
          void addGrant(
            ctxInput.origin,
            ctxInput.method as GrantMethod,
            grantAddress,
          );
        }
        resolve(d.decision);
      };
      const slot: PendingConfirm = { context, nonce, resolve: slotResolve, timeout };
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
    })();
  });
}

function handleConfirmResult(
  requestId: string,
  nonce: string,
  decision: 'approve' | 'reject',
  rememberFor1h: boolean,
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
  slot.resolve({ decision, rememberFor1h });
}
