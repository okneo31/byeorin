import { readFileSync, existsSync } from "node:fs";

const OUT = "D:/TTLCOINWalet/scripts/bip157-live/out";
const fixture = JSON.parse(readFileSync(`${OUT}/fixture.json`, "utf8"));

const normRecord = (r) => ({
  height: r.height,
  txid: r.txid,
  receivedOutputs: [...r.receivedOutputs]
    .map((o) => ({ vout: o.vout, value: String(o.value), spk: o.scriptPubKeyHex }))
    .sort((a, b) => a.vout - b.vout),
  spentOutpoints: [...r.spentOutpoints]
    .map((s) => `${s.txid}:${s.vout}`)
    .sort(),
});
const normSet = (records) =>
  JSON.stringify(
    [...records].map(normRecord).sort((a, b) => a.height - b.height || a.txid.localeCompare(b.txid))
  );

const runs = [];
for (let i = 0; i < 10; i++) {
  const p = `${OUT}/result-${i}.json`;
  if (!existsSync(p)) { runs.push({ i, missing: true }); continue; }
  const j = JSON.parse(readFileSync(p, "utf8"));
  runs.push({ i, j });
}

const success = runs.filter((r) => !r.missing && r.j.ok === true);
const failed = runs.filter((r) => r.missing || r.j.ok !== true);

const discrepancies = [];

// 1. records identical
const sets = success.map((r) => normSet(r.j.records));
const recordsIdentical = sets.every((s) => s === sets[0]);
if (!recordsIdentical) {
  const uniq = [...new Set(sets)];
  discrepancies.push(`records set mismatch: ${uniq.length} distinct sets among successes`);
  success.forEach((r, k) => {
    if (sets[k] !== sets[0]) discrepancies.push(`run ${r.i} records differ from run ${success[0].i}`);
  });
}

// 2. tipHeight/tipHash
const tipOk = success.every(
  (r) => r.j.tipHeight === fixture.stopAtHeight && r.j.tipHash === success[0].j.tipHash
);
const tipHashSet = [...new Set(success.map((r) => r.j.tipHash))];
success.forEach((r) => {
  if (r.j.tipHeight !== fixture.stopAtHeight)
    discrepancies.push(`run ${r.i}: tipHeight ${r.j.tipHeight} != stopAtHeight ${fixture.stopAtHeight}`);
});
if (tipHashSet.length !== 1) discrepancies.push(`tipHash not identical: ${tipHashSet.join(", ")}`);
if (fixture.meta?.tipHash && tipHashSet[0] !== fixture.meta.tipHash)
  discrepancies.push(`tipHash ${tipHashSet[0]} != fixture.meta.tipHash ${fixture.meta.tipHash}`);

// 3. expected txids present in all successes
let expectedFoundInAll = true;
for (const r of success) {
  const txids = new Set(r.j.records.map((x) => x.txid));
  for (const e of fixture.expected) {
    if (!txids.has(e.txid)) {
      expectedFoundInAll = false;
      discrepancies.push(`run ${r.i}: expected txid ${e.txid} missing from records`);
    } else {
      const rec = r.j.records.find((x) => x.txid === e.txid);
      if (rec.height !== e.height) {
        expectedFoundInAll = false;
        discrepancies.push(`run ${r.i}: txid ${e.txid} at height ${rec.height}, expected ${e.height}`);
      }
    }
  }
}

// 4. scannedFilterCount
const wantScan = fixture.stopAtHeight - fixture.checkpoint.height;
for (const r of success) {
  if (r.j.scannedFilterCount !== wantScan)
    discrepancies.push(`run ${r.i}: scannedFilterCount ${r.j.scannedFilterCount} != ${wantScan}`);
}

// 5. failed run classification
for (const r of failed) {
  if (r.missing) discrepancies.push(`run ${r.i}: result file missing (부대 전멸)`);
  else discrepancies.push(`run ${r.i}: ok=false error=${r.j.error}`);
}

const summary = success.map((r) => ({
  i: r.i,
  host: r.j.host,
  tipHeight: r.j.tipHeight,
  tipHashShort: r.j.tipHash.slice(-8),
  scanned: r.j.scannedFilterCount,
  matched: r.j.matchedBlockCount,
  records: r.j.records.length,
  expectedFound: r.j.expectedFound?.length,
  expectedMissing: r.j.expectedMissing?.length,
  recordsEqualRun0: sets[success.indexOf(r)] === sets[0],
}));

console.log(JSON.stringify({
  successRuns: success.length,
  failedRuns: failed.length,
  recordsIdentical,
  tipOk,
  tipHashIdentical: tipHashSet.length === 1,
  expectedFoundInAll,
  wantScan,
  discrepancies,
  summary,
}, null, 2));
