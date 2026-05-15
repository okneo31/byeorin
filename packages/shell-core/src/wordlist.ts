/**
 * 입력된 니모닉이 한국어 BIP39 워드리스트인지 영어 워드리스트인지 휴리스틱으로 판정한다.
 *
 * 정규식 `[가-힣]` 는 한글 음절 블록(AC00–D7A3) 전체를 커버한다. 이전 구현은
 * 유니코드 코드포인트 `힯` (D7AF) 까지 포함하는 잘못된 범위(`[가-힯]`)를 썼는데,
 * 이는 한글 자모 확장 영역 일부를 잡으면서도 표준 BIP39 한국어 워드리스트 전체를
 * 정확히 커버한다는 의미상 우연일 뿐이므로 표준 음절 범위로 교정한다.
 *
 * 정책 (concern #5):
 *  - 모든 단어가 한글 음절로만 구성되어 있으면 'korean'.
 *  - 모든 단어가 영문 소문자(BIP39 영어 워드리스트 도메인)로만 구성되어 있으면 'english'.
 *  - 한 단어 내부에서 한/영이 섞이거나, 단어 단위로 한/영이 혼재하면 throw.
 *    isValidMnemonic 이 한참 뒤에 막연한 "invalid mnemonic" 으로 실패하는 것보다
 *    사용자에게 더 친절한 에러를 즉시 던지는 편이 낫다.
 */

const HANGUL_SYLLABLE = /^[가-힣]+$/u;
const ASCII_LOWER = /^[a-z]+$/u;

export function detectWordlist(input: string): 'english' | 'korean' {
  const words = input.trim().split(/\s+/u).filter((w) => w.length > 0);
  if (words.length === 0) {
    // 빈 입력은 영어로 보내 isValidMnemonic 이 일관된 메시지로 거부하게 한다.
    return 'english';
  }

  let korean = 0;
  let english = 0;
  for (const w of words) {
    if (HANGUL_SYLLABLE.test(w)) {
      korean++;
    } else if (ASCII_LOWER.test(w)) {
      english++;
    } else {
      // 한 단어 안에 섞여있거나 다른 스크립트가 들어가 있음.
      throw new Error('단어가 한국어/영어 워드리스트와 일치하지 않습니다');
    }
  }

  if (korean > 0 && english > 0) {
    throw new Error('단어가 한국어/영어 워드리스트와 일치하지 않습니다');
  }
  return korean > 0 ? 'korean' : 'english';
}
