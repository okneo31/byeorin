// 캡처 계층 — 프레임을 어디서 얻느냐만 셸마다 다르다. transport.ts 를
// ByteTransport 로 가른 것과 같은 수법: 계약만 여기 두고 구현은 셸이 준다.
// 카메라/파일 소스 구현도 순수 DOM 이라 여기 함께 둔다 — DOM 이 없는 환경에서는
// 호출되지 않으므로 import 만으로 깨지지 않게 전부 지연 접근한다.

import { decodeQr, type RawImageData } from './decode.js';

export interface QrFrameSource {
  /** 카메라/파일에서 한 프레임을 낸다. 아직 없으면 null. */
  grab(): Promise<RawImageData | null>;
  /** 자원 해제. 멱등. */
  close(): void;
}

export interface QrScanController {
  stop(): void;
}

export interface ScanLoopOptions {
  intervalMs?: number;
  onError?: (e: unknown) => void;
}

/**
 * 공용 스캔 루프. rAF 가 없는 환경(확장 백그라운드 문서 등)도 있으므로
 * setTimeout 기반으로 간다.
 */
export function runScanLoop(
  source: QrFrameSource,
  onResult: (text: string) => void,
  opts: ScanLoopOptions = {},
): QrScanController {
  const interval = opts.intervalMs ?? 200;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const frame = await source.grab();
      if (frame) {
        const text = decodeQr(frame);
        if (text !== null) {
          stop();
          onResult(text);
          return;
        }
      }
    } catch (e) {
      opts.onError?.(e);
    }
    if (!stopped) timer = setTimeout(() => void tick(), interval);
  };

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    source.close();
  }

  void tick();
  return { stop };
}

function drawToImageData(
  src: CanvasImageSource,
  w: number,
  h: number,
  canvas: HTMLCanvasElement | null,
): RawImageData | null {
  if (w <= 0 || h <= 0) return null;
  const c =
    canvas ??
    (typeof document !== 'undefined' ? document.createElement('canvas') : null);
  if (!c) return null;
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(src, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/** 카메라 프레임 소스. 스트림은 srcObject 로만 붙인다 — blob: URL 을 만들면 CSP 에 걸린다. */
export function cameraFrameSource(
  video: HTMLVideoElement,
  stream: MediaStream,
): QrFrameSource {
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  video.srcObject = stream;
  return {
    async grab() {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (w === 0 || h === 0) return null; // 아직 첫 프레임 전
      return drawToImageData(video, w, h, canvas);
    },
    close() {
      for (const t of stream.getTracks()) t.stop();
      video.srcObject = null;
    },
  };
}

/** 이미지 파일 소스. 한 번만 프레임을 낸다(정지 이미지이므로 재시도 의미 없음). */
export function fileFrameSource(file: Blob): QrFrameSource {
  let used = false;
  return {
    async grab() {
      if (used) return null;
      used = true;
      const g = globalThis as unknown as {
        createImageBitmap?: (b: Blob) => Promise<ImageBitmap>;
      };
      if (!g.createImageBitmap) return null;
      const bmp = await g.createImageBitmap(file);
      const out = drawToImageData(bmp as unknown as CanvasImageSource, bmp.width, bmp.height, null);
      bmp.close?.();
      return out;
    },
    close() {
      used = true;
    },
  };
}
