// QrScanner.tsx — QR 캡처 계층 (안드로이드 셸).
//
// 디코드·파싱은 하지 않는다. 그건 shell-core 의 공용 모듈 몫이고, 셸마다
// 다른 것은 "프레임을 어디서 얻느냐" 뿐이기 때문이다. 여기서는 카메라 스트림과
// 파일 입력만 만들어 shell-core 의 runScanLoop 에 넘기고, 읽어낸 원문 문자열을
// 그대로 상위에 돌려준다 — 검증 없이 입력란에 넣지 않기 위해 판단은 상위가 한다.
//
// 스트림은 srcObject 로만 붙인다. blob: URL 을 만들면 다른 셸의 CSP 에 걸린다 —
// 캡처 코드가 셸마다 갈라지지 않게 그 전제를 여기서도 지킨다.
//
// 카메라는 거부·미지원이 정상 경로다(권한 거부, 카메라 없는 기기, secure
// context 아님). 그 경우 화면이 죽지 않고 이미지 파일 선택으로 내려간다.

import { useEffect, useRef, useState } from 'react';
import { cameraFrameSource, fileFrameSource, runScanLoop } from '@byeorin/shell-core';
import { useT } from '@byeorin/i18n/react';

export interface QrScannerProps {
  /** 읽어낸 QR 원문. 검증은 하지 않은 값이다. */
  onText: (text: string) => void;
  onClose: () => void;
}

export function QrScanner({ onText, onClose }: QrScannerProps) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // 카메라를 실제로 열어보기 전에는 가능 여부를 알 수 없다 — 'trying' 이 초기값.
  const [camera, setCamera] = useState<'trying' | 'live' | 'unavailable'>('trying');
  const [fileNote, setFileNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let controller: { stop(): void } | null = null;

    async function start(): Promise<void> {
      const md = navigator.mediaDevices;
      // isSecureContext 가 아니면 getUserMedia 자체가 없다 — 예외 대신 분기로 본다.
      if (!md || typeof md.getUserMedia !== 'function') {
        if (!cancelled) setCamera('unavailable');
        return;
      }
      try {
        // 후면 카메라 — QR 은 상대 화면·종이를 비추는 것이라 전면이면 쓸모없다.
        const stream = await md.getUserMedia({ video: { facingMode: 'environment' } });
        const video = videoRef.current;
        if (cancelled || !video) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        const source = cameraFrameSource(video, stream);
        video.muted = true;
        video.playsInline = true;
        await video.play().catch(() => undefined);
        setCamera('live');
        controller = runScanLoop(source, (text) => {
          if (!cancelled) onText(text);
        });
      } catch {
        // 권한 거부·장치 없음 모두 여기로 온다. 파일 경로가 남아 있으므로 실패가 아니다.
        if (!cancelled) setCamera('unavailable');
      }
    }

    void start();
    return () => {
      cancelled = true;
      controller?.stop();
    };
  }, [onText]);

  async function handleFile(file: File): Promise<void> {
    setFileNote(null);
    const source = fileFrameSource(file);
    await new Promise<void>((resolve) => {
      // 정지 이미지는 프레임이 한 장뿐이라 루프가 곧 끝난다. 못 읽으면 결과가
      // 오지 않으므로 첫 tick 이후를 직접 마감한다.
      // 타이머를 잡아 두지 않으면 인식 성공 뒤에도 1.5 초 뒤 "못 읽었다" 가
      // 덮어써진다 — 읽었는데 못 읽었다고 말하는 화면이 된다.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ctl = runScanLoop(source, (text) => {
        if (timer !== undefined) clearTimeout(timer);
        onText(text);
        resolve();
      });
      timer = setTimeout(() => {
        ctl.stop();
        setFileNote(t('scan.not_found'));
        resolve();
      }, 1500);
    });
  }

  return (
    <div className="card scan-pane">
      <p className="label">{t('scan.title')}</p>

      {camera !== 'unavailable' && (
        <video
          ref={videoRef}
          style={{ width: '100%', borderRadius: 8, background: '#000' }}
          muted
          playsInline
        />
      )}
      {camera === 'trying' && <p className="muted small">{t('scan.camera_starting')}</p>}
      {camera === 'live' && <p className="muted small">{t('scan.camera_hint')}</p>}
      {camera === 'unavailable' && <p className="muted small">{t('scan.camera_unavailable')}</p>}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void handleFile(f);
        }}
      />
      <button type="button" className="btn-ghost" onClick={() => fileRef.current?.click()}>
        {t('scan.pick_image')}
      </button>
      {fileNote !== null && <p className="error small">{fileNote}</p>}

      <button type="button" className="btn-ghost" onClick={onClose}>
        {t('common.cancel')}
      </button>
    </div>
  );
}
