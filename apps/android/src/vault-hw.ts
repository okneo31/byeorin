// vault-hw.ts — 금고를 기기 밖으로 나갈 수 없는 키로 한 겹 더 감싸는 저장소 계층.
//
// 문제: 기존 금고는 `AES-GCM(scrypt(비밀번호))` 한 겹이라, localStorage 를 통째로
// 떠가면 공격자가 자기 장비에서 비밀번호를 무제한 대입할 수 있었다. 방어선이
// scrypt 비용 하나뿐이었다.
//
// 해법: AndroidKeyStore(TEE/StrongBox) 안에서 만들어져 **한 번도 칩 밖으로 나오지
// 않는** AES 키로 blob 을 한 번 더 감싼다. 그러면 blob 만으로는 그 폰 밖에서
// 복호화를 시작조차 못 한다 — 오프라인 대입이라는 공격 경로가 사라진다.
//
// 왜 여기가 맞는 자리인가: shell-core 의 `EncryptedKeystoreStore` 는 저장소를
// `PersistentBackend` 인터페이스로 주입받는다. 그 자리에 "감싸는 백엔드" 를 끼우면
// 키스토어 로직(scrypt/AES/버전 관리)은 한 줄도 건드리지 않고 계층 하나가 는다.

import { registerPlugin } from '@capacitor/core';
import { Capacitor } from '@capacitor/core';
import type { PersistentBackend } from '@byeorin/shell-core';

interface VaultCryptoPlugin {
  isAvailable(): Promise<{ available: boolean; strongBox?: boolean; reason?: string }>;
  wrap(options: { data: string }): Promise<{ iv: string; ct: string }>;
  unwrap(options: { iv: string; ct: string }): Promise<{ data: string }>;
}

const VaultCrypto = registerPlugin<VaultCryptoPlugin>('VaultCrypto');

/** 하드웨어 래핑된 값의 봉투. `hw` 는 나중에 방식이 바뀔 때의 분기점. */
interface HwEnvelope {
  hw: 1;
  iv: string;
  ct: string;
}

function parseEnvelope(raw: string): HwEnvelope | null {
  if (!raw.startsWith('{')) return null;
  try {
    const o: unknown = JSON.parse(raw);
    if (
      typeof o === 'object' &&
      o !== null &&
      (o as HwEnvelope).hw === 1 &&
      typeof (o as HwEnvelope).iv === 'string' &&
      typeof (o as HwEnvelope).ct === 'string'
    ) {
      return o as HwEnvelope;
    }
  } catch {
    // JSON 이 아니면 봉투가 아니다 — 아래에서 레거시로 취급.
  }
  return null;
}

export interface HardwareStatus {
  /** 하드웨어 래핑이 실제로 적용되고 있는지. */
  active: boolean;
  /** 전용 보안 칩(StrongBox) 인지, 아니면 TEE 인지. */
  strongBox: boolean;
  /** active=false 인 이유 (웹 개발 환경 등). */
  reason?: string;
}

/**
 * 다른 백엔드를 감싸, 저장 전에 하드웨어 키로 봉인하고 읽을 때 푼다.
 *
 * 마이그레이션: 하드웨어 래핑 이전에 만들어진 금고는 봉투가 없는 평범한
 * EncryptedBlob JSON 이다. 읽을 때 그대로 통과시키고, 다음 write 때 자동으로
 * 봉인된다 (잠금 해제 직후 WalletStore 가 persist 하므로 사실상 즉시 승급된다).
 */
export class HardwareWrappedBackend implements PersistentBackend {
  private status: HardwareStatus | null = null;
  private lastReadWrapped: boolean | null = null;

  constructor(private readonly inner: PersistentBackend) {}

  /**
   * 마지막 read() 가 하드웨어 봉투였는지. null 이면 아직 읽은 적 없음.
   *
   * 승급 판단용이다 — 하드웨어 래핑 도입 이전 금고를 열었다면 곧바로 다시
   * 봉인해야 하는데, 셸의 저장 로직은 "내용이 그대로면 쓰지 않는다" 로 최적화돼
   * 있어 가만 두면 평생 옛 형태로 남는다.
   */
  get lastReadWasWrapped(): boolean | null {
    return this.lastReadWrapped;
  }

  /** 하드웨어 가용성 확인. 결과를 캐시한다. */
  async probe(): Promise<HardwareStatus> {
    if (this.status) return this.status;
    if (!Capacitor.isNativePlatform()) {
      // 브라우저(vite dev)에는 TEE 가 없다. 개발 편의를 위해 통과시키되
      // 상태를 숨기지 않는다 — 실기기에서는 아래 write 가 강제한다.
      this.status = { active: false, strongBox: false, reason: 'not a native platform' };
      return this.status;
    }
    try {
      const r = await VaultCrypto.isAvailable();
      this.status = {
        active: r.available,
        strongBox: r.strongBox === true,
        ...(r.reason !== undefined ? { reason: r.reason } : {}),
      };
    } catch (e) {
      this.status = {
        active: false,
        strongBox: false,
        reason: e instanceof Error ? e.message : String(e),
      };
    }
    return this.status;
  }

  async read(key: string): Promise<string | null> {
    const raw = await this.inner.read(key);
    if (raw === null) return null;
    const env = parseEnvelope(raw);
    this.lastReadWrapped = env !== null;
    // 봉투가 없으면 하드웨어 래핑 도입 이전의 금고 — 그대로 돌려준다.
    if (!env) return raw;
    const { data } = await VaultCrypto.unwrap({ iv: env.iv, ct: env.ct });
    return data;
  }

  async write(key: string, value: string): Promise<void> {
    const status = await this.probe();
    if (!status.active) {
      if (Capacitor.isNativePlatform()) {
        // 실기기에서 하드웨어를 못 쓰면 **조용히 약한 금고를 쓰지 않는다.**
        // 지갑이 보호 수준을 몰래 낮추는 것보다 눈에 띄게 실패하는 편이 낫다.
        throw new Error(
          `금고를 이 기기의 보안 하드웨어에 묶을 수 없습니다 (${status.reason ?? 'unknown'}). ` +
            '보호 수준을 낮춰 저장하지 않습니다.',
        );
      }
      // 웹 개발 환경 — 하드웨어 없이 그대로 저장.
      await this.inner.write(key, value);
      return;
    }
    const { iv, ct } = await VaultCrypto.wrap({ data: value });
    const env: HwEnvelope = { hw: 1, iv, ct };
    await this.inner.write(key, JSON.stringify(env));
  }

  async delete(key: string): Promise<void> {
    await this.inner.delete(key);
  }
}
