/**
 * Verdict — a neutral evaluator for agent work.
 *
 * Holds the `evaluator` seat in an ERC-8183 job, and answers ERC-8004
 * validation requests. Given a job whose spec says "this code must pass these
 * tests", it fetches the submission, checks it against what was committed
 * on-chain, re-runs it in a sandbox, and releases or refuses the escrow.
 *
 * The reason this role has to exist: ERC-8183 lets the client name anyone as
 * evaluator, and Circle's own quickstart names the *client*. A buyer who
 * judges their own purchase can reject good work and reclaim the escrow, so
 * no provider should accept those terms once real money is involved. The seat
 * needs an occupant with no stake in the outcome.
 *
 * What makes this checkable rather than merely trusted:
 *  - Every document is content-addressed and its hash committed on-chain
 *    before evaluation, so neither side can swap content afterwards.
 *  - Every verdict is published in full — the tests, the output, the reasons —
 *    and signed, so either party can re-run the evaluation and compare.
 *  - When the evaluator cannot verify something, it abstains rather than
 *    guessing. See `OUTCOME.ABSTAIN` in verify.js.
 */
import { decodeFunctionData, decodeEventLog } from "viem";

import { AGENTIC_COMMERCE_ABI, VALIDATION_REGISTRY_ABI, JOB_STATUS } from "./abi.js";
import { evaluate, sealVerdict, OUTCOME } from "./verify.js";
import { parseJobDescription, decodeDeliverableUri, hashDocument } from "./spec.js";

export { OUTCOME };

/**
 * Arc's public RPC refuses `eth_getLogs` ranges of 10,000 blocks or more
 * ("requested range too large"). At ~0.5s blocks that is about 83 minutes of
 * chain, so any watcher looking further back than that must page.
 */
export const LOG_WINDOW = 9_999n;

/** Split [from, to] into inclusive windows no wider than `size` blocks apart. */
export function logWindows(from, to, size = LOG_WINDOW) {
  if (to < from) return [];
  const out = [];
  for (let lo = from; lo <= to; lo += size + 1n) {
    const hi = lo + size > to ? to : lo + size;
    out.push([lo, hi]);
  }
  return out;
}

export class Evaluator {
  /**
   * @param {object} opts
   * @param {object} opts.publicClient
   * @param {object} opts.wallet          The evaluator's wallet — holds the seat.
   * @param {`0x${string}`} [opts.jobs]   ERC-8183 contract address.
   * @param {`0x${string}`} [opts.validation] ERC-8004 ValidationRegistry address.
   * @param {(doc) => Promise<string>} [opts.publish] Publishes a verdict, returns its URI.
   * @param {string} [opts.backend]       Sandbox backend override.
   * @param {object} [opts.resolveOpts]   Passed to the document resolver.
   * @param {boolean} [opts.dryRun]       Evaluate but never send a transaction.
   */
  constructor({
    publicClient,
    wallet,
    jobs,
    validation,
    publish,
    backend,
    resolveOpts,
    dryRun = false,
  }) {
    this.publicClient = publicClient;
    this.wallet = wallet;
    this.jobs = jobs;
    this.validation = validation;
    this.publish = publish ?? (async () => null);
    this.backend = backend;
    this.resolveOpts = resolveOpts;
    this.dryRun = dryRun;

    this.address = wallet.account.address;
    this.handled = new Set();
    this.log = [];
  }

