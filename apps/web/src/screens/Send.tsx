import { useEffect, useMemo, useState } from 'react';
import { parseUnits } from 'viem';
import {
  Erc20,
  TokenRegistry,
  discoverTokens,
  type DiscoveredBalance,
  type TransferIntent,
} from '@nodong/wallet-sdk';
import { ShellError } from '@nodong/shell-core';
import { Button, Card, Input } from '@nodong/design-system';
import { useT } from '@nodong/i18n/react';
import { walletStore } from '../wallet-store.js';

interface Props {
  onBack: () => void;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'sent'; hash: string }
  | { kind: 'error'; message: string };

// TTL은 18자리 소수 (EVM 호환).
const TTL_DECIMALS = 18;

// 입력 검증 — 비어있지 않은 10진수, 소수점은 18자리 이하 (토큰별 decimals 는
// parseUnits 가 동적으로 처리). 끝/앞 공백은 trim 단계에서 제거되므로
// 정규식은 순수 숫자만 검사한다.
const AMOUNT_RE = /^\d+(\.\d{1,18})?$/;

// 스모크 체크:
//   parseUnits('0.7', 18) === 700000000000000000n  ✓ (정확)
//   parseFloat('0.7') * 1e18 === 6.999999999999999e17 → Math.floor → 699999999999999900  ✗ (-100 wei)

// "native" 는 TTL 송금. 그 외 값은 토큰 컨트랙트 주소(소문자 비교 X — UI 식별자).
type AssetKey = 'native' | string;

const sharedRegistry = new TokenRegistry();

export function Send({ onBack }: Props) {
  const t = useT();
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [senderAddress, setSenderAddress] = useState<string | null>(null);
  const [tokens, setTokens] = useState<DiscoveredBalance[]>([]);
  const [asset, setAsset] = useState<AssetKey>('native');

  useEffect(() => {
    let cancelled = false;
    if (!walletStore.isUnlocked()) return;
    void walletStore.getAccount().then((acc) => {
      if (cancelled) return;
      setSenderAddress(acc.address);
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
  const disabled = !validAddress || !validAmount || locked;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;

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

  void senderAddress;

  return (
    <div>
      <h1 className="nd-h1">{t('send.title')}</h1>
      <p className="nd-lead">
        {selectedToken
          ? t('send.lead_token', { symbol: selectedToken.token.symbol })
          : t('send.lead_native')}
      </p>

      <form onSubmit={onSubmit}>
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
          <Button
            type="button"
            variant="primary"
            className="nd-button--block"
            onClick={onBack}
          >
            {t('send.back_to_wallet')}
          </Button>
        ) : (
          <Button
            type="submit"
            variant="primary"
            className="nd-button--block"
            disabled={disabled}
            loading={status.kind === 'pending'}
          >
            {status.kind === 'pending' ? t('send.sending') : t('send.submit')}
          </Button>
        )}

        <Button
          type="button"
          variant="ghost"
          className="nd-button--block"
          onClick={onBack}
          disabled={status.kind === 'pending'}
        >
          {t('common.back')}
        </Button>
      </form>
    </div>
  );
}
