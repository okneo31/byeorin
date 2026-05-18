// 데스크톱 — 하드웨어 월릿(Ledger) 뷰.
//
// v0.4 범위:
//   - Solana / Cosmos 만 지원 (Ledger 앱이 임의 메시지 서명을 지원)
//   - EVM(TTL) 은 Ledger Eth 앱이 raw RLP tx 를 요구하므로 v0.5 로 이연
//   - BTC 는 PSBT v2 흐름이 필요해 v0.5 로 이연
//
// 권한 흐름:
//   1) 사용자가 "Ledger 연결" 클릭 → user gesture
//   2) Tauri webview 가 WebHID chooser 표시 → Ledger Nano 선택
//   3) 디바이스에서 해당 앱(Solana/Cosmos) 이 열려 있어야 함
//   4) Ledger 화면의 "주소 확인" 프롬프트 → 사용자 양손 버튼 승인
//
// 본 화면은 unlocked 여부와 무관하게 사용 가능 — 소프트 월릿 없이 HW 단독으로도
// 자산 조회/이체 흐름에 진입할 수 있다 (단, v0.4 에서는 *연결 표시* 만 한다).

import { useEffect, useState } from 'react';
import type { HwAppName } from '@byeorin/wallet-sdk';
import { AddressDisplay, Button, Card } from '@byeorin/design-system';
import { useT } from '@byeorin/i18n/react';
import {
  connectHardware,
  disconnectHardware,
  getHwAccount,
  subscribeHwState,
  type HwAccountState,
} from '../wallet-store.js';

export function Hardware() {
  const t = useT();
  const [hw, setHw] = useState<HwAccountState | null>(getHwAccount());
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => subscribeHwState(setHw), []);

  const connect = (appName: HwAppName) => {
    setError(null);
    setBusy(true);
    void (async () => {
      try {
        await connectHardware(appName);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    })();
  };

  const disconnect = () => {
    setBusy(true);
    void (async () => {
      try {
        await disconnectHardware();
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className="nd-view">
      <header className="nd-view__header">
        <h1 className="nd-h1">{t('hw.label.title')}</h1>
        <p className="nd-lead">
          {t('hw.lead_desktop')}
        </p>
      </header>

      {hw ? (
        <Card as="section">
          <div className="nd-label">{t('hw.connected_label', { appName: hw.appName.toUpperCase() })}</div>
          <AddressDisplay address={hw.address} head={8} tail={6} />
          <div className="nd-muted" style={{ marginTop: 8 }}>
            {t('hw.derivation_path_long', { path: hw.derivationPath })}
          </div>
          <div className="nd-row" style={{ marginTop: 16 }}>
            <Button variant="secondary" onClick={disconnect} disabled={busy}>
              {busy ? t('hw.disconnecting') : t('hw.disconnect')}
            </Button>
          </div>
        </Card>
      ) : (
        <Card as="section">
          <div className="nd-label">{t('hw.connect_label')}</div>
          <Button
            variant="primary"
            className="nd-button--block"
            onClick={() => connect('solana')}
            disabled={busy}
          >
            {busy ? t('hw.connecting') : t('hw.connect.solana_short')}
          </Button>
          <div style={{ height: 10 }} />
          <Button
            variant="secondary"
            className="nd-button--block"
            onClick={() => connect('cosmos')}
            disabled={busy}
          >
            {busy ? t('hw.connecting') : t('hw.connect.cosmos')}
          </Button>
          {error && (
            <div className="nd-error" style={{ marginTop: 12 }}>
              {error}
            </div>
          )}
          <div className="nd-muted" style={{ marginTop: 12 }}>
            {t('hw.evm_btc_v05_note')}
          </div>
        </Card>
      )}
    </div>
  );
}
