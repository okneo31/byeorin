// errors.ts — shell-core 가 던지는 에러의 안정적인 코드 + 영어 메시지.
//
// 정책:
//  - SDK 는 번역의 주인이 아니다. throw 하는 메시지는 영어 baseline 으로만 둔다.
//  - 호출자(앱) 가 `error.code` 를 i18n 키로 변환해 사용자 언어로 보여준다.
//    예: catch (e) { showError(t(`errors.${(e as ShellError).code}`)); }
//  - 메시지는 영어 baseline 이지만 e.message 도 그대로 노출 가능 — 개발자/로그 친화.
//
// 코드 네이밍:
//   {scope}.{cause}
//   scope: wallet | mnemonic | wordlist | keystore
//   cause: locked | already_unlocked | invalid | mixed_characters | ...

/** shell-core 에서 throw 되는 에러 코드 (i18n 키 `errors.<code>` 와 1:1). */
export type ShellErrorCode =
  | 'wallet.locked'
  | 'wallet.already_unlocked'
  | 'mnemonic.invalid'
  | 'wordlist.mixed_characters'
  | 'keystore.invalid_passphrase'
  | 'keystore.unsupported_version'
  | 'keystore.unsupported_kdf'
  | 'keystore.passphrase_required'
  | 'keystore.corrupt_blob'
  | 'keystore.webcrypto_unavailable'
  // 다중 계정 관리
  | 'account.not_found'           // idx out of range
  | 'account.kind_mismatch'       // exportMnemonic 을 privateKey 계정에 호출, 등
  | 'account.last_cannot_remove'  // 마지막 계정 제거 시도 (lock() 을 쓰라)
  | 'account.duplicate'           // 동일 시크릿이 이미 추가되어 있음
  | 'privateKey.invalid';         // hex 길이/문자/range 위반

/** shell-core 가 던지는 도메인 에러. `code` 로 사용자 언어 매핑. */
export class ShellError extends Error {
  readonly code: ShellErrorCode;
  constructor(code: ShellErrorCode, message: string) {
    super(message);
    this.name = 'ShellError';
    this.code = code;
  }
}

/** 짧은 헬퍼 — 시그니처 일관성을 위해. */
export function shellError(code: ShellErrorCode, message: string): ShellError {
  return new ShellError(code, message);
}

/**
 * 알 수 없는 throw 값을 ShellError 로 정규화하지는 않는다 — 호출자가
 * `e instanceof ShellError` 로 분기하면 충분. 본 유틸은 단지 코드 추출용.
 */
export function shellErrorCode(e: unknown): ShellErrorCode | undefined {
  return e instanceof ShellError ? e.code : undefined;
}
