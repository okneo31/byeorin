// 키스토어 (v0.2 빌딩 블록).
//
// 목적: 사용자 passphrase 로 니모닉을 암호화해 영구 스토리지(localStorage /
// chrome.storage.local) 에 보관할 수 있는 SessionStore 구현체를 제공한다.
//
// 위협 모델 / 정책:
//  - autoRestoreAllowed=false  — 부팅 시 자동 복원 금지. 사용자가 passphrase 를
//    명시적으로 입력해야 read() 가 동작한다.
//  - KDF: scrypt (RFC 7914). 기본값 N=2**17 (≈256 MB).
//      * N=2**17 (≈256 MB) 은 데스크톱/노트북에서 1~2초. 단발성 unlock 비용은
//        충분히 감내 가능하며, 오프라인 brute-force 비용을 GPU 대비 크게
//        상승시킨다.
//      * N=2**16 (≈128 MB) 은 BIP-38 권장값과 동일. 모바일/저사양 디바이스에
//        대비한 fast preset (KEYSTORE_PARAMS_FAST) 로 노출한다.
//      * 호출자가 환경에 따라 KeystoreParams 로 override 가능.
//      * 잘못된 passphrase 거부 시점도 scrypt + AES-GCM verify 가 동일하게
//        수행되므로 두 경로의 wallclock 시간이 같아 timing oracle 이 없다.
//  - AEAD: AES-256-GCM via WebCrypto subtle. 12 바이트 nonce. GCM tag(16B) 는
//    ciphertext 끝에 포함된다.
//  - 매 write 마다 새 salt(16B) + 새 nonce(12B) 를 생성한다. 같은 평문/같은
//    passphrase 라도 ciphertext 는 매번 다르다 (확률적 암호화).
//  - Nonce 충돌 안전성: NIST SP 800-38D §8.2.2 는 random 96-bit IV 사용 시
//    동일 키로 최대 2**32 회 암호화까지를 안전 범위로 규정한다. 본 키스토어는
//    "사용자가 직접 wallet 을 잠갔다 풀 때" 한 번 write 가 발생하므로
//    실세계 호출량은 2**16 (수만 회) 을 크게 넘지 않는다 — 2**32 안전선과
//    약 16 비트 여유. 추가로 매 write 가 새 salt 로 새 키를 도출하므로
//    실질적으로 모든 nonce-key 쌍이 일회용이다.
//
// 의도적 비목표:
//  - 메모리 와이프 진짜 보장 — JS 의 GC/string interning 때문에 best-effort 만
//    가능. clearPassphrase() 는 cached passphrase 참조를 끊는다.
//  - 키 stretching 외 추가 hardening (예: HMAC-키 분리, 키 래핑) — 현 버전에서는
//    단일 scrypt 출력 32바이트를 AES-GCM 키로 직접 사용.

import { scryptAsync } from '@noble/hashes/scrypt';
import { shellError } from './errors.js';
// `@noble/hashes/utils` 의 `randomBytes` 는 내부적으로 WebCrypto 의
// `crypto.getRandomValues` (없으면 Node `crypto.randomBytes`) 를 호출하는
// CSPRNG 래퍼다. 16-byte salt 와 12-byte GCM nonce 양쪽에 충분한 엔트로피를
// 제공한다.
import { randomBytes } from '@noble/hashes/utils';
import type { SessionStore } from './session.js';

/**
 * scrypt 파라미터. 모두 RFC 7914 정의를 따른다.
 *
 * - N: CPU/메모리 cost. 2의 거듭제곱. 기본 2**17 (≈256 MB).
 * - r: 블록 크기. 기본 8.
 * - p: 병렬화 인자. 기본 1.
 *
 * Preset 상수:
 *   `KEYSTORE_PARAMS_DEFAULT` — 데스크톱/확장프로그램용 (보수적 보안).
 *   `KEYSTORE_PARAMS_FAST`    — 모바일/저사양용 (BIP-38 동등).
 */
export interface KeystoreParams {
  /** scrypt N (CPU/memory cost). Default 2**17 (~256 MB). */
  N?: number;
  /** scrypt r (block size). Default 8. */
  r?: number;
  /** scrypt p (parallelization). Default 1. */
  p?: number;
}

