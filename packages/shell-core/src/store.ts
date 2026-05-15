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
 * Wallet 에는 .destroy?() 가 공식적으로 없지만, wallet-sdk 가 향후 best-effort
 * seed 와이프를 추가할 경우 호출할 수 있도록 좁은 표면 타입을 둔다.
 * (wallet-sdk 패키지는 별도 에이전트가 관리하므로 본 패키지에서 강제하지 않는다.)
 */
interface MaybeDestroyable {
  destroy?: () => void;
}

/**
 * 앱 셸 공용 월릿 라이프사이클.
 *
 * 책임:
 *  - 니모닉으로부터 Wallet/계정 파생 (한국어/영어 워드리스트 자동 감지)
 *  - 활성 계정 캐시(체인 어댑터 ID 별, 단 defaultAdapter 호출에 한정)
 *  - 송금 위임
 *  - 세션 저장소와의 read/write/clear 동기화
 *  - 부팅 시 자동 복원 (세션 저장소가 허용하는 경우에만)
 *
 * Race / lifecycle 정책 (이 클래스의 합의된 동작):
 *
 * [lock() vs in-flight transfer]
 *   transfer() 는 호출 시점의 wallet/account 참조를 클로저로 잡는다. lock() 은
 *   진행 중인 transfer 의 broadcast 를 취소하지 않는다 — 이미 서명까지 끝낸
 *   트랜잭션은 "committed work" 로 본다. 다만 lock 이후의 모든 getAccount /
 *   transfer 호출은 즉시 "wallet locked" 로 거부된다. 사용자가 "잠금" 을 누른
 *   순간 새로운 서명은 일어나지 않는다는 보장만 한다.
 *
 * [concurrent unlock()]
 *   동일 니모닉으로 재호출하면 no-op (idempotent). 다른 니모닉으로 호출하면
 *   throw — 사용자는 먼저 lock() 을 명시적으로 해야 한다. 이로써 더블 클릭이나
 *   UI 의 중복 디스패치가 KDF/derive 를 두 번 돌리지 않는다.
 *
 * [accountCache invariant]
 *   adapter ID 가 같아도 다른 RPC URL 로 만들어진 두 어댑터를 서로 다른 호출에
 *   섞어 쓰면 캐시가 잘못된 어댑터의 account 를 돌려줄 수 있다 — 그래서 캐시는
 *   defaultAdapter 호출에만 적용한다. caller 가 명시적으로 adapter 를 넘기면
 *   항상 새 WalletAccount 를 빌드한다. (간단·안전, 성능 비용은 미미.)
 *
 * [메모리 와이프]
 *   JS 의 GC/string interning 때문에 진짜 와이프는 불가능. lock() 은 참조만
 *   끊는다. wallet-sdk 가 destroy() 를 노출하면 호출한다 (현재는 미존재).
 */
export class WalletStore {
  private wallet: Wallet | null = null;
  private currentMnemonic: string | null = null;
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
   *
   * Idempotency (concern #2):
   *  - 이미 동일 니모닉으로 unlocked 상태라면 no-op — KDF/derive 를 다시 돌리지 않는다.
   *  - 이미 다른 니모닉으로 unlocked 상태라면 throw — 명시적 lock() 후 다시 시도하라.
   */
  async unlock(mnemonic: string): Promise<void> {
    const trimmed = mnemonic.trim().replace(/\s+/g, ' ');

    if (this.wallet !== null && this.currentMnemonic !== null) {
      if (this.currentMnemonic === trimmed) {
        // 동일 니모닉 재호출 — 세션 write 가 누락된 경우에 대비해 한 번 더 보장만 해준다.
        await this.session.write(trimmed);
        return;
      }
      throw new Error('already unlocked; call lock() first');
    }

    // detectWordlist 가 한/영 혼재 입력은 명확한 메시지로 throw 한다.
    const wordlist = detectWordlist(trimmed);
    if (!isValidMnemonic(trimmed, wordlist)) {
      throw new Error('유효하지 않은 복구 문구입니다.');
    }
    this.wallet = Wallet.fromMnemonic({ mnemonic: trimmed, wordlist });
    this.currentMnemonic = trimmed;
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
      this.currentMnemonic = null;
      this.accountCache.clear();
      return false;
    }
  }

  /**
   * 활성 계정. adapter 미지정 시 defaultAdapter 를 쓰고 결과를 캐시한다.
   * 명시적으로 adapter 가 주어진 경우 캐시를 우회하고 항상 새로 빌드한다
   * (concern #3: 동일 id 의 어댑터가 서로 다른 RPC 로 만들어졌을 수 있으므로).
   */
  async getAccount(adapter?: ChainAdapter): Promise<WalletAccount> {
    if (!this.wallet) throw new Error('wallet locked');
    if (adapter !== undefined) {
      // 캐시 우회 — caller 가 의도한 정확한 어댑터 인스턴스로 빌드.
      return this.wallet.account(adapter);
    }
    const a = this.defaultAdapter;
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

  /**
   * intent 로 송금. adapter 미지정 시 defaultAdapter.
   *
   * NOTE (concern #1, lock semantics):
   *   transfer 는 시작 시점의 wallet/account 참조를 잡고 진행한다. 중간에
   *   lock() 이 호출되어도 이 함수의 broadcast 는 취소되지 않는다 (이미 서명된
   *   tx 는 committed work). lock 이후의 후속 호출은 즉시 "wallet locked".
   */
  async transfer(intent: TransferIntent, adapter?: ChainAdapter): Promise<TxHash> {
    if (!this.wallet) throw new Error('wallet locked');
    // wallet 참조를 지역으로 들고 가서, lock() 으로 this.wallet 이 null 이 되어도
    // 진행 중인 송금은 마무리되도록 한다 (committed work).
    const w = this.wallet;
    const acc = adapter !== undefined ? w.account(adapter) : await this.getAccount();
    return w.transfer(acc, intent);
  }

  /**
   * 잠금: 메모리/캐시 비우고 세션 저장소도 클리어.
   *
   * 메모리 와이프 (concern #4):
   *  - wallet 참조를 null 로 만들어 GC 대상이 되도록 한다.
   *  - wallet-sdk 가 destroy() 를 노출하면 호출한다 (typeof-체크, 옵션).
   *  - JS 의 GC/string interning 으로 인해 seed/mnemonic 의 실제 메모리 제거는
   *    보장되지 않는다 — best-effort 임을 명시적으로 인정.
   */
  async lock(): Promise<void> {
    const w = this.wallet as (Wallet & MaybeDestroyable) | null;
    if (w && typeof w.destroy === 'function') {
      try {
        w.destroy();
      } catch {
        // destroy 가 실패해도 lock 의 다른 부분은 계속 진행한다.
      }
    }
    this.wallet = null;
    this.currentMnemonic = null;
    this.accountCache.clear();
    await this.session.clear();
  }
}

export function createWalletStore(opts: WalletStoreOptions): WalletStore {
  return new WalletStore(opts);
}
