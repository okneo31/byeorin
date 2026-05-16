import { useEffect, useMemo, useState } from 'react';
import { parseUnits } from 'viem';
import {
  Erc20,
  TokenRegistry,
  discoverTokens,
  type DiscoveredBalance,
  type TransferIntent,
} from '@nodong/wallet-sdk';
import { Button, Card, Input } from '@nodong/design-system';
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
    return tokens.find((t) => t.token.address === asset) ?? null;
  }, [asset, tokens]);

  if (!walletStore.isUnlocked()) {
    return (
      <div>
        <h1 className="nd-h1">송금</h1>
        <Card>
          <div className="nd-error">지갑이 잠겨있습니다. 다시 시작해주세요.</div>
        </Card>
        <Button variant="ghost" className="nd-button--block" onClick={onBack}>
          뒤로
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
      setStatus({ kind: 'error', message: '금액 형식이 올바르지 않습니다.' });
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
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : '송금에 실패했습니다.',
      });
    }
  };

  void senderAddress;

  return (
    <div>
      <h1 className="nd-h1">송금</h1>
      <p className="nd-lead">
        {selectedToken
          ? `${selectedToken.token.symbol} 토큰을 다른 주소로 보냅니다.`
          : 'TTL을 다른 주소로 보냅니다. 수수료는 네트워크가 자동 산정합니다.'}
      </p>

      <form onSubmit={onSubmit}>
        <Card>
          <label className="nd-field__label" htmlFor="nd-asset-select">
            어떤 토큰?
          </label>
          <select
            id="nd-asset-select"
            className="nd-input"
            value={asset}
            onChange={(e) => setAsset(e.target.value as AssetKey)}
            disabled={locked}
          >
            <option value="native">TTL (네이티브)</option>
            {tokens.map((t) => (
              <option key={t.token.address} value={t.token.address}>
                {t.token.symbol} · {t.token.name}
              </option>
            ))}
          </select>
        </Card>

        <Card>
          <Input
            label="받는 주소"
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
                ? '주소 형식이 올바르지 않습니다 (0x + 40자리 16진수).'
                : undefined
            }
          />
        </Card>

        <Card>
          <Input
            label={`금액 (${symbol})`}
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.0"
            disabled={locked}
            error={
              showAmountError ? '금액 형식이 올바르지 않습니다.' : undefined
            }
          />
        </Card>

        {status.kind === 'pending' && (
          <div className="nd-warn">송금을 처리하고 있습니다. 잠시만 기다려주세요...</div>
        )}

        {status.kind === 'sent' && (
          <Card>
            <div className="nd-success">송금 요청 완료</div>
            <div style={{ marginTop: 6 }}>
              <a
                href={`https://scan.ttl1.top/tx/${status.hash}`}
                target="_blank"
                rel="noreferrer"
              >
                탐색기에서 보기 ↗
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
            지갑으로
          </Button>
        ) : (
          <Button
            type="submit"
            variant="primary"
            className="nd-button--block"
            disabled={disabled}
            loading={status.kind === 'pending'}
          >
            {status.kind === 'pending' ? '전송 중...' : '보내기'}
          </Button>
        )}

        <Button
          type="button"
          variant="ghost"
          className="nd-button--block"
          onClick={onBack}
          disabled={status.kind === 'pending'}
        >
          뒤로
        </Button>
      </form>
    </div>
  );
}
