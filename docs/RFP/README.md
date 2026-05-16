# External Engagement Documents — Worker's Wallet (노동자의 지갑)

This folder contains the draft external-engagement documents for the Worker's Wallet project: one **security audit RFP**, one **internal audit-firms shortlist**, and one **Korean legal engagement brief**. All four documents are find-and-replace ready — search for `[PLACEHOLDER]` strings and fill them in before sending.

---

## Documents

| File | Audience | Language | Status |
|---|---|---|---|
| `security-audit-rfp.md` | International audit firms (Trail of Bits, Halborn, SlowMist, Cure53, OpenZeppelin, etc.) | English | Draft, needs placeholders filled |
| `audit-firms-shortlist.md` | **Internal only** — do not share with bidders | English | Draft, verify firm capabilities before contact |
| `legal-engagement-brief.md` | Korean law firms with 가상자산 (virtual-asset) practice | Korean primary, English summary | Draft, needs placeholders filled |
| `README.md` | Internal navigation (this file) | English | — |

---

## Intended workflow

### Track A — Security audit (parallel to Track B)

1. **Verify the shortlist** in `audit-firms-shortlist.md`. Visit each firm's website, confirm specialty match, find a real sales contact. Remove "TBD verify" annotations.
2. **Fill placeholders** in `security-audit-rfp.md`:
   - `[YOUR_EMAIL]`, `[YOUR_NAME]`, `[YOUR_TITLE]`, `[COMPANY_LEGAL_NAME]`, `[COMPANY_SHORT_NAME]`
   - All `[YYYY-MM-DD]` date fields per the offset table in section 8
   - `[PGP_FINGERPRINT]`, `[SIGNAL_HANDLE_OR_NUMBER]`, `[PROTON_ADDRESS_PLACEHOLDER]`, `[NDA_LINK_OR_ATTACHMENT]`, `[TRANSPORT_METHOD]`
3. **Send to 3-5 firms simultaneously.** Recommended initial set:
   - Trail of Bits (tooling + embedded)
   - Halborn (wallet track record)
   - SlowMist (Asia timezone + wallet specialty)
   - Cure53 OR OpenZeppelin (UI-shell-depth vs EVM-depth backstop)
4. **Q&A round (10 days)** — compile all firms' questions, redistribute answers to all bidders weekly.
5. **Proposals due (T+14 days)** — compare against weighted criteria in RFP section 7.
6. **Selection (T+28 days)** — notify winner; politely decline others.
7. **MSA + SOW signed (T+35 days)** → **Kickoff (T+45 days)**.

### Track B — Legal engagement (parallel to Track A)

1. **Verify Korean firm practice areas** — confirm 가상자산 팀 currently active at each candidate (율촌, 김앤장, 광장, 세종, 디라이트). Strip "verify" annotations as confirmed.
2. **Fill placeholders** in `legal-engagement-brief.md`:
   - `[COMPANY_LEGAL_NAME_KR]`, `[COMPANY_LEGAL_NAME_EN]`, `[CEO_NAME]`, `[BUSINESS_REGISTRATION_NUMBER]`, `[REGISTERED_ADDRESS_KR]`
   - `[YOUR_NAME]`, `[YOUR_TITLE]`, `[YOUR_EMAIL]`, `[YOUR_PHONE]`, `[PGP_FINGERPRINT]`
   - `[YYYY-MM-DD]` date fields
   - `[NDA_TEMPLATE_LINK]`
3. **Initial outreach: 1-2 firms** (suggest one large firm + one boutique). First meeting is usually free or low-cost.
4. **First meeting (week 1)** — present the brief, hear high-level fee estimates and timeline.
5. **Choose firm, sign engagement letter (week 2-3)**.
6. **1차 의견서 (의견서) drafting** — 4-6 weeks.
7. **Receive opinion, internal review, follow-up Q&A**.

### Critical sequencing constraint

**The legal opinion (Track B) must be received BEFORE marketing launch**, even if the security audit (Track A) is still in remediation. Marketing without an opinion on:

- 가상자산이용자보호법 신고 의무
- 보험업법 모집인 자격 (insurance referral revenue)
- 가상자산 광고 가이드라인

— exposes us to regulatory enforcement risk that cannot be cured by post-launch fixes.

The audit can finish later (and ideally before any HW device ships, with software launch acceptable on a remediated SDK without final report).

---

## Find-and-replace placeholder inventory

Across all four documents, placeholders use the `[PLACEHOLDER]` format. Common ones to fill globally:

- `[YOUR_NAME]`, `[YOUR_TITLE]`, `[YOUR_EMAIL]`, `[YOUR_PHONE]`
- `[COMPANY_LEGAL_NAME]`, `[COMPANY_LEGAL_NAME_KR]`, `[COMPANY_LEGAL_NAME_EN]`, `[COMPANY_SHORT_NAME]`
- `[CEO_NAME]`, `[BUSINESS_REGISTRATION_NUMBER]`, `[REGISTERED_ADDRESS_KR]`
- `[YYYY-MM-DD]` (many — date offsets given inline in each doc)
- `[PGP_FINGERPRINT]`, `[SIGNAL_HANDLE_OR_NUMBER]`, `[PROTON_ADDRESS_PLACEHOLDER]`
- `[NDA_LINK_OR_ATTACHMENT]`, `[NDA_TEMPLATE_LINK]`
- `[TRANSPORT_METHOD]`

After find-replace, do a final pass for any remaining `[` `]` brackets to catch stragglers.

---

## What's intentionally *not* in these documents

- **Firm-specific pricing** — only ranges, never firm-named quotes.
- **Specific commitments** — everything is framed as "considering" or "may engage".
- **Internal financial figures** — budget envelopes (USD 50-150k) are stated as guidance; actual cap will be set in the SOW.
- **Audit findings** — we have no audit yet; nothing claimed about security posture beyond test counts and dependency audit cleanliness.
- **Legal conclusions** — we list questions, not answers; the law firm provides answers.

---

## Reference docs (attached to outbound engagements)

- `../ARCHITECTURE.md` — system architecture, trust boundaries (both audit + legal)
- `../PLAN.md` — roadmap, security goals (both)
- `../INSURANCE.md` — insurance design (legal 3.2 — 보험모집인 자격)
- `../CHANGELOG.md` — commit history (audit kickoff package)
