#!/usr/bin/env node
// build-checkpoints.mjs — BIP157 스캔 체크포인트 재생성·검증기.
//
// 목적: packages/wallet-sdk/src/btc-history/bip157/checkpoints.ts 에 박힌 값이
//       "누가 어디서 베껴온 숫자"가 아니라 재현 가능한 계산 결과임을 제3자가
//       직접 확인할 수 있게 한다.
//
// 네트워크 접속 0. 모든 값은 아래 두 원천에서만 나온다:
//
//   (A) 제네시스 블록 — 프로토콜 상수. 블록 원문을 이 파일 안의 필드에서
//       재조립해 해시·PoW 를 자체 검산한 뒤, BIP158 basic filter 를 실제
//       gcs.ts 로 인코드해서 filter header 를 계산한다.
//       코인베이스 트랜잭션 원문은 mainnet/testnet3 가 바이트 동일하고,
//       그 원문은 BIP158 공식 벡터(testnet 높이 0)의 블록 hex 와 일치한다.
//
//   (B) BIP158 공식 테스트 벡터 — bitcoin/bips 저장소 bip-0158/testnet-19.json.
//       (블록 hex, 소비된 이전 출력 스크립트, 이전 filter header, filter, header)
//       이 스크립트는 벡터의 header 값을 "베끼지" 않는다. 블록 hex 에서 필터를
//       다시 만들어 header 를 계산하고, 그 결과가 벡터의 header 와 같은지 본다.
//       heights ≥ 21111 (testnet3 BIP34 활성 높이)은 코인베이스 scriptSig 에
//       박힌 높이까지 대조한다.
//
// mainnet 은 제네시스 외의 체크포인트를 넣지 않는다 — 오프라인으로 검증
// 가능한 mainnet filter header 원천이 없다. 지어내지 않는다.
//
// 실행:
//   node scripts/btc-p2p/build-checkpoints.mjs           # 계산 + checkpoints.ts 대조 (검증)
//   node scripts/btc-p2p/build-checkpoints.mjs --emit    # checkpoints.ts 에 넣을 TS 리터럴 출력
//   node scripts/btc-p2p/build-checkpoints.mjs --json    # 계산 결과를 JSON 으로 출력
//
// 구현 메모: SDK 원본(.ts)을 그대로 불러 쓴다 — 빌드 산출물(dist)에 의존하지
// 않으므로 다른 작업 중에도 돌아간다. Node 의 타입 제거만으로는 gcs.ts 의
// 파라미터 프로퍼티(constructor(private ...))를 못 지우므로
// --experimental-transform-types 로 자기 자신을 다시 띄운다.

import { spawnSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..', '..');
const BIP157_DIR = path.join(
  REPO_ROOT,
  'packages',
  'wallet-sdk',
  'src',
  'btc-history',
  'bip157',
);

// --- TS 원본 직접 로드 -------------------------------------------------------

if (process.features.typescript !== 'transform') {
  const r = spawnSync(
    process.execPath,
    [
      '--experimental-transform-types',
      '--disable-warning=ExperimentalWarning',
      SELF,
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit' },
  );
  process.exit(r.status ?? 1);
}

// SDK 원본은 ESM 규약대로 './messages.js' 를 가리킨다. 실제 파일은 .ts 이므로
// 부모가 .ts 일 때만 확장자를 바꿔 재해석한다.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith('.') &&
      specifier.endsWith('.js') &&
      typeof context.parentURL === 'string' &&
      context.parentURL.endsWith('.ts')
    ) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const sdkUrl = (file) => pathToFileURL(path.join(BIP157_DIR, file)).href;

const { bytesToHex, decodeBlock, displayHashToInternal, hexToBytes, internalHashToDisplay } =
  await import(sdkUrl('messages.ts'));
const { computeFilterHash, computeFilterHeader, encodeGcsFilter, filterKeyFromBlockHash } =
  await import(sdkUrl('gcs.ts'));

// ---------------------------------------------------------------------------
// (A) 제네시스 — 프로토콜 상수
// ---------------------------------------------------------------------------

/**
 * 제네시스 코인베이스 트랜잭션 원문 (mainnet · testnet3 · signet · regtest 공통).
 * scriptSig 안에 "The Times 03/Jan/2009 Chancellor on brink of second bailout
 * for banks" 가 들어 있다. 이 hex 는 BIP158 공식 벡터(testnet 높이 0)의 블록
 * hex 뒤쪽 트랜잭션 부분과 바이트 단위로 같다 — 아래 assertGenesisTxMatchesVector() 가 대조한다.
 */
const GENESIS_TX_HEX =
  '01000000' + // version
  '01' + // input count
  '0000000000000000000000000000000000000000000000000000000000000000ffffffff' + // null prevout
  '4d' + // scriptSig 길이 77
  '04ffff001d' + // push: bits
  '0104' + // push: extra nonce
  '45' + // push 69바이트
  '5468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e2062' +
  '72696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73' +
  'ffffffff' + // sequence
  '01' + // output count
  '00f2052a01000000' + // 50 BTC
  '43' + // scriptPubKey 길이 67
  '4104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc' +
  '3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac' +
  '00000000'; // locktime

/** 제네시스 머클루트 (직렬화 순서 = internal). 코인베이스가 1개뿐이므로 txid 와 같다. */
const GENESIS_MERKLE_ROOT_INTERNAL_HEX =
  '3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a';

/**
 * 제네시스 헤더 필드 — 네트워크별로 time·bits·nonce 만 다르다.
 * expectedHash 는 "정답"이 아니라 계산 결과와 대조할 사전 공개값이다.
 * (계산이 어긋나면 이 스크립트가 실패한다.)
 */
const GENESIS = [
  {
    network: 'mainnet',
    time: 1231006505,
    bits: 0x1d00ffff,
    nonce: 2083236893,
    expectedHash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
  },
  {
    network: 'testnet3',
    time: 1296688602,
    bits: 0x1d00ffff,
    nonce: 414098458,
    expectedHash: '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943',
  },
];

// ---------------------------------------------------------------------------
// (B) BIP158 공식 테스트 벡터 (bitcoin/bips · bip-0158/testnet-19.json)
//     체크포인트로 쓸 행만 발췌. 높이 0 은 (A) 와 교차 검증에도 쓴다.
// ---------------------------------------------------------------------------

const BIP158_VECTORS = [
  {
    height: 0,
    blockHash: '000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943',
    block:
      '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4adae5494dffff001d1aa4ae180101000000010000000000000000000000000000000000000000000000000000000000000000ffffffff4d04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000',
    prevOutputScripts: [],
    prevHeader: '0000000000000000000000000000000000000000000000000000000000000000',
    filter: '019dfca8',
    header: '21584579b7eb08997773e5aeff3a7f932700042d0ed2a6129012b7d7ae81b750',
  },
  {
    height: 49291,
    blockHash: '0000000018b07dca1b28b4b5a119f6d6e71698ce1ed96f143f54179ce177a19c',
    block:
      '02000000abfaf47274223ca2fea22797e44498240e482cb4c2f2baea088962f800000000604b5b52c32305b15d7542071d8b04e750a547500005d4010727694b6e72a776e55d0d51ffff001d211806480201000000010000000000000000000000000000000000000000000000000000000000000000ffffffff0d038bc0000102062f503253482fffffffff01a078072a01000000232102971dd6034ed0cf52450b608d196c07d6345184fcb14deb277a6b82d526a6163dac0000000001000000081cefd96060ecb1c4fbe675ad8a4f8bdc61d634c52b3a1c4116dee23749fe80ff000000009300493046022100866859c21f306538152e83f115bcfbf59ab4bb34887a88c03483a5dff9895f96022100a6dfd83caa609bf0516debc2bf65c3df91813a4842650a1858b3f61cfa8af249014730440220296d4b818bb037d0f83f9f7111665f49532dfdcbec1e6b784526e9ac4046eaa602204acf3a5cb2695e8404d80bf49ab04828bcbe6fc31d25a2844ced7a8d24afbdff01ffffffff1cefd96060ecb1c4fbe675ad8a4f8bdc61d634c52b3a1c4116dee23749fe80ff020000009400483045022100e87899175991aa008176cb553c6f2badbb5b741f328c9845fcab89f8b18cae2302200acce689896dc82933015e7230e5230d5cff8a1ffe82d334d60162ac2c5b0c9601493046022100994ad29d1e7b03e41731a4316e5f4992f0d9b6e2efc40a1ccd2c949b461175c502210099b69fdc2db00fbba214f16e286f6a49e2d8a0d5ffc6409d87796add475478d601ffffffff1e4a6d2d280ea06680d6cf8788ac90344a9c67cca9b06005bbd6d3f6945c8272010000009500493046022100a27400ba52fd842ce07398a1de102f710a10c5599545e6c95798934352c2e4df022100f6383b0b14c9f64b6718139f55b6b9494374755b86bae7d63f5d3e583b57255a01493046022100fdf543292f34e1eeb1703b264965339ec4a450ec47585009c606b3edbc5b617b022100a5fbb1c8de8aaaa582988cdb23622838e38de90bebcaab3928d949aa502a65d401ffffffff1e4a6d2d280ea06680d6cf8788ac90344a9c67cca9b06005bbd6d3f6945c8272020000009400493046022100ac626ac3051f875145b4fe4cfe089ea895aac73f65ab837b1ac30f5d875874fa022100bc03e79fa4b7eb707fb735b95ff6613ca33adeaf3a0607cdcead4cfd3b51729801483045022100b720b04a5c5e2f61b7df0fcf334ab6fea167b7aaede5695d3f7c6973496adbf1022043328c4cc1cdc3e5db7bb895ccc37133e960b2fd3ece98350f774596badb387201ffffffff23a8733e349c97d6cd90f520fdd084ba15ce0a395aad03cd51370602bb9e5db3010000004a00483045022100e8556b72c5e9c0da7371913a45861a61c5df434dfd962de7b23848e1a28c86ca02205d41ceda00136267281be0974be132ac4cda1459fe2090ce455619d8b91045e901ffffffff6856d609b881e875a5ee141c235e2a82f6b039f2b9babe82333677a5570285a6000000006a473044022040a1c631554b8b210fbdf2a73f191b2851afb51d5171fb53502a3a040a38d2c0022040d11cf6e7b41fe1b66c3d08f6ada1aee07a047cb77f242b8ecc63812c832c9a012102bcfad931b502761e452962a5976c79158a0f6d307ad31b739611dac6a297c256ffffffff6856d609b881e875a5ee141c235e2a82f6b039f2b9babe82333677a5570285a601000000930048304502205b109df098f7e932fbf71a45869c3f80323974a826ee2770789eae178a21bfc8022100c0e75615e53ee4b6e32b9bb5faa36ac539e9c05fa2ae6b6de5d09c08455c8b9601483045022009fb7d27375c47bea23b24818634df6a54ecf72d52e0c1268fb2a2c84f1885de022100e0ed4f15d62e7f537da0d0f1863498f9c7c0c0a4e00e4679588c8d1a9eb20bb801ffffffffa563c3722b7b39481836d5edfc1461f97335d5d1e9a23ade13680d0e2c1c371f030000006c493046022100ecc38ae2b1565643dc3c0dad5e961a5f0ea09cab28d024f92fa05c922924157e022100ebc166edf6fbe4004c72bfe8cf40130263f98ddff728c8e67b113dbd621906a601210211a4ed241174708c07206601b44a4c1c29e5ad8b1f731c50ca7e1d4b2a06dc1fffffffff02d0223a00000000001976a91445db0b779c0b9fa207f12a8218c94fc77aff504588ac80f0fa02000000000000000000',
    prevOutputScripts: [
      '5221033423007d8f263819a2e42becaaf5b06f34cb09919e06304349d950668209eaed21021d69e2b68c3960903b702af7829fadcd80bd89b158150c85c4a75b2c8cb9c39452ae',
      '52210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f8179821021d69e2b68c3960903b702af7829fadcd80bd89b158150c85c4a75b2c8cb9c39452ae',
      '522102a7ae1e0971fc1689bd66d2a7296da3a1662fd21a53c9e38979e0f090a375c12d21022adb62335f41eb4e27056ac37d462cda5ad783fa8e0e526ed79c752475db285d52ae',
      '52210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f8179821022adb62335f41eb4e27056ac37d462cda5ad783fa8e0e526ed79c752475db285d52ae',
      '512103b9d1d0e2b4355ec3cdef7c11a5c0beff9e8b8d8372ab4b4e0aaf30e80173001951ae',
      '76a9149144761ebaccd5b4bbdc2a35453585b5637b2f8588ac',
      '522103f1848b40621c5d48471d9784c8174ca060555891ace6d2b03c58eece946b1a9121020ee5d32b54d429c152fdc7b1db84f2074b0564d35400d89d11870f9273ec140c52ae',
      '76a914f4fa1cc7de742d135ea82c17adf0bb9cf5f4fb8388ac',
    ],
    prevHeader: 'ed47705334f4643892ca46396eb3f4196a5e30880589e4009ef38eae895d4a13',
    filter: '0afbc2920af1b027f31f87b592276eb4c32094bb4d3697021b4c6380',
    header: 'b6d98692cec5145f67585f3434ec3c2b3030182e1cb3ec58b855c5c164dfaaa3',
  },
  {
    height: 987876,
    blockHash: '0000000000000c00901f2049055e2a437c819d79a3d54fd63e6af796cd7b8a79',
    block:
      '000000202694f74969fdb542090e95a56bc8aa2d646e27033850e32f1c5f000000000000f7e53676b3f12d5beb524ed617f2d25f5a93b5f4f52c1ba2678260d72712f8dd0a6dfe5740257e1a4b1768960101000000010000000000000000000000000000000000000000000000000000000000000000ffffffff1603e4120ff9c30a1c216900002f424d4920546573742fffffff0001205fa012000000001e76a914c486de584a735ec2f22da7cd9681614681f92173d83d0aa68688ac00000000',
    prevOutputScripts: [],
    prevHeader: 'fe4d230dbb0f4fec9bed23a5283e08baf996e3f32b93f52c7de1f641ddfd04ad',
    filter: '010c0b40',
    header: '0965a544743bbfa36f254446e75630c09404b3d164a261892372977538928ed5',
  },
  {
    height: 1263442,
    blockHash: '000000006f27ddfe1dd680044a34548f41bed47eba9e6f0b310da21423bc5f33',
    block:
      '000000201c8d1a529c39a396db2db234d5ec152fa651a2872966daccbde028b400000000083f14492679151dbfaa1a825ef4c18518e780c1f91044180280a7d33f4a98ff5f45765aaddc001d38333b9a02010000000001010000000000000000000000000000000000000000000000000000000000000000ffffffff230352471300fe5f45765afe94690a000963676d696e6572343208000000000000000000ffffffff024423a804000000001976a914f2c25ac3d59f3d674b1d1d0a25c27339aaac0ba688ac0000000000000000266a24aa21a9edcb26cb3052426b9ebb4d19c819ef87c19677bbf3a7c46ef0855bd1b2abe83491012000000000000000000000000000000000000000000000000000000000000000000000000002000000000101d20978463906ba4ff5e7192494b88dd5eb0de85d900ab253af909106faa22cc5010000000004000000014777ff000000000016001446c29eabe8208a33aa1023c741fa79aa92e881ff0347304402207d7ca96134f2bcfdd6b536536fdd39ad17793632016936f777ebb32c22943fda02206014d2fb8a6aa58279797f861042ba604ebd2f8f61e5bddbd9d3be5a245047b201004b632103eeaeba7ce5dc2470221e9517fb498e8d6bd4e73b85b8be655196972eb9ccd5566754b2752103a40b74d43df244799d041f32ce1ad515a6cd99501701540e38750d883ae21d3a68ac00000000',
    prevOutputScripts: [
      '002027a5000c7917f785d8fc6e5a55adfca8717ecb973ebb7743849ff956d896a7ed',
    ],
    prevHeader: '31d66d516a9eda7de865df29f6ef6cb8e4bf9309e5dac899968a9a62a5df61e3',
    filter: '0385acb4f0fe889ef0',
    header: '4e6d564c2a2452065c205dd7eb2791124e0c4e0dbb064c410c24968572589dec',
  },
  {
    height: 1414221,
    blockHash: '0000000000000027b2b3b3381f114f674f481544ff2be37ae3788d7e078383b1',
    block:
      '000000204ea88307a7959d8207968f152bedca5a93aefab253f1fb2cfb032a400000000070cebb14ec6dbc27a9dfd066d9849a4d3bac5f674665f73a5fe1de01a022a0c851fda85bf05f4c19a779d1450102000000010000000000000000000000000000000000000000000000000000000000000000ffffffff18034d94154d696e6572476174653030310d000000f238f401ffffffff01c817a804000000000000000000',
    prevOutputScripts: [],
    prevHeader: '5e5e12d90693c8e936f01847859404c67482439681928353ca1296982042864e',
    filter: '00',
    header: '021e8882ef5a0ed932edeebbecfeda1d7ce528ec7b3daa27641acf1189d7b5dc',
  },
];

/** testnet3 BIP34(코인베이스에 높이 기록) 활성 높이. 이 위로는 높이를 블록에서 검산한다. */
const TESTNET3_BIP34_HEIGHT = 21111;

// ---------------------------------------------------------------------------
// 계산 유틸
// ---------------------------------------------------------------------------

function fail(msg) {
  throw new Error(`build-checkpoints: ${msg}`);
}

function assertEq(actual, expected, what) {
  if (actual !== expected) fail(`${what}\n  계산: ${actual}\n  기대: ${expected}`);
}

function u32le(n) {
  return (n >>> 0).toString(16).padStart(8, '0').match(/../g).reverse().join('');
}

/** nBits → 목표값(target). PoW 검산용. */
function targetFromBits(bits) {
  const exponent = BigInt(bits >>> 24);
  const mantissa = BigInt(bits & 0x007fffff);
  return exponent <= 3n
    ? mantissa >> (8n * (3n - exponent))
    : mantissa << (8n * (exponent - 3n));
}

/** display hex(빅엔디언 표기) → 정수. PoW 비교용. */
function hashToBigInt(displayHex) {
  return BigInt(`0x${displayHex}`);
}

/**
 * BIP158 basic filter 원소:
 *   - 블록 안 모든 출력의 scriptPubKey (빈 것·OP_RETURN 시작 제외)
 *   - 이 블록의 입력들이 소비한 이전 출력의 scriptPubKey (빈 것 제외, 코인베이스 없음)
 */
function basicFilterItems(block, prevOutputScripts) {
  const items = [];
  for (const tx of block.transactions) {
    for (const out of tx.outputs) {
      if (out.scriptPubKey.length > 0 && out.scriptPubKey[0] !== 0x6a) {
        items.push(out.scriptPubKey);
      }
    }
  }
  for (const hex of prevOutputScripts) {
    if (hex.length > 0) items.push(hexToBytes(hex));
  }
  return items;
}

/** 블록 hex → { blockHash(display), filter(hex), filterHeader(display) } */
function filterFromBlock(blockHex, prevOutputScripts, prevHeaderDisplay) {
  const block = decodeBlock(hexToBytes(blockHex));
  const blockHashInternal = block.header.hash;
  const key = filterKeyFromBlockHash(blockHashInternal);
  const filterBytes = encodeGcsFilter(basicFilterItems(block, prevOutputScripts), key);
  const filterHeader = computeFilterHeader(
    computeFilterHash(filterBytes),
    displayHashToInternal(prevHeaderDisplay),
  );
  return {
    block,
    blockHash: internalHashToDisplay(blockHashInternal),
    filter: bytesToHex(filterBytes),
    filterHeader: internalHashToDisplay(filterHeader),
  };
}

/** 코인베이스 scriptSig 의 첫 push = BIP34 높이. 못 읽으면 null. */
function coinbaseHeight(block) {
  const tx = block.transactions[0];
  if (!tx) return null;
  const input = tx.inputs[0];
  if (!input) return null;
  const script = input.scriptSig;
  if (script.length === 0) return null;
  const len = script[0];
  if (len < 1 || len > 4 || script.length < 1 + len) return null;
  let v = 0;
  for (let i = len; i >= 1; i--) v = v * 256 + script[i];
  return v;
}

// ---------------------------------------------------------------------------
// 1. 제네시스 — 자체 계산
// ---------------------------------------------------------------------------

function assertGenesisTxMatchesVector() {
  const vec = BIP158_VECTORS.find((v) => v.height === 0);
  if (!vec) fail('BIP158 높이 0 벡터가 없다');
  // 벡터 블록 hex = 헤더(80바이트=160hex) + 트랜잭션 수 varint('01') + 트랜잭션
  const txFromVector = vec.block.slice(160 + 2);
  assertEq(
    GENESIS_TX_HEX,
    txFromVector,
    '제네시스 코인베이스 원문이 BIP158 공식 벡터의 트랜잭션과 다르다',
  );
}

function buildGenesis(params) {
  const headerHex =
    '01000000' + // version 1
    '0'.repeat(64) + // prev block = 0
    GENESIS_MERKLE_ROOT_INTERNAL_HEX +
    u32le(params.time) +
    u32le(params.bits) +
    u32le(params.nonce);
  const blockHex = `${headerHex}01${GENESIS_TX_HEX}`;

  const out = filterFromBlock(blockHex, [], '0'.repeat(64));

  // (1) 머클루트 = 코인베이스 txid (트랜잭션 1개)
  assertEq(
    bytesToHex(out.block.transactions[0].txid),
    GENESIS_MERKLE_ROOT_INTERNAL_HEX,
    `${params.network}: 코인베이스 txid ≠ 머클루트`,
  );
  // (2) 블록해시가 공개된 제네시스 해시와 일치
  assertEq(out.blockHash, params.expectedHash, `${params.network}: 제네시스 블록해시 불일치`);
  // (3) PoW 유효 — 해시 ≤ target(bits)
  if (hashToBigInt(out.blockHash) > targetFromBits(params.bits)) {
    fail(`${params.network}: 제네시스 PoW 불만족`);
  }

  return {
    network: params.network,
    height: 0,
    blockHash: out.blockHash,
    filter: out.filter,
    filterHeader: out.filterHeader,
    source: 'genesis-computed',
  };
}

// ---------------------------------------------------------------------------
// 2. BIP158 벡터 — 재계산 후 대조
// ---------------------------------------------------------------------------

function buildFromVector(vec) {
  const out = filterFromBlock(vec.block, vec.prevOutputScripts, vec.prevHeader);

  assertEq(out.blockHash, vec.blockHash, `높이 ${vec.height}: 블록해시 불일치`);
  assertEq(out.filter, vec.filter, `높이 ${vec.height}: 필터 재계산 불일치`);
  assertEq(out.filterHeader, vec.header, `높이 ${vec.height}: filter header 재계산 불일치`);

  let heightAttested = false;
  if (vec.height >= TESTNET3_BIP34_HEIGHT) {
    const h = coinbaseHeight(out.block);
    if (h === null) fail(`높이 ${vec.height}: BIP34 높이를 코인베이스에서 못 읽음`);
    assertEq(String(h), String(vec.height), `높이 ${vec.height}: BIP34 코인베이스 높이 불일치`);
    heightAttested = true;
  }

  return {
    network: 'testnet3',
    height: vec.height,
    blockHash: out.blockHash,
    filter: out.filter,
    filterHeader: out.filterHeader,
    source: vec.height === 0 ? 'genesis-computed' : 'bip158-test-vectors',
    heightAttested,
  };
}

// ---------------------------------------------------------------------------
// 3. 전체 계산
// ---------------------------------------------------------------------------

function computeAll() {
  assertGenesisTxMatchesVector();

  const genesis = GENESIS.map(buildGenesis);
  const fromVectors = BIP158_VECTORS.map(buildFromVector);

  // 제네시스 교차검증: 자체 계산한 testnet3 제네시스 = 공식 벡터 높이 0
  const ownTestnet = genesis.find((g) => g.network === 'testnet3');
  const vecTestnet = fromVectors.find((v) => v.height === 0);
  assertEq(ownTestnet.blockHash, vecTestnet.blockHash, '교차검증: testnet3 제네시스 블록해시');
  assertEq(ownTestnet.filter, vecTestnet.filter, '교차검증: testnet3 제네시스 필터');
  assertEq(
    ownTestnet.filterHeader,
    vecTestnet.filterHeader,
    '교차검증: testnet3 제네시스 filter header',
  );

  const mainnet = genesis.filter((g) => g.network === 'mainnet');
  const testnet3 = [
    ...genesis.filter((g) => g.network === 'testnet3'),
    ...fromVectors.filter((v) => v.height > 0),
  ].sort((a, b) => a.height - b.height);

  return { mainnet, testnet3 };
}

// ---------------------------------------------------------------------------
// 4. checkpoints.ts 대조 / 출력
// ---------------------------------------------------------------------------

function emitTs(list, constName, comment) {
  const rows = list.map(
    (c) =>
      `  {\n` +
      `    height: ${c.height},\n` +
      `    blockHash: '${c.blockHash}',\n` +
      `    filterHeader: '${c.filterHeader}',\n` +
      `    source: '${c.source}',\n` +
      `  },`,
  );
  return `${comment}\nexport const ${constName}: readonly FilterCheckpoint[] = [\n${rows.join('\n')}\n];`;
}

async function verifyAgainstSource(computed) {
  const mod = await import(sdkUrl('checkpoints.ts'));
  let ok = true;
  for (const [network, list] of Object.entries(computed)) {
    const actual = mod.getFilterCheckpoints(network);
    if (actual.length !== list.length) {
      console.error(
        `[FAIL] ${network}: 체크포인트 개수 ${actual.length} ≠ 계산값 ${list.length}`,
      );
      ok = false;
      continue;
    }
    for (let i = 0; i < list.length; i++) {
      const want = list[i];
      const got = actual[i];
      for (const field of ['height', 'blockHash', 'filterHeader', 'source']) {
        if (String(got[field]) !== String(want[field])) {
          console.error(
            `[FAIL] ${network}[${i}].${field}: 파일=${got[field]} 계산=${want[field]}`,
          );
          ok = false;
        }
      }
    }
    if (ok) console.log(`[OK]   ${network}: 체크포인트 ${list.length}개 재계산 일치`);
  }
  return ok;
}

// ---------------------------------------------------------------------------

const args = new Set(process.argv.slice(2));
const computed = computeAll();

if (args.has('--json')) {
  console.log(JSON.stringify(computed, null, 2));
} else if (args.has('--emit')) {
  console.log(
    emitTs(
      computed.mainnet,
      'MAINNET_FILTER_CHECKPOINTS',
      '/** mainnet 체크포인트 — 제네시스만. 그 외 높이는 미확보(오프라인 검증 원천 없음). */',
    ),
  );
  console.log();
  console.log(
    emitTs(
      computed.testnet3,
      'TESTNET3_FILTER_CHECKPOINTS',
      '/** testnet3 체크포인트 — 제네시스 + BIP158 공식 벡터에서 재계산한 높이들. */',
    ),
  );
} else {
  console.log('BIP157 체크포인트 재계산 — 네트워크 접속 없음\n');
  console.log(`  제네시스 코인베이스 원문 = BIP158 공식 벡터(높이 0) 트랜잭션  [일치]`);
  for (const c of computed.mainnet.concat(computed.testnet3)) {
    console.log(
      `  ${c.network.padEnd(8)} h=${String(c.height).padStart(7)}  block=${c.blockHash}  cfheader=${c.filterHeader}`,
    );
  }
  console.log();
  const ok = await verifyAgainstSource(computed);
  if (!ok) {
    console.error('\ncheckpoints.ts 가 재계산 결과와 다르다.');
    process.exit(1);
  }
  console.log('\n모든 체크포인트가 재계산으로 확인됨.');
}
