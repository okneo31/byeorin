import {
  bytesToHex,
  concat,
  createPublicClient,
  getAddress,
  hexToBytes,
  http,
  keccak256,
  parseSignature,
  serializeTransaction,
  stringToBytes,
  type Address as ViemAddress,
  type Chain as ViemChain,
  type Hex,
  type PublicClient,
  type Signature,
  type TransactionSerializableLegacy,
  type TransactionSerializableEIP1559,
  encodeFunctionData,
} from 'viem';
import { publicKeyToAddress } from 'viem/accounts';
import { toUncompressedSecp256k1 } from '../crypto/secp.js';
import { discoverTokens as discoverRegistryTokens } from '../tokens/discovery.js';
// Erc20 는 `import type { EvmAdapter }` 만 되짚으므로 런타임 순환이 생기지 않는다
// (타입 import 는 컴파일 후 사라진다). 아래 ERC20_TRANSFER_ABI 를 복제한 이유는
// 그 주석에 적힌 대로 **값 의존**을 피하기 위한 것이었는데, 여기서 필요한 것은
// 이미 있는 read 구현(symbol/name/decimals/balanceOf)이라 그대로 쓴다 —
// 같은 호출을 두 벌 만들면 둘이 어긋난다.
import { Erc20 } from '../tokens/erc20.js';
import { TokenRegistry } from '../tokens/registry.js';
import type { PortableTokenBalance, TokenCapableAdapter } from '../tokens/portable.js';
import type { Signer, Address, TransferIntent, TxHash } from '../types.js';
import type { ChainAdapter, SignRequest, TxContext } from './chain.js';

export type EvmUnsignedTx =
  | (TransactionSerializableLegacy & { type: 'legacy' })
  | (TransactionSerializableEIP1559 & { type: 'eip1559' });

export interface EvmSignedTx {
  raw: Hex;
  hash: Hex;
}

/**
 * 토큰 스캔이 상한에 걸려 일부만 조회됐을 때 호출자에게 넘기는 사실.
 *
 * `discoverTokens(owner)` 의 반환 타입은 공통 인터페이스라 늘릴 수 없다. 그렇다고
 * 조용히 자르면 잔액이 있는 토큰이 화면에서 사라진다 — 그래서 반환값 대신 콜백으로
 * 알린다.
 */
export interface EvmTokenScanTruncation {
  chainId: number;
  /** 레지스트리가 알고 있던 토큰 수. */
  known: number;
  /** 실제로 balanceOf 를 부른 수. */
  scanned: number;
}

/**
 * `discoverTokens(owner)` 가 발행할 balanceOf 호출의 기본 상한.
 *
 * `discovery.ts` 의 기본값은 50 이고, 초과분을 앞에서 잘라낸 뒤 console.warn 한 줄만
 * 남긴다. TTL(7777) 은 익스플로러에서 66 종을 받아오므로 그 기본값으로는 16 종이
 * 소리 없이 사라진다. 512 는 현재 알려진 어느 체인의 목록보다도 크게 잡은 값이라
 * 실무에서는 걸리지 않는다. 그래도 걸리면 `onTokenScanTruncated` 로 알린다.
 */
export const DEFAULT_EVM_TOKEN_SCAN_CALLS = 512;

/**
 * `PortableTokenBalance.source` 에 넣는 조회 방식 표기.
 *
 * 잔액은 어느 쪽이든 체인에서 balanceOf 로 직접 읽는다. 다른 것은 **메타데이터의
 * 출처**다 — `:custom` 은 심볼/이름/decimals 가 코드에 박힌 빌트인이 아니라 밖에서
 * 들어온 값(사용자 추가, TTL Scan 목록)이라는 뜻이다. 화면이 그 차이를 표시할 수
 * 있어야 하므로 숨기지 않는다.
 */
export const EVM_TOKEN_SOURCE_BUILTIN = 'erc20.balanceOf';
export const EVM_TOKEN_SOURCE_CUSTOM = 'erc20.balanceOf:custom';

/**
 * `readToken`(수동 추가)이 쓰는 표기.
 *
 * 목록 조회와 구분하는 이유: 이쪽은 **레지스트리를 거치지 않고 컨트랙트에서 직접**
 * 심볼/이름/자릿수를 읽는다. 같은 `erc20.balanceOf` 로 뭉뚱그리면 화면이 "코드에
 * 박힌 값"과 "방금 계약에 물어본 값"을 구별할 수 없다.
 */