/**
 * 디폴트 keystore 파라미터 — N=2**17 (≈256 MB scrypt working set).
 *
 * 데스크톱 / 노트북 / 브라우저 확장의 단발성 unlock 비용 (보통 1~2초) 은
 * 사용자가 감내 가능한 수준이며, 동일 cost 의 GPU brute-force 비용을 크게
 * 끌어올린다. `encryptKeystore({ params: KEYSTORE_PARAMS_DEFAULT })` 로
 * 명시적으로 전달하거나 호출자가 옵션을 비워두면 동일한 값이 적용된다.
 */
export const KEYSTORE_PARAMS_DEFAULT: Required<KeystoreParams> = Object.freeze({
  N: 2 ** 17,
  r: 8,
  p: 1,
});

/**
 * 모바일 / 저사양 디바이스용 keystore 파라미터 — N=2**16 (≈128 MB).
 *
 * BIP-38 권장값과 동일. 256 MB working set 이 OOM 또는 1초+ 지연을 유발하는
 * 환경(예: 일부 안드로이드 디바이스, embedded JS 런타임) 에서 fallback 으로
 * 사용한다. 보안 수준은 한 단계 낮지만 여전히 GPU offline attack 에 대해
 * 충분히 비싸다.
 */
export const KEYSTORE_PARAMS_FAST: Required<KeystoreParams> = Object.freeze({
  N: 2 ** 16,
  r: 8,
  p: 1,
});

/**
 * 영구 스토리지에 저장되는 직렬화된 암호문 블롭.
 *
 * 모든 바이너리 필드는 base64 로 인코딩한다 (JSON.stringify 안전).
 * v 필드는 향후 KDF/AEAD 가 바뀔 때 마이그레이션 분기점.
 */
export interface EncryptedBlob {
  v: 1;
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string; // base64 (16 bytes)
  nonce: string; // base64 (12 bytes for AES-GCM)
  ciphertext: string; // base64 — includes 16-byte GCM tag
}

const DEFAULT_N = KEYSTORE_PARAMS_DEFAULT.N;
const DEFAULT_R = KEYSTORE_PARAMS_DEFAULT.r;
const DEFAULT_P = KEYSTORE_PARAMS_DEFAULT.p;
const DK_LEN = 32; // AES-256 key length
const SALT_LEN = 16;
const NONCE_LEN = 12; // GCM standard

// ───────── base64 helpers (브라우저/Node 양쪽에서 동작, Buffer 의존 X) ─────────

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  // btoa 는 latin-1 문자열만 받으므로 위 변환으로 충분.
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

// ───────── KDF + AEAD ─────────

async function derive(
  passphrase: string,
  salt: Uint8Array,
  opts: { N: number; r: number; p: number },
): Promise<Uint8Array> {
  const passBytes = new TextEncoder().encode(passphrase);
  return scryptAsync(passBytes, salt, {
    N: opts.N,
    r: opts.r,
    p: opts.p,
    dkLen: DK_LEN,
  });
}

function getSubtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle) {
    throw shellError(
      'keystore.webcrypto_unavailable',
      'keystore: WebCrypto subtle is unavailable. Requires Node 20+ or a modern browser.',
    );
  }
  return c.subtle;
}

async function importAesKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return getSubtle().importKey(
    'raw',
    rawKey as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function webcryptoEncrypt(
  rawKey: Uint8Array,
  nonce: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  const key = await importAesKey(rawKey);
  const buf = await getSubtle().encrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource },
    key,
    data as BufferSource,
  );
  return new Uint8Array(buf);
}

async function webcryptoDecrypt(
  rawKey: Uint8Array,
  nonce: Uint8Array,
  cipher: Uint8Array,
): Promise<Uint8Array> {
  const key = await importAesKey(rawKey);
  const buf = await getSubtle().decrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource },
    key,
    cipher as BufferSource,
  );
  return new Uint8Array(buf);
}

/**
 * UTF-8 평문(니모닉) 을 passphrase 로 암호화한다.
 * 매 호출마다 새 salt/nonce 를 생성한다 — 같은 입력이라도 출력은 매번 다르다.
 */
