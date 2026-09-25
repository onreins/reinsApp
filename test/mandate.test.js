/**
 * Mandate: an AI agent's dollar budget with rules it cannot break.
 *
 * Every test here is an attempt by the agent (or the market, or a hostile
 * exchange) to get past a rule, and the contract refusing it.
 */
import { test, before, describe } from "node:test";
import assert from "node:assert/strict";

import { publicClient, walletFor, account, waitForNode, localChain, expectRevert } from "./helpers.js";
import { artifact } from "../scripts/artifact.js";

const deployer = walletFor(0);
const owner = walletFor(1);
const agent = walletFor(2);
const stranger = walletFor(4);
const OWNER = account(1).address;
const AGENT = account(2).address;
const ZERO = "0x0000000000000000000000000000000000000000";

const M = artifact("Mandate");
// The factory can revert with errors raised inside the Mandate it deploys, so
// decode with both sets of error definitions.
const F = {
  ...artifact("MandateFactory"),
  abi: [...artifact("MandateFactory").abi, ...artifact("Mandate").abi.filter((x) => x.type === "error")],
};
const TOKEN = artifact("MockToken");
const FEED = artifact("MockFeed");
const VENUE = artifact("OracleVenue");

const USD = (n) => BigInt(Math.round(n * 1e6)); // 6-decimal USDC
const ETH_PRICE = 2_500n * 10n ** 8n;
const BTC_PRICE = 80_000n * 10n ** 8n;

let usdc, weth, wbtc, ethFeed, btcFeed, venue, factory;

async function deploy(name, args = []) {
  const { abi, bytecode } = artifact(name);
  const hash = await deployer.deployContract({ abi, bytecode, args, account: deployer.account, chain: localChain });
  return (await publicClient.waitForTransactionReceipt({ hash })).contractAddress;
}

async function send(wallet, address, abi, functionName, args = []) {
  const hash = await wallet.writeContract({ address, abi, functionName, args, account: wallet.account, chain: localChain });
  return publicClient.waitForTransactionReceipt({ hash });
}

const read = (address, abi, functionName, args = []) => publicClient.readContract({ address, abi, functionName, args });
const now = async () => (await publicClient.getBlock()).timestamp;
async function warp(seconds) {
  await publicClient.request({ method: "evm_increaseTime", params: [Number(seconds)] });
  await publicClient.request({ method: "evm_mine", params: [] });
}

/** A fresh mandate with sensible defaults; override any rule. */
async function makeMandate(overrides = {}, { deposit = USD(100), venueAddress = venue, tokens, feeds } = {}) {
  const rules = {
    maxTradeValue: USD(50),
    maxDrawdownBps: 2_000,
    maxSlippageBps: 100,
    expiresAt: (await now()) + 7n * 86_400n,
    maxPriceAge: 86_400,
    ...overrides,
  };
  const receipt = await send(owner, factory, F.abi, "create", [
    "test agent",
    AGENT,
    usdc,
    venueAddress,
    rules,
    tokens ?? [weth],
    feeds ?? [ethFeed],
  ]);
  const created = receipt.logs.find((l) => l.address.toLowerCase() === factory.toLowerCase());
  const mandate = `0x${created.topics[1].slice(26)}`;
  if (deposit) {
    await send(deployer, usdc, TOKEN.abi, "mint", [OWNER, deposit]);
    await send(owner, usdc, TOKEN.abi, "approve", [mandate, deposit]);
    await send(owner, mandate, M.abi, "deposit", [deposit]);
  }
  return mandate;
}

const trade = (m, tokenIn, tokenOut, amountIn, minOut = 0n, wallet = agent) =>
  send(wallet, m, M.abi, "trade", [tokenIn, tokenOut, amountIn, minOut]);
const equity = (m) => read(m, M.abi, "equity");
const bal = (token, who) => read(token, TOKEN.abi, "balanceOf", [who]);
const freshPrices = async () => {
  await send(deployer, ethFeed, FEED.abi, "set", [ETH_PRICE]);
  await send(deployer, btcFeed, FEED.abi, "set", [BTC_PRICE]);
};

