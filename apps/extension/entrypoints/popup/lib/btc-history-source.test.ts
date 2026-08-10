// btc-history-source.test.ts — BTC 이력 배선의 순수 로직 검증.
//
// 네트워크는 타지 않는다. fetchBtcHistory 는 Electrum 왕복을 하므로 여기서
// 부르지 않고, 화면 표시를 좌우하는 두 순수 함수만 고정한다:
//   - sortBtcRowsForDisplay: 무엇이 위에 오는가
//   - classifyBtcFailure:    어떤 실패가 어떤 안내 문구로 가는가
//
// 확장 vitest 는 environment: node 라 렌더링은 대상이 아니다.

import { describe, expect, it } from 'vitest';
import type { BtcActivityRow } from '@byeorin/wallet-sdk/btc-history';
import {
  ELECTRUM,
  RELAY_URL,
  classifyBtcFailure,
  sortBtcRowsForDisplay,
} from './btc-history-source.js';

function row(txid: string, height: number): BtcActivityRow {
  return {
    txid,
    height,
    confirmed: height > 0,
    raw: { tx_hash: txid, height },
  };
}

// ElectrumError 판정을 주입으로 받으므로, 테스트는 클래스 없이도 두 갈래를 다 탄다.
const notElectrum = (): boolean => false;
const isElectrum = (): boolean => true;

describe('sortBtcRowsForDisplay', () => {
  it('멤풀이 먼저, 그 다음 높이 내림차순', () => {
    const out = sortBtcRowsForDisplay([
      row('a', 100),
      row('b', 0),
      row('c', 300),
      row('d', -1),
      row('e', 200),
    ]);
    expect(out.map((r) => r.txid)).toEqual(['b', 'd', 'c', 'e', 'a']);
  });

  it('원 배열을 건드리지 않는다', () => {
    const input = [row('a', 1), row('b', 2)];
    const before = input.map((r) => r.txid);
    sortBtcRowsForDisplay(input);
    expect(input.map((r) => r.txid)).toEqual(before);
  });

  it('같은 높이는 txid 사전순 — 재조회마다 순서가 흔들리지 않는다', () => {
    const out = sortBtcRowsForDisplay([row('zz', 7), row('aa', 7), row('mm', 7)]);
    expect(out.map((r) => r.txid)).toEqual(['aa', 'mm', 'zz']);
  });

  it('빈 목록은 빈 목록', () => {
    expect(sortBtcRowsForDisplay([])).toEqual([]);
  });
});

describe('classifyBtcFailure', () => {
  it('ElectrumError 는 단계와 무관하게 server', () => {
    expect(classifyBtcFailure(new Error('x'), 'request', isElectrum)).toBe('server');
    expect(classifyBtcFailure(new Error('x'), 'decode', isElectrum)).toBe('server');
  });

  it('timeout 문구는 stage 보다 우선한다', () => {
    expect(
      classifyBtcFailure(new Error('relay connect timeout (8000ms)'), 'connect', notElectrum),
    ).toBe('timeout');
    expect(classifyBtcFailure(new Error('request timed out'), 'request', notElectrum)).toBe(
      'timeout',
    );
  });

  it('connect 단계 실패는 transport — 릴레이 미가동이 여기로 온다', () => {
    expect(
      classifyBtcFailure(
        new Error('WsTcpTransport: relay connection failed (code=1006)'),
        'connect',
        notElectrum,
      ),
    ).toBe('transport');
  });

  it('요청 중 소켓 끊김도 transport', () => {
    expect(classifyBtcFailure(new Error('not connected'), 'request', notElectrum)).toBe(
      'transport',
    );
  });

  it('응답 형태 불일치는 protocol', () => {
    expect(
      classifyBtcFailure(new Error('unexpected history item shape'), 'decode', notElectrum),
    ).toBe('protocol');
  });

  it('Error 가 아닌 값도 삼키지 않고 분류한다', () => {
    expect(classifyBtcFailure('nope', 'connect', notElectrum)).toBe('transport');
  });
});

describe('서버 상수', () => {
  it('릴레이는 로컬 루프백 — 확장이 외부 WS 로 나가지 않는다', () => {
    expect(RELAY_URL).toBe('ws://127.0.0.1:18337');
  });

  it('릴레이→서버 구간이 인터넷을 지나므로 반드시 TLS(50002) 로 나간다', () => {
    // 평문 50001 로 되돌리면 조회 주소가 경로 전체에 노출된다. 이 단언이 그 회귀를 막는다.
    expect(ELECTRUM.port).toBe(50002);
    expect(ELECTRUM.tls).toBe(true);
  });
});
