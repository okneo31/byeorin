import type { Address, TransferIntent, TxHash } from './types.js';
import type { ChainAdapter } from './chains/chain.js';
import { deriveEd25519, deriveSecp256k1 } from './crypto/hdkey.js';
import { isValidMnemonic, mnemonicToSeed, type WordlistName } from './crypto/seed.js';
import { SoftSigner } from './signers/soft.js';

export interface WalletAccount {
  address: Address;
  derivationPath: string;
  publicKey: Uint8Array;
  signer: SoftSigner;
  adapter: ChainAdapter;
}

export interface WalletOptions {
  mnemonic: string;
  passphrase?: string;
  wordlist?: WordlistName;
}

export class Wallet {
  private readonly seed: Uint8Array;

  private constructor(seed: Uint8Array) {
    this.seed = seed;
  }

  static fromMnemonic(opts: WalletOptions): Wallet {
    const wl = opts.wordlist ?? 'english';
    if (!isValidMnemonic(opts.mnemonic, wl)) {
      throw new Error('wallet: invalid mnemonic for selected wordlist');
    }
    return new Wallet(mnemonicToSeed(opts.mnemonic, opts.passphrase ?? ''));
  }

  account(adapter: ChainAdapter, account = 0, index = 0): WalletAccount {
    const path = adapter.derivationPath(account, index);
    const derived =
      adapter.curve === 'secp256k1'
        ? deriveSecp256k1(this.seed, path)
        : deriveEd25519(this.seed, path);
    const signer = new SoftSigner({ curve: adapter.curve, privateKey: derived.privateKey });
    const address = adapter.pubkeyToAddress(derived.publicKey);
    return {
      address,
      derivationPath: path,
      publicKey: derived.publicKey,
      signer,
      adapter,
    };
  }

  async transfer(acc: WalletAccount, intent: TransferIntent): Promise<TxHash> {
    const unsigned = await acc.adapter.buildTransfer(intent, {
      sender: acc.address,
      signer: acc.signer,
    });
    const hash = await acc.adapter.serializeForSigning(unsigned);
    const sig = await acc.signer.sign(hash);
    const signed = await acc.adapter.applySignature(unsigned, sig);
    return acc.adapter.broadcast(signed);
  }
}
