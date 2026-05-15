import { HDKey } from '@scure/bip32';
import { ed25519 } from '@noble/curves/ed25519';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';

export interface DerivedKey {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export function deriveSecp256k1(seed: Uint8Array, path: string): DerivedKey {
  const master = HDKey.fromMasterSeed(seed);
  const node = master.derive(path);
  if (!node.privateKey) throw new Error(`hdkey: no private key at ${path}`);
  if (!node.publicKey) throw new Error(`hdkey: no public key at ${path}`);
  return { privateKey: node.privateKey, publicKey: node.publicKey };
}

const ED25519_CURVE = new TextEncoder().encode('ed25519 seed');

interface Ed25519Node {
  key: Uint8Array;
  chainCode: Uint8Array;
}

function ed25519Master(seed: Uint8Array): Ed25519Node {
  const I = hmac(sha512, ED25519_CURVE, seed);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

function ed25519Child(parent: Ed25519Node, index: number): Ed25519Node {
  const data = new Uint8Array(1 + 32 + 4);
  data[0] = 0x00;
  data.set(parent.key, 1);
  data[33] = (index >>> 24) & 0xff;
  data[34] = (index >>> 16) & 0xff;
  data[35] = (index >>> 8) & 0xff;
  data[36] = index & 0xff;
  const I = hmac(sha512, parent.chainCode, data);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

export function deriveEd25519(seed: Uint8Array, path: string): DerivedKey {
  if (!path.startsWith('m/')) throw new Error(`hdkey: bad path ${path}`);
  const segments = path.slice(2).split('/').filter(Boolean);
  let node = ed25519Master(seed);
  for (const seg of segments) {
    if (!seg.endsWith("'")) {
      throw new Error(`hdkey: ed25519 requires hardened path, got ${seg}`);
    }
    const idx = Number(seg.slice(0, -1));
    if (!Number.isInteger(idx) || idx < 0) {
      throw new Error(`hdkey: invalid index ${seg}`);
    }
    node = ed25519Child(node, idx + 0x80000000);
  }
  const publicKey = ed25519.getPublicKey(node.key);
  return { privateKey: node.key, publicKey };
}
