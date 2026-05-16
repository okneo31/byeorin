// 노동자의 지갑 — 4-byte 셀렉터 디코더 + ERC-20/721/1155 인자 파서.
//
// EIP-1193 의 eth_sendTransaction 이 data 를 동반할 때, confirm popup 이 사용자에게
// "어떤 함수가 호출되는지" 를 보여주기 위한 최소한의 휴리스틱.
//
// 본 모듈은 표준 ERC 진입점에 대해서만 인자(주소/금액)를 추출한다. 미상 셀렉터는
// 그대로 hex 로 노출하고 "알 수 없는 함수 호출" 라벨을 붙인다.

import { decodeFunctionData, parseAbi, type Hex } from 'viem';

/**
 * `${selector(0x… 4B)}: 사람이 읽는 시그니처` 형태.
 * keccak256(signature) 의 첫 4바이트가 셀렉터 — 모두 표준 ERC 정의 기반.
 */
export const SELECTOR_TABLE: Record<string, string> = {
  // ERC-20
  '0xa9059cbb': 'transfer(address,uint256)',
  '0x23b872dd': 'transferFrom(address,address,uint256)',
  '0x095ea7b3': 'approve(address,uint256)',

  // ERC-721 (ERC-20 의 transfer 와 동일 셀렉터를 갖는 'transferFrom' 은 위에서 커버)
  '0x42842e0e': 'safeTransferFrom(address,address,uint256)',
  '0xb88d4fde': 'safeTransferFrom(address,address,uint256,bytes)',
  '0xa22cb465': 'setApprovalForAll(address,bool)',

  // ERC-1155
  '0xf242432a': 'safeTransferFrom(address,address,uint256,uint256,bytes)',
  '0x2eb2c2d6': 'safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)',
  // ERC-1155 의 setApprovalForAll 셀렉터는 ERC-721 과 동일 (위에서 커버).
};

export type DecodedSelector = {
  selector: string;        // '0xa9059cbb' (소문자)
  signature: string | null; // 알려진 경우 'transfer(address,uint256)' 등, 미상 null.
};

/**
 * data hex 의 처음 4바이트(8 hex chars + '0x')를 셀렉터로 추출. data 가 '0x' / 빈
 * 문자열 / 4바이트보다 짧으면 null 을 반환.
 */
export function decode4Byte(dataHex: string | null | undefined): DecodedSelector | null {
  if (!dataHex || typeof dataHex !== 'string') return null;
  const h = dataHex.toLowerCase();
  if (!h.startsWith('0x')) return null;
  // 4바이트 셀렉터 = '0x' + 8 hex chars = 정확히 10자.
  if (h.length < 10) return null;
  const selector = h.slice(0, 10);
  // hex 문자만 허용.
  if (!/^0x[0-9a-f]{8}$/.test(selector)) return null;
  const sig = SELECTOR_TABLE[selector] ?? null;
  return { selector, signature: sig };
}

// ── ERC-20/721 ABI (최소 — viem.decodeFunctionData 입력용) ──────────────
// 본 ABI 들은 인자 추출 전용. 셀렉터별 분기는 호출부가 담당.
const ERC20_ABI = parseAbi([
  'function transfer(address to, uint256 amount)',
  'function approve(address spender, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amount)',
]);

/**
 * ERC-20 표준 함수의 인자(주소/금액)를 추출한다. 셀렉터가 매치하지 않거나 디코딩
 * 실패 시 null. viem 의 decodeFunctionData 는 길이 부족/타입 불일치를 자체적으로 던진다.
 */
export type Erc20Decoded =
  | { kind: 'transfer'; to: string; amount: bigint }
  | { kind: 'approve'; spender: string; amount: bigint }
  | { kind: 'transferFrom'; from: string; to: string; amount: bigint };

export function decodeErc20Call(dataHex: string | null | undefined): Erc20Decoded | null {
  if (!dataHex || typeof dataHex !== 'string') return null;
  const h = dataHex.toLowerCase();
  if (!h.startsWith('0x')) return null;
  // 셀렉터(4B) + 최소 32B 인자 1 개 이상 필요.
  if (h.length < 10 + 64) return null;
  const sel = h.slice(0, 10);
  if (sel !== '0xa9059cbb' && sel !== '0x095ea7b3' && sel !== '0x23b872dd') return null;
  try {
    const { functionName, args } = decodeFunctionData({
      abi: ERC20_ABI,
      data: h as Hex,
    });
    if (functionName === 'transfer') {
      const [to, amount] = args as [string, bigint];
      return { kind: 'transfer', to, amount };
    }
    if (functionName === 'approve') {
      const [spender, amount] = args as [string, bigint];
      return { kind: 'approve', spender, amount };
    }
    if (functionName === 'transferFrom') {
      const [from, to, amount] = args as [string, string, bigint];
      return { kind: 'transferFrom', from, to, amount };
    }
    return null;
  } catch {
    return null;
  }
}

