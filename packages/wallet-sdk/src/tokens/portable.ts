// portable.ts — 체인 무관 토큰 계층.
//
// 왜 필요한가: 지금까지 토큰은 EVM 전용이었다. ERC-20 만 알고, 조회도 송금도
// `evm:` 로 시작하는 체인에서만 됐다. Solana 의 SPL, TRON 의 TRC-20, Cosmos 의
// denom, Sui/Aptos 의 Coin, TON 의 Jetton, XRP 의 issued currency 는 지갑에서
// 존재하지 않는 것이나 마찬가지였다.
//
// 체인마다 토큰 표준이 완전히 다르므로 **하나의 구현으로 합칠 수 없다.** 대신
// 지갑이 필요로 하는 두 가지 질문만 공통으로 두고, 답하는 방법은 각 어댑터가
// 자기 방식으로 구현한다:
//
//   1. 이 주소가 무슨 토큰을 얼마나 갖고 있나?   → discoverTokens
//   2. 이 토큰을 저 주소로 보내려면?              → TransferIntent.asset
//
// 2번은 새 메서드를 만들지 않는다. `TransferIntent` 에 이미 `asset?: string` 이
// 있고, 어댑터의 `buildTransfer` 가 그것을 보고 분기하면 된다. 인터페이스를 늘리는
// 대신 이미 있는 자리를 쓴다 — 어댑터가 구현해야 할 표면이 좁을수록 체인을
// 추가하기 쉽다.

/**
 * 체인 무관 토큰 잔액.
 *
 * `id` 는 그 체인에서 토큰을 가리키는 문자열이고 형식은 체인마다 다르다:
 *   EVM     `0x…` 컨트랙트 주소
 *   Solana  SPL mint 주소 (base58)
 *   TRON    TRC-20 컨트랙트 주소 (T…)
 *   Cosmos  denom (`utrg`, `ibc/…`)
 *   Sui     coin type (`0x2::sui::SUI`)
 *   Aptos   coin type 또는 FA metadata 주소
 *   TON     jetton master 주소
 *   XRP     `CUR.issuer` (통화코드 + 발행자)
 *
 * 이 값을 그대로 `TransferIntent.asset` 에 넣으면 송금이 된다 — 조회와 송금이
 * 같은 식별자를 쓰게 해서, 화면이 둘을 잇는 변환표를 들고 있지 않아도 되게 한다.
 */
export interface PortableTokenBalance {
  /** 체인 안에서 이 토큰을 가리키는 식별자. TransferIntent.asset 에 그대로 쓴다. */
  id: string;
  symbol: string;
  name: string;
  /** base unit → 표시 단위 변환에 쓰는 자릿수. */
  decimals: number;
  /** base unit 잔액. */
  balance: bigint;
  /**
   * 이 값의 출처가 체인 자체가 아니라 인덱서/외부 API 인 경우 그 이름.
   *
   * 체인에서 직접 읽은 값과 남이 말해준 값은 신뢰도가 다르다. 화면이 그 차이를
   * 표시할 수 있어야 하므로 숨기지 않는다.
   */
  source?: string;
}

/**
 * 토큰을 다룰 수 있는 어댑터가 추가로 구현하는 것.
 *
 * `ChainAdapter` 본체에 넣지 않고 분리한 이유: 토큰 개념이 없거나 아직 구현하지
 * 않은 체인이 빈 메서드를 만들도록 강요하지 않기 위해서다. 지갑은 `supportsTokens`
 * 로 물어보고, 아니면 조회 자체를 시도하지 않는다.
 */
export interface TokenCapableAdapter {
  /**
   * 이 주소가 보유한 토큰을 전부 돌려준다.
   *
   * **잔액 0 인 토큰을 포함할지는 구현이 정한다.** 체인에 따라 "보유 목록"이
   * 계정에 등록된 것만 나오기도 하고(Solana ATA, XRP trust line), 전체 스캔이
   * 필요하기도 하다(EVM 은 알려진 컨트랙트를 하나씩 물어봐야 한다).
   *
   * 실패는 던지지 않고 빈 배열을 돌려준다 — 토큰 목록 때문에 지갑이 안 열리면
   * 안 된다. 부분 실패(일부 토큰만 조회 성공)도 성공한 것만 돌려준다.
   */
  discoverTokens(owner: string): Promise<PortableTokenBalance[]>;

