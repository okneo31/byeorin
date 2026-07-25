// /core subpath — shell-core 는 어떤 chain adapter 구현도 알 필요가 없다.
// 본 모듈을 통해 wallet-sdk 의 메인 barrel 이 끌려오면 컨슈머(브라우저 확장) bundle 에
// 모든 체인 라이브러리가 함께 들어가 popup 마운트가 실패한다.
import {
  Wallet,
  accountFromPrivateKey,
  isValidMnemonic,
  privateKeyToHex,
  transferAccount,
  type ChainAdapter,
  type TransferIntent,
  type TxHash,
  type WalletAccount,
} from '@byeorin/wallet-sdk/core';
import { shellError } from './errors.js';
import type { SessionStore } from './session.js';
import { detectWordlist } from './wordlist.js';

export interface WalletStoreOptions {
  /** 기본 체인 어댑터(보통 TTL 의 EvmAdapter). */
  defaultAdapter: ChainAdapter;
  /** 앱 환경에 맞는 세션 저장소. */
  session: SessionStore;
}

/**
 * 한 슬롯에 들어가는 계정의 메모리 표현.
 *
 * - mnemonic 계정: BIP39 시드구문 + 첫 derivation 결과를 lazy 로 캐시한 Wallet.
 *   추후 다른 어댑터로도 같은 Wallet 에서 계정 파생 가능.
 * - privateKey 계정: 32바이트 raw key 의 hex 표현(0x...). HD 파생 X — 단일 계정.
 *
 * 두 종류 모두 `defaultAdapter` 기준 주소를 `cachedAddress` 에 보관해
 * `listAccounts()` 가 동기/즉시 응답할 수 있게 한다.
 */
interface Slot {
  kind: 'mnemonic' | 'privateKey';
  label: string | null;
  /** mnemonic 계정은 trimmed/normalized 시드구문, privateKey 계정은 0x... hex 64자. */
  secret: string;
  /** mnemonic 계정에서만 채워진다. lazy 로 mnemonicToSeed 비용 회피. */
  wallet: Wallet | null;
  /** defaultAdapter 기준 주소. addAccount 시점에 한 번 계산. */
  cachedAddress: string;
}

/** listAccounts() 의 read-only view. UI 가 셀렉터를 그릴 때 충분한 정보. */
export interface AccountInfo {
  idx: number;
  kind: 'mnemonic' | 'privateKey';
  /** 사용자 부여 라벨. null 이면 UI 가 기본값(예: `Account 1`)을 보여준다. */
  label: string | null;
  /** defaultAdapter 기준 주소. */
  address: string;
  /** 현재 활성 계정인지. */
  active: boolean;
}

/** 세션 직렬화 포맷 v2 — 다중 계정. 옛 v1 = 그냥 mnemonic string. */
interface SessionBlobV2 {
  v: 2;
  active: number;
  accounts: Array<
    | { kind: 'mnemonic'; label: string | null; mnemonic: string }
    | { kind: 'privateKey'; label: string | null; privateKeyHex: string }
  >;
}

/**
 * 앱 셸 공용 월릿 라이프사이클 (다중 계정 v2).
 *
 * 책임:
 *  - 시드(BIP-39) 또는 raw private key 로 계정을 만들고 관리한다.
 *  - 활성 계정 1개 + 추가 계정 N개를 메모리에 보유한다.
 *  - 송금 / 잔액 조회는 활성 계정에 위임한다.
 *  - 세션 저장소와의 read/write/clear 동기화 — v2 JSON 직렬화.
 *    옛 v1 단일 mnemonic 형식도 부팅 시 자동 마이그레이션해 읽는다.
 *
 * 옛 단일 계정 API 호환:
 *   - `unlock(mnemonic)` 은 그대로 동작 — 첫 계정으로 잠금 해제.
 *   - `getAccount/transfer/lock/isUnlocked/hasPersisted/tryAutoRestore` 시그니처 유지.
 *
 * Race / lifecycle 정책 (옛 단일 계정에서 그대로 계승):
 *
 * [lock() vs in-flight transfer]
 *   transfer() 는 호출 시점의 account 참조를 클로저로 잡는다. lock() 은 진행 중인
 *   transfer 의 broadcast 를 취소하지 않는다 — 이미 서명까지 끝낸 tx 는 committed.
 *
 * [concurrent unlock()]
 *   동일 첫 mnemonic 으로 재호출하면 no-op. 다른 mnemonic 으로 호출하면 throw.
 *   더블 클릭이 KDF 를 두 번 돌리지 않도록 보호.
 *
 * [account add idempotency]
 *   동일 mnemonic / privateKey 가 이미 추가되어 있으면 `account.duplicate` throw.
 *   호출자가 의도적으로 중복을 두려면 명시적으로 다른 라벨로 시도해야 한다.
 *
 * [메모리 와이프]
 *   JS GC/string interning 한계로 실제 와이프 불가. lock() 은 참조만 끊고
 *   상태를 초기화한다.
 */