before(async () => {
  await waitForNode();
  usdc = await deploy("MockToken", ["USDC", 6]);
  weth = await deploy("MockToken", ["WETH", 18]);
  wbtc = await deploy("MockToken", ["cirBTC", 8]);
  ethFeed = await deploy("MockFeed", [8, ETH_PRICE]);
  btcFeed = await deploy("MockFeed", [8, BTC_PRICE]);
  venue = await deploy("OracleVenue", [usdc, 6]);
  await send(deployer, venue, VENUE.abi, "list", [weth, ethFeed, 18]);
  await send(deployer, venue, VENUE.abi, "list", [wbtc, btcFeed, 8]);
  // Give the exchange plenty of inventory on every side.
  await send(deployer, usdc, TOKEN.abi, "mint", [venue, USD(10_000_000)]);
  await send(deployer, weth, TOKEN.abi, "mint", [venue, 10_000n * 10n ** 18n]);
  await send(deployer, wbtc, TOKEN.abi, "mint", [venue, 1_000n * 10n ** 8n]);
  factory = await deploy("MandateFactory");
});

describe("the happy path", () => {
  test("the factory records who owns the mandate and who the agent is", async () => {
    const m = await makeMandate();
    assert.equal((await read(m, M.abi, "owner")).toLowerCase(), OWNER.toLowerCase());
    assert.equal((await read(m, M.abi, "agent")).toLowerCase(), AGENT.toLowerCase());
    assert.equal(await read(m, M.abi, "baseline"), USD(100));
  });

  test("the agent trades at a fair price and equity is valued correctly", async () => {
    await freshPrices();
    const m = await makeMandate();
    await trade(m, usdc, weth, USD(50));
    assert.equal(await bal(weth, m), 2n * 10n ** 16n); // $50 at $2,500/ETH = 0.02 ETH
    assert.equal(await equity(m), USD(100));
  });

  test("values assets with other decimals too (8-decimal BTC)", async () => {
    await freshPrices();
    const m = await makeMandate({}, { tokens: [weth, wbtc], feeds: [ethFeed, btcFeed] });
    await trade(m, usdc, wbtc, USD(40));
    assert.equal(await bal(wbtc, m), 50_000n); // $40 / $80,000 = 0.0005 BTC
    assert.equal(await equity(m), USD(100));
  });
});

describe("rules the agent cannot break", () => {
  test("only the agent can trade", async () => {
    const m = await makeMandate();
    await expectRevert(trade(m, usdc, weth, USD(10), 0n, owner), "NotAgent");
    await expectRevert(trade(m, usdc, weth, USD(10), 0n, stranger), "NotAgent");
  });

  test("no trade larger than the size limit", async () => {
    const m = await makeMandate();
    await expectRevert(trade(m, usdc, weth, USD(50.01)), "TradeTooLarge");
  });

  test("no assets outside the mandate", async () => {
    const m = await makeMandate(); // only WETH allowed
    await expectRevert(trade(m, usdc, wbtc, USD(10)), "AssetNotAllowed");
  });

  test("no fills worse than the allowed slippage from the oracle price", async () => {
    await freshPrices();
    const m = await makeMandate(); // 1% max slippage
    await send(deployer, venue, VENUE.abi, "setEdge", [300]); // the exchange wants 3%
    try {
      await expectRevert(trade(m, usdc, weth, USD(20)), "slippage");
    } finally {
      await send(deployer, venue, VENUE.abi, "setEdge", [0]);
    }
  });

  test("small losses per trade can't add up past the loss limit", async () => {
    await freshPrices();
    // 3% loss limit; every round trip leaks ~1.8% of $50 at a 0.9% edge.
    const m = await makeMandate({ maxDrawdownBps: 300 });
    await send(deployer, venue, VENUE.abi, "setEdge", [90]);
    try {
      let refused = false;
      for (let i = 0; i < 10 && !refused; i++) {
        try {
          await trade(m, usdc, weth, USD(50));
          await trade(m, weth, usdc, await bal(weth, m));
        } catch (err) {
          assert.match(`${err.shortMessage} ${err.message}`, /DrawdownLimit/);
          refused = true;
        }
      }
      assert.ok(refused, "the drain was stopped");
      assert.ok((await equity(m)) >= (await read(m, M.abi, "floor")), "equity never went below the floor");
    } finally {
      await send(deployer, venue, VENUE.abi, "setEdge", [0]);
    }
  });

  test("no trading on stale prices", async () => {
    await freshPrices();
    const m = await makeMandate({ maxPriceAge: 3_600 });
    await send(deployer, ethFeed, FEED.abi, "setUpdatedAt", [(await now()) - 7_200n]);
    try {
      await expectRevert(trade(m, usdc, weth, USD(10)), "StalePrice");
    } finally {
      await freshPrices();
    }
  });

  test("no trading after the mandate expires", async () => {
    const m = await makeMandate({ expiresAt: (await now()) + 600n });
    await warp(601);
    await freshPrices(); // keep prices fresh after the warp, so expiry is the only reason
    await expectRevert(trade(m, usdc, weth, USD(10)), "MandateExpired");
  });

  test("the agent has no way to take money out", async () => {
    const m = await makeMandate();
    await expectRevert(send(agent, m, M.abi, "withdraw", [usdc, USD(1)]), "NotOwner");
    await expectRevert(send(agent, m, M.abi, "withdrawAll"), "NotOwner");
    await expectRevert(send(agent, m, M.abi, "setAgent", [account(5).address]), "NotOwner");
    await expectRevert(send(agent, m, M.abi, "unfreeze"), "NotOwner");
  });
});