  /**
   * 식별자 하나를 받아 그 토큰이 무엇인지 체인에서 읽는다. **수동 추가용.**
   *
   * 자동 발견이 못 찾는 토큰이 늘 있다. 인덱서가 모르거나, 목록 API 가 상한에
   * 걸렸거나, 방금 발행됐거나. 그때 사용자가 식별자를 직접 넣을 길이 있어야 한다.
   *
   * `id` 형식은 `PortableTokenBalance.id` 와 같다 (EVM 컨트랙트 주소, Solana
   * mint, Cosmos denom, …). 반환값의 `id` 도 정규화된 형태로 돌려줘야 조회와
   * 송금이 같은 문자열을 보게 된다.
   *
   * 규칙:
   *   - **decimals 를 못 읽으면 null.** 추측해서 18 을 넣지 않는다. 자릿수가
   *     틀리면 잔액이 통째로 거짓이 되는데, 사용자는 그걸 알아채지 못한다.
   *   - 그 체인의 토큰이 아니거나 존재하지 않으면 null.
   *   - **던져도 된다.** discoverTokens 와 달리 이건 사용자가 명시적으로 요청한
   *     동작이라, 왜 실패했는지 알려주는 편이 낫다. 화면이 메시지를 보여준다.
   *
   * `owner` 는 잔액을 함께 채우기 위한 것이다. 잔액을 못 구하면 0n 으로 두되
   * 메타데이터는 채워 돌려준다 — 등록 자체는 되어야 한다.
   */
  readToken?(id: string, owner: string): Promise<PortableTokenBalance | null>;
}

/** 이 어댑터가 토큰 조회를 할 수 있는가. */
export function supportsTokens(adapter: unknown): adapter is TokenCapableAdapter {
  return (
    typeof adapter === 'object' &&
    adapter !== null &&
    typeof (adapter as TokenCapableAdapter).discoverTokens === 'function'
  );
}

/**
 * 안전하게 조회한다. 어댑터가 토큰을 모르면 빈 배열, 던지면 빈 배열.
 *
 * 화면은 이 함수만 부르면 되고 체인별 분기를 하지 않는다.
 */
export async function discoverPortableTokens(
  adapter: unknown,
  owner: string,
): Promise<PortableTokenBalance[]> {
  if (!supportsTokens(adapter)) return [];
  try {
    const out = await adapter.discoverTokens(owner);
    return Array.isArray(out) ? out.filter(isValidTokenBalance) : [];
  } catch {
    return [];
  }
}

/**
 * 어댑터가 돌려준 항목이 쓸 만한지 본다.
 *
 * decimals 가 틀리면 잔액이 자릿수째로 거짓이 되므로 **추측해서 18 을 넣지 않고
 * 그 항목을 버린다.** 외부 API 가 이상한 값을 줘도 화면에 거짓 수량이 뜨지
 * 않게 하는 마지막 방어선이다.
 */
function isValidTokenBalance(v: unknown): v is PortableTokenBalance {
  if (typeof v !== 'object' || v === null) return false;
  const t = v as PortableTokenBalance;
  return (
    typeof t.id === 'string' &&
    t.id.length > 0 &&
    typeof t.symbol === 'string' &&
    typeof t.decimals === 'number' &&
    Number.isInteger(t.decimals) &&
    t.decimals >= 0 &&
    t.decimals <= 36 &&
    typeof t.balance === 'bigint' &&
    t.balance >= 0n
  );
}

/**
 * 식별자 하나를 체인에서 읽어 토큰 정보를 얻는다. **수동 추가용.**
 *
 * discoverPortableTokens 와 달리 **던진다.** 사용자가 명시적으로 요청한 동작이라
 * 조용히 실패하면 왜 안 됐는지 알 수 없다 — 화면이 이유를 보여줘야 한다.
 */
export async function readPortableToken(
  adapter: unknown,
  id: string,
  owner: string,
): Promise<PortableTokenBalance | null> {
  if (!supportsTokens(adapter) || typeof adapter.readToken !== 'function') {
    return null;
  }
  const out = await adapter.readToken(id, owner);
  if (out === null || out === undefined) return null;
  // 어댑터가 이상한 값을 줘도 레지스트리를 오염시키지 않는다. 특히 decimals —
  // 자릿수가 틀리면 잔액이 통째로 거짓이 되는데 사용자는 알아채지 못한다.
  return isValidTokenBalance(out) ? out : null;
}

/** 이 어댑터가 수동 토큰 추가를 지원하는가. */
export function supportsManualToken(adapter: unknown): boolean {
  return supportsTokens(adapter) && typeof adapter.readToken === 'function';
}
