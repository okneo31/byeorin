import { useEffect, useMemo, useState } from 'react';
import { parseUnits } from 'viem';
import {
  Erc20,
  MEMO_MAX_BYTES,
  MEMO_MIN_BYTES,
  TokenRegistry,
  TTL_CHAIN,
  discoverTokens,
  memoByteLength,
  validateMemo,
  type DiscoveredBalance,
  type TransferIntent,
} from '@byeorin/wallet-sdk';
import { ShellError, parseScanned } from '@byeorin/shell-core';
import { Button, Card, Input } from '@byeorin/design-system';
import { useT } from '@byeorin/i18n/react';
import { walletStore } from '../wallet-store.js';
import { QrScanModal } from '../components/QrScanModal.js';

interface Props {
  onBack: () => void;
}

// 송금 흐름은 두 단계로 분리한다:
//   1) `compose`  — 주소·금액·자산 입력. "다음" 으로 확인 화면 진입.
//   2) `review`   — 큰 미리보기, "되돌릴 수 없습니다" 안내, "확정하고 보내기".
// 사용자가 review 에서 돌아오면 입력은 유지된다(`step` 만 바뀜).
// 송금이 시작되면 `pending` 으로, 성공/실패는 `sent` / `error` 상태로 전이.
type Step = 'compose' | 'review';
type Status =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'sent'; hash: string }
  | { kind: 'error'; message: string };

// TTL은 18자리 소수 (EVM 호환).
const TTL_DECIMALS = 18;

// 입력 검증 — 비어있지 않은 10진수, 소수점은 18자리 이하 (토큰별 decimals 는
// parseUnits 가 동적으로 처리).
const AMOUNT_RE = /^\d+(\.\d{1,18})?$/;

// "native" 는 TTL 송금. 그 외 값은 토큰 컨트랙트 주소(소문자 비교 X — UI 식별자).
type AssetKey = 'native' | string;

// 주소 형식 검사 — 훅 안팎에서 같은 기준을 쓴다.
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// 메모를 붙일 수신자 판정 상태.
//   idle     — 확인할 이유가 없다(메모칸이 비었거나 주소가 아직 형식 미달).
//   checking — eth_getCode 응답 대기.
//   eoa      — 코드 없음. 메모를 붙여도 된다.
//   contract — 코드 있음. 메모 바이트가 함수 호출로 해석되므로 막는다.
//   error    — RPC 가 답을 못 줬다. 모르면 멈춘다(어댑터도 같은 자리에서 던진다).
type RecipientKind = 'idle' | 'checking' | 'eoa' | 'contract' | 'error';

const RPC_URL = TTL_CHAIN.rpcUrls.default.http[0] ?? 'https://rpc.ttl1.top';

// 타자마다 RPC 를 때리지 않는다 — 입력이 멎고 이 시간이 지나야 한 번 부른다.
const RECIPIENT_CHECK_DEBOUNCE_MS = 500;

const sharedRegistry = new TokenRegistry();

