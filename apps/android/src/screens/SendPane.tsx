// SendPane.tsx — 송금 화면 (안드로이드 셸).
//
// App.tsx 안에 있던 SendPane 을 그대로 옮겨온 뒤 **토큰 분기** 를 더했다.
// native 경로는 손대지 않았다 — 자산 셀렉터를 건드리지 않으면 예전과 완전히
// 동일하게 동작한다.
//
// 확장판(apps/extension/entrypoints/popup/screens/SendPane.tsx)의 이식본이다.
// 안드로이드 셸에는 HW(WebHID) 가 없지만 이 화면은 애초에 HW 를 참조하지
// 않았으므로 제거할 것이 없었다. 다른 점은 wallet-service 의 import 경로뿐이다
// (안드로이드는 비밀번호로 봉인된 금고 세션을 쓰는 walletStore).
//
// 단계: 'compose' (자산/주소/금액 입력) → 'review' (요약 + 확정) → 'sent' / 'error'.
//
// **자산 선택은 체인과 무관하다.** 예전에는 `chainKey.startsWith('evm:')` 로
// 셀렉터를 가렸지만 이제 판단 기준은 하나뿐이다: 상위가 넘긴 토큰 목록이 비어
// 있지 않은가. 토큰이 있으면 그리고, 없으면 안 그린다 — 어느 체인이든 같다.
//
// 토큰 목록은 **직접 조회하지 않는다.** 상위가 이미 `discoverPortableTokens` 로
// 가져온 값을 props 로 받는다 — 같은 화면에서 같은 RPC 를 두 번 때리지 않기
// 위해서다.

import { useMemo, useState } from 'react';
import type { ChainAdapter, TransferIntent } from '@byeorin/wallet-sdk/core';
import { ShellError, type Addressbook } from '@byeorin/shell-core';
import { useT } from '@byeorin/i18n/react';
import { walletStore } from '../wallet-service.js';
import { useAddressbookSuggestions } from './AddressbookPane.js';
import {
  buildTransferIntent,
  assetAmountToInputString,
  formatAssetAmount,
  parseAssetAmount,
  type AssetKey,
  type SelectedAsset,
} from '../lib/token-send.js';
import type { PortableTokenBalance } from '../lib/token-visibility.js';

export interface SendPaneProps {
  onBack: () => void;
  adapter: ChainAdapter;
  nativeSymbol: string;
  nativeDecimals: number;
  chainKey: string;
  /**
   * 상위가 발견한 토큰 잔액 (`discoverPortableTokens` 결과 그대로, 체인 무관).
   * 아직 조회 전이거나 이 체인이 토큰을 모르면 null/빈 배열 — 그 경우 native
   * 전용 화면이 된다 (기존 동작).
   */
  tokens?: readonly PortableTokenBalance[] | null;
  /** native 잔액(base-unit). 알 수 없으면 null — 잔액 초과 검사를 건너뛴다. */
  nativeBalance?: bigint | null;
  /**
   * 주소록 — 받는 주소 입력의 자동완성(datalist) 후보로만 쓴다. null 이면
   * 자동완성 없이 순수 입력 (기존 동작).
   */
  book?: Addressbook | null;
}

