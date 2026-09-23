/**
 * A content-addressed document store.
 *
 * Specs, deliverables and verdicts all need to live somewhere fetchable, keyed
 * by the hash that was committed on-chain. In production that is IPFS or any
 * content-addressed storage; this is the same contract over plain HTTP, which
 * is enough to run the protocol end to end.
 *
 * Documents are served at /<hash>. Serving is verify-on-read: the store
 * re-hashes what it is about to return and refuses if it does not match the
 * key, so the store itself cannot quietly become a place where content is
 * swapped.
 */
import express from "express";
import { hashDocument, canonicalize } from "./spec.js";

export class ContentStore {
  constructor() {
    this.docs = new Map();
    this.baseUrl = null;
  }

  /** Store a document; returns its hash and (once listening) its URI. */
  put(doc) {
    const hash = hashDocument(doc);
    this.docs.set(hash.toLowerCase(), doc);
    return { hash, uri: this.uriFor(hash) };
  }

  uriFor(hash) {
    return this.baseUrl ? `${this.baseUrl}/${hash}` : null;
  }

  get(hash) {
    return this.docs.get(String(hash).toLowerCase()) ?? null;
  }

  /**
   * Overwrite what is served at `hash` with different content.
   *
   * Only exists so tests can simulate a provider swapping the deliverable
   * after committing to it — the attack the on-chain hash is there to stop.
   */
  tamper(hash, doc) {
    this.docs.set(String(hash).toLowerCase(), doc);
  }

  app() {
    const app = express();
    app.get("/:hash", (req, res) => {
      const doc = this.get(req.params.hash);
      if (!doc) return res.status(404).json({ error: "not_found" });
      res.type("application/json").send(canonicalize(doc));
    });
    return app;
  }

  async listen(port = 0) {
    this.server = await new Promise((resolve) => {
      const s = this.app().listen(port, () => resolve(s));
    });
    this.baseUrl = `http://127.0.0.1:${this.server.address().port}`;
    return this.baseUrl;
  }

  close() {
    this.server?.close();
  }

  /** A `publish` function for the Evaluator, storing sealed verdicts. */
  publisher() {
    return async (sealed) => {
      this.docs.set(sealed.hash.toLowerCase(), sealed.verdict);
      return this.uriFor(sealed.hash);
    };
  }
}