export function Send({ onBack }: Props) {
  const t = useT();
  const [step, setStep] = useState<Step>('compose');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [tokens, setTokens] = useState<DiscoveredBalance[]>([]);
  const [asset, setAsset] = useState<AssetKey>('native');
  const [scanOpen, setScanOpen] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanNote, setScanNote] = useState<string | null>(null);
  // 메모 — TTL 은 평범한 송금 tx 의 data 에 UTF-8 바이트로 싣는다. 셸은 원문
  // 문자열만 넘기고 hex 변환·판정은 SDK(EvmAdapter + memo.ts) 가 한다.
  const [memo, setMemo] = useState('');
  const [recipientKind, setRecipientKind] = useState<RecipientKind>('idle');

  useEffect(() => {
    let cancelled = false;
    if (!walletStore.isUnlocked()) return;
    void walletStore.getAccount().then((acc) => {
      if (cancelled) return;
      const adapter = walletStore.getDefaultAdapter() as unknown as Parameters<
        typeof discoverTokens
      >[0];
      // rows 를 명시한다 — QR 모듈을 들여오면서 shell-core 타입이 함께 실려
      // discoverTokens 의 반환 추론이 any 로 무너진다.
      void discoverTokens(adapter, sharedRegistry, acc.address).then((rows: DiscoveredBalance[]) => {
        if (!cancelled) setTokens(rows);
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 앞뒤 공백은 잘라서 판정하고 잘라서 보낸다. 서버(wallet-api/memo.js)가
  // trim() 후 비면 탈락시키므로, 안 자르고 보내면 벼린이 센 바이트 수와 체인에
  // 남는 바이트 수가 어긋난다. 다른 셸 3종도 잘라서 보낸다.
  const trimmedMemo = memo.trim();
  const memoEmpty = trimmedMemo.length === 0;

  // ── 수신자가 EOA 인지 확인 ────────────────────────────────
  // 메모칸에 글자가 있고 주소가 형식을 갖췄을 때만 부른다. 메모를 안 쓰는
  // 사용자에게는 RPC 왕복이 0 이다. 어댑터도 서명 직전에 같은 확인을 하지만
  // (evm.ts assertEoaRecipient), 보내고 나서 실패를 보는 것보다 입력 중에 알려
  // 주는 편이 낫다.
  useEffect(() => {
    const target = to.trim();
    if (memoEmpty || !ADDRESS_RE.test(target)) {
      setRecipientKind('idle');
      return;
    }
    let cancelled = false;
    setRecipientKind('checking');
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(RPC_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'eth_getCode',
              params: [target, 'latest'],
            }),
          });
          const body = (await res.json()) as { result?: unknown };
          if (cancelled) return;
          // 답을 못 읽으면 'eoa' 로 추정하지 않는다 — 컨트랙트에 메모를 붙이면
          // 그 바이트가 함수 호출이 된다.
          if (typeof body.result !== 'string') {
            setRecipientKind('error');
            return;
          }
          setRecipientKind(body.result === '0x' ? 'eoa' : 'contract');
        } catch {
          if (!cancelled) setRecipientKind('error');
        }
      })();
    }, RECIPIENT_CHECK_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [to, memoEmpty]);

  const selectedToken = useMemo(() => {
    if (asset === 'native') return null;
    return tokens.find((tk) => tk.token.address === asset) ?? null;
  }, [asset, tokens]);

  if (!walletStore.isUnlocked()) {
    return (
      <div>
        <h1 className="nd-h1">{t('send.title')}</h1>
        <Card>
          <div className="nd-error">{t('send.locked_warn')}</div>
        </Card>
        <Button variant="ghost" className="nd-button--block" onClick={onBack}>
          {t('common.back')}
        </Button>
      </div>
    );
  }

  const decimals = selectedToken?.token.decimals ?? TTL_DECIMALS;
  const symbol = selectedToken?.token.symbol ?? 'TTL';

  const trimmedTo = to.trim();
  const trimmedAmount = amount.trim();
  const validAddress = /^0x[0-9a-fA-F]{40}$/.test(trimmedTo);
  const validAmountFormat = AMOUNT_RE.test(trimmedAmount);
  const validAmount = validAmountFormat && Number(trimmedAmount) > 0;
  const showAmountError = trimmedAmount.length > 0 && !validAmount;

  const locked = status.kind === 'pending' || status.kind === 'sent';

  // ── 메모 게이트 ───────────────────────────────────────────
  // 이 셸은 TTL(evm:ttl) 전용이다(wallet-store.ts 의 defaultAdapter). 따라서
  // 체인 조건은 필요 없고 자산 조건만 남는다 — ERC-20 전송은 tx.data 가 transfer
  // calldata 로 이미 차 있어 메모가 들어갈 자리가 없다(evm.ts buildTransfer).
  const memoCapable = selectedToken === null;
  const memoActive = memoCapable && !memoEmpty;
  // 판정은 SDK 가 한다 — 규칙(2..2048 바이트·제어문자·공백)을 셸에 복제하지 않는다.
  const memoCheck = memoEmpty ? null : validateMemo(trimmedMemo);
  const memoErrorText =
    memoActive && memoCheck && !memoCheck.ok
      ? t(`send.memo_reason.${memoCheck.reason}`, {
          n: memoCheck.byteLength,
          min: MEMO_MIN_BYTES,
          max: MEMO_MAX_BYTES,
        })
      : memoActive && recipientKind === 'contract'
        ? t('send.memo_contract_recipient')
        : memoActive && recipientKind === 'error'
          ? t('send.memo_recipient_check_failed')
          : undefined;
  // 확인 중(checking)에도 다음 단계로 넘기지 않는다 — 컨트랙트로 판명될 수 있다.
  const memoReady = !memoActive || (memoCheck?.ok === true && recipientKind === 'eoa');
  // 토큰을 고른 채 메모가 남아 있으면 조용히 버리지 않고 이유를 보인다.
  const memoDroppedByToken = selectedToken !== null && !memoEmpty;

  const canProceed = validAddress && validAmount && !locked && memoReady;

  // ── QR 스캔 결과 반영 ─────────────────────────────────────
  // 돈 보내는 자리라 스캔값을 그대로 입력란에 넣지 않는다. 형식 파싱과 주소
  // 검증을 shell-core 가 한 번에 하고(parseScanned), 실패하면 입력을 건드리지
  // 않고 이유만 보인다. 이 셸은 TTL 체인만 다루므로 검증 기준도 evm:ttl 이다.
  const applyScan = (text: string) => {
    const r = parseScanned(text, 'evm:ttl');
    if (!r.ok) {
      const key = `scan.error.${r.code.replace(/-/g, '_')}`;
      setScanError(t(key, { chain: 'TTL' }));
      setScanNote(null);
      setScanOpen(false); // 모달이 덮고 있으면 이유가 보이지 않는다
      return;
    }

    const notes: string[] = [];
    let noteSymbol = 'TTL';
    if (r.tokenAddress) {
      // EIP-681 /transfer — 이미 목록에 있는 토큰일 때만 자산을 바꾼다.
      const wanted = r.tokenAddress.toLowerCase();
      const hit = tokens.find((tk) => tk.token.address.toLowerCase() === wanted);
      if (hit) {
        setAsset(hit.token.address);
        noteSymbol = hit.token.symbol;
      } else {
        notes.push(t('scan.error.unsupported_scheme'));
      }
    }
    setTo(r.address);
    if (r.amount && AMOUNT_RE.test(r.amount)) {
      setAmount(r.amount);
      notes.push(t('scan.amount_filled', { amount: r.amount, symbol: noteSymbol }));
    } else if (r.amount) {
      notes.push(t('scan.amount_ignored'));
    }
    if (r.tokenAmountRaw) {
      notes.push(t('scan.token_raw_amount', { v: r.tokenAmountRaw }));
    }
    // 형식만 본 검증이라는 사실을 숨기지 않는다.
    notes.push(t('scan.address_unchecked'));

    setScanError(null);
    setScanNote(notes.join(' '));
    setScanOpen(false);
  };

  // 실제 송금 호출 — review 화면에서만 실행된다.
  const performSend = async () => {
    let value: bigint;
    try {
      value = parseUnits(trimmedAmount, decimals);
    } catch {
      setStatus({ kind: 'error', message: t('send.amount_invalid') });
      return;
    }

    let intent: TransferIntent;
    if (selectedToken) {
      // ERC-20 송금: calldata 를 채운 TransferIntent. wallet-sdk 의 EvmAdapter 가
      // intent.data 를 감지해 컨트랙트 호출 트랜잭션을 빌드한다.
      const adapter = walletStore.getDefaultAdapter() as unknown as ConstructorParameters<
        typeof Erc20
      >[0];
      const erc20 = new Erc20(adapter);
      intent = erc20.transfer(selectedToken.token.address, trimmedTo, value);
    } else {
      intent = { to: trimmedTo, amount: value };
      // 메모칸이 비면 memo 를 아예 넣지 않는다 — 빈 '0x' 도 data 에 넣지 않는다.
      // 어댑터는 원문 문자열을 받아 encodeMemo 로 hex 를 만든다(evm.ts).
      if (memoActive) intent.memo = trimmedMemo;
    }

    setStatus({ kind: 'pending' });
    try {
      const hash = await walletStore.transfer(intent);
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
  };

  // ── Step 2: review ────────────────────────────────────────
  if (step === 'review') {
    const shortAddr =
      trimmedTo.length > 14
        ? `${trimmedTo.slice(0, 6)}…${trimmedTo.slice(-4)}`
        : trimmedTo;

    return (
      <div>
        <h1 className="nd-h1">{t('send.review_title')}</h1>

        <div className="web-send-review">
          <p className="web-send-review__summary">
            {/*
              한국어 문장 구조상 "{amount} {symbol} 을(를) {address} 로 보냅니다." 가 자연스럽다.
              따로 분리된 span 으로 강조를 입혀 시각적 위계를 만든다.
            */}
            {t('send.review_summary', {
              amount: trimmedAmount,
              symbol,
              address: shortAddr,
            })}
          </p>
          {memoActive && (
            // 메모는 체인에 그대로 남는다 — 보내기 전에 원문을 그대로 보인다.
            // React 텍스트 노드라 이스케이프는 프레임워크가 한다.
            <div className="web-send-review__row web-send-review__row--memo">
              <span>{t('send.review_memo_label')}</span>
              <span className="web-send-review__memo-text">{memo}</span>
            </div>
          )}
          <div className="web-send-review__row">
            <span>{t('send.review_gas_label')}</span>
            <span>{t('send.review_gas_unknown')}</span>
          </div>
          <div className="web-send-review__row">
            <span>{t('send.view_in_explorer').replace(' ↗', '')}</span>
            <span>{t('send.review_explorer_preview')}</span>
          </div>
          <p className="web-send-review__irreversible">
            {t('send.review_irreversible')}
          </p>
        </div>

        {status.kind === 'pending' && (
          <div className="nd-warn">{t('send.pending')}</div>
        )}
        {status.kind === 'sent' && (
          <Card>
            <div className="nd-success">{t('send.sent_title')}</div>
            <div style={{ marginTop: 6 }}>
              <a
                href={`https://scan.ttl1.top/tx/${status.hash}`}
                target="_blank"
                rel="noreferrer"
              >
                {t('send.view_in_explorer')}
              </a>
            </div>
            <div className="nd-hash" style={{ marginTop: 6 }}>
              {status.hash}
            </div>
          </Card>
        )}
        {status.kind === 'error' && <div className="nd-error">{status.message}</div>}

        {status.kind === 'sent' ? (
          <Button variant="primary" className="nd-button--block" onClick={onBack}>
            {t('send.back_to_wallet')}
          </Button>
        ) : (
          <Button
            variant="primary"
            className="nd-button--block"
            disabled={!canProceed}
            loading={status.kind === 'pending'}
            onClick={() => void performSend()}
          >
            {status.kind === 'pending'
              ? t('send.sending')
              : t('send.review_confirm')}
          </Button>
        )}
        <Button
          variant="ghost"
          className="nd-button--block"
          onClick={() => setStep('compose')}
          disabled={status.kind === 'pending' || status.kind === 'sent'}
        >
          {t('send.review_edit')}
        </Button>
      </div>
    );
  }

  // ── Step 1: compose ───────────────────────────────────────
  return (
    <div>
      <h1 className="nd-h1">{t('send.title')}</h1>
      <p className="nd-lead">
        {selectedToken
          ? t('send.lead_token', { symbol: selectedToken.token.symbol })
          : t('send.lead_native')}
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canProceed) setStep('review');
        }}
      >
        {/* 토큰 선택은 dropdown 으로 보이지만, 어차피 자산 1개(TTL)만 있는 경우가
            대부분이라 사용자 인지 부담을 줄이기 위해 한 Card 안에 모아 둔다. */}
        <Card>
          <label className="nd-field__label" htmlFor="nd-asset-select">
            {t('send.asset_label')}
          </label>
          <select
            id="nd-asset-select"
            className="nd-input"
            value={asset}
            onChange={(e) => setAsset(e.target.value as AssetKey)}
            disabled={locked}
          >
            <option value="native">{t('send.asset_native_option')}</option>
            {tokens.map((tk) => (
              <option key={tk.token.address} value={tk.token.address}>
                {tk.token.symbol} · {tk.token.name}
              </option>
            ))}
          </select>
        </Card>

        <Card>
          <Input
            label={t('send.to_label')}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="0x..."
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            mono
            disabled={locked}
            error={
              trimmedTo.length > 0 && !validAddress
                ? t('send.to_invalid')
                : undefined
            }
          />
          <div className="web-send__scan-row">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setScanError(null);
                setScanNote(null);
                setScanOpen(true);
              }}
              disabled={locked}
            >
              {t('scan.button')}
            </Button>
          </div>
          {scanError && <div className="nd-error">{scanError}</div>}
          {scanNote && <div className="nd-warn">{scanNote}</div>}
        </Card>

        <Card>
          <Input
            label={t('send.amount_label', { symbol })}
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.0"
            disabled={locked}
            error={
              showAmountError ? t('send.amount_invalid') : undefined
            }
          />
        </Card>

        {/* 메모 — native(TTL) 송금에만 붙는다. design-system 의 Input 은 input
            전용이라 2048 바이트를 담기엔 좁다. 여기서만 bare textarea 를 쓰고
            클래스는 기존 nd-input 체계를 그대로 따른다. */}
        {memoCapable && (
          <Card>
            <label className="nd-field__label" htmlFor="nd-memo-input">
              {t('send.memo_label')}
            </label>
            <textarea
              id="nd-memo-input"
              className="nd-input web-send__memo-input"
              rows={2}
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder={t('send.memo_placeholder')}
              disabled={locked}
              aria-invalid={memoErrorText ? true : undefined}
            />
            <div className="web-send__memo-meta">
              <span>
                {t('send.memo_bytes', {
                  n: memoByteLength(memo),
                  max: MEMO_MAX_BYTES,
                })}
              </span>
              {memoActive && recipientKind === 'checking' && (
                <span>{t('send.memo_checking_recipient')}</span>
              )}
            </div>
            {memoErrorText && (
              <div className="nd-field__error" role="alert">
                {memoErrorText}
              </div>
            )}
            <p className="web-send__memo-note">{t('send.memo_public_note')}</p>
            {memoActive && (
              <p className="web-send__memo-note">{t('send.memo_gas_note')}</p>
            )}
          </Card>
        )}
        {memoDroppedByToken && (
          <div className="nd-warn">{t('send.memo_token_unsupported')}</div>
        )}

        <Button
          type="submit"
          variant="primary"
          className="nd-button--block"
          disabled={!canProceed}
        >
          {t('send.next_step')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="nd-button--block"
          onClick={onBack}
        >
          {t('common.back')}
        </Button>
      </form>

      {scanOpen && (
        <QrScanModal onDetected={applyScan} onClose={() => setScanOpen(false)} />
      )}
    </div>
  );
}
