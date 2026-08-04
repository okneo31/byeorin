import { useEffect, useRef, useState } from 'react';
import {
  cameraFrameSource,
  decodeQrAuto,
  runScanLoop,
  type QrScanController,
} from '@byeorin/shell-core';
import { Button } from '@byeorin/design-system';
import { useT } from '@byeorin/i18n/react';

// QR 스캔 모달 — 캡처만 담당한다. 디코드·파싱·주소검증은 shell-core 의 공용
// 모듈이 하고, 여기서는 읽은 문자열만 위로 올린다(셸마다 다른 것은 캡처뿐이라서).
//
// 웹은 secure context(https/localhost)에서만 카메라가 열린다. 아니면 카메라
// 버튼을 아예 내린다 — 눌러도 안 되는 버튼은 두지 않는다.
// 스트림은 srcObject 로만 붙인다(blob: URL 을 만들면 CSP 를 건드리게 된다).

interface Props {
  onDetected: (text: string) => void;
  onClose: () => void;
}

export function QrScanModal({ onDetected, onClose }: Props) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const ctlRef = useRef<QrScanController | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const secure =
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia;
  const cameraPossible =
    typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  // 모달이 사라질 때 스트림이 남으면 카메라 표시등이 계속 켜져 있다.
  useEffect(() => {
    return () => {
      ctlRef.current?.stop();
      ctlRef.current = null;
    };
  }, []);

  const stopCamera = () => {
    ctlRef.current?.stop();
    ctlRef.current = null;
    setCamera(false);
    setBusy(null);
  };

  const startCamera = async () => {
    setError(null);
    if (!cameraPossible) {
      setError(t('scan.camera_unavailable'));
      return;
    }
    if (!secure) {
      setError(t('scan.camera_insecure'));
      return;
    }
    setBusy(t('scan.camera_starting'));
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      const video = videoRef.current;
      if (!video) {
        for (const tr of stream.getTracks()) tr.stop();
        setBusy(null);
        return;
      }
      setCamera(true);
      setBusy(null);
      const src = cameraFrameSource(video, stream);
      await video.play().catch(() => undefined);
      ctlRef.current = runScanLoop(src, (text) => {
        ctlRef.current = null;
        setCamera(false);
        onDetected(text);
      });
    } catch (e) {
      setCamera(false);
      setBusy(null);
      const name = e instanceof Error ? e.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setError(t('scan.camera_denied'));
      } else {
        setError(
          t('scan.camera_failed', { reason: name || t('scan.camera_unavailable') }),
        );
      }
    }
  };

  const readFile = async (file: File) => {
    setError(null);
    setBusy(t('scan.file_reading'));
    try {
      const text = await decodeQrAuto(file);
      setBusy(null);
      if (text === null) setError(t('scan.not_found'));
      else {
        stopCamera();
        onDetected(text);
      }
    } catch {
      setBusy(null);
      setError(t('scan.file_failed'));
    }
  };

  return (
    <div className="nd-modal" role="dialog" aria-modal="true">
      <div className="nd-modal__sheet">
        <h2 className="nd-h2">{t('scan.title')}</h2>
        <p className="nd-lead">{t('scan.lead')}</p>

        <div className="web-scan__stage">
          {/* playsInline 이 없으면 iOS Safari 가 전체화면 재생으로 가로챈다. */}
          <video
            ref={videoRef}
            className="web-scan__video"
            muted
            playsInline
            style={{ display: camera ? 'block' : 'none' }}
          />
          {!camera && (
            <p className="web-scan__hint">
              {busy ?? t('scan.file_hint')}
            </p>
          )}
        </div>
        {camera && <p className="web-scan__hint">{t('scan.camera_hint')}</p>}

        {error && <div className="nd-error">{error}</div>}

        {secure &&
          cameraPossible &&
          (camera ? (
            <Button
              variant="ghost"
              className="nd-button--block"
              onClick={stopCamera}
            >
              {t('scan.camera_stop')}
            </Button>
          ) : (
            <Button
              variant="primary"
              className="nd-button--block"
              onClick={() => void startCamera()}
              disabled={busy !== null}
            >
              {t('scan.camera_start')}
            </Button>
          ))}

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void readFile(f);
          }}
        />
        <Button
          variant="ghost"
          className="nd-button--block"
          onClick={() => fileRef.current?.click()}
          disabled={busy !== null}
        >
          {t('scan.file_button')}
        </Button>

        <Button
          variant="ghost"
          className="nd-button--block"
          onClick={() => {
            stopCamera();
            onClose();
          }}
        >
          {t('scan.cancel')}
        </Button>
      </div>
    </div>
  );
}