// ── 위험 휴리스틱 ──────────────────────────────────────────────────────

/**
 * "무제한 승인" 임계값.
 *
 * 이유: ERC-20 표준 approve 호출은 종종 2^256-1 (=MaxUint256) 또는 그에 준하는
 * 거대 값을 사용해 사용자의 풀 잔고에 대한 권한을 영구적으로 위임한다. 본 임계값을
 * 2^200 으로 잡은 까닭:
 *   - 어떤 ERC-20 도 totalSupply 가 2^200 을 넘지 않는다(소수점 18자리 기준 ≈ 1.6e60).
 *   - 따라서 2^200 이상은 100% "무제한 의도" — 사용자에게 빨간 깃발을 보여준다.
 *   - 2^256-1 만 검사하는 휴리스틱은 0xff..fe / 0xf0..00 같은 변형(MetaMask 가
 *     관측한 패턴) 을 놓친다.
 */
export const UNLIMITED_APPROVE_THRESHOLD = 1n << 200n;

export function isUnlimitedApprove(amount: bigint): boolean {
  return amount >= UNLIMITED_APPROVE_THRESHOLD;
}

/** 0x0000…0000 (40 hex chars) 여부. case-insensitive. */
export function isZeroAddress(addr: string | undefined | null): boolean {
  if (!addr || typeof addr !== 'string') return false;
  return /^0x0{40}$/i.test(addr);
}

/**
 * 알려진 Seaport(OpenSea) verifyingContract 주소(소문자).
 * EIP-712 OrderComponents/Order 서명은 dApp 이 NFT/토큰 양도 권한을
 * 위임받는 매우 위험한 패턴 — 사용자에게 별도 경고를 띄운다.
 *
 * 참고: 본 목록은 mainnet 의 잘 알려진 배포본만 담는다. TTL 체인에는 Seaport 가
 * 없으나(domain.chainId 가드가 거른다), 위조 사이트가 동일 주소를 도메인에 박아
 * 사용자를 속이려 시도하는 경우를 막기 위해 표시 자체는 유지한다.
 */
export const KNOWN_SEAPORT_CONTRACTS: ReadonlySet<string> = new Set([
  '0x00000000006c3852cbef3e08e8df289169ede581', // Seaport 1.1
  '0x00000000000001ad428e4906ae43d8f9852d0dd6', // Seaport 1.4
  '0x00000000000000adc04c56bf30ac9d3c0aaf14dc', // Seaport 1.5
  '0x0000000000000068f116a894984e2db1123eb395', // Seaport 1.6
]);

/**
 * EIP-712 typed-data 의 위험 패턴 감지. UI 가 빨간/노란 배너를 띄울 때 사용.
 *   - 'permit': primaryType === 'Permit' (EIP-2612 토큰 권한 위임) — 매우 위험.
 *   - 'seaport': verifyingContract 가 알려진 Seaport — NFT/토큰 양도 위임.
 *   - 'unicode': primaryType / domain.name 에 비-ASCII 문자 포함 — 동형이의어 사기 우려.
 */
export type TypedDataRisk = 'permit' | 'seaport' | 'unicode';

export function detectTypedDataRisks(args: {
  primaryType: string;
  domainName?: string;
  verifyingContract?: string;
}): TypedDataRisk[] {
  const risks: TypedDataRisk[] = [];
  // Permit 류: EIP-2612 'Permit', EIP-2098 변종, Seaport 의 'OrderComponents' 도 포함.
  // 보수적으로 'Permit' 으로 시작 OR 'Order' 류는 별도 분기에서 잡는다.
  if (/^permit/i.test(args.primaryType)) risks.push('permit');
  const vc = args.verifyingContract?.toLowerCase();
  if (vc && KNOWN_SEAPORT_CONTRACTS.has(vc)) risks.push('seaport');
  // 비-ASCII 문자(코드포인트 ≥ 0x80) 검출 — Cyrillic 'і' 같은 동형이의어 차단.
  const hasNonAscii = (s: string | undefined): boolean => {
    if (!s) return false;
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) > 0x7e) return true;
    }
    return false;
  };
  if (hasNonAscii(args.primaryType) || hasNonAscii(args.domainName)) {
    risks.push('unicode');
  }
  return risks;
}