export function SendPane({
  onBack,
  adapter,
  nativeSymbol,
  nativeDecimals,
  chainKey,
  tokens = null,
  nativeBalance = null,
  book = null,
}: SendPaneProps) {
  const t = useT();
  type Step = 'compose' | 'review';
  type Status =
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'sent'; hash: string }
    | { kind: 'error'; message: string };

  const [step, setStep] = useState<Step>('compose');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [assetKey, setAssetKey] = useState<AssetKey>('native');
  // 메모 — **체인이 프로토콜에 원래 가진 기능만 노출한다** (CLAUDE.md 경계 원칙).
  // Cosmos 계열(ZION)은 tx memo 필드, TON 은 코멘트 셀이 네이티브다.
  // EVM 등 메모 개념이 없는 체인에서는 입력칸 자체를 그리지 않는다 —
  // 지갑이 관행·트릭으로 체인에 없는 기능을 발명하지 않는다.
  const [memo, setMemo] = useState('');
  const memoCapable = chainKey.startsWith('cosmos:') || chainKey === 'ton';
  const trimmedMemo = memo.trim();
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  // "최대" 로 채웠고 아직 사용자가 수정하지 않았다는 표시 — native 는 가스를
  // 뺀 값이라 왜 잔액보다 작은지 화면이 설명해야 한다.
  const [maxNote, setMaxNote] = useState(false);

  // 주소록 자동완성 후보 — 활성 체인 엔트리만. book 이 null 이면 빈 배열.
  const suggestions = useAddressbookSuggestions(book, chainKey);

  // TTL(evm:ttl) 만 익스플로러 링크를 노출한다 — scan.ttl1.top 은 TTL 전용.
  const isTtl = chainKey === 'evm:ttl';
  const isEvm = chainKey.startsWith('evm:');
  const trimmedTo = to.trim();
  const trimmedAmount = amount.trim();

  // 토큰 셀렉터의 유일한 조건: 받은 목록이 비어 있지 않은가. 체인은 묻지 않는다.
  const tokenOptions: readonly PortableTokenBalance[] = tokens ?? [];
  const showAssetPicker = tokenOptions.length > 0;

  // 선택 자산 — 심볼/decimals/잔액이 여기서 하나로 확정된다. native 18 과 토큰
  // decimals 를 섞지 않기 위해 아래 파싱·표시는 전부 이 값만 본다.
  const asset = useMemo(
    () =>
      selectAsset(
        showAssetPicker ? assetKey : 'native',
        nativeSymbol,
        nativeDecimals,
        nativeBalance ?? null,
        tokenOptions,
      ),
    [assetKey, showAssetPicker, nativeSymbol, nativeDecimals, nativeBalance, tokenOptions],
  );

  // EVM 은 0x+40hex 엄격 검증. 비-EVM(cosmos bech32, solana base58 등)은 형식이
  // 체인마다 달라 popup 에서 일괄 검증하지 않고 non-empty 만 본다 — 잘못된 주소는
  // 어댑터의 broadcast 단계에서 실패한다.
  const validAddress = isEvm
    ? /^0x[0-9a-fA-F]{40}$/.test(trimmedTo)
    : trimmedTo.length > 0;

  const parsed = useMemo(() => parseAssetAmount(trimmedAmount, asset), [trimmedAmount, asset]);
  const validAmount = parsed.ok;
  // 입력이 비어 있을 때는 에러를 띄우지 않는다 (기존 동작).
  const amountError =
    trimmedAmount.length > 0 && !parsed.ok ? amountErrorText(parsed.reason) : null;
  const locked = status.kind === 'pending' || status.kind === 'sent';
  const canProceed = validAddress && validAmount && !locked;

  // native 전송 수수료를 추정할 수 있는 어댑터의 구조적 표면 (EVM 계열).
  type NativeFeeEstimator = { estimateNativeSendFee(gasUnits?: bigint): Promise<bigint> };
  const feeEstimator =
    typeof (adapter as Partial<NativeFeeEstimator>).estimateNativeSendFee === 'function'
      ? (adapter as unknown as NativeFeeEstimator)
      : null;
  // 토큰은 전액이 항상 가능하고(가스는 native 로 낸다), native 는 수수료를
  // 추정할 수 있을 때만 최대 버튼을 그린다 — 전액을 채워 실패를 만들지 않는다.
  const canMax = asset.balance !== null && (asset.kind !== 'native' || feeEstimator !== null);

  /**
   * "최대" — 토큰은 전액, native 는 잔액 − 예상 가스.
   *
   * 잔액 전부를 수량에 넣으면 가스 낼 몫이 없어 전송이 반드시 실패한다
   * (실기기 보고: 100 TTL 보유에서 100 입력 → 전송 불가). 수수료 추정이
   * 실패하면 채우지 않는다 — 틀린 값을 넣느니 아무것도 안 한다.
   */
  async function fillMax(): Promise<void> {
    if (asset.balance === null || locked) return;
    if (asset.kind !== 'native') {
      setAmount(assetAmountToInputString(asset.balance, asset.decimals));
      setMaxNote(false);
      return;
    }
    if (feeEstimator === null) return;
    try {
      const fee = await feeEstimator.estimateNativeSendFee();
      const max = asset.balance > fee ? asset.balance - fee : 0n;
      setAmount(assetAmountToInputString(max, asset.decimals));
      setMaxNote(true);
    } catch {
      // 수수료를 모르면 조용히 둔다 — 사용자는 손으로 입력할 수 있다.
    }
  }

  function amountErrorText(reason: 'format' | 'decimals' | 'insufficient'): string {
    if (reason === 'insufficient') {
      return t('send.amount_exceeds_balance', {
        balance: formatAssetAmount(asset.balance, asset.decimals),
        symbol: asset.symbol,
      });
    }
    if (reason === 'decimals') {
      return t('send.amount_decimals_exceeded', {
        symbol: asset.symbol,
        decimals: asset.decimals,
      });
    }
    return t('send.amount_invalid');
  }

  async function performSend(): Promise<void> {
    // 선택 자산의 decimals 로 파싱 — EVM native 18, Cosmos 6, ERC-20 은 토큰별.
    const result = parseAssetAmount(trimmedAmount, asset);
    if (!result.ok) {
      setStatus({ kind: 'error', message: amountErrorText(result.reason) });
      return;
    }
    // native 면 예전과 같은 { to, amount }. 토큰이면 체인에 맞는 형식.
    const intent = buildAssetIntent(asset, trimmedTo, result.value, adapter, isEvm);
    if (memoCapable && trimmedMemo.length > 0) intent.memo = trimmedMemo;
    setStatus({ kind: 'pending' });
    try {
      // 활성 체인 어댑터로 송금 — defaultAdapter(TTL) 아님.
      const hash = await walletStore.transfer(intent, adapter);
      setStatus({ kind: 'sent', hash });
    } catch (err) {
      let msg: string;
      if (err instanceof ShellError) msg = t(`errors.${err.code}`);
      else if (err instanceof Error) msg = err.message || t('send.failed');
      else msg = t('send.failed');
      setStatus({ kind: 'error', message: msg });
    }
  }

  if (step === 'review') {
    const shortTo =
      trimmedTo.length > 14 ? `${trimmedTo.slice(0, 6)}…${trimmedTo.slice(-4)}` : trimmedTo;

    return (
      <section className="card">
        <h2 className="create-step__title">{t('send.review_title')}</h2>
        <p className="create-step__lead">
          {t('send.review_summary', {
            amount: trimmedAmount,
            // 심볼은 선택 자산 기준 — 토큰 송금인데 native 심볼이 뜨면 안 된다.
            symbol: asset.symbol,
            address: shortTo,
          })}
        </p>
        {asset.kind === 'erc20' && asset.address !== null && (
          <div className="send-review__row">
            <span className="muted small">{t('send.review_contract_label')}</span>
            <span className="small addr" title={asset.address}>
              {shorten(asset.address)}
            </span>
          </div>
        )}
        {memoCapable && trimmedMemo.length > 0 && (
          <div className="send-review__row">
            <span className="muted small">{t('send.memo_label')}</span>
            <span className="small">{trimmedMemo}</span>
          </div>
        )}
        <div className="send-review__row">
          <span className="muted small">{t('send.review_gas_label')}</span>
          <span className="small">{t('send.review_gas_unknown')}</span>
        </div>
        <p className="warn small" style={{ margin: 0 }}>
          {t('send.review_irreversible')}
        </p>

        {status.kind === 'pending' && (
          <p className="muted small">{t('send.pending')}</p>
        )}
        {status.kind === 'sent' && (
          <div className="send-sent">
            <p className="label">{t('send.sent_title')}</p>
            <p className="addr send-hash" title={status.hash}>
              {shorten(status.hash)}
            </p>
            {isTtl && (
              <a
                href={`https://scan.ttl1.top/tx/${status.hash}`}
                target="_blank"
                rel="noreferrer"
                className="small"
              >
                {t('send.view_in_explorer')}
              </a>
            )}
          </div>
        )}
        {status.kind === 'error' && <p className="error">{status.message}</p>}

        {status.kind === 'sent' ? (
          <button className="btn-primary" onClick={onBack}>
            {t('send.back_to_wallet')}
          </button>
        ) : (
          <button
            className="btn-primary"
            disabled={!canProceed}
            onClick={() => {
              void performSend();
            }}
          >
            {status.kind === 'pending' ? t('send.sending') : t('send.review_confirm')}
          </button>
        )}
        <button
          className="btn-ghost"
          onClick={() => setStep('compose')}
          disabled={status.kind === 'pending' || status.kind === 'sent'}
        >
          {t('send.review_edit')}
        </button>
      </section>
    );
  }

  // step === 'compose'
  return (
    <section className="card">
      <h2 className="create-step__title">{t('send.title')}</h2>
      <p className="create-step__lead">
        {asset.kind === 'erc20'
          ? t('send.lead_token', { symbol: asset.symbol })
          : t('send.lead_native', { symbol: asset.symbol })}
      </p>

      {/* 자산 선택 — 발견된 토큰이 있으면 그린다. 체인은 조건이 아니다. */}
      {showAssetPicker && (
        <>
          <label className="label" htmlFor="send-asset">
            {t('send.asset_label')}
          </label>
          {/* 체인 셀렉터와 같은 스타일 — 새 CSS 없이 기존 .chain-select 재사용. */}
          <select
            id="send-asset"
            className="chain-select send-asset__select"
            value={assetKey}
            onChange={(e) => setAssetKey(e.target.value)}
            disabled={locked}
          >
            <option value="native">
              {t('send.asset_native_option_symbol', { symbol: nativeSymbol })}
            </option>
            {tokenOptions.map((tok) => (
              <option key={tok.id} value={tok.id}>
                {tok.symbol} · {formatAssetAmount(tok.balance, tok.decimals)}
              </option>
            ))}
          </select>
        </>
      )}

      {asset.balance !== null && (
        <p className="muted small send-asset__balance">
          {t('send.available_balance', {
            amount: formatAssetAmount(asset.balance, asset.decimals),
            symbol: asset.symbol,
          })}
        </p>
      )}

      <label className="label" htmlFor="send-to">
        {t('send.to_label')}
      </label>
      {/* textarea 가 아니라 input 인 이유: HTML 의 `list` 속성(datalist 연결)은
       * input 에만 있다. textarea 로 두면 주소록 자동완성이 아예 동작하지 않는다.
       * 주소는 한 줄이라 rows=2 를 잃는 손해는 없다.
       *
       * className="input" 은 안드로이드 전용 추가분이다. styles.css 는 bare
       * `textarea` 만 스타일링하고 bare `input` 규칙이 없어서, 확장판처럼 클래스
       * 없이 두면 이 칸만 OS 기본 입력으로 렌더된다. 게다가 안드로이드는
       * font-size 16px 미만 입력에 포커스하면 화면을 확대한다 — `.input` 이 그
       * 두 가지를 모두 해결하는 모바일 오버라이드 클래스다. */}
      <input
        id="send-to"
        className="input"
        type="text"
        list={suggestions.length > 0 ? 'send-to-book' : undefined}
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder={isEvm ? '0x...' : ''}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        disabled={locked}
      />
      {suggestions.length > 0 && (
        <datalist id="send-to-book">
          {suggestions.map((s) => (
            <option key={s.address} value={s.address} label={s.label} />
          ))}
        </datalist>
      )}
      {trimmedTo.length > 0 && !validAddress && (
        <p className="error small">{t('send.to_invalid')}</p>
      )}

      <label className="label" htmlFor="send-amount">
        {t('send.amount_label', { symbol: asset.symbol })}
      </label>
      <input
        id="send-amount"
        type="text"
        inputMode="decimal"
        className="verify-row__input"
        value={amount}
        onChange={(e) => {
          setAmount(e.target.value);
          setMaxNote(false);
        }}
        placeholder="0.0"
        disabled={locked}
      />
      {canMax && (
        <button
          type="button"
          className="btn-ghost"
          onClick={() => {
            void fillMax();
          }}
          disabled={locked}
        >
          {t('send.max_button')}
        </button>
      )}
      {maxNote && <p className="muted small">{t('send.max_native_note')}</p>}

      {memoCapable && (
        <>
          <label className="label" htmlFor="send-memo">
            {t('send.memo_label')}
          </label>
          <input
            id="send-memo"
            type="text"
            className="verify-row__input"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder={t('send.memo_placeholder')}
            maxLength={256}
            disabled={locked}
          />
        </>
      )}
      {amountError !== null && <p className="error small">{amountError}</p>}

      <button
        className="btn-primary"
        disabled={!canProceed}
        onClick={() => setStep('review')}
      >
        {t('send.next_step')}
      </button>
      <button className="btn-ghost" onClick={onBack}>
        {t('common.back')}
      </button>
    </section>
  );
}

