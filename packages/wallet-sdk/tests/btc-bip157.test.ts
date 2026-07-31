// btc-bip157.test.ts — BIP157/158 라이트클라이언트 모듈 결정적 테스트 (네트워크 없음).
//
// 공식 테스트 벡터 출처:
//   - SipHash-2-4: SipHash 논문(Aumasson & Bernstein) 레퍼런스 구현
//     https://github.com/veorq/SipHash — vectors.h 의 vectors_sip64
//     (키 000102…0f, 메시지 = 길이 0..63 의 00,01,02,… 연속 바이트, 출력 8바이트 LE).
//   - BIP158 GCS: bitcoin/bips 저장소 bip-0158/testnet-19.json
//     https://github.com/bitcoin/bips/blob/master/bip-0158/testnet-19.json
//     (testnet3 블록 — basic filter 파라미터 P=19, M=784931 은 mainnet 과 동일).
//   두 벡터 모두 2026-07-31 원본에서 그대로 복사 — 지어낸 값 없음.

import { describe, expect, it } from 'vitest';
import {
  ByteReader,
  DecodedBlock,
  GCS_M,
  GCS_P,
  MAINNET_MAGIC,
  P2PFrameDecoder,
  buildPingPayload,
  buildPongPayload,
  buildVersionPayload,
  bytesToHex,
  computeFilterHash,
  computeFilterHeader,
  decodeBlock,
  decodeCfHeaders,
  decodeCfilter,
  decodeGcsFilterValues,
  decodeHeadersMessage,
  decodeVarint,
  displayHashToInternal,
  encodeGcsFilter,
  encodeGetCfHeaders,
  encodeGetCfilters,
  encodeGetData,
  encodeGetHeaders,
  encodeMessage,
  encodeVarint,
  filterKeyFromBlockHash,
  gcsMatchAny,
  hasCompactFilters,
  hexToBytes,
  internalHashToDisplay,
  parsePingPayload,
  parseVersionPayload,
  siphash24,
  SERVICE_NODE_COMPACT_FILTERS,
} from '../src/btc-history/bip157/index.js';

// ---------------------------------------------------------------------------
// varint (CompactSize)
// ---------------------------------------------------------------------------

describe('bip157/messages — varint', () => {
  it('encodes boundary values with the correct width', () => {
    expect(bytesToHex(encodeVarint(0))).toBe('00');
    expect(bytesToHex(encodeVarint(0xfc))).toBe('fc');
    expect(bytesToHex(encodeVarint(0xfd))).toBe('fdfd00');
    expect(bytesToHex(encodeVarint(0xffff))).toBe('fdffff');
    expect(bytesToHex(encodeVarint(0x10000))).toBe('fe00000100');
    expect(bytesToHex(encodeVarint(0xffffffff))).toBe('feffffffff');
    expect(bytesToHex(encodeVarint(0x100000000n))).toBe('ff0000000001000000');
    expect(bytesToHex(encodeVarint(0xffffffffffffffffn))).toBe('ffffffffffffffffff');
  });

  it('round-trips across all widths', () => {
    for (const v of [0n, 1n, 0xfcn, 0xfdn, 0x1234n, 0xffffn, 0x10000n, 0xdeadbeefn, 0x100000000n, 0xffffffffffffffffn]) {
      const enc = encodeVarint(v);
      const { value, size } = decodeVarint(enc, 0);
      expect(value).toBe(v);
      expect(size).toBe(enc.length);
    }
  });

  it('respects offsets and rejects truncated input', () => {
    const buf = new Uint8Array([0xaa, ...encodeVarint(0xffff)]);
    expect(decodeVarint(buf, 1).value).toBe(0xffffn);
    expect(() => decodeVarint(new Uint8Array([0xfd, 0x01]), 0)).toThrow(/truncated/);
    expect(() => decodeVarint(new Uint8Array(0), 0)).toThrow(/out of bounds/);
  });
});

// ---------------------------------------------------------------------------
// P2P 프레이밍
// ---------------------------------------------------------------------------

