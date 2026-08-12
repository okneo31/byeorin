// explorer-links.test.ts — ChainSpec.explorer 16종 표 고정.
//
// 표의 도메인·경로는 2026-08-12 GET 실측(공개 RPC 최신 블록의 실존 표본)으로
// 확정된 값이다. 이 테스트는 네트워크를 치지 않는다 — URL 생성 규칙이 실측표에서
// 벗어나면 여기서 잡는다. 죽었거나 미확인이었던 링크(avalanche 전체, arbitrum
// address, zion address)는 null 이어야 한다 — 죽은 링크를 만들지 않는다.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHAINS,
  findChainSpec,
  cosmosChainSpec,
  evmExplorer,
  type ChainKey,
} from '../src/multichain.js';
import { TTL_CHAIN } from '../src/chains/registry.js';

/** 표본 입력 — 형식만 유효하면 되는 고정값. */
const EVM_HASH = '0x' + 'ab'.repeat(32);
const EVM_ADDR = '0x' + '12'.repeat(20);
const HEX64 = 'a1'.repeat(32); // 0x 없는 64자 hex (xrp/ton/zion 형)

function explorerOf(key: ChainKey) {
  const spec = findChainSpec(key);
  expect(spec, `${key} spec 존재`).toBeDefined();
  return spec!.explorer;
}

describe('모든 체인에 explorer 필드가 명시돼 있다', () => {
  it('16종 전부 explorer 가 ChainExplorer 또는 null 로 채워져 있다', () => {
    expect(DEFAULT_CHAINS).toHaveLength(16);
    for (const spec of DEFAULT_CHAINS) {
      // 필드 자체가 빠진 spec 은 없다 (undefined 금지 — null 로 명시).
      expect(spec.explorer !== undefined, `${spec.key} explorer 명시`).toBe(true);
    }
  });
});

describe('EVM 8종 — viem blockExplorers 기반 /tx·/address', () => {
  it('ttl → scan.ttl1.top (라우터 실측으로 /address 확인)', () => {
    const ex = explorerOf('evm:ttl')!;
    expect(ex.name).toBe('TTL Scan');
    expect(ex.txUrl(EVM_HASH)).toBe(`https://scan.ttl1.top/tx/${EVM_HASH}`);
    expect(ex.addressUrl(EVM_ADDR)).toBe(`https://scan.ttl1.top/address/${EVM_ADDR}`);
  });

  it.each([
    ['evm:ethereum', 'https://etherscan.io'],
    ['evm:polygon', 'https://polygonscan.com'],
    ['evm:bsc', 'https://bscscan.com'],
    ['evm:optimism', 'https://optimistic.etherscan.io'],
    ['evm:base', 'https://basescan.org'],
  ] as const)('%s → %s (tx·address 실측 200/200)', (key, base) => {
    const ex = explorerOf(key)!;
    expect(ex.txUrl(EVM_HASH)).toBe(`${base}/tx/${EVM_HASH}`);
    expect(ex.addressUrl(EVM_ADDR)).toBe(`${base}/address/${EVM_ADDR}`);
  });

  it('arbitrum — tx 만 산다(200). address 는 실측 403 → null', () => {
    const ex = explorerOf('evm:arbitrum')!;
    expect(ex.txUrl(EVM_HASH)).toBe(`https://arbiscan.io/tx/${EVM_HASH}`);
    expect(ex.addressUrl(EVM_ADDR)).toBeNull();
  });

  it('avalanche — snowtrace.io 사이트 전체 403 실측 → 탐색기 자체가 null', () => {
    expect(explorerOf('evm:avalanche')).toBeNull();
  });

  it('빈 해시·"0x" 는 링크를 만들지 않는다 (기존 셸 explorerTxUrl 규칙 승계)', () => {
    const ex = explorerOf('evm:ttl')!;
    expect(ex.txUrl('')).toBeNull();
    expect(ex.txUrl('0x')).toBeNull();
    expect(ex.addressUrl('')).toBeNull();
  });

  it('evmExplorer() — blockExplorers 없는 체인은 null, TTL_CHAIN 은 산다', () => {
    expect(evmExplorer({ ...TTL_CHAIN, blockExplorers: undefined })).toBeNull();
    const ex = evmExplorer(TTL_CHAIN)!;
    expect(ex.baseUrl).toBe('https://scan.ttl1.top');
  });
});