export class WalletStore {
  private accounts: Slot[] = [];
  private active = 0;
  private readonly session: SessionStore;
  private readonly defaultAdapter: ChainAdapter;
  /** defaultAdapter 호출용 활성 계정 캐시. selectAccount/addAccount 시 invalidate. */
  private activeAccountCache: WalletAccount | null = null;

  constructor(opts: WalletStoreOptions) {
    this.defaultAdapter = opts.defaultAdapter;
    this.session = opts.session;
  }

  /** 현재 메모리에 계정이 하나라도 로드되어 있는지(=잠금 해제 상태). */
  isUnlocked(): boolean {
    return this.accounts.length > 0;
  }

  /** 세션 저장소에 데이터가 남아 있는지. autoRestoreAllowed 와 무관. */
  async hasPersisted(): Promise<boolean> {
    return (await this.session.read()) !== null;
  }

  /**
   * 첫 mnemonic 계정으로 잠금 해제 (옛 단일 계정 API 보존).
   *
   * Idempotency:
   *  - 이미 unlocked + 활성이 동일 mnemonic 이면 no-op (세션 write 만 보장).
   *  - 이미 unlocked + 다른 상태이면 throw — 명시적으로 lock() 후 다시 시도.
   *
   * 호출 후:
   *  - accounts = [첫 mnemonic 계정 1개]
   *  - active = 0
   *  - session 에 v2 blob 기록
   */
  async unlock(mnemonic: string): Promise<void> {
    const trimmed = mnemonic.trim().replace(/\s+/g, ' ');
    if (this.isUnlocked()) {
      const first = this.accounts[0]!;
      if (
        this.accounts.length === 1 &&
        first.kind === 'mnemonic' &&
        first.secret === trimmed
      ) {
        await this.persist();
        return;
      }
      throw shellError(
        'wallet.already_unlocked',
        'already unlocked; call lock() first',
      );
    }
    const slot = this.buildMnemonicSlot(trimmed, null);
    this.accounts = [slot];
    this.active = 0;
    this.activeAccountCache = null;
    await this.persist();
  }

  /**
   * 이미 잠금 해제된 상태에 시드 기반 계정을 추가한다. 잠금이라면 자동으로 첫 계정으로 시작.
   * 동일 시드가 이미 있으면 `account.duplicate` 로 throw.
   */
  async addMnemonicAccount(mnemonic: string, label: string | null = null): Promise<number> {
    const trimmed = mnemonic.trim().replace(/\s+/g, ' ');
    if (this.accounts.some((a) => a.kind === 'mnemonic' && a.secret === trimmed)) {
      throw shellError('account.duplicate', 'mnemonic already present in store');
    }
    const slot = this.buildMnemonicSlot(trimmed, label);
    this.accounts.push(slot);
    const idx = this.accounts.length - 1;
    await this.persist();
    return idx;
  }

  /**
   * raw 32바이트 private key 를 hex 로 받아 import 한다. EVM/secp256k1 어댑터 대상.
   *
   * 검증:
   *   - 0x 선택적 prefix + 64자 hex
   *   - 0 < d < secp256k1 order (wallet-sdk 가 위임 검사)
   *
   * 동일 키가 이미 있으면 `account.duplicate`.
   */
  async importPrivateKey(privateKeyHex: string, label: string | null = null): Promise<number> {
    const normalized = normalizePrivateKeyHex(privateKeyHex);
    if (this.accounts.some((a) => a.kind === 'privateKey' && a.secret === normalized)) {
      throw shellError('account.duplicate', 'privateKey already present in store');
    }
    const slot = this.buildPrivateKeySlot(normalized, label);
    this.accounts.push(slot);
    const idx = this.accounts.length - 1;
    await this.persist();
    return idx;
  }

