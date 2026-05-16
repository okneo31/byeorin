import { useEffect, useMemo, useState } from 'react';
import {
  Erc20,
  TokenRegistry,
  discoverTokens,
  type DiscoveredBalance,
  type TransferIntent,
  type WalletAccount,
} from '@nodong/wallet-sdk';
import { AddressDisplay, Button, Card, Input } from '@nodong/design-system';
import { walletStore } from '../wallet-store.js';

interface Props {
  unlocked: boolean;
  onGoWallet: () => void;
}

// chainId 별 TokenRegistry — Wallet 뷰와 별도 인스턴스. 사용자 커스텀은
// 양 뷰가 공유되지 않지만, 송금에서 표시되는 토큰은 어차피 잔액 > 0 인 것만
// discoverTokens 로 가져오므로 빌트인이면 양쪽 다 보인다.
const sharedRegistry = new TokenRegistry();

// "native" 는 TTL 송금. 그 외 값은 토큰 컨트랙트 주소.
type AssetKey = 'native' | string;

const TTL_DECIMALS = 18;

export function Send({ unlocked, onGoWallet }: Props) {
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [toError, setToError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [tokens, setTokens] = useState<DiscoveredBalance[]>([]);
  const [asset, setAsset] = useState<AssetKey>('native');

  useEffect(() => {
    let cancelled = false;
    if (!unlocked || !walletStore.isUnlocked()) {
      setAccount(null);
      return;
    }
    void walletStore.getAccount().then((a) => {
      if (cancelled) return;
      setAccount(a);
      const adapter = walletStore.getDefaultAdapter() as unknown as Parameters<
        typeof discoverTokens
      >[0];
      void discoverTokens(adapter, sharedRegistry, a.address).then((rows) => {
        if (!cancelled) setTokens(rows);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [unlocked]);

  const selectedToken = useMemo(() => {
    if (asset === 'native') return null;
    return tokens.find((t) => t.token.address === asset) ?? null;
  }, [asset, tokens]);

  if (!unlocked || !account) {
    return (
      <div className="nd-view">
        <header className="nd-view__header">
          <h1 className="nd-h1">송수신</h1>
          <p className="nd-lead">먼저 지갑을 열거나 복원해 주세요.</p>
        </header>
        <Card as="section">
          <Button variant="primary" className="nd-button--block" onClick={onGoWallet}>
            지갑으로 이동
          </Button>
        </Card>
      </div>
    );
  }

  const decimals = selectedToken?.token.decimals ?? TTL_DECIMALS;
  const symbol = selectedToken?.token.symbol ?? 'TTL';

  const submit = async () => {
    setError(null);
    setTxHash(null);
    setToError(null);
    setAmountError(null);

    if (!/^0x[0-9a-fA-F]{40}$/.test(to.trim())) {
      setToError('받는 주소가 올바르지 않습니다.');
      return;
    }
    let value: bigint;
    try {
      value = parseAmountToBase(amount.trim(), decimals);
    } catch (e) {
      setAmountError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (value <= 0n) {
      setAmountError('금액은 0보다 커야 합니다.');
      return;
    }

    let intent: TransferIntent;
    if (selectedToken) {
      const adapter = walletStore.getDefaultAdapter() as unknown as ConstructorParameters<
        typeof Erc20
      >[0];
      const erc20 = new Erc20(adapter);
      intent = erc20.transfer(selectedToken.token.address, to.trim(), value);
    } else {
      intent = { to: to.trim(), amount: value };
    }

    setSending(true);
    try {
      const finalHash = await walletStore.transfer(intent);
      setTxHash(finalHash);
      setAmount('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="nd-view">
      <header className="nd-view__header">
        <h1 className="nd-h1">송수신</h1>
        <p className="nd-lead">
          {selectedToken
            ? `${selectedToken.token.symbol} 토큰을 송금합니다.`
            : 'TTL을 송금합니다. 수수료는 자동 추정됩니다.'}
        </p>
      </header>

      <Card as="section">
        <div className="nd-label">보내는 주소</div>
        <AddressDisplay address={account.address} head={8} tail={6} />
      </Card>

      <Card as="section" style={{ marginTop: 16 }}>
        <label className="nd-label" htmlFor="nd-asset-select-d">
          어떤 토큰?
        </label>
        <select
          id="nd-asset-select-d"
          className="nd-input"
          value={asset}
          onChange={(e) => setAsset(e.target.value as AssetKey)}
          disabled={sending}
        >
          <option value="native">TTL (네이티브)</option>
          {tokens.map((t) => (
            <option key={t.token.address} value={t.token.address}>
              {t.token.symbol} · {t.token.name}
            </option>
          ))}
        </select>

        <div style={{ height: 16 }} />

        <Input
          id="to"
          label="받는 주소"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="0x..."
          autoComplete="off"
          spellCheck={false}
          mono
          error={toError ?? undefined}
        />

        <div style={{ height: 16 }} />

        <Input
          id="amount"
          label={`금액 (${symbol})`}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          placeholder="0.0"
          autoComplete="off"
          error={amountError ?? undefined}
        />

        {error && <div className="nd-error">{error}</div>}
        {txHash && (
          <div className="nd-success">
            전송 완료 · 트랜잭션 해시:
            <br />
            <code style={{ wordBreak: 'break-all' }}>{txHash}</code>
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          <Button
            variant="primary"
            className="nd-button--block"
            onClick={submit}
            loading={sending}
            disabled={sending}
          >
            {sending ? '전송 중…' : '서명하고 전송'}
          </Button>
        </div>
      </Card>
    </div>
  );
}

/**
 * 소수 문자열 → 토큰 base unit (bigint). decimals 가 동적이라 viem.parseUnits 대신
 * 인라인 구현 — 이 파일이 viem 직접 의존을 갖지 않게 한다 (이미 SDK 가 통제).
 */
function parseAmountToBase(s: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error('금액 형식이 올바르지 않습니다.');
  }
  const [whole, frac = ''] = s.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole ?? '0') * 10n ** BigInt(decimals) + BigInt(fracPadded || '0');
}
