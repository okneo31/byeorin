// Hardware signer (Ledger) — v0.4.
//
// 본 모듈은 Ledger 디바이스의 앱(Solana/Cosmos)을 통해 서명을 수행하는 어댑터다.
// 우리 자체 HW 가 출시되기 전까지의 브릿지로서, 사용자가 이미 보유한 Ledger Nano
// X/S+ 를 노동자의 지갑 멀티체인 인터페이스 위에서 사용할 수 있게 한다.
//
// v0.4 범위 결정(중요):
//   - Solana(Ed25519, signTransaction → 64-byte raw sig)
//   - Cosmos(secp256k1, sign(message) → 64-byte r||s)
//   두 체인은 모두 Ledger 앱이 "임의 메시지 to-sign" 입력을 그대로 받기 때문에
//   우리 `Signer.sign(message)` 단일 시그니처와 1:1 매핑된다.
//
//   다음 체인은 v0.5 로 이연한다:
//     - EVM: Ledger Ethereum 앱은 digest 가 아닌 raw transaction(RLP) 를 요구한다.
//       우리 어댑터의 `signRequests` 는 digest 만 노출하므로 Wallet 리팩터(아래
//       TODO 참고)가 선행되어야 한다.
//     - BTC: Ledger Bitcoin 앱은 PSBT v2(또는 createPaymentTransaction 의
//       다단계 흐름)를 요구한다. `@scure/btc-signer` 출력과의 매핑이 추가 필요.
//
// 설계 원칙:
//   - `@ledgerhq/hw-app-*` 의존성은 *동적 import* 로만 끌어쓴다. 본 모듈이 직접
//     번들에 정적 의존하지 않도록 해, 라이브러리가 미설치된 환경에서도
//     SDK typecheck/build 가 깨지지 않는다.
//   - 어떤 APDU 가 갔는지 테스트할 수 있도록, `HwTransport.send` 를 라우팅
//     레이어로 추상화한다(아래 `MockHwTransport` 참조).

import type { Bytes, Curve, Signer } from '../types.js';

/**
 * 최소 HW 트랜스포트 인터페이스. `@ledgerhq/hw-transport` 의 send/close 시그니처
 * 를 그대로 따른다. 우리는 `Transport` 클래스 자체를 import 하지 않으므로,
 * webhid/node-hid/mock 어느 구현이든 본 형태만 만족시키면 된다.
 */
export interface HwTransport {
  send(
    cla: number,
    ins: number,
    p1: number,
    p2: number,
    data?: Uint8Array,
  ): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** v0.4 에서 지원하는 Ledger 앱. */
export type HwAppName = 'solana' | 'cosmos';

export interface HwSignerOptions {
  transport: HwTransport;
  appName: HwAppName;
  /** BIP-44 derivation path, 예: "m/44'/501'/0'/0'" (Solana), "m/44'/118'/0'/0/0" (Cosmos). */
  derivationPath: string;
}

/**
 * Ledger 앱을 통한 통합 서명자.
 *
 * `Signer` 인터페이스를 그대로 구현하므로 `Wallet.transfer` 의 sign 루프에 그대로
 * 끼워 넣을 수 있다(단, v0.4 는 Solana/Cosmos 만).
 */
export class HwSigner implements Signer {
  readonly curve: Curve;
  readonly appName: HwAppName;
  readonly derivationPath: string;
  private readonly transport: HwTransport;
  private cachedPubkey: Uint8Array | null = null;

  constructor(opts: HwSignerOptions) {
    if (!opts.transport) throw new Error('HwSigner: transport is required');
    if (!opts.derivationPath || !opts.derivationPath.startsWith('m/')) {
      throw new Error(
        `HwSigner: derivationPath must start with "m/", got ${String(opts.derivationPath)}`,
      );
    }
    this.transport = opts.transport;
    this.appName = opts.appName;
    this.derivationPath = opts.derivationPath;
    this.curve = opts.appName === 'solana' ? 'ed25519' : 'secp256k1';
  }

  async publicKey(): Promise<Bytes> {
    if (this.cachedPubkey) return this.cachedPubkey;
    const pk =
      this.appName === 'solana'
        ? await this.solanaGetPubkey()
        : await this.cosmosGetPubkey();
    this.cachedPubkey = pk;
    return pk;
  }

