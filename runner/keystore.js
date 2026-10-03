/**
 * Trading keys for hosted agents, generated here and stored only encrypted.
 *
 * A trading key can trade inside its agent's limits and has no way to move
 * money out, so losing one is bounded by the owner's stop-loss. Still, they are
 * treated as secrets: AES-256-GCM under a master key that lives in the host's
 * secret store, a fresh random IV per key, and the key's own address as
 * associated data, so a record swapped onto another row, or tampered with,
 * fails to open instead of signing with the wrong key. The plain key exists
 * only inside open() and the viem account built from it; the buffer holding it
 * is zeroed straight after.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const aad = (address) => Buffer.from(String(address).toLowerCase(), "utf8");

/** @param {{ masterKey: Buffer }} p */
export function createKeystore({ masterKey }) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== KEY_BYTES) throw new Error("the master key must be 32 bytes");

  function seal(privateKey, address) {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, masterKey, iv);
    cipher.setAAD(aad(address));
    const plain = Buffer.from(privateKey.slice(2), "hex");
    const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
    plain.fill(0);
    return { enc: enc.toString("hex"), iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex") };
  }

  /** The plain key for `address`. Throws if the record was tampered with, belongs to another address, or the master key is wrong. */
  function open(sealed, address) {
    const decipher = createDecipheriv(ALGO, masterKey, Buffer.from(sealed.iv, "hex"));
    decipher.setAAD(aad(address));
    decipher.setAuthTag(Buffer.from(sealed.tag, "hex"));
    const plain = Buffer.concat([decipher.update(Buffer.from(sealed.enc, "hex")), decipher.final()]);
    const key = `0x${plain.toString("hex")}`;
    plain.fill(0);
    return key;
  }

  return {
    /** A new trading key: its public address, and the sealed record to store. */
    generate() {
      const key = generatePrivateKey();
      const address = privateKeyToAccount(key).address;
      return { address, sealed: seal(key, address) };
    },
    open,
    /** A viem account that signs with the key; refuses if the key isn't the one for `address`. */
    account(sealed, address) {
      const acct = privateKeyToAccount(open(sealed, address));
      if (acct.address.toLowerCase() !== String(address).toLowerCase()) throw new Error(`the sealed key does not belong to ${address}`);
      return acct;
    },
  };
}
