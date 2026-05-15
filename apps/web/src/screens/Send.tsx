import { useState } from 'react';
import { parseUnits } from 'viem';
import { Button, Card, Input } from '@nodong/design-system';
import { getAccount, getWallet } from '../wallet-store.js';

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

// 입력 검증 — 비어있지 않은 10진수, 소수점은 18자리 이하.
// 끝/앞 공백은 trim 단계에서 제거되므로 정규식은 순수 숫자만 검사한다.
const AMOUNT_RE = /^\d+(\.\d{1,18})?$/;

// 스모크 체크:
//   parseUnits('0.7', 18) === 700000000000000000n  ✓ (정확)
//   parseFloat('0.7') * 1e18 === 6.999999999999999e17 → Math.floor → 699999999999999900  ✗ (-100 wei)

export function Send({ onBack }: Props) {
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const account = getAccount();
  const wallet = getWallet();

  if (!account || !wallet) {
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

  const trimmedTo = to.trim();
  const trimmedAmount = amount.trim();
  const validAddress = /^0x[0-9a-fA-F]{40}$/.test(trimmedTo);
  const validAmountFormat = AMOUNT_RE.test(trimmedAmount);
  // 0 / 0.0 / 0.00... 같이 모두 0인 값은 거부.
  const validAmount = validAmountFormat && Number(trimmedAmount) > 0;
  const showAmountError = trimmedAmount.length > 0 && !validAmount;

  const locked = status.kind === 'pending' || status.kind === 'sent';
  const disabled = !validAddress || !validAmount || locked;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (disabled) return;

    let value: bigint;
    try {
      // parseUnits는 문자열 기반이라 18자리 이내 어떤 입력이라도 정확하다.
      // 예: parseUnits('0.7', 18) === 700000000000000000n
      value = parseUnits(trimmedAmount, TTL_DECIMALS);
    } catch {
      setStatus({ kind: 'error', message: '금액 형식이 올바르지 않습니다.' });
      return;
    }

    setStatus({ kind: 'pending' });
    try {
      const hash = await wallet.transfer(account, {
        to: trimmedTo,
        amount: value,
      });
      setStatus({ kind: 'sent', hash });
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : '송금에 실패했습니다.',
      });
    }
  };

  return (
    <div>
      <h1 className="nd-h1">송금</h1>
      <p className="nd-lead">TTL을 다른 주소로 보냅니다. 수수료는 네트워크가 자동 산정합니다.</p>

      <form onSubmit={onSubmit}>
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
            label="금액 (TTL)"
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
