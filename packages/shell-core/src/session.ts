// 확장(MV3) 외 환경에서 본 패키지를 typecheck 하기 위한 최소 chrome 표면 타입.
// @types/chrome 를 본 패키지 의존성으로 들이지 않기 위해, ExtensionSessionStore
// 내부에서만 globalThis 를 통해 좁은 모양으로 접근한다. 본 타입은 export 되지
// 않으므로 다른 패키지의 @types/chrome 와 충돌하지 않는다.
interface ChromeSessionLike {
  storage: {
    session: {
      get: (key: string) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>;
      remove: (key: string) => Promise<void>;
    };
  };
}

function getChromeApi(): ChromeSessionLike {
  const c = (globalThis as { chrome?: ChromeSessionLike }).chrome;
  if (!c) {
    throw new Error(
      'ExtensionSessionStore: chrome.storage.session is unavailable in this runtime',
    );
  }
  return c;
}

/**
 * 셸 공용 세션 저장소 추상화.
 *
 * 4 개 앱(web / desktop / mobile / extension) 은 각자 세션 보관 시맨틱이 다르다.
 *  - web/desktop: 페이지 리로드 시 자동 복원 금지 (H1 보안 정책)
 *  - extension : chrome.storage.session — 브라우저 프로세스 수명 동안만 휘발
 *  - mobile    : 키체인 도입 전까지 메모리 한정
 *
 * 본 인터페이스는 위 차이를 캡슐화한다. WalletStore 는 SessionStore 한 개에만
 * 의존해 라이프사이클을 운영하고, 각 앱은 자기 환경에 맞는 구현체만 주입한다.
 */
export interface SessionStore {
  /** 저장된 니모닉을 반환한다. 없으면 null. */
  read(): Promise<string | null>;
  /** 니모닉을 저장한다. */
  write(mnemonic: string): Promise<void>;
  /** 저장된 니모닉을 삭제한다. */
  clear(): Promise<void>;
  /**
   * 앱 부팅 시 자동 복원(read 호출)을 허용하는지.
   * H1 정책: 사용자 명시 행동 없이 잠금 해제하면 안 되는 환경(web/desktop/mobile)은 false.
   * 확장(extension) 처럼 브라우저가 자동 복원 시점/생명주기를 통제하는 경우 true.
   */
  readonly autoRestoreAllowed: boolean;
}

/**
 * 웹/데스크톱용 세션 저장소.
 *
 * v0.1 정책: 페이지 리로드 시 자동 복원하지 않는다(autoRestoreAllowed=false).
 * sessionStorage 가 실제로 SPA 네비게이션 동안 살아있더라도, 보안 리뷰 H1 결론에
 * 따라 평문 니모닉을 디스크/스토리지 백킹 영역에 쓰지 않는다. 그래서 본 구현은
 * 모듈 메모리에만 보관한다.
 *
 * TODO(v0.2): passphrase 기반 암호화 키스토어가 도입되면 sessionStorage 에
 *   ciphertext 만 쓰고, 잠금 해제 시 사용자 입력 키로 복호화하는 흐름으로 전환한다.
 */
export class WebSessionStore implements SessionStore {
  readonly autoRestoreAllowed = false;
  private value: string | null = null;

  async read(): Promise<string | null> {
    return this.value;
  }

  async write(mnemonic: string): Promise<void> {
    this.value = mnemonic;
  }

  async clear(): Promise<void> {
    this.value = null;
  }
}

/**
 * 브라우저 확장(MV3) 용 세션 저장소.
 *
 * chrome.storage.session 은 service worker 와 popup 사이 공유 가능하고,
 * 브라우저 프로세스가 살아있는 동안만 유지된다(자동 휘발). 따라서 본 환경에서는
 * 자동 복원을 허용한다(autoRestoreAllowed=true).
 */
export class ExtensionSessionStore implements SessionStore {
  readonly autoRestoreAllowed = true;
  private readonly key: string;

  constructor(key: string = 'nd:mnemonic') {
    this.key = key;
  }

  async read(): Promise<string | null> {
    const out = await getChromeApi().storage.session.get(this.key);
    const v = out[this.key];
    return typeof v === 'string' ? v : null;
  }

  async write(mnemonic: string): Promise<void> {
    await getChromeApi().storage.session.set({ [this.key]: mnemonic });
  }

  async clear(): Promise<void> {
    await getChromeApi().storage.session.remove(this.key);
  }
}

/**
 * 메모리 한정 세션 저장소.
 *
 * 모바일에서 react-native-keychain 이 도입되기 전(v0.1) 기본값. 프로세스가 죽으면
 * 자동 잠금된다. autoRestoreAllowed=false — 키체인 도입 후에도 생체 인증 게이팅을
 * 필요로 하므로 자동 복원은 별도 정책 결정 시까지 막아둔다.
 */
export class MemorySessionStore implements SessionStore {
  readonly autoRestoreAllowed = false;
  private value: string | null = null;

  async read(): Promise<string | null> {
    return this.value;
  }

  async write(mnemonic: string): Promise<void> {
    this.value = mnemonic;
  }

  async clear(): Promise<void> {
    this.value = null;
  }
}