  /**
   * `getLogs`, paged into windows the RPC will accept. Same parameters and
   * result shape, but a wide range becomes several narrow queries instead of
   * an error.
   */
  async #logs({ fromBlock = 0n, toBlock = "latest", ...rest }) {
    // cacheTime: 0 matters. viem caches getBlockNumber for ~4s by default, and
    // at Arc's 0.5s blocks a cached head is ~8 blocks stale — enough to page
    // right past a submission made moments ago and report it missing.
    const to =
      toBlock === "latest" ? await this.publicClient.getBlockNumber({ cacheTime: 0 }) : toBlock;
    const out = [];
    for (const [lo, hi] of logWindows(fromBlock, to)) {
      out.push(...(await this.publicClient.getLogs({ ...rest, fromBlock: lo, toBlock: hi })));
    }
    return out;
  }

  #record(entry) {
    this.log.push({ at: new Date().toISOString(), ...entry });
    return entry;
  }

  // -------------------------------------------------------------------------
  // ERC-8183 jobs
  // -------------------------------------------------------------------------

  /**
   * Recover the deliverable URI from the submitting transaction.
   *
   * `JobSubmitted` carries only the hash, and `getJob` does not expose
   * `optParams`, so the URI has to come from the calldata of the `submit`
   * call itself. Faithful to the published interface rather than requiring a
   * contract change.
   */
  async deliverableUriForJob(jobId, { fromBlock = 0n } = {}) {
    const logs = await this.#logs({
      address: this.jobs,
      event: AGENTIC_COMMERCE_ABI.find((e) => e.type === "event" && e.name === "JobSubmitted"),
      args: { jobId },
      fromBlock,
      toBlock: "latest",
    });
    if (logs.length === 0) return null;

    const tx = await this.publicClient.getTransaction({
      hash: logs[logs.length - 1].transactionHash,
    });
    try {
      const { functionName, args } = decodeFunctionData({
        abi: AGENTIC_COMMERCE_ABI,
        data: tx.input,
      });
      if (functionName !== "submit") return null;
      return decodeDeliverableUri(args[2]);
    } catch {
      return null;
    }
  }

  /**
   * Evaluate one job and act on the result.
   *
   * Idempotent per job: a job already handled in this process is skipped, and
   * the on-chain status is re-read before acting so a restart cannot
   * double-settle.
   */
  async handleJob(jobId, { fromBlock = 0n } = {}) {
    const key = `job:${jobId}`;
    if (this.handled.has(key)) return this.#record({ jobId, skipped: "already handled" });

    const job = await this.publicClient.readContract({
      address: this.jobs,
      abi: AGENTIC_COMMERCE_ABI,
      functionName: "getJob",
      args: [jobId],
    });

    if (job.evaluator.toLowerCase() !== this.address.toLowerCase()) {
      return this.#record({ jobId, skipped: "not our seat", evaluator: job.evaluator });
    }
    if (JOB_STATUS[job.status] !== "Submitted") {
      return this.#record({ jobId, skipped: `status is ${JOB_STATUS[job.status]}` });
    }

    // What did the client actually ask for?
    let pointer;
    try {
      pointer = parseJobDescription(job.description);
    } catch (err) {
      const verdict = await this.#abstain(jobId, `job description unusable: ${err.message}`, err.code);
      return this.#record({ jobId, outcome: OUTCOME.ABSTAIN, verdict, acted: false });
    }

    const deliverableHash = await this.publicClient.readContract({
      address: this.jobs,
      abi: [
        {
          type: "function",
          name: "deliverableOf",
          stateMutability: "view",
          inputs: [{ name: "", type: "uint256" }],
          outputs: [{ name: "", type: "bytes32" }],
        },
      ],
      functionName: "deliverableOf",
      args: [jobId],
    }).catch(() => null);

    const deliverableUri = await this.deliverableUriForJob(jobId, { fromBlock });

    const verdict = await evaluate({
      specUri: pointer.uri,
      specHash: pointer.hash,
      deliverableUri,
      deliverableHash,
      jobId: jobId.toString(),
      backend: this.backend,
      resolveOpts: this.resolveOpts,
      evaluator: this.address,
    });

    const sealed = await sealVerdict(verdict, this.wallet);
    const uri = await this.publish(sealed);

    // Abstain leaves the escrow untouched; the job's own expiry refunds the
    // client without us taking a side.
    if (verdict.outcome === OUTCOME.ABSTAIN) {
      this.handled.add(key);
      return this.#record({ jobId, outcome: verdict.outcome, verdict, uri, acted: false });
    }

    let txHash = null;
    if (!this.dryRun) {
      const fn = verdict.outcome === OUTCOME.PASSED ? "complete" : "reject";
      txHash = await this.wallet.writeContract({
        address: this.jobs,
        abi: AGENTIC_COMMERCE_ABI,
        functionName: fn,
        args: [jobId, sealed.hash, "0x"],
        chain: this.wallet.chain,
        account: this.wallet.account,
      });
      await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    }

    this.handled.add(key);
    return this.#record({
      jobId,
      outcome: verdict.outcome,
      score: verdict.score,
      verdict,
      uri,
      txHash,
      acted: !this.dryRun,
    });
  }

  async #abstain(jobId, reason, code) {
    const verdict = {
      spec: "verdict-result/1",
      jobId: jobId?.toString() ?? null,
      outcome: OUTCOME.ABSTAIN,
      score: 0,
      reason,
      code,
      tests: [],
      evaluator: this.address,
      evaluatedAt: new Date().toISOString(),
    };
    const sealed = await sealVerdict(verdict, this.wallet);
    await this.publish(sealed);
    return verdict;
  }

  // -------------------------------------------------------------------------
  // ERC-8004 validation
  // -------------------------------------------------------------------------

  /**
   * Answer a validation request addressed to us.
   *
   * The request URI points at a document naming the spec and the work to
   * check. We re-run it and post a 0-100 score.
   */
  async handleValidationRequest(requestHash, { requestUri } = {}) {
    const key = `val:${requestHash}`;
    if (this.handled.has(key)) return this.#record({ requestHash, skipped: "already handled" });

    const [validatorAddress, agentId, existing] = await this.publicClient.readContract({
      address: this.validation,
      abi: VALIDATION_REGISTRY_ABI,
      functionName: "getValidationStatus",
      args: [requestHash],
    });

    if (validatorAddress.toLowerCase() !== this.address.toLowerCase()) {
      return this.#record({ requestHash, skipped: "not addressed to us" });
    }
    if (existing !== 0) {
      return this.#record({ requestHash, skipped: `already answered with ${existing}` });
    }

    let uri = requestUri;
    if (!uri) uri = await this.#requestUriFromLogs(requestHash);
    if (!uri) {
      return this.#record({ requestHash, skipped: "no request uri found" });
    }

    // The request document points at the spec and the deliverable, and is
    // itself committed to by requestHash.
    const { resolve } = await import("./verify.js");
    let request;
    try {
      request = await resolve(uri, this.resolveOpts);
    } catch (err) {
      return this.#record({ requestHash, skipped: `request unfetchable: ${err.message}` });
    }

    const verdict = await evaluate({
      specUri: request.specUri,
      specHash: request.specHash,
      deliverableUri: request.deliverableUri,
      deliverableHash: request.deliverableHash,
      agentId: agentId.toString(),
      backend: this.backend,
      resolveOpts: this.resolveOpts,
      evaluator: this.address,
    });

    const sealed = await sealVerdict(verdict, this.wallet);
    const responseUri = (await this.publish(sealed)) ?? "";

    if (verdict.outcome === OUTCOME.ABSTAIN) {
      this.handled.add(key);
      return this.#record({ requestHash, outcome: verdict.outcome, verdict, acted: false });
    }

    let txHash = null;
    if (!this.dryRun) {
      txHash = await this.wallet.writeContract({
        address: this.validation,
        abi: VALIDATION_REGISTRY_ABI,
        functionName: "validationResponse",
        args: [requestHash, verdict.score, responseUri, sealed.hash, "verdict"],
        chain: this.wallet.chain,
        account: this.wallet.account,
      });
      await this.publicClient.waitForTransactionReceipt({ hash: txHash });
    }

    this.handled.add(key);
    return this.#record({
      requestHash,
      agentId: agentId.toString(),
      outcome: verdict.outcome,
      score: verdict.score,
      verdict,
      txHash,
      acted: !this.dryRun,
    });
  }

  async #requestUriFromLogs(requestHash, fromBlock = 0n) {
    const logs = await this.#logs({
      address: this.validation,
      event: VALIDATION_REGISTRY_ABI.find((e) => e.type === "event" && e.name === "ValidationRequest"),
      args: { requestHash },
      fromBlock,
      toBlock: "latest",
    });
    return logs.length ? logs[logs.length - 1].args.requestURI : null;
  }

  // -------------------------------------------------------------------------
  // Watching
  // -------------------------------------------------------------------------

  /**
   * Scan a block range for work addressed to us and handle it.
   *
   * Returns everything it did, so a caller can poll on whatever cadence suits
   * the chain. Arc's public RPC refuses wide `eth_getLogs` ranges, so keep the
   * window small or use a provider that indexes.
   */
  async scan({ fromBlock = 0n, toBlock = "latest" } = {}) {
    const results = [];

    if (this.jobs) {
      const submitted = await this.#logs({
        address: this.jobs,
        event: AGENTIC_COMMERCE_ABI.find((e) => e.type === "event" && e.name === "JobSubmitted"),
        fromBlock,
        toBlock,
      });
      for (const log of submitted) {
        results.push(await this.handleJob(log.args.jobId, { fromBlock }));
      }
    }

    if (this.validation) {
      const requests = await this.#logs({
        address: this.validation,
        event: VALIDATION_REGISTRY_ABI.find((e) => e.type === "event" && e.name === "ValidationRequest"),
        args: { validatorAddress: this.address },
        fromBlock,
        toBlock,
      });
      for (const log of requests) {
        results.push(
          await this.handleValidationRequest(log.args.requestHash, {
            requestUri: log.args.requestURI,
          }),
        );
      }
    }

    return results;
  }
}

export { hashDocument, decodeEventLog };