export const EVM_TOKEN_SOURCE_MANUAL = 'erc20.contract';

/** portable.ts 의 검증 상한과 맞춘다 — 벗어나면 신뢰할 수 없는 값이다. */
const MAX_TOKEN_DECIMALS = 36;

/** 컨트랙트 주소 형식. 이걸 통과 못 하면 EVM 토큰이 아니다. */
const EVM_CONTRACT_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * 레지스트리를 주입받지 못한 어댑터가 쓰는 폴백 — 빌트인만 들어 있다.
 *
 * 모듈 스코프에 한 번만 만든다. 어댑터마다 사본을 들려 주면 인스턴스마다 상태가
 * 생기고, 매 조회마다 새로 만들면 빌트인을 계속 복사하게 된다. 여기에는 아무도
 * `addCustomToken` 을 하지 않으므로 사실상 읽기 전용이다.
 */
let fallbackRegistry: TokenRegistry | undefined;
function builtinOnlyRegistry(): TokenRegistry {
  fallbackRegistry ??= new TokenRegistry();
  return fallbackRegistry;
}

export interface EvmAdapterOptions {
  chain: ViemChain;
  rpcUrl?: string;
  feeMode?: 'auto' | 'legacy' | 'eip1559';
  coinType?: number;
  /**
   * 토큰 조회에 쓸 레지스트리. **호출자가 이미 들고 있는 인스턴스를 그대로 넘긴다.**
   *
   * 어댑터가 자기 레지스트리를 새로 만들면 사용자가 추가한 토큰과 TTL Scan 에서
   * 받아온 66 종이 어댑터에는 안 보인다 — 지갑이 들고 있는 것과 다른 목록이 두 벌
   * 생긴다. 참조를 넘기면 나중에 지갑이 `addCustomToken` 한 것도 그대로 보인다.
   *
   * 생략하면 빌트인만 보는 폴백을 쓴다.
   */
  tokenRegistry?: TokenRegistry;
  /** balanceOf 호출 상한. 기본 {@link DEFAULT_EVM_TOKEN_SCAN_CALLS}. */
  maxTokenScanCalls?: number;
  /** 상한에 걸려 목록이 잘렸을 때 불린다. 조회 자체는 잘린 채로 계속 진행된다. */
  onTokenScanTruncated?: (info: EvmTokenScanTruncation) => void;
}

// ERC-20 transfer(address,uint256) calldata.
//
// tokens/erc20.ts 의 Erc20 를 쓰지 않고 여기 최소 ABI 를 둔 이유: chains 가
// tokens 를 값으로 의존하면 순환이 생긴다(erc20.ts 는 EvmAdapter 를 참조한다).
// 함수 하나짜리 ABI 를 복제하는 편이 의존 방향을 단순하게 유지한다.
const ERC20_TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

function encodeErc20Transfer(to: ViemAddress, amount: bigint): Hex {
  return encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: 'transfer',
    args: [to, amount],
  });
}

