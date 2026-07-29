// token-send.ts — 송금 화면의 "자산 선택 · 금액 파싱 · intent 구성" 순수 로직.
//
// SendPane 은 화면만 그리고, 아래 판단은 전부 여기서 한다:
//   - 지금 고른 자산이 native 인가 ERC-20 인가 (심볼/decimals/잔액이 무엇인가)
//   - 입력 문자열이 그 자산의 base-unit 으로 얼마인가
//   - 그 금액이 보유 잔액을 넘지 않는가
//   - ERC-20 이면 어떤 TransferIntent 를 walletStore.transfer 에 넘길 것인가
//
// 확장판(apps/extension/entrypoints/popup/lib/token-send.ts)의 복사본이다.
// 안드로이드 셸에는 vitest 설정이 없어 테스트는 확장 쪽 token-send.test.ts 가
// 계속 들고 있다 — 두 파일은 내용이 같으므로 그 테스트가 이 로직도 덮는다.
// (셸 코드에 의존하는 부분이 하나도 없다: viem + wallet-sdk 뿐.)
//
// ERC-20 계층은 재구현하지 않는다 — wallet-sdk 의 `Erc20` 가 이미 transfer
// calldata 를 만들어 TransferIntent 로 돌려주고, EvmAdapter.buildTransfer 가
// intent.data 를 보고 계약 호출 tx 를 빌드한다. 본 모듈은 그 위의 얇은 층이다.

import { parseUnits } from 'viem';
import type { ChainAdapter, TransferIntent } from '@byeorin/wallet-sdk/core';
import { Erc20, type DiscoveredBalance, type EvmAdapter } from '@byeorin/wallet-sdk/evm';

/**
 * 송금 금액 검증 — 10진수, 소수점 18자리 이하.
 *
 * App.tsx 의 동명 상수와 같은 값이다. App.tsx 를 건드리지 않기 위해 의도적으로
 * 복제했다 (App.tsx 쪽은 SwapPane 이 계속 쓴다). 나중에 App.tsx 가 이 모듈을
 * import 하도록 정리하면 한 곳으로 합칠 수 있다.
 */
export const AMOUNT_RE = /^\d+(\.\d{1,18})?$/;

/** 'native' 또는 ERC-20 컨트랙트 주소. */
export type AssetKey = 'native' | string;

/** 선택된 자산의 송금에 필요한 사실들만 담은 값. */
export interface SelectedAsset {
  readonly kind: 'native' | 'erc20';
  readonly symbol: string;
  readonly decimals: number;
  /** ERC-20 일 때 컨트랙트 주소, native 면 null. */
  readonly address: string | null;
  /** 알려진 보유 잔액(base-unit). 모르면 null — 잔액 검사를 건너뛴다. */
  readonly balance: bigint | null;
}

/**
 * 자산 키 → SelectedAsset.
 *
 * 목록에 없는 키(토큰 목록이 갱신되며 사라진 경우 등)는 native 로 되돌린다 —
 * "정체를 모르는 자산으로 송금" 이라는 상태를 만들지 않기 위해서다.
 */
export function resolveAsset(
  key: AssetKey,
  nativeSymbol: string,
  nativeDecimals: number,
  nativeBalance: bigint | null,
  tokens: readonly DiscoveredBalance[] | null,
): SelectedAsset {
  if (key !== 'native' && tokens) {
    const hit = tokens.find(
      (row) => row.token.address.toLowerCase() === key.toLowerCase(),
    );
    if (hit) {
      return {
        kind: 'erc20',
        symbol: hit.token.symbol,
        decimals: hit.token.decimals,
        address: hit.token.address,
        balance: hit.balance,
      };
    }
  }
  return {
    kind: 'native',
    symbol: nativeSymbol,
    decimals: nativeDecimals,
    address: null,
    balance: nativeBalance,
  };
}

export type AmountErrorReason = 'format' | 'decimals' | 'insufficient';

export type AmountParse =
  | { readonly ok: true; readonly value: bigint }
  | { readonly ok: false; readonly reason: AmountErrorReason };