  async sign(message: Bytes): Promise<Bytes> {
    if (this.appName === 'solana') return this.solanaSign(message);
    return this.cosmosSign(message);
  }

  // ── Solana ────────────────────────────────────────────────────────────
  //
  // Ledger Solana 앱(@ledgerhq/hw-app-solana) 시그니처:
  //   getAddress(path: string): Promise<{ address: Buffer }>  // 32-byte Ed25519 pubkey
  //   signTransaction(path: string, tx: Buffer): Promise<{ signature: Buffer }>
  //
  // 주의: Ledger Solana 앱은 "임의 바이트열을 받아 Ed25519 로 서명" 하므로 `tx`
  // 인자는 사실상 서명 대상 바이트(즉 SDK 가 만든 `signRequests[0].message`)다.

  private async solanaGetPubkey(): Promise<Uint8Array> {
    const Solana = await loadLedgerApp<SolanaCtor>(
      '@ledgerhq/hw-app-solana',
      'solana',
    );
    const app = new Solana(this.transport);
    const { address } = await app.getAddress(this.derivationPath);
    return toUint8Array(address);
  }

  private async solanaSign(message: Uint8Array): Promise<Uint8Array> {
    const Solana = await loadLedgerApp<SolanaCtor>(
      '@ledgerhq/hw-app-solana',
      'solana',
    );
    const app = new Solana(this.transport);
    const { signature } = await app.signTransaction(
      this.derivationPath,
      bufferLike(message),
    );
    const out = toUint8Array(signature);
    if (out.length !== 64) {
      throw new Error(
        `HwSigner(solana): expected 64-byte Ed25519 signature, got ${out.length}`,
      );
    }
    return out;
  }

  // ── Cosmos ────────────────────────────────────────────────────────────
  //
  // Ledger Cosmos 앱(@ledgerhq/hw-app-cosmos):
  //   getAddress(path, hrp): Promise<{ publicKey: string(hex), address: string }>
  //   sign(path, message: string): Promise<{ signature: Buffer }>
  //
  // 주의:
  //   - hrp(예: "cosmos") 는 sign 에는 영향을 주지 않지만 getAddress 에 필요.
  //     본 SDK 는 Cosmos hrp 를 어댑터가 들고 있으므로, 여기서는 pubkey 만 뽑고
  //     주소 계산은 어댑터에 위임한다.
  //   - sign 의 결과는 (대개) DER 또는 64-byte r||s 일 수 있다. 라이브러리 버전에
  //     따라 다르므로 64-byte 가 아니면 DER 디코드를 시도해 r||s 로 정규화한다.

  private async cosmosGetPubkey(): Promise<Uint8Array> {
    const Cosmos = await loadLedgerApp<CosmosCtor>(
      '@ledgerhq/hw-app-cosmos',
      'cosmos',
    );
    const app = new Cosmos(this.transport);
    // hrp 는 pubkey 도출에 영향 없음 — placeholder.
    const { publicKey } = await app.getAddress(this.derivationPath, 'cosmos');
    return hexToBytes(publicKey);
  }