  /** 활성 계정 인덱스 변경. */
  async selectAccount(idx: number): Promise<void> {
    this.assertIndex(idx);
    if (this.active === idx) return;
    this.active = idx;
    this.activeAccountCache = null;
    await this.persist();
  }

  /** 메모리 상태의 계정 목록을 동기 반환. address 는 defaultAdapter 기준 캐시. */
  listAccounts(): AccountInfo[] {
    return this.accounts.map((slot, idx) => ({
      idx,
      kind: slot.kind,
      label: slot.label,
      address: slot.cachedAddress,
      active: idx === this.active,
    }));
  }

  /** 현재 활성 인덱스. unlocked 상태가 아니면 -1. */
  getActiveIndex(): number {
    return this.isUnlocked() ? this.active : -1;
  }

  /**
   * 인덱스 idx 의 계정을 제거한다.
   *  - 마지막 1개 계정이면 throw — 사용자가 의도한 동작이라면 명시적으로 lock() 을 호출하라.
   *  - 활성 계정을 지우면 다음 가용 idx 로 active 가 이동한다.
   */
  async removeAccount(idx: number): Promise<void> {
    this.assertIndex(idx);
    if (this.accounts.length <= 1) {
      throw shellError(
        'account.last_cannot_remove',
        'cannot remove the last account; call lock() instead',
      );
    }
    this.accounts.splice(idx, 1);
    if (this.active === idx) {
      // 활성을 지웠다 — 같은 위치에 있던 다음 항목이 자동 활성이 된다.
      // splice 후 idx 가 length 와 같으면 마지막을 가리키므로 한 칸 당겨 준다.
      this.active = Math.min(idx, this.accounts.length - 1);
    } else if (this.active > idx) {
      // 활성이 지워진 항목 뒤에 있었다 — 한 칸 당김.
      this.active -= 1;
    }
    this.activeAccountCache = null;
    await this.persist();
  }

  /** raw private key 노출. 보안 게이트는 호출자(UI) 책임. */
  async exportPrivateKey(idx: number): Promise<string> {
    this.assertIndex(idx);
    const slot = this.accounts[idx]!;
    if (slot.kind === 'privateKey') return slot.secret;
    // mnemonic 계정 — defaultAdapter 의 derivation path 로 첫 계정 키 노출.
    // 사용자가 raw key 로 다른 지갑에 import 할 의도. defaultAdapter 가 secp256k1 일 때만 유의미.
    if (this.defaultAdapter.curve !== 'secp256k1') {
      throw shellError(
        'account.kind_mismatch',
        'exportPrivateKey: defaultAdapter curve is not secp256k1',
      );
    }
    if (!slot.wallet) {
      slot.wallet = Wallet.fromMnemonic({
        mnemonic: slot.secret,
        wordlist: detectWordlist(slot.secret),
      });
    }
    // signer 의 raw key 는 SoftSigner 내부에 보관되므로 직접 노출은 SDK 제한.
    // 우회: WalletAccount 빌드 후 signer 의 private 필드는 접근 X — 대신 직접 derive.
    // 여기서는 wallet.account(adapter).signer 가 평문 키를 들고 있으나 SDK 가 export 하지 않음.
    // → 임시 우회: hdkey 모듈을 직접 호출. 본 우회는 v0.6 SDK 의 signer.exportKey() 도입 후 제거.
    // 1차 stage 에서는 mnemonic 계정의 raw key export 를 미지원으로 두고 명확한 에러를 던진다.
    throw shellError(
      'account.kind_mismatch',
      'exportPrivateKey on a mnemonic account is not supported yet; use exportMnemonic instead',
    );
  }

  /** mnemonic 노출. privateKey 계정에는 적용 불가. */
  async exportMnemonic(idx: number): Promise<string> {
    this.assertIndex(idx);
    const slot = this.accounts[idx]!;
    if (slot.kind !== 'mnemonic') {
      throw shellError(
        'account.kind_mismatch',
        'exportMnemonic: this account was imported as private key',
      );
    }
    return slot.secret;
  }

