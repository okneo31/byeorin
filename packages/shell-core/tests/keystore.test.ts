// keystore.test.ts — 셸 코어 암호화 키스토어 회귀 테스트.
//
// 테스트 속도용으로 N=2**8 을 사용한다 (≈수 ms). 프로덕션 기본값 2**16 은
// 노트북에서 ~1초 걸려서 단위 테스트엔 부적합. KDF 정확성은 동일 코드 경로
// (scryptAsync) 를 타므로 파라미터만 바꿔도 회귀 신호는 유효하다.

import { describe, expect, it } from 'vitest';
import {
  EncryptedKeystoreStore,
  decryptKeystore,
  encryptKeystore,
  type EncryptedBlob,
  type KeystoreParams,
  type PersistentBackend,
} from '../src/keystore.js';

const TEST_PARAMS: KeystoreParams = { N: 2 ** 8, r: 8, p: 1 };
const MNEMONIC =
  'test test test test test test test test test test test junk';
const PASS = 'correct horse battery staple';

/**
 * 테스트 전용 인메모리 백엔드.
 * cross-instance 시나리오를 위해 한 Map 을 여러 인스턴스가 공유할 수 있도록 한다.
 */
class MemoryBackend implements PersistentBackend {
  constructor(private readonly store: Map<string, string> = new Map()) {}

