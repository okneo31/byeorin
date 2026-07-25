// hw-connect — Ledger 연결 페이지 React app.
//
// URL: chrome-extension://<id>/hw-connect.html?app=solana   (또는 cosmos)
//
// 흐름:
//   1) URL 의 ?app 파라미터로 초기 앱 선택 (solana / cosmos). 사용자가 변경 가능.
//   2) "Ledger 연결" 클릭 → WebHidTransport.open() → chooser → 디바이스 선택
//   3) HwSigner 로 derivationPath 에 해당하는 publicKey 추출 → 표시
//   4) chrome.storage.session 에 'nd:hw-account' 키로 결과 저장
//   5) popup 이 storage change 를 listen 해서 HW 카드 갱신
//   6) "닫기" 버튼 또는 자동 window.close()

import { useEffect, useMemo, useState } from 'react';
import {
  HwSigner,
  WebHidTransport,
  type HwAppName,
} from '@byeorin/wallet-sdk/core';

// popup 의 wallet-service 가 정의한 storage 형태와 동기화. address 는 표시용
// (현재는 pubkey hex preview — v0.5 에서 chain-aware 주소로 채워질 예정).
interface HwAccountStored {
  appName: HwAppName;
  address: string;
  derivationPath: string;
  publicKeyHex: string;
  connectedAt: number;
}

const STORAGE_KEY = 'nd:hw-account';

const DEFAULT_PATHS: Record<HwAppName, string> = {
  solana: "m/44'/501'/0'/0'",
  cosmos: "m/44'/118'/0'/0/0",
};

function bytesToHex(bytes: Uint8Array): string {
  let s = '0x';
  for (let i = 0; i < bytes.length; i++) {
    s += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return s;
}

function shorten(s: string, head = 10, tail = 8): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'connected'; result: HwAccountStored }
  | { kind: 'error'; message: string; raw?: string; errorName?: string };

function parseInitialAppFromUrl(): HwAppName {
  try {
    const p = new URLSearchParams(window.location.search);
    const v = p.get('app');
    if (v === 'cosmos' || v === 'solana') return v;
  } catch {
    // ignore
  }
  return 'solana';
}