describe('bip157/p2p — framing', () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5]);

  it('encodes the frame header layout (magic|command|length|checksum)', () => {
    const frame = encodeMessage('ping', buildPingPayload(0x1122334455667788n));
    expect(bytesToHex(frame.subarray(0, 4))).toBe('f9beb4d9'); // mainnet magic
    expect(bytesToHex(frame.subarray(4, 16))).toBe('70696e670000000000000000'); // "ping" + null 패딩
    expect(bytesToHex(frame.subarray(16, 20))).toBe('08000000'); // length 8 LE
    expect(frame.length).toBe(24 + 8);
  });

  it('round-trips through the decoder fed one byte at a time', () => {
    const frame = encodeMessage('getcfilters', payload);
    const dec = new P2PFrameDecoder();
    const got: { command: string; payload: Uint8Array }[] = [];
    for (const b of frame) got.push(...dec.push(new Uint8Array([b])));
    expect(got).toHaveLength(1);
    expect(got[0]!.command).toBe('getcfilters');
    expect(bytesToHex(got[0]!.payload)).toBe(bytesToHex(payload));
  });

  it('splits multiple messages arriving in one chunk', () => {
    const a = encodeMessage('verack', new Uint8Array(0));
    const b = encodeMessage('ping', buildPingPayload(7n));
    const chunk = new Uint8Array([...a, ...b]);
    const dec = new P2PFrameDecoder();
    const got = dec.push(chunk);
    expect(got.map((m) => m.command)).toEqual(['verack', 'ping']);
  });

  it('throws on checksum corruption', () => {
    const frame = encodeMessage('ping', buildPingPayload(1n));
    const last = frame.length - 1;
    frame[last] = frame[last]! ^ 0xff; // 페이로드 마지막 바이트 훼손
    expect(() => new P2PFrameDecoder().push(frame)).toThrow(/checksum/);
  });

  it('throws on bad magic (stream out of sync)', () => {
    const frame = encodeMessage('ping', buildPingPayload(1n));
    frame[0] = 0x00;
    expect(() => new P2PFrameDecoder().push(frame)).toThrow(/magic/);
  });
});

// ---------------------------------------------------------------------------
// version / verack / ping
// ---------------------------------------------------------------------------

describe('bip157/p2p — version handshake payloads', () => {
  it('builds and parses a version payload round-trip', () => {
    const payload = buildVersionPayload({
      services: 0n,
      timestampSec: 1_753_900_000n,
      nonce: 0x0123456789abcdefn,
      userAgent: '/byeorin-test:1.0/',
      startHeight: 850_000,
      relay: false,
    });
    const v = parseVersionPayload(payload);
    expect(v.version).toBe(70016);
    expect(v.services).toBe(0n);
    expect(v.timestamp).toBe(1_753_900_000n);
    expect(v.nonce).toBe(0x0123456789abcdefn);
    expect(v.userAgent).toBe('/byeorin-test:1.0/');
    expect(v.startHeight).toBe(850_000);
    expect(v.relay).toBe(false);
  });

  it('has the fixed-layout prefix (version|services|timestamp|2×net_addr) before nonce', () => {
    const payload = buildVersionPayload({ timestampSec: 0n, nonce: 0n, userAgent: '' });
    // 4 + 8 + 8 + 26 + 26 = 72바이트 뒤에 nonce
    expect(payload.length).toBe(72 + 8 + 1 + 0 + 4 + 1);
    expect(bytesToHex(payload.subarray(0, 4))).toBe('80110100'); // 70016 LE
  });

  it('detects NODE_COMPACT_FILTERS (0x40) in the services bitfield', () => {
    expect(SERVICE_NODE_COMPACT_FILTERS).toBe(0x40n);
    expect(hasCompactFilters(0x40n)).toBe(true);
    expect(hasCompactFilters(0x40n | 0x9n)).toBe(true);
    expect(hasCompactFilters(0x9n)).toBe(false); // NODE_NETWORK|NODE_WITNESS 만
  });

  it('answers ping with a pong carrying the same nonce', () => {
    const ping = buildPingPayload(0xdeadbeefcafef00dn);
    expect(parsePingPayload(ping)).toBe(0xdeadbeefcafef00dn);
    expect(bytesToHex(buildPongPayload(parsePingPayload(ping)))).toBe(bytesToHex(ping));
  });
});

// ---------------------------------------------------------------------------
// SipHash-2-4 — 공식 벡터 (veorq/SipHash vectors.h, vectors_sip64)
// ---------------------------------------------------------------------------

