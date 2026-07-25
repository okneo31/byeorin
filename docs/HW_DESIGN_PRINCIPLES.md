# 벼린 자체 HW 월릿 — 설계 원칙

> 작성: 2026-05-31 · ZION swap 슬라이스(v0.4) 검증 중 Ledger Nano S WebHID 연결 실패에서 얻은 교훈을 v0.7+ 자체 HW 월릿 설계 원칙으로 정리.

## 1. 배경 — Ledger 사건의 진단

ZION swap E2E 검증 도중, 사용자의 Ledger Nano S(펌웨어 2.1.0)가 Chrome·Edge 양쪽에서 WebHID 로 연결되지 않는 현상이 관찰됨.

### 1.1 진단 결과

Chrome `chrome://device-log/`:

```
HID device added: vendorId=11415 (0x2c97), productId=4113 (0x1011),
  name='Nano S', serial='0001'
SetupDiGetDeviceProperty({{A45C254E-...}, 6}) failed: 요소가 없습니다. (0x490)
USB device function updated ... driver='WINUSB'
```

- Windows 의 SetupDi API 가 디바이스의 특정 property 를 못 찾음 (0x490 = `ERROR_NOT_FOUND`)
- 디바이스의 일부 interface 가 **WinUSB** driver 로 mounted

브라우저 WebHID API 호출 결과:

```
navigator.hid.getDevices() → []
navigator.hid.requestDevice({ filters: [{ vendorId: 0x2c97 }] }) → []
```

즉 OS 레벨에서는 HID 디바이스로 인식되었으나 Chrome/Edge 의 WebHID API enumeration 에서 **사라진** 상태.

### 1.2 근본 원인

**Ledger Live 가 일부 interface 를 WinUSB driver 로 잡고, 제거 후에도 driver 잔재가 Windows 에 남아 Chrome WebHID 의 HID class enumeration 을 막는** Windows-Ledger 조합의 알려진 함정.

증거:

- 시도한 모든 일반 trouble-shooting 무효: Ledger Live 종료 (작업 관리자 강제 종료), Chrome 재시작, extension 재로드, USB 재연결, 디바이스 재시작, 펌웨어 최신 확인 (2.1.0)
- Edge 에서도 동일 — 브라우저 차이가 아님
- Nano S 펌웨어 2.1.0 의 "Browser support" 옵션은 메뉴에서 제거되어 자동 ON 상태가 정상 (펌웨어 2.0 까지의 toggle 옵션이 2.1.0 에서 사라짐)

### 1.3 우리 코드·Chrome WebHID 책임 아님

같은 PC 에서 MetaMask · Phantom · Rabby 등 다른 wallet extension 들도 동일 증상을 보일 것 (Ledger 와 Windows 의 관계가 원인). Chrome WebHID 자체는 매우 안정된 API 이며, **Ledger Live 가 한 번도 설치된 적 없는 깨끗한 Windows 환경 또는 macOS/Linux** 에서는 같은 Ledger Nano S 가 정상 동작한다.

---

## 2. 자체 HW 월릿 설계 원칙 (v0.7+)

이번 사건의 원인이 "Ledger 가 Windows 드라이버 모델과 맺은 특정 관계" 이므로, **우리 자체 HW 가 같은 패턴을 답습하지 않으면 같은 문제가 없다**. 다음 4 원칙을 manifest·USB 펌웨어·desktop transport layer 설계 시점에 명시한다.

### 원칙 1 — 순수 HID class 만 (composite + WinUSB 회피)

Ledger 의 USB 디바이스는 HID + WinUSB 의 composite. 이게 Windows 가 일부 interface 를 WinUSB driver 로 잡게 만들고, Chrome WebHID 의 HID 클래스 enumeration 에서 사라지게 함.

**우리의 결정:**

- 자체 HW 는 **표준 HID class 1개 interface 만** 노출한다.
- composite USB device 회피.
- 별도 driver 설치 불필요 → Windows 기본 HID driver 가 자동 인식.

### 원칙 2 — Bridge process 없음 (background USB 점유 회피)

