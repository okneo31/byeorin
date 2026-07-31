// checkpoints.ts — BIP157 스캔 시작점(체크포인트) 데이터.
//
// scan.ts 는 ScanCheckpoint(height + blockHash + basic filter header)에서 출발해
// 그 "다음" 블록부터 훑는다. 체크포인트는 두 가지를 고정한다:
//   - 헤더 체인의 시작 앵커 (이보다 깊은 재조직은 scan.ts 가 거부한다)
//   - filter header 체인의 시작 앵커 (cfheaders 가 여기에 연결돼야 통과)
// 따라서 값이 틀리면 스캔이 조용히 잘못되는 게 아니라 예외로 멈춘다.
//
// ---------------------------------------------------------------------------
// 이 파일의 값은 어디서 왔나 (지어낸 값 0)
// ---------------------------------------------------------------------------
// 전부 scripts/btc-p2p/build-checkpoints.mjs 가 오프라인으로 재계산한 결과다.
// 그 스크립트는 이 디렉터리의 gcs.ts·messages.ts 를 그대로 불러 쓴다.
//
//   source: 'genesis-computed'
//     제네시스 블록은 프로토콜 상수다. 코인베이스 원문 + 헤더 필드(time·bits·
//     nonce)로 블록을 재조립해 (1) 코인베이스 txid = 머클루트, (2) 블록해시가
//     공개된 제네시스 해시와 일치, (3) 해시 ≤ target(bits) 를 확인한 뒤,
//     BIP158 basic filter 를 encodeGcsFilter 로 만들고
//     filter_header = dsha256(dsha256(filter) ‖ 0^32) 를 계산했다.
//     제네시스 필터의 원소는 코인베이스 출력 스크립트 1개뿐이다
//     (P2PK, 67바이트 — OP_RETURN 아님, 소비된 이전 출력 없음).
//
//   source: 'bip158-test-vectors'
//     bitcoin/bips 저장소 bip-0158/testnet-19.json 의 공식 테스트 벡터.
//     벡터의 header 값을 옮겨 적은 게 아니라, 벡터의 블록 원문에서 필터를 다시
//     만들어 header 를 계산하고 벡터 값과 일치함을 확인했다. 블록해시도 블록
//     원문에서 다시 구했고, 높이는 코인베이스 scriptSig 의 BIP34 높이와 대조했다.
//
// 재현: node scripts/btc-p2p/build-checkpoints.mjs   (일치하면 exit 0)
//
// ---------------------------------------------------------------------------
// 미확보 (넣지 않은 것)
// ---------------------------------------------------------------------------
// mainnet 은 제네시스 하나뿐이다. mainnet 의 임의 높이 filter header 를
// 오프라인으로 검증할 원천(공식 벡터·스펙 문서)이 없기 때문이다. 10만 단위
// 체크포인트를 넣으려면 신뢰하는 풀노드에서 getcfheaders 로 직접 받아 복수
// 피어로 교차 확인한 뒤 build-checkpoints.mjs 에 원천을 명시해 추가한다.
// 그 전까지 mainnet 스캔은 제네시스부터 시작하거나, 호출부가 자체 확보한
// 체크포인트를 ScanOptions.checkpoint 로 직접 넣어야 한다.

import { displayHashToInternal } from './messages.js';
import type { ScanCheckpoint } from './scan.js';

// ---------------------------------------------------------------------------
// 타입
// ---------------------------------------------------------------------------

/** 체크포인트를 제공하는 네트워크. */
export type BtcFilterNetwork = 'mainnet' | 'testnet3';

/** 값의 출처 — 위 주석의 재현 절차와 1:1 대응. */
export type CheckpointSource = 'genesis-computed' | 'bip158-test-vectors';

/** 저장 형태 — 해시는 사람이 읽는 display hex(빅엔디언 표기, 익스플로러와 같은 순서). */
export interface FilterCheckpoint {
  height: number;
  /** 블록해시, display hex. */
  blockHash: string;
  /** 이 블록의 basic filter header, display hex. */
  filterHeader: string;
  source: CheckpointSource;
}

// ---------------------------------------------------------------------------
// 데이터 — build-checkpoints.mjs --emit 산출물
// ---------------------------------------------------------------------------

/** mainnet 체크포인트 — 제네시스만. 그 외 높이는 미확보(오프라인 검증 원천 없음). */
export const MAINNET_FILTER_CHECKPOINTS: readonly FilterCheckpoint[] = [
  {
    height: 0,
    blockHash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
    filterHeader: '02c2392180d0ce2b5b6f8b08d39a11ffe831c673311a3ecf77b97fc3f0303c9f',
    source: 'genesis-computed',
  },
];