/**
 * 입력 문자열 → 선택 자산의 base-unit.
 *
 * 자릿수 규칙이 자산마다 다르다:
 *   - ERC-20: decimals 를 넘는 소수 자릿수를 **거절**한다. parseUnits 가 조용히
 *     반올림해서 "입력한 것과 다른 금액" 이 나가는 사고를 막는다.
 *   - native: 기존 SendPane 동작을 그대로 둔다 (AMOUNT_RE 통과 후 parseUnits 에
 *     맡김). 회귀를 만들지 않기 위한 의도적 비대칭이며, native 쪽 자릿수 엄격화는
 *     별도 과제다.
 */
export function parseAssetAmount(input: string, asset: SelectedAsset): AmountParse {
  const s = input.trim();
  if (!AMOUNT_RE.test(s) || Number(s) <= 0) return { ok: false, reason: 'format' };

  if (asset.kind === 'erc20') {
    const dot = s.indexOf('.');
    const fracLen = dot === -1 ? 0 : s.length - dot - 1;
    if (fracLen > asset.decimals) return { ok: false, reason: 'decimals' };
  }

  let value: bigint;
  try {
    value = parseUnits(s, asset.decimals);
  } catch {
    return { ok: false, reason: 'format' };
  }
  if (value <= 0n) return { ok: false, reason: 'format' };
  if (asset.balance !== null && value > asset.balance) {
    return { ok: false, reason: 'insufficient' };
  }
  return { ok: true, value };
}

/**
 * 선택 자산에 맞는 TransferIntent.
 *
 * native 는 기존과 동일한 `{ to, amount }`. ERC-20 은 `Erc20.transfer` 가
 * 만들어주는 `{ to: 컨트랙트, amount: 0n, asset: 'erc20', data: calldata }`.
 * 어느 쪽이든 walletStore.transfer(intent, adapter) 로 그대로 흘려보내면 된다 —
 * 서명·브로드캐스트 경로가 하나다.
 */
export function buildTransferIntent(
  asset: SelectedAsset,
  to: string,
  value: bigint,
  adapter: ChainAdapter,
): TransferIntent {
  if (asset.kind === 'native' || asset.address === null) {
    return { to, amount: value };
  }
  // 이 함수는 **호출자가 EVM 임을 확인한 뒤에만** 부른다 (SendPane 의 isEvm 분기).
  //
  // 예전 주석은 "SendPane 이 비-EVM 에서 토큰 선택 UI 를 안 그리므로 여기 도달할
  // 수 없다" 였는데, 이제 자산 선택은 체인을 묻지 않으므로 그 이유는 틀렸다.
  // 안전한 이유는 바뀌었다 — 호출부가 명시적으로 가른다.
  //
  // 비-EVM 은 TransferIntent.asset 규약을 쓰고 이 경로로 오지 않는다. EvmAdapter
  // 도 이제 asset 을 읽으므로 언젠가 이 분기를 없애고 규약 하나로 합칠 수 있다 —
  // 다만 자산이 오가는 경로라 실증 없이 바꾸지 않는다.
  //
  // Erc20 는 adapter 의 viem client 만 꺼내 쓰는데, transfer() 는 calldata
  // 인코딩만 하므로 RPC 를 건드리지 않는다.
  const erc20 = new Erc20(adapter as unknown as EvmAdapter);
  return erc20.transfer(asset.address, to, value);
}

/**
 * base-unit → 사람이 읽는 문자열. 잔액 표시 전용 (소수 4자리 + 천 단위 쉼표).
 * App.tsx 의 formatAmount 와 같은 표기를 쓴다.
 */
export function formatAssetAmount(base: bigint | null, decimals: number): string {
  if (base == null) return '0.0000';
  const factor = 10n ** BigInt(decimals);
  const whole = base / factor;
  const frac = base % factor;
  const fracStr = (Number(frac) / Number(factor)).toFixed(4).slice(2);
  return `${withCommas(whole.toString())}.${fracStr}`;
}

/** 정수 문자열에 천 단위 쉼표. */
function withCommas(s: string): string {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
