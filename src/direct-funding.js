/**
 * Paying a direct-funding request from this wallet, the way the umbrel app
 * does (manager/ui/src/lib/direct-funding.js).
 *
 * The engine's contract: POST /direct-funding/send REJECTS only before our
 * witness has left the device. After that it resolves, with whatever is known
 * and a `caveat`, because a payer that falls back to a plain on-chain send on
 * any error cannot tell a late refusal from an early one and would pay twice.
 * So the only answers that leave nothing spent are a rejection and a status
 * from before the witness went out (CREATED, OFFERED); everything else is a
 * payment out of our hands, to be shown as it stands.
 */

/** The fee ceiling a direct funding is charged against, in sats. */
export const DIRECT_FUNDING_FEE_HEADROOM_SATS = 1000;

const PRE_WITNESS = new Set(["CREATED", "OFFERED"]);
const SETTLED = new Set(["MEMPOOL_SEEN", "CONFIRMED"]);

/**
 * Refusal codes the engine hands back before anything leaves. Each one is a
 * certain "nothing was spent", so a plain payment of the address may follow
 * after a fresh review.
 */
export const DIRECT_FUNDING_REFUSAL_CODES = new Set([
  "MALFORMED",
  "UNSUPPORTED_VERSION",
  "EXPIRED",
  "EXPIRY_TOO_DISTANT",
  "INVALID_SIGNATURE",
  "WRONG_SIGNER",
  "WRONG_CHAIN",
  "TOO_MANY_REQUESTS",
  "NOT_PERSISTED",
  "UNREACHABLE",
  "AMOUNT_REQUIRED",
  "AMOUNT_MISMATCH",
  "NO_SUITABLE_UTXO",
  "OFFER_DECLINED",
  "SIGN_REQUEST_REFUSED",
  "EXCHANGE_TIMEOUT",
]);

/**
 * The confirmed coin that can carry this direct funding, or null. The engine
 * spends one whole coin and takes the fee out of it, so the coin has to cover
 * the amount and the fee ceiling; a coin that only covers the amount passes
 * a looser check and is then refused with NO_SUITABLE_UTXO.
 */
export function coveringUtxo(
  utxos,
  amountSats,
  headroomSats = DIRECT_FUNDING_FEE_HEADROOM_SATS,
) {
  if (!Array.isArray(utxos) || !(amountSats > 0)) return null;
  return (
    utxos.find(
      (u) =>
        u &&
        Number(u.height) > 0 &&
        !u.frozen &&
        Number(u.valueSats) >= amountSats + headroomSats,
    ) || null
  );
}

/**
 * What to do with what POST /direct-funding/send answered. Returns
 * `{ kind: 'fallback', reason }` when nothing was spent, or `{ kind: 'sent', ... }`
 * describing the funding as the engine reported it.
 */
export function fundingOutcome(answer) {
  if (answer instanceof Error) {
    return {
      kind: "fallback",
      reason: answer.message || "The direct funding was refused.",
    };
  }
  const status = answer && answer.status;
  if (!answer || PRE_WITNESS.has(status)) {
    return {
      kind: "fallback",
      reason:
        answer && answer.caveat
          ? answer.caveat
          : "The recipient did not take the direct funding.",
    };
  }
  return {
    kind: "sent",
    status,
    txid: answer.fundingTxid || null,
    caveat: answer.caveat || null,
    settled: SETTLED.has(status),
    failed: status === "FAILED" || status === "ABORTED",
  };
}

/** One short sentence for a sent outcome. */
export function describeFunding(outcome) {
  if (outcome.kind !== "sent") return outcome.reason;
  if (outcome.settled) return "Paid as direct funding.";
  if (outcome.failed)
    return `The direct funding did not complete.${
      outcome.caveat ? ` ${outcome.caveat}` : ""
    } Check Activity before paying again.`;
  return "Direct funding signed and on its way.";
}
