import * as React from 'react';

export interface AmountDisplayProps {
  /** 정수 base unit (예: wei, satoshi). bigint 또는 10진 문자열을 받는다. */
  value: bigint | string;
  /** 소수 자릿수 (예: ETH=18, BTC=8, USDC=6). */
  decimals: number;
  /** 토큰/통화 심볼 (예: "ETH"). 호출자 주입. */
  symbol?: string;
  /** 표시할 최대 소수 자릿수. 기본 6 (ETH 보기 좋은 기본값). */
  maxDecimals?: number;
  /** 자릿수가 길어 잘릴 때 끝에 "..." 표시. 기본 false. */
  showApprox?: boolean;
  /** 컴포넌트 크기. */
  size?: 'sm' | 'md' | 'lg';
  /** 한국어 천 단위 구분자(쉼표) 사용 여부. 기본 true. */
  thousandsSeparator?: boolean;
  className?: string;
}

function normalizeValue(v: bigint | string): bigint {
  if (typeof v === 'bigint') return v;
  // 음수/공백 허용. 빈 문자열은 0n.
  const trimmed = v.trim();
  if (trimmed === '' || trimmed === '-') return 0n;
  return BigInt(trimmed);
}

/**
 * base unit을 소수 표기로 바꾼다.
 * 예) formatUnits(123456789n, 6) -> "123.456789"
 */
function formatUnits(value: bigint, decimals: number): {
  intPart: string;
  fracPart: string;
  negative: boolean;
} {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const s = abs.toString();
  if (decimals <= 0) {
    return { intPart: s, fracPart: '', negative };
  }
  if (s.length <= decimals) {
    const frac = s.padStart(decimals, '0');
    return { intPart: '0', fracPart: frac, negative };
  }
  const intPart = s.slice(0, s.length - decimals);
  const fracPart = s.slice(s.length - decimals);
  return { intPart, fracPart, negative };
}

function withThousands(intPart: string): string {
  // ko-KR 로케일 그룹 구분자(쉼표) 사용.
  // intPart는 절댓값 + 부호 없음 가정.
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * AmountDisplay — bigint base-unit 금액을 소수·심볼·한국식 천 단위 콤마로 표기.
 * 정확도 손실을 피하기 위해 모든 계산은 문자열/bigint로 수행한다 (Number 사용 X).
 */
export function AmountDisplay({
  value,
  decimals,
  symbol,
  maxDecimals = 6,
  showApprox = false,
  size = 'md',
  thousandsSeparator = true,
  className,
}: AmountDisplayProps) {
  const v = normalizeValue(value);
  const { intPart, fracPart, negative } = formatUnits(v, decimals);

  let frac = fracPart;
  let truncated = false;
  if (frac.length > maxDecimals) {
    truncated = true;
    frac = frac.slice(0, maxDecimals);
  }
  // 의미 없는 trailing 0 제거.
  frac = frac.replace(/0+$/, '');

  const intDisplay = thousandsSeparator ? withThousands(intPart) : intPart;
  const sign = negative ? '-' : '';
  const decimalStr = frac.length > 0 ? `.${frac}` : '';
  const approx = truncated && showApprox ? '…' : '';
  const valueText = `${sign}${intDisplay}${decimalStr}${approx}`;

  return (
    <span
      className={[
        'nd-amount',
        `nd-amount--${size}`,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span className="nd-amount__value">{valueText}</span>
      {symbol && <span className="nd-amount__symbol">{symbol}</span>}
    </span>
  );
}

export default AmountDisplay;