/**
 * 자산 키 → SelectedAsset. token-send.ts 의 `resolveAsset` 과 같은 규칙이되
 * 입력이 EVM 전용 `DiscoveredBalance` 가 아니라 체인 무관 `PortableTokenBalance` 다.
 *
 * 목록에 없는 키(토큰 목록이 갱신되며 사라진 경우 등)는 native 로 되돌린다 —
 * "정체를 모르는 자산으로 송금" 이라는 상태를 만들지 않기 위해서다.
 *
 * `kind: 'erc20'` 은 token-send.ts 가 쓰는 기존 이름일 뿐이고 여기서는 "native 가
 * 아님(= 토큰)" 이라는 뜻이다. Solana SPL 도 Cosmos denom 도 이 값을 갖는다.
 * `address` 에는 `PortableTokenBalance.id` 가 그대로 들어간다.
 */
function selectAsset(
  key: AssetKey,
  nativeSymbol: string,
  nativeDecimals: number,
  nativeBalance: bigint | null,
  tokens: readonly PortableTokenBalance[],
): SelectedAsset {
  if (key !== 'native') {
    const hit = tokens.find((tok) => tok.id.toLowerCase() === key.toLowerCase());
    if (hit) {
      return {
        kind: 'erc20',
        symbol: hit.symbol,
        decimals: hit.decimals,
        address: hit.id,
        balance: hit.balance,
      };
    }
  }
  return {
    kind: 'native',
    symbol: nativeSymbol,
    decimals: nativeDecimals,
    address: null,
    balance: nativeBalance,
  };
}

