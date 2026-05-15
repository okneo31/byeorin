import { defineContentScript } from 'wxt/sandbox';
import {
  NODONG_MSG_TAG,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type WindowEnvelope,
} from '../src/lib/rpc.js';

// 모든 페이지에 inpage 스크립트(window.ethereum)를 주입하고,
// inpage ↔ background 사이에서 메시지를 중계한다.
export default defineContentScript({
  matches: ['<all_urls>'],
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
      chrome.runtime.sendMessage(req, (res: JsonRpcResponse) => {
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
