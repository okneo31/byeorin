// client.ts — Electrum 프로토콜 클라이언트 (JSON-RPC 2.0, 줄바꿈 구분).
//
// 전송은 ByteTransport 주입 — node net / Capacitor / Tauri / WS 릴레이 어느
// 구현이든 이 클라이언트는 모른다. 여기서 하는 일:
//   1. 줄 조립: onData 로 오는 스트림 조각을 모아 '\n' 단위로 자른다.
//      (0x0a 는 UTF-8 연속 바이트로 나올 수 없으므로 바이트 단위 분리가 안전)
//   2. id 매칭: 응답 id 를 대기 중 요청과 대조. 모르는 id 는 어떤 요청에도
//      배정하지 않고 버린다 — TTL RPC 응답 섞임 사고의 교훈.
//   3. 요청 타임아웃: 실측 server.version 406ms · get_history 3.6s
//      (electrum.blockstream.info:50001) → 기본 10s 로 여유를 둔다.

import type { ByteTransport, ByteTransportOptions } from '../transport.js';
import type { ElectrumHistoryItem } from './history.js';
import { isElectrumHistoryItem } from './history.js';

export interface ElectrumClientOptions {
  /** 요청별 응답 대기 상한 (ms). 기본 10_000. */
  timeoutMs?: number;
}

export interface ElectrumRequestOptions {
  /** 이 요청만의 타임아웃 (ms). */
  timeoutMs?: number;
}

/** blockchain.scripthash.get_balance 응답. 단위 sats. */
export interface ElectrumBalance {
  confirmed: number;
  unconfirmed: number;
}

/** blockchain.headers.subscribe 결과·알림의 헤더. */
export interface ElectrumHeader {
  height: number;
  hex: string;
}

/** 서버가 error 필드로 응답했을 때. */
export class ElectrumError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
  ) {
    super(`electrum: ${method} 실패${code !== undefined ? ` (code ${code})` : ''}: ${message}`);
    this.name = 'ElectrumError';
  }
}

interface PendingRequest {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const NL = 0x0a; // '\n'

export class ElectrumClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = new Uint8Array(0);
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private readonly notificationCbs: Array<(method: string, params: unknown) => void> = [];
  private closed = false;

  constructor(
    private readonly transport: ByteTransport,
    private readonly opts: ElectrumClientOptions = {},
  ) {
    transport.onData((bytes) => this.handleData(bytes));
    transport.onClose((err) => this.handleClose(err));
  }

  async connect(host: string, port: number, opts?: ByteTransportOptions): Promise<void> {
    await this.transport.connect(host, port, opts);
    this.closed = false;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  /** 서버 알림 (id 없는 메시지 — headers.subscribe 등) 구독. */
  onNotification(cb: (method: string, params: unknown) => void): void {
    this.notificationCbs.push(cb);
  }

  /** blockchain.headers.subscribe 알림만 골라 헤더로 전달. */
  onHeader(cb: (header: ElectrumHeader) => void): void {
    this.onNotification((method, params) => {
      if (method !== 'blockchain.headers.subscribe') return;
      // 알림 params 는 [ {height, hex} ] 형태 (프로토콜 1.4).
      const first = Array.isArray(params) ? (params[0] as unknown) : undefined;
      if (isHeader(first)) cb(first);
    });
  }

  // ── 프로토콜 메서드 ─────────────────────────────────────────────

  /** server.version. 반환은 서버 원형 그대로 [서버 소프트웨어, 프로토콜 버전]. */
  async version(clientName: string, protocolVersion = '1.4'): Promise<[string, string]> {
    const r = await this.request('server.version', [clientName, protocolVersion]);
    if (!Array.isArray(r) || typeof r[0] !== 'string' || typeof r[1] !== 'string') {
      throw new Error(`electrum: server.version 응답 형태가 어긋남: ${JSON.stringify(r)}`);
    }
    return [r[0], r[1]];
  }

  /** blockchain.scripthash.get_history — 컨펌(블록 순서) 뒤에 멤풀 항목. */
  async getHistory(
    scripthash: string,
    opts?: ElectrumRequestOptions,
  ): Promise<ElectrumHistoryItem[]> {
    const r = await this.request('blockchain.scripthash.get_history', [scripthash], opts);
    if (!Array.isArray(r) || !r.every(isElectrumHistoryItem)) {
      throw new Error(`electrum: get_history 응답 형태가 어긋남: ${JSON.stringify(r)}`);
    }
    return r;
  }

  /** blockchain.scripthash.get_balance — sats 단위 {confirmed, unconfirmed}. */
  async getBalance(scripthash: string, opts?: ElectrumRequestOptions): Promise<ElectrumBalance> {
    const r = await this.request('blockchain.scripthash.get_balance', [scripthash], opts);
    const b = r as ElectrumBalance;
    if (
      typeof b !== 'object' ||
      b === null ||
      typeof b.confirmed !== 'number' ||
      typeof b.unconfirmed !== 'number'
    ) {
      throw new Error(`electrum: get_balance 응답 형태가 어긋남: ${JSON.stringify(r)}`);
    }
    return { confirmed: b.confirmed, unconfirmed: b.unconfirmed };
  }

  /**
   * blockchain.transaction.get.
   * verbose=false → 원문 hex 문자열. verbose=true → 서버(bitcoind)가 주는
   * verbose 객체 — 필드 구성이 서버 구현에 달려 있어 임의로 타입을 좁히지 않는다.
   */
  async getTransaction(txid: string, verbose?: false, opts?: ElectrumRequestOptions): Promise<string>;
  async getTransaction(
    txid: string,
    verbose: true,
    opts?: ElectrumRequestOptions,
  ): Promise<Record<string, unknown>>;
  async getTransaction(
    txid: string,
    verbose = false,
    opts?: ElectrumRequestOptions,
  ): Promise<string | Record<string, unknown>> {
    const r = await this.request('blockchain.transaction.get', [txid, verbose], opts);
    if (!verbose) {
      if (typeof r !== 'string') {
        throw new Error(`electrum: transaction.get 응답이 hex 문자열이 아님: ${JSON.stringify(r)}`);
      }
      return r;
    }
    if (typeof r !== 'object' || r === null) {
      throw new Error(`electrum: transaction.get(verbose) 응답이 객체가 아님: ${JSON.stringify(r)}`);
    }
    return r as Record<string, unknown>;
  }

  /** blockchain.headers.subscribe — 현재 팁 헤더 반환, 이후 알림은 onHeader 로. */
  async headersSubscribe(opts?: ElectrumRequestOptions): Promise<ElectrumHeader> {
    const r = await this.request('blockchain.headers.subscribe', [], opts);
    if (!isHeader(r)) {
      throw new Error(`electrum: headers.subscribe 응답 형태가 어긋남: ${JSON.stringify(r)}`);
    }
    return r;
  }

  // ── JSON-RPC 코어 ──────────────────────────────────────────────

  /** 원시 요청 — 위 래퍼가 안 덮는 메서드도 부를 수 있게 공개해 둔다. */
  async request(
    method: string,
    params: unknown[] = [],
    opts?: ElectrumRequestOptions,
  ): Promise<unknown> {
    if (this.closed) throw new Error(`electrum: 연결이 닫힌 뒤의 요청 (${method})`);
    const id = this.nextId++;
    const timeoutMs = opts?.timeoutMs ?? this.opts.timeoutMs ?? 10_000;
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`electrum: ${method} 응답 없음 — ${timeoutMs}ms 초과 (id=${id})`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });

