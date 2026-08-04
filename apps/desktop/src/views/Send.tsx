import { useEffect, useMemo, useState } from 'react';
import {
  Erc20,
  TokenRegistry,
  discoverTokens,
  type DiscoveredBalance,
  type TransferIntent,
  type WalletAccount,
} from '@byeorin/wallet-sdk';
import { AddressDisplay, Button, Card, Input } from '@byeorin/design-system';
import { useT } from '@byeorin/i18n/react';
import type { ScanResult } from '@byeorin/shell-core';
import { walletStore } from '../wallet-store.js';
import { QrScanner } from '../components/QrScanner.js';

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
  const t = useT();
  // 카탈로그에 스캔 키가 아직 없을 때 키 문자열이 화면에 노출되지 않게 한다.
  const tx = (key: string, fallback: string, vars?: Record<string, string>) => {
    const s = t(key, vars);
    if (s !== key) return s;
    return vars ? fallback.replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? '') : fallback;
  };
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
  const [scanOpen, setScanOpen] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);

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
          <h1 className="nd-h1">{t('send.title_desktop')}</h1>
          <p className="nd-lead">{t('send.locked_lead')}</p>
        </header>
        <Card as="section">
          <Button variant="primary" className="nd-button--block" onClick={onGoWallet}>
            {t('send.go_to_wallet')}
          </Button>
        </Card>
      </div>
    );
  }

  const decimals = selectedToken?.token.decimals ?? TTL_DECIMALS;
  const symbol = selectedToken?.token.symbol ?? 'TTL';

  // 스캔값은 검증을 통과한 것만 들어온다(parseScanned 가 주소 형식까지 본다).
  // 남은 위험은 "형식은 맞지만 다른 체인·다른 토큰" 이므로 채우되 알린다.
  const applyScan = (r: ScanResult) => {
    // 정규식·EIP-55 까지만 본 값이다 — 눈으로 대조하라는 말을 항상 남긴다.
    const notes: string[] = [
      tx('scan.address_unchecked', '형식만 확인했습니다 — 주소를 눈으로 대조하세요.'),
      ...r.warnings,
    ];
    setTo(r.address);
    setToError(null);
    if (r.chainHint && r.chainHint !== 'evm:ttl') {
      notes.push(tx('scan.chain_hint_mismatch', '이 QR 은 {chain} 을(를) 가리킵니다. 지금 선택된 체인은 {current} 입니다.', { chain: r.chainHint, current: 'TTL' }));
    }
    if (r.tokenAddress) {
      const hit = tokens.find(
        (tok) => tok.token.address.toLowerCase() === r.tokenAddress?.toLowerCase(),
      );
      if (hit) setAsset(hit.token.address);
      else
        notes.push(
          tx('scan.token_unknown', '목록에 없는 토큰이라 자산을 바꾸지 않았습니다: {token}', {
            token: r.tokenAddress,
          }),
        );
    }
    if (r.amount) {
      setAmount(r.amount);
      setAmountError(null);
    } else if (r.tokenAmountRaw) {
      // decimals 를 모르는 raw uint256 은 추측 환산하지 않는다.
      notes.push(
        tx('scan.token_raw_amount', '토큰 수량({v})은 자릿수를 알 수 없어 채우지 않았습니다.', {
          v: r.tokenAmountRaw,
        }),
      );
    }
    setScanNote(notes.length ? notes.join(' · ') : null);
    setScanOpen(false);
  };

  const submit = async () => {
    setError(null);
    setTxHash(null);
    setToError(null);
    setAmountError(null);

    if (!/^0x[0-9a-fA-F]{40}$/.test(to.trim())) {
      setToError(t('send.to_invalid_desktop'));
      return;
    }
    let value: bigint;
    try {
      value = parseAmountToBase(amount.trim(), decimals);
    } catch {
      setAmountError(t('send.amount_invalid'));
      return;
    }
    if (value <= 0n) {
      setAmountError(t('send.amount_invalid_positive'));
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
        <h1 className="nd-h1">{t('send.title_desktop')}</h1>
        <p className="nd-lead">
          {selectedToken
            ? t('send.lead_token_desktop', { symbol: selectedToken.token.symbol })
            : t('send.lead_native_desktop')}
        </p>
      </header>

      <Card as="section">
        <div className="nd-label">{t('send.from_label')}</div>
        <AddressDisplay address={account.address} head={8} tail={6} />
      </Card>

      <Card as="section" style={{ marginTop: 16 }}>
        <label className="nd-label" htmlFor="nd-asset-select-d">
          {t('send.asset_label')}
        </label>
        <select
          id="nd-asset-select-d"
          className="nd-input"
          value={asset}
          onChange={(e) => setAsset(e.target.value as AssetKey)}
          disabled={sending}
        >
          <option value="native">{t('send.asset_native_option')}</option>
          {tokens.map((tok) => (
            <option key={tok.token.address} value={tok.token.address}>
              {tok.token.symbol} · {tok.token.name}
            </option>
          ))}
        </select>

        <div style={{ height: 16 }} />

        <Input
          id="to"
          label={t('send.to_label')}
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="0x..."
          autoComplete="off"
          spellCheck={false}
          mono
          error={toError ?? undefined}
        />

        <div style={{ marginTop: 8 }}>
          <Button variant="secondary" onClick={() => setScanOpen((v) => !v)} disabled={sending}>
            {scanOpen ? tx('scan.cancel', '취소') : tx('scan.button', 'QR 스캔')}
          </Button>
        </div>

        {scanNote && (
          <div className="nd-lead" style={{ marginTop: 8 }}>
            {scanNote}
          </div>
        )}

        <div style={{ height: 16 }} />

        <Input
          id="amount"
          label={t('send.amount_label', { symbol })}
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
            {t('send.completed_inline')}
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
            {sending ? t('send.sending_short') : t('send.sign_and_send')}
          </Button>
        </div>
      </Card>

      {scanOpen && (
        <QrScanner chain="evm:ttl" onResult={applyScan} onClose={() => setScanOpen(false)} />
      )}
    </div>
  );
}

/**
 * 소수 문자열 → 토큰 base unit (bigint). decimals 가 동적이라 viem.parseUnits 대신
 * 인라인 구현 — 이 파일이 viem 직접 의존을 갖지 않게 한다 (이미 SDK 가 통제).
 */
function parseAmountToBase(s: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(s)) {
    // The caller renders a localized message; this sentinel just signals
    // "amount format invalid" without leaking a hardcoded locale.
    throw new Error('INVALID_AMOUNT_FORMAT');
  }
  const [whole, frac = ''] = s.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole ?? '0') * 10n ** BigInt(decimals) + BigInt(fracPadded || '0');
}
