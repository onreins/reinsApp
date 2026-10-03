/**
 * Keeps each hosted trading key able to pay for its trades.
 *
 * On Arc, gas is paid in USDC, the chain's native currency: about a cent a
 * trade. Any key below `low` is topped up to `high` from the gas wallet, within
 * two daily caps that live in the store, so a restart can't reset them:
 *
 *   perKeyCap   one key can't take more than this a day, so a key that burns
 *               gas (a hostile or broken agent) can't starve the others
 *   dailyCap    everything together, so nothing can drain the gas wallet
 *
 * A top-up counts as spent the moment it's sent, before its receipt: a receipt
 * that can't be read never leads to a second send. If the gas wallet runs low,
 * keys aren't topped up and their agents hold; nothing fails.
 *
 * Amounts are in the native currency's whole units (USDC on Arc, ETH on a local
 * test chain), 18 decimals on the wire.
 */
import { parseEther, formatEther } from "viem";

export function createGasKeeper({ publicClient, gasWallet, store, low = 0.1, high = 0.5, perKeyCap = 1, dailyCap = 5, now = () => new Date() }) {
  if (!(low < high)) throw new Error("the top-up line must be below the refill level");
  const lowWei = parseEther(String(low));
  const highWei = parseEther(String(high));
  const keyCapWei = parseEther(String(perKeyCap));
  const capWei = parseEther(String(dailyCap));

  async function topUpOne(address, day) {
    const balance = await publicClient.getBalance({ address });
    if (balance >= lowWei) return null;
    const want = highWei - balance;
    if (store.gasSpent(day, address) + want > keyCapWei) return { address, skipped: "this key's daily gas cap is reached" };
    if (store.gasSpent(day) + want > capWei) return { address, skipped: "the daily gas cap is reached" };
    const available = await publicClient.getBalance({ address: gasWallet.account.address });
    if (available < want) return { address, skipped: "the gas wallet is running low" };
    const hash = await gasWallet.sendTransaction({ to: address, value: want, account: gasWallet.account, chain: gasWallet.chain });
    store.recordGas({ day, address, wei: want, hash, at: now().getTime() });
    await publicClient.waitForTransactionReceipt({ hash });
    return { address, sent: formatEther(want), hash };
  }

  return {
    /** @returns {Promise<Array<{ address: string, sent?: string, hash?: string, skipped?: string, error?: string }>>} */
    async topUp(addresses) {
      const day = now().toISOString().slice(0, 10);
      const results = [];
      for (const address of addresses) {
        try {
          const r = await topUpOne(address, day);
          if (r) results.push(r);
        } catch (err) {
          results.push({ address, error: String(err?.shortMessage ?? err?.message ?? err).split("\n")[0] });
        }
      }
      return results;
    },
    /** For alerts: what's left in the gas wallet. */
    async walletBalance() {
      return Number(formatEther(await publicClient.getBalance({ address: gasWallet.account.address })));
    },
  };
}
