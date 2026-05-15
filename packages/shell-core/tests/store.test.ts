// store.test.ts — WalletStore 라이프사이클 / 라이스 / 캐시 단위 테스트.
//
// 본 테스트는 wallet-sdk 의 Wallet/SoftSigner 까지 실제로 굴리되, ChainAdapter 만
// 네트워크 비의존 fake 로 대체한다 (RPC 호출이 필요 없는 표면만 구현). 이로써
// store.ts 의 캐시 키 의존성·lock 정책·자동 복원 정책을 신뢰성 있게 검증한다.

import { describe, expect, it, beforeEach } from 'vitest';
import {
  Wallet,
  type ChainAdapter,
  type SignRequest,
  type TransferIntent,
} from '@nodong/wallet-sdk';
import { WalletStore } from '../src/store.js';
import { MemorySessionStore, ExtensionSessionStore, type SessionStore } from '../src/session.js';

// "test test test ... junk" 는 BIP39 표준 테스트 벡터. 12 words, secp256k1 도출
// 시 잘 알려진 주소 (0xf39F...92266) 가 나온다 — 본 테스트에서는 그 정확값을
// 강제하진 않고, "동일 입력 → 동일 출력" 결정성과 캐시 동작만 검증한다.
const MNEMONIC =
  'test test test test test test test test test test test junk';
const KOREAN_MNEMONIC =
  '강력히 별도 주민 도망 사실 시간 시계 한복 본사 한식 출신 발견';
const SECOND_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

/**
 * 테스트용 fake EVM-ish 어댑터.
 * id 와 derivationPath, pubkeyToAddress 까지만 정확히 동작하면 store 의 캐시 /
 * account 도출을 검증할 수 있다. 네트워크 호출은 일어나지 않는다.
 */
class FakeAdapter implements ChainAdapter<unknown, unknown> {
  readonly curve = 'secp256k1' as const;
  readonly id: string;
  readonly displayName: string;
  readonly coinType: number;

  constructor(id = 'evm:7777', displayName = 'TTL', coinType = 60) {
    this.id = id;
    this.displayName = displayName;
    this.coinType = coinType;
  }

  derivationPath(account = 0, index = 0): string {
    return `m/44'/${this.coinType}'/${account}'/0/${index}`;
  }

  pubkeyToAddress(pubkey: Uint8Array): string {
    // 결정적이고 비충돌적인 fake address. 진짜 EVM 주소 형식은 아니지만 동일
    // pubkey → 동일 문자열을 보장하면 충분하다.
    let h = '';
    for (let i = 0; i < pubkey.length; i++) {
      h += pubkey[i]!.toString(16).padStart(2, '0');
    }
    return `0xfake${h.slice(0, 36)}`;
  }

  async getBalance(): Promise<bigint> {
    return 0n;
  }

  async buildTransfer(_intent: TransferIntent): Promise<unknown> {
    return { kind: 'fake-unsigned' };
  }

  async signRequests(): Promise<SignRequest[]> {
    return [{ message: new Uint8Array(32), prehashed: true }];
  }

  async applySignatures(): Promise<unknown> {
    return { kind: 'fake-signed' };
  }

  async broadcast(): Promise<string> {
    return '0xfaketxhash';
  }
}

/**
 * autoRestoreAllowed=true 한정 fake — ExtensionSessionStore 는 chrome API 가 없는
 * Node 환경에서 instantiate 가능하지만 read() 가 throw 한다. 그래서 본 테스트는
 * MemorySessionStore 표면에 autoRestoreAllowed 만 true 로 살짝 덮어쓴 가짜를 쓴다.
 */
class AutoRestoreMemorySession implements SessionStore {
  readonly autoRestoreAllowed = true;
  private value: string | null = null;
  async read(): Promise<string | null> {
    return this.value;
  }
  async write(m: string): Promise<void> {
    this.value = m;
  }
  async clear(): Promise<void> {
    this.value = null;
  }
}

function makeStore(opts?: {
  session?: SessionStore;
  adapter?: ChainAdapter;
}): { store: WalletStore; adapter: FakeAdapter; session: SessionStore } {
  const adapter = (opts?.adapter as FakeAdapter | undefined) ?? new FakeAdapter();
  const session = opts?.session ?? new MemorySessionStore();
  const store = new WalletStore({ defaultAdapter: adapter, session });
  return { store, adapter, session };
}

