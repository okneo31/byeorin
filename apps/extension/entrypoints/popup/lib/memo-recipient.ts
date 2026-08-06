// memo-recipient.ts — 받는 주소가 EOA 인지 컨트랙트인지 미리 본다.
//
// **왜 셸에 이런 게 있나.** 메모는 평범한 송금 tx 의 data 에 실리는 UTF-8
// 바이트다. 받는 쪽이 컨트랙트면 그 바이트가 함수 호출로 해석된다 — 메모 앞
// 4바이트가 우연히 어떤 selector 와 겹치면 의도치 않은 함수가 불린다.
// SDK 의 EvmAdapter 가 buildTransfer 안에서 이미 막지만(evm.ts:231
// assertEoaRecipient), 그건 **서명 직전**이다. 사용자가 메모를 다 쓰고 확인
// 화면까지 간 뒤에 거절당하는 것보다, 입력 중에 미리 알려주는 편이 낫다.
// 여기서 통과해도 최종 판단은 어댑터가 다시 한다 — 이 화면은 안내일 뿐이다.
//
// **RPC 접근 방식.** EvmAdapter 의 `client`(viem PublicClient) 는 private 이고
// SDK 는 아직 공개 getCode 를 내지 않는다. background.ts:225-228 이 읽기 전용
// RPC passthrough 에서 쓰는 것과 **같은 우회**를 그대로 쓴다(unknown 경유
// 캐스팅). SDK 가 읽기 전용 헬퍼를 노출하면 이 파일은 지운다.
//
// 호출 빈도는 부르는 쪽이 책임진다 — 타자마다 부르지 마라(SendPane 은 디바운스
// 뒤에만 부른다).

/** 받는 주소의 정체. 확인 실패는 이 타입에 없다 — 실패는 throw 로 올라간다. */
export type RecipientKind = 'eoa' | 'contract';

/** viem PublicClient 중 여기서 쓰는 표면만. '0x' 는 undefined 로 온다(viem 2.55). */
type CodeReader = {
  getCode(args: { address: `0x${string}` }): Promise<string | undefined>;
};

/**
 * `eth_getCode` 한 번. 코드가 비면 EOA, 있으면 컨트랙트.
 *
 * 실패하면 던진다. **모르는 것을 EOA 로 추정하지 않는다** — 추정이 틀리면
 * 메모 바이트가 컨트랙트 함수 호출이 된다. 모르면 화면이 "확인하지 못했다" 고
 * 말하는 쪽이 맞다.
 */
export async function probeRecipientKind(
  adapter: unknown,
  address: string,
): Promise<RecipientKind> {
  const client = (adapter as { client?: unknown }).client as CodeReader | undefined;
  if (!client || typeof client.getCode !== 'function') {
    throw new Error('memo-recipient: 이 어댑터에서 eth_getCode 를 부를 수 없다');
  }
  const code = await client.getCode({ address: address as `0x${string}` });
  return code === undefined || code === '0x' ? 'eoa' : 'contract';
}
