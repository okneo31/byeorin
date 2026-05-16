// HW 트랜스포트 진입점.
//
// v0.4: WebHID 만 제공. Node-HID(데스크톱 Tauri 직속) 는 native dep 가 늘어
// 인스톨/CI 표면이 커지므로 v0.5 로 이연. 데스크톱은 v0.4 에서는 Tauri 2 의
// 브라우저-호환 WebHID 를 통해 동일하게 `WebHidTransport` 를 사용한다.
//
// TODO(v0.5): `node-hid.ts` — `@ledgerhq/hw-transport-node-hid` wrap.
//   - prebuilt 바이너리 매트릭스 확보 후 추가.
//   - CI 에서 node 22 / electron 28 양쪽 빌드 검증.

export { WebHidTransport, type WebHidOpenOptions } from './webhid.js';
