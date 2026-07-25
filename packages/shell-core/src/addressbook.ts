// addressbook.ts — 주소록 모듈 (4 셸 공유).
//
// 책임(단일): 송금 대상 주소를 라벨과 함께 보관/조회한다.
//
// 두 종류의 엔트리:
//   - 'self'     — 사용자 본인의 다른 계정 주소. WalletStore 의 계정 목록에서
//                  자동 sync 된다 (syncSelfEntries). 사용자가 직접 편집하지 않는다.
//   - 'external' — 사용자가 손으로 추가한 외부 주소 (거래소, 친구 지갑 등).
//
// 저장: PersistentBackend (localStorage / chrome.storage.local) 에 평문 JSON.
//   주소록은 공개키 파생물(주소)만 담으므로 암호화하지 않는다 — 시드/키 없음.
//   keystore.ts 의 PersistentBackend 인터페이스를 그대로 재사용한다.

import type { PersistentBackend } from './keystore.js';

/**
 * 주소록 한 항목.
 *
 * `chainKey` 는 `@byeorin/wallet-sdk/multichain` 의 ChainKey 와 호환되는 문자열
 * (`evm:ttl`, `btc`, `cosmos:cosmoshub-4`, ...). shell-core 는 멀티체인 모듈을
 * 직접 의존하지 않으므로 타입은 string 으로 느슨하게 둔다.
 */
export interface AddressbookEntry {
  /** deterministic id — `${kind}:${chainKey}:${address}` 소문자. 중복 방지. */
  id: string;
  label: string;
  address: string;
  chainKey: string;
  kind: 'self' | 'external';
  createdAt: number;
}

interface AddressbookBlob {
  v: 1;
  entries: AddressbookEntry[];
}

/** self-sync 입력 — WalletStore 계정 × 체인 매트릭스에서 셸이 만들어 넘긴다. */
export interface SelfAddressInput {
  label: string;
  address: string;
  chainKey: string;
}

function makeId(kind: 'self' | 'external', chainKey: string, address: string): string {
  return `${kind}:${chainKey}:${address}`.toLowerCase();
}

/**
 * 주소록.
 *
 * 사용 패턴:
 *   const book = new Addressbook(new ChromeLocalBackend());
 *   await book.syncSelfEntries(myAccountsMatrix);   // 내 계정 자동 반영
 *   await book.addExternal({ label, address, chainKey });
 *   const all = await book.list();
 *
 * 모든 메서드는 backend read/write 를 거치며, 메모리 캐시로 중복 read 를 줄인다.
 */
export class Addressbook {
  private readonly backend: PersistentBackend;
  private readonly storageKey: string;
  private cache: AddressbookEntry[] | null = null;

  constructor(backend: PersistentBackend, storageKey = 'nd:addressbook') {
    this.backend = backend;
    this.storageKey = storageKey;
  }

  /** 전체 엔트리. self 가 먼저, 그 다음 external — 둘 다 라벨 가나다순. */
  async list(): Promise<AddressbookEntry[]> {
    const all = await this.load();
    const byLabel = (a: AddressbookEntry, b: AddressbookEntry): number =>
      a.label.localeCompare(b.label);
    return [
      ...all.filter((e) => e.kind === 'self').sort(byLabel),
      ...all.filter((e) => e.kind === 'external').sort(byLabel),
    ];
  }

  /** 외부(사용자 추가) 엔트리만. */
  async listExternal(): Promise<AddressbookEntry[]> {
    return (await this.list()).filter((e) => e.kind === 'external');
  }

  /** 내 계정(자동 sync) 엔트리만. */
  async listSelf(): Promise<AddressbookEntry[]> {
    return (await this.list()).filter((e) => e.kind === 'self');
  }

  /**
   * 외부 주소를 추가한다.
   *
   * 동일 (chainKey, address) 가 이미 external 로 있으면 라벨만 갱신하고 그 엔트리를
   * 돌려준다 (idempotent — 중복 throw 대신 덮어쓰기). self 엔트리와는 id namespace 가
   * 다르므로 충돌하지 않는다.
   */
  async addExternal(input: SelfAddressInput): Promise<AddressbookEntry> {
    const all = await this.load();
    const id = makeId('external', input.chainKey, input.address);
    const existing = all.find((e) => e.id === id);
    if (existing) {
      existing.label = input.label;
      await this.save(all);
      return existing;
    }
    const entry: AddressbookEntry = {
      id,
      label: input.label,
      address: input.address,
      chainKey: input.chainKey,
      kind: 'external',
      createdAt: Date.now(),
    };
    all.push(entry);
    await this.save(all);
    return entry;
  }

  /** 엔트리 라벨을 수정한다. self 엔트리도 라벨 변경은 허용 (다음 sync 시 덮어써짐). */
  async updateLabel(id: string, label: string): Promise<void> {
    const all = await this.load();
    const entry = all.find((e) => e.id === id);
    if (!entry) return;
    entry.label = label;
    await this.save(all);
  }

  /** 엔트리를 제거한다. self 엔트리를 지워도 다음 syncSelfEntries 에서 복원된다. */
  async remove(id: string): Promise<void> {
    const all = await this.load();
    const next = all.filter((e) => e.id !== id);
    if (next.length !== all.length) await this.save(next);
  }

  /**
   * 내 계정 주소를 자동 반영한다.
   *
   * 기존 'self' 엔트리를 전부 제거하고 입력 목록으로 새로 채운다. 'external' 은
   * 보존한다. WalletStore 의 계정이 추가/제거/체인 변경될 때마다 셸이 호출한다.
   */
  async syncSelfEntries(inputs: SelfAddressInput[]): Promise<void> {
    const all = await this.load();
    const external = all.filter((e) => e.kind === 'external');
    const now = Date.now();
    const self: AddressbookEntry[] = inputs.map((i) => ({
      id: makeId('self', i.chainKey, i.address),
      label: i.label,
      address: i.address,
      chainKey: i.chainKey,
      kind: 'self',
      createdAt: now,
    }));
    // 동일 id 중복 제거 (같은 주소가 두 번 들어온 경우).
    const deduped = new Map<string, AddressbookEntry>();
    for (const e of self) deduped.set(e.id, e);
    await this.save([...deduped.values(), ...external]);
  }

  /** 주소록 전체 삭제. */
  async clear(): Promise<void> {
    this.cache = [];
    await this.backend.delete(this.storageKey);
  }

  // ────────── private ──────────

  private async load(): Promise<AddressbookEntry[]> {
    if (this.cache !== null) return this.cache;
    const raw = await this.backend.read(this.storageKey);
    if (!raw) {
      this.cache = [];
      return this.cache;
    }
    try {
      const blob = JSON.parse(raw) as AddressbookBlob;
      this.cache = blob.v === 1 && Array.isArray(blob.entries) ? blob.entries : [];
    } catch {
      // 손상된 데이터는 빈 주소록으로 — 주소록은 비치명적이므로 throw 하지 않는다.
      this.cache = [];
    }
    return this.cache;
  }

  private async save(entries: AddressbookEntry[]): Promise<void> {
    this.cache = entries;
    const blob: AddressbookBlob = { v: 1, entries };
    await this.backend.write(this.storageKey, JSON.stringify(blob));
  }
}
