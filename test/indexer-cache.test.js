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

describe("a saved snapshot of what was read", () => {
  test("a server seeded from a snapshot rereads nothing it covers", async () => {
    const first = new ArenaIndexer({ publicClient: stubClient(), factory: ADDRESS, fromBlock: 0n });
    const original = await first._logs({ address: ADDRESS, fromBlock: 0n, toBlock: 25_000n });
    const saved = JSON.parse(JSON.stringify(first.exportLogs())); // through JSON, as on disk

    const client = stubClient();
    const fresh = new ArenaIndexer({ publicClient: client, factory: ADDRESS, fromBlock: 0n });
    assert.equal(fresh.seedLogs(saved), 1);
    const logs = await fresh._logs({ address: ADDRESS, fromBlock: 0n, toBlock: 25_000n });

    assert.equal(client.calls.length, 0, "covered by the snapshot");
    assert.deepEqual(logs, original);
    assert.equal(typeof logs[0].blockNumber, "bigint");
  });

  test("blocks after the snapshot cost only their own windows", async () => {
    const first = new ArenaIndexer({ publicClient: stubClient(), factory: ADDRESS, fromBlock: 0n });
    await first._logs({ address: ADDRESS, fromBlock: 0n, toBlock: 25_000n });

    const client = stubClient();
    const fresh = new ArenaIndexer({ publicClient: client, factory: ADDRESS, fromBlock: 0n });
    fresh.seedLogs(JSON.parse(JSON.stringify(first.exportLogs())));
    await fresh._logs({ address: ADDRESS, fromBlock: 0n, toBlock: 25_600n });

    assert.deepEqual(client.calls, [[25_001n, 25_600n]]);
  });

  test("a snapshot from another factory or start block is ignored", async () => {
    const first = new ArenaIndexer({ publicClient: stubClient(), factory: ADDRESS, fromBlock: 0n });
    await first._logs({ address: ADDRESS, fromBlock: 0n, toBlock: 25_000n });
    const saved = JSON.parse(JSON.stringify(first.exportLogs()));

    const other = new ArenaIndexer({ publicClient: stubClient(), factory: "0x0000000000000000000000000000000000000001", fromBlock: 0n });
    assert.equal(other.seedLogs(saved), 0);
    const later = new ArenaIndexer({ publicClient: stubClient(), factory: ADDRESS, fromBlock: 5n });
    assert.equal(later.seedLogs(saved), 0);
    assert.equal(other.seedLogs(null), 0);
  });

  test("every bigint field of a real log survives the round trip", async () => {
    const log = { blockNumber: 7n, blockTimestamp: 1790000000n, logIndex: 2, transactionHash: "0xab", data: "0x", topics: [] };
    const client = { getLogs: async () => [log] };
    const first = new ArenaIndexer({ publicClient: client, factory: ADDRESS, fromBlock: 0n });
    await first._logs({ address: ADDRESS, fromBlock: 0n, toBlock: 10n });
    const saved = JSON.parse(JSON.stringify(first.exportLogs()));

    const fresh = new ArenaIndexer({ publicClient: stubClient(), factory: ADDRESS, fromBlock: 0n });
    fresh.seedLogs(saved);
    const [back] = await fresh._logs({ address: ADDRESS, fromBlock: 0n, toBlock: 10n });
    assert.deepEqual(back, log);
  });

  test("seeding never replaces a cache that has already read further", async () => {
    const old = new ArenaIndexer({ publicClient: stubClient(), factory: ADDRESS, fromBlock: 0n });
    await old._logs({ address: ADDRESS, fromBlock: 0n, toBlock: 5_000n });
    const saved = JSON.parse(JSON.stringify(old.exportLogs()));

    const client = stubClient();
    const live = new ArenaIndexer({ publicClient: client, factory: ADDRESS, fromBlock: 0n });
    await live._logs({ address: ADDRESS, fromBlock: 0n, toBlock: 25_000n });
    assert.equal(live.seedLogs(saved), 0);
    const calls = client.calls.length;
    await live._logs({ address: ADDRESS, fromBlock: 0n, toBlock: 25_000n });
    assert.equal(client.calls.length, calls);
  });
});
