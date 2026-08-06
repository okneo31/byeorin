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
  activityMemo,
  explorerTxUrl,
  formatAmount,
  isEvmChainKey,
  isOutgoing,
  memoHasLink,
  relativeParts,
  renderMemo,
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

describe('activityMemo', () => {
  // Activity 에 memo 필드가 아직 없어도 컴파일이 깨지지 않는 읽기라, 픽스처도
  // 같은 방식(unknown 경유)으로 얹는다.
  function withMemo(memo: unknown): Activity {
    return { ...act(), ...(({ memo } as unknown) as Partial<Activity>) };
  }

  it('memo 필드가 없으면 null — 예전 응답과 예전 SDK 를 그대로 견딘다', () => {
    expect(activityMemo(act())).toBeNull();
  });

  it('null / 빈 문자열은 메모가 아니다 (인덱서 배포 이전 tx · 일반 송금)', () => {
    expect(activityMemo(withMemo(null))).toBeNull();
    expect(activityMemo(withMemo(''))).toBeNull();
    expect(activityMemo(withMemo(42))).toBeNull();
  });

  it('정상 메모는 원문 그대로', () => {
    expect(activityMemo(withMemo('2026년 용역계약서 3차 대금'))).toBe(
      '2026년 용역계약서 3차 대금',
    );
  });

  it('제어문자·깨진 글자는 인덱서가 줬어도 화면에 올리지 않는다', () => {
    expect(activityMemo(withMemo('a\u0007b'))).toBeNull();
    expect(activityMemo(withMemo('a\uFFFDb'))).toBeNull();
    expect(activityMemo(withMemo('   '))).toBeNull();
  });

  it('탭·개행은 허용 문자다', () => {
    expect(activityMemo(withMemo('첫 줄\n둘째\t줄'))).toBe('첫 줄\n둘째\t줄');
  });

  it('2048 바이트를 넘으면 버린다 (서버 판정과 같은 규칙)', () => {
    expect(activityMemo(withMemo('a'.repeat(2048)))).toBe('a'.repeat(2048));
    expect(activityMemo(withMemo('a'.repeat(2049)))).toBeNull();
  });
});

// ── 메모 링크 렌더 ──────────────────────────────────────────────────────
//
// environment 가 'node' 라 DOM 이 없다. renderMemo 가 돌려주는 것은 React 엘리먼트
// 객체 배열이므로 **객체 그대로** 들여다본다 — HTML 문자열을 만들지 않는다는 계약이
// 여기서 그대로 검증된다(문자열이면 아래 type/props 검사가 성립하지 않는다).
describe('renderMemo / memoHasLink', () => {
  interface Elem {
    type: unknown;
    props: Record<string, unknown>;
  }
  const el = (n: unknown): Elem => n as unknown as Elem;
  /** <a> 조각만. type 이 'a' 인 엘리먼트가 링크다. */
  const links = (text: string): Elem[] =>
    renderMemo(text)
      .map(el)
      .filter((e) => e.type === 'a');
  /** 첫 번째 링크. 없으면 테스트가 그 자리에서 실패한다. */
  const firstLink = (text: string): Elem => {
    const [a] = links(text);
    if (a === undefined) throw new Error(`링크 없음: ${text}`);
    return a;
  };
  /** 텍스트 조각(Fragment)의 children 을 이어붙인 것. */
  const plain = (text: string): string =>
    renderMemo(text)
      .map(el)
      .filter((e) => e.type !== 'a')
      .map((e) => String(e.props.children))
      .join('');

  it('링크가 없으면 조각 하나뿐 — 예전 렌더와 같은 텍스트 노드 하나', () => {
    const out = renderMemo('2026년 용역계약서 3차 대금');
    expect(out).toHaveLength(1);
    expect(el(out[0]).type).not.toBe('a');
    expect(el(out[0]).props.children).toBe('2026년 용역계약서 3차 대금');
    expect(memoHasLink('2026년 용역계약서 3차 대금')).toBe(false);
  });

  it('href 와 화면 텍스트가 같은 값이다 — 링크 위장이 구조적으로 불가능', () => {
    const a = firstLink('https://scan.ttl1.top/tx/0xabc');
    expect(a.props.href).toBe('https://scan.ttl1.top/tx/0xabc');
    expect(a.props.children).toBe(a.props.href);
    expect(a.props.rel).toBe('noreferrer noopener');
    expect(a.props.target).toBe('_blank');
  });

  it('문장 끝 마침표는 링크에 들어가지 않는다', () => {
    const a = firstLink('확인 https://scan.ttl1.top/tx/0xabc.');
    expect(a.props.href).toBe('https://scan.ttl1.top/tx/0xabc');
    expect(plain('확인 https://scan.ttl1.top/tx/0xabc.')).toBe('확인 .');
  });

  it('감싼 괄호는 링크 밖 — 짝 맞는 괄호는 링크 안', () => {
    expect(firstLink('(https://scan.ttl1.top)').props.href).toBe('https://scan.ttl1.top');
    expect(plain('(https://scan.ttl1.top)')).toBe('()');
    expect(firstLink('https://ko.wikipedia.org/wiki/A_(B)').props.href).toBe(
      'https://ko.wikipedia.org/wiki/A_(B)',
    );
  });

  it('javascript: · data: 는 링크가 되지 않는다 (평문)', () => {
    const src = 'javascript:alert(1) 과 data:text/html,x';
    expect(links(src)).toHaveLength(0);
    expect(memoHasLink(src)).toBe(false);
    expect(plain(src)).toBe(src);
  });

  it('호스트가 없는 https:// 는 링크로 만들지 않고 원문을 텍스트로 남긴다', () => {
    expect(links('https://.')).toHaveLength(0);
    expect(plain('https://.')).toBe('https://.');
  });

  it('링크가 하나라도 있으면 memoHasLink 가 true — 줄접기를 끄는 근거', () => {
    expect(memoHasLink('영수증 https://scan.ttl1.top/tx/0xabc 확인')).toBe(true);
  });

  it('개행 너머로 URL 이 이어지지 않는다 (\\s 에서 끊긴다)', () => {
    const a = firstLink('https://a.example/x\nhttps://b.example/y');
    expect(a.props.href).toBe('https://a.example/x');
    expect(links('https://a.example/x\nhttps://b.example/y')).toHaveLength(2);
  });
});
