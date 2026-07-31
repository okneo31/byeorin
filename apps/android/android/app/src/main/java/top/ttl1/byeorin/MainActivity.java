package top.ttl1.byeorin;

import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 로컬 플러그인은 브리지가 뜨기 전에 등록해야 웹 레이어에서 즉시 보인다.
        registerPlugin(VaultCryptoPlugin.class);
        registerPlugin(TcpSocketPlugin.class);

        super.onCreate(savedInstanceState);

        /*
         * WebView 원격 디버깅을 디버그 빌드에서만 켠다.
         *
         * capacitor.config.ts 의 `webContentsDebuggingEnabled` 는 빌드 타입을
         * 구분하지 않아, true 로 두면 release APK 에서도 devtools 소켓이 열린다
         * (실제로 release 빌드에 CDP 로 붙어 확인했다). 지갑에서는 잠금 해제 중인
         * 평문 시드가 JS 힙에 있으므로 막아야 한다. super.onCreate 뒤에 호출해야
         * Capacitor 브리지가 설정한 값을 덮어쓴다.
         */
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
    }
}