Ledger Live Bridge, Phantom Helper 같은 native bridge process 가 background 에서 USB 를 점유하면 다른 process(우리 wallet extension)가 같은 디바이스에 접근 못한다. 사용자가 명시 종료하지 않으면 점유 지속.

**우리의 결정:**

- bridge process **0개**. Chrome WebHID 가 디바이스에 직접 붙는다.
- 사용자 설치 마찰 0.
- 진단·디버깅도 단순 (점유 충돌이 구조적으로 없음).

### 원칙 3 — Transport 다중화 (단일 채널 의존 끊기)

WebHID 한 채널만 의존하면 이번 사건처럼 그 채널이 막혔을 때 전체 실패. 다층 안전망이 필요.

**우리의 결정 (우선순위):**

| 순위 | Transport | 적용 환경 | 비용 |
|------|-----------|---------|------|
| 1차 | **WebHID** | 데스크톱 Chrome/Edge (대다수 사용자) | 0 (기본) |
| 2차 | **WebUSB** | 1차 실패 시 fallback | manifest 한 줄 |
| 3차 | **BLE (Bluetooth LE)** | 모바일 + 무선 (선택) | 펌웨어 추가 |
| 최후 | **Native bridge** | 모든 web API 실패 시 | 사용자 설치 마찰 큼, 권장 X |

특히 1+2 동시 노출 (WebHID + WebUSB) 은 manifest 한 줄 비용으로 큰 robustness 제공.

### 원칙 4 — 다중 OS · 다중 driver-state 테스트

Windows USB 스택의 잔재(이전 driver 흔적)는 가장 흔한 함정. 자체 HW 의 v0.1 부터 다음 4 환경에서 정합성 검증:

1. **깨끗한 Windows** (어떤 wallet 도 설치 안 된 상태)
2. **잔재 Windows** (Ledger Live · MetaMask Bridge 등 다른 wallet 의 driver 잔재가 있는 상태) ← **이번 사건의 환경**
3. **macOS** (driver 모델 단순, 표준 호환 검증)
4. **Linux** (udev rules 필요 여부 확인)

특히 **시나리오 (2) 의 의미**: 사용자가 Ledger Live 에서 우리 벼린 HW Live 로 갈아탈 때 잔재가 남아있는 상태. 이게 우리 HW 의 **마이그레이션 친화도** 를 결정.

---

## 3. 단기·중기 적용 로드맵

| 시점 | 단계 | 작업 |
|------|------|------|
| **v0.4 (현재)** | SW Extension | Ledger 진단은 backlog 이동. ZION swap (소프트 지갑) E2E 검증 우선. |
| **v0.5** | EVM HW 서명 | Ledger Nano S/X 재검증 (깨끗한 Windows + macOS). 자체 HW 가 아직 없으므로 Ledger 호환이 1차 목표. |
| **v0.6** | 자체 HW 펌웨어 설계 시작 | 본 문서의 4 원칙을 USB descriptor 설계 출발점으로 사용. |
| **v0.7** | 자체 HW prototype | 위 4 환경에서 정합성 검증. WebHID + WebUSB 동시 노출. |
| **v1.0 GA** | 자체 HW + SW 통합 | bridge 0, 다중 transport, 잔재 Windows 에서도 동작 확인. |

---

## 4. 메모리 색인

- 메모리: `project-hw-wallet-design` — 본 문서의 압축 버전 + 적용 규칙.
- 관련: [`project-wallet-principles`](#) (SW→HW 순서, 비수탁), [`project-insurance-backlog`](#) (HW 보증 옵션), [`project-ttl-wallet`](#) (전체 라인업).

---

## 5. 사용자 인용

> "문제는 렛저 말고 나중에 하드웨어 월릿을 개발하면 문제 아냐?"
>
> — 2026-05-31, 사용자가 Ledger 사건의 일반화 가능성을 정당하게 우려한 시점.

이 의도 추궁이 본 문서의 출발점. 비슷한 우려가 향후 다시 제기될 때 본 문서를 참조해 같은 분석을 반복하지 않는다.
