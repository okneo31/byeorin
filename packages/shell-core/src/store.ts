import {
  Wallet,
  isValidMnemonic,
  type ChainAdapter,
  type TransferIntent,
  type TxHash,
  type WalletAccount,
} from '@nodong/wallet-sdk';
import type { SessionStore } from './session.js';
import { detectWordlist } from './wordlist.js';

export interface WalletStoreOptions {
  /** 기본 체인 어댑터(보통 TTL 의 EvmAdapter). */
  defaultAdapter: ChainAdapter;
  /** 앱 환경에 맞는 세션 저장소. */
  session: SessionStore;
}

/**
 * 앱 셸 공용 월릿 라이프사이클.
 *
 * 책임:
 *  - 니모닉으로부터 Wallet/계정 파생 (한국어/영어 워드리스트 자동 감지)
 *  - 활성 계정 캐시(체인 어댑터 ID 별)
 *  - 송금 위임
 *  - 세션 저장소와의 read/write/clear 동기화
 *  - 부팅 시 자동 복원 (세션 저장소가 허용하는 경우에만)
 *
 * 4 개 앱은 본 클래스의 동일 인스턴스 인터페이스만 사용한다.
 */
export class WalletStore {
  private wallet: Wallet | null = null;
  private accountCache = new Map<string, WalletAccount>();
  private readonly session: SessionStore;
  private readonly defaultAdapter: ChainAdapter;

  constructor(opts: WalletStoreOptions) {
    this.defaultAdapter = opts.defaultAdapter;
    this.session = opts.session;
  }

  /** 현재 메모리에 wallet 이 로드되어 있는지(=잠금 해제 상태인지). */
  isUnlocked(): boolean {
    return this.wallet !== null;
  }

  /** 세션 저장소에 니모닉이 남아 있는지. autoRestoreAllowed 여부와 무관하게 단순 조회. */
  async hasPersisted(): Promise<boolean> {
    return (await this.session.read()) !== null;
  }

  /**
   * 니모닉으로 잠금 해제. trim/공백 정규화 후 워드리스트를 자동 감지해 검증한다.
   * 성공 시 활성 계정 캐시는 초기화되고, 세션 저장소에 니모닉이 기록된다.
   */
  async unlock(mnemonic: string): Promise<void> {
    const trimmed = mnemonic.trim().replace(/\s+/g, ' ');
    const wordlist = detectWordlist(trimmed);
    if (!isValidMnemonic(trimmed, wordlist)) {
      throw new Error('유효하지 않은 복구 문구입니다.');
    }
    this.wallet = Wallet.fromMnemonic({ mnemonic: trimmed, wordlist });
    this.accountCache.clear();
    await this.session.write(trimmed);
  }

  /**
   * 세션 저장소가 허용할 때만 자동 복원을 시도한다. 복원되었으면 true.
   * 어떤 이유로 저장된 값이 유효하지 않으면 조용히 세션을 비우고 false 반환.
   */
  async tryAutoRestore(): Promise<boolean> {
    if (!this.session.autoRestoreAllowed) return false;
    const m = await this.session.read();
    if (!m) return false;
    try {
      await this.unlock(m);
      return true;
    } catch {
      await this.session.clear();
      this.wallet = null;
      this.accountCache.clear();
      return false;
    }
  }

  /**
   * 활성 계정. adapter 미지정 시 defaultAdapter 사용.
   * 동일 adapter.id 에 대해서는 캐시된 결과를 재사용한다.
   */
  async getAccount(adapter?: ChainAdapter): Promise<WalletAccount> {
    if (!this.wallet) throw new Error('wallet locked');
    const a = adapter ?? this.defaultAdapter;
    let acc = this.accountCache.get(a.id);
    if (!acc) {
      acc = this.wallet.account(a);
      this.accountCache.set(a.id, acc);
    }
    return acc;
  }

  /** 기본 어댑터 — 잔액 조회 등 read-only 호출에 사용. */
  getDefaultAdapter(): ChainAdapter {
    return this.defaultAdapter;
  }

  /** intent 로 송금. adapter 미지정 시 defaultAdapter. */
  async transfer(intent: TransferIntent, adapter?: ChainAdapter): Promise<TxHash> {
    if (!this.wallet) throw new Error('wallet locked');
    const acc = await this.getAccount(adapter);
    return this.wallet.transfer(acc, intent);
  }

  /** 잠금: 메모리/캐시 비우고 세션 저장소도 클리어. */
  async lock(): Promise<void> {
    this.wallet = null;
    this.accountCache.clear();
    await this.session.clear();
  }
}

export function createWalletStore(opts: WalletStoreOptions): WalletStore {
  return new WalletStore(opts);
}
