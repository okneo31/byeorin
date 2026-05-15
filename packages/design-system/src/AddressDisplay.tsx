import * as React from 'react';

export interface AddressDisplayProps {
  /** 표시할 풀 주소 (0x..., bc1..., cosmos1... 등). */
  address: string;
  /** 앞에 노출할 글자 수. 기본 6. */
  head?: number;
  /** 뒤에 노출할 글자 수. 기본 4. */
  tail?: number;
  /** 복사 버튼 표시 여부. 기본 true. */
  copyable?: boolean;
  /** 복사 버튼 라벨(한국어). 호출자 주입. 기본 "복사". */
  copyLabel?: string;
  /** 복사 직후 잠시 보여줄 라벨. 기본 "복사됨". */
  copiedLabel?: string;
  /** 복사 성공 콜백. */
  onCopy?: (address: string) => void;
  /** 추가 클래스. */
  className?: string;
}

function truncate(addr: string, head: number, tail: number): string {
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

/**
 * AddressDisplay — 긴 지갑 주소를 0x1234…abcd 형식으로 줄여 보여주고
 * 등폭 글꼴 + 클립보드 복사 버튼을 함께 제공한다.
 */
export function AddressDisplay({
  address,
  head = 6,
  tail = 4,
  copyable = true,
  copyLabel = '복사',
  copiedLabel = '복사됨',
  onCopy,
  className,
}: AddressDisplayProps) {
  const [copied, setCopied] = React.useState(false);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = React.useCallback(async () => {
    try {
      if (
        typeof navigator !== 'undefined' &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === 'function'
      ) {
        await navigator.clipboard.writeText(address);
      }
      setCopied(true);
      onCopy?.(address);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // 조용히 실패: 클립보드 권한이 없을 수도 있다.
    }
  }, [address, onCopy]);

  const shown = truncate(address, head, tail);

  return (
    <span className={['nd-address', className].filter(Boolean).join(' ')}>
      <span title={address} aria-label={address}>
        {shown}
      </span>
      {copyable && (
        <button
          type="button"
          className="nd-address__copy"
          onClick={handleCopy}
          aria-live="polite"
        >
          {copied ? copiedLabel : copyLabel}
        </button>
      )}
    </span>
  );
}

export default AddressDisplay;
