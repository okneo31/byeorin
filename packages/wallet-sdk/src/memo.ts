// memo.ts — TTL 체인 메모의 인코딩과 판정.
//
// 메모는 별도 컨트랙트도 별도 tx 도 아니다. **평범한 송금 tx 의 data 필드에
// 들어가는 UTF-8 바이트**다. to=수신자 EOA, value=금액, data=0x+UTF-8(메모).
//
// 이 파일의 유일한 책임: **서버 인덱서(wallet-api/memo.js 의 parseMemo)와 같은
// 답을 내는 것.** 여기서 통과시킨 메모가 체인에서 memo:null 로 떨어지면
// 사용자는 "보냈는데 안 보인다" 를 겪는다. 반대로 여기서 막은 메모가 서버에서
// 통과하면 지갑이 쓸 수 있는 것을 못 쓰게 막은 것이다. 규칙을 여기서만 고친다.
//
// 의존성 0 (TextEncoder/TextDecoder 만). Buffer 를 쓰지 않는다 — 확장 MV3 ·
// Capacitor WebView 에 Buffer 가 없다. viem 도 쓰지 않는다 — 이 모듈은
// core.ts 배럴에 실리고, core 는 체인 라이브러리를 일절 끌지 않는 것이 존재
// 이유다(core.ts:1-13).
//
// 가스는 여기서 계산하지 않는다. 명세서 4절의 EIP-2028 식은 이 노드에서 틀렸다
// (실측: 2048 B 에서 문서 53,768 vs 실측 103,911 = 1.93배. 노드가 EIP-7623 로
// 매긴다). 가스는 data 를 포함한 estimateGas 결과만 쓴다 — chains/evm.ts:236.

import type { Hex } from './types.js';

/** 메모로 인정되는 최소 바이트 수. **글자 수가 아니라 UTF-8 바이트 수다.** */
export const MEMO_MIN_BYTES = 2;

/** 메모로 인정되는 최대 바이트 수. 넘으면 인덱서가 memo:null 로 떨군다. */
export const MEMO_MAX_BYTES = 2048;

/** 제어문자 중 유일하게 허용되는 셋 — 탭·개행·복귀. */
export const MEMO_ALLOWED_CONTROLS: readonly number[] = [0x09, 0x0a, 0x0d];

/** 메모가 거부된 사유. UI 는 이 코드로 문구를 고른다(문자열 비교 금지). */
export type MemoRejectReason =
  /** 입력이 비어 있다. 메모 없는 송금 — 오류가 아니라 data 를 아예 안 붙이는 경우. */
  | 'empty'
  /** 2 바이트 미만. ASCII 한 글자짜리 메모가 여기 걸린다. */
  | 'too-short'
  /** 2048 바이트 초과. */
  | 'too-long'
  /** trim() 후 비었다. 공백·탭·개행만 있는 메모. */
  | 'blank'
  /** 허용되지 않는 제어문자(\t \n \r 외)가 있다. */
  | 'control-char'
  /**
   * U+FFFD(대체 문자)가 실린다. 원문에 직접 있거나, 짝 없는 서로게이트가
   * UTF-8 인코딩 중 U+FFFD 로 바뀐 경우다. 둘 다 서버가 거부한다.
   */
  | 'replacement-char';

/** 메모 한 건의 판정 결과. UI 가 "몇 바이트 남았나"·"왜 거부됐나" 를 모두 여기서 읽는다. */
export interface MemoCheck {
  /** 이 텍스트를 메모로 실어도 서버가 메모로 인정하는가. */
  readonly ok: boolean;
  /** UTF-8 바이트 수. 글자 수가 아니다 — 한글 3, 이모지 4. */
  readonly byteLength: number;
  /** 남은 바이트 (MEMO_MAX_BYTES - byteLength). 초과하면 음수다. */
  readonly remaining: number;
  /** ok:false 일 때만. */
  readonly reason?: MemoRejectReason;
  /** control-char / replacement-char 일 때 문제가 된 코드포인트. UI 가 U+XXXX 로 보여줄 수 있게. */
  readonly offendingCodePoint?: number;
}

/** 규칙 위반. reason 을 들고 있어 UI 가 catch 해서 문구를 고를 수 있다. */
export class MemoError extends Error {
  readonly reason: MemoRejectReason;
  readonly check: MemoCheck;
  constructor(check: MemoCheck) {
    super(`memo: 규칙 위반 (${check.reason}, ${check.byteLength} 바이트)`);
    this.name = 'MemoError';
    this.reason = check.reason ?? 'empty';
    this.check = check;
  }
}

const encoder = /* @__PURE__ */ new TextEncoder();
// fatal:true 가 핵심이다. 없으면 기계 데이터가 U+FFFD 범벅 문자열로 디코드돼
// 화면에 쏟아진다.
const strictDecoder = /* @__PURE__ */ new TextDecoder('utf-8', { fatal: true });

/**
 * 허용되지 않는 코드포인트를 찾는다. 없으면 null.
 * 코드**포인트** 단위로 순회한다(for..of) — 서로게이트 쌍을 반쪽씩 보지 않기 위해서다.
 */
function findForbiddenCodePoint(text: string): number | null {
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    if (MEMO_ALLOWED_CONTROLS.includes(c)) continue; // tab, LF, CR
    // C0 제어문자 · DEL · C1 제어문자(U+0080–U+009F) · 대체 문자.
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0xfffd) return c;
  }
  return null;
}