// 출력 8바이트 LE hex. 인덱스 i 의 메시지 = [0x00, 0x01, …, i-1].
const SIPHASH_VECTORS = [
  '310e0edd47db6f72', 'fd67dc93c539f874', '5a4fa9d909806c0d', '2d7efbd796666785',
  'b7877127e09427cf', '8da699cd64557618', 'cee3fe586e46c9cb', '37d1018bf50002ab',
  '6224939a79f5f593', 'b0e4a90bdf82009e', 'f3b9dd94c5bb5d7a', 'a7ad6b22462fb3f4',
  'fbe50e86bc8f1e75', '903d84c02756ea14', 'eef27a8e90ca23f7', 'e545be4961ca29a1',
  'db9bc2577fcc2a3f', '9447be2cf5e99a69', '9cd38d96f0b3c14b', 'bd6179a71dc96dbb',
  '98eea21af25cd6be', 'c7673b2eb0cbf2d0', '883ea3e395675393', 'c8ce5ccd8c030ca8',
  '94af49f6c650adb8', 'eab8858ade92e1bc', 'f315bb5bb835d817', 'adcf6b0763612e2f',
  'a5c91da7acaa4dde', '716595876650a2a6', '28ef495c53a387ad', '42c341d8fa92d832',
  'ce7cf2722f512771', 'e37859f94623f3a7', '381205bb1ab0e012', 'ae97a10fd434e015',
  'b4a31508beff4d31', '81396229f0907902', '4d0cf49ee5d4dcca', '5c73336a76d8bf9a',
  'd0a704536ba93e0e', '925958fcd6420cad', 'a915c29bc8067318', '952b79f3bc0aa6d4',
  'f21df2e41d4535f9', '87577519048f53a9', '10a56cf5dfcd9adb', 'eb75095ccd986cd0',
  '51a9cb9ecba312e6', '96afadfc2ce666c7', '72fe52975a4364ee', '5a1645b276d592a1',
  'b274cb8ebf87870a', '6f9bb4203de7b381', 'eaecb2a30b22a87f', '9924a43cc1315724',
  'bd838d3aafbf8db7', '0b1a2a3265d51aea', '135079a3231ce660', '932b2846e4d70666',
  'e1915f5cb1eca46c', 'f325965ca16d629f', '575ff28e60381be5', '724506eb4c328a95',
];

function u64ToLEHex(v: bigint): string {
  const b = new Uint8Array(8);
  for (let i = 0; i < 8; i++) b[i] = Number((v >> BigInt(8 * i)) & 0xffn);
  return bytesToHex(b);
}

describe('bip157/gcs — siphash-2-4 official vectors', () => {
  const key = hexToBytes('000102030405060708090a0b0c0d0e0f');

  it('matches all 64 reference vectors (message lengths 0..63)', () => {
    for (let len = 0; len < 64; len++) {
      const msg = new Uint8Array(len);
      for (let i = 0; i < len; i++) msg[i] = i;
      expect(u64ToLEHex(siphash24(key, msg)), `len=${len}`).toBe(SIPHASH_VECTORS[len]);
    }
  });

  it('rejects keys that are not 16 bytes', () => {
    expect(() => siphash24(new Uint8Array(15), new Uint8Array(0))).toThrow(/16 bytes/);
  });
});

// ---------------------------------------------------------------------------
// BIP158 GCS — 공식 벡터 (bitcoin/bips bip-0158/testnet-19.json 발췌 8개)
// ---------------------------------------------------------------------------

interface Bip158Vector {
  height: number;
  blockHash: string; // display hex
  block: string; // full block hex
  prevOutputScripts: string[]; // 이 블록 입력들이 소비한 출력 스크립트
  prevHeader: string; // 이전 basic filter header (display hex)
  filter: string; // basic filter hex (N varint 포함)
  header: string; // 이 블록 basic filter header (display hex)
}