describe("the public stop-loss", () => {
  test("when the market drops past the limit, anyone can freeze the agent", async () => {
    await freshPrices();
    const m = await makeMandate();
    await trade(m, usdc, weth, USD(50));
    await expectRevert(send(stranger, m, M.abi, "checkpoint"), "NotBreached");

    await send(deployer, ethFeed, FEED.abi, "set", [ETH_PRICE / 2n]); // ETH halves: equity $75 < floor $80
    try {
      await send(stranger, m, M.abi, "checkpoint");
      assert.equal(await read(m, M.abi, "frozen"), true);
      await expectRevert(trade(m, weth, usdc, 10n ** 15n), "IsFrozen");

      // The owner decides: resume, measuring losses from here.
      await send(owner, m, M.abi, "unfreeze");
      assert.equal(await read(m, M.abi, "frozen"), false);
      assert.equal(await read(m, M.abi, "baseline"), await equity(m));
    } finally {
      await freshPrices();
    }
  });
});

describe("the owner stays in control", () => {
  test("partial withdrawals shrink the loss baseline in proportion", async () => {
    await freshPrices();
    const m = await makeMandate();
    await send(owner, m, M.abi, "withdraw", [usdc, USD(40)]);
    assert.equal(await read(m, M.abi, "baseline"), USD(60));
    await trade(m, usdc, weth, USD(50)); // still inside the rules after the withdrawal
  });

  test("withdrawAll returns everything and removes the agent", async () => {
    await freshPrices();
    const m = await makeMandate();
    await trade(m, usdc, weth, USD(30));
    const usdcBefore = await bal(usdc, OWNER);
    const wethBefore = await bal(weth, OWNER);
    await send(owner, m, M.abi, "withdrawAll");
    assert.equal(await bal(usdc, m), 0n);
    assert.equal(await bal(weth, m), 0n);
    assert.equal((await bal(usdc, OWNER)) - usdcBefore, USD(70));
    assert.equal((await bal(weth, OWNER)) - wethBefore, 12n * 10n ** 15n); // $30 of ETH came back too
    assert.equal(await read(m, M.abi, "agent"), ZERO);
    await expectRevert(trade(m, usdc, weth, USD(1)), "NotAgent");
  });

  test("revoking the agent stops it immediately", async () => {
    const m = await makeMandate();
    await send(owner, m, M.abi, "setAgent", [ZERO]);
    await expectRevert(trade(m, usdc, weth, USD(1)), "NotAgent");
  });
});

