// QrScanField.tsx — 확장 popup 의 QR 읽기 입구.
//
// **이미지 파일만** 받는다. popup 은 포커스를 잃는 순간 문서째 파괴되는데,
// 카메라 권한 프롬프트가 바로 그 포커스를 가져간다 — 실시간 스캔을 넣으면
// 사용자에게는 "누르면 창이 닫히는 고장" 으로 보인다. 파일 입력은 OS 다이얼로그가
// 뜨는 동안에도 popup 이 살아 있는 경로라 확장에서 성립하는 유일한 기본값이다.
// (카메라를 별도 탭으로 여는 우회로가 있으나 새 entrypoint 가 필요해 이번 범위 밖.)
//
// 디코딩·파싱·주소검증은 전부 shell-core 공용 모듈이 한다 — 셸은 "프레임을
// 어디서 얻느냐" 만 책임진다. 검증을 건너뛸 수 없게 parseScanned 가 관문이다.

import { useRef, useState } from 'react';
import { decodeQrAuto, parseScanned, type ScanErrorCode, type ScanResult } from '@byeorin/shell-core';
import type { ChainKey } from '@byeorin/wallet-sdk/multichain';
import { useT } from '@byeorin/i18n/react';

export interface QrScanFieldProps {
  /** 현재 선택 체인 — 스캔값이 이 체인의 주소 형식과 맞는지 검사한다. */
  chainKey: string;
  /** 검증을 통과한 결과만 올라온다. */
  onScan: (result: ScanResult) => void;
  disabled?: boolean;
}

export function QrScanField({ chainKey, onScan, disabled = false }: QrScanFieldProps) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function errorText(code: ScanErrorCode): string {
    // 카탈로그 키는 점 표기(scan.error.bad_address)다. 코드의 하이픈만 맞춘다.
    return t(`scan.error.${code.replace(/-/g, '_')}`, { chain: chainKey });
  }

  async function handleFile(file: File | null): Promise<void> {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const text = await decodeQrAuto(file);
      if (text === null) {
        setError(t('scan.not_found'));
        return;
      }
      const parsed = parseScanned(text, chainKey as ChainKey);
      if (!parsed.ok) {
        setError(errorText(parsed.code));
        return;
      }
      onScan(parsed);
    } catch {
      setError(t('scan.file_failed'));
    } finally {
      setBusy(false);
      // 같은 파일을 다시 골라도 change 가 오게 비운다.
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          void handleFile(e.target.files?.[0] ?? null);
        }}
      />
      <button
        type="button"
        className="btn-ghost"
        disabled={disabled || busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? t('scan.file_reading') : t('scan.file_button')}
      </button>
      {error !== null && <p className="error small">{error}</p>}
    </>
  );
}
