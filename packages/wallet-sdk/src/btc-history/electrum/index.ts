// btc-history/electrum — Electrum 프로토콜 클라이언트 SDK 모듈 배럴.
// 전송(ByteTransport)은 ../transport.ts 계약으로 주입받는다.
// 주의: 패키지 공유 배럴(src/index.ts)·exports 연결은 오케스트레이터 몫 —
// 여기서는 이 모듈 내부 표면만 모은다.

export {
  ElectrumClient,
  ElectrumError,
  type ElectrumClientOptions,
  type ElectrumRequestOptions,
  type ElectrumBalance,
  type ElectrumHeader,
} from './client.js';

export {
  addressToScriptPubKey,
  scriptPubKeyToScripthash,
  addressToScripthash,
} from './scripthash.js';

export {
  toActivityRows,
  isElectrumHistoryItem,
  type ElectrumHistoryItem,
  type BtcActivityRow,
} from './history.js';

export { isByteTransport, type ByteTransport, type ByteTransportOptions } from '../transport.js';
