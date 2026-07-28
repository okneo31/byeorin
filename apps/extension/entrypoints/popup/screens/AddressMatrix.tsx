// AddressMatrix — 활성 계정의 "체인별 주소" 매트릭스.
//
// 활성 카드(ActiveAccountCard)는 *선택된 한 체인* 의 주소만 보여준다. 받을 때는
// 상대가 어느 체인으로 보내는지에 따라 주소가 달라지므로, 체인을 하나씩 바꿔가며
// 확인하는 대신 전 체인 주소를 한 화면에서 보고 바로 복사할 수 있어야 한다.
//
// 파생은 전부 로컬 sync 계산이다 — 네트워크 호출 없음. `walletStore.getAccountAt`
// 은 (idx, adapter) 로 주소를 즉시 만들어 준다.

import { useCallback, useMemo, useState } from 'react';
import type { ChainSpec } from '@byeorin/wallet-sdk/multichain';
import type { AccountInfo } from '@byeorin/shell-core';
import { useT } from '@byeorin/i18n/react';
import { walletStore } from '../../../src/lib/wallet-service.js';

/** 매트릭스 한 줄. `address === null` 이면 이 계정으로 이 체인을 쓸 수 없다. */
export interface AddressRow {
  chainKey: string;
  displayName: string;
  address: string | null;
}

/**
 * 체인 spec 목록 → 주소 행 목록.
 *
 * `resolve` 를 주입받는 이유: 어댑터 생성/주소 파생은 계정 종류에 따라 **throw**
 * 한다 (raw private key 계정 + ed25519 체인 등). 여기서 try/catch 를 한 곳에
 * 모아두면 호출부는 "미지원" 표시만 신경 쓰면 되고, 이 함수 자체는 walletStore
 * 없이도 단독 검증이 된다.
 */
export function buildAddressRows(
  chainSpecs: readonly ChainSpec[],
  resolve: (spec: ChainSpec) => string,
): AddressRow[] {
  return chainSpecs.map((spec) => {
    try {
      return { chainKey: spec.key, displayName: spec.displayName, address: resolve(spec) };
    } catch {
      // 계정 × 체인 조합이 불가능한 것뿐 — 화면 전체를 실패시키지 않는다.
      return { chainKey: spec.key, displayName: spec.displayName, address: null };
    }
  });
}

/** 주소 축약 — App.tsx 의 shortenAddress 와 동일 규칙(앞 6 · 뒤 4). */
export function shortenChainAddress(a: string): string {
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export interface AddressMatrixProps {
  /** 활성 계정. 주소 파생에는 `account.idx` 만 쓴다. */
  account: AccountInfo;
  /** multichain dynamic import 전이면 null — 로딩 문구를 보여준다. */
  chainSpecs: ChainSpec[] | null;
  /** 별도 화면으로 띄울 때의 뒤로가기. 카드 안에 끼워 넣을 땐 생략. */
  onBack?: () => void;
}

export function AddressMatrix({ account, chainSpecs, onBack }: AddressMatrixProps) {
  const t = useT();
  // 어느 행을 복사했는지 — 행마다 "복사됨" 을 따로 띄우기 위해 boolean 이 아닌 key.
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copyErr, setCopyErr] = useState(false);

  // 전 체인 주소를 한 번에 파생한다. spec.build() 는 호출마다 새 어댑터를 만들지만
  // 어댑터 생성은 RPC 를 때리지 않는 순수 객체 생성이고, 계정/체인 목록이 바뀔
  // 때만 재계산되므로 mount 당 한 번의 비용이다.
  const rows = useMemo<AddressRow[]>(() => {
    if (!chainSpecs) return [];
    return buildAddressRows(chainSpecs, (spec) =>
      walletStore.getAccountAt(account.idx, spec.build()).address,
    );
  }, [account.idx, chainSpecs]);

  const copy = useCallback(async (row: AddressRow): Promise<void> => {
    if (!row.address) return;
    setCopyErr(false);
    try {
      await navigator.clipboard.writeText(row.address);
      setCopiedKey(row.chainKey);
      // 2 초 뒤 원상복귀 — 사용자가 "복사됐다" 를 인지할 최소 시간.
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      // 권한 거부 — 주소는 화면에 그대로 있으니 직접 선택해 복사할 수 있다.
      setCopyErr(true);
    }
  }, []);

  return (
    <section className="card">
      <h2 className="create-step__title">{t('addresses.title')}</h2>
      <p className="create-step__lead">{t('addresses.lead')}</p>

      {!chainSpecs ? (
        <p className="muted small">{t('addresses.loading')}</p>
      ) : (
        <ul className="addr-matrix">
          {rows.map((row) => (
            <li key={row.chainKey} className="addr-matrix__row">
              <span className="addr-matrix__chain" title={row.displayName}>
                {row.displayName}
              </span>
              {row.address === null ? (
                <span className="addr-matrix__unsupported small">
                  {t('addresses.unsupported')}
                </span>
              ) : (
                <>
                  <span className="addr addr-matrix__addr" title={row.address}>
                    {shortenChainAddress(row.address)}
                  </span>
                  <button
                    type="button"
                    className="btn-ghost btn-sm addr-matrix__copy"
                    aria-label={t('addresses.copy_aria', { chain: row.displayName })}
                    onClick={() => {
                      void copy(row);
                    }}
                  >
                    {copiedKey === row.chainKey ? t('common.copied') : t('common.copy')}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {copyErr && (
        <p className="warn small" role="alert">
          {t('addresses.copy_failed')}
        </p>
      )}

      {onBack && (
        <button className="btn-ghost" onClick={onBack}>
          {t('common.back')}
        </button>
      )}
    </section>
  );
}
