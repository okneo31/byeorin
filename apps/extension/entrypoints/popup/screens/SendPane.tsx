// SendPane.tsx — 송금 화면.
//
// App.tsx 안에 있던 SendPane 을 그대로 옮겨온 뒤 **토큰 분기** 를 더했다.
// native 경로는 손대지 않았다 — 자산 셀렉터를 건드리지 않으면 예전과 완전히
// 동일하게 동작한다.
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

import { useEffect, useMemo, useState } from 'react';
import type { ChainAdapter, TransferIntent } from '@byeorin/wallet-sdk/core';
// 메모 판정은 SDK 한 곳에만 있다. 규칙(2~2048바이트·엄격 UTF-8·제어문자)은 서버
// 인덱서(wallet-api/memo.js)와 한 글자도 어긋나면 안 되므로 셸에서 다시 짜지 않는다.
import { validateMemo, MEMO_MAX_BYTES, type MemoCheck } from '@byeorin/wallet-sdk/core';
import { ShellError, type Addressbook, type ScanResult } from '@byeorin/shell-core';
import { useT } from '@byeorin/i18n/react';
import { walletStore } from '../../../src/lib/wallet-service.js';
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
import { probeRecipientKind } from '../lib/memo-recipient.js';
import { QrScanField } from './QrScanField.js';

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
  // TTL(evm:ttl)은 메모 필드가 없는 대신, 체인이 원래 가진 tx.data 에 UTF-8
  // 바이트를 싣고 **TTL 인덱서가 그것을 메모로 판정한다**(벼린-메모연동.md 1·2절).
  // 발명이 아니라 이미 배포된 체인 기능을 노출하는 것이다.
  // 그 외 체인에서는 입력칸 자체를 그리지 않는다.
  const [memo, setMemo] = useState('');
  const trimmedMemo = memo.trim();
  // 받는 주소의 정체. TTL 메모 경로에서만 조회한다 (아래 useEffect).
  //   null = 아직 모름/조회 안 함, 'checking' = 조회 중, 'error' = 확인 실패
  type RecipientState = null | 'checking' | 'eoa' | 'contract' | 'error';
  const [recipient, setRecipient] = useState<RecipientState>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  // "최대" 로 채웠고 아직 사용자가 수정하지 않았다는 표시 — native 는 가스를
  // 뺀 값이라 왜 잔액보다 작은지 화면이 설명해야 한다.
  const [maxNote, setMaxNote] = useState(false);
  // 스캔이 주소 말고 무엇을 더 채웠는지 사용자에게 밝히는 줄. 돈 보내는 자리라
  // "어디서 온 값인가" 를 화면이 말하지 않으면 안 된다.
  const [scanNote, setScanNote] = useState<string | null>(null);

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

  // ── 메모 게이트 ────────────────────────────────────────────────────────
  //
  // TTL 만 연다. 다른 EVM 체인은 열지 않는다 — 메모를 판정해 되읽어 주는 인덱서가
  // TTL 에만 배포돼 있어(벼린-메모연동.md 5절), 다른 체인에서는 사용자가 수수료를
  // 더 내고 data 를 실어도 화면 어디에도 다시 뜨지 않는다. "보냈는데 안 보인다" 를
  // 만들지 않기 위해 TTL 만 연다.
  //
  // 토큰은 제외한다. ERC-20 전송은 tx.data 가 이미 transfer calldata 로 차 있고,
  // tx.data 는 한 칸뿐이다. 메모를 같이 넘기면 SDK 가 던진다(evm.ts:226).
  const isTtlMemo = isTtl && asset.kind === 'native';
  const memoCapable = chainKey.startsWith('cosmos:') || chainKey === 'ton' || isTtlMemo;

  // 입력 중 실시간 판정. 빈 문자열은 오류가 아니다 — 메모 없는 송금이다.
  const memoCheck: MemoCheck | null =
    isTtlMemo && trimmedMemo.length > 0 ? validateMemo(trimmedMemo) : null;
  const memoRuleError =
    memoCheck !== null && !memoCheck.ok && memoCheck.reason !== undefined
      ? t(`send.memo_reason.${memoCheck.reason}`, {
          n: memoCheck.byteLength,
          min: 2,
          max: MEMO_MAX_BYTES,
        })
      : null;

  // 받는 주소가 컨트랙트면 메모 바이트가 함수 호출로 해석된다(명세서 7절).
  // 어댑터가 서명 직전에 다시 막지만, 화면이 먼저 알려 준다.
  const memoRecipientError =
    isTtlMemo && trimmedMemo.length > 0
      ? recipient === 'contract'
        ? t('send.memo_contract_recipient')
        : recipient === 'error'
          ? t('send.memo_recipient_check_failed')
          : null
      : null;
  // 조회가 끝나기 전에는 다음 단계로 보내지 않는다 — 모르는 채로 메모를 실어
  // 보내면 되돌릴 수 없다.
  const memoRecipientPending =
    isTtlMemo && trimmedMemo.length > 0 && (recipient === null || recipient === 'checking');
  const memoBlocked =
    memoRuleError !== null || memoRecipientError !== null || memoRecipientPending;

  const canProceed = validAddress && validAmount && !locked && !memoBlocked;

  // "최대" 로 채운 뒤에 메모를 적으면 남겨둔 가스 몫이 모자라진다 — 그 상태로
  // 두면 그 송금은 반드시 실패한다(메모 없이 남긴 21,000×1.2 몫 0.00126 TTL 로는
  // 2048 B 메모의 103,911 가스 = 0.0051956 TTL 을 못 낸다). 메모 길이가 변하면
  // 최대치를 다시 계산한다. "최대" 를 누른 상태(maxNote)에서만 돈다.
  useEffect(() => {
    if (!maxNote || !isTtlMemo) return;
    const timer = setTimeout(() => {
      void fillMax();
    }, 400);
    return () => clearTimeout(timer);
    // fillMax 는 매 렌더 새로 만들어지므로 의존성에 넣지 않는다 — 넣으면 매
    // 렌더마다 타이머가 다시 걸린다. 값이 바뀌는 축은 아래 셋뿐이다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxNote, isTtlMemo, memoCheck?.byteLength]);

  /**
   * 받는 주소 정체 조회 — **디바운스 400ms**. 타자마다 eth_getCode 를 부르면
   * 한 글자에 RPC 왕복 하나가 생긴다. 주소가 유효 형식일 때, 그리고 메모를
   * 실제로 쓰고 있을 때만 부른다 (메모 없는 송금은 왕복 0회).
   */
  useEffect(() => {
    if (!isTtlMemo || trimmedMemo.length === 0 || !validAddress) {
      setRecipient(null);
      return;
    }
    let cancelled = false;
    setRecipient('checking');
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const kind = await probeRecipientKind(adapter, trimmedTo);
          if (!cancelled) setRecipient(kind);
        } catch {
          // 모르는 것을 EOA 로 추정하지 않는다. 화면이 "확인하지 못했다" 고 말한다.
          if (!cancelled) setRecipient('error');
        }
      })();
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // trimmedMemo 는 길이 0 여부만 쓰므로 의존성에서 길이만 본다 — 메모 한 글자
    // 칠 때마다 조회를 다시 걸지 않기 위해서다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTtlMemo, trimmedMemo.length === 0, validAddress, trimmedTo, adapter]);

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
      // 메모가 붙으면 가스가 21,000 을 훌쩍 넘는다. 기본값(21,000)으로 최대를
      // 계산하면 남는 몫이 수수료보다 적어 전송 자체가 실패한다.
      //
      // 계수 44 의 근거(실측, rpc.ttl1.top / EOA 수신자):
      //   1 B → 21,205 / 256 B → 31,593 / 1024 B → 62,789 / 2048 B → 103,911
      //   = 노드가 EIP-7623(비영 40/B) 로 매긴다. 2048×40+21,000 = 102,920 이라
      //   실측 103,911 에 못 미치므로 40 이 아니라 **44** 로 올려 잡는다
      //   (2048×44+21,000 = 111,112 > 103,911). 넉넉히 잡으면 최대 금액이 조금
      //   줄 뿐이지만, 모자라게 잡으면 전송이 OOG 로 죽는다.
      //   명세서 4절의 EIP-2028 식(바이트당 16)은 이 노드에서 틀렸다.
      const memoGas =
        isTtlMemo && trimmedMemo.length > 0
          ? 21_000n + BigInt(validateMemo(trimmedMemo).byteLength) * 44n
          : undefined;
      const fee = await feeEstimator.estimateNativeSendFee(memoGas);
      const max = asset.balance > fee ? asset.balance - fee : 0n;
      setAmount(assetAmountToInputString(max, asset.decimals));
      setMaxNote(true);
    } catch {
      // 수수료를 모르면 조용히 둔다 — 사용자는 손으로 입력할 수 있다.
    }
  }

  /**
   * 검증을 통과한 스캔 결과를 입력란에 옮긴다.
   *
   * 주소는 shell-core 가 이미 이 체인의 형식으로 확인한 값이므로 그대로 넣는다.
   * 금액은 **native 자산이 선택돼 있을 때만** 옮긴다 — BIP21 의 BTC 수량을 토큰
   * 칸에 넣으면 단위가 다른 숫자가 된다. EIP-681 의 토큰 수량(uint256)은 decimals
   * 를 QR 이 담지 않으므로 아예 채우지 않고 사용자가 직접 적게 둔다.
   */
  function applyScan(r: ScanResult): void {
    setTo(r.address);
    setMaxNote(false);
    const notes: string[] = [];

    if (r.tokenAddress !== undefined) {
      const wanted = r.tokenAddress;
      const hit = tokenOptions.find((tok) => tok.id.toLowerCase() === wanted.toLowerCase());
      if (hit) {
        setAssetKey(hit.id);
        notes.push(`${t('send.asset_label')}: ${hit.symbol}`);
      } else {
        // 목록에 없는 토큰이면 자산을 바꾸지 않는다 — 정체 모르는 자산으로
        // 보내는 상태를 만들지 않기 위해 컨트랙트 주소만 보여 준다.
        notes.push(`${t('scan.result_raw')}: ${wanted}`);
      }
      if (r.tokenAmountRaw !== undefined)
        notes.push(t('scan.token_raw_amount', { v: r.tokenAmountRaw }));
    } else if (r.amount !== undefined) {
      if (assetKey === 'native') {
        setAmount(r.amount);
        notes.push(t('scan.amount_filled', { amount: r.amount, symbol: asset.symbol }));
      } else {
        notes.push(t('scan.amount_ignored'));
      }
    }

    if (r.label !== undefined && r.label.length > 0) notes.push(r.label);
    if (r.message !== undefined && r.message.length > 0) notes.push(r.message);
    for (const w of r.warnings) notes.push(w);
    notes.push(t('scan.address_unchecked'));
    setScanNote(notes.length > 0 ? notes.join(' · ') : null);
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
    // 메모는 **원문 문자열**로 넘긴다. hex 변환(encodeMemo)은 어댑터의 일이다 —
    // cosmos(tx memo)·ton(코멘트 셀)·TTL(tx.data) 이 같은 한 줄을 쓴다.
    // 비어 있으면 필드를 아예 넣지 않는다: 빈 '0x' data 를 붙이면 안 된다(7절).
    if (memoCapable && trimmedMemo.length > 0) intent.memo = trimmedMemo;
    setStatus({ kind: 'pending' });
    try {
      // 활성 체인 어댑터로 송금 — defaultAdapter(TTL) 아님.
      const hash = await walletStore.transfer(intent, adapter);
      setStatus({ kind: 'sent', hash });
      // 보낸 메모는 지운다. 남겨 두면 다음 송금에 앞 거래의 메모가 그대로
      // 실려 나간다 — 사용자는 칸이 비어 있다고 믿기 쉽다.
      setMemo('');
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
            <span className="muted small">{t('send.review_memo_label')}</span>
            {/* 사용자가 방금 친 문자열이지만 렌더 규칙은 활동 화면과 같게 둔다 —
                React 텍스트 노드. dangerouslySetInnerHTML 을 쓰지 않는다. */}
            <span className="small send-review__memo">{trimmedMemo}</span>
          </div>
        )}
        <div className="send-review__row">
          <span className="muted small">{t('send.review_gas_label')}</span>
          <span className="small">{t('send.review_gas_unknown')}</span>
        </div>
        {/* 메모가 붙으면 가스가 바이트 수만큼 늘어난다(실측 2048B → 103,911).
            확인 화면에서 한 번 더 말해 준다 — 되돌릴 수 없는 단계라서. */}
        {isTtlMemo && trimmedMemo.length > 0 && (
          <p className="muted small" style={{ margin: 0 }}>
            {t('send.memo_gas_note')}
          </p>
        )}
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
       * 주소는 한 줄이라 rows=2 를 잃는 손해는 없다. */}
      <input
        id="send-to"
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
      <QrScanField chainKey={chainKey} onScan={applyScan} disabled={locked} />
      {scanNote !== null && <p className="muted small">{scanNote}</p>}

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
          {/* TTL 은 2048 **바이트**(한글 682자)까지 실린다 — 글자 수가 아니다
              (한글 3바이트/자). 그래서 TTL 경로만 textarea + 바이트 카운터로
              바꾸고 maxLength(글자 수 제한)를 걸지 않는다.
              (styles.css:335 의 bare textarea 규칙이 그대로 적용된다.)
              cosmos/ton 은 예전 그대로 한 줄 input · 256 글자 제한을 유지한다 —
              TTL 과 무관한 경로라 이번 작업에서 바꿀 이유가 없다. */}
          {isTtlMemo ? (
            <textarea
              id="send-memo"
              className="send-memo__input"
              rows={2}
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder={t('send.memo_placeholder')}
              spellCheck={false}
              disabled={locked}
            />
          ) : (
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
          )}
          {isTtlMemo && (
            <>
              <p className="muted small send-memo__count">
                {t('send.memo_bytes', {
                  n: memoCheck?.byteLength ?? 0,
                  max: MEMO_MAX_BYTES,
                })}
              </p>
              {/* 규칙 위반 사유는 SDK 의 reason 코드를 그대로 i18n 키로 쓴다. */}
              {memoRuleError !== null && <p className="error small">{memoRuleError}</p>}
              {memoRecipientPending && (
                <p className="muted small">{t('send.memo_checking_recipient')}</p>
              )}
              {memoRecipientError !== null && (
                <p className="error small">{memoRecipientError}</p>
              )}
              {trimmedMemo.length > 0 && memoRuleError === null && (
                <p className="muted small">{t('send.memo_public_note')}</p>
              )}
            </>
          )}
        </>
      )}
      {/* 토큰을 고르면 메모칸 자체가 사라진다. 왜 사라졌는지 말해 준다 —
          ERC-20 전송은 tx.data 가 이미 차 있어 메모를 넣을 자리가 없다. */}
      {isTtl && !isTtlMemo && (
        <p className="muted small">{t('send.memo_token_unsupported')}</p>
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