const BIP158_VECTORS: Bip158Vector[] = [
  { height: 0, blockHash: '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943', block: '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4adae5494dffff001d1aa4ae180101000000010000000000000000000000000000000000000000000000000000000000000000ffffffff4d04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000', prevOutputScripts: [], prevHeader: '0000000000000000000000000000000000000000000000000000000000000000', filter: '019dfca8', header: '21584579b7eb08997773e5aeff3a7f932700042d0ed2a6129012b7d7ae81b750' },
  { height: 2, blockHash: '000000006c02c8ea6e4ff69651f7fcde348fb9d557a06e6957b65552002a7820', block: '0100000006128e87be8b1b4dea47a7247d5528d2702c96826c7a648497e773b800000000e241352e3bec0a95a6217e10c3abb54adfa05abb12c126695595580fb92e222032e7494dffff001d00d235340101000000010000000000000000000000000000000000000000000000000000000000000000ffffffff0e0432e7494d010e062f503253482fffffffff0100f2052a010000002321038a7f6ef1c8ca0c588aa53fa860128077c9e6c11e6830f4d7ee4e763a56b7718fac00000000', prevOutputScripts: [], prevHeader: 'd7bdac13a59d745b1add0d2ce852f1a0442e8945fc1bf3848d3cbffd88c24fe1', filter: '0174a170', header: '186afd11ef2b5e7e3504f2e8cbf8df28a1fd251fe53d60dff8b1467d1b386cf0' },
  { height: 3, blockHash: '000000008b896e272758da5297bcd98fdc6d97c9b765ecec401e286dc1fdbe10', block: '0100000020782a005255b657696ea057d5b98f34defcf75196f64f6eeac8026c0000000041ba5afc532aae03151b8aa87b65e1594f97504a768e010c98c0add79216247186e7494dffff001d058dc2b60101000000010000000000000000000000000000000000000000000000000000000000000000ffffffff0e0486e7494d0151062f503253482fffffffff0100f2052a01000000232103f6d9ff4c12959445ca5549c811683bf9c88e637b222dd2e0311154c4c85cf423ac00000000', prevOutputScripts: [], prevHeader: '186afd11ef2b5e7e3504f2e8cbf8df28a1fd251fe53d60dff8b1467d1b386cf0', filter: '016cf7a0', header: '8d63aadf5ab7257cb6d2316a57b16f517bff1c6388f124ec4c04af1212729d2a' },
  { height: 15007, blockHash: '0000000038c44c703bae0f98cdd6bf30922326340a5996cc692aaae8bacf47ad', block: '0100000002394092aa378fe35d7e9ac79c869b975c4de4374cd75eb5484b0e1e00000000eb9b8670abd44ad6c55cee18e3020fb0c6519e7004b01a16e9164867531b67afc33bc94fffff001d123f10050101000000010000000000000000000000000000000000000000000000000000000000000000ffffffff0e04c33bc94f0115062f503253482fffffffff0100f2052a01000000232103f268e9ae07e0f8cb2f6e901d87c510d650b97230c0365b021df8f467363cafb1ac00000000', prevOutputScripts: [], prevHeader: '18b5c2b0146d2d09d24fb00ff5b52bd0742f36c9e65527abdb9de30c027a4748', filter: '013c3710', header: '07384b01311867949e0c046607c66b7a766d338474bb67f66c8ae9dbd454b20e' },
  { height: 49291, blockHash: '0000000018b07dca1b28b4b5a119f6d6e71698ce1ed96f143f54179ce177a19c', block: '02000000abfaf47274223ca2fea22797e44498240e482cb4c2f2baea088962f800000000604b5b52c32305b15d7542071d8b04e750a547500005d4010727694b6e72a776e55d0d51ffff001d211806480201000000010000000000000000000000000000000000000000000000000000000000000000ffffffff0d038bc0000102062f503253482fffffffff01a078072a01000000232102971dd6034ed0cf52450b608d196c07d6345184fcb14deb277a6b82d526a6163dac0000000001000000081cefd96060ecb1c4fbe675ad8a4f8bdc61d634c52b3a1c4116dee23749fe80ff000000009300493046022100866859c21f306538152e83f115bcfbf59ab4bb34887a88c03483a5dff9895f96022100a6dfd83caa609bf0516debc2bf65c3df91813a4842650a1858b3f61cfa8af249014730440220296d4b818bb037d0f83f9f7111665f49532dfdcbec1e6b784526e9ac4046eaa602204acf3a5cb2695e8404d80bf49ab04828bcbe6fc31d25a2844ced7a8d24afbdff01ffffffff1cefd96060ecb1c4fbe675ad8a4f8bdc61d634c52b3a1c4116dee23749fe80ff020000009400483045022100e87899175991aa008176cb553c6f2badbb5b741f328c9845fcab89f8b18cae2302200acce689896dc82933015e7230e5230d5cff8a1ffe82d334d60162ac2c5b0c9601493046022100994ad29d1e7b03e41731a4316e5f4992f0d9b6e2efc40a1ccd2c949b461175c502210099b69fdc2db00fbba214f16e286f6a49e2d8a0d5ffc6409d87796add475478d601ffffffff1e4a6d2d280ea06680d6cf8788ac90344a9c67cca9b06005bbd6d3f6945c8272010000009500493046022100a27400ba52fd842ce07398a1de102f710a10c5599545e6c95798934352c2e4df022100f6383b0b14c9f64b6718139f55b6b9494374755b86bae7d63f5d3e583b57255a01493046022100fdf543292f34e1eeb1703b264965339ec4a450ec47585009c606b3edbc5b617b022100a5fbb1c8de8aaaa582988cdb23622838e38de90bebcaab3928d949aa502a65d401ffffffff1e4a6d2d280ea06680d6cf8788ac90344a9c67cca9b06005bbd6d3f6945c8272020000009400493046022100ac626ac3051f875145b4fe4cfe089ea895aac73f65ab837b1ac30f5d875874fa022100bc03e79fa4b7eb707fb735b95ff6613ca33adeaf3a0607cdcead4cfd3b51729801483045022100b720b04a5c5e2f61b7df0fcf334ab6fea167b7aaede5695d3f7c6973496adbf1022043328c4cc1cdc3e5db7bb895ccc37133e960b2fd3ece98350f774596badb387201ffffffff23a8733e349c97d6cd90f520fdd084ba15ce0a395aad03cd51370602bb9e5db3010000004a00483045022100e8556b72c5e9c0da7371913a45861a61c5df434dfd962de7b23848e1a28c86ca02205d41ceda00136267281be0974be132ac4cda1459fe2090ce455619d8b91045e901ffffffff6856d609b881e875a5ee141c235e2a82f6b039f2b9babe82333677a5570285a6000000006a473044022040a1c631554b8b210fbdf2a73f191b2851afb51d5171fb53502a3a040a38d2c0022040d11cf6e7b41fe1b66c3d08f6ada1aee07a047cb77f242b8ecc63812c832c9a012102bcfad931b502761e452962a5976c79158a0f6d307ad31b739611dac6a297c256ffffffff6856d609b881e875a5ee141c235e2a82f6b039f2b9babe82333677a5570285a601000000930048304502205b109df098f7e932fbf71a45869c3f80323974a826ee2770789eae178a21bfc8022100c0e75615e53ee4b6e32b9bb5faa36ac539e9c05fa2ae6b6de5d09c08455c8b9601483045022009fb7d27375c47bea23b24818634df6a54ecf72d52e0c1268fb2a2c84f1885de022100e0ed4f15d62e7f537da0d0f1863498f9c7c0c0a4e00e4679588c8d1a9eb20bb801ffffffffa563c3722b7b39481836d5edfc1461f97335d5d1e9a23ade13680d0e2c1c371f030000006c493046022100ecc38ae2b1565643dc3c0dad5e961a5f0ea09cab28d024f92fa05c922924157e022100ebc166edf6fbe4004c72bfe8cf40130263f98ddff728c8e67b113dbd621906a601210211a4ed241174708c07206601b44a4c1c29e5ad8b1f731c50ca7e1d4b2a06dc1fffffffff02d0223a00000000001976a91445db0b779c0b9fa207f12a8218c94fc77aff504588ac80f0fa02000000000000000000', prevOutputScripts: ['5221033423007d8f263819a2e42becaaf5b06f34cb09919e06304349d950668209eaed21021d69e2b68c3960903b702af7829fadcd80bd89b158150c85c4a75b2c8cb9c39452ae', '52210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f8179821021d69e2b68c3960903b702af7829fadcd80bd89b158150c85c4a75b2c8cb9c39452ae', '522102a7ae1e0971fc1689bd66d2a7296da3a1662fd21a53c9e38979e0f090a375c12d21022adb62335f41eb4e27056ac37d462cda5ad783fa8e0e526ed79c752475db285d52ae', '52210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f8179821022adb62335f41eb4e27056ac37d462cda5ad783fa8e0e526ed79c752475db285d52ae', '512103b9d1d0e2b4355ec3cdef7c11a5c0beff9e8b8d8372ab4b4e0aaf30e80173001951ae', '76a9149144761ebaccd5b4bbdc2a35453585b5637b2f8588ac', '522103f1848b40621c5d48471d9784c8174ca060555891ace6d2b03c58eece946b1a9121020ee5d32b54d429c152fdc7b1db84f2074b0564d35400d89d11870f9273ec140c52ae', '76a914f4fa1cc7de742d135ea82c17adf0bb9cf5f4fb8388ac'], prevHeader: 'ed47705334f4643892ca46396eb3f4196a5e30880589e4009ef38eae895d4a13', filter: '0afbc2920af1b027f31f87b592276eb4c32094bb4d3697021b4c6380', header: 'b6d98692cec5145f67585f3434ec3c2b3030182e1cb3ec58b855c5c164dfaaa3' },
  { height: 987876, blockHash: '0000000000000c00901f2049055e2a437c819d79a3d54fd63e6af796cd7b8a79', block: '000000202694f74969fdb542090e95a56bc8aa2d646e27033850e32f1c5f000000000000f7e53676b3f12d5beb524ed617f2d25f5a93b5f4f52c1ba2678260d72712f8dd0a6dfe5740257e1a4b1768960101000000010000000000000000000000000000000000000000000000000000000000000000ffffffff1603e4120ff9c30a1c216900002f424d4920546573742fffffff0001205fa012000000001e76a914c486de584a735ec2f22da7cd9681614681f92173d83d0aa68688ac00000000', prevOutputScripts: [], prevHeader: 'fe4d230dbb0f4fec9bed23a5283e08baf996e3f32b93f52c7de1f641ddfd04ad', filter: '010c0b40', header: '0965a544743bbfa36f254446e75630c09404b3d164a261892372977538928ed5' },
  { height: 1263442, blockHash: '000000006f27ddfe1dd680044a34548f41bed47eba9e6f0b310da21423bc5f33', block: '000000201c8d1a529c39a396db2db234d5ec152fa651a2872966daccbde028b400000000083f14492679151dbfaa1a825ef4c18518e780c1f91044180280a7d33f4a98ff5f45765aaddc001d38333b9a02010000000001010000000000000000000000000000000000000000000000000000000000000000ffffffff230352471300fe5f45765afe94690a000963676d696e6572343208000000000000000000ffffffff024423a804000000001976a914f2c25ac3d59f3d674b1d1d0a25c27339aaac0ba688ac0000000000000000266a24aa21a9edcb26cb3052426b9ebb4d19c819ef87c19677bbf3a7c46ef0855bd1b2abe83491012000000000000000000000000000000000000000000000000000000000000000000000000002000000000101d20978463906ba4ff5e7192494b88dd5eb0de85d900ab253af909106faa22cc5010000000004000000014777ff000000000016001446c29eabe8208a33aa1023c741fa79aa92e881ff0347304402207d7ca96134f2bcfdd6b536536fdd39ad17793632016936f777ebb32c22943fda02206014d2fb8a6aa58279797f861042ba604ebd2f8f61e5bddbd9d3be5a245047b201004b632103eeaeba7ce5dc2470221e9517fb498e8d6bd4e73b85b8be655196972eb9ccd5566754b2752103a40b74d43df244799d041f32ce1ad515a6cd99501701540e38750d883ae21d3a68ac00000000', prevOutputScripts: ['002027a5000c7917f785d8fc6e5a55adfca8717ecb973ebb7743849ff956d896a7ed'], prevHeader: '31d66d516a9eda7de865df29f6ef6cb8e4bf9309e5dac899968a9a62a5df61e3', filter: '0385acb4f0fe889ef0', header: '4e6d564c2a2452065c205dd7eb2791124e0c4e0dbb064c410c24968572589dec' },
  { height: 1414221, blockHash: '0000000000000027b2b3b3381f114f674f481544ff2be37ae3788d7e078383b1', block: '000000204ea88307a7959d8207968f152bedca5a93aefab253f1fb2cfb032a400000000070cebb14ec6dbc27a9dfd066d9849a4d3bac5f674665f73a5fe1de01a022a0c851fda85bf05f4c19a779d1450102000000010000000000000000000000000000000000000000000000000000000000000000ffffffff18034d94154d696e6572476174653030310d000000f238f401ffffffff01c817a804000000000000000000', prevOutputScripts: [], prevHeader: '5e5e12d90693c8e936f01847859404c67482439681928353ca1296982042864e', filter: '00', header: '021e8882ef5a0ed932edeebbecfeda1d7ce528ec7b3daa27641acf1189d7b5dc' },
];

