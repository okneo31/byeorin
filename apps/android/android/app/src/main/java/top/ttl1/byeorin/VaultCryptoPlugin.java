package top.ttl1.byeorin;

import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * VaultCrypto — 금고 blob 을 기기 밖으로 나갈 수 없는 키로 한 겹 더 감싼다.
 *
 * 왜 필요한가.
 *   기존 금고는 `AES-GCM(scrypt(비밀번호))` 한 겹이라, localStorage 파일만
 *   빼내면 공격자가 자기 장비에서 마음껏 비밀번호를 대입할 수 있었다. 방어선이
 *   scrypt 비용 하나뿐이라 시간과 GPU 를 들이면 뚫린다.
 *
 *   여기서 만드는 키는 AndroidKeyStore 안에서 생성되고 **한 번도 칩 밖으로
 *   나오지 않는다**. 앱조차 키 바이트를 볼 수 없고 "이거 암호화/복호화 해줘" 라고
 *   요청만 할 수 있다. 따라서 blob 을 통째로 떠가도 그 폰이 아니면 복호화를
 *   시작조차 못 한다 — 오프라인 대입이라는 공격 경로 자체가 사라진다.
 *
 * 무엇을 막지 못하는가 (과장하지 않기 위해 명시한다).
 *   - 폰을 쥐고, 잠금을 풀고, 우리 앱으로 코드를 실행할 수 있는 공격자.
 *     이 경우 TEE 에 복호화를 요청할 수 있으므로 다시 scrypt 대입 싸움이 된다.
 *     다만 폰 한 대에서, 우리가 정한 KDF 비용으로만 가능하다.
 *   - 잠금 해제된 동안 메모리에 있는 평문 시드.
 *
 * 사용자 인증 요구(setUserAuthenticationRequired)는 켜지 않았다. 켜면 생체 재등록
 * 이나 화면잠금 해제만으로 키가 무효화돼 금고를 못 여는 사고가 난다. 복구 문구가
 * 있으면 살아나지만, 그 대가를 사용자 동의 없이 기본값으로 둘 수는 없다.
 * (켤 준비는 되어 있다 — GEN 스펙에 한 줄 추가하면 된다.)
 */
@CapacitorPlugin(name = "VaultCrypto")
public class VaultCryptoPlugin extends Plugin {

    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String ALIAS = "byeorin.vault.hw.v1";
    private static final String TRANSFORM = "AES/GCM/NoPadding";
    private static final int GCM_TAG_BITS = 128;
    private static final int IV_BYTES = 12;

    /** 이 기기에서 하드웨어 래핑이 가능한지. 실패 시 셸이 이유를 알 수 있게 메시지도 준다. */
    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            getOrCreateKey();
            ret.put("available", true);
            ret.put("strongBox", strongBoxBacked);
        } catch (Exception e) {
            ret.put("available", false);
            ret.put("reason", String.valueOf(e.getMessage()));
        }
        call.resolve(ret);
    }

    /** 평문 문자열 → base64(iv) / base64(ciphertext). */
    @PluginMethod
    public void wrap(PluginCall call) {
        String data = call.getString("data");
        if (data == null) {
            call.reject("data is required");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
            byte[] ct = cipher.doFinal(data.getBytes("UTF-8"));
            JSObject ret = new JSObject();
            ret.put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP));
            ret.put("ct", Base64.encodeToString(ct, Base64.NO_WRAP));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("wrap failed: " + e.getMessage(), e);
        }
    }

    /** base64(iv) + base64(ciphertext) → 평문 문자열. */
    @PluginMethod
    public void unwrap(PluginCall call) {
        String ivB64 = call.getString("iv");
        String ctB64 = call.getString("ct");
        if (ivB64 == null || ctB64 == null) {
            call.reject("iv and ct are required");
            return;
        }
        try {
            byte[] iv = Base64.decode(ivB64, Base64.NO_WRAP);
            byte[] ct = Base64.decode(ctB64, Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(GCM_TAG_BITS, iv));
            JSObject ret = new JSObject();
            ret.put("data", new String(cipher.doFinal(ct), "UTF-8"));
            call.resolve(ret);
        } catch (Exception e) {
            // 키가 사라졌거나(앱 데이터 삭제) 변조된 경우 여기로 온다.
            call.reject("unwrap failed: " + e.getMessage(), e);
        }
    }

    private boolean strongBoxBacked = false;

    /**
     * 별칭으로 키를 찾고 없으면 만든다.
     *
     * StrongBox(전용 보안 칩)를 먼저 시도하고, 미지원 단말이면 TEE 로 떨어진다.
     * StrongBox 가 없다고 실패시키면 다수 단말에서 앱이 못 돌아간다 — 둘 다
     * "키가 칩 밖으로 안 나온다" 는 성질은 동일하다.
     */
    private SecretKey getOrCreateKey() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        KeyStore.Entry entry = ks.getEntry(ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                SecretKey k = generate(true);
                strongBoxBacked = true;
                return k;
            } catch (Exception ignored) {
                // StrongBox 미탑재 — TEE 로 폴백.
            }
        }
        strongBoxBacked = false;
        return generate(false);
    }

    private SecretKey generate(boolean strongBox) throws Exception {
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(
                ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                // 매 wrap 마다 새 IV 를 시스템이 생성하게 한다 (IV 재사용은 GCM 에서 치명적).
                .setRandomizedEncryptionRequired(true);
        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            b.setIsStrongBoxBacked(true);
        }
        gen.init(b.build());
        return gen.generateKey();
    }
}
