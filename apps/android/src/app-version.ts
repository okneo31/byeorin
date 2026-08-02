// app-version.ts — 지금 이 폰에 깔린 빌드가 무엇인지 화면에서 확인하기 위한 값.
//
// 왜 필요한가: 파일명(`벼린<버전>.apk`)이 버전을 담게 됐어도, 폰에 **이미 깔린**
// 빌드가 무엇인지는 파일을 봐서 알 수 없다. 실기기 테스트에서 "이거 새 빌드 맞나?"
// 를 매번 확인하려면 앱 자신이 답할 수 있어야 한다.
//
// 값 출처는 네이티브(build.gradle 의 versionName/versionCode) 이므로 웹 번들이
// 따로 버전을 들고 있을 필요가 없다 — 어긋날 여지를 없앤다.

import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

/** 예: "v0.5.1 (2)". 네이티브가 아니거나 조회 실패면 null. */
export async function getAppVersion(): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const info = await CapApp.getInfo();
    return `v${info.version} (${info.build})`;
  } catch {
    // 플러그인 미가용 — 버전 표시는 부가 정보라 조용히 생략한다.
    return null;
  }
}