describe('비-EVM 7종 — 실측표 그대로', () => {
  it('btc → mempool.space', () => {
    const ex = explorerOf('btc')!;
    expect(ex.txUrl(HEX64)).toBe(`https://mempool.space/tx/${HEX64}`);
    expect(ex.addressUrl('bc1qxy')).toBe('https://mempool.space/address/bc1qxy');
  });

  it('xrp → livenet.xrpl.org — 해시는 대문자 hex 64자로 정규화', () => {
    const ex = explorerOf('xrp')!;
    expect(ex.txUrl(HEX64)).toBe(
      `https://livenet.xrpl.org/transactions/${HEX64.toUpperCase()}`,
    );
    // 64자 hex 형식이 아니면 못 만든다 — null.
    expect(ex.txUrl('not-a-hash')).toBeNull();
    expect(ex.addressUrl('rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh')).toBe(
      'https://livenet.xrpl.org/accounts/rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
    );
  });

  it('solana → explorer.solana.com', () => {
    const ex = explorerOf('solana')!;
    expect(ex.txUrl('5sig')).toBe('https://explorer.solana.com/tx/5sig');
    expect(ex.addressUrl('Vote111')).toBe('https://explorer.solana.com/address/Vote111');
  });

  it('tron → tronscan.org (# fragment 라우팅)', () => {
    const ex = explorerOf('tron')!;
    expect(ex.txUrl(HEX64)).toBe(`https://tronscan.org/#/transaction/${HEX64}`);
    expect(ex.addressUrl('TCqZkyExhEMjaLQXjy9sUqJ43qinqUbYnP')).toBe(
      'https://tronscan.org/#/address/TCqZkyExhEMjaLQXjy9sUqJ43qinqUbYnP',
    );
  });

  it('ton → tonviewer.com — base64 해시(toncenter 형식)를 hex 로 변환한다', () => {
    const ex = explorerOf('ton')!;
    // hex 그대로 오면 소문자 정규화.
    expect(ex.txUrl(HEX64.toUpperCase())).toBe(
      `https://tonviewer.com/transaction/${HEX64}`,
    );
    // 실측 표본: base64 'Ky7UMdd...' → hex '2b2ed431...'. 여기선 규칙만 고정 —
    // 32바이트를 base64 로 싼 값이 같은 바이트의 hex 로 풀리는지 본다.
    const bytes = Array.from({ length: 32 }, (_, i) => i); // 00 01 02 ... 1f
    const b64 = Buffer.from(bytes).toString('base64');
    const hex = Buffer.from(bytes).toString('hex');
    expect(ex.txUrl(b64)).toBe(`https://tonviewer.com/transaction/${hex}`);
    // 32바이트가 아니거나 형식이 다르면 null — 링크를 지어내지 않는다.
    expect(ex.txUrl('short')).toBeNull();
    expect(ex.addressUrl('EQAbc')).toBe('https://tonviewer.com/EQAbc');
  });

  it('aptos → explorer.aptoslabs.com (?network=mainnet 필수)', () => {
    const ex = explorerOf('aptos')!;
    expect(ex.txUrl(`0x${HEX64}`)).toBe(
      `https://explorer.aptoslabs.com/txn/0x${HEX64}?network=mainnet`,
    );
    expect(ex.addressUrl(`0x${HEX64}`)).toBe(
      `https://explorer.aptoslabs.com/account/0x${HEX64}?network=mainnet`,
    );
  });

  it('sui → suiscan.xyz/mainnet', () => {
    const ex = explorerOf('sui')!;
    expect(ex.txUrl('DigestAbc')).toBe('https://suiscan.xyz/mainnet/tx/DigestAbc');
    expect(ex.addressUrl('0xabc')).toBe('https://suiscan.xyz/mainnet/account/0xabc');
  });
});

describe('cosmos:zion — zion1.top/explorer (tx 만 실재)', () => {
  it('tx → 대문자 hex 64자 경로 (실측: 실존/가짜 해시 본문 상이 = 서버 렌더링)', () => {
    const ex = explorerOf('cosmos:zion')!;
    expect(ex.txUrl(HEX64)).toBe(
      `https://zion1.top/explorer/tx/${HEX64.toUpperCase()}`,
    );
    expect(ex.txUrl('not-64-hex')).toBeNull();
  });

  it('address — /explorer/address·/account 실측 404 → 항상 null', () => {
    const ex = explorerOf('cosmos:zion')!;
    expect(ex.addressUrl('zion1yp64nwygmxev2aej2ejsv6ywg4wy4jyqgaddfn')).toBeNull();
  });
});

describe('cosmosChainSpec() — 외부 Cosmos 는 탐색기 미지정 → null', () => {
  it('explorer 가 null 로 명시된다', () => {
    const spec = cosmosChainSpec({
      displayName: 'Cosmos Hub',
      nativeSymbol: 'ATOM',
      chainId: 'cosmoshub-4',
      bech32Prefix: 'cosmos',
      rpcUrl: 'https://example.invalid',
      denom: 'uatom',
    });
    expect(spec.explorer).toBeNull();
  });
});
