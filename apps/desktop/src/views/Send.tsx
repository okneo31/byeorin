import { useEffect, useMemo, useState } from 'react';
import {
  Erc20,
  MEMO_MAX_BYTES,
  MEMO_MIN_BYTES,
  TTL_CHAIN,
  TokenRegistry,
  discoverTokens,
  validateMemo,
  type DiscoveredBalance,
  type MemoCheck,
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

// ── 메모 수신자 검사 ────────────────────────────────────────────────────
//
// 메모는 송금 tx 의 data 에 UTF-8 바이트로 실린다. 받는 쪽이 컨트랙트면 그
// 바이트가 함수 호출로 해석되므로 EOA 에만 붙인다(eth_getCode 가 '0x' 면 EOA).
// 어댑터(evm.ts assertEoaRecipient)가 최종적으로 막지만, 서명 버튼을 누르기
// 전에 화면이 먼저 알려주는 편이 낫다.
//
// 읽기 전용 RPC 다 — tx 를 보내지 않는다. tauri.conf.json 의 CSP connect-src 에
// rpc.ttl1.top 이 이미 있으므로 CSP 수정이 필요 없다.
const TTL_RPC_URL = TTL_CHAIN.rpcUrls.default.http[0] ?? 'https://rpc.ttl1.top';

type RecipientKind = 'eoa' | 'contract';

// 판정 결과를 캐시하지 않는다 — 한 번 EOA 로 본 주소도 나중에 CREATE2 로
// 컨트랙트가 배포될 수 있다. 오래된 'eoa' 를 믿으면 메모 바이트가 함수 호출로
// 해석되는 tx 를 그대로 내보낸다. 자금 경로라 성능보다 정확성이다.
// 왕복 절약은 아래 useEffect 의 600ms 디바운스가 맡는다(다른 셸 3종과 같다).
async function fetchRecipientKind(address: string): Promise<RecipientKind> {
  const res = await fetch(TTL_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getCode',
      params: [address, 'latest'],
    }),
  });
  if (!res.ok) throw new Error(`eth_getCode HTTP ${res.status}`);
  const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message ?? 'eth_getCode 오류');
  const code = typeof json.result === 'string' ? json.result : '0x';
  const kind: RecipientKind = code === '0x' || code === '' ? 'eoa' : 'contract';
  return kind;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function Send({ unlocked, onGoWallet }: Props) {
  const t = useT();
  // 카탈로그에 스캔 키가 아직 없을 때 키 문자열이 화면에 노출되지 않게 한다.
  const tx = (key: string, fallback: string, vars?: Record<string, string>) => {
    const s = t(key, vars);
    if (s !== key) return s;
    return vars ? fallback.replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? '') : fallback;
  };
  // 거부 사유는 SDK 가 준 코드(MemoRejectReason)를 i18n 키 꼬리에 그대로 붙인다.
  // 문자열 비교를 하지 않으므로 규칙이 늘어도 이 셸이 어긋나지 않는다.
  const memoReasonText = (check: MemoCheck): string =>
    tx(`send.memo_reason.${check.reason ?? 'empty'}`, '메모를 이대로 보낼 수 없습니다.', {
      n: String(check.byteLength),
      min: String(MEMO_MIN_BYTES),
      max: String(MEMO_MAX_BYTES),
    });
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
  const [memo, setMemo] = useState('');
  // 'idle' = 확인할 이유가 없음(메모 없음/주소 미완성), 'error' = RPC 실패.
  const [recipientKind, setRecipientKind] = useState<'idle' | 'checking' | 'error' | RecipientKind>(
    'idle',
  );

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

  // 이 셸은 TTL 체인만 다룬다(walletStore.getDefaultAdapter() = EvmAdapter/TTL_CHAIN).
  // 그래서 체인 게이트가 없다 — 남는 조건은 "native 자산" 하나뿐이다.
  // 토큰 송금은 tx.data 가 이미 ERC-20 transfer calldata 로 차 있어 메모가 들어갈
  // 자리가 없다(어댑터가 던진다).
  const memoCapable = selectedToken === null;
  const trimmedTo = to.trim();
  const toLooksValid = ADDRESS_RE.test(trimmedTo);
  // 어댑터에 넘길 실제 메모 문자열. 앞뒤 공백은 떼고 보낸다.
  const memoText = memo.trim();
  const memoCheck: MemoCheck = validateMemo(memoText);
  const memoWanted = memoCapable && memoText.length > 0;

  // 수신자 EOA 확인. **메모를 실제로 적었을 때만** 부른다 — 메모 없는 송금에
  // RPC 왕복을 늘리지 않는다. 또 타자마다 부르지 않는다: 600ms 멈춘 뒤 한 번.
  useEffect(() => {
    if (!memoWanted || !toLooksValid) {
      setRecipientKind('idle');
      return;
    }
    let cancelled = false;
    setRecipientKind('checking');
    const timer = setTimeout(() => {
      fetchRecipientKind(trimmedTo)
        .then((kind) => {
          if (!cancelled) setRecipientKind(kind);
        })
        .catch(() => {
          // 확인 못 했으면 모른다고 말한다 — 조용히 EOA 로 넘기지 않는다.
          if (!cancelled) setRecipientKind('error');
        });
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [memoWanted, toLooksValid, trimmedTo]);

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
      // 메모칸이 비면 memo 필드 자체를 넣지 않는다 — 빈 문자열·'0x' 를 넣으면
      // 메모 없는 송금이 기존과 다르게 동작한다.
      if (memoText.length > 0) {
        if (!memoCheck.ok) {
          setError(memoReasonText(memoCheck));
          return;
        }
        // 디바운스 중이거나 아직 못 본 주소일 수 있으니 여기서 한 번 더 확정한다.
        // 캐시를 두지 않으므로 이 확인은 항상 체인의 현재 상태를 읽는다.
        let kind: RecipientKind;
        try {
          kind = await fetchRecipientKind(trimmedTo);
        } catch {
          setRecipientKind('error');
          setError(
            tx(
              'send.memo_recipient_check_failed',
              '받는 주소가 컨트랙트인지 확인하지 못했습니다. 메모 없이 보내거나 잠시 후 다시 시도하세요.',
            ),
          );
          return;
        }
        setRecipientKind(kind);
        if (kind === 'contract') {
          setError(
            tx('send.memo_contract_recipient', '받는 주소가 컨트랙트라 메모를 붙일 수 없습니다.'),
          );
          return;
        }
        intent.memo = memoText;
      }
    }

    setSending(true);
    try {
      const finalHash = await walletStore.transfer(intent);
      setTxHash(finalHash);
      setAmount('');
      setMemo('');
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

        <div style={{ height: 16 }} />

        {/* 메모 — TTL 은 송금 tx 의 data 에 UTF-8 바이트로 싣는다. 규칙 검사는
            SDK 의 validateMemo 하나로 한다(셸에 규칙을 복제하지 않는다). */}
        {memoCapable ? (
          <>
            <label className="nd-label" htmlFor="nd-memo-d">
              {tx('send.memo_label', '메모 (선택)')}
            </label>
            <textarea
              id="nd-memo-d"
              className="nd-textarea nd-textarea--memo"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder={tx('send.memo_placeholder', '이 체인은 메모를 기록에 남깁니다')}
              spellCheck={false}
              disabled={sending}
            />
            <div className="nd-memo-meta">
              <span className="nd-muted">
                {tx('send.memo_bytes', '{n} / {max} 바이트', {
                  n: String(memoCheck.byteLength),
                  max: String(MEMO_MAX_BYTES),
                })}
              </span>
              {memoWanted && recipientKind === 'checking' && (
                <span className="nd-muted">
                  {tx('send.memo_checking_recipient', '받는 주소를 확인하는 중…')}
                </span>
              )}
            </div>

            {memoWanted && !memoCheck.ok && (
              <div className="nd-error">{memoReasonText(memoCheck)}</div>
            )}
            {memoWanted && recipientKind === 'contract' && (
              <div className="nd-error">
                {tx('send.memo_contract_recipient', '받는 주소가 컨트랙트라 메모를 붙일 수 없습니다.')}
              </div>
            )}
            {memoWanted && recipientKind === 'error' && (
              <div className="nd-error">
                {tx(
                  'send.memo_recipient_check_failed',
                  '받는 주소가 컨트랙트인지 확인하지 못했습니다. 메모 없이 보내거나 잠시 후 다시 시도하세요.',
                )}
              </div>
            )}

            {memoWanted && memoCheck.ok && (
              <>
                <p className="nd-muted" style={{ marginTop: 8 }}>
                  {tx(
                    'send.memo_public_note',
                    '메모는 체인에 그대로 남고 누구나 볼 수 있습니다. 개인정보를 적지 마세요.',
                  )}
                </p>
                <p className="nd-muted" style={{ marginTop: 4 }}>
                  {tx('send.memo_gas_note', '메모를 붙이면 수수료가 늘어납니다. 메모가 길수록 더 늘어납니다.')}
                </p>
                {/* 이 셸에는 별도 확인(review) 단계가 없다. 서명 버튼 바로 위에
                    보낼 메모 원문을 그대로 보여줘, 오타가 체인에 영구히 남기 전에
                    눈으로 대조하게 한다. */}
                <div className="nd-memo-review">
                  <div className="nd-label">{tx('send.review_memo_label', '메모')}</div>
                  <div className="nd-memo-review__text">{memoText}</div>
                </div>
              </>
            )}
          </>
        ) : (
          <p className="nd-muted">
            {tx('send.memo_token_unsupported', '토큰 송금에는 메모를 붙일 수 없습니다.')}
          </p>
        )}

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
            // 메모가 규칙을 어기거나 받는 쪽이 컨트랙트면 서명 자체를 막는다.
            // (어댑터도 던지지만, 눌러 보고 실패하는 것보다 못 누르는 편이 낫다.)
            disabled={sending || (memoWanted && (!memoCheck.ok || recipientKind === 'contract'))}
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
