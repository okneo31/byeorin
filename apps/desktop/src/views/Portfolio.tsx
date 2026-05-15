interface Props {
  unlocked: boolean;
}

interface AssetCard {
  symbol: string;
  name: string;
  status: '연결' | '준비 중';
}

const ASSETS: readonly AssetCard[] = [
  { symbol: 'TTL', name: 'TTL Mainnet', status: '연결' },
  { symbol: 'ETH', name: 'Ethereum', status: '준비 중' },
  { symbol: 'BTC', name: 'Bitcoin', status: '준비 중' },
  { symbol: 'XRP', name: 'XRP Ledger', status: '준비 중' },
  { symbol: 'ATOM', name: 'Cosmos Hub', status: '준비 중' },
  { symbol: 'MATIC', name: 'Polygon', status: '준비 중' },
  { symbol: 'BNB', name: 'BNB Smart Chain', status: '준비 중' },
  { symbol: 'AVAX', name: 'Avalanche', status: '준비 중' },
];

export function Portfolio({ unlocked }: Props) {
  return (
    <div className="nd-view">
      <header className="nd-view__header">
        <h1 className="nd-h1">포트폴리오</h1>
        <p className="nd-lead">
          멀티체인 자산 한 눈에 보기. TTL 외 체인은 곧 활성화됩니다.
        </p>
      </header>

      {!unlocked && (
        <div className="nd-warn">
          지갑을 열면 자산이 표시됩니다. 좌측 메뉴에서 지갑을 시작하세요.
        </div>
      )}

      <section className="nd-grid">
        {ASSETS.map((a) => (
          <div key={a.symbol} className="nd-tile">
            <div className="nd-tile__sym">{a.symbol}</div>
            <div className="nd-tile__name">{a.name}</div>
            <div
              className={
                'nd-tile__status' +
                (a.status === '연결' ? ' nd-tile__status--live' : ' nd-tile__status--pending')
              }
            >
              {a.status}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
