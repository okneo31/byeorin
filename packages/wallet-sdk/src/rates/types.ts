// rates/types.ts — 환율 스냅샷의 형태.
//
// 스냅샷은 앵커다. 한 번 만들어지고 그 뒤로 외부 데이터를 참조하지 않는다.
// 값이 어떻게 나왔는지(inputs)를 함께 실어, 제3자가 같은 입력으로 같은 값을
// 재현해 검증할 수 있게 한다 — 숫자만 있고 근거가 없으면 믿으라는 말밖에 안 된다.

export interface RateInputs {
  /** 명목 GDP, **자국통화 단위**. 달러 환산값이 아니다. */
  gdpLocal: number;
  /** 위 GDP 의 기준 연도. */
  gdpYear: string;
  population: number;
  populationYear: string;
  /** 합성값일 때만 존재 — 예) 유로존은 회원국 GDP 합산. */
  gdpSynthetic?: string;
}

export interface TokenRate {
  /** 토큰 심볼 — tUSD, tJPY … */
  symbol: string;
  /** 통화 ISO — USD, JPY … */
  iso: string;
  /** ERC-20 컨트랙트 주소. 심볼이 아니라 이것으로 맞춘다. */
  address: string;
  decimals: number;
  country: string;
  /**
   * World Bank iso3 국가코드 — 입력 출처를 되짚을 수 있게.
   * 통화동맹(EUR·XOF)은 한 나라가 아니므로 비어 있고, iso3Members 를 본다.
   */
  iso3?: string;
  /** 통화동맹일 때 합산에 쓴 회원국 iso3 목록. 단일 국가면 없다. */
  iso3Members?: string[];
  /**
   * **1 TTL = perTtl 단위의 이 토큰.**
   *
   * 그 나라의 하루 품삯(자국통화)이다. 1 TTL 이 노동 1일이므로 곧 환율이 된다.
   */
  perTtl: number;
  inputs: RateInputs;
}

/** 데이터가 없어 환율을 내지 못한 토큰. 추측하지 않고 남긴다. */
export interface UnresolvedRate {
  symbol: string;
  iso: string;
  country: string;
  reason: string;
}

export interface RateSnapshot {
  v: number;
  /**
   * 앵커를 취득한 날. **고정 상수다** — 생성기를 다시 돌려도 바뀌지 않는다.
   * 실행 시각을 넣으면 "다시 돌려 git diff 가 비는지" 로 재현을 검증할 수 없다.
   */
  anchoredAt: string;
  principle: string;
  formula: string;
  daysPerYear: number;
  sources: Record<string, string>;
  notes: string[];
  rates: TokenRate[];
  unresolved: UnresolvedRate[];
}
