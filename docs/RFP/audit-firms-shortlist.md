# Audit Firms — Internal Shortlist

**Status**: internal working document — not shared with bidders.
**Owner**: [YOUR_NAME]
**Last updated**: [YYYY-MM-DD]

This document collects publicly known information about candidate firms for the Worker's Wallet security audit. Every entry should be **re-verified by a current visit to the firm's website** before contact — firm specialties, pricing models, and team rosters change frequently. Entries marked "TBD verify" are educated guesses from public-domain memory and must be confirmed before quoting in any internal decision.

Engagement-size figures are **rough public-record averages**, not commitments any firm has made. Use as ballpark only.

---

## Tier A — strong fit on prior wallet / multi-chain / HW work

| Firm | Specialties | Public clients (representative) | Typical engagement | KR timezone | Contact | Why we'd consider |
|---|---|---|---|---|---|---|
| **Trail of Bits** | EVM, Solana, Move, embedded/C, fuzzing tooling (slither, echidna, manticore) | Numerous (Compound, MakerDAO, others — verify current list) | ~10-30k LOC, 8-16 weeks | US ET — challenging overlap; mature async workflow | trailofbits.com/contact | Strongest tooling reputation; multi-chain + embedded coverage is rare. Likely upper-end pricing. **Verify** current wallet/HW availability. |
| **Cure53** | Browser extensions, web app sec, mobile, embedded — broad pen-test depth | Mozilla, 1Password, ProtonMail (verify) | ~2-8 weeks scoped | CET — manageable overlap with KR | cure53.de | Excellent for the extension / UI-shell side. Less known for chain-protocol depth. Pair with a chain-focused firm if budget allows. |
| **Halborn** | EVM, Solana, Cosmos, mobile wallets, infrastructure | MetaMask, Solana Foundation, others (verify) | Multi-chain wallet work documented publicly | US ET / global team | halborn.com/contact | Direct wallet experience. **Verify** current HW capability — primarily software-focused historically. |
| **OpenZeppelin** | EVM (deepest in industry), Solana growing, governance | Compound, Ethereum Foundation, Coinbase (verify current) | ~5-12 weeks for SDK-sized scopes | US / global | openzeppelin.com/security-audits | EVM gold standard. Non-EVM coverage exists but less deep. **Verify** Move/TON capacity. |
| **SlowMist** | EVM, Solana, BTC ecosystem, wallet-specific, has KR/CN/JP language capability | imToken, OKX Wallet, many Asian wallets | Wallet-class engagements regular | CN — best KR timezone overlap | slowmist.com | Strong wallet-audit track record in Asia. Korean-language communication likely feasible. Confirm scope on HW firmware. |

## Tier B — strong on chain protocol, may need pairing for UI/HW

| Firm | Specialties | Public clients | Typical engagement | KR timezone | Contact | Why we'd consider |
|---|---|---|---|---|---|---|
| **ChainSecurity** | EVM (deep), formal-methods leaning | Lido, Maker, others (verify) | Protocol-sized scopes | CET | chainsecurity.com | Strong rigor; less wallet-shell focused. **Verify** non-EVM. |
| **Quantstamp** | EVM, broad chain coverage | Many — verify current | Variable | US/global | quantstamp.com | Brand recognition; ask for senior-team allocation explicitly. |
| **Sigma Prime** | Ethereum consensus, Lighthouse client — deep crypto/protocol | Ethereum Foundation, Lido | Protocol-heavy | AU — tough overlap | sigmaprime.io | Best-in-class for protocol crypto, probably overkill for wallet UI. Worth a conversation if SDK-cryptography is a top concern. |
| **Spearbit** | EVM, distributed marketplace of senior auditors (Cantina) | Optimism, Aave, many | Variable, often via Cantina | Global | spearbit.com / cantina.xyz | Talent-quality model; can assemble multi-chain team. **Verify** HW capacity. |
| **Veridise** | Formal methods, ZK, EVM | zkSync, Aleo, others (verify) | Specialized | US | veridise.com | Probably overkill unless we add ZK features; mention only for completeness. |

## Tier C — different engagement model (consider, don't replace)

| Firm | Specialties | Notes |
|---|---|---|
| **Code4rena** | Crowdsourced contest audits, EVM-dominant | Contest model — best for time-boxed competitive review on EVM SDK paths. **Not a substitute** for a firm engagement; useful as a complement before code freeze. Verify if non-EVM contests are mature. |
| **Sherlock** | Audit-as-coverage; insurance-backed | Insurance-bundled audits. Worth a conversation given our parallel insurance work (see `docs/INSURANCE.md`). **Verify** scope coverage for wallet (vs DeFi protocol) and HW. |
| **CertiK** | Broad market, formal-verification branding | Polarizing reputation in industry — verify recent report quality before including. Brand recognition in Asia is high. |

---

## Initial outreach plan

1. **Tier A first**: send RFP to 3-5 firms. Suggested initial set:
   - Trail of Bits (tooling depth + embedded)
   - Halborn (wallet track record)
   - SlowMist (Asia timezone + wallet specialty)
   - One of Cure53 / OpenZeppelin depending on whether we want extension-depth or EVM-depth as a backstop
2. **Tier B as backup** if Tier A capacity is unavailable in our timeline.
3. **Tier C** for parallel/complementary engagements only (e.g., a Code4rena contest run during remediation gap).

---

## Pre-contact checklist (per firm)

Before sending the RFP, do all of:

- [ ] Visit firm website; confirm services page still lists relevant practice areas.
- [ ] Read most recent 2 public reports; check seniority of named auditors.
- [ ] Verify our scope (chains + HW) is within their stated practice.
- [ ] Confirm they accept private-repo / NDA engagements.
- [ ] Find a real contact email or sales form (not just a generic info@ if avoidable).
- [ ] Note any obvious conflict of interest (e.g., they audit a direct competitor we'd rather not signal to).
- [ ] Strip any internal notes from this file before sharing externally.

---

## Notes on what we'd NOT do

- **Do not** sole-source on price alone. Cheapest bid is almost always a junior team.
- **Do not** sign without named senior auditors with allocation %.
- **Do not** accept "we'll assign the team at kickoff" — names go in the SOW.
- **Do not** waive liability cap to zero; negotiate to industry norm (typically 1x-2x fee).
- **Do not** rely on a single firm for both software and HW — pair if needed.
