// popup 주소 화면(AddressMatrix / AddressbookPane)의 순수 로직 검증.
//
// 확장의 vitest 는 environment:'node' 이고 DOM 이 없다 — 렌더 테스트는 범위 밖이다.
// 따라서 두 화면에서 판단이 들어가는 부분(체인×계정 매트릭스 구성, 자동완성 후보
// 선별)만 순수 함수로 떼어내 검증한다.

import { describe, expect, it, vi } from 'vitest';
import type { AddressbookEntry } from '@byeorin/shell-core';
import type { ChainSpec } from '@byeorin/wallet-sdk/multichain';

// AddressMatrix 는 walletStore(= viem/EvmAdapter 실인스턴스) 를 import 한다.
// 주소 파생 로직 자체는 resolve 콜백으로 주입되므로, 테스트에서는 모듈 부작용만
// 잘라내면 충분하다.
vi.mock('./wallet-service.js', () => ({
  walletStore: {
    getAccountAt: () => {
      throw new Error('not used in this test');
    },
  },
}));

const { buildAddressRows, shortenChainAddress } = await import(
  '../../entrypoints/popup/screens/AddressMatrix.js'
);
const { toSuggestions } = await import(
  '../../entrypoints/popup/screens/AddressbookPane.js'
);

/** 테스트용 최소 ChainSpec — build() 는 매트릭스 로직에서 호출되지 않는다. */
function spec(key: string, displayName: string): ChainSpec {
  return {
    key,
    displayName,
    curve: 'secp256k1',
    nativeSymbol: 'X',
    nativeDecimals: 18,
    build: () => {
      throw new Error('build() should not be called by buildAddressRows');
    },
  } as unknown as ChainSpec;
}

function entry(
  kind: 'self' | 'external',
  chainKey: string,
  address: string,
  label: string,
): AddressbookEntry {
  return {
    id: `${kind}:${chainKey}:${address}`.toLowerCase(),
    label,
    address,
    chainKey,
    kind,
    createdAt: 0,
  };
}

describe('buildAddressRows', () => {
  const specs = [spec('evm:ttl', 'TTL'), spec('solana', 'Solana')];

  it('resolve 가 성공한 체인은 주소를, throw 한 체인은 null 을 담는다', () => {
    const rows = buildAddressRows(specs, (s) => {
      if (s.key === 'solana') throw new Error('ed25519 unsupported for raw key account');
      return '0xabc';
    });
    expect(rows).toEqual([
      { chainKey: 'evm:ttl', displayName: 'TTL', address: '0xabc' },
      { chainKey: 'solana', displayName: 'Solana', address: null },
    ]);
  });

  it('전 체인이 실패해도 행 수는 유지된다 (화면 전체가 죽지 않는다)', () => {
    const rows = buildAddressRows(specs, () => {
      throw new Error('boom');
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.address === null)).toBe(true);
  });

  it('빈 체인 목록은 빈 배열', () => {
    expect(buildAddressRows([], () => '0x0')).toEqual([]);
  });
});

describe('shortenChainAddress', () => {
  it('12자 이하는 그대로 둔다', () => {
    expect(shortenChainAddress('0x1234567890')).toBe('0x1234567890');
  });

  it('긴 주소는 앞 6 · 뒤 4 로 줄인다', () => {
    expect(shortenChainAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe(
      '0x1234…5678',
    );
  });
});

describe('toSuggestions', () => {
  const entries: AddressbookEntry[] = [
    entry('self', 'evm:ttl', '0xAAA', '내 계정 1'),
    entry('external', 'evm:ttl', '0xBBB', '거래소'),
    entry('external', 'solana', 'SoLxxx', '친구'),
  ];

  it('요청한 체인의 엔트리만 label/address 로 돌려준다', () => {
    expect(toSuggestions(entries, 'evm:ttl')).toEqual([
      { label: '내 계정 1', address: '0xAAA' },
      { label: '거래소', address: '0xBBB' },
    ]);
  });

  it('해당 체인 엔트리가 없으면 빈 배열', () => {
    expect(toSuggestions(entries, 'btc')).toEqual([]);
  });

  it('대소문자만 다른 같은 주소는 먼저 나온 것만 남긴다', () => {
    const dup = [
      entry('self', 'evm:ttl', '0xAAA', '내 계정 1'),
      entry('external', 'evm:ttl', '0xaaa', '수동 등록'),
    ];
    expect(toSuggestions(dup, 'evm:ttl')).toEqual([{ label: '내 계정 1', address: '0xAAA' }]);
  });
});