  async read(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async write(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

describe('encryptKeystore / decryptKeystore', () => {
  it('round-trips a UTF-8 mnemonic', async () => {
    const blob = await encryptKeystore(MNEMONIC, PASS, TEST_PARAMS);
    expect(blob.v).toBe(1);
    expect(blob.kdf).toBe('scrypt');
    expect(blob.N).toBe(TEST_PARAMS.N);
    const out = await decryptKeystore(blob, PASS);
    expect(out).toBe(MNEMONIC);
  });

  it('throws "invalid passphrase" on wrong passphrase', async () => {
    const blob = await encryptKeystore(MNEMONIC, PASS, TEST_PARAMS);
    await expect(decryptKeystore(blob, 'wrong passphrase')).rejects.toThrow(
      /invalid passphrase/,
    );
  });

  it('produces different blobs on two writes with same passphrase (random salt+nonce)', async () => {
    const a = await encryptKeystore(MNEMONIC, PASS, TEST_PARAMS);
    const b = await encryptKeystore(MNEMONIC, PASS, TEST_PARAMS);
    expect(a.salt).not.toBe(b.salt);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    // 그러나 둘 다 같은 passphrase 로 풀려야 한다.
    expect(await decryptKeystore(a, PASS)).toBe(MNEMONIC);
    expect(await decryptKeystore(b, PASS)).toBe(MNEMONIC);
  });

  it('throws on unknown version', async () => {
    const blob: EncryptedBlob = {
      ...(await encryptKeystore(MNEMONIC, PASS, TEST_PARAMS)),
      v: 2 as unknown as 1,
    };
    await expect(decryptKeystore(blob, PASS)).rejects.toThrow(/unknown version/);
  });

  it('throws on unknown kdf', async () => {
    const blob: EncryptedBlob = {
      ...(await encryptKeystore(MNEMONIC, PASS, TEST_PARAMS)),
      kdf: 'pbkdf2' as unknown as 'scrypt',
    };
    await expect(decryptKeystore(blob, PASS)).rejects.toThrow(/unknown kdf/);
  });
});

describe('EncryptedKeystoreStore', () => {
  it('write → read returns the written mnemonic after setPassphrase', async () => {
    const backend = new MemoryBackend();
    const ks = new EncryptedKeystoreStore({
      backend,
      storageKey: 'nd:keystore',
      params: TEST_PARAMS,
    });
    ks.setPassphrase(PASS);
    await ks.write(MNEMONIC);
    expect(await ks.read()).toBe(MNEMONIC);
  });

  it('read returns null when no passphrase is set', async () => {
    const backend = new MemoryBackend();
    // 미리 다른 인스턴스로 블롭을 심어둔다.
    const seeder = new EncryptedKeystoreStore({
      backend,
      storageKey: 'nd:keystore',
      params: TEST_PARAMS,
    });
    seeder.setPassphrase(PASS);
    await seeder.write(MNEMONIC);

    const ks = new EncryptedKeystoreStore({
      backend,
      storageKey: 'nd:keystore',
      params: TEST_PARAMS,
    });
    // passphrase 미설정 — null 이어야 한다 (H1 자동 복원 금지).
    expect(await ks.read()).toBeNull();
  });

  it('read returns null when no blob exists yet (even with passphrase set)', async () => {
    const backend = new MemoryBackend();
    const ks = new EncryptedKeystoreStore({
      backend,
      storageKey: 'nd:keystore',
      params: TEST_PARAMS,
    });
    ks.setPassphrase(PASS);
    expect(await ks.read()).toBeNull();
  });

  it('write throws when passphrase is not set', async () => {
    const backend = new MemoryBackend();
    const ks = new EncryptedKeystoreStore({
      backend,
      storageKey: 'nd:keystore',
      params: TEST_PARAMS,
    });
    await expect(ks.write(MNEMONIC)).rejects.toThrow(/passphrase not set/);
  });

  it('read throws on wrong passphrase', async () => {
    const backend = new MemoryBackend();
    const writer = new EncryptedKeystoreStore({
      backend,
      storageKey: 'nd:keystore',
      params: TEST_PARAMS,
    });
    writer.setPassphrase(PASS);
    await writer.write(MNEMONIC);

    const reader = new EncryptedKeystoreStore({
      backend,
      storageKey: 'nd:keystore',
      params: TEST_PARAMS,
    });
    reader.setPassphrase('wrong');
    await expect(reader.read()).rejects.toThrow(/invalid passphrase/);
  });

  it('clear() wipes the persisted blob and in-memory passphrase', async () => {
    const backend = new MemoryBackend();
    const ks = new EncryptedKeystoreStore({
      backend,
      storageKey: 'nd:keystore',
      params: TEST_PARAMS,
    });
    ks.setPassphrase(PASS);
    await ks.write(MNEMONIC);
    expect(await ks.read()).toBe(MNEMONIC);

    await ks.clear();
    // passphrase 도 함께 폐기되므로 read 는 null.
    expect(await ks.read()).toBeNull();
    // 백엔드에서도 사라졌어야 한다.
    expect(await backend.read('nd:keystore')).toBeNull();
  });

  it('clearPassphrase() drops cache without touching persisted blob', async () => {
    const backend = new MemoryBackend();
    const ks = new EncryptedKeystoreStore({
      backend,
      storageKey: 'nd:keystore',
      params: TEST_PARAMS,
    });
    ks.setPassphrase(PASS);
    await ks.write(MNEMONIC);

    ks.clearPassphrase();
    expect(await ks.read()).toBeNull();

    // 같은 passphrase 재주입하면 다시 풀려야 한다.
    ks.setPassphrase(PASS);
    expect(await ks.read()).toBe(MNEMONIC);
  });

  it('cross-instance: blob written by one store can be read by another with same backend+passphrase', async () => {
    const shared = new Map<string, string>();
    const backendA = new MemoryBackend(shared);
    const backendB = new MemoryBackend(shared);

    const writer = new EncryptedKeystoreStore({
      backend: backendA,
      storageKey: 'nd:keystore',
      params: TEST_PARAMS,
    });
    writer.setPassphrase(PASS);
    await writer.write(MNEMONIC);

    const reader = new EncryptedKeystoreStore({
      backend: backendB,
      storageKey: 'nd:keystore',
      params: TEST_PARAMS,
    });
    reader.setPassphrase(PASS);
    expect(await reader.read()).toBe(MNEMONIC);
  });

  it('declares autoRestoreAllowed=false (H1 보안 정책)', () => {
    const backend = new MemoryBackend();
    const ks = new EncryptedKeystoreStore({
      backend,
      storageKey: 'nd:keystore',
      params: TEST_PARAMS,
    });
    expect(ks.autoRestoreAllowed).toBe(false);
  });
});