export async function encryptKeystore(
  plaintext: string,
  passphrase: string,
  params: KeystoreParams = {},
): Promise<EncryptedBlob> {
  const N = params.N ?? DEFAULT_N;
  const r = params.r ?? DEFAULT_R;
  const p = params.p ?? DEFAULT_P;
  const salt = randomBytes(SALT_LEN);
  const key = await derive(passphrase, salt, { N, r, p });
  const nonce = randomBytes(NONCE_LEN);
  const data = new TextEncoder().encode(plaintext);
  const cipher = await webcryptoEncrypt(key, nonce, data);
  // best-effort: 도출된 키를 즉시 zero-fill. GC 가 보장하지 않으므로 어디까지나
  // "윈도우 축소" 용. RawKey 가 CryptoKey 내부로 복사된 사본까지는 못 지운다.
  key.fill(0);
  return {
    v: 1,
    kdf: 'scrypt',
    N,
    r,
    p,
    salt: toBase64(salt),
    nonce: toBase64(nonce),
    ciphertext: toBase64(cipher),
  };
}

/**
 * 블롭을 복호화한다.
 * 잘못된 passphrase / 변조된 블롭 / 알 수 없는 버전이면 명확한 Error 를 던진다.
 */
export async function decryptKeystore(
  blob: EncryptedBlob,
  passphrase: string,
): Promise<string> {
  if (blob.v !== 1) {
    throw shellError(
      'keystore.unsupported_version',
      `keystore: unknown version ${String(blob.v)}`,
    );
  }
  if (blob.kdf !== 'scrypt') {
    throw shellError(
      'keystore.unsupported_kdf',
      `keystore: unknown kdf ${String(blob.kdf)}`,
    );
  }
  const salt = fromBase64(blob.salt);
  const nonce = fromBase64(blob.nonce);
  const cipher = fromBase64(blob.ciphertext);
  const key = await derive(passphrase, salt, {
    N: blob.N,
    r: blob.r,
    p: blob.p,
  });
  let plain: Uint8Array;
  try {
    plain = await webcryptoDecrypt(key, nonce, cipher);
  } catch {
    key.fill(0);
    throw shellError(
      'keystore.invalid_passphrase',
      'keystore: invalid passphrase or corrupt blob',
    );
  }
  key.fill(0);
  return new TextDecoder().decode(plain);
}

// ───────── Persistent backends ─────────

/**
 * 영구 스토리지 백엔드 추상화.
 *
 * 동기/비동기 API 차이를 흡수해 EncryptedKeystoreStore 가 환경에 무관하게
 * 한 가지 await 패턴만 쓰도록 한다.
 */
export interface PersistentBackend {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** 브라우저/Electron 렌더러용: window.localStorage. */
export class LocalStorageBackend implements PersistentBackend {
  private get ls(): Storage {
    const w = (globalThis as { localStorage?: Storage }).localStorage;
    if (!w) {
      throw new Error(
        'LocalStorageBackend: window.localStorage is unavailable in this runtime',
      );
    }
    return w;
  }

  async read(key: string): Promise<string | null> {
    return this.ls.getItem(key);
  }

  async write(key: string, value: string): Promise<void> {
    this.ls.setItem(key, value);
  }

  async delete(key: string): Promise<void> {
    this.ls.removeItem(key);
  }
}

// chrome.storage.local 외 환경에서 typecheck 하기 위한 최소 표면 타입.
// @types/chrome 의존성을 본 패키지에 들이지 않기 위해 globalThis 로 좁게 접근한다.
interface ChromeLocalLike {
  storage: {
    local: {
      get: (key: string) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>;
      remove: (key: string) => Promise<void>;
    };
  };
}

function getChromeLocal(): ChromeLocalLike {
  const c = (globalThis as { chrome?: ChromeLocalLike }).chrome;
  if (!c) {
    throw new Error(
      'ChromeLocalBackend: chrome.storage.local is unavailable in this runtime',
    );
  }
  return c;
}

/** 브라우저 확장(MV3) 용: chrome.storage.local. */
export class ChromeLocalBackend implements PersistentBackend {
  async read(key: string): Promise<string | null> {
    const out = await getChromeLocal().storage.local.get(key);
    const v = out[key];
    return typeof v === 'string' ? v : null;
  }

  async write(key: string, value: string): Promise<void> {
    await getChromeLocal().storage.local.set({ [key]: value });
  }