export function App() {
  const [appName, setAppName] = useState<HwAppName>(parseInitialAppFromUrl());
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const path = useMemo(() => DEFAULT_PATHS[appName], [appName]);

  // 페이지가 떠 있는 동안 ledger 모듈을 prefetch 해두면 사용자 click 시점의
  // 첫 await 가 캐시 hit 으로 즉시 resolve — gesture chain 보존.
  useEffect(() => {
    void WebHidTransport;
  }, []);

  async function connect(): Promise<void> {
    setStatus({ kind: 'connecting' });
    // eslint-disable-next-line no-console
    console.log('[hw-connect] step 1: WebHidTransport.open(forceRequest:true)');
    let transport;
    try {
      transport = await WebHidTransport.open({ forceRequest: true });
      // eslint-disable-next-line no-console
      console.log('[hw-connect] step 2: transport opened', transport);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[hw-connect] transport open failed:', e);
      const errorName = e instanceof Error ? e.constructor.name : typeof e;
      const raw = e instanceof Error ? e.message : String(e);
      // raw 메시지를 우선 그대로 보여주고, 그 아래에 친절 안내를 덧붙인다.
      // (이전엔 너무 일찍 친절 메시지로만 가려서 어디가 막힌 건지 진단이 어려웠다.)
      const isLikelyDeviceMissing =
        raw.includes("reading 'open'") ||
        raw.toLowerCase().includes('no device') ||
        raw.toLowerCase().includes('cancel');
      setStatus({
        kind: 'error',
        errorName,
        raw,
        message: isLikelyDeviceMissing
          ? 'Ledger 디바이스를 찾지 못했거나 선택을 취소했습니다. USB 연결과 ' +
            '잠금 해제, 해당 앱(Solana/Cosmos) 실행을 확인하고 다시 시도해 주세요.'
          : '연결 실패 — 아래 raw 에러 메시지로 원인 진단이 필요합니다.',
      });
      return;
    }

    try {
      // eslint-disable-next-line no-console
      console.log('[hw-connect] step 3: building HwSigner');
      const signer = new HwSigner({ transport, appName, derivationPath: path });
      // eslint-disable-next-line no-console
      console.log('[hw-connect] step 4: requesting publicKey');
      const publicKey = await signer.publicKey();
      // eslint-disable-next-line no-console
      console.log('[hw-connect] step 5: publicKey received', publicKey);
      const result: HwAccountStored = {
        appName,
        address: bytesToHex(publicKey).slice(0, 22),
        derivationPath: path,
        publicKeyHex: bytesToHex(publicKey),
        connectedAt: Date.now(),
      };
      try {
        await chrome.storage.session.set({ [STORAGE_KEY]: result });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[hw-connect] storage.session.set failed:', e);
      }
      setStatus({ kind: 'connected', result });
      try {
        await transport.close();
      } catch {
        // ignore
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[hw-connect] publicKey failed:', e);
      try {
        await transport.close();
      } catch {
        // ignore
      }
      const errorName = e instanceof Error ? e.constructor.name : typeof e;
      const raw = e instanceof Error ? e.message : String(e);
      setStatus({
        kind: 'error',
        errorName,
        raw,
        message:
          '디바이스 연결까지는 됐지만 공개 키 요청 단계에서 실패했습니다. ' +
          `(Ledger 의 ${appName === 'solana' ? 'Solana' : 'Cosmos'} 앱이 ` +
          '실제로 열려 있는지, 같은 앱을 다른 프로그램이 점유하지 않는지 확인하세요.)',
      });
    }
  }

  /**
   * 이미 권한 부여된 HID 디바이스 조회 (`navigator.hid.getDevices()`).
   * user gesture 불필요 + chooser 안 뜸. Chrome 이 OS 레벨에서 Ledger 를
   * 인식하고 있는지 자체를 본다.
   */
  async function diagnoseAllHid(): Promise<void> {
    setStatus({ kind: 'connecting' });
    try {
      const hid = (navigator as {
        hid?: {
          getDevices: () => Promise<unknown[]>;
          requestDevice: (opts: unknown) => Promise<unknown[]>;
        };
      }).hid;
      if (!hid) {
        setStatus({
          kind: 'error',
          errorName: 'EnvironmentError',
          raw: 'navigator.hid is undefined',
          message: 'WebHID API 가 없습니다.',
        });
        return;
      }
      // 1) 이미 권한 부여된 디바이스 (Chrome 이 OS 레벨에서 보고 있는 것)
      const known = (await hid.getDevices()) as Array<{
        productName?: string;
        vendorId?: number;
        productId?: number;
      }>;
      // 2) Ledger 의 알려진 모든 vendorId 로 chooser 호출 (현재는 0x2c97 만).
      //    `filters: [{}]` 빈 객체는 Chrome 이 거부하므로 vendorId 명시.
      const devices = (await hid.requestDevice({
        filters: [{ vendorId: 0x2c97 }],
      })) as Array<{
        productName?: string;
        vendorId?: number;
        productId?: number;
      }>;
      if (devices.length === 0 && known.length === 0) {
        setStatus({
          kind: 'error',
          errorName: 'NoLedgerOnSystem',
          raw:
            `getDevices() returned []. requestDevice(vendorId:0x2c97) returned []. ` +
            `Chrome 이 시스템에서 Ledger 를 보지 못함.`,
          message:
            '⚠ Chrome 이 OS 측에서 Ledger 자체를 인식 못 합니다. 코드 문제가 ' +
            '아닙니다. 다음을 순서대로 시도해 주세요:\n' +
            '① Windows 작업 관리자에서 Ledger Live 와 LedgerLive Bridge 프로세스 전부 종료\n' +
            '② Ledger USB 케이블을 다른 포트에 다시 꽂기 (USB-A 권장, hub 거치지 말 것)\n' +
            '③ Ledger 디바이스 재시작 (전원 종료 후 다시 켜기)\n' +
            '④ chrome://device-log/ 페이지를 열어 USB 인식 이벤트 확인\n' +
            '⑤ Chrome 자체 재시작\n' +
            '⑥ chrome://settings/content/hidDevices 에서 이 사이트가 차단 목록에 있는지 확인',
        });
        return;
      }
      const list = devices.length > 0 ? devices : known;
      const summary = list
        .map(
          (d, i) =>
            `[${i}] ${d.productName ?? '?'} · vendorId=0x${(d.vendorId ?? 0).toString(16)} ` +
            `productId=0x${(d.productId ?? 0).toString(16)}`,
        )
        .join('\n');
      const headline = devices.length > 0
        ? `✓ Ledger 인식 OK (${devices.length}개) — chooser 에서 선택한 디바이스:`
        : `✓ 이미 권한 부여된 Ledger ${known.length}개 발견 (chooser 결과는 빈 배열):`;
      setStatus({
        kind: 'error',
        errorName: 'DiagnoseOK',
        raw: summary,
        message:
          headline +
          ' 디바이스 자체는 잡혔으니 이제 일반 "Ledger 연결" 을 다시 눌러보세요. ' +
          '여전히 실패하면 디바이스 위의 앱(Solana/Cosmos)이 실제로 열려있는지 확인 (홈 화면 X).',
      });
    } catch (e) {
      const errorName = e instanceof Error ? e.constructor.name : typeof e;
      const raw = e instanceof Error ? e.message : String(e);
      setStatus({ kind: 'error', errorName, raw, message: '진단 실패.' });
    }
  }

  /**
   * Ledger transport 우회 — navigator.hid.requestDevice 를 직접 호출해 chooser 가
   * 뜨는지, 디바이스가 잡히는지 자체를 확인. WebHID API 자체의 문제인지
   * vs. Ledger 모듈/앱 문제인지 가른다.
   *
   * 결과는 chrome.storage 에 저장하지 않음 — 순수 진단 용도.
   */
  async function diagnoseRawHid(): Promise<void> {
    setStatus({ kind: 'connecting' });
    // eslint-disable-next-line no-console
    console.log('[hw-connect] raw hid diagnose: navigator.hid =', (navigator as { hid?: unknown }).hid);
    try {
      const hid = (navigator as { hid?: { requestDevice: (opts: unknown) => Promise<unknown[]> } }).hid;
      if (!hid) {
        setStatus({
          kind: 'error',
          errorName: 'EnvironmentError',
          raw: 'navigator.hid is undefined',
          message: 'WebHID API 를 사용할 수 없습니다. Chrome 89+ / Edge 90+ 가 필요합니다.',
        });
        return;
      }
      // Ledger Vendor ID: 0x2c97. filter 없이 호출하면 모든 HID 디바이스 노출.
      const devices = (await hid.requestDevice({
        filters: [{ vendorId: 0x2c97 }],
      })) as Array<{ productName?: string; vendorId?: number; productId?: number }>;
      // eslint-disable-next-line no-console
      console.log('[hw-connect] raw hid devices:', devices);
      if (devices.length === 0) {
        setStatus({
          kind: 'error',
          errorName: 'NoDeviceSelected',
          raw: `requestDevice returned [] (chooser 가 떴지만 사용자가 디바이스를 선택하지 않았거나 디바이스 없음). filter=vendorId 0x2c97 (Ledger)`,
          message:
            '디바이스 선택창은 떴지만 디바이스가 선택되지 않았습니다. ' +
            'chooser 에 Ledger 가 보였나요? 안 보였다면 USB 인식 자체가 ' +
            '안 되는 상태(케이블/허브/Ledger Live 점유 등).',
        });
        return;
      }
      const d = devices[0]!;
      setStatus({
        kind: 'error',
        errorName: 'DiagnoseOK',
        raw: `requestDevice OK: productName=${d.productName ?? '?'}, vendorId=0x${(d.vendorId ?? 0).toString(16)}, productId=0x${(d.productId ?? 0).toString(16)}`,
        message:
          '✓ 원시 HID 진단 성공 — Chrome 의 WebHID 와 Ledger 인식은 정상입니다. ' +
          '즉 실제 문제는 Ledger transport 측. 이제 위쪽 "Ledger 연결" 을 다시 ' +
          '눌러 보고 raw 에러를 확인하세요.',
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[hw-connect] raw hid diagnose failed:', e);
      const errorName = e instanceof Error ? e.constructor.name : typeof e;
      const raw = e instanceof Error ? e.message : String(e);
      setStatus({
        kind: 'error',
        errorName,
        raw,
        message:
          '원시 HID 호출 자체가 실패. 이건 Chrome WebHID API 또는 사용자 ' +
          'cancel 입니다 (Ledger 코드와 무관).',
      });
    }
  }

  function closeWindow(): void {
    window.close();
  }

  return (
    <main className="hw-root">
      <header className="hw-header">
        <img
          className="hw-header__mark"
          src="/icon/48.png"
          width={32}
          height={32}
          alt="벼린"
        />
        <h1 className="hw-header__title">하드웨어 월릿 연결</h1>
      </header>

      <section className="hw-card">
        <h2 className="hw-section-title">Ledger 앱 선택</h2>
        <p className="hw-lead">
          Ledger 디바이스에서 어떤 앱을 열어두셨나요? 선택한 앱과 같은 파생 경로의
          공개 키를 가져옵니다. v0.4 는 주소 확인만 — 실제 서명은 v0.5 에서 활성화됩니다.
        </p>

        <div className="hw-app-select" role="radiogroup" aria-label="Ledger 앱">
          <button
            type="button"
            className={
              appName === 'solana'
                ? 'hw-app-option hw-app-option--active'
                : 'hw-app-option'
            }
            onClick={() => setAppName('solana')}
            disabled={status.kind === 'connecting'}
          >
            Solana
          </button>
          <button
            type="button"
            className={
              appName === 'cosmos'
                ? 'hw-app-option hw-app-option--active'
                : 'hw-app-option'
            }
            onClick={() => setAppName('cosmos')}
            disabled={status.kind === 'connecting'}
          >
            Cosmos
          </button>
        </div>

        <p className="hw-meta">파생 경로: {path}</p>
      </section>

      <section className="hw-card">
        <h2 className="hw-section-title">연결 전 체크리스트</h2>
        <ul className="hw-checklist">
          <li>① Ledger 를 USB 에 연결</li>
          <li>② 디바이스 잠금 해제 (PIN 입력)</li>
          <li>③ Ledger Live 가 켜져있다면 종료 (앱 점유 충돌 방지)</li>
          <li>④ 디바이스에서 위에 고른 앱({appName === 'solana' ? 'Solana' : 'Cosmos'})을 열어두기</li>
        </ul>

        {status.kind === 'idle' && (
          <button className="hw-btn-primary" onClick={() => { void connect(); }}>
            Ledger 연결
          </button>
        )}

        {status.kind === 'connecting' && (
          <>
            <div className="hw-status hw-status--info">
              Chrome 의 디바이스 선택창이 떴는지 확인하세요. 디바이스를 고르면
              자동으로 다음 단계로 진행합니다.
            </div>
            <button className="hw-btn-primary" disabled>
              연결 중…
            </button>
          </>
        )}

        {status.kind === 'connected' && (
          <>
            <div className="hw-status hw-status--ok">
              Ledger 연결 성공. 결과가 팝업으로 전달되었습니다.
            </div>
            <p className="hw-meta">
              앱: {status.result.appName} · 경로: {status.result.derivationPath}
            </p>
            <p className="hw-meta">공개 키 (preview)</p>
            <div className="hw-addr" title={status.result.publicKeyHex}>
              {shorten(status.result.publicKeyHex, 18, 14)}
            </div>
            <button className="hw-btn-primary" onClick={closeWindow}>
              닫기
            </button>
          </>
        )}

        {status.kind === 'error' && (
          <>
            <div className="hw-status hw-status--error">{status.message}</div>
            {status.raw && (
              <>
                <p className="hw-meta">
                  raw error · type: <code>{status.errorName ?? '?'}</code>
                </p>
                <div className="hw-addr">{status.raw}</div>
              </>
            )}
            <button className="hw-btn-primary" onClick={() => { void connect(); }}>
              다시 시도
            </button>
            <button className="hw-btn-ghost" onClick={() => { void diagnoseRawHid(); }}>
              원시 HID 진단 (Ledger filter)
            </button>
            <button className="hw-btn-ghost" onClick={() => { void diagnoseAllHid(); }}>
              Ledger 인식 진단 (OS 레벨 확인)
            </button>
            <button className="hw-btn-ghost" onClick={closeWindow}>
              취소
            </button>
          </>
        )}
      </section>
    </main>
  );
}
