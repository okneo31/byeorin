// 노동자의 지갑 — 4-byte 셀렉터 디코더.
//
// EIP-1193 의 eth_sendTransaction 이 data 를 동반할 때, confirm popup 이 사용자에게
// "어떤 함수가 호출되는지" 를 보여주기 위한 최소한의 휴리스틱.
//
// 본 모듈은 ABI 디코딩을 하지 않는다 — 셀렉터(4바이트) 만 인식해 사람이 읽을 수 있는
// 시그니처 문자열로 매핑한다. 미상 셀렉터는 그대로 hex 로 보여주고 "알 수 없는 함수
// 호출" 라벨을 붙인다.
//
// 표는 보수적으로 ERC-20 / ERC-721 / ERC-1155 의 가장 흔한 진입점만 담는다.
// (전체 4byte.directory 와의 연동은 v0.4 의 transaction-insight 항목으로 미룬다.)

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
  if (h.length < 2 + 8) return null;
  const selector = h.slice(0, 10);
  // hex 문자만 허용.
  if (!/^0x[0-9a-f]{8}$/.test(selector)) return null;
  const sig = SELECTOR_TABLE[selector] ?? null;
  return { selector, signature: sig };
}
