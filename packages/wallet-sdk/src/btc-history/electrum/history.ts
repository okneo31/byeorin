// history.ts — blockchain.scripthash.get_history 결과 → 지갑 활동 행.
//
// Electrum 이 주는 필드는 tx_hash / height / (멤풀 항목에만) fee 가 전부다.
// 입출금 방향(direction)·금액은 이 응답만으로는 판정할 수 없다 — 그건
// transaction.get 으로 원문을 받아 입출력을 대조해야 하는 별개 단계이고,
// 표시는 화면 몫이다. 여기서는 받은 것만 담고 지어내지 않는다.

/** blockchain.scripthash.get_history 응답 항목 (프로토콜 1.4 원형 그대로). */
export interface ElectrumHistoryItem {
  tx_hash: string;
  /**
   * >0: 컨펌된 블록 높이.
   *  0: 멤풀 (부모 전부 컨펌됨).
   * -1: 멤풀 (미컨펌 부모 있음).
   */
  height: number;
  /** 멤풀 항목에만 존재. 단위 sats. */
  fee?: number;
}

/** 지갑 활동 행 — Electrum 원자료 + 사실에서 직접 유도되는 confirmed 플래그만. */
export interface BtcActivityRow {
  txid: string;
  height: number;
  /** height > 0 과 동치. */
  confirmed: boolean;
  /** 멤풀 항목에만 존재 (sats). */
  fee?: number;
  /** 서버가 준 원형 — 상위 계층이 재해석할 때 쓴다. */
  raw: ElectrumHistoryItem;
}

/** 런타임 형태 검사 — 서버 응답을 믿지 않는다. */
export function isElectrumHistoryItem(v: unknown): v is ElectrumHistoryItem {
  if (typeof v !== 'object' || v === null) return false;
  const it = v as ElectrumHistoryItem;
  return (
    typeof it.tx_hash === 'string' &&
    typeof it.height === 'number' &&
    (it.fee === undefined || typeof it.fee === 'number')
  );
}

/**
 * get_history 응답 → 활동 행. 순수 함수, 순서는 서버가 준 그대로
 * (프로토콜상 컨펌 항목은 블록체인 순서, 멤풀 항목이 그 뒤).
 * 형태가 어긋난 항목이 있으면 조용히 버리지 않고 예외를 던진다.
 */
export function toActivityRows(items: ElectrumHistoryItem[]): BtcActivityRow[] {
  return items.map((it, i) => {
    if (!isElectrumHistoryItem(it)) {
      throw new Error(`electrum: get_history[${i}] 형태가 어긋남: ${JSON.stringify(it)}`);
    }
    const row: BtcActivityRow = {
      txid: it.tx_hash,
      height: it.height,
      confirmed: it.height > 0,
      raw: it,
    };
    if (it.fee !== undefined) row.fee = it.fee;
    return row;
  });
}