/**
 * 선택 자산 → TransferIntent.
 *
 * native 는 예전 그대로 `{ to, amount }` — 이 경로는 한 글자도 바뀌지 않았다.
 *
 * 토큰의 원칙 형식은 체인 무관 하나다: `{ to: 받는 주소, amount, asset: 토큰 id }`.
 * 어댑터의 `buildTransfer` 가 `asset` 을 보고 자기 체인의 토큰 전송을 만든다.
 *
 * **EVM 만 예외로 남긴다.** 현재 `EvmAdapter.buildTransfer` 는 `intent.asset` 을
 * 읽지 않고 `intent.data`(calldata) 만 본다. EVM 에서 원칙 형식을 넣으면 ERC-20 이
 * 아니라 native 코인이 그대로 나간다 — 자산을 잃는 회귀다. 그래서 EVM 토큰은
 * 기존 `buildTransferIntent`(Erc20.transfer calldata) 경로를 그대로 쓴다.
 * EvmAdapter 가 `asset` 을 읽게 되면 이 분기(아래 `if (isEvm)`) 를 지우면 된다.
 */
function buildAssetIntent(
  asset: SelectedAsset,
  to: string,
  value: bigint,
  adapter: ChainAdapter,
  isEvm: boolean,
): TransferIntent {
  if (asset.kind === 'native' || asset.address === null) {
    return buildTransferIntent(asset, to, value, adapter);
  }
  if (isEvm) return buildTransferIntent(asset, to, value, adapter);
  return { to, amount: value, asset: asset.address };
}

/** App.tsx 의 shortenAddress 와 같은 규칙. App.tsx 를 건드리지 않으려 복제했다. */
function shorten(a: string): string {
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
