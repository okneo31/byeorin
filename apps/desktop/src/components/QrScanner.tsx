import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cameraFrameSource,
  fileFrameSource,
  decodeQrAuto,
  parseScanned,
  runScanLoop,
  type QrScanController,
  type ScanError,
  type ScanResult,
} from '@byeorin/shell-core';
import type { ChainKey } from '@byeorin/wallet-sdk/multichain';
import { Button, Card } from '@byeorin/design-system';
import { useT } from '@byeorin/i18n/react';

interface Props {
  /** 스캔값을 검증할 기준 체인. 데스크톱 셸은 TTL 단일이지만 값으로 받는다. */
  chain: ChainKey;
  onResult: (result: ScanResult) => void;
  onClose: () => void;
}

/**
 * PC 는 카메라가 없는 경우가 흔하므로 이미지 파일을 기본 경로로 두고,
 * videoinput 장치가 실제로 잡힐 때만 실시간 버튼을 노출한다.
 *
 * MediaStream 은 srcObject 로만 붙이고 blob: URL 을 만들지 않는다 —
 * Tauri CSP(default-src 'self') 를 건드리지 않기 위한 제약이다.
 */
export function QrScanner({ chain, onResult, onClose }: Props) {
  const t = useT();
  const tx = useCallback(
    (key: string, fallback: string, vars?: Record<string, string>) => {
      const s = t(key, vars);
      if (s !== key) return s;
      // 카탈로그에 키가 아직 없을 때 키 문자열이 화면에 노출되는 것을 막는다.
      return vars ? fallback.replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? '') : fallback;
    },
    [t],
  );

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const loopRef = useRef<QrScanController | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [hasCamera, setHasCamera] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const secure = typeof window !== 'undefined' && window.isSecureContext;

  useEffect(() => {
    let cancelled = false;
    if (!secure || !navigator.mediaDevices?.enumerateDevices) return;
    void navigator.mediaDevices
      .enumerateDevices()
      .then((list) => {
        if (!cancelled) setHasCamera(list.some((d) => d.kind === 'videoinput'));
      })
      .catch(() => {
        /* 장치 열거 실패는 "카메라 없음" 과 같게 다룬다 */
      });
    return () => {
      cancelled = true;
    };
  }, [secure]);

  const stopCamera = useCallback(() => {
    loopRef.current?.stop();
    loopRef.current = null;
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  const handle = useCallback(
    (text: string) => {
      const r: ScanResult | ScanError = parseScanned(text, chain);
      if (!r.ok) {
        setError(scanErrorText(tx, r));
        return;
      }
      setError(null);
      onResult(r);
    },
    [chain, onResult, tx],
  );

  const startCamera = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        stream.getTracks().forEach((tr) => tr.stop());
        return;
      }
      setCameraOn(true);
      const source = cameraFrameSource(video, stream);
      loopRef.current = runScanLoop(source, (text) => {
        stopCamera();
        handle(text);
      });
    } catch (e) {
      stopCamera();
      setError(
        tx('scan.camera_failed', '카메라를 열지 못했습니다. ({reason})', {
          reason: e instanceof Error ? e.name : String(e),
        }),
      );
    }
  };

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const source = fileFrameSource(file);
      const frame = await source.grab();
      source.close();
      const text = frame ? await decodeQrAuto(frame) : null;
      if (!text) {
        setError(tx('scan.not_found', 'QR 을 찾지 못했습니다. 다른 이미지를 고르세요.'));
        return;
      }
      handle(text);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card as="section" style={{ marginTop: 16 }}>
      <div className="nd-label">{tx('scan.title', 'QR 스캔')}</div>

      <p className="nd-lead" style={{ marginTop: 4 }}>
        {tx('scan.lead', '주소가 담긴 QR 이미지 파일을 고르세요. 카메라가 있으면 실시간 스캔도 됩니다.')}
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        <Button variant="primary" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? tx('scan.file_reading', '이미지를 읽는 중…') : tx('scan.file_button', '이미지 파일 선택')}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            void pickFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />

        {hasCamera &&
          (cameraOn ? (
            <Button variant="secondary" onClick={stopCamera}>
              {tx('scan.camera_stop', '카메라 끄기')}
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => void startCamera()}>
              {tx('scan.camera_start', '카메라로 스캔')}
            </Button>
          ))}

        <Button variant="ghost" onClick={onClose}>
          {tx('scan.cancel', '취소')}
        </Button>
      </div>

      {!secure && (
        <div className="nd-error" style={{ marginTop: 12 }}>
          {tx('scan.camera_insecure', '보안 연결이 아니라 카메라를 열 수 없습니다. 이미지 파일로 스캔하세요.')}
        </div>
      )}

      <video
        ref={videoRef}
        playsInline
        muted
        style={{
          display: cameraOn ? 'block' : 'none',
          width: '100%',
          maxWidth: 420,
          marginTop: 12,
          borderRadius: 8,
          background: '#000',
        }}
      />

      {error && (
        <div className="nd-error" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
    </Card>
  );
}

/** 스캔 실패 코드는 돈 보내는 자리의 경고이므로 원문을 함께 보여 준다. */
function scanErrorText(
  tx: (k: string, f: string, v?: Record<string, string>) => string,
  e: ScanError,
): string {
  const map: Record<string, [string, string]> = {
    empty: ['scan.error.empty', '내용이 비어 있습니다.'],
    'unsupported-scheme': ['scan.error.unsupported_scheme', '지원하지 않는 형식입니다. 입력란에 넣지 않았습니다.'],
    'required-param': ['scan.error.required_param', '지갑이 모르는 필수 항목을 요구하는 QR 입니다.'],
    'bad-amount': ['scan.error.bad_amount', '금액을 읽을 수 없습니다.'],
    'bad-address': ['scan.error.bad_address', '주소 형식이 아닙니다.'],
    'chain-mismatch': ['scan.error.chain_mismatch', '{chain} 의 주소 형식이 아닙니다.'],
  };
  const [key, fallback] = map[e.code] ?? ['scan.error.unsupported_scheme', '사용할 수 없는 값입니다.'];
  return `${tx(key, fallback, { chain: 'TTL' })} — ${e.text.slice(0, 120)}`;
}
