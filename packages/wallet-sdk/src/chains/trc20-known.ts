// trc20-known.ts — 주소가 고정된 TRC-20 토큰의 내장 이름표.
//
// 왜 있나: tron.ts 는 무키 TronGrid 의 IP 할당량 때문에 symbol()/name() 을
// 기본적으로 부르지 않는다(fetchLabels=false). 예산을 decimals 에 몰아준
// 의도적 절충이고, 그 절충 자체는 유효하다 — 실측 880개 중 0개가 나왔던
// 원인이 3배 예산이었다. 다만 USDT 처럼 **주소가 고정된 유명 토큰**까지
// 주소 축약으로 표시되는 것은 절충의 대가가 아니라 그냥 손해다. 그런 토큰은
// RPC 를 한 번도 쓰지 않고 이름을 붙일 수 있다.
//
// 왜 tokens/registry.ts 를 안 쓰나: 그쪽 TokenRegistry 는 (1) Map<number,…>
// 라 EVM chainId 가 필요하고 — TRON 에는 없다 —, (2) normAddr 가 주소를
// toLowerCase() 한다. Ethereum 은 체크섬 케이스가 표기 옵션이라 안전하지만
// TRON base58check 는 대소문자가 정보다. 소문자화하면 다른 주소가 되고,
// 저장 후 되읽으면 송금 불가 문자열이 된다. 그래서 별도 모듈이다.
//
// 주소를 추가하는 절차(엄수): 기억에서 적지 않는다. 저장소 안에 근거가 있는
// 주소만 넣고 evidence 에 그 경로:줄 을 적는다. 근거가 없으면 먼저 근거를
// 만든다. 틀린 주소는 사용자 자금을 다른 컨트랙트로 보낸다.

/** 내장 목록 한 줄. */
export interface KnownTrc20 {
  /** base58check 정본. 대소문자 그대로 — 절대 정규화하지 않는다. */
  address: string;
  /** 표시용 심볼 — ex. "USDT". */
  symbol: string;
  /** 사람 읽기용 풀네임. */
  name: string;
  /**
   * 자릿수 **폴백 전용**. 체인에서 읽힌 값이 항상 이긴다.
   *
   * 내장값을 믿어도 아껴지는 RPC 는 0회다 — decimals 호출은 어차피 나간다.
   * 이득 없이 "내장값이 체인과 다르면 금액이 틀린다"는 위험만 남으므로,
   * 이 값은 체인에서 못 읽었을 때의 마지막 수단으로만 쓴다.
   * 근거 없는 숫자는 넣지 않는다 — 비워 두는 편이 틀린 값보다 낫다.
   */
  decimals?: number;
  /**
   * **액면 통화 ISO** (USD·KRW…). 없으면 스테이블코인이 아니다.
   * 의미·경계·한계는 tokens/registry.ts 의 TokenInfo.faceIso 주석과 동일하다 —
   * 액면은 발행자 선언 단위지 시장 시세가 아니고, 페그 파탄은 이 구조가 탐지하지
   * 못한다. 디페그 확인 시 이 필드를 지우면 값만 비고 신원은 남는다.
   */
  faceIso?: string;
  /** 이 주소의 저장소 내 근거. 없는 주소는 목록에 넣지 않는다. */
  evidence: string;
}

/**
 * 내장 목록.
 *
 * 지금 1종뿐인 이유: 저장소 전체를 base58 패턴으로 훑어 근거가 확인된 TRON
 * 컨트랙트 주소가 이것 하나였다. USDC 등은 근거가 생기면 그때 추가한다.
 * 지어낸 주소를 채워 목록을 "풍성하게" 만드는 것이 이 파일의 목적이 아니다.
 */
export const KNOWN_TRC20: readonly KnownTrc20[] = [
  {
    address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    symbol: 'USDT',
    name: 'Tether USD',
    faceIso: 'USD',
    // decimals 는 비워 둔다 — 저장소 안에 근거가 없다. 체인에서 읽는다.
    evidence:
      'apps/android/src/App.tsx:192, apps/extension/entrypoints/popup/App.tsx:190, packages/shell-core/tests/qr-parse.test.ts:255',
  },
];

/** 정확 일치 조회용 인덱스. 정규화하지 않는 것이 이 Map 의 요점이다. */
const BY_ADDRESS: ReadonlyMap<string, KnownTrc20> = new Map(
  KNOWN_TRC20.map((t) => [t.address, t]),
);

/**
 * base58 주소로 내장 항목을 찾는다. 없으면 undefined.
 *
 * 대소문자를 맞춰 주지 않는다 — 맞춰 주면 잘못된 케이스의 주소를 "아는 토큰"
 * 으로 인정하게 되고, 그 주소는 송금에 쓰이면 실패하거나 다른 곳으로 간다.
 */
export function lookupKnownTrc20(base58: string): KnownTrc20 | undefined {
  return BY_ADDRESS.get(base58);
}

/** decimals 대조 결과. note 가 있으면 source 문자열에 그대로 얹는다. */
export interface DecimalsReconcile {
  /** 실제로 써야 할 자릿수. 둘 다 없으면 null — 그 토큰은 버린다. */
  decimals: number | null;
  /** 화면에 남길 사실. 특이사항 없으면 undefined. */
  note?: string;
}

/**
 * 내장 decimals 와 체인 decimals 를 대조한다.
 *
 * 규칙: **체인이 이긴다.** 내장 목록은 사람이 적은 것이고 토큰은 재발행될 수
 * 있지만, 체인 값은 그 컨트랙트가 지금 실제로 쓰는 값이다. 불일치는 숨기지
 * 않고 note 로 남긴다 — 내장 목록이 낡았다는 신호이기 때문이다.
 * 체인에서 못 읽었을 때만 내장값을 쓰고, 미검증임을 반드시 표기한다.
 */
export function reconcileKnownDecimals(
  known: KnownTrc20 | undefined,
  onChain: number | null,
): DecimalsReconcile {
  if (onChain !== null) {
    if (known?.decimals !== undefined && known.decimals !== onChain) {
      return {
        decimals: onChain,
        note: `decimals=체인 ${onChain}(내장 ${known.decimals}와 불일치, 체인 채택)`,
      };
    }
    return { decimals: onChain };
  }
  if (known?.decimals !== undefined) {
    return {
      decimals: known.decimals,
      note: `decimals=내장폴백 ${known.decimals}(체인 읽기실패, 미검증)`,
    };
  }
  return { decimals: null };
}

/**
 * 체인에서 읽은 심볼과 내장 심볼이 다를 때 남길 사실. 채택값은 체인이다.
 * (fetchLabels=true 인 경로에서만 발생한다.)
 */
export function noteSymbolMismatch(
  known: KnownTrc20 | undefined,
  onChainSymbol: string | null,
): string | undefined {
  if (!known || onChainSymbol === null) return undefined;
  if (onChainSymbol === known.symbol) return undefined;
  return `symbol=체인 ${onChainSymbol}(내장 ${known.symbol}와 불일치, 체인 채택)`;
}