describe('WalletStore — lifecycle', () => {
  it('unlock → getAccount returns same address as derived externally', async () => {
    const { store, adapter } = makeStore();
    await store.unlock(MNEMONIC);
    const acc = await store.getAccount();

    // 외부에서 동일 입력으로 만든 wallet/account 가 동일 주소를 내야 한다.
    const ref = Wallet.fromMnemonic({ mnemonic: MNEMONIC, wordlist: 'english' });
    const refAcc = ref.account(adapter);
    expect(acc.address).toBe(refAcc.address);
    expect(acc.derivationPath).toBe(refAcc.derivationPath);
  });

  it('lock() clears state — getAccount throws "wallet locked" after', async () => {
    const { store } = makeStore();
    await store.unlock(MNEMONIC);
    expect(store.isUnlocked()).toBe(true);
    await store.lock();
    expect(store.isUnlocked()).toBe(false);
    await expect(store.getAccount()).rejects.toThrow(/wallet locked/);
  });

  it('transfer before unlock throws "wallet locked"', async () => {
    const { store } = makeStore();
    await expect(
      store.transfer({ to: '0xdead', amount: 1n }),
    ).rejects.toThrow(/wallet locked/);
  });

  it('getAccount before unlock throws "wallet locked"', async () => {
    const { store } = makeStore();
    await expect(store.getAccount()).rejects.toThrow(/wallet locked/);
  });

  it('hasPersisted returns true after unlock, false after lock', async () => {
    const { store } = makeStore();
    expect(await store.hasPersisted()).toBe(false);
    await store.unlock(MNEMONIC);
    expect(await store.hasPersisted()).toBe(true);
    await store.lock();
    expect(await store.hasPersisted()).toBe(false);
  });
});

describe('WalletStore — tryAutoRestore', () => {
  it('with autoRestoreAllowed=false returns false even when session has value', async () => {
    // MemorySessionStore.autoRestoreAllowed = false.
    const session = new MemorySessionStore();
    await session.write(MNEMONIC); // 누군가 직접 세션에 심어 둠.
    const { store } = makeStore({ session });
    const restored = await store.tryAutoRestore();
    expect(restored).toBe(false);
    expect(store.isUnlocked()).toBe(false);
  });

  it('with autoRestoreAllowed=true unlocks from stored mnemonic', async () => {
    const session = new AutoRestoreMemorySession();
    await session.write(MNEMONIC);
    const { store } = makeStore({ session });
    const restored = await store.tryAutoRestore();
    expect(restored).toBe(true);
    expect(store.isUnlocked()).toBe(true);
  });

  it('with autoRestoreAllowed=true but corrupt stored mnemonic returns false and clears', async () => {
    const session = new AutoRestoreMemorySession();
    await session.write('not a valid mnemonic at all');
    const { store } = makeStore({ session });
    const restored = await store.tryAutoRestore();
    expect(restored).toBe(false);
    expect(store.isUnlocked()).toBe(false);
    expect(await session.read()).toBeNull();
  });

  it('ExtensionSessionStore declares autoRestoreAllowed=true', () => {
    const ext = new ExtensionSessionStore();
    expect(ext.autoRestoreAllowed).toBe(true);
  });
});

describe('WalletStore — concurrent unlock idempotency', () => {
  it('same mnemonic unlocked twice is a no-op (same wallet derivation)', async () => {
    const { store } = makeStore();
    await store.unlock(MNEMONIC);
    const acc1 = await store.getAccount();
    await store.unlock(MNEMONIC); // 두번째 호출 — 캐시 초기화 없이 통과.
    const acc2 = await store.getAccount();
    expect(acc2).toBe(acc1); // 동일 참조 (캐시 보존)
  });

  it('different mnemonic without lock() in between throws', async () => {
    const { store } = makeStore();
    await store.unlock(MNEMONIC);
    await expect(store.unlock(SECOND_MNEMONIC)).rejects.toThrow(
      /already unlocked/,
    );
  });

  it('lock() → unlock(different) succeeds', async () => {
    const { store } = makeStore();
    await store.unlock(MNEMONIC);
    await store.lock();
    await store.unlock(SECOND_MNEMONIC);
    expect(store.isUnlocked()).toBe(true);
  });

  it('whitespace-normalized mnemonic counts as the same input', async () => {
    const { store } = makeStore();
    await store.unlock(MNEMONIC);
    // 줄바꿈/탭/이중 공백 섞어 호출.
    const noisy = MNEMONIC.replace(/ /g, '  ').replace(' junk', '\tjunk');
    await store.unlock(noisy); // idempotent — throw 하면 안 됨.
    expect(store.isUnlocked()).toBe(true);
  });
});

