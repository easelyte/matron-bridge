# Vendored files

`approval-verify.mjs` is the journal's reference verifier for signed
approvals, copied unchanged from `tools/approval-verify.mjs` of
matron-journal at commit `d3b72ff`. `test/approval-gate.test.js` compares its
SHA-256 with a constant, so a local edit fails the tests. To update it, copy
the newer file over it and change the constant (and the commit named here)
in the same change. `test/fixtures/approval-vectors.json` is the journal's
shared test vector set from the same commit; its key is a throwaway.
