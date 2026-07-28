#!/usr/bin/env node
/**
 * 시드구문 → 앵커 publisher 개인키 파생.
 *
 * 이 스크립트는 "키를 만드는" 게 아니다. 시드구문 하나에 이미 무한한 주소와
 * 그 개인키가 들어 있고, 여기서는 경로 하나를 골라 꺼낼 뿐이다.
 *
 * 왜 stdin 인가:
 *   시드구문을 argv 로 받으면 프로세스 목록(`ps`, 작업관리자)과 셸 히스토리에
 *   그대로 남는다. 그래서 **stdin 으로만** 받는다. 파일로도 쓰지 않는다.
 *   비밀이 아닌 값(account/index/wordlist)만 argv 로 받는다.
 *
 * 왜 SDK 를 쓰는가:
 *   BIP-39/BIP-32 를 여기서 다시 구현하면 검증되지 않은 암호 코드가 하나 더
 *   생긴다. 지갑이 쓰는 것과 같은 코드 경로(`@byeorin/wallet-sdk` dist)를 그대로
 *   쓴다 — 그래야 여기서 나온 주소가 벼린 지갑이 보여주는 주소와 반드시 같다.
 *   두 경로(raw 파생 / Wallet.account)로 각각 구해 서로 대조하고, 어긋나면
 *   키를 출력하지 않고 죽는다.
 *
 * 출력: stdout 에 JSON 한 줄. 사람이 읽는 화면 출력은 PowerShell 래퍼가 만든다.
 *   성공 { ok: true, path, address, privateKey, chainId, balanceWei, balanceTtl }
 *   실패 { ok: false, error }   ← 시드구문은 어떤 경우에도 에러 메시지에 넣지 않는다.
 *
 * 사용:
 *   echo "<mnemonic>" | node scripts/derive-publisher-key.mjs --index 7
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(__dirname);
const SDK = join(REPO_ROOT, 'packages', 'wallet-sdk', 'dist');

// Windows 절대경로(`D:\...`)를 dynamic import 에 그대로 넘기면 ESM 로더가 `d:` 를
// 프로토콜로 읽어 죽는다. file:// URL 로 바꿔서 넘긴다.
const sdkUrl = (file) => pathToFileURL(join(SDK, file)).href;

const DEFAULT_RPC = 'https://rpc.ttl1.top';
// 앵커 1건의 실측 비용 (2026-07-28, eth_estimateGas × eth_gasPrice).
// 잔액이 이보다 적으면 발행이 못 나가므로 래퍼가 경고할 수 있게 같이 내려준다.
const ANCHOR_COST_TTL = 0.0013612;

function fail(msg) {
  // 시드구문은 절대 넣지 않는다. 호출자가 이 JSON 을 로그에 남길 수 있다.
  process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
  process.exitCode = 1;
}

function parseArgs(argv) {
  const out = {
    account: 0,
    index: 0,
    wordlist: 'auto',
    rpc: DEFAULT_RPC,
    balance: true,
    passphrase: '',
    stdinBase64: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--account') out.account = Number(argv[++i]);
    else if (a === '--index') out.index = Number(argv[++i]);
    else if (a === '--wordlist') out.wordlist = String(argv[++i]);
    else if (a === '--rpc') out.rpc = String(argv[++i]);
    else if (a === '--no-balance') out.balance = false;
    else if (a === '--stdin-base64') out.stdinBase64 = true;
    else throw new Error(`알 수 없는 인자: ${a}`);
  }
  if (!Number.isInteger(out.account) || out.account < 0) {
    throw new Error('--account 는 0 이상의 정수여야 한다');
  }
  if (!Number.isInteger(out.index) || out.index < 0) {
    throw new Error('--index 는 0 이상의 정수여야 한다');
  }
  if (!['auto', 'english', 'korean'].includes(out.wordlist)) {
    throw new Error('--wordlist 는 auto | english | korean 중 하나');
  }
  return out;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 입력 정규화 — 줄바꿈/중복 공백을 단일 공백으로, 앞뒤 공백 제거.
 * 한국어 wordlist 는 NFKD(자모분리) 로 저장돼 있는데 IME 입력은 NFC 라서
 * 그대로 비교하면 유효한 시드가 무효로 판정된다. 비교는 NFKD 로 통일한다.
 * (seed 파생 자체는 PBKDF2 가 내부에서 NFKD 정규화하므로 결과는 동일하다.)
 */
