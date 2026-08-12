// activity-links.ts — 활동 화면의 체인 분기·탐색기 링크 **순수 로직**.
//
// ActivityPane.tsx 에서 분리한 이유: 확장 vitest 는 environment=node 라 .tsx
// 렌더링을 테스트하지 않는다(btc-history-source.ts 와 같은 배치). 화면 분기를
// 좌우하는 판정을 여기에 두고 그 함수만 고정한다.
//
// 전부 타입 import 만 쓴다 — 이 파일이 popup 초기 번들에 실려도 SDK 런타임
// 코드는 0 이다. 활동 소스 값(fetch 함수)은 ActivityPane 이 dynamic import 한다.

import type {
  ActivitySourceChain,
  ActivitySourceFailure,
  ChainActivityRow,
} from '@byeorin/wallet-sdk/activity-sources';
import type { ChainExplorer } from '@byeorin/wallet-sdk/multichain';

/**
 * 체인 키 → 활동 소스 판정. 기존 RPC 만으로 이력이 나오는 5체인만 담는다.
 * cosmos:zion 만 cosmos 소스에 매핑 — 외부 Cosmos 체인이 추가되면 그 체인의
 * LCD 를 따로 배선해야 하므로 `cosmos:` 접두사로 뭉뚱그리지 않는다.
 * tron·ton 은 제3자 인덱서가 필요해 여기 없다(체인 자체 RPC 에 이력 조회가 없다).
 */
const SOURCED_ACTIVITY_CHAINS: Record<string, ActivitySourceChain> = {
  solana: 'solana',
  xrp: 'xrp',
  aptos: 'aptos',
  sui: 'sui',
  'cosmos:zion': 'cosmos',
};

/** 활성 체인이 활동 소스 5종 중 하나인가. 아니면 null. */
export function sourcedChainOf(chainKey: string): ActivitySourceChain | null {
  return SOURCED_ACTIVITY_CHAINS[chainKey] ?? null;
}

/**
 * 탐색기 tx 링크. ChainSpec.explorer 가 null 인 체인(공개 탐색기 없음/실측 사망)
 * 이거나 explorer 가 이 입력으로 URL 을 못 만들면 null — 죽은 링크를 그리지
 * 않는다. 예전 TTL_EXPLORER 하드코딩(TTL 외 전부 null)을 SDK 표로 대체한 자리.
 */
export function explorerTxLink(
  explorer: Pick<ChainExplorer, 'txUrl'> | null | undefined,
  id: string,
): string | null {
  if (!explorer) return null;
  return explorer.txUrl(id);
}

/** 소스 실패 분류 → i18n 키. unsupported/server/protocol 은 공통 문구로 합친다. */
export function srcFailureKey(failure: ActivitySourceFailure): string {
  if (failure === 'timeout') return 'activity.src.timeout';
  if (failure === 'network') return 'activity.src.network';
  return 'activity.src.failed';
}

/** 소스 행 상태 → i18n 키. 'unknown' 은 지어내지 않고 미상으로 표기한다. */
export function srcStatusKey(status: ChainActivityRow['status']): string {
  if (status === 'success') return 'activity.status_confirmed';
  if (status === 'failed') return 'activity.status_failed';
  return 'activity.src.status_unknown';
}

/** 소스 행 방향 → i18n 키. 방향을 못 주는 소스(solana)는 undefined → null. */
export function srcDirectionKey(
  direction: ChainActivityRow['direction'],
): string | null {
  if (direction === 'out') return 'activity.outgoing';
  if (direction === 'in') return 'activity.incoming';
  if (direction === 'self') return 'activity.src.self';
  return null;
}
