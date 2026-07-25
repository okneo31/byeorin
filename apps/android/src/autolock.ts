// autolock.ts — 백그라운드 체류 시간 기반 자동 잠금.
//
// 잠금 해제된 동안 평문 시드는 JS 힙에 있다. 앱을 내려둔 채 단말을 잃어버리는
// 상황이 가장 현실적인 노출 경로이므로, 백그라운드에 일정 시간 이상 머물면
// 복귀 시 잠근다.
//
// 왜 "백그라운드 진입 즉시" 가 아닌가: 송금 중 QR 을 찍으러 카메라 앱을 잠깐
// 열거나 알림을 확인하는 정상 흐름까지 잠가버리면 사용성이 무너진다. 유예를
// 두되 짧게(기본 2분) 잡는다.
//
// Capacitor 의 appStateChange 는 네이티브 신호라 WebView 가 얼어붙은 뒤에도
// 정확하다. 웹(vite dev)에서는 플러그인이 없으므로 visibilitychange 로 폴백한다.

import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

/** 백그라운드 허용 시간. 이 시간을 넘겨 복귀하면 잠근다. */
export const AUTOLOCK_GRACE_MS = 2 * 60 * 1000;

/**
 * 자동 잠금을 설치한다. 해제 함수를 반환.
 *
 * @param shouldLock 현재 잠금 해제 상태인지 (잠겨 있으면 아무 것도 안 한다)
 * @param onLock     잠금 실행 — 셸의 lock 핸들러
 * @param onSuspend  백그라운드 진입 시점 훅 — 대기 중인 저장을 확정하는 데 쓴다
 */
export function installAutoLock(opts: {
  shouldLock: () => boolean;
  onLock: () => void;
  onSuspend?: () => void;
}): () => void {
  let backgroundedAt: number | null = null;

  const handle = (active: boolean): void => {
    if (!active) {
      backgroundedAt = Date.now();
      opts.onSuspend?.();
      return;
    }
    const since = backgroundedAt;
    backgroundedAt = null;
    if (since === null) return;
    if (Date.now() - since >= AUTOLOCK_GRACE_MS && opts.shouldLock()) {
      opts.onLock();
    }
  };

  if (Capacitor.isNativePlatform()) {
    const listener = CapApp.addListener('appStateChange', ({ isActive }) => {
      handle(isActive);
    });
    return () => {
      void listener.then((l) => l.remove());
    };
  }

  const onVisibility = (): void => {
    handle(document.visibilityState === 'visible');
  };
  document.addEventListener('visibilitychange', onVisibility);
  return () => document.removeEventListener('visibilitychange', onVisibility);
}
