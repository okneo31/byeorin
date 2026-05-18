import { useEffect, useMemo, useState } from 'react';
import { parseUnits } from 'viem';
import {
  Erc20,
  TokenRegistry,
  discoverTokens,
  type DiscoveredBalance,
  type TransferIntent,
} from '@byeorin/wallet-sdk';
import { ShellError } from '@byeorin/shell-core';
import { Button, Card, Input } from '@byeorin/design-system';
import { useT } from '@byeorin/i18n/react';
import { walletStore } from '../wallet-store.js';

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

const sharedRegistry = new TokenRegistry();

export function Send({ onBack }: Props) {
  const t = useT();
  const [step, setStep] = useState<Step>('compose');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [tokens, setTokens] = useState<DiscoveredBalance[]>([]);
  const [asset, setAsset] = useState<AssetKey>('native');

  useEffect(() => {
    let cancelled = false;
    if (!walletStore.isUnlocked()) return;
    void walletStore.getAccount().then((acc) => {
      if (cancelled) return;
      const adapter = walletStore.getDefaultAdapter() as unknown as Parameters<
        typeof discoverTokens
      >[0];
      void discoverTokens(adapter, sharedRegistry, acc.address).then((rows) => {
        if (!cancelled) setTokens(rows);
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
  const canProceed = validAddress && validAmount && !locked;

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
    }

    setStatus({ kind: 'pending' });
    try {
      const hash = await walletStore.transfer(intent);
      setStatus({ kind: 'sent', hash });
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
    </div>
  );
}
