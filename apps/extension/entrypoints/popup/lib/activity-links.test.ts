// activity-links.test.ts — 활동 화면 체인 분기·탐색기 링크 순수 로직 검증.
//
// 네트워크는 타지 않는다. 렌더링도 하지 않는다(확장 vitest 는 environment=node).
// SDK multichain 값(16 체인 어댑터)도 끌지 않는다 — explorerTxLink 는
// Pick<ChainExplorer,'txUrl'> 만 받으므로 가짜 탐색기로 계약을 고정한다.

import { describe, expect, it } from 'vitest';
import { en, ko } from '@byeorin/i18n';
import {
  explorerTxLink,
  sourcedChainOf,
  srcDirectionKey,
  srcFailureKey,
  srcStatusKey,
} from './activity-links.js';

describe('sourcedChainOf — 활동 소스 5체인 판정', () => {
  it('소스 5체인은 각자의 소스로 간다', () => {
    expect(sourcedChainOf('solana')).toBe('solana');
    expect(sourcedChainOf('xrp')).toBe('xrp');
    expect(sourcedChainOf('aptos')).toBe('aptos');
    expect(sourcedChainOf('sui')).toBe('sui');
    expect(sourcedChainOf('cosmos:zion')).toBe('cosmos');
  });

  it('EVM·BTC 는 기존 트랙 — 소스가 아니다', () => {
    expect(sourcedChainOf('evm:ttl')).toBeNull();
    expect(sourcedChainOf('evm:ethereum')).toBeNull();
    expect(sourcedChainOf('btc')).toBeNull();
  });

  it('tron·ton 은 제3자 인덱서 필요 — 소스 없음(미지원 안내로 간다)', () => {
    expect(sourcedChainOf('tron')).toBeNull();
    expect(sourcedChainOf('ton')).toBeNull();
  });

  it('cosmos:zion 외의 cosmos 체인은 zion LCD 로 보내지 않는다', () => {
    expect(sourcedChainOf('cosmos:cosmoshub-4')).toBeNull();
    expect(sourcedChainOf('cosmos')).toBeNull();
  });
});

describe('explorerTxLink — ChainSpec.explorer 소비', () => {
  const fake = {
    txUrl: (h: string): string | null => (h && h !== '0x' ? `https://x.example/tx/${h}` : null),
  };

  it('explorer 가 null(탐색기 없는 체인)이면 링크 없음', () => {
    expect(explorerTxLink(null, '0xabc')).toBeNull();
    expect(explorerTxLink(undefined, '0xabc')).toBeNull();
  });

  it('explorer 의 txUrl 규칙을 그대로 쓴다 — 빈 해시·"0x" 는 null', () => {
    expect(explorerTxLink(fake, '0xabc')).toBe('https://x.example/tx/0xabc');
    expect(explorerTxLink(fake, '')).toBeNull();
    expect(explorerTxLink(fake, '0x')).toBeNull();
  });
});

describe('srcFailureKey / srcStatusKey / srcDirectionKey — i18n 키 사상', () => {
  it('실패 분류 → 문구 키', () => {
    expect(srcFailureKey('timeout')).toBe('activity.src.timeout');
    expect(srcFailureKey('network')).toBe('activity.src.network');
    expect(srcFailureKey('server')).toBe('activity.src.failed');
    expect(srcFailureKey('protocol')).toBe('activity.src.failed');
    expect(srcFailureKey('unsupported')).toBe('activity.src.failed');
  });

  it('상태 → 문구 키. unknown 은 지어내지 않고 미상', () => {
    expect(srcStatusKey('success')).toBe('activity.status_confirmed');
    expect(srcStatusKey('failed')).toBe('activity.status_failed');
    expect(srcStatusKey('unknown')).toBe('activity.src.status_unknown');
  });

  it('방향 → 문구 키. 방향을 못 주는 소스는 null(줄 자체를 안 그린다)', () => {
    expect(srcDirectionKey('out')).toBe('activity.outgoing');
    expect(srcDirectionKey('in')).toBe('activity.incoming');
    expect(srcDirectionKey('self')).toBe('activity.src.self');
    expect(srcDirectionKey(undefined)).toBeNull();
  });
});

describe('i18n 카탈로그 — 화면이 쓰는 키가 ko/en 양쪽에 실재한다', () => {
  // ActivityPane 소스 카드가 t() 로 부르는 키 전부. 하나라도 빠지면 화면에
  // 키 문자열이 그대로 노출된다 — 카탈로그 수정 없이 여기서 잡는다.
  const KEYS = [
    'activity.src.lead',
    'activity.src.failed',
    'activity.src.network',
    'activity.src.timeout',
    'activity.src.status_unknown',
    'activity.src.self',
    'activity.src.omit.timestamp',
    'activity.src.omit.direction',
    'activity.src.omit.counterparty',
    'activity.src.omit.amount',
    'activity.src.omit.memo',
    'activity.src.aptos.sent_only',
    'activity.view_in_explorer',
    'activity.retry',
    'activity.empty',
    'activity.count_with_max',
    'activity.block_number',
    'activity.memo_label',
  ];

  it.each(KEYS)('%s', (key) => {
    expect((ko as Record<string, string>)[key]).toBeTypeOf('string');
    expect((en as Record<string, string>)[key]).toBeTypeOf('string');
  });
});
