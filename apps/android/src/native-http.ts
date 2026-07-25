// native-http.ts — CORS 를 우회해야 하는 단 하나의 엔드포인트를 위한 네이티브 fetch.
//
// 배경: 확장(MV3) 은 manifest 의 host_permissions 로 CORS 를 통째로 무력화할 수
// 있었다. WebView 에는 그런 장치가 없고 오리진이 `https://localhost` 인 평범한
// 웹 페이지로 취급되므로, 서버가 `Access-Control-Allow-Origin` 을 주지 않으면
// 응답 본문을 읽을 수 없다.
//
// 9 체인 RPC 를 전부 실측(2026-07-25)한 결과:
//   rpc.ttl1.top · rpc.zion1.top · publicnode(eth/sol) · blockstream ·
//   toncenter · trongrid · aptoslabs · sui · binance  → 전부 ACAO 응답 O
//   api.zion1.top (ZION AMM 인덱서)                    → ACAO 없음 ✗
//
// 따라서 전역 fetch 를 패치(CapacitorHttp enabled)하는 대신, AMM 클라이언트에만
// 이 fetcher 를 주입한다. 부작용 표면을 한 곳으로 묶어두는 편이 진단이 쉽다.
//
// 웹(vite dev)에서 실행될 때는 플러그인이 없으므로 표준 fetch 로 자동 폴백한다.

import { CapacitorHttp, Capacitor } from '@capacitor/core';

/** 네이티브 계층(OkHttp)을 태우는 fetch 호환 함수. 실패 시 표준 fetch 로 폴백. */
export const nativeFetch: typeof fetch = async (input, init) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

  if (!Capacitor.isNativePlatform()) {
    return fetch(input as RequestInfo, init);
  }

  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = normalizeHeaders(init?.headers);

  const res = await CapacitorHttp.request({
    url,
    method,
    headers,
    ...(init?.body !== undefined && init.body !== null
      ? { data: await bodyToData(init.body) }
      : {}),
    // 네이티브 계층이 content-type 을 보고 JSON 파싱을 해버리면 아래에서
    // 다시 stringify 해야 한다. 원문 그대로 받아 Response 를 우리가 만든다.
    responseType: 'text',
  });

  const bodyText =
    typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

  return new Response(bodyText, {
    status: res.status,
    // Response 생성자는 204/205/304 에 본문을 허용하지 않으므로 statusText 만.
    statusText: String(res.status),
    headers: toHeaderInit(res.headers),
  });
};

function normalizeHeaders(h: HeadersInit | undefined): Record<string, string> {
  if (!h) return {};
  if (h instanceof Headers) {
    const out: Record<string, string> = {};
    h.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(h)) return Object.fromEntries(h);
  return { ...h };
}

function toHeaderInit(h: unknown): Record<string, string> {
  if (!h || typeof h !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
    // Response 생성자가 거부하는 hop-by-hop / 인코딩 헤더는 제외한다.
    // (본문은 이미 디코딩된 문자열이라 content-encoding 을 남기면 깨진다.)
    const lower = k.toLowerCase();
    if (lower === 'content-encoding' || lower === 'content-length') continue;
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

async function bodyToData(body: BodyInit): Promise<unknown> {
  if (typeof body === 'string') {
    // JSON 문자열이면 객체로 넘겨야 네이티브가 올바른 content-type 을 붙인다.
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  if (body instanceof Blob) return body.text();
  if (body instanceof URLSearchParams) return body.toString();
  return String(body);
}
