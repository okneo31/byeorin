import { defineBackground } from 'wxt/sandbox';
import { TTL_CHAIN } from '@nodong/wallet-sdk';
import { readSession } from '../src/lib/session.js';
import { getActiveAccount, getTtlAdapter } from '../src/lib/wallet-service.js';
import {
  RPC_ERRORS,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from '../src/lib/rpc.js';

// 노동자의 지갑 백그라운드 서비스 워커.
// dApp 으로부터 들어오는 EIP-1193 RPC 를 SDK 로 라우팅한다.
// v0.1 스켈레톤: chainId/accounts 만 end-to-end 동작, 나머지는 명시적 throw.

export default defineBackground({
  type: 'module',
  main() {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      // 비동기 응답이므로 true 를 반환해 채널을 열어둔다.
      handleRequest(msg as JsonRpcRequest).then(sendResponse).catch((err) => {
        sendResponse({
          id: (msg as JsonRpcRequest)?.id ?? 0,
          error: { code: RPC_ERRORS.INTERNAL.code, message: String(err?.message ?? err) },
        } satisfies JsonRpcResponse);
      });
      return true;
    });
  },
});

async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
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
      const session = await readSession();
      return ok(session ? [session.address] : []);
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
      // TODO(v0.2): chrome.windows.create 로 confirm popup 띄우고 결과 회신.
      // 현재는 이미 unlock 된 세션이 있으면 그대로 반환, 없으면 unauthorized.
      const acc = await getActiveAccount();
      if (!acc) return fail(RPC_ERRORS.UNAUTHORIZED.code, '지갑 잠금 상태입니다');
      return ok([acc.address]);
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