      this.transport.send(this.encoder.encode(line)).catch((err: unknown) => {
        const p = this.pending.get(id);
        if (!p) return; // 이미 타임아웃 처리됨
        clearTimeout(p.timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  // ── 내부: 줄 조립 · 메시지 분배 ─────────────────────────────────

  private handleData(bytes: Uint8Array): void {
    // 조각을 이어붙이고 '\n' 이 나올 때마다 한 줄씩 처리한다.
    const merged = new Uint8Array(this.buffer.length + bytes.length);
    merged.set(this.buffer, 0);
    merged.set(bytes, this.buffer.length);

    let start = 0;
    for (let i = 0; i < merged.length; i++) {
      if (merged[i] !== NL) continue;
      const lineBytes = merged.subarray(start, i);
      start = i + 1;
      const text = this.decoder.decode(lineBytes).replace(/\r$/, '');
      if (text.length > 0) this.handleLine(text);
    }
    this.buffer = merged.slice(start);
  }

  private handleLine(text: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      // JSON 이 아닌 줄 — 어느 요청에도 배정할 수 없으므로 버린다.
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };

    if (m.id === undefined || m.id === null) {
      // id 없음 = 서버 알림.
      if (typeof m.method === 'string') {
        for (const cb of this.notificationCbs) cb(m.method, m.params);
      }
      return;
    }

    // id 매칭 — 숫자 id 만 발급하므로 그 외/미발급 id 는 모두 폐기.
    // (모르는 id 를 아무 요청에나 배정하는 순간 응답 섞임 사고가 재현된다.)
    const p = typeof m.id === 'number' ? this.pending.get(m.id) : undefined;
    if (!p) return;
    this.pending.delete(m.id as number);
    clearTimeout(p.timer);

    if (m.error !== undefined && m.error !== null) {
      const e = m.error as { code?: unknown; message?: unknown };
      const code = typeof e.code === 'number' ? e.code : undefined;
      const message =
        typeof e.message === 'string' ? e.message : JSON.stringify(m.error);
      p.reject(new ElectrumError(p.method, code, message));
      return;
    }
    p.resolve(m.result);
  }

  private handleClose(err?: Error): void {
    this.closed = true;
    const reason = err ?? new Error('electrum: 응답 전에 연결이 끊김');
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(
        err ? reason : new Error(`electrum: ${p.method} 응답 전에 연결이 끊김`),
      );
    }
    this.pending.clear();
  }
}

function isHeader(v: unknown): v is ElectrumHeader {
  if (typeof v !== 'object' || v === null) return false;
  const h = v as ElectrumHeader;
  return typeof h.height === 'number' && typeof h.hex === 'string';
}
