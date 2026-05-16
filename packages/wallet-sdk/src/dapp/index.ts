// Public surface for the `dapp/` module.
//
// Wallet shells importing WalletConnect should go through
//   `import { WalletConnectSigner, ... } from '@nodong/wallet-sdk'`
// rather than reaching into this file directly.

export {
  WalletConnectSigner,
  type WcConnectionRequest,
  type WcSession,
  type WcSessionProposal,
  type WcSessionProposalDecision,
  type WcSessionProposalHandler,
  type WcRequestHandler,
  type WcRequest,
  type WcNamespace,
  type WcMetadata,
  type WcDelegate,
  type WalletConnectSignerOptions,
} from './walletconnect.js';