/** testnet3 체크포인트 — 제네시스 + BIP158 공식 벡터에서 재계산한 높이들. */
export const TESTNET3_FILTER_CHECKPOINTS: readonly FilterCheckpoint[] = [
  {
    height: 0,
    blockHash: '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943',
    filterHeader: '21584579b7eb08997773e5aeff3a7f932700042d0ed2a6129012b7d7ae81b750',
    source: 'genesis-computed',
  },
  {
    height: 49291,
    blockHash: '0000000018b07dca1b28b4b5a119f6d6e71698ce1ed96f143f54179ce177a19c',
    filterHeader: 'b6d98692cec5145f67585f3434ec3c2b3030182e1cb3ec58b855c5c164dfaaa3',
    source: 'bip158-test-vectors',
  },
  {
    height: 987876,
    blockHash: '0000000000000c00901f2049055e2a437c819d79a3d54fd63e6af796cd7b8a79',
    filterHeader: '0965a544743bbfa36f254446e75630c09404b3d164a261892372977538928ed5',
    source: 'bip158-test-vectors',
  },
  {
    height: 1263442,
    blockHash: '000000006f27ddfe1dd680044a34548f41bed47eba9e6f0b310da21423bc5f33',
    filterHeader: '4e6d564c2a2452065c205dd7eb2791124e0c4e0dbb064c410c24968572589dec',
    source: 'bip158-test-vectors',
  },
  {
    height: 1414221,
    blockHash: '0000000000000027b2b3b3381f114f674f481544ff2be37ae3788d7e078383b1',
    filterHeader: '021e8882ef5a0ed932edeebbecfeda1d7ce528ec7b3daa27641acf1189d7b5dc',
    source: 'bip158-test-vectors',
  },
];

/** 네트워크 → 체크포인트 목록 (높이 오름차순). */
export const FILTER_CHECKPOINTS: Readonly<Record<BtcFilterNetwork, readonly FilterCheckpoint[]>> =
  {
    mainnet: MAINNET_FILTER_CHECKPOINTS,
    testnet3: TESTNET3_FILTER_CHECKPOINTS,
  };

// ---------------------------------------------------------------------------
// 조회
// ---------------------------------------------------------------------------

/** 해당 네트워크의 체크포인트 전부 (높이 오름차순, 최소 1개 = 제네시스). */
export function getFilterCheckpoints(
  network: BtcFilterNetwork,
): readonly FilterCheckpoint[] {
  return FILTER_CHECKPOINTS[network];
}

/** 저장 형태(display hex) → scan.ts 가 받는 형태(internal 바이트). */
export function toScanCheckpoint(cp: FilterCheckpoint): ScanCheckpoint {
  return {
    height: cp.height,
    blockHash: displayHashToInternal(cp.blockHash),
    filterHeader: displayHashToInternal(cp.filterHeader),
  };
}

/** 제네시스(높이 0) 체크포인트. 전량 스캔의 시작점. */
export function getGenesisCheckpoint(network: BtcFilterNetwork): ScanCheckpoint {
  const list = getFilterCheckpoints(network);
  const genesis = list.find((c) => c.height === 0);
  if (genesis === undefined) {
    throw new Error(`checkpoints: ${network} has no genesis checkpoint`);
  }
  return toScanCheckpoint(genesis);
}

/** 가장 높은 체크포인트. 새 지갑(그 이전 이력이 없다고 아는 경우)의 시작점. */
export function getLatestCheckpoint(network: BtcFilterNetwork): ScanCheckpoint {
  const list = getFilterCheckpoints(network);
  let best: FilterCheckpoint | undefined;
  for (const cp of list) {
    if (best === undefined || cp.height > best.height) best = cp;
  }
  if (best === undefined) {
    throw new Error(`checkpoints: ${network} has no checkpoints`);
  }
  return toScanCheckpoint(best);
}

/**
 * height 이하의 체크포인트 중 가장 높은 것.
 * 예: 지갑 생성 높이를 알면 그 이전 구간을 통째로 건너뛴다.
 * height 가 0 미만이거나 해당하는 게 없으면 제네시스를 준다.
 */
export function getCheckpointAtOrBefore(
  network: BtcFilterNetwork,
  height: number,
): ScanCheckpoint {
  const list = getFilterCheckpoints(network);
  let best: FilterCheckpoint | undefined;
  for (const cp of list) {
    if (cp.height > height) continue;
    if (best === undefined || cp.height > best.height) best = cp;
  }
  if (best === undefined) return getGenesisCheckpoint(network);
  return toScanCheckpoint(best);
}
