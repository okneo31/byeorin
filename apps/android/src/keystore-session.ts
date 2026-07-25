// keystore-session.ts — 모바일 셸의 영속 잠금 계층.
//
// 확장(MV3)은 `chrome.storage.session` 이 브라우저 프로세스 수명과 함께 알아서
// 휘발하므로 비밀번호 없이도 "세션" 개념이 성립했다. 앱에는 그런 게 없다.
// 앱을 껐다 켤 때마다 시드를 다시 입력해야 한다면 지갑으로 못 쓰고, 그렇다고
// 평문으로 두면 루팅된 단말에서 그대로 털린다.
//
// 그래서 shell-core 의 `EncryptedKeystoreStore`(scrypt + AES-256-GCM)를
// localStorage 위에 얹고, 그 앞에 세 가지 셸 요구사항을 덧댄 것이 본 모듈이다:
//
//   1. **오입력이 지갑을 지우면 안 된다.**
//      `WalletStore.tryAutoRestore()` 는 복원 중 예외가 나면 세션을 clear 한다
//      (손상 데이터 폐기 정책). 비밀번호를 그 경로에 그대로 물리면 오타 한 번에
//      금고가 날아간다. 따라서 복호화는 `unlock()` 안에서 **먼저** 끝내고,
//      성공한 평문만 메모리 캐시에 올린다. WalletStore 가 보는 read() 는 그
//      캐시일 뿐이라 복호화 실패가 store 까지 전파되지 않는다.
//
//   2. **계정 전환마다 1초씩 멎으면 안 된다.**
//      WalletStore 는 add/select/remove 마다 persist() → write() 를 호출한다.
//      write 를 그대로 scrypt 에 물리면 매번 KDF 를 돌아 UI 가 얼어붙는다.
//      캐시는 즉시 갱신하고 암호화 저장은 디바운스해 백그라운드로 넘긴다.
//
//   3. **자동 복원 가부가 런타임에 바뀐다.**
//      SessionStore.autoRestoreAllowed 를 getter 로 구현해, 비밀번호가 풀린
//      뒤에만 true 가 되게 한다. 잠긴 상태에서는 어떤 경로로도 자동 복원되지
//      않는다 (H1 정책 유지).
//
// 위협 모델상 남는 것: 잠금 해제된 동안 평문 시드가 JS 힙에 존재한다. 이건
// WebView 든 RN 이든 동일하며, 화면 잠금/백그라운드 자동 잠금(autolock.ts)으로
// 노출 창을 좁히는 것이 현실적인 완화책이다.

import {
  EncryptedKeystoreStore,
  KEYSTORE_PARAMS_FAST,
  LocalStorageBackend,
  ShellError,
  type SessionStore,
} from '@byeorin/shell-core';
import { HardwareWrappedBackend, type HardwareStatus } from './vault-hw.js';

/** localStorage 키 — 암호화된 v2 계정 blob 이 여기 들어간다. */
const VAULT_KEY = 'byeorin:vault';

/** 암호화 저장 디바운스. 사용자가 연속으로 계정을 만져도 KDF 는 한 번만 돈다. */
const PERSIST_DEBOUNCE_MS = 350;

/** 비밀번호 최소 길이. scrypt N=2^16 과 합쳐 오프라인 공격 비용을 확보한다. */
export const MIN_PASSPHRASE_LENGTH = 8;

export class MobileKeystoreSession implements SessionStore {
  private readonly inner: EncryptedKeystoreStore;
  private readonly hw: HardwareWrappedBackend;
  /** 복호화된 평문(WalletStore 의 v2 JSON blob). null 이면 잠금 상태. */
  private cache: string | null = null;
  /** 마지막으로 디스크에 확정 기록된 평문 — 불필요한 재암호화를 건너뛴다. */
  private persisted: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private onPersistError: ((e: unknown) => void) | null = null;

  constructor() {
    // localStorage 를 하드웨어 래핑 계층으로 감싼다. 저장되는 바이트는
    // AndroidKeyStore 키로 한 번 더 봉인되므로, 파일만 떠가서는 그 폰 밖에서
    // 비밀번호 대입을 시작할 수 없다 (vault-hw.ts 주석 참고).
    this.hw = new HardwareWrappedBackend(new LocalStorageBackend());
    this.inner = new EncryptedKeystoreStore({
      backend: this.hw,
      storageKey: VAULT_KEY,
      // 모바일 CPU 기준 N=2^17(256MB) 은 저가형 단말에서 OOM/수 초 지연 위험이
      // 있다. BIP-38 권장값과 동일한 N=2^16(128MB) 을 쓴다.
      params: KEYSTORE_PARAMS_FAST,
    });
  }

  // ───────── SessionStore 구현 ─────────

  /** 비밀번호가 풀려 평문 캐시가 살아 있을 때만 자동 복원을 허용한다. */
  get autoRestoreAllowed(): boolean {
    return this.cache !== null;
  }

  async read(): Promise<string | null> {
    return this.cache;
  }

  async write(blob: string): Promise<void> {
    this.cache = blob;
    this.schedulePersist();
  }