function bytesToHexString(bytes: Uint8Array): Hex {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i] as number).toString(16).padStart(2, '0');
  }
  return `0x${out}` as Hex;
}

function hexStringToBytes(body: string): Uint8Array {
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** 이 텍스트의 UTF-8 바이트 수. 입력칸 카운터용 — 판정은 validateMemo 가 한다. */
export function memoByteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * 메모 판정. 예외를 던지지 않는다 — 입력칸이 타이핑마다 부를 함수다.
 *
 * 명세서 3절 encodeMemo 는 원문 문자열만 검사하지만, 여기서는 **인코딩한
 * 바이트를 되읽어서** 검사한다. 이유: 짝 없는 서로게이트('\uD800')를
 * TextEncoder 가 조용히 U+FFFD(EF BF BD) 로 바꾼다. 원문에는 U+FFFD 가 없으니
 * 원문만 보면 통과하지만, 체인에 실리는 바이트에는 U+FFFD 가 있어 서버
 * parseMemo 가 거부한다. 서버는 체인 바이트를 보므로 우리도 바이트를 본다.
 */
export function validateMemo(text: string): MemoCheck {
  const bytes = encoder.encode(text);
  const byteLength = bytes.length;
  const remaining = MEMO_MAX_BYTES - byteLength;
  const reject = (reason: MemoRejectReason, cp?: number): MemoCheck => ({
    ok: false,
    byteLength,
    remaining,
    reason,
    ...(cp === undefined ? {} : { offendingCodePoint: cp }),
  });

  if (byteLength === 0) return reject('empty');
  if (byteLength < MEMO_MIN_BYTES) return reject('too-short');
  if (byteLength > MEMO_MAX_BYTES) return reject('too-long');
  if (text.trim().length === 0) return reject('blank');

  // encoder 가 낸 바이트라 항상 유효 UTF-8 이다. decode 는 던지지 않는다.
  const roundTrip = strictDecoder.decode(bytes);
  const bad = findForbiddenCodePoint(roundTrip);
  if (bad !== null) return reject(bad === 0xfffd ? 'replacement-char' : 'control-char', bad);

  return { ok: true, byteLength, remaining };
}

/**
 * 메모 문자열 → tx.data 에 넣을 hex. 규칙 위반이면 MemoError 를 던진다.
 *
 * **빈 문자열도 던진다.** 메모칸이 비면 이 함수를 부르지 말고 data 를 아예 넣지
 * 마라 — 빈 '0x' 도 넣지 않는다(명세서 7절). 부르는 쪽에서 `text.length > 0` 로
 * 먼저 갈라라.
 */
export function encodeMemo(text: string): Hex {
  const check = validateMemo(text);
  if (!check.ok) throw new MemoError(check);
  return bytesToHexString(encoder.encode(text));
}

/**
 * tx.data hex → 메모 텍스트. 메모가 아니면 **null**(빈 문자열이 아니다).
 *
 * scan.ttl1.top/api/tx 의 원본 data 를 표시할 때 쓴다. api.ttl1.top 의 memo
 * 필드는 이미 서버가 디코드한 텍스트라 이 함수를 거칠 필요가 없다.
 * (api 응답의 input_data 는 74자에서 잘리므로 여기에 넣지 마라 — 명세서 7절.)
 */
export function decodeMemo(hex: string | null | undefined): string | null {
  if (typeof hex !== 'string') return null;
  // 0x 접두 + 짝수 길이 + hex 문자만. 명세서 3절은 문자 종류를 안 보지만, 비-hex
  // 문자는 parseInt 에서 NaN → 0x00 바이트로 둔갑해 조용히 다른 답을 낸다.
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(hex)) return null;

  const bytes = hexStringToBytes(hex.slice(2));
  if (bytes.length < MEMO_MIN_BYTES || bytes.length > MEMO_MAX_BYTES) return null;

  let text: string;
  try {
    text = strictDecoder.decode(bytes); // fatal:true — 깨진 바이트 하나면 여기서 throw
  } catch {
    return null;
  }
  if (text.trim().length === 0) return null;
  if (findForbiddenCodePoint(text) !== null) return null;
  return text;
}

/** 표시용 조각. React 는 text 를 그대로 렌더하고 link 만 <a> 로 감싼다. */
export type MemoSegment =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'link'; readonly value: string };

/**
 * 메모를 텍스트/링크 조각으로 나눈다. **HTML 을 만들지 않는다.**
 *
 * 메모는 체인에서 온 임의 문자열이다 — 누구든 tx 하나로 무엇이든 써 넣는다.
 * 문자열로 HTML 을 조립해 innerHTML/dangerouslySetInnerHTML 에 넣으면 그 사람이
 * 벼린 사용자 모두의 화면에서 스크립트를 돌린다(명세서 6절). React 로 텍스트를
 * 렌더하면 이스케이프는 프레임워크가 하므로, 여기서는 링크 분리만 한다.
 * http/https 만 링크로 만든다 — javascript: 는 대상이 아니다.
 */
export function splitMemoLinks(text: string): MemoSegment[] {
  const out: MemoSegment[] = [];
  const re = /https?:\/\/[^\s<]+/g;
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > last) out.push({ kind: 'text', value: text.slice(last, m.index) });
    out.push({ kind: 'link', value: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) });
  return out;
}
