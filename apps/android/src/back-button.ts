// back-button.ts — 안드로이드 하드웨어/제스처 뒤로가기 처리.
//
// WebView 앱의 기본 동작은 "히스토리가 없으면 앱 종료" 다. 우리 셸은 라우터
// 없이 mode 상태 하나로 화면을 바꾸므로 히스토리가 늘 비어 있고, 결과적으로
// 송금 화면에서 뒤로가기를 누르면 앱이 그냥 꺼진다. 지갑에서는 특히 나쁜
// 동작이라 — 사용자는 "취소" 를 의도했는데 앱이 종료되고 잠기기까지 한다 —
// 뒤로가기를 셸의 화면 스택으로 연결한다.
//
// 규칙: 홈이 아니면 홈으로, 홈이면 앱 종료(안드로이드 관습).

import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

export function installBackButton(opts: {
  /** 홈 화면인지. false 면 뒤로가기가 홈 복귀로 소비된다. */
  isHome: () => boolean;
  /** 홈으로 되돌리기. */
  goHome: () => void;
}): () => void {
  if (!Capacitor.isNativePlatform()) return () => {};

  const listener = CapApp.addListener('backButton', () => {
    if (!opts.isHome()) {
      opts.goHome();
      return;
    }
    void CapApp.exitApp();
  });

  return () => {
    void listener.then((l) => l.remove());
  };
}
