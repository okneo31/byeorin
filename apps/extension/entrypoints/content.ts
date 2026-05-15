import { defineContentScript } from 'wxt/sandbox';
import {
  NODONG_MSG_TAG,
  type BackgroundMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type WindowEnvelope,
} from '../src/lib/rpc.js';

// H3 fix: 공개 웹(https) + 로컬 개발(http://localhost) 로만 주입을 한정한다.
// chrome://, chrome-extension://, file://, about:, view-source: 등 특권/내부 페이지에서는
// dApp 프로바이더가 활성화될 이유가 없으며, 은행/정부/인트라넷 환경에서의 표면 노출도 줄인다.
export default defineContentScript({
  matches: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
  runAt: 'document_start',
  allFrames: false,
  async main() {
    // inpage 스크립트는 web_accessible_resources 로 노출되어 있다.
    // WXT 가 inpage.ts 를 별도 청크로 빌드하지만, 가장 안정적인 방법은
    // script 태그를 페이지 컨텍스트에 삽입해 MAIN world 에서 실행시키는 것.
    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('/inpage.js');
      script.async = false;
      (document.head || document.documentElement).appendChild(script);
      script.onload = () => script.remove();
    } catch (e) {
      // 일부 페이지(CSP strict)에서 실패할 수 있다. 본 스켈레톤에서는 무시.
      console.warn('[nodong] inpage 주입 실패:', e);
    }

    // 페이지에서 올라오는 RPC 요청을 background 로 포워딩.
    window.addEventListener('message', (event: MessageEvent<WindowEnvelope>) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.tag !== NODONG_MSG_TAG || data.dir !== 'page-to-cs') return;
      const req = data.payload as JsonRpcRequest;
      const msg: BackgroundMessage = { type: 'rpc', payload: req };
      chrome.runtime.sendMessage(msg, (res: JsonRpcResponse) => {
        const envelope: WindowEnvelope = {
          tag: NODONG_MSG_TAG,
          dir: 'cs-to-page',
          payload: res,
        };
        window.postMessage(envelope, '*');
      });
    });
  },
});