/** BIP158 basic filter 내용 규칙: 출력 스크립트(빈 것·OP_RETURN 제외) + 소비된 이전 출력 스크립트(빈 것 제외). */
function basicFilterItems(block: DecodedBlock, prevOutputScripts: string[]): Uint8Array[] {
  const items: Uint8Array[] = [];
  for (const tx of block.transactions) {
    for (const out of tx.outputs) {
      if (out.scriptPubKey.length > 0 && out.scriptPubKey[0] !== 0x6a) items.push(out.scriptPubKey);
    }
  }
  for (const hex of prevOutputScripts) if (hex.length > 0) items.push(hexToBytes(hex));
  return items;
}

describe('bip157/gcs — BIP158 official vectors', () => {
  for (const vec of BIP158_VECTORS) {
    describe(`testnet block ${vec.height}`, () => {
      const block = decodeBlock(hexToBytes(vec.block));
      const blockHashInternal = displayHashToInternal(vec.blockHash);
      const key = filterKeyFromBlockHash(blockHashInternal);
      const items = basicFilterItems(block, vec.prevOutputScripts);
      const filterBytes = hexToBytes(vec.filter);

      it('block decode reproduces the header hash', () => {
        expect(internalHashToDisplay(block.header.hash)).toBe(vec.blockHash);
      });

      it('encoding the filter contents reproduces the official filter bytes', () => {
        expect(bytesToHex(encodeGcsFilter(items, key))).toBe(vec.filter);
      });

      it('every filter item matches; a foreign script does not', () => {
        for (const item of items) {
          expect(gcsMatchAny(filterBytes, key, [item])).toBe(true);
        }
        // 결정적 비회원 스크립트 — 오탐 확률 ≈ 1/784931, 고정 입력이므로 결과 결정적
        const foreign = hexToBytes('76a914deadbeefdeadbeefdeadbeefdeadbeefdeadbeef88ac');
        expect(gcsMatchAny(filterBytes, key, [foreign])).toBe(false);
      });

      it('filter header chain matches the official header', () => {
        const header = computeFilterHeader(
          computeFilterHash(filterBytes),
          displayHashToInternal(vec.prevHeader),
        );
        expect(internalHashToDisplay(header)).toBe(vec.header);
      });
    });
  }

  it('decodes the empty filter (height 1414221) as N=0', () => {
    expect(decodeGcsFilterValues(hexToBytes('00'))).toEqual({ n: 0, values: [] });
    expect(gcsMatchAny(hexToBytes('00'), new Uint8Array(16), [new Uint8Array([1])])).toBe(false);
  });
});

