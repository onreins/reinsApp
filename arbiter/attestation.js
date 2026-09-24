/**
 * The on-chain form of a ruling.
 *
 * A full ruling (every test, its output, the reasons) is too big and too
 * free-form for a contract to read. What an escrow contract needs is small and
 * exact: for this case, what was decided, about which terms and which delivery,
 * and was it really Verdict who decided it. That is this EIP-712 attestation:
 *
 *   Ruling(bytes32 caseId, uint8 outcome, uint8 score,
 *          bytes32 rulingHash, bytes32 termsHash, bytes32 deliveryHash)
 *
 * - caseId       the escrow's own identifier for the dispute
 * - outcome      1 passed, 2 failed, 3 abstain
 * - rulingHash   hash of the full published ruling, so the details are one
 *                lookup away and can't be changed after the fact
 * - termsHash /
 *   deliveryHash the commitments the ruling was made against; the contract
 *                checks these equal what the two parties actually committed
 *
 * The domain includes the escrow contract's address and chain id, so an
 * attestation for one escrow can't be replayed against another.
 */
import { verifyTypedData } from "viem";

export const OUTCOME_CODE = { passed: 1, failed: 2, abstain: 3 };
export const OUTCOME_NAME = { 1: "passed", 2: "failed", 3: "abstain" };

export const RULING_TYPES = {
  Ruling: [
    { name: "caseId", type: "bytes32" },
    { name: "outcome", type: "uint8" },
    { name: "score", type: "uint8" },
    { name: "rulingHash", type: "bytes32" },
    { name: "termsHash", type: "bytes32" },
    { name: "deliveryHash", type: "bytes32" },
  ],
};

export const domainFor = ({ chainId, escrow }) => ({
  name: "Verdict",
  version: "1",
  chainId: Number(chainId),
  verifyingContract: escrow,
});

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Validate the escrow's attestation request; returns a normalised copy or throws. */
export function parseAttestRequest(attest) {
  if (attest === undefined || attest === null) return null;
  if (typeof attest !== "object") throw new TypeError("attest must be an object");
  const chainId = Number(attest.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new TypeError("attest.chainId must be a positive integer");
  }
  if (!ADDRESS.test(attest.escrow ?? "")) throw new TypeError("attest.escrow must be a contract address");
  if (!BYTES32.test(attest.caseId ?? "")) throw new TypeError("attest.caseId must be a 0x-prefixed bytes32");
  return { chainId, escrow: attest.escrow, caseId: attest.caseId };
}

/** Build the message an escrow will verify, from a sealed ruling. */
export function rulingMessage({ caseId, verdict, rulingHash }) {
  return {
    caseId,
    outcome: OUTCOME_CODE[verdict.outcome],
    score: Math.max(0, Math.min(100, Math.round(verdict.score ?? 0))),
    rulingHash,
    termsHash: verdict.specHash,
    deliveryHash: verdict.deliverableHash,
  };
}

/** Sign an attestation with the arbiter's key. */
export async function signAttestation({ account, attest, verdict, rulingHash }) {
  const domain = domainFor(attest);
  const message = rulingMessage({ caseId: attest.caseId, verdict, rulingHash });
  const signature = await account.signTypedData({
    domain,
    types: RULING_TYPES,
    primaryType: "Ruling",
    message,
  });
  return { domain, message, signature };
}

/** Check an attestation off-chain, exactly as the contract will on-chain. */
export function verifyAttestation({ address, domain, message, signature }) {
  return verifyTypedData({ address, domain, types: RULING_TYPES, primaryType: "Ruling", message, signature });
}