export class EvmAdapter
  implements ChainAdapter<EvmUnsignedTx, EvmSignedTx>, TokenCapableAdapter
{
  readonly curve = 'secp256k1' as const;
  readonly id: string;
  readonly displayName: string;
  readonly coinType: number;
  readonly chain: ViemChain;
  private readonly client: PublicClient;
  private readonly feeMode: 'auto' | 'legacy' | 'eip1559';
  private readonly tokenRegistry: TokenRegistry | undefined;
  private readonly maxTokenScanCalls: number;
  private readonly onTokenScanTruncated:
    | ((info: EvmTokenScanTruncation) => void)
    | undefined;

  constructor(opts: EvmAdapterOptions) {
    this.chain = opts.chain;
    this.id = `evm:${opts.chain.id}`;
    this.displayName = opts.chain.name;
    this.coinType = opts.coinType ?? 60;
    this.feeMode = opts.feeMode ?? 'auto';
    this.tokenRegistry = opts.tokenRegistry;
    this.maxTokenScanCalls = opts.maxTokenScanCalls ?? DEFAULT_EVM_TOKEN_SCAN_CALLS;
    this.onTokenScanTruncated = opts.onTokenScanTruncated;
    const url = opts.rpcUrl ?? opts.chain.rpcUrls.default.http[0];
    if (!url) throw new Error(`evm: no rpcUrl for ${opts.chain.name}`);
    this.client = createPublicClient({ chain: opts.chain, transport: http(url) });
  }

  derivationPath(account = 0, index = 0): string {
    return `m/44'/${this.coinType}'/${account}'/0/${index}`;
  }

  pubkeyToAddress(pubkey: Uint8Array): Address {
    const uncompressed = toUncompressedSecp256k1(pubkey);
    return publicKeyToAddress(bytesToHex(uncompressed));
  }

  async getBalance(address: Address): Promise<bigint> {
    return this.client.getBalance({ address: address as ViemAddress });
  }

  async buildTransfer(intent: TransferIntent, ctx: TxContext): Promise<EvmUnsignedTx> {
    const sender = ctx.sender as ViemAddress;
    const to = intent.to as ViemAddress;
    const nonce = await this.client.getTransactionCount({ address: sender, blockTag: 'pending' });
    const useEip1559 = await this.shouldUseEip1559();

    // calldata 전파: '0x' / 빈 문자열 / undefined 는 native 전송으로 취급. 그 외는
    // estimateGas 와 직렬화에 모두 calldata 를 포함시킨다 — gas 추정이 native 와
    // 크게 다르므로 누락하면 transfer 가 OOG 로 실패한다.
    let dataField: Hex | undefined =
      intent.data && intent.data !== '0x' ? (intent.data as Hex) : undefined;
    // 실제로 서명될 대상. asset(ERC-20) 이면 to 는 컨트랙트, value 는 0 이 된다.
    let target = to;
    let value = intent.amount;

    // 공통 토큰 규약: intent.asset 에 토큰 식별자(EVM 은 컨트랙트 주소)를 넣으면
    // 그 토큰을 보낸다. 이 분기가 없으면 asset 을 넣어도 **native 코인이 그대로
    // 나간다** — 다른 체인과 같은 규약을 쓴다고 믿은 호출자가 자산을 잃는다.
    //
    // data 를 직접 넣는 기존 경로도 그대로 둔다. 둘이 같이 오면 data 가 이긴다 —
    // 명시적으로 calldata 를 지정한 쪽이 더 구체적인 의사표시다.
    if (!dataField && typeof intent.asset === 'string' && intent.asset.length > 0) {
      const token = intent.asset;
      if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
        // 조용히 native 로 되돌리지 않는다. 토큰을 고른 사용자에게 native 가
        // 나가는 것이 최악이라, 실패를 시끄럽게 만든다.
        throw new Error(`evm: asset 이 컨트랙트 주소 형식이 아니다: ${token}`);
      }
      dataField = encodeErc20Transfer(to, intent.amount);
      target = token as ViemAddress;
      value = 0n;
    }

    if (useEip1559) {
      const fees = await this.client.estimateFeesPerGas();
      const gas = await this.client.estimateGas({
        account: sender,
        to: target,
        value,
        ...(dataField ? { data: dataField } : {}),
      });
      const base: TransactionSerializableEIP1559 & { type: 'eip1559' } = {
        type: 'eip1559',
        chainId: this.chain.id,
        nonce,
        to: target,
        value,
        gas,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      };
      if (dataField) base.data = dataField;
      return base;
    }

    const gasPrice = await this.client.getGasPrice();
    const gas = await this.client.estimateGas({
      account: sender,
      to,
      value,
      ...(dataField ? { data: dataField } : {}),
    });
    const base: TransactionSerializableLegacy & { type: 'legacy' } = {
      type: 'legacy',
      chainId: this.chain.id,
      nonce,
      to,
      value,
      gas,
      gasPrice,
    };
    if (dataField) base.data = dataField;
    return base;
  }

  async signRequests(tx: EvmUnsignedTx): Promise<SignRequest[]> {
    const serialized = serializeTransaction(tx);
    return [{ message: hexToBytes(keccak256(serialized)), prehashed: true }];
  }

  async applySignatures(tx: EvmUnsignedTx, signatures: Uint8Array[]): Promise<EvmSignedTx> {
    if (signatures.length !== 1) {
      throw new Error(`evm: expected 1 signature, got ${signatures.length}`);
    }
    const signature = signatures[0]!;
    if (signature.length !== 65) {
      throw new Error(`evm: signature must be 65 bytes, got ${signature.length}`);
    }
    const sig = parseSignature(bytesToHex(signature)) as Signature;
    const raw = serializeTransaction(tx, sig);
    return { raw, hash: keccak256(raw) };
  }

  async broadcast(tx: EvmSignedTx): Promise<TxHash> {
    return this.client.sendRawTransaction({ serializedTransaction: tx.raw });
  }

  /**
   * `TokenCapableAdapter` 구현 — 이 주소가 보유한 ERC-20 을 돌려준다.
   *
   * EVM 은 "가진 토큰 목록"을 물어볼 수 있는 체인이 아니다. 알려진 컨트랙트마다
   * balanceOf 를 하나씩 부르는 수밖에 없고, 그래서 **어떤 목록을 아느냐가 곧 무엇이
   * 보이느냐**다. 목록은 생성자로 주입받은 레지스트리에서 온다(위 `tokenRegistry`
   * 주석 참고). 새 로직을 쓰지 않고 기존 `discoverTokens(adapter, registry, ...)`
   * 를 그대로 부른다 — 조회 경로가 둘로 갈라지면 둘이 어긋난다.
   *
   * 잔액 0 은 제외한다(`includeZero` 기본값). 공통 인터페이스에는 "전체 보기"
   * 토글에 해당하는 인자가 없고, 없는 걸 있는 것처럼 보여주기보다 안 보여주는 쪽이
   * 첫 화면에 맞다. 0 까지 필요한 화면은 기존 `discoverTokens` 를 직접 부르면 된다.
   *
   * 실패는 던지지 않고 빈 배열을 돌려준다.
   */
  async discoverTokens(owner: string): Promise<PortableTokenBalance[]> {
    const registry = this.tokenRegistry ?? builtinOnlyRegistry();
    try {
      const chainId = this.chain.id;
      const known = registry.getKnownTokens(chainId);
      if (known.length > this.maxTokenScanCalls) {
        // discovery.ts 는 여기서 앞부분만 남기고 console.warn 만 한다. 잘렸다는
        // 사실 자체를 호출자에게 넘긴다 — 화면이 "일부만 조회됨"을 말할 수 있어야
        // 사용자가 안 보이는 토큰을 사라진 토큰으로 오해하지 않는다.
        this.onTokenScanTruncated?.({
          chainId,
          known: known.length,
          scanned: this.maxTokenScanCalls,
        });
      }

      const found = await discoverRegistryTokens(this, registry, owner as Address, {
        chainId,
        maxRpcCalls: this.maxTokenScanCalls,
        // **잔액 0 도 포함한다.** EVM 의 목록은 "레지스트리에 등록된 것" 이라
        // 0 을 빼면 화면에서 검색·가리기 대상이 통째로 사라진다 — TTL 66 종 중
        // 보유분만 남아 "무슨 토큰을 볼 수 있나" 를 알 수 없게 된다.
        // 0 을 감출지는 화면이 정한다 (체인의 사실과 표시 정책을 섞지 않는다).
        includeZero: true,
      });

      const out: PortableTokenBalance[] = [];
      for (const { token, balance } of found) {
        // decimals 가 틀리면 잔액이 자릿수째로 거짓이 된다. 사용자 추가 토큰은
        // 레지스트리가 값을 검증하지 않으므로 여기서 막는다 — 추측해서 18 을
        // 넣지 않고 그 항목을 버린다.
        if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 36) {
          continue;
        }
        out.push({
          // EVM 의 토큰 식별자 = 컨트랙트 주소. 레지스트리에 등록된 표기를 그대로
          // 쓴다(체크섬 여부 포함) — 조회와 표시가 같은 문자열을 보게 한다.
          id: token.address,
          symbol: token.symbol,
          name: token.name,
          decimals: token.decimals,
          balance,
          source: token.custom ? EVM_TOKEN_SOURCE_CUSTOM : EVM_TOKEN_SOURCE_BUILTIN,
        });
      }
      return out;
    } catch {
      // 토큰 목록 때문에 지갑이 안 열리면 안 된다.
      return [];
    }
  }

  /**
   * 컨트랙트 주소 하나를 받아 그 ERC-20 이 무엇인지 체인에서 읽는다. **수동 추가용.**
   *
   * 호출 구성 — **왕복 4회, 전부 동시에 나간다** (`decimals`/`symbol`/`name`/
   * `balanceOf`). 순차로 돌릴 이유가 없다: EVM 공개 RPC 는 TRON 처럼 연속 호출
   * 한도가 빡빡하지 않고, 사용자가 "추가" 버튼을 누르고 기다리는 화면이라
   * 4배 느려지는 쪽이 손해다. 하나라도 실패해도 나머지는 살린다.
   *
   * 실패의 종류를 두 가지로 나눈다:
   *   - **형식이 틀리면 던진다.** 사용자가 방금 붙여넣은 문자열이 주소가 아니라는
   *     사실은 즉시 알려줘야 한다. 조용히 null 을 주면 "왜 안 되지"만 남는다.
   *   - **형식은 맞는데 decimals 를 못 읽으면 null.** EOA 나 ERC-20 이 아닌 계약이
   *     여기 해당한다. 18 로 추측하지 않는다 — 자릿수가 틀리면 잔액이 통째로
   *     거짓이 되는데 사용자는 그걸 알아채지 못한다.
   *
   * symbol/name 은 못 읽어도 버리지 않는다. 금액을 왜곡하지 않으므로 주소 축약으로
   * 대체하고 그 사실을 `source` 에 남긴다(지어내지 않는다). 잔액도 못 구하면 0n 으로
   * 두되 등록 자체는 되게 한다 — 아직 안 받은 토큰을 미리 등록하는 것은 정상이다.
   */
  async readToken(id: string, owner: string): Promise<PortableTokenBalance | null> {
    if (typeof id !== 'string' || !EVM_CONTRACT_ADDRESS_RE.test(id)) {
      throw new Error(
        `evm: 토큰 식별자가 컨트랙트 주소 형식(0x + 40 hex)이 아닙니다: ${id}`,
      );
    }
    // 체크섬 표기로 못박는다. 같은 컨트랙트를 소문자로도 대문자로도 등록하면
    // 레지스트리에 같은 토큰이 두 줄 생기고, 조회와 송금이 서로 다른 문자열을
    // 보게 된다. getAddress 는 EIP-55 체크섬으로 정규화한다.
    const token = getAddress(id) as Address;

    const erc20 = new Erc20(this);
    const [decRes, symRes, nameRes, balRes] = await Promise.allSettled([
      erc20.decimals(token),
      erc20.symbol(token),
      erc20.name(token),
      erc20.balanceOf(token, owner as Address),
    ]);

    // decimals 가 없으면 이 주소는 ERC-20 이 아니거나 읽을 수 없는 상태다.
    if (decRes.status !== 'fulfilled') return null;
    const decimals = decRes.value;
    if (
      !Number.isInteger(decimals) ||
      decimals < 0 ||
      decimals > MAX_TOKEN_DECIMALS
    ) {
      return null;
    }

    const symbol = symRes.status === 'fulfilled' ? cleanLabel(symRes.value) : null;
    const name = nameRes.status === 'fulfilled' ? cleanLabel(nameRes.value) : null;
    // 음수는 balanceOf 가 줄 수 없는 값이다. 그런 응답이 오면 읽기 실패로 본다.
    const balance =
      balRes.status === 'fulfilled' &&
      typeof balRes.value === 'bigint' &&
      balRes.value >= 0n
        ? balRes.value
        : null;
    const fallback = shortenEvmAddress(token);

    return {
      id: token, // 그대로 TransferIntent.asset 에 넣으면 송금이 된다.
      symbol: symbol ?? fallback,
      name: name ?? symbol ?? fallback,
      decimals,
      balance: balance ?? 0n,
      source: buildManualEvmSource({
        symbolRead: symbol !== null,
        nameRead: name !== null,
        balanceRead: balance !== null,
      }),
    };
  }

  private async shouldUseEip1559(): Promise<boolean> {
    if (this.feeMode === 'legacy') return false;
    if (this.feeMode === 'eip1559') return true;
    try {
      const block = await this.client.getBlock({ blockTag: 'latest' });
      return block.baseFeePerGas != null;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// 수동 토큰 추가(readToken) 보조 함수
// ---------------------------------------------------------------------------

/**
 * `source` 문자열을 만든다.
 *
 * 무엇을 계약에서 실제로 읽었고 무엇을 대체했는지 한 줄에 담는다 — 화면이
 * PortableTokenBalance 하나만 받아도 "이 이름이 진짜인가"를 판단할 수 있어야 한다.
 */
function buildManualEvmSource(o: {
  symbolRead: boolean;
  nameRead: boolean;
  balanceRead: boolean;
}): string {
  const read = ['decimals'];
  if (o.symbolRead) read.push('symbol');
  if (o.nameRead) read.push('name');
  if (o.balanceRead) read.push('balanceOf');
  const parts = [`${EVM_TOKEN_SOURCE_MANUAL}:${read.join(',')}`];
  if (!o.symbolRead) parts.push('symbol=주소축약(읽기실패)');
  if (!o.nameRead) parts.push('name=대체(읽기실패)');
  if (!o.balanceRead) parts.push('balance=0(조회실패)');
  return parts.join('; ');
}

/** `0xaaaa…bbbb` 꼴. symbol 을 못 읽었을 때 지어내는 대신 쓴다. */
function shortenEvmAddress(addr: string): string {
  return addr.length <= 12 ? addr : `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * 계약이 준 텍스트를 그대로 믿지 않는다.
 *
 * symbol()/name() 은 컨트랙트가 임의로 정하는 문자열이라 줄바꿈으로 UI 를 깨거나
 * 다른 토큰인 척하는 데 쓰일 수 있다. 제어문자를 지우고 길이를 자른다.
 * 남는 게 없으면 null — 여기서 빈 문자열을 통과시키면 화면에 이름 없는 줄이 생긴다.
 * (tron.ts 의 sanitizeText 와 같은 규칙. 두 파일이 서로를 import 하지 않으므로
 * 짧은 함수 하나를 각자 들고 있는 편이 의존 방향을 단순하게 유지한다.)
 */
function cleanLabel(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let cleaned = '';
  for (const ch of v) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    cleaned += ch;
  }
  cleaned = cleaned.trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > 64 ? cleaned.slice(0, 64) : cleaned;
}

/**
 * EIP-191 personal-sign helper.
 *
 * Computes the canonical Ethereum signed-message digest and signs it with the
 * provided Signer (SoftSigner or HW). Returns a 0x-prefixed 65-byte
 * `r(32) || s(32) || v(1)` hex string with `v ∈ {27, 28}` — the format
 * `eth_sign` / `personal_sign` callers expect.
 *
 * Digest = `keccak256("\x19Ethereum Signed Message:\n" + len(message) + message)`
 *
 * `message` may be:
 *   - a UTF-8 string (encoded to bytes before length-prefixing), or
 *   - a `Uint8Array` (used as-is, length-prefixed).
 *
 * The `address` argument is accepted for symmetry with wallet APIs but is
 * **not** verified against the signer's public key. Callers wiring this into
 * a JSON-RPC bridge should validate the address upstream (see
 * `apps/extension/entrypoints/background.ts::personal_sign`).
 *
 * Cross-checked against MetaMask's personal_sign output and the on-chain
 * `ecrecover` behaviour used by EIP-1271-style verifiers.
 */
export async function signEvmMessage(
  signer: Signer,
  address: Address,
  message: string | Uint8Array,
): Promise<Hex> {
  if (signer.curve !== 'secp256k1') {
    throw new Error(`signEvmMessage: requires secp256k1 signer, got ${signer.curve}`);
  }
  // Accept-but-don't-verify the address. Documented above.
  void address;
  const msgBytes =
    typeof message === 'string' ? stringToBytes(message) : message;
  const prefix = stringToBytes(`\x19Ethereum Signed Message:\n${msgBytes.length}`);
  const digestHex = keccak256(concat([prefix, msgBytes]));
  const sig = await signer.sign(hexToBytes(digestHex));
  if (sig.length !== 65) {
    throw new Error(`signEvmMessage: signature must be 65 bytes, got ${sig.length}`);
  }
  const recovery = sig[64] as number;
  // SoftSigner emits raw recovery {0,1}. Accept pre-encoded v ∈ {27, 28} too
  // (some HW signers add 27 internally).
  let v: number;
  if (recovery === 0 || recovery === 1) {
    v = recovery + 27;
  } else if (recovery === 27 || recovery === 28) {
    v = recovery;
  } else {
    throw new Error(
      `signEvmMessage: recovery byte must be 0|1|27|28, got ${recovery}`,
    );
  }
  const out = new Uint8Array(65);
  out.set(sig.subarray(0, 64), 0);
  out[64] = v;
  return bytesToHex(out);
}

