// AddressbookPane — 주소록 화면 + 송금 자동완성 훅.
//
// 저장/정렬/중복 규칙은 전부 shell-core 의 `Addressbook` 이 갖는다. 이 파일은
// 그 위의 표시/입력 레이어일 뿐이라 비즈니스 규칙을 다시 만들지 않는다.
//
// 엔트리 두 종류의 성격이 다르므로 화면도 두 구역으로 나눈다:
//   - self     — WalletStore 계정에서 자동 sync 된 내 주소. 사용자가 손댈 게 없다.
//   - external — 사용자가 넣은 주소. 추가/삭제 대상.
//
// 쓰기(추가/삭제) 후에는 같은 popup 안의 다른 화면(SendPane 자동완성)도 즉시
// 최신값을 봐야 한다. Addressbook 인스턴스는 React 밖의 가변 객체라 state 변경이
// 전파되지 않으므로, 이 모듈이 작은 구독 채널을 하나 들고 변경을 알린다.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Addressbook, AddressbookEntry } from '@byeorin/shell-core';
import type { ChainSpec } from '@byeorin/wallet-sdk/multichain';
import { useT } from '@byeorin/i18n/react';

// ────────── 변경 구독 (모듈 로컬) ──────────

type Listener = () => void;
const listeners = new Set<Listener>();

/** 주소록에 쓰기가 일어났음을 알린다. 외부(App.tsx 의 self-sync)도 호출 가능. */
export function notifyAddressbookChanged(): void {
  for (const l of listeners) l();
}

function subscribeAddressbook(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// ────────── 송금 자동완성 ──────────

/** `<datalist>` 한 항목 — value 는 주소, 표시는 라벨. */
export interface AddressSuggestion {
  label: string;
  address: string;
}

/**
 * 해당 체인의 엔트리만 골라 자동완성 후보로 만든다.
 *
 * 같은 주소가 self 와 external 양쪽에 있으면 앞서 나온 것(= `list()` 정렬상 self)
 * 만 남긴다 — datalist 에 같은 value 가 두 번 있으면 브라우저가 중복 항목을
 * 그대로 보여줘 지저분해진다. 주소 비교는 소문자 기준(EVM 체크섬 표기 차이 흡수).
 */
export function toSuggestions(
  entries: readonly AddressbookEntry[],
  chainKey: string,
): AddressSuggestion[] {
  const seen = new Set<string>();
  const out: AddressSuggestion[] = [];
  for (const e of entries) {
    if (e.chainKey !== chainKey) continue;
    const dedupeKey = e.address.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ label: e.label, address: e.address });
  }
  return out;
}

/**
 * SendPane 이 `<datalist>` 로 붙일 후보 목록.
 *
 * book 이 null 이면(주소록 미초기화) 빈 배열 — 호출부가 분기하지 않아도 되게.
 */
