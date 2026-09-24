# Outreach drafts

> **Not sent.** Drafts for the founder to edit and send. Nothing here has been
> posted anywhere. Fill the brackets, and check each team's current docs before
> sending, since their products move fast and these notes come from research on
> 2026-09-24.

The ask in every message is the same and small: **one real dispute, judged by
Verdict, on testnet.** That's grant milestone 2 ("settlements from contracts we
don't control") and the first proof that someone other than us wants this.

---

## 1. Escrow protocols with a pluggable arbiter (e.g. x402r)

> Hi [name], I'm building Verdict, a neutral arbiter for agent payments on Arc.
> I saw [protocol] lets a buyer name an arbiter for disputes. We built exactly the
> thing that sits in that slot: send us the terms and the delivery, we re-run the
> work against the tests both sides agreed to, and return a signed EIP-712 ruling
> your contract can verify in one call. It's bound to your contract, the case and
> the exact commitments, so it can't be replayed elsewhere.
>
> It's live on Arc testnet with a reference escrow settling on it:
> [link to ARBITER-RUN.md]. We never hold funds and charge the same flat fee
> whatever the outcome.
>
> Would you be up for wiring one testnet dispute through it? I'll do the
> integration work on our side. [repo link]

## 2. Agent escrow / payment products with a dispute step (e.g. PayCrow)

> Hi [name], quick one. When a [product] dispute comes in today, who decides it?
> We built Verdict to be that decision for anything a machine can check (code,
> computations, API responses against a schema). It returns a signed ruling in
> seconds, and abstains instead of guessing when it can't verify. That matters,
> because a wrong call costs you a customer either way.
>
> Live on Arc testnet: [link]. Happy to run your last few disputes through it
> offline and show you what it would have ruled. No integration needed for that.

## 3. ERC-8183 marketplace builders on Arc

> Hi [name], if you're building on ERC-8183, the evaluator seat is the part the
> standard leaves open. Buyers naming themselves evaluator is the default in the
> quickstart, and it lets a buyer reject good work and keep the money.
>
> Verdict fills that seat on Arc today: put `0x6686…d100` in the evaluator field
> and it judges the delivery against the committed tests and settles. Both of its
> ERC-8183 cases on testnet can be re-checked from chain data alone with one
> command: [link]. Would you try it as the default evaluator for jobs on
> [marketplace]?

## 4. Circle developer relations

> Hi [name], we're building Verdict on Arc: the neutral arbiter for agent-to-agent
> payments. It fills the ERC-8183 evaluator seat, gives any escrow a signed
> EIP-712 ruling it can verify on-chain, and charges per ruling over x402 through
> Gateway. Everything settles in USDC on Arc testnet today, including four real
> cases and Gateway payments settled end to end: [link].
>
> We're preparing a grant application and would value 15 minutes on whether this
> fits what you want to see in the agent stack. [repo link]

---

## Who to try first

1. **Escrow protocols with an arbiter slot**: the integration is smallest, and the
   message is concrete ("fill your slot").
2. **Circle DevRel**: cheap to ask, and it shapes the grant.
3. **ERC-8183 builders**: the fewest exist, but the fit is exact.

Track replies in this file, one line each: who, when, and what they said.