  /**
   * 세션 저장소가 허용할 때만 자동 복원 시도. 성공 시 true.
   * 옛 v1(평문 mnemonic) 과 v2(JSON blob) 둘 다 마이그레이션해 받아 들인다.
   */
  async tryAutoRestore(): Promise<boolean> {
    if (!this.session.autoRestoreAllowed) return false;
    const raw = await this.session.read();
    if (!raw) return false;
    try {
      const restored = this.deserialize(raw);
      if (restored === null || restored.slots.length === 0) {
        await this.session.clear();
        return false;
      }
      this.accounts = restored.slots;
      this.active = restored.active;
      this.activeAccountCache = null;
      // 옛 v1 형식을 읽었다면 v2 로 재기록 (마이그레이션).
      // v2 였더라도 새 인스턴스이므로 한 번 더 write 해도 안전.
      await this.persist();
      return true;
    } catch {
      // 손상된 데이터는 조용히 폐기.
      await this.session.clear();
      this.accounts = [];
      this.active = 0;
      this.activeAccountCache = null;
      return false;
    }
  }

  /**
   * 활성 계정을 빌드해 돌려준다. adapter 미지정 시 defaultAdapter + 결과 캐시.
   * 명시적으로 adapter 가 주어지면 캐시 우회.
   */
  async getAccount(adapter?: ChainAdapter): Promise<WalletAccount> {
    if (!this.isUnlocked()) throw shellError('wallet.locked', 'wallet locked');
    if (adapter !== undefined) {
      return this.buildAccount(this.accounts[this.active]!, adapter);
    }
    if (!this.activeAccountCache) {
      this.activeAccountCache = this.buildAccount(
        this.accounts[this.active]!,
        this.defaultAdapter,
      );
    }
    return this.activeAccountCache;
  }

  /**
   * 임의 슬롯 + 임의 어댑터로 계정을 빌드한다 (캐시 우회, 항상 새 인스턴스).
   *
   * 용도: 멀티체인 주소 매트릭스 — 활성/비활성 무관하게 특정 계정의 특정 체인
   * 주소를 얻는다. 셸이 `@byeorin/wallet-sdk/multichain` 의 ChainSpec.build() 로
   * 만든 어댑터를 넘기면, shell-core 는 멀티체인 라이브러리를 직접 의존하지 않고도
   * N 계정 × M 체인 매트릭스를 만들 수 있다.
   */
  getAccountAt(idx: number, adapter: ChainAdapter): WalletAccount {
    this.assertIndex(idx);
    return this.buildAccount(this.accounts[idx]!, adapter);
  }

  /** 기본 어댑터 — 잔액 조회 등 read-only 호출에 사용. */
  getDefaultAdapter(): ChainAdapter {
    return this.defaultAdapter;
  }

  /**
   * intent 로 송금. adapter 미지정 시 defaultAdapter. 활성 계정 기준.
   *
   * lock semantics: transfer 는 시작 시점의 account 참조를 잡는다. 중간에 lock() 이
   * 호출되어도 broadcast 는 취소되지 않는다 (committed work).
   */
  async transfer(intent: TransferIntent, adapter?: ChainAdapter): Promise<TxHash> {
    if (!this.isUnlocked()) throw shellError('wallet.locked', 'wallet locked');
    const slot = this.accounts[this.active]!;
    const acc = this.buildAccount(slot, adapter ?? this.defaultAdapter);
    return transferAccount(acc, intent);
  }

  /**
   * 잠금: 모든 계정 상태 + 캐시 비우고 세션 저장소도 클리어.
   * 메모리 와이프는 best-effort — JS GC/string interning 한계.
   */
  async lock(): Promise<void> {
    for (const slot of this.accounts) {
      // 향후 Wallet.destroy() 가 노출되면 호출.
      const w = slot.wallet as (Wallet & { destroy?: () => void }) | null;
      if (w && typeof w.destroy === 'function') {
        try {
          w.destroy();
        } catch {
          // destroy 실패해도 다른 정리는 진행.
        }
      }
    }
    this.accounts = [];
    this.active = 0;
    this.activeAccountCache = null;
    await this.session.clear();
  }

  // ────────── private helpers ──────────