export function useAddressbookSuggestions(
  book: Addressbook | null,
  chainKey: string,
): AddressSuggestion[] {
  const [entries, setEntries] = useState<AddressbookEntry[]>([]);

  useEffect(() => {
    if (!book) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    const reload = (): void => {
      void book
        .list()
        .then((all) => {
          if (!cancelled) setEntries(all);
        })
        .catch(() => {
          // 주소록은 보조 기능 — 실패해도 송금 자체는 막지 않는다.
          if (!cancelled) setEntries([]);
        });
    };
    reload();
    const unsubscribe = subscribeAddressbook(reload);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [book]);

  return useMemo(() => toSuggestions(entries, chainKey), [entries, chainKey]);
}

// ────────── 주소록 화면 ──────────

export interface AddressbookPaneProps {
  /** shell-core Addressbook 인스턴스. 생성/self-sync 는 App.tsx 책임. */
  book: Addressbook;
  /** 체인 선택지. multichain 로드 전이면 null → 추가 폼을 잠근다. */
  chainSpecs: ChainSpec[] | null;
  /** 추가 폼의 초기 선택 체인. 보통 현재 활성 체인 키. */
  defaultChainKey?: string;
  onBack?: () => void;
}

/** 추가 폼 결과 — 성공/중복갱신을 구분해 안내 문구를 다르게 낸다. */
type FormNotice = { kind: 'added' } | { kind: 'updated' } | { kind: 'error'; message: string };

export function AddressbookPane({
  book,
  chainSpecs,
  defaultChainKey,
  onBack,
}: AddressbookPaneProps) {
  const t = useT();
  const [entries, setEntries] = useState<AddressbookEntry[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [label, setLabel] = useState('');
  const [address, setAddress] = useState('');
  const [chainKey, setChainKey] = useState<string>(defaultChainKey ?? 'evm:ttl');
  const [notice, setNotice] = useState<FormNotice | null>(null);
  const [saving, setSaving] = useState(false);
  // 삭제는 오폭이 잦아 확인 단계를 1회 둔다. 확인 대기 중인 엔트리 id.
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const all = await book.list();
      setEntries(all);
      setLoadErr(null);
    } catch (e) {
      setEntries([]);
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  }, [book]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const selfEntries = useMemo(
    () => (entries ?? []).filter((e) => e.kind === 'self'),
    [entries],
  );
  const externalEntries = useMemo(
    () => (entries ?? []).filter((e) => e.kind === 'external'),
    [entries],
  );

  // 체인 키 → 표시 이름. spec 이 없으면 키를 그대로 보여준다(모르는 체인도 숨기지 않음).
  const chainName = useCallback(
    (key: string): string => chainSpecs?.find((c) => c.key === key)?.displayName ?? key,
    [chainSpecs],
  );

  async function handleAdd(): Promise<void> {
    const trimmedLabel = label.trim();
    const trimmedAddress = address.trim();
    if (!trimmedLabel) {
      setNotice({ kind: 'error', message: t('addressbook.error_label_required') });
      return;
    }
    if (!trimmedAddress) {
      setNotice({ kind: 'error', message: t('addressbook.error_address_required') });
      return;
    }
    if (!chainKey) {
      setNotice({ kind: 'error', message: t('addressbook.error_chain_required') });
      return;
    }
    // shell-core 의 addExternal 은 같은 (chainKey, address) 를 throw 하지 않고
    // 라벨만 갱신한다(idempotent). 사용자에겐 "새로 추가" 와 "덮어씀" 이 다른
    // 사건이므로, 호출 전에 기존 엔트리 유무를 보고 안내 문구를 나눈다.
    const duplicate = externalEntries.some(
      (e) =>
        e.chainKey === chainKey && e.address.toLowerCase() === trimmedAddress.toLowerCase(),
    );
    setSaving(true);
    try {
      await book.addExternal({
        label: trimmedLabel,
        address: trimmedAddress,
        chainKey,
      });
      setLabel('');
      setAddress('');
      setNotice(duplicate ? { kind: 'updated' } : { kind: 'added' });
      await reload();
      notifyAddressbookChanged();
    } catch (e) {
      setNotice({
        kind: 'error',
        message: t('addressbook.error_save_failed', {
          reason: e instanceof Error ? e.message : String(e),
        }),
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(id: string): Promise<void> {
    try {
      await book.remove(id);
      setPendingRemove(null);
      await reload();
      notifyAddressbookChanged();
    } catch (e) {
      setNotice({
        kind: 'error',
        message: t('addressbook.error_save_failed', {
          reason: e instanceof Error ? e.message : String(e),
        }),
      });
    }
  }

  return (
    <section className="card">
      <h2 className="create-step__title">{t('addressbook.title')}</h2>
      <p className="create-step__lead">{t('addressbook.lead')}</p>

      {loadErr && (
        <p className="error" role="alert">
          {t('addressbook.error_load_failed', { reason: loadErr })}
        </p>
      )}

      {entries === null ? (
        <p className="muted small">{t('addressbook.loading')}</p>
      ) : (
        <>
          {/* 내 계정 — 읽기 전용. 편집/삭제 버튼을 아예 그리지 않는다. */}
          <p className="label">{t('addressbook.self_section')}</p>
          {selfEntries.length === 0 ? (
            <p className="empty-state">{t('addressbook.self_empty')}</p>
          ) : (
            <ul className="addressbook">
              {selfEntries.map((e) => (
                <li key={e.id} className="addressbook__row">
                  <span className="addressbook__meta">
                    <span className="addressbook__label">{e.label}</span>
                    <span className="addressbook__chain small muted">
                      {chainName(e.chainKey)}
                    </span>
                  </span>
                  <span className="addr addressbook__addr" title={e.address}>
                    {e.address}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">{t('addressbook.self_readonly')}</p>

          {/* 외부 주소 — 추가/삭제 대상 */}
          <p className="label">{t('addressbook.external_section')}</p>
          {externalEntries.length === 0 ? (
            <p className="empty-state">{t('addressbook.external_empty')}</p>
          ) : (
            <ul className="addressbook">
              {externalEntries.map((e) => (
                <li key={e.id} className="addressbook__row">
                  <span className="addressbook__meta">
                    <span className="addressbook__label">{e.label}</span>
                    <span className="addressbook__chain small muted">
                      {chainName(e.chainKey)}
                    </span>
                  </span>
                  <span className="addr addressbook__addr" title={e.address}>
                    {e.address}
                  </span>
                  <span className="addressbook__actions">
                    {pendingRemove === e.id ? (
                      <>
                        <button
                          type="button"
                          className="btn-ghost btn-sm"
                          onClick={() => {
                            void handleRemove(e.id);
                          }}
                        >
                          {t('addressbook.remove_confirm_yes')}
                        </button>
                        <button
                          type="button"
                          className="btn-ghost btn-sm"
                          onClick={() => setPendingRemove(null)}
                        >
                          {t('common.cancel')}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn-ghost btn-sm"
                        onClick={() => setPendingRemove(e.id)}
                      >
                        {t('addressbook.remove_button')}
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {/* 외부 주소 추가 폼 */}
      <p className="label">{t('addressbook.add_title')}</p>
      <div className="addressbook-form">
        <label className="label" htmlFor="ab-label">
          {t('addressbook.label_field')}
        </label>
        <input
          id="ab-label"
          type="text"
          className="verify-row__input"
          value={label}
          onChange={(ev) => setLabel(ev.target.value)}
          placeholder={t('addressbook.label_placeholder')}
          disabled={saving}
        />

        <label className="label" htmlFor="ab-address">
          {t('addressbook.address_field')}
        </label>
        <textarea
          id="ab-address"
          rows={2}
          value={address}
          onChange={(ev) => setAddress(ev.target.value)}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          disabled={saving}
        />

        <label className="label" htmlFor="ab-chain">
          {t('addressbook.chain_field')}
        </label>
        <select
          id="ab-chain"
          className="chain-select"
          value={chainKey}
          onChange={(ev) => setChainKey(ev.target.value)}
          disabled={saving || !chainSpecs}
        >
          {chainSpecs ? (
            chainSpecs.map((c) => (
              <option key={c.key} value={c.key}>
                {c.displayName}
              </option>
            ))
          ) : (
            <option value="evm:ttl">TTL</option>
          )}
        </select>

        <button
          className="btn-primary"
          disabled={saving || !label.trim() || !address.trim()}
          onClick={() => {
            void handleAdd();
          }}
        >
          {t('addressbook.add_button')}
        </button>
      </div>

      {notice?.kind === 'error' && (
        <p className="error" role="alert">
          {notice.message}
        </p>
      )}
      {notice?.kind === 'added' && <p className="muted small">{t('addressbook.added')}</p>}
      {notice?.kind === 'updated' && (
        <p className="warn small">{t('addressbook.duplicate_updated')}</p>
      )}

      {onBack && (
        <button className="btn-ghost" onClick={onBack}>
          {t('common.back')}
        </button>
      )}
    </section>
  );
}