describe('bip157/gcs — round-trip on synthetic sets', () => {
  const key = hexToBytes('0f0e0d0c0b0a09080706050403020100');

  /** 결정적 의사난수 항목 — siphash 로부터 파생 (외부 의존 없음). */
  function syntheticItems(count: number): Uint8Array[] {
    const items: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      const seed = new Uint8Array([i & 0xff, (i >> 8) & 0xff]);
      const h = siphash24(key, seed);
      const item = new Uint8Array(25);
      for (let j = 0; j < 8; j++) item[j] = Number((h >> BigInt(8 * j)) & 0xffn);
      item[24] = i & 0xff;
      items.push(item);
    }
    return items;
  }

  it('encode → decode recovers exactly N sorted values', () => {
    const items = syntheticItems(200);
    const filter = encodeGcsFilter(items, key);
    const { n, values } = decodeGcsFilterValues(filter);
    expect(n).toBe(200);
    expect(values).toHaveLength(200);
    for (let i = 1; i < values.length; i++) expect(values[i]! >= values[i - 1]!).toBe(true);
  });

  it('all members match; parameters are the BIP158 basic ones', () => {
    expect(GCS_P).toBe(19);
    expect(GCS_M).toBe(784931);
    const items = syntheticItems(50);
    const filter = encodeGcsFilter(items, key);
    expect(gcsMatchAny(filter, key, items)).toBe(true);
    for (const item of items) expect(gcsMatchAny(filter, key, [item])).toBe(true);
  });

  it('deduplicates identical raw items before counting N', () => {
    const items = syntheticItems(10);
    const withDupes = [...items, ...items];
    expect(bytesToHex(encodeGcsFilter(withDupes, key))).toBe(bytesToHex(encodeGcsFilter(items, key)));
  });

  it('empty set encodes to a lone 0x00 varint', () => {
    expect(bytesToHex(encodeGcsFilter([], key))).toBe('00');
  });
});