  private assertIndex(idx: number): void {
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.accounts.length) {
      throw shellError('account.not_found', `account index ${idx} out of range`);
    }
  }

  private buildMnemonicSlot(trimmedMnemonic: string, label: string | null): Slot {
    const wordlist = detectWordlist(trimmedMnemonic);
    if (!isValidMnemonic(trimmedMnemonic, wordlist)) {
      throw shellError('mnemonic.invalid', 'Invalid recovery phrase.');
    }
    const wallet = Wallet.fromMnemonic({ mnemonic: trimmedMnemonic, wordlist });
    const acc = wallet.account(this.defaultAdapter);
    return {
      kind: 'mnemonic',
      label,
      secret: trimmedMnemonic,
      wallet,
      cachedAddress: acc.address,
    };
  }

  private buildPrivateKeySlot(normalizedHex: string, label: string | null): Slot {
    // wallet-sdk 가 hex 파싱·범위 검증·SoftSigner 생성·주소 파생을 한 번에 처리.
    let acc: WalletAccount;
    try {
      acc = accountFromPrivateKey(normalizedHex, this.defaultAdapter);
    } catch (e) {
      throw shellError(
        'privateKey.invalid',
        `privateKey rejected: ${(e as Error).message}`,
      );
    }
    return {
      kind: 'privateKey',
      label,
      secret: normalizedHex,
      wallet: null,
      cachedAddress: acc.address,
    };
  }

  private buildAccount(slot: Slot, adapter: ChainAdapter): WalletAccount {
    if (slot.kind === 'mnemonic') {
      if (!slot.wallet) {
        slot.wallet = Wallet.fromMnemonic({
          mnemonic: slot.secret,
          wordlist: detectWordlist(slot.secret),
        });
      }
      return slot.wallet.account(adapter);
    }
    return accountFromPrivateKey(slot.secret, adapter);
  }

  private async persist(): Promise<void> {
    const blob: SessionBlobV2 = {
      v: 2,
      active: this.active,
      accounts: this.accounts.map((s) =>
        s.kind === 'mnemonic'
          ? { kind: 'mnemonic', label: s.label, mnemonic: s.secret }
          : { kind: 'privateKey', label: s.label, privateKeyHex: s.secret },
      ),
    };
    await this.session.write(JSON.stringify(blob));
  }

  /**
   * 저장된 raw string 을 슬롯 배열로 역직렬화.
   *
   * 두 형식을 받아 들인다:
   *  - v1 (legacy): 그냥 mnemonic 평문. 단일 mnemonic 계정으로 마이그레이션.
   *  - v2: { v: 2, active, accounts: [...] } JSON.
   *
   * 알 수 없는 형식이면 null. 호출자가 세션을 클리어한다.
   */
  private deserialize(raw: string): { slots: Slot[]; active: number } | null {
    const trimmed = raw.trim();
    // v2 JSON 시도. `{` 로 시작하지 않으면 옛 평문 mnemonic 으로 간주.
    if (trimmed.startsWith('{')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return null;
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        (parsed as { v?: unknown }).v !== 2
      ) {
        return null;
      }
      const blob = parsed as SessionBlobV2;
      if (!Array.isArray(blob.accounts) || blob.accounts.length === 0) return null;
      const slots: Slot[] = [];
      for (const a of blob.accounts) {
        if (a.kind === 'mnemonic') {
          slots.push(this.buildMnemonicSlot(a.mnemonic, a.label ?? null));
        } else if (a.kind === 'privateKey') {
          slots.push(this.buildPrivateKeySlot(a.privateKeyHex, a.label ?? null));
        } else {
          return null;
        }
      }
      const active =
        Number.isInteger(blob.active) && blob.active >= 0 && blob.active < slots.length
          ? blob.active
          : 0;
      return { slots, active };
    }
    // v1 legacy — 평문 mnemonic 한 개.
    return {
      slots: [this.buildMnemonicSlot(trimmed.replace(/\s+/g, ' '), null)],
      active: 0,
    };
  }
}

/**
 * `0x` 선택적 prefix 의 hex 문자열을 정규화한다 (소문자 + 0x prefix + 64자 검증).
 * 실제 키 range 검증(0 < d < n) 은 wallet-sdk 의 `accountFromPrivateKey` 가 수행.
 */
function normalizePrivateKeyHex(input: string): string {
  let s = input.trim();
  if (s.startsWith('0x') || s.startsWith('0X')) s = s.slice(2);
  if (s.length !== 64) {
    throw shellError(
      'privateKey.invalid',
      `privateKey must be 64 hex chars (32 bytes), got ${s.length}`,
    );
  }
  if (!/^[0-9a-fA-F]+$/.test(s)) {
    throw shellError('privateKey.invalid', 'privateKey contains non-hex characters');
  }
  return '0x' + s.toLowerCase();
}

/** privateKey hex 문자열의 표시용 helper — UI 가 호출. */
export { privateKeyToHex };

export function createWalletStore(opts: WalletStoreOptions): WalletStore {
  return new WalletStore(opts);
}