describe("hostile exchanges", () => {
  test("an exchange that takes the tokens and sends nothing is caught", async () => {
    await freshPrices();
    const thief = await deploy("ThiefVenue");
    const m = await makeMandate({}, { venueAddress: thief });
    await expectRevert(trade(m, usdc, weth, USD(10)), "PriceTooLow");
    assert.equal(await bal(usdc, m), USD(100), "nothing was lost");
  });

  test("an exchange can't call back into the mandate mid-trade", async () => {
    await freshPrices();
    const evil = await deploy("ReenteringVenue");
    const m = await makeMandate({}, { venueAddress: evil });
    await send(deployer, evil, artifact("ReenteringVenue").abi, "aim", [m, usdc, weth, false]);
    await expectRevert(trade(m, usdc, weth, USD(10)), "Reentrancy");
  });

  test("an exchange can't trip the stop-loss mid-swap, while balances look low", async () => {
    await freshPrices();
    const evil = await deploy("ReenteringVenue");
    const m = await makeMandate({}, { venueAddress: evil });
    await send(deployer, evil, artifact("ReenteringVenue").abi, "aim", [m, usdc, weth, true]);
    await expectRevert(trade(m, usdc, weth, USD(10)), "Reentrancy");
    assert.equal(await read(m, M.abi, "frozen"), false);
  });
});

describe("the owner's exit never depends on an oracle", () => {
  test("a stale feed doesn't block a normal withdrawal", async () => {
    await freshPrices();
    const m = await makeMandate({ maxPriceAge: 3_600 });
    await trade(m, usdc, weth, USD(30)); // now holds an asset whose feed will go stale
    await send(deployer, ethFeed, FEED.abi, "setUpdatedAt", [(await now()) - 7_200n]);
    try {
      const before = await bal(usdc, OWNER);
      await send(owner, m, M.abi, "withdraw", [usdc, USD(20)]);
      assert.equal((await bal(usdc, OWNER)) - before, USD(20));
      await expectRevert(trade(m, usdc, weth, USD(1)), "StalePrice"); // but the agent still can't trade blind
    } finally {
      await freshPrices();
    }
  });

  test("a broken feed doesn't block withdrawals, and the asset can be dropped", async () => {
    await freshPrices();
    const m = await makeMandate();
    await trade(m, usdc, weth, USD(30));
    await send(deployer, ethFeed, FEED.abi, "setBroken", [true]);
    try {
      await send(owner, m, M.abi, "withdraw", [usdc, USD(10)]);
      const wethBefore = await bal(weth, OWNER);
      await send(owner, m, M.abi, "removeAsset", [weth]);
      assert.equal((await bal(weth, OWNER)) - wethBefore, 12n * 10n ** 15n, "the stranded ETH came home");
      assert.deepEqual(await read(m, M.abi, "assetList"), []);
    } finally {
      await send(deployer, ethFeed, FEED.abi, "setBroken", [false]);
    }
    await expectRevert(trade(m, usdc, weth, USD(1)), "AssetNotAllowed");
    await expectRevert(send(agent, m, M.abi, "removeAsset", [weth]), "NotOwner");
  });
});

describe("bad configurations are refused", () => {
  const create = async (overrides, agentAddress = AGENT) =>
    send(owner, factory, F.abi, "create", [
      "bad",
      agentAddress,
      usdc,
      venue,
      {
        maxTradeValue: USD(50),
        maxDrawdownBps: 2_000,
        maxSlippageBps: 100,
        expiresAt: (await now()) + 86_400n,
        maxPriceAge: 86_400,
        ...overrides,
      },
      [weth],
      [ethFeed],
    ]);

  test("the owner can't also be the agent", async () => {
    await expectRevert(create({}, OWNER), "BadConfig");
  });
  test("slippage above 10% is refused", async () => {
    await expectRevert(create({ maxSlippageBps: 1_001 }), "BadConfig");
  });
  test("a loss limit of zero is refused", async () => {
    await expectRevert(create({ maxDrawdownBps: 0 }), "BadConfig");
  });
  test("an already-expired mandate is refused", async () => {
    await expectRevert(create({ expiresAt: (await now()) - 1n }), "BadConfig");
  });
});