// ---------------------------------------------------------------------------
// BIP157 와이어 메시지 인코딩·디코딩
// ---------------------------------------------------------------------------

describe('bip157/messages — wire encodings', () => {
  const stopHash = displayHashToInternal(BIP158_VECTORS[1]!.blockHash);

  it('getcfheaders payload layout: type|startHeight LE|stopHash', () => {
    const p = encodeGetCfHeaders(1000, stopHash);
    expect(p.length).toBe(1 + 4 + 32);
    expect(p[0]).toBe(0);
    expect(bytesToHex(p.subarray(1, 5))).toBe('e8030000');
    expect(bytesToHex(p.subarray(5))).toBe(bytesToHex(stopHash));
    expect(bytesToHex(encodeGetCfilters(1000, stopHash))).toBe(bytesToHex(p)); // 동일 레이아웃
  });

  it('decodes a cfheaders payload', () => {
    const prev = new Uint8Array(32).fill(7);
    const h1 = new Uint8Array(32).fill(1);
    const h2 = new Uint8Array(32).fill(2);
    const payload = new Uint8Array([0, ...stopHash, ...prev, 2, ...h1, ...h2]);
    const msg = decodeCfHeaders(payload);
    expect(msg.filterType).toBe(0);
    expect(bytesToHex(msg.stopHash)).toBe(bytesToHex(stopHash));
    expect(bytesToHex(msg.previousFilterHeader)).toBe(bytesToHex(prev));
    expect(msg.filterHashes.map(bytesToHex)).toEqual([bytesToHex(h1), bytesToHex(h2)]);
  });

  it('decodes a cfilter payload (varint-prefixed filter bytes)', () => {
    const filter = hexToBytes(BIP158_VECTORS[4]!.filter);
    const payload = new Uint8Array([0, ...stopHash, filter.length, ...filter]);
    const msg = decodeCfilter(payload);
    expect(msg.filterType).toBe(0);
    expect(bytesToHex(msg.blockHash)).toBe(bytesToHex(stopHash));
    expect(bytesToHex(msg.filterBytes)).toBe(BIP158_VECTORS[4]!.filter);
  });

  it('getheaders ↔ headers round-trip with a real block header', () => {
    const block = decodeBlock(hexToBytes(BIP158_VECTORS[2]!.block));
    const getPayload = encodeGetHeaders([block.header.hash]);
    // version(4) + count(1) + hash(32) + stop(32)
    expect(getPayload.length).toBe(69);
    expect(new ByteReader(getPayload).readU32LE()).toBe(70016);

    // headers 응답: count + 80바이트 헤더 + txcount(0)
    const headersPayload = new Uint8Array([1, ...block.header.raw, 0]);
    const decoded = decodeHeadersMessage(headersPayload)[0]!;
    expect(internalHashToDisplay(decoded.hash)).toBe(BIP158_VECTORS[2]!.blockHash);
    expect(bytesToHex(decoded.prevBlockHash)).toBe(bytesToHex(block.header.prevBlockHash));
  });

  it('getdata payload layout: count | (type LE|hash)*', () => {
    const p = encodeGetData([
      { type: 2, hash: stopHash },
      { type: 0x40000002, hash: stopHash },
    ]);
    expect(p.length).toBe(1 + 2 * 36);
    expect(p[0]).toBe(2);
    expect(bytesToHex(p.subarray(1, 5))).toBe('02000000');
    expect(bytesToHex(p.subarray(37, 41))).toBe('02000040');
  });

  it('decodes a segwit block and computes stripped txids (block 1263442)', () => {
    const block = decodeBlock(hexToBytes(BIP158_VECTORS[6]!.block));
    expect(block.transactions).toHaveLength(2);
    expect(block.transactions[0]!.hasWitness).toBe(true);
    expect(block.transactions[1]!.hasWitness).toBe(true);
    // 코인베이스 판정 + 두 번째 tx 의 입력이 witness v0 P2WSH 출력을 소비
    expect(block.transactions[0]!.inputs[0]!.prevVout).toBe(0xffffffff);
    expect(block.transactions[1]!.inputs).toHaveLength(1);
    expect(internalHashToDisplay(block.transactions[1]!.inputs[0]!.prevTxid)).toBe(
      'c52ca2fa069190af53b20a905de80debd58db8942419e7f54fba0639467809d2',
    );
  });

  it('frames a full getcfilters request ready for a transport', () => {
    const frame = encodeMessage('getcfilters', encodeGetCfilters(0, stopHash), MAINNET_MAGIC);
    const msg = new P2PFrameDecoder().push(frame)[0]!;
    expect(msg.command).toBe('getcfilters');
    const decoded = decodeCfilterRequestEcho(msg.payload);
    expect(decoded.startHeight).toBe(0);
  });
});

/** 테스트 보조 — getcfilters 요청 페이로드 재해석 (요청 인코더 검증용). */
function decodeCfilterRequestEcho(payload: Uint8Array): { filterType: number; startHeight: number } {
  const r = new ByteReader(payload);
  return { filterType: r.readU8(), startHeight: r.readU32LE() };
}