  private async cosmosSign(message: Uint8Array): Promise<Uint8Array> {
    const Cosmos = await loadLedgerApp<CosmosCtor>(
      '@ledgerhq/hw-app-cosmos',
      'cosmos',
    );
    const app = new Cosmos(this.transport);
    // hw-app-cosmos 는 입력을 utf-8 문자열로 받아 내부에서 다시 바이트화한다.
    // 우리는 JSON sign-doc 바이트열(이미 ASCII) 을 보내므로 안전하다.
    const text = new TextDecoder().decode(message);
    const { signature } = await app.sign(this.derivationPath, text);
    const raw = toUint8Array(signature);
    if (raw.length === 64) return raw;
    // DER → 64-byte r||s 로 정규화.
    return derToCompactSig(raw);
  }
}

// ── 동적 import 로더 ────────────────────────────────────────────────────────

// 노트: 본 클래스/생성자 시그니처는 ledger 라이브러리 표면이 최소한으로 필요로
// 하는 부분만 모델링한다. 라이브러리가 미설치된 환경에서도 본 파일이 컴파일
// 가능해야 하므로 인터페이스를 *우리가* 선언한다.
interface SolanaApp {
  getAddress(path: string): Promise<{ address: Uint8Array | { length: number } }>;
  signTransaction(
    path: string,
    tx: Uint8Array | { length: number },
  ): Promise<{ signature: Uint8Array | { length: number } }>;
}
type SolanaCtor = new (t: HwTransport) => SolanaApp;

interface CosmosApp {
  getAddress(
    path: string,
    hrp: string,
  ): Promise<{ publicKey: string; address: string }>;
  sign(
    path: string,
    message: string,
  ): Promise<{ signature: Uint8Array | { length: number } }>;
}
type CosmosCtor = new (t: HwTransport) => CosmosApp;

async function loadLedgerApp<T>(specifier: string, app: HwAppName): Promise<T> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await import(/* @vite-ignore */ specifier)) as { default: T };
    return mod.default;
  } catch (e) {
    throw new Error(
      `HwSigner: ledger app library "${specifier}" is not installed. ` +
        `Install it to enable ${app} hardware signing. (${
          e instanceof Error ? e.message : String(e)
        })`,
    );
  }
}

// ── 유틸 ────────────────────────────────────────────────────────────────────

function toUint8Array(b: unknown): Uint8Array {
  if (b instanceof Uint8Array) return b;
  // Node Buffer 는 Uint8Array 의 서브클래스라 typeof check 만으로 부족할 수 있다.
  // 안전하게 length 가 있는 ArrayLike 를 신뢰한다.
  if (
    b &&
    typeof b === 'object' &&
    'length' in (b as ArrayLike<number>) &&
    typeof (b as ArrayLike<number>).length === 'number'
  ) {
    return new Uint8Array(b as ArrayLike<number>);
  }
  throw new Error('HwSigner: ledger lib returned non-bytes value');
}

function bufferLike(u: Uint8Array): Uint8Array {
  // hw-app-solana 는 Buffer 를 기대하지만 Buffer 는 Uint8Array 서브클래스이므로
  // 브라우저(웹HID)/Node 양쪽에서 Uint8Array 전달이 안전하다.
  return u;
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error('HwSigner: invalid hex length');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('HwSigner: invalid hex char');
    out[i] = byte;
  }
  return out;
}

/**
 * DER-encoded ECDSA signature → 64-byte `r(32)||s(32)`.
 *
 * Ledger Cosmos 앱 일부 버전은 DER 을 반환한다. r/s 는 좌측-제로 패딩.
 */
export function derToCompactSig(der: Uint8Array): Uint8Array {
  if (der.length < 8 || der[0] !== 0x30) {
    throw new Error('HwSigner: not a DER sequence');
  }
  let i = 2; // skip 0x30 + total-len
  if (der[i] !== 0x02) throw new Error('HwSigner: DER missing INTEGER (r)');
  const rLen = der[i + 1] ?? 0;
  const rStart = i + 2;
  const r = der.slice(rStart, rStart + rLen);
  i = rStart + rLen;
  if (der[i] !== 0x02) throw new Error('HwSigner: DER missing INTEGER (s)');
  const sLen = der[i + 1] ?? 0;
  const sStart = i + 2;
  const s = der.slice(sStart, sStart + sLen);

  const out = new Uint8Array(64);
  copyRightAligned(stripLeadingZero(r), out, 0, 32);
  copyRightAligned(stripLeadingZero(s), out, 32, 32);
  return out;
}

function stripLeadingZero(b: Uint8Array): Uint8Array {
  // DER 은 양수를 표현하기 위해 0x80 비트가 켜진 r/s 앞에 0x00 을 패딩한다.
  if (b.length > 0 && b[0] === 0x00) return b.slice(1);
  return b;
}

function copyRightAligned(
  src: Uint8Array,
  dst: Uint8Array,
  offset: number,
  width: number,
): void {
  if (src.length > width) {
    throw new Error('HwSigner: DER integer wider than 32 bytes');
  }
  dst.set(src, offset + (width - src.length));
}