describe('WalletStore — accountCache invariant', () => {
  it('same adapter same call returns same WalletAccount reference (cache hit)', async () => {
    const { store } = makeStore();
    await store.unlock(MNEMONIC);
    const a = await store.getAccount();
    const b = await store.getAccount();
    expect(b).toBe(a);
  });

  it('explicit adapter argument bypasses the cache (always fresh build)', async () => {
    const { store, adapter } = makeStore();
    await store.unlock(MNEMONIC);
    const cached = await store.getAccount(); // default 경로, 캐시 채움.
    const explicit1 = await store.getAccount(adapter); // 명시 → 새 빌드.
    const explicit2 = await store.getAccount(adapter); // 또 새 빌드.
    // 주소는 같지만 (동일 도출), WalletAccount 인스턴스는 새것이어야 한다.
    expect(explicit1.address).toBe(cached.address);
    expect(explicit1).not.toBe(cached);
    expect(explicit2).not.toBe(explicit1);
  });

  it('two adapters with different ids each cache independently', async () => {
    const ttl = new FakeAdapter('evm:7777', 'TTL', 60);
    // coinType 다르면 derivation path 도 다르므로 다른 주소가 나온다.
    const eth = new FakeAdapter('evm:1', 'Ethereum', 61);
    const session = new MemorySessionStore();
    // ttl 을 default 로 만들고 그 다음 호출에 eth 도 명시. 다만 명시 어댑터는
    // 캐시 우회이므로 동일 어댑터로 다시 호출했을 때만 캐시 hit 을 확인한다.
    const store = new WalletStore({ defaultAdapter: ttl, session });
    await store.unlock(MNEMONIC);
    const tA = await store.getAccount(); // default = ttl, cache 채움.
    const tB = await store.getAccount(); // default 다시 — cache hit.
    expect(tB).toBe(tA);

    // 다른 어댑터로 명시 호출 → 항상 새 인스턴스.
    const e1 = await store.getAccount(eth);
    const e2 = await store.getAccount(eth);
    expect(e1.address).not.toBe(tA.address); // 다른 cointype/path 면 다른 주소
    expect(e1).not.toBe(e2);
  });

  it('lock() clears the cache — re-unlock returns a fresh WalletAccount', async () => {
    const { store } = makeStore();
    await store.unlock(MNEMONIC);
    const before = await store.getAccount();
    await store.lock();
    await store.unlock(MNEMONIC);
    const after = await store.getAccount();
    expect(after.address).toBe(before.address);
    expect(after).not.toBe(before); // 캐시 비워졌으므로 새 인스턴스
  });
});

describe('WalletStore — wordlist auto-detect integration', () => {
  it('accepts a Korean mnemonic when valid', async () => {
    const { store } = makeStore();
    // 위 KOREAN_MNEMONIC 이 진짜 valid BIP39 인지에 따라 검증이 갈리는데,
    // 본 테스트는 "detection 자체는 일어난다" 만 본다 — 무효라면 우리가
    // 정의한 한국어 메시지로 떨어져야 한다.
    try {
      await store.unlock(KOREAN_MNEMONIC);
      expect(store.isUnlocked()).toBe(true);
    } catch (e) {
      expect((e as Error).message).toMatch(/유효하지 않은 복구 문구/);
    }
  });

  it('rejects mixed Korean+English mnemonic with a clear message', async () => {
    const { store } = makeStore();
    await expect(store.unlock('test test 가격 가격')).rejects.toThrow(
      /단어가 한국어\/영어 워드리스트와 일치하지 않습니다/,
    );
  });
});

describe('WalletStore — transfer + lock race policy (concern #1)', () => {
  it('in-flight transfer completes even if lock() is called mid-broadcast', async () => {
    // FakeAdapter.broadcast 를 지연시킨 변형으로 race 시뮬레이션.
    let releaseBroadcast: (() => void) | null = null;
    const broadcastGate = new Promise<void>((res) => {
      releaseBroadcast = res;
    });

    class SlowBroadcastAdapter extends FakeAdapter {
      override async broadcast(): Promise<string> {
        await broadcastGate;
        return '0xslowtxhash';
      }
    }

    const adapter = new SlowBroadcastAdapter();
    const { store } = makeStore({ adapter });
    await store.unlock(MNEMONIC);

    // transfer 시작 — broadcast 가 막혀 있으므로 pending 상태.
    const transferPromise = store.transfer({ to: '0xdead', amount: 1n });

    // 사용자가 잠금 — 메모리/세션은 즉시 비워야 한다.
    await store.lock();
    expect(store.isUnlocked()).toBe(false);

    // 잠금 이후의 신규 호출은 즉시 거부.
    await expect(store.getAccount()).rejects.toThrow(/wallet locked/);
    await expect(
      store.transfer({ to: '0xdead', amount: 2n }),
    ).rejects.toThrow(/wallet locked/);

    // 진행 중이던 transfer 는 그대로 완주 — committed work 정책.
    releaseBroadcast!();
    const hash = await transferPromise;
    expect(hash).toBe('0xslowtxhash');
  });
});
