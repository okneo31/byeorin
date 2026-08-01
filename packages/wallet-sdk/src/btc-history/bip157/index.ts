// index.ts — BIP157/158 라이트클라이언트 모듈 배럴.
//
// BTC 이력 트랙 C: 제3자 인덱서 0 의존 주소 이력 스캔.
// 전송은 ../transport.ts 의 ByteTransport 로 주입 — 이 모듈은 순수 TS, 전송 무관.

export {
  // 바이트 유틸
  concatBytes,
  bytesEqual,
  reverseBytes,
  hexToBytes,
  bytesToHex,
  displayHashToInternal,
  internalHashToDisplay,
  dsha256,
  ZERO_HASH,
  encodeVarint,
  decodeVarint,
  ByteReader,
  ByteWriter,
  // 와이어 메시지
  PROTOCOL_VERSION,
  FILTER_TYPE_BASIC,
  MAX_CFHEADERS_PER_REQUEST,
  MAX_CFILTERS_PER_REQUEST,
  INV_BLOCK,
  INV_WITNESS_BLOCK,
  decodeBlockHeader,
  encodeGetHeaders,
  decodeHeadersMessage,
  encodeGetCfHeaders,
  decodeCfHeaders,
  encodeGetCfilters,
  decodeCfilter,
  encodeGetData,
  decodeTx,
  computeMerkleRoot,
  decodeBlock,
  isCoinbase,
} from './messages.js';
export type {
  BlockHeader,
  CfHeadersMessage,
  CfilterMessage,
  TxInput,
  TxOutput,
  DecodedTx,
  DecodedBlock,
} from './messages.js';

export {
  MAINNET_MAGIC,
  TESTNET_MAGIC,
  SERVICE_NODE_NETWORK,
  SERVICE_NODE_WITNESS,
  SERVICE_NODE_COMPACT_FILTERS,
  hasCompactFilters,
  checksum,
  encodeCommand,
  decodeCommand,
  encodeMessage,
  P2PFrameDecoder,
  DEFAULT_USER_AGENT,
  buildVersionPayload,
  parseVersionPayload,
  buildVerackMessage,
  buildPingPayload,
  parsePingPayload,
  buildPongPayload,
} from './p2p.js';
export type { P2PMessage, VersionFields, BuildVersionOptions } from './p2p.js';

export {
  siphash24,
  GCS_P,
  GCS_M,
  filterKeyFromBlockHash,
  hashToRange,
  encodeGcsFilter,
  decodeGcsFilterValues,
  gcsMatchAny,
  computeFilterHash,
  computeFilterHeader,
} from './gcs.js';

export { bip157Scan } from './scan.js';
export type {
  ScanCheckpoint,
  ScanOptions,
  ScanTxRecord,
  ScanResult,
} from './scan.js';
