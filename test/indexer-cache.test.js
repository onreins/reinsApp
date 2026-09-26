/**
 * The indexer reads logs incrementally.
 *
 * Arc's public RPC caps each log query at 10k blocks and rate-limits bursts.
 * Rescanning from the deployment block on every refresh costs one request per
 * 10k blocks forever, and grows every hour the chain does. These tests pin
 * down that a repeat read costs nothing, new blocks cost only their own
 * windows, and a scan cut off by a rate limit resumes where it stopped.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { ArenaIndexer } from "../arena/indexer.js";

const ADDRESS = "0x991b8687aca6Acd6b92438bb4cE22866827bD632";

function stubClient({ failOnCall = null } = {}) {
  const calls = [];
  return {
    calls,
    getLogs: async ({ fromBlock, toBlock }) => {
      calls.push([fromBlock, toBlock]);
      if (failOnCall !== null && calls.length === failOnCall) {
        throw new Error("rate limit exceeded");
      }
      // One synthetic log at the first block of every window.
      return [{ blockNumber: fromBlock, marker: `${fromBlock}` }];
    },
  };
}

describe("incremental log reads", () => {
  test("a repeat read of the same range costs no requests", async () => {
    const client = stubClient();
    const ix = new ArenaIndexer({ publicClient: client, factory: ADDRESS, fromBlock: 0n });

    const first = await ix._logs({ address: ADDRESS, fromBlock: 0n, toBlock: 25_000n });
    const callsAfterFirst = client.calls.length;
    assert.equal(callsAfterFirst, 3, "0..25000 is three windows");

    const again = await ix._logs({ address: ADDRESS, fromBlock: 0n, toBlock: 25_000n });
    assert.equal(client.calls.length, callsAfterFirst, "nothing new to read");
    assert.deepEqual(again, first);
  });

  test("new blocks cost only their own windows", async () => {
    const client = stubClient();
    const ix = new ArenaIndexer({ publicClient: client, factory: ADDRESS, fromBlock: 0n });

    await ix._logs({ address: ADDRESS, fromBlock: 0n, toBlock: 25_000n });
    const before = client.calls.length;
    const logs = await ix._logs({ address: ADDRESS, fromBlock: 0n, toBlock: 25_600n });

    assert.equal(client.calls.length, before + 1, "600 new blocks is one request");
    assert.deepEqual(client.calls.at(-1), [25_001n, 25_600n]);
    assert.equal(logs.length, 4, "the old logs plus the new window's");
  });

  test("a scan cut off by a rate limit resumes where it stopped", async () => {
    const client = stubClient({ failOnCall: 2 });
    const ix = new ArenaIndexer({ publicClient: client, factory: ADDRESS, fromBlock: 0n });

    await assert.rejects(ix._logs({ address: ADDRESS, fromBlock: 0n, toBlock: 25_000n }), /rate limit/);
    assert.equal(client.calls.length, 2);

    const logs = await ix._logs({ address: ADDRESS, fromBlock: 0n, toBlock: 25_000n });
    const retried = client.calls.slice(2);
    assert.equal(retried[0][0], 10_000n, "the retry starts at the window that failed, not at genesis");
    assert.equal(logs.length, 3, "and the result is complete, with nothing duplicated");
  });

  test("an older bound returns only the logs up to it", async () => {
    const client = stubClient();
    const ix = new ArenaIndexer({ publicClient: client, factory: ADDRESS, fromBlock: 0n });
    await ix._logs({ address: ADDRESS, fromBlock: 0n, toBlock: 25_000n });
    const calls = client.calls.length;
    const early = await ix._logs({ address: ADDRESS, fromBlock: 0n, toBlock: 12_000n });
    assert.equal(client.calls.length, calls);
    assert.ok(early.every((l) => l.blockNumber <= 12_000n));
  });
});

describe("concurrent readers", () => {
  test("two reads of one address at once fetch each window once and return no duplicates", async () => {
    const client = stubClient();
    const ix = new ArenaIndexer({ publicClient: client, factory: ADDRESS, fromBlock: 0n });

    const [a, b] = await Promise.all([
      ix._logs({ address: ADDRESS, fromBlock: 0n, toBlock: 25_000n }),
      ix._logs({ address: ADDRESS, fromBlock: 0n, toBlock: 25_000n }),
    ]);

    assert.equal(client.calls.length, 3, "each window is fetched exactly once");
    assert.equal(a.length, 3);
    assert.equal(b.length, 3, "the second reader gets the same logs, not a doubled list");
  });
});
