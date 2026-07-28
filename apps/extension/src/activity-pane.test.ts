// ActivityPane 의 순수 헬퍼 단위 테스트.
//
// vitest.config.ts 가 `src/**/*.test.ts` 만 include 하고 environment 가 'node' 라
// 렌더 테스트(jsdom/testing-library)는 이 워크스페이스에 없다. 그래서 화면 로직
// 중 **판정에 해당하는 부분**을 순수 함수로 뽑아 여기서 검증한다:
// 방향 판정, 축약, 금액 포맷, 상대 시간 구간, TTL 전용 탐색기 링크.

import { describe, expect, it } from 'vitest';
import type { Activity } from '@byeorin/wallet-sdk';
import {
  absoluteTime,
  explorerTxUrl,
  formatAmount,
  isEvmChainKey,
  isOutgoing,
  relativeParts,
  shortenHex,
  statusKey,
} from '../entrypoints/popup/screens/ActivityPane.js';

const SELF = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
const PEER = '0x1111111111111111111111111111111111111111';

function act(over: Partial<Activity> = {}): Activity {
  return {
    hash: '0xdeadbeef',
    blockNumber: 100n,
    timestamp: 1_700_000_000,
    from: SELF,
    to: PEER,
    value: 10n ** 18n,
    status: 'success',
    ...over,
  };
}

describe('isEvmChainKey', () => {
  it('evm: 접두만 EVM 으로 본다', () => {
    expect(isEvmChainKey('evm:ttl')).toBe(true);
    expect(isEvmChainKey('evm:ethereum')).toBe(true);
    expect(isEvmChainKey('cosmos:zion')).toBe(false);
    expect(isEvmChainKey('solana:mainnet')).toBe(false);
    expect(isEvmChainKey('')).toBe(false);
  });
});

describe('explorerTxUrl', () => {
  it('TTL 에서만 scan.ttl1.top 링크를 만든다', () => {
    expect(explorerTxUrl('evm:ttl', '0xabc')).toBe('https://scan.ttl1.top/tx/0xabc');
  });

  it('다른 EVM 체인에는 TTL 탐색기를 붙이지 않는다', () => {
    expect(explorerTxUrl('evm:ethereum', '0xabc')).toBeNull();
    expect(explorerTxUrl('evm:polygon', '0xabc')).toBeNull();
    expect(explorerTxUrl('cosmos:zion', '0xabc')).toBeNull();
  });

  it('해시가 비면 링크를 안 만든다 (RPC fallback 의 0x 자리표시)', () => {
    expect(explorerTxUrl('evm:ttl', '0x')).toBeNull();
    expect(explorerTxUrl('evm:ttl', '')).toBeNull();
  });
});

describe('shortenHex', () => {
  it('12자 이하는 그대로 둔다', () => {
    expect(shortenHex('0x1234')).toBe('0x1234');
  });

  it('긴 값은 6…4 로 줄인다', () => {
    expect(shortenHex(PEER)).toBe('0x1111…1111');
  });
});

describe('formatAmount', () => {
  it('18 decimals 를 소수 4자리로 표기한다', () => {
    expect(formatAmount(10n ** 18n, 18)).toBe('1.0000');
    expect(formatAmount(1_500_000_000_000_000_000n, 18)).toBe('1.5000');
  });

  it('정수부에 천 단위 쉼표를 넣는다', () => {
    expect(formatAmount(1_234_567n * 10n ** 18n, 18)).toBe('1,234,567.0000');
  });

  it('0 과 비-18 decimals 도 처리한다', () => {
    expect(formatAmount(0n, 18)).toBe('0.0000');
    expect(formatAmount(2_500_000n, 6)).toBe('2.5000');
  });
});

describe('isOutgoing', () => {
  it('활성 주소가 from 이면 보냄', () => {
    expect(isOutgoing(act(), SELF)).toBe(true);
  });

  it('활성 주소가 to 면 받음', () => {
    expect(isOutgoing(act({ from: PEER, to: SELF }), SELF)).toBe(false);
  });

  it('대소문자(체크섬)를 무시한다', () => {
    expect(isOutgoing(act({ from: SELF.toLowerCase() }), SELF.toUpperCase())).toBe(true);
  });
});

describe('relativeParts', () => {
  const now = 1_700_000_000_000; // ms

  it('1분 미만은 "방금"', () => {
    expect(relativeParts(1_700_000_000, now)).toEqual({
      key: 'activity.rel.just_now',
      n: 0,
    });
  });

  it('분 / 시간 / 일 구간을 나눈다', () => {
    expect(relativeParts(1_700_000_000 - 300, now)).toEqual({
      key: 'activity.rel.minutes',
      n: 5,
    });
    expect(relativeParts(1_700_000_000 - 7200, now)).toEqual({
      key: 'activity.rel.hours',
      n: 2,
    });
    expect(relativeParts(1_700_000_000 - 3 * 86_400, now)).toEqual({
      key: 'activity.rel.days',
      n: 3,
    });
  });

  it('미래 시각(노드 시계 오차)은 "방금" 으로 흡수한다', () => {
    expect(relativeParts(1_700_000_500, now)).toEqual({
      key: 'activity.rel.just_now',
      n: 0,
    });
  });

  it('timestamp 0 (RPC fallback 의 토큰 로그) 은 null', () => {
    expect(relativeParts(0, now)).toBeNull();
    expect(relativeParts(Number.NaN, now)).toBeNull();
  });
});

describe('absoluteTime', () => {
  it('0 이면 null', () => {
    expect(absoluteTime(0)).toBeNull();
  });

  it('YYYY-MM-DD HH:mm 형식', () => {
    expect(absoluteTime(1_700_000_000)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe('statusKey', () => {
  it('기존 카탈로그 키로 매핑한다', () => {
    expect(statusKey('success')).toBe('activity.status_confirmed');
    expect(statusKey('failed')).toBe('activity.status_failed');
    expect(statusKey('pending')).toBe('activity.status_pending');
  });
});