function normalizeMnemonic(raw) {
  return raw.replace(/\s+/g, ' ').trim();
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`RPC ${method}: ${j.error.message}`);
  return j.result;
}

/**
 * 실패 원인 분류용 통계. **시드 내용은 한 글자도 내보내지 않는다** — 개수와
 * 성질만 센다. 어느 단어가 틀렸는지 알려주는 건 이 스크립트의 일이 아니고,
 * 그렇게 하면 오류 메시지가 시드 유출 경로가 된다.
 */
function diagnose(mnemonic, getWordlist) {
  const words = mnemonic.split(' ').filter((w) => w.length > 0);
  const inList = (wl) => {
    const set = new Set(getWordlist(wl).map((w) => w.normalize('NFKD')));
    return words.filter((w) => !set.has(w.normalize('NFKD'))).length;
  };
  return {
    wordCount: words.length,
    validWordCount: [12, 15, 18, 21, 24].includes(words.length),
    unknownEnglish: inList('english'),
    unknownKorean: inList('korean'),
    hasNonAscii: /[^\x20-\x7E]/.test(mnemonic),
    // U+FFFD = 디코딩 실패로 치환된 문자. 있으면 인코딩이 깨진 것이 확실하다.
    mangled: mnemonic.includes('�'),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (process.stdin.isTTY) {
    throw new Error(
      '시드구문을 stdin 으로 넘겨야 한다. 직접 실행하지 말고 ' +
        'scripts/Set-AnchorKey.ps1 을 쓰거나 파이프로 넘겨라.',
    );
  }

  const core = await import(sdkUrl('core.js'));
  const evm = await import(sdkUrl('evm.js'));
  const {
    Wallet,
    isValidMnemonic,
    mnemonicToSeed,
    deriveSecp256k1,
    privateKeyToHex,
    getWordlist,
  } = core;
  const { EvmAdapter, TTL_CHAIN } = evm;

  // base64 전송 모드.
  //
  // 왜 필요한가: PowerShell 이 네이티브 프로세스 stdin 으로 문자열을 보낼 때
  // 쓰는 인코딩은 $OutputEncoding 전역 변수인데, PS 5.1 기본값이 ASCII 다.
  // 그러면 한국어 시드가 '?' 로 전부 치환돼 도착한다 — 실제로 그렇게 터졌고,
  // 스크립트에서 그 변수를 UTF-8 로 바꿔도 파이프에 반영되지 않았다.
  //
  // 그래서 그 전역 변수에 의존하는 구조 자체를 없앤다. 호출자가 UTF-8 바이트를
  // base64 로 감싸 보내면 전선 위에는 ASCII 만 흐르고, 어떤 코드페이지도
  // 훼손할 수 없다.
  const rawStdin = await readStdin();
  let decoded;
  if (args.stdinBase64) {
    const b64 = rawStdin.trim();
    if (!/^[A-Za-z0-9+/=\s]*$/.test(b64)) {
      throw new Error('--stdin-base64 인데 입력이 base64 가 아니다');
    }
    decoded = Buffer.from(b64, 'base64').toString('utf8');
  } else {
    decoded = rawStdin;
  }
  const mnemonic = normalizeMnemonic(decoded);
  if (mnemonic.length === 0) throw new Error('시드구문이 비어 있다');

  // wordlist 판정. auto 는 english → korean 순으로 시도한다.
  // 여기서 단어 개수/철자를 말해주지 않는다 — 어느 단어가 틀렸는지 알려주는 건
  // 이 스크립트의 일이 아니고, 오류 메시지에 시드 조각이 새는 경로가 된다.
  const candidates = args.wordlist === 'auto' ? ['english', 'korean'] : [args.wordlist];
  let wordlist = null;
  for (const wl of candidates) {
    if (isValidMnemonic(mnemonic, wl) || isValidMnemonic(mnemonic.normalize('NFKD'), wl)) {
      wordlist = wl;
      break;
    }
  }
  if (wordlist === null) {
    // 왜 실패했는지 말해주지 않으면 사용자가 손댈 데가 없다. 단, 시드 자체나
    // 어느 단어가 틀렸는지는 절대 내보내지 않는다 — **개수와 성질만** 센다.
    const diag = diagnose(mnemonic, getWordlist);
    throw new Error(
      `유효한 시드구문이 아니다 (${args.wordlist === 'auto' ? 'english/korean 둘 다 실패' : `wordlist=${args.wordlist}`}). ` +
        `단어 ${diag.wordCount}개` +
        (diag.validWordCount ? '' : ` — BIP-39 는 12/15/18/21/24 개만 유효하다`) +
        `. 사전에 없는 단어: english ${diag.unknownEnglish}개, korean ${diag.unknownKorean}개` +
        (diag.unknownEnglish > 0 && diag.unknownKorean > 0 && diag.hasNonAscii === false
          ? '. (전부 ASCII 인데 english 사전에 없다 — 오타이거나 다른 언어 사전이다)'
          : '') +
        (diag.unknownKorean === 0 && diag.validWordCount
          ? '. (모든 단어가 korean 사전에 있다 — 단어는 맞고 체크섬이 안 맞는다. 순서가 틀렸을 가능성이 크다)'
          : '') +
        (diag.unknownEnglish === 0 && diag.validWordCount
          ? '. (모든 단어가 english 사전에 있다 — 단어는 맞고 체크섬이 안 맞는다. 순서가 틀렸을 가능성이 크다)'
          : '') +
        (diag.mangled
          ? '. ⚠ 입력에 치환문자(U+FFFD)가 있다 — 인코딩이 깨진 채로 전달됐다'
          : ''),
    );
  }

  const adapter = new EvmAdapter({ chain: TTL_CHAIN, rpcUrl: args.rpc });
  const path = adapter.derivationPath(args.account, args.index);

  // 경로 ①: raw 파생 — 개인키를 직접 꺼낸다.
  const seed = mnemonicToSeed(mnemonic, args.passphrase);
  const derived = deriveSecp256k1(seed, path);
  const privateKey = privateKeyToHex(derived.privateKey);
  const addressRaw = adapter.pubkeyToAddress(derived.publicKey);

  // 경로 ②: 지갑이 쓰는 고수준 API. 둘이 어긋나면 어딘가 깨진 것이므로 멈춘다.
  const wallet = Wallet.fromMnemonic({ mnemonic, wordlist, passphrase: args.passphrase });
  const acc = wallet.account(adapter, args.account, args.index);
  if (acc.address.toLowerCase() !== addressRaw.toLowerCase() || acc.derivationPath !== path) {
    throw new Error('내부 검증 실패: 두 파생 경로의 결과가 다르다. 키를 출력하지 않는다.');
  }

  const out = {
    ok: true,
    wordlist,
    path,
    address: acc.address,
    privateKey,
    anchorCostTtl: ANCHOR_COST_TTL,
  };

  if (args.balance) {
    // 잔액 조회는 실패해도 파생 결과를 버리지 않는다 — 오프라인에서도 키는 나와야 한다.
    try {
      const chainIdHex = await rpc(args.rpc, 'eth_chainId', []);
      const balHex = await rpc(args.rpc, 'eth_getBalance', [acc.address, 'latest']);
      out.chainId = parseInt(chainIdHex, 16);
      out.balanceWei = BigInt(balHex).toString();
      out.balanceTtl = Number(BigInt(balHex)) / 1e18;
    } catch (e) {
      out.balanceError = e instanceof Error ? e.message : String(e);
    }
  }

  process.stdout.write(JSON.stringify(out) + '\n');
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