  /**
   * **잠금**(금고 삭제 아님).
   *
   * 확장에서는 세션 저장소가 시드의 유일한 사본이라 `WalletStore.lock()` 이
   * 부르는 clear() = 완전 폐기였다. 앱에서 같은 의미로 두면 잠금 버튼 한 번에
   * 지갑이 사라진다. 여기서 clear() 는 "메모리에서 내린다" 로 해석하고,
   * 디스크의 암호화 금고는 남긴다. 금고 자체를 지우는 것은 `wipe()` 뿐이다.
   *
   * 잠그기 전에 대기 중인 저장을 확정한다 — 계정을 추가하자마자 잠가도
   * 그 계정이 유실되지 않는다.
   */
  async clear(): Promise<void> {
    await this.flush();
    this.cache = null;
    this.persisted = null;
    this.inner.clearPassphrase();
  }

  /** 금고 완전 폐기 — 사용자가 "지갑 초기화" 를 명시적으로 선택했을 때만. */
  async wipe(): Promise<void> {
    this.cancelPersist();
    this.cache = null;
    this.persisted = null;
    await this.inner.clear();
  }

  // ───────── 셸이 쓰는 잠금 API ─────────

  /** 이 단말에 저장된 금고가 있는지. 동기 — 첫 화면 분기에 쓴다. */
  hasVault(): boolean {
    try {
      return localStorage.getItem(VAULT_KEY) !== null;
    } catch {
      return false;
    }
  }

  /** 잠금 해제 상태인지(= 평문 캐시 보유). */
  isOpen(): boolean {
    return this.cache !== null;
  }

  /**
   * 저장된 금고를 비밀번호로 연다.
   *
   * 성공하면 평문이 캐시에 올라가고, 이어지는 `WalletStore.tryAutoRestore()`
   * 가 즉시(KDF 재실행 없이) 계정을 복원한다.
   * 비밀번호가 틀리면 ShellError('keystore.invalid_passphrase') 를 던지며,
   * **금고는 손대지 않는다.**
   */
  async unlock(passphrase: string): Promise<void> {
    this.inner.setPassphrase(passphrase);
    let plain: string | null;
    try {
      plain = await this.inner.read();
    } catch (e) {
      this.inner.clearPassphrase();
      throw e;
    }
    if (plain === null) {
      this.inner.clearPassphrase();
      throw new ShellError('keystore.corrupt_blob', 'vault is empty');
    }
    this.cache = plain;
    this.persisted = plain;

    // 하드웨어 래핑 이전에 만들어진 금고를 열었다면 즉시 승급시킨다.
    // persisted 를 비워 두지 않으면 runPersist 의 "내용 동일 → 건너뛰기" 에
    // 걸려 옛 형태로 영영 남는다 (실제로 그렇게 남는 것을 확인하고 고쳤다).
    const hwStatus = await this.hw.probe();
    if (hwStatus.active && this.hw.lastReadWasWrapped === false) {
      this.persisted = null;
      this.schedulePersist();
    }
  }

  /**
   * 새 지갑용 — 아직 금고가 없는 상태에서 비밀번호만 먼저 잡아둔다.
   * 이후 WalletStore 가 write() 를 부르면 이 비밀번호로 암호화된다.
   */
  initialize(passphrase: string): void {
    this.inner.setPassphrase(passphrase);
    // 캐시를 빈 문자열이 아닌 "빈 blob" 으로 두면 autoRestoreAllowed 가 켜지면서
    // WalletStore 가 빈 계정을 복원하려 든다. null 을 유지하고, 첫 write() 가
    // 캐시를 채우게 둔다.
  }

  /** 비밀번호 변경 — 현재 평문을 새 비밀번호로 다시 봉인한다. */
  async changePassphrase(next: string): Promise<void> {
    if (this.cache === null) {
      throw new ShellError('wallet.locked', 'cannot rotate passphrase while locked');
    }
    this.cancelPersist();
    this.inner.setPassphrase(next);
    await this.inner.write(this.cache);
    this.persisted = this.cache;
  }

  /** 디바운스 대기 중인 암호화 저장을 즉시 확정한다. */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      this.runPersist();
    }
    await this.inFlight;
  }

  /** 금고가 이 기기의 보안 하드웨어에 묶여 있는지. UI 표시용. */
  async hardwareStatus(): Promise<HardwareStatus> {
    return this.hw.probe();
  }

  /** 저장 실패(스토리지 가득참 등)를 UI 로 올리기 위한 훅. */
  setPersistErrorHandler(fn: (e: unknown) => void): void {
    this.onPersistError = fn;
  }

  // ───────── 내부 ─────────

  private schedulePersist(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runPersist();
    }, PERSIST_DEBOUNCE_MS);
  }

  private cancelPersist(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * 실제 암호화 저장. 직전 확정본과 같으면 건너뛴다.
   * 여러 번 호출돼도 inFlight 체인에 직렬로 붙어 순서가 뒤집히지 않는다.
   */
  private runPersist(): void {
    const snapshot = this.cache;
    if (snapshot === null || snapshot === this.persisted) return;
    this.inFlight = this.inFlight
      .then(async () => {
        await this.inner.write(snapshot);
        this.persisted = snapshot;
      })
      .catch((e: unknown) => {
        // 저장 실패는 조용히 넘기면 안 된다 — 다음 실행에서 계정이 사라진다.
        this.onPersistError?.(e);
      });
  }
}

/** 셸 전역 인스턴스. */
export const keystoreSession = new MobileKeystoreSession();