  async delete(key: string): Promise<void> {
    await getChromeLocal().storage.local.remove(key);
  }
}

// ───────── EncryptedKeystoreStore (SessionStore impl) ─────────

export interface EncryptedKeystoreStoreOptions {
  backend: PersistentBackend;
  storageKey: string;
  params?: KeystoreParams;
}

/**
 * passphrase 로 보호되는 영구 SessionStore.
 *
 * 사용 패턴:
 *   const ks = new EncryptedKeystoreStore({ backend, storageKey: 'nd:keystore' });
 *   await ks.setPassphrase(userPassphrase);  // 메모리에 캐시
 *   await ks.write(mnemonic);                // 즉시 암호화 후 영구 저장
 *   const m = await ks.read();               // 영구 저장본을 복호화
 *   await ks.clearPassphrase();              // 캐시 폐기 — 다음 read 는 null
 *
 * autoRestoreAllowed=false: 부팅 시 자동 read() 금지. WalletStore 는
 * passphrase 가 주입되기 전까지 잠금 상태를 유지해야 한다.
 */
export class EncryptedKeystoreStore implements SessionStore {
  readonly autoRestoreAllowed = false as const;

  private readonly backend: PersistentBackend;
  private readonly storageKey: string;
  private readonly params: KeystoreParams;
  private passphrase: string | null = null;

  constructor(options: EncryptedKeystoreStoreOptions) {
    this.backend = options.backend;
    this.storageKey = options.storageKey;
    this.params = options.params ?? {};
  }

  /**
   * passphrase 를 메모리에 캐시한다. 즉시 복호화 / 재암호화는 하지 않는다
   * (lazy on read/write).
   *
   * 의도된 시맨틱 (concern #6):
   *  - setPassphrase 는 디스크의 블롭을 건드리지 않는다. 새 passphrase 로
   *    "회전" 하고 싶다면 호출자가 명시적으로 read() → setPassphrase(new) →
   *    write() 시퀀스를 실행해야 한다.
   *  - 디스크의 블롭과 맞지 않는 passphrase 로 read() 하면
   *    "keystore: invalid passphrase or corrupt blob" 으로 throw 한다.
   *  - 동일 인스턴스에 재호출하면 이전 캐시를 덮어쓴다.
   */
  setPassphrase(passphrase: string): void {
    this.passphrase = passphrase;
  }

  /**
   * 캐시된 passphrase 를 폐기한다.
   *
   * JS 의 string interning 과 GC 때문에 진짜 와이프는 불가. 이 호출은
   * 참조만 끊고 의도를 분명히 한다. 메모리 덤프에서 잔존할 수 있음을 가정.
   */
  clearPassphrase(): void {
    this.passphrase = null;
  }

  async read(): Promise<string | null> {
    if (this.passphrase === null) {
      // H1 정책: 자동 복원 금지. 호출자는 passphrase 를 먼저 set 해야 한다.
      return null;
    }
    const raw = await this.backend.read(this.storageKey);
    if (raw === null) return null;
    let blob: EncryptedBlob;
    try {
      blob = JSON.parse(raw) as EncryptedBlob;
    } catch {
      throw shellError(
        'keystore.corrupt_blob',
        'keystore: corrupt blob (invalid JSON)',
      );
    }
    // decryptKeystore 가 잘못된 passphrase 와 무결성 위반을 함께 던진다.
    return decryptKeystore(blob, this.passphrase);
  }

  async write(mnemonic: string): Promise<void> {
    if (this.passphrase === null) {
      throw shellError(
        'keystore.passphrase_required',
        'keystore: passphrase not set; call setPassphrase first',
      );
    }
    const blob = await encryptKeystore(mnemonic, this.passphrase, this.params);
    await this.backend.write(this.storageKey, JSON.stringify(blob));
  }

  /**
   * 영구 블롭 + 메모리 캐시를 모두 폐기한다.
   *
   * SessionStore.clear 시맨틱: 사용자가 명시적 로그아웃 / 지갑 초기화를
   * 했다는 뜻이므로, 디스크와 메모리를 동시에 비운다.
   */
  async clear(): Promise<void> {
    await this.backend.delete(this.storageKey);
    this.clearPassphrase();
  }
}
