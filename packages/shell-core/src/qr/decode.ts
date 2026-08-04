// QR 디코드 — 이미지 한 장 → 문자열.
//
// 캡처(셸마다 다름)와 디코드(공용)를 가르기 위한 계층. 여기는 "이미 ImageData 가
// 손에 있다" 는 지점부터만 책임진다. BarcodeDetector 는 크롬 계열에만 있으므로
// 있으면 쓰고 없으면 jsQR 로 떨어진다 — 셸이 이 분기를 하지 않게 하려고 모듈
// 안에 가둔다.

import jsQR from 'jsqr';

export interface DecodeOptions {
  /** 반전(흰바탕/검바탕) 시도 여부. 기본 'attemptBoth'. */
  inversion?: 'dontInvert' | 'onlyInvert' | 'attemptBoth';
}

/** ImageData 의 최소 구조 — node 테스트처럼 DOM 클래스가 없는 곳에서도 쓰기 위함. */
export interface RawImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** 동기 경로. 순수 JS(jsQR) 라 어느 셸에서도 동일하게 돈다. */
export function decodeQr(image: RawImageData, opts: DecodeOptions = {}): string | null {
  if (!image || image.width <= 0 || image.height <= 0) return null;
  const r = jsQR(image.data, image.width, image.height, {
    inversionAttempts: opts.inversion ?? 'attemptBoth',
  });
  return r ? r.data : null;
}

// lib.dom 에 BarcodeDetector 타입이 없다. 추가 @types 의존을 두지 않으려고
// 필요한 최소 표면만 여기서 선언한다.
interface BarcodeDetectorLike {
  detect(source: unknown): Promise<Array<{ rawValue: string }>>;
}
interface BarcodeDetectorCtor {
  new (init?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

function nativeCtor(): BarcodeDetectorCtor | null {
  const g = globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor };
  return typeof g.BarcodeDetector === 'function' ? g.BarcodeDetector : null;
}

export function hasNativeDetector(): boolean {
  return nativeCtor() !== null;
}

/**
 * 네이티브 우선 경로. 네이티브가 없거나 던지거나 못 찾으면 jsQR 로 떨어진다.
 * Blob/ImageBitmap 은 네이티브가 직접 먹고, jsQR 폴백을 위해서만 캔버스를 거친다.
 */
export async function decodeQrAuto(
  source: RawImageData | ImageBitmap | Blob,
  opts: DecodeOptions = {},
): Promise<string | null> {
  const Ctor = nativeCtor();
  if (Ctor) {
    try {
      const det = new Ctor({ formats: ['qr_code'] });
      const found = await det.detect(isRawImage(source) ? await toBitmap(source) : source);
      if (found.length > 0 && found[0]!.rawValue) return found[0]!.rawValue;
    } catch {
      // 네이티브 실패는 폴백으로 흡수한다 — 사용자에게 보일 오류가 아니다.
    }
  }
  const img = isRawImage(source) ? source : await toImageData(source);
  return img ? decodeQr(img, opts) : null;
}

function isRawImage(s: unknown): s is RawImageData {
  return !!s && typeof s === 'object' && 'data' in (s as object) && 'width' in (s as object);
}

async function toBitmap(img: RawImageData): Promise<unknown> {
  // 네이티브 detector 는 ImageData 를 직접 받으므로 그대로 넘긴다.
  return img;
}

/** Blob/ImageBitmap → ImageData. 캔버스가 없는 환경(worker 무지원 등)이면 null. */
export async function toImageData(source: ImageBitmap | Blob): Promise<RawImageData | null> {
  const g = globalThis as unknown as {
    createImageBitmap?: (b: Blob) => Promise<ImageBitmap>;
    OffscreenCanvas?: new (w: number, h: number) => OffscreenCanvas;
    document?: Document;
  };
  let bmp: ImageBitmap;
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    if (!g.createImageBitmap) return null;
    bmp = await g.createImageBitmap(source);
  } else {
    bmp = source as ImageBitmap;
  }
  const w = bmp.width;
  const h = bmp.height;
  if (g.OffscreenCanvas) {
    const c = new g.OffscreenCanvas(w, h);
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.drawImage(bmp as unknown as CanvasImageSource, 0, 0);
    return ctx.getImageData(0, 0, w, h);
  }
  if (g.document) {
    const c = g.document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bmp as unknown as CanvasImageSource, 0, 0);
    return ctx.getImageData(0, 0, w, h);
  }
  return null;
}
