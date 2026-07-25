package top.ttl1.byeorin;

import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * WebView 원격 디버깅을 **디버그 빌드에서만** 켠다.
     *
     * 왜 필요한가: capacitor.config.ts 의 `webContentsDebuggingEnabled` 는 빌드
     * 타입을 구분하지 않는다. true 로 두면 release APK 에서도 devtools 소켓
     * (`webview_devtools_remote_<pid>`) 이 열린다 — 실제로 release 빌드에
     * Chrome DevTools Protocol 로 붙어 확인했다.
     *
     * 지갑에서 이건 그냥 넘길 문제가 아니다. 단말에 USB 디버깅이 켜져 있고
     * adb 가 닿는 상황이면, 잠금 해제된 동안 JS 힙에 있는 평문 시드를 읽거나
     * 임의 스크립트를 주입할 수 있다. 물리적 접근 + 디버깅 허용이라는 전제가
     * 붙긴 하지만, 막는 비용이 이 세 줄뿐이라 막지 않을 이유가 없다.
     *
     * BuildConfig.DEBUG 로 갈라 두면 디버그 APK 의 진단 능력은 그대로 유지된다.
     * super.onCreate 뒤에 호출해야 Capacitor 브리지가 설정한 값을 덮어쓴다.
     */
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
    }
}
