import { parsePayment, buildBip21 } from "./payment-uri.js";
import {
  lfbwStatus,
  planInvoice,
  homeChannel,
  arrivingFundsNote,
  channelizeNote,
  INBOUND_HEADROOM_SATS,
  REVERT_NOTE_MS,
} from "./lfbw.js";
import {
  DIRECT_FUNDING_FEE_HEADROOM_SATS,
  DIRECT_FUNDING_REFUSAL_CODES,
  coveringUtxo,
  fundingOutcome,
  describeFunding,
} from "./direct-funding.js";
export {
  parsePayment,
  btcStringToSats,
  satsToBtcString,
  buildBip21,
} from "./payment-uri.js";

export const DEFAULT_HOST_URL = "http://127.0.0.1:8787";
/**
 * Routing fee a Lightning send may pay above the estimate. The engine reports
 * the estimate rounded DOWN to whole sats and enforces the cap in millisats,
 * so a cap equal to the estimate refused the very route it priced (a 1,024
 * msat fee against a 1,000 msat cap: "Route fee exceeds maximum"). The rest
 * leaves room for a retry over a slightly costlier route when the first
 * fails. The review shows the resulting maximum.
 */
export const LIGHTNING_FEE_HEADROOM_SATS = 10;
export const DEFAULT_PRIMARY_URI =
  "025501f56b72e7b999443b836ae1bff4c6fff514943d3f6677302a9189949bd99c@ulyeemszaigzrvpjcjcby4ehibrvsuqi5sq4dmmew2urk2nse5f7spid.onion:9102";
const MAX_SATS = 2_100_000_000_000_000;
const FUNDING_SETUP_STATES = new Set([
  "SENT_FUNDING_CREATED",
  "SENT_FUNDING_SIGNED",
  "AWAITING_FUNDING_CONFIRMED",
  "AWAITING_CHANNEL_READY",
  "DUAL_FUNDING_V2",
  "AWAITING_TX_SIGNATURES",
]);
let sequence = 0;
const uid = () =>
  globalThis.crypto?.randomUUID?.() ??
  `request-${Date.now().toString(36)}-${++sequence}-${Math.random()
    .toString(36)
    .slice(2)}-${Math.random().toString(36).slice(2)}`;
const clone = (value) => JSON.parse(JSON.stringify(value));
const asTime = (value) => {
  if (typeof value === "string" && !/^\d+(\.\d+)?$/.test(value))
    return Date.parse(value) || 0;
  const n = Number(value) || 0;
  return n > 0 && n < 1e12 ? n * 1000 : n;
};
export class WalletError extends Error {
  constructor(message, code = "WALLET_ERROR", status) {
    super(message);
    this.name = "WalletError";
    this.code = code;
    this.status = status;
  }
}
export function parseSats(input) {
  if (
    typeof input === "string" &&
    (!/^\d+$/.test(input.trim()) || input.trim().length > 16)
  )
    throw new WalletError("Enter a whole number of sats.", "INVALID_AMOUNT");
  if (typeof input !== "string" && typeof input !== "number")
    throw new WalletError("Enter a whole number of sats.", "INVALID_AMOUNT");
  const n = Number(typeof input === "string" ? input.trim() : input);
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_SATS)
    throw new WalletError(
      "Enter a whole number of sats within the Bitcoin supply.",
      "INVALID_AMOUNT",
    );
  return n;
}
export const formatSats = (n) => parseSats(n).toLocaleString("en-US");
const positiveSats = (value) => {
  const n = parseSats(value);
  if (!n)
    throw new WalletError(
      "Enter an amount greater than zero.",
      "INVALID_AMOUNT",
    );
  return n;
};
const integerField = (value, name) => {
  try {
    return parseSats(value);
  } catch {
    throw new WalletError(
      `The wallet returned an invalid ${name}. Refresh before continuing.`,
      "INVALID_RESPONSE",
    );
  }
};
const amountOptional = (value) =>
  value == null || value === "" ? null : positiveSats(value);
const text = (value) => (typeof value === "string" ? value : "");
const boundedDescription = (value) => text(value).trim().slice(0, 256);
const receiveFee = (amount, flat, ppm) =>
  Number(
    BigInt(integerField(flat, "receive fee")) +
      (BigInt(amount || 0) * BigInt(integerField(ppm, "receive fee rate")) +
        999999n) /
        1000000n,
  );
const jitReceiveError = (error, stage) =>
  error?.code === "JIT_TIMEOUT"
    ? new WalletError(
        (stage === "quote"
          ? "Your primary was connected but did not answer the capacity request. Try again. "
          : "Your primary did not confirm the capacity request in time, so no invoice was created. Review the amount and try again. ") +
          "If you run that Beignet node, check that Liquidity provider is enabled there.",
        error.code,
        error.status,
      )
    : error;

export function validatePrimaryUri(input) {
  const uri = text(input).trim();
  if (
    !/^(02|03)[a-fA-F0-9]{64}@(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\]):\d{1,5}$/.test(
      uri,
    )
  )
    throw new WalletError(
      "Enter a node URI: public key@host:port.",
      "INVALID_PRIMARY",
    );
  const port = Number(uri.slice(uri.lastIndexOf(":") + 1));
  if (port < 1 || port > 65535)
    throw new WalletError(
      "The node port must be between 1 and 65535.",
      "INVALID_PRIMARY",
    );
  return uri;
}
export function normalizeConnection(connection) {
  let url;
  try {
    url = new URL(text(connection?.url).trim());
  } catch {
    throw new WalletError("Enter the full wallet host URL.", "INVALID_URL");
  }
  const local = ["localhost", "127.0.0.1", "[::1]", "::1", "10.0.2.2"].includes(
    url.hostname,
  );
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new WalletError(
      "Use HTTPS for a remote wallet host. HTTP is only supported on loopback or the Android emulator host.",
      "INSECURE_URL",
    );
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    throw new WalletError(
      "Use only the wallet host origin, with no credentials, path, query or fragment.",
      "INVALID_URL",
    );
  if (
    connection.walletId != null &&
    (typeof connection.walletId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(connection.walletId))
  )
    throw new WalletError("Select a valid wallet.", "INVALID_WALLET");
  const token = text(connection?.token).trim();
  if (!token || /[\s\r\n]/.test(token))
    throw new WalletError(
      "Enter the wallet host access token.",
      "INVALID_TOKEN",
    );
  return Object.freeze({
    url: url.origin,
    token,
    ...(connection.walletId ? { walletId: connection.walletId } : {}),
  });
}
function activityStatus(status) {
  switch (String(status).toUpperCase()) {
    case "COMPLETED":
    case "PAID":
    case "CONFIRMED":
      return "completed";
    case "FAILED":
    case "CANCELLED":
      return "failed";
    case "EXPIRED":
      return "expired";
    case "UNKNOWN":
    case "UNCERTAIN":
      return "uncertain";
    default:
      return "pending";
  }
}
function legacyReceiveRequest(invoice) {
  if (
    typeof invoice.bolt11 !== "string" ||
    !invoice.bolt11 ||
    invoice.bolt11.length > 24000
  )
    return undefined;
  return {
    id: `payment:${invoice.paymentHash}`,
    uri: invoice.bolt11,
    bolt11: invoice.bolt11,
    paymentHash: invoice.paymentHash,
    amountSats:
      invoice.amountSats == null
        ? null
        : integerField(invoice.amountSats, "invoice amount"),
    description: boundedDescription(invoice.description),
    feeSats: 0,
    createdAt: asTime(invoice.createdAt),
    expiresAt:
      asTime(invoice.createdAt) + Number(invoice.expiry ?? 3600) * 1000,
    warnings: [],
    demo: false,
    legacy: true,
  };
}
function publicStoredRequest(value) {
  const lightningOnly = value?.bitcoinTracking === "lightning-only";
  requires(
    value &&
      typeof value.id === "string" &&
      value.id.length <= 128 &&
      typeof value.uri === "string" &&
      value.uri.length <= 24000 &&
      typeof value.bolt11 === "string" &&
      value.bolt11.length <= 24000 &&
      (lightningOnly
        ? value.address == null &&
          parsePayment(value.uri, { now: 0 }).kind === "bolt11"
        : typeof value.address === "string" && value.address.length <= 128) &&
      /^[a-fA-F0-9]{64}$/.test(value.paymentHash) &&
      Number.isFinite(value.expiresAt) &&
      value.expiresAt > 0,
    "The wallet returned incomplete saved request details.",
    "INVALID_RESPONSE",
  );
  return {
    id: value.id,
    uri: value.uri,
    ...(!lightningOnly ? { address: value.address } : {}),
    bolt11: value.bolt11,
    paymentHash: value.paymentHash.toLowerCase(),
    amountSats: amountOptional(value.amountSats),
    description: boundedDescription(value.description),
    feeSats: integerField(value.feeSats ?? 0, "receive fee"),
    expiresAt: value.expiresAt,
    warnings: Array.isArray(value.warnings)
      ? value.warnings
          .filter((w) => typeof w === "string")
          .slice(0, 5)
          .map((w) => w.slice(0, 512))
      : [],
    ...(Number.isFinite(value.createdAt) ? { createdAt: value.createdAt } : {}),
    ...(value.offlineReceive === true ? { offlineReceive: true } : {}),
    bitcoinTracking: lightningOnly
      ? "lightning-only"
      : value.bitcoinTracking === "ambiguous"
      ? "ambiguous"
      : "unique",
    demo: false,
  };
}
function publicStoredRequests(value) {
  requires(
    Array.isArray(value?.requests),
    "Saved requests unavailable",
    "INVALID_RESPONSE",
  );
  const requests = value.requests.map(publicStoredRequest);
  requires(
    new Set(requests.map((request) => request.paymentHash)).size ===
      requests.length,
    "Conflicting saved request details",
    "INVALID_RESPONSE",
  );
  const groups = new Map();
  for (const request of requests) {
    if (request.bitcoinTracking === "lightning-only") continue;
    const group = groups.get(request.address) || [];
    group.push(request);
    groups.set(request.address, group);
  }
  requires(
    [...groups.values()].every(
      (group) =>
        group.length === 1 ||
        group.every((request) => request.bitcoinTracking === "ambiguous"),
    ),
    "Conflicting saved address tracking details",
    "INVALID_RESPONSE",
  );
  return requests;
}
export function mergeActivity(
  {
    payments = [],
    invoices = [],
    transactions = [],
    channels = [],
    sentTxids = [],
  },
  now = Date.now(),
) {
  const rows = new Map();
  const fundingTxids = new Set(
    channels.map((channel) => channel.fundingTxid).filter(Boolean),
  );
  const explicitSends = new Set(sentTxids);
  for (const p of payments) {
    if (!p.paymentHash) continue;
    const kind = p.direction === "INCOMING" ? "received" : "sent";
    const id = `payment:${p.paymentHash}`;
    const next = {
      id,
      kind,
      title: kind === "received" ? "Payment received" : "Payment sent",
      description: text(p.metadata?.description),
      amountSats: integerField(p.amountSats, "payment amount"),
      feeSats: p.feeSats == null ? 0 : integerField(p.feeSats, "payment fee"),
      feeKnown: p.feeSats != null,
      feeEstimated: false,
      status: activityStatus(p.status),
      timestamp: asTime(p.completedAt || p.createdAt),
      reference: p.paymentHash,
      paymentHash: p.paymentHash,
    };
    const previous = rows.get(id);
    if (!previous || next.timestamp >= previous.timestamp) rows.set(id, next);
  }
  for (const i of invoices) {
    if (!i.paymentHash) continue;
    const id = `payment:${i.paymentHash}`;
    const receiveRequest = legacyReceiveRequest(i);
    let status = activityStatus(i.status);
    const expiresAt =
      i.expiry != null ? asTime(i.createdAt) + Number(i.expiry) * 1000 : 0;
    if (status === "pending" && expiresAt && expiresAt <= now)
      status = "expired";
    if (rows.has(id)) {
      const existing = rows.get(id);
      if (existing.kind === "received") {
        if (receiveRequest) existing.receiveRequest = receiveRequest;
        if (!existing.description) existing.description = text(i.description);
        // The reads can straddle settlement. A paid invoice proves receipt
        // even when /payments returned the earlier pending state. Keep the
        // payment's actual amount and fee, and never promote an outgoing row.
        if (status === "completed") existing.status = "completed";
        if (existing.status === "completed") continue;
        // An issued invoice can already have an incoming payment record before
        // it is paid. Show the request's amount and lifecycle until settlement.
      } else continue;
    }
    const paid = status === "completed";
    rows.set(id, {
      id,
      kind: paid ? "received" : "request",
      title: paid ? "Payment received" : "Payment request",
      description: text(i.description),
      amountSats:
        i.amountSats == null ? 0 : integerField(i.amountSats, "invoice amount"),
      feeSats: 0,
      feeKnown: false,
      feeEstimated: false,
      status,
      timestamp: asTime(i.createdAt),
      reference: i.paymentHash,
      paymentHash: i.paymentHash,
      ...(receiveRequest ? { receiveRequest } : {}),
    });
  }
  for (const tx of transactions) {
    if (!tx.txid) continue;
    const internal = fundingTxids.has(tx.txid) && !explicitSends.has(tx.txid);
    const kind = internal
      ? "transfer"
      : tx.type === "received"
      ? "received"
      : tx.type === "sent"
      ? "sent"
      : "transfer";
    rows.set(`transaction:${tx.txid}`, {
      id: `transaction:${tx.txid}`,
      kind,
      title:
        kind === "received"
          ? "Bitcoin received"
          : kind === "sent"
          ? "Bitcoin sent"
          : "Wallet transfer",
      description: text(tx.description),
      amountSats: integerField(Math.abs(tx.valueSats), "transaction amount"),
      feeSats:
        tx.feeSats == null ? 0 : integerField(tx.feeSats, "transaction fee"),
      feeKnown: tx.feeSats != null,
      feeEstimated: false,
      status:
        tx.confirmed &&
        !(
          internal &&
          channels.some(
            (channel) =>
              channel.fundingTxid === tx.txid &&
              FUNDING_SETUP_STATES.has(channel.state),
          )
        )
          ? "completed"
          : "pending",
      timestamp: asTime(tx.confirmTimestamp || tx.timestamp),
      reference: tx.txid,
      txid: tx.txid,
      ...(tx.address ? { address: tx.address } : {}),
    });
  }
  return [...rows.values()].sort(
    (a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id),
  );
}
// Managers persist arbitrary Error.message values here, including errors from
// remote transports. Publish fixed diagnostics instead of copying their payload,
// which may contain credentials, stack traces, or private wallet data.
function publicSetupError(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const diagnostic = value.slice(0, 4096);
  const subject = /\belectrum\b|\bbitcoin server\b/i.test(diagnostic)
    ? "The Bitcoin server"
    : "The primary node";
  if (
    /genesis|wrong (?:bitcoin )?network|network mismatch|different (?:bitcoin )?network/i.test(
      diagnostic,
    )
  )
    return "The Bitcoin server is on a different network. Check the selected network and server, then retry setup.";
  if (
    /unauthori[sz]ed|forbidden|authentication|access denied|invalid.{0,12}token|token.{0,12}expired/i.test(
      diagnostic,
    )
  )
    return "The connection could not be authenticated. Check the host or relay connection settings, then retry setup.";
  if (
    /certificate|err_tls_|err_ssl_|\b(?:tls|ssl)\b.{0,32}(?:fail|error|verif|handshake)/i.test(
      diagnostic,
    )
  )
    return `${subject}'s secure connection could not be verified. Check the server and its certificate, then retry setup.`;
  if (/\bsocks\b|\btor\b/i.test(diagnostic))
    return "The private network connection is unavailable. Check Tor or relay settings, then retry setup.";
  if (
    /econnrefused|refused (?:the )?connection|connection refused|upstream_refused/i.test(
      diagnostic,
    )
  )
    return `${subject} refused the connection. Check that it is running and listening on the configured port, then retry setup.`;
  if (
    /enotfound|eai_again|\bdns\b|hostname.{0,24}resolved|address.{0,24}resolved|upstream_dns/i.test(
      diagnostic,
    )
  )
    return `${subject}'s address could not be resolved. Check the address and local network, then retry setup.`;
  if (/timed?\s*out|timeout|etimedout/i.test(diagnostic))
    return `${subject} connection timed out. Check the address, port, and network, then retry setup.`;
  if (/unreachable|enetunreach|ehostunreach/i.test(diagnostic))
    return `${subject} is unreachable. Check the network connection, then retry setup.`;
  if (
    /option_zeroconf|option_scid_alias|unsupported.{0,24}feature|did not negotiate/i.test(
      diagnostic,
    )
  )
    return "The primary node does not support a required wallet feature. Check the selected primary, then retry setup.";
  return "Primary setup could not complete. Check the node address and connection settings, then retry setup.";
}
function publicWallet(rec) {
  if (!rec?.id)
    throw new WalletError(
      "The host did not return a wallet.",
      "INVALID_RESPONSE",
    );
  const setupError = publicSetupError(rec.lfbw?.setupError);
  return {
    id: rec.id,
    name: text(rec.name),
    network: rec.network,
    status: rec.status || (rec.running ? "running" : "stopped"),
    ...(rec.lfbw
      ? {
          lfbw: {
            enabled: !!rec.lfbw.enabled,
            mode: rec.lfbw.mode,
            primaryUri: rec.lfbw.primaryUri,
            primaryPubkey: rec.lfbw.primaryPubkey,
            primaryWalletId: rec.lfbw.primaryWalletId,
            setup: rec.lfbw.setup,
            ...(setupError ? { setupError } : {}),
            trusted: rec.lfbw.trusted,
            ...(rec.lfbw.unpairedFunding &&
            Number.isFinite(rec.lfbw.unpairedFunding.at)
              ? { unpairedFunding: { at: rec.lfbw.unpairedFunding.at } }
              : {}),
            ...(rec.lfbw.lastSplice &&
            ["conflicted", "reverted"].includes(rec.lfbw.lastSplice.state)
              ? {
                  lastSplice: {
                    state: rec.lfbw.lastSplice.state,
                    spliceTxid: text(rec.lfbw.lastSplice.spliceTxid) || null,
                    conflictTxid:
                      text(rec.lfbw.lastSplice.conflictTxid) || null,
                    at: Number(rec.lfbw.lastSplice.at) || 0,
                  },
                }
              : {}),
            ...publicChannelize(rec.lfbw.lastChannelize),
            ...publicOffer(rec.lfbw.lastOffer),
          },
        }
      : {}),
  };
}
const CHANNELIZE_ACTIONS = new Set([
  "wait",
  "splice-in",
  "open",
  "open-v2",
  "failed",
]);
/**
 * The wallet's last channelize decision, sanitized: a small fixed set of
 * fields, bounded text, and nothing that came from a request body.
 */
function publicChannelize(last) {
  if (!last || !Number.isFinite(last.at) || !CHANNELIZE_ACTIONS.has(last.action))
    return {};
  const out = { action: last.action, at: last.at };
  if (text(last.reason)) out.reason = text(last.reason).slice(0, 200);
  if (text(last.error)) out.error = text(last.error).slice(0, 200);
  if (text(last.code)) out.code = text(last.code).slice(0, 64);
  if (Number.isSafeInteger(last.feeSats)) out.feeSats = last.feeSats;
  if (Number.isSafeInteger(last.amountSats)) out.amountSats = last.amountSats;
  if (Number.isFinite(last.retryAt)) out.retryAt = last.retryAt;
  if (text(last.fallbackFrom)) out.fallbackFrom = text(last.fallbackFrom);
  return { lastChannelize: out };
}
const OFFER_STATES = new Set(["accepted", "declined", "failed", "completed"]);
/** The last direct-funding offer this wallet answered, and why. */
function publicOffer(offer) {
  if (!offer || !Number.isFinite(offer.at) || !OFFER_STATES.has(offer.state))
    return {};
  return {
    lastOffer: {
      state: offer.state,
      reason: text(offer.reason) ? text(offer.reason).slice(0, 200) : null,
      at: offer.at,
    },
  };
}
const requires = (condition, message, code) => {
  if (!condition) throw new WalletError(message, code);
};
const validateReceiveMode = (mode) =>
  requires(
    mode === undefined || mode === "unified" || mode === "offline",
    "Choose a supported receive mode.",
    "INVALID_PARAMS",
  );
const knownRefusal = (error) =>
  error instanceof WalletError &&
  ([401, 403, 404].includes(error.status) ||
    [
      "INVALID_PARAMS",
      "INVALID_INVOICE",
      "INSUFFICIENT_FUNDS",
      "INVALID_AMOUNT",
      "NO_ROUTE",
    ].includes(error.code) ||
    DIRECT_FUNDING_REFUSAL_CODES.has(error.code));

export class WalletClient {
  constructor(connection, options = {}) {
    this.connection = normalizeConnection(connection);
    this.demo = false;
    this._fetch = options.fetch || globalThis.fetch;
    this._now = options.now || Date.now;
    this._sendReviews = new Map();
    this._receiveQuotes = new Map();
    this._paymentLocks = new Set();
    // Direct-funding envelopes a recipient refused before anything was spent.
    // The next review of the same request pays the address instead.
    this._fundingDeclined = new Set();
    this._localActivity = [];
    this._receiveStatusCache = new Map();
    this._savedReceiveRequests = [];
    this._epoch = 0;
  }
  selectWallet(id) {
    requires(
      typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id),
      "Select a valid wallet.",
      "INVALID_WALLET",
    );
    this._epoch++;
    this.connection = Object.freeze({ ...this.connection, walletId: id });
    this._sendReviews.clear();
    this._receiveQuotes.clear();
    this._receiveStatusCache.clear();
    this._savedReceiveRequests = [];
  }
  _assertEpoch(epoch) {
    requires(
      epoch === this._epoch,
      "The selected wallet changed. Refresh before continuing.",
      "WALLET_CHANGED",
    );
  }
  _walletPath(path) {
    requires(this.connection.walletId, "Choose a wallet first.", "NO_WALLET");
    return `/wallets/${encodeURIComponent(
      this.connection.walletId,
    )}/api${path}`;
  }
  async _request(path, method = "GET", body, readOnly = method === "GET") {
    let response;
    let timeout;
    const controller = readOnly ? new AbortController() : null;
    // JIT quotes have their own 15-second peer reply window. Leave room for
    // that typed result to return through the host instead of aborting first.
    const timeoutMs =
      method === "GET" &&
      /^\/wallets\/[^/]+\/api\/jit\/quote(?:\?|$)/.test(path)
        ? 25000
        : 15000;
    if (controller) timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      response = await this._fetch(this.connection.url + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.connection.token}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch {
      throw new WalletError(
        readOnly
          ? "Cannot reach the wallet host. Check the connection and try refreshing."
          : "The connection ended before the wallet confirmed the result. Check Activity before attempting this action again.",
        readOnly ? "NETWORK_ERROR" : "RESULT_UNCERTAIN",
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    let envelope;
    try {
      envelope = await response.json();
    } catch {
      throw new WalletError(
        "The wallet host returned an unreadable response.",
        "INVALID_RESPONSE",
        response.status,
      );
    }
    if (!response.ok || envelope?.ok === false) {
      const raw =
        text(envelope?.error?.message) ||
        `Wallet host request failed (${response.status}).`;
      throw new WalletError(
        raw.split(this.connection.token).join("[redacted]"),
        envelope?.error?.code || "HOST_ERROR",
        response.status,
      );
    }
    if (!envelope || !Object.prototype.hasOwnProperty.call(envelope, "result"))
      throw new WalletError(
        "The wallet host returned an unexpected response.",
        "INVALID_RESPONSE",
        response.status,
      );
    return envelope.result;
  }
  _get(path) {
    return this._request(this._walletPath(path));
  }
  _post(path, body, readOnly = false) {
    return this._request(this._walletPath(path), "POST", body, readOnly);
  }
  async listWallets() {
    const records = await this._request("/api/wallets");
    requires(
      Array.isArray(records),
      "The wallet returned an invalid wallet list.",
      "INVALID_RESPONSE",
    );
    return records.filter((r) => r.lfbw?.enabled).map(publicWallet);
  }
  async getConfig() {
    return this._request("/api/config");
  }
  async getRecoveryPhrase() {
    const epoch = this._epoch;
    const result = await this._get("/mnemonic");
    this._assertEpoch(epoch);
    requires(
      typeof result?.mnemonic === "string" &&
        result.mnemonic.trim().split(/\s+/).length >= 12,
      "The wallet did not return a recovery phrase.",
      "INVALID_RESPONSE",
    );
    return result.mnemonic;
  }
  async getRecoveryStatus() {
    const epoch = this._epoch;
    const result = await this._get("/recovery/status");
    this._assertEpoch(epoch);
    const phases = ["idle", "settling", "applying", "applied", "refused"];
    const states = ["disabled", "running", "restore-required", "restoring", "restart-required", "fenced"];
    requires(
      ["off", "peer-storage", "async-remote", "quorum"].includes(result?.mode) &&
        states.includes(result?.state) &&
        typeof result?.autoApply?.enabled === "boolean" &&
        phases.includes(result?.autoApply?.phase) &&
        (result.node == null || Array.isArray(result.node.channels)),
      "The wallet returned an incomplete recovery status.",
      "INVALID_RESPONSE",
    );
    return {
      mode: result.mode,
      state: result.state,
      importPending: result.importPending === true,
      importComplete: result.importComplete === true,
      autoApply: {
        enabled: result.autoApply.enabled,
        phase: result.autoApply.phase,
        lastReason: typeof result.autoApply.lastReason === "string"
          ? result.autoApply.lastReason.slice(0, 512) : null,
      },
      capsuleCount: integerField(result.capsules?.candidates ?? 0, "recovery backup count"),
      backupChannelCount: result.capsules?.best == null ? null
        : integerField(result.capsules.best.channelCount, "backup channel count"),
      channels: (result.node?.channels ?? []).map((channel) => {
        requires(
          typeof channel?.channelId === "string" && /^[a-f0-9]{64}$/i.test(channel.channelId) &&
            typeof channel.status === "string" && channel.status.length <= 80,
          "The wallet returned an invalid recovered channel.",
          "INVALID_RESPONSE",
        );
        return {
          channelId: channel.channelId,
          status: channel.status,
          restoreRecencyUnproven: channel.restoreRecencyUnproven === true,
          fundingUnidentified: channel.fundingUnidentified === true,
        };
      }),
    };
  }
  async createWallet({
    name,
    network = "mainnet",
    primaryUri,
    electrum,
    mnemonic,
    recoveryAutoApply,
  } = {}) {
    requires(
      ["mainnet", "testnet", "regtest"].includes(network),
      "Choose a supported Bitcoin network.",
      "INVALID_NETWORK",
    );
    // An existing recovery phrase restores that wallet's keys; the engine
    // checks the words and their checksum. The phrase is sent once and never
    // enters a record, a snapshot or an error.
    const phrase =
      typeof mnemonic === "string"
        ? mnemonic.trim().toLowerCase().split(/\s+/).filter(Boolean)
        : [];
    requires(
      mnemonic === undefined || (typeof mnemonic === "string" && [12, 15, 18, 21, 24].includes(phrase.length)),
      "Enter a valid recovery phrase of 12 to 24 words.",
      "INVALID_MNEMONIC",
    );
    requires(
      recoveryAutoApply === undefined || typeof recoveryAutoApply === "boolean",
      "Choose whether to recover channel backups.",
      "INVALID_PARAMS",
    );
    if (recoveryAutoApply === true) {
      requires(phrase.length > 0, "Enter the existing wallet's recovery phrase.", "INVALID_MNEMONIC");
      requires(this.embedded, "Channel recovery import is only available for this browser wallet.", "RECOVERY_UNAVAILABLE");
      const config = await this.getConfig();
      requires(config?.recoveryAutoApplyAvailable === true,
        "Reopen the wallet to load the version that supports channel recovery import.", "RECOVERY_UNAVAILABLE");
    }
    const uri = validatePrimaryUri(
      primaryUri || (network === "mainnet" ? DEFAULT_PRIMARY_URI : ""),
    );
    const created = await this._request("/api/wallets", "POST", {
      name: boundedDescription(name) || "My wallet",
      network,
      ...(electrum ? { electrum } : {}),
      ...(phrase.length ? { mnemonic: phrase.join(" ") } : {}),
      ...(recoveryAutoApply === true ? { recoveryAutoApply: true } : {}),
      recoveryMode: "peer-storage",
      tor: uri.includes(".onion:"),
      lfbw: {
        enabled: true,
        primaryUri: uri,
        trusted: true,
        initialChannelSats: 0,
      },
    });
    const wallet = publicWallet(created?.record);
    const warnings = Array.isArray(created.warnings)
      ? created.warnings
          .filter((warning) => typeof warning === "string" && warning.trim())
          .slice(0, 5)
          .map((warning) => warning.trim().slice(0, 512))
      : [];
    this.selectWallet(wallet.id);
    return {
      ...wallet,
      ...(typeof created.mnemonic === "string"
        ? { mnemonic: created.mnemonic }
        : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  }
  _managerWalletPath(suffix = "") {
    requires(this.connection.walletId, "Choose a wallet first.", "NO_WALLET");
    return `/api/wallets/${encodeURIComponent(
      this.connection.walletId,
    )}${suffix}`;
  }
  async startWallet() {
    await this._request(this._managerWalletPath("/start"), "POST", {});
  }
  async refreshWallet() {
    await this._post("/wallet/refresh", {}, true);
  }
  /**
   * What the wallet's engine reports about itself, in one read, for the
   * owner to look at when a payment or a move is not behaving. Figures only:
   * no keys, no secrets, no raw error payloads beyond what publicWallet
   * already admits.
   */
  async diagnostics() {
    const rec = await this._record();
    const read = (path) => this._get(path).catch(() => null);
    const [info, health, balance, liquidity, channels, peers, utxos, funding, graph] =
      await Promise.all([
        read("/info"),
        read("/health"),
        read("/balance"),
        read("/liquidity"),
        read("/channels"),
        read("/peers"),
        read("/utxos"),
        read("/direct-funding/config"),
        read("/graph/info"),
      ]);
    const primaryPubkey = rec.lfbw?.primaryPubkey || null;
    const wallet = publicWallet(rec);
    return {
      checkedAt: this._now(),
      wallet: wallet.lfbw ?? null,
      blockHeight: Number.isFinite(info?.blockHeight) ? info.blockHeight : null,
      electrumConnected:
        typeof health?.electrumConnected === "boolean"
          ? health.electrumConnected
          : null,
      primaryConnected: Array.isArray(peers)
        ? peers.some(
            (p) =>
              p.pubkey === primaryPubkey &&
              (p.state === "connected" || p.state === "ready" || p.connected === true),
          )
        : null,
      balance: balance
        ? {
            onchain: Number(balance.onchain) || 0,
            lightning: Number(balance.lightning) || 0,
            splicingSats: Number(balance.splicingSats) || 0,
          }
        : null,
      sendableSats: Number.isFinite(liquidity?.sendableSats)
        ? liquidity.sendableSats
        : null,
      // The network map routes are found on. A device with a handful of
      // channels here cannot route past its primary.
      graph:
        graph && Number.isFinite(graph.channelCount)
          ? {
              nodes: Number(graph.nodeCount) || 0,
              channels: graph.channelCount,
              lastSyncAt: Number.isFinite(graph.lastSyncAt) ? graph.lastSyncAt : null,
            }
          : null,
      utxos: Array.isArray(utxos)
        ? utxos.map((u) => ({
            valueSats: Number(u.valueSats) || 0,
            height: Number(u.height) || 0,
          }))
        : null,
      channels: Array.isArray(channels)
        ? channels.map((c) => ({
            channelId: text(c.channelId),
            withPrimary: c.peerPubkey === primaryPubkey,
            state: text(c.state),
            htlcUsable: c.htlcUsable ?? null,
            fundingConfirmed: c.fundingConfirmed ?? null,
            fundingTxid: text(c.fundingTxid) || null,
            capacitySats: Number(c.capacitySats) || 0,
            localBalanceSats: Number(c.localBalanceSats) || 0,
            remoteBalanceSats: Number(c.remoteBalanceSats) || 0,
            ...(c.pendingSpliceLocalBalanceSats != null
              ? { pendingSpliceLocalBalanceSats: Number(c.pendingSpliceLocalBalanceSats) }
              : {}),
            ...(c.payThroughSplice != null
              ? { payThroughSplice: !!c.payThroughSplice }
              : {}),
            ...(c.restoreRecencyUnproven ? { restoreRecencyUnproven: true } : {}),
            ...(c.fundingUnaccounted ? { fundingUnaccounted: true } : {}),
          }))
        : null,
      directFunding: funding
        ? {
            lspPubkey: text(funding.lspPubkey) || null,
            lspHost: text(funding.lspHost) || null,
            lspPort: Number(funding.lspPort) || null,
            allowSplice: funding.allowSplice ?? null,
            allowUnpairedSplice: funding.allowUnpairedSplice ?? null,
            unpairedSpliceDepth: funding.unpairedSpliceDepth ?? null,
            minAmountSat: funding.minAmountSat ?? null,
          }
        : null,
    };
  }
  async _record() {
    requires(this.connection.walletId, "Choose a wallet first.", "NO_WALLET");
    const record = await this._request(
      `/api/wallets/${encodeURIComponent(this.connection.walletId)}`,
    );
    requires(
      record?.lfbw?.enabled,
      "Choose a Lightning-first wallet.",
      "NOT_LFBW",
    );
    return record;
  }
  async snapshot() {
    const epoch = this._epoch;
    const [
      rec,
      info,
      balance,
      liquidity,
      channels,
      utxos,
      peers,
      payments,
      invoices,
      transactions,
      submissions,
      savedRequests,
      offline,
    ] = await Promise.all([
      this._record(),
      this._get("/info"),
      this._get("/balance"),
      this._get("/liquidity"),
      this._get("/channels"),
      this._get("/utxos"),
      this._get("/peers"),
      this._get("/payments"),
      this._get("/invoices"),
      this._get("/transactions"),
      this._request(this._managerWalletPath("/activity")),
      this._get("/receive/requests").catch(() => null),
      // The device engine says how much an offline receive can take; a
      // host's daemon has no such route, and there the figure stays unknown.
      this._get("/receive/offline").catch(() => null),
    ]);
    this._assertEpoch(epoch);
    for (const value of [
      channels,
      utxos,
      peers,
      payments,
      invoices,
      transactions,
      submissions,
    ])
      requires(
        Array.isArray(value),
        "The wallet returned an incomplete snapshot.",
        "INVALID_RESPONSE",
      );
    for (const key of ["onchain", "lightning"])
      integerField(balance?.[key], `${key} balance`);
    const status = lfbwStatus({
      rec,
      balance,
      liquidity,
      channels,
      utxos,
      peers,
    });
    // Canonical Lightning already includes disconnected/restore-held NORMAL balances;
    // splicingSats is a separate daemon bucket. Only add genuinely funded openings.
    const observedTransactions = new Set(transactions.map((tx) => tx.txid));
    const openingSats = channels
      .filter(
        (c) =>
          FUNDING_SETUP_STATES.has(c.state) &&
          c.fundingTxid &&
          observedTransactions.has(c.fundingTxid),
      )
      .reduce(
        (sum, c) => sum + integerField(c.localBalanceSats, "opening balance"),
        0,
      );
    const splicingSats = integerField(
      balance.splicingSats ?? 0,
      "funds moving",
    );
    const closingSats = integerField(
      info.pendingCloseBalanceSats ?? 0,
      "recovering balance",
    );
    const erroredSats = integerField(
      info.erroredBalanceSats ?? 0,
      "funds needing attention",
    );
    const totalSats =
      balance.lightning +
      balance.onchain +
      openingSats +
      splicingSats +
      closingSats +
      erroredSats;
    const pendingSats =
      balance.onchain + openingSats + splicingSats + closingSats + erroredSats;
    const notes = [];
    if (rec.lfbw.setup !== "ready")
      notes.push("Wallet setup is not finished. Check Settings.");
    if (status.unconfirmed > 0)
      notes.push(
        `${formatSats(status.unconfirmed)} sats arriving. Available after confirmation.`,
      );
    // Confirmed on-chain funds say what the wallet is doing with them, from its
    // last channelize decision, so a refused or waiting move is never dressed
    // up as progress.
    const moving = channelizeNote(status, this._now());
    if (moving) notes.push(moving);
    if (openingSats + splicingSats > 0)
      notes.push(
        rec.lfbw.unpairedFunding
          ? `${formatSats(
              openingSats + splicingSats,
            )} sats moving. A payer's transfer locks after three confirmations.`
          : `${formatSats(
              openingSats + splicingSats,
            )} sats moving. Available when the transfer confirms.`,
      );
    // A stranger's coin spent elsewhere before its splice confirmed: the
    // engine and the primary put the channel back on its previous funding.
    // Nothing of the wallet's is lost either way, and the wallet says so
    // rather than letting a vanished pending amount go unexplained.
    const splice = rec.lfbw.lastSplice || null;
    if (splice?.state === "conflicted")
      notes.push(
        "A payer's funding was spent elsewhere. Your balance is being restored. Nothing of yours is lost.",
      );
    else if (
      splice?.state === "reverted" &&
      this._now() - (splice.at || 0) < REVERT_NOTE_MS
    )
      notes.push(
        "Your balance was restored after a payer's funding was spent elsewhere. Nothing of yours was lost.",
      );
    if (closingSats > 0)
      notes.push(
        `${formatSats(closingSats)} sats recovering. Still in your total.`,
      );
    if (erroredSats > 0)
      notes.push(
        `${formatSats(erroredSats)} sats need recovery attention before they can be spent.`,
      );
    // A trusted (zero-conf) channel reports NORMAL from the moment it opens, so
    // no channel state ever marks its balance as arriving. The wallet showed
    // such funds as ordinary spendable balance, with nothing to say the channel
    // itself was still only a mempool promise.
    const unconfirmedFunding = status.channels
      .filter((c) => c.fundingConfirmed === false)
      .reduce((sum, c) => sum + (c.localBalanceSats || 0), 0);
    if (unconfirmedFunding > 0)
      notes.push(
        `${formatSats(
          unconfirmedFunding,
        )} sats are in a transfer that has not confirmed yet. Lightning sends work now. Bitcoin address sends wait for that confirmation.`,
      );
    if (channels.some((c) => c.restoreRecencyUnproven || c.fundingUnaccounted))
      notes.push(
        "Some funds are held while the wallet verifies its latest state. Still in your total.",
      );
    if (status.previousChannels.length > 0)
      notes.push("Funds with your previous primary remain in your total.");
    const journal = submissions.map((row) => ({
      id: text(row.id),
      kind: "sent",
      title: text(row.title) || "Bitcoin sent",
      description: text(row.description),
      amountSats: integerField(row.amountSats, "submitted payment amount"),
      feeSats: integerField(row.feeSats, "submitted payment fee"),
      feeKnown: row.feeKnown !== false,
      feeEstimated: row.feeEstimated !== false,
      status: activityStatus(row.status),
      timestamp: asTime(row.timestamp),
      reference: text(row.reference),
      ...(row.txid ? { txid: text(row.txid) } : {}),
      ...(row.address ? { address: text(row.address) } : {}),
    }));
    requires(
      journal.every((row) => row.id && row.reference),
      "The wallet returned incomplete payment tracking. Refresh before continuing.",
      "INVALID_RESPONSE",
    );
    const journalTxids = new Set(
      journal.map((row) => row.txid).filter(Boolean),
    );
    let activity = [
      ...mergeActivity(
        {
          payments,
          invoices,
          transactions,
          channels,
          sentTxids: [
            ...journalTxids,
            ...this._localActivity
              .filter((row) => row.walletId === this.connection.walletId)
              .map((row) => row.txid)
              .filter(Boolean),
          ],
        },
        this._now(),
      ).filter((row) => !row.txid || !journalTxids.has(row.txid)),
      ...journal,
    ];
    activity = await this._reconcileReceiveActivity({
      activity,
      savedRequests,
      payments,
      invoices,
      notes,
    });
    this._assertEpoch(epoch);
    const knownReferences = new Set(activity.map((row) => row.reference));
    const knownIds = new Set(activity.map((row) => row.id));
    const local = this._localActivity
      .filter(
        (row) =>
          row.walletId === this.connection.walletId &&
          !knownReferences.has(row.reference) &&
          !knownIds.has(row.id),
      )
      .map(({ walletId, ...row }) => row);
    for (const payment of payments)
      if (payment.status === "FAILED")
        this._paymentLocks.delete(
          `${this.connection.walletId}:${payment.paymentHash}`,
        );
    const wallet = publicWallet(rec);
    return {
      wallet,
      balance: {
        totalSats: integerField(totalSats, "total balance"),
        availableSats: integerField(status.canSend, "available balance"),
        pendingSats: integerField(pendingSats, "pending balance"),
        receivableSats: integerField(status.canReceive, "receivable balance"),
        ...(Number.isSafeInteger(offline?.maxSats) && offline.maxSats >= 0
          ? { offlineReceivableSats: offline.maxSats }
          : {}),
      },
      activity: [...activity, ...local].sort(
        (a, b) => b.timestamp - a.timestamp,
      ),
      primary: {
        uri: text(rec.lfbw.primaryUri),
        connected: status.primaryConnected,
        setup: rec.lfbw.setup || "pending",
        ...(wallet.lfbw?.setupError
          ? { setupError: wallet.lfbw.setupError }
          : {}),
      },
      notes,
      updatedAt: this._now(),
      demo: false,
    };
  }
  /**
   * Why a payment is out of reach right now, when the wallet holds enough in
   * total but not enough that is spendable yet.
   *
   * A lightning-first wallet routinely holds funds that are arriving: an
   * unconfirmed deposit, a confirmed one below the channelize floor, a channel
   * still opening, a splice still locking. "Not enough funds" is wrong in that
   * situation and sends the user looking for money they already have. This says
   * what is arriving and roughly when, which is the difference between a dead
   * end and a wait.
   *
   * The extra reads happen only on the refusal path, so an ordinary send is not
   * slowed down preparing an explanation it will not need.
   */
  async _arrivingFunds(amountSats, rec, canSendOverride) {
    try {
      const [balance, liquidity, channels, utxos, peers] = await Promise.all([
        this._get("/balance"),
        this._get("/liquidity"),
        this._get("/channels"),
        this._get("/utxos"),
        this._get("/peers"),
      ]);
      const status = lfbwStatus({
        rec,
        balance,
        liquidity,
        channels,
        utxos,
        peers,
      });
      // A send to a Bitcoin address is bounded by what the splice can take out,
      // which is lower than the Lightning sendable. Measuring the shortfall
      // against the wrong limit would understate it.
      return arrivingFundsNote(
        amountSats,
        canSendOverride == null
          ? status
          : { ...status, canSend: Math.min(status.canSend, canSendOverride) },
      );
    } catch {
      // An explanation is a courtesy. Failing to build one must never change
      // the refusal itself.
      return null;
    }
  }
  async prepareSend({ request, amountSats } = {}) {
    const epoch = this._epoch;
    const rec = await this._record();
    const parsed = parsePayment(request, {
      network: rec.network,
      now: this._now(),
    });
    requires(
      parsed.kind !== "invalid" && parsed.kind !== "empty",
      parsed.message || "Paste a payment request or Bitcoin address.",
      parsed.code || "INVALID_REQUEST",
    );
    let target =
      parsed.kind === "onchain" && parsed.lightning ? parsed.lightning : parsed;
    requires(
      target.kind !== "bolt12",
      "This version needs a Lightning invoice or Bitcoin address so it can show a fee before payment. Ask the recipient for a one-time invoice.",
      "OFFER_NOT_QUOTABLE",
    );
    const typed = amountOptional(amountSats);
    let amount = parsed.amountSats ?? target.amountSats ?? typed;
    // A request from another Beignet wallet may carry a direct-funding
    // envelope: one of this wallet's confirmed coins becomes the recipient's
    // channel funding directly, in one transaction. It takes a whole confirmed
    // coin covering the amount and the fee ceiling; a lightning-first wallet
    // holds one only while confirmed funds sit outside its channel.
    const fundingCoin =
      parsed.kind === "onchain" &&
      parsed.funding &&
      amount != null &&
      !this._fundingDeclined.has(parsed.funding.envelope) &&
      parsed.funding.expiresAt > this._now()
        ? coveringUtxo(await this._get("/utxos").catch(() => []), amount)
        : null;
    // Lightning first: the invoice carries the payment when this wallet can
    // send that much over Lightning. When it cannot, and a coin can fund the
    // recipient's channel directly, that is the payment; a wallet with no
    // channel yet has no Lightning to try.
    if (target.kind === "bolt11" && fundingCoin) {
      const liquidity = await this._get("/liquidity").catch(() => null);
      const sendable = Number(liquidity?.sendableSats) || 0;
      if (!(sendable >= amount)) target = parsed;
    }
    if (typed != null && amount != null && typed !== amount)
      throw new WalletError(
        "The entered amount differs from the payment request.",
        "AMOUNT_CONFLICT",
      );
    const warnings = (parsed.warnings || []).map((w) => w.message);
    let destination;
    let description = parsed.message || parsed.label || "";
    let feeSats;
    let estimatedFeeSats;
    let path;
    let body;
    let route;
    let paymentHash;
    let expiresAt = this._now() + 60000;
    if (target.kind === "bolt11") {
      const decoded = await this._post(
        "/invoice/decode",
        { bolt11: target.invoice },
        true,
      );
      const decodedAmount =
        decoded.amountSats == null || decoded.amountSats === 0
          ? null
          : positiveSats(decoded.amountSats);
      if (decodedAmount != null && amount != null && decodedAmount !== amount)
        throw new WalletError(
          "The invoice amount and request disagree.",
          "AMOUNT_CONFLICT",
        );
      amount = positiveSats(decodedAmount ?? amount);
      const invoiceExpiry =
        (Number(decoded.timestamp) + Number(decoded.expiry ?? 3600)) * 1000;
      requires(
        Number.isFinite(invoiceExpiry) && invoiceExpiry > this._now(),
        "This payment request has expired. Ask for a new one.",
        "INVOICE_EXPIRED",
      );
      expiresAt = Math.min(expiresAt, invoiceExpiry);
      paymentHash = text(decoded.paymentHash);
      requires(
        paymentHash,
        "The wallet could not verify this invoice.",
        "INVALID_RESPONSE",
      );
      const lock = `${this.connection.walletId}:${paymentHash}`;
      requires(
        !this._paymentLocks.has(lock),
        "This payment was already submitted. Check Activity before sending again.",
        "ALREADY_SUBMITTED",
      );
      // What the channel can send, read before asking for a route: with no
      // room the router finds none, and the estimate's refusal used to hide
      // the reason. A channel whose primary is away sends nothing, and that is
      // not a low balance, so it is said first.
      const [liquidity, peers] = await Promise.all([
        this._get("/liquidity"),
        this._get("/peers"),
      ]);
      const sendable = integerField(liquidity.sendableSats, "available balance");
      const refuseShortfall = async (needed) => {
        const primary = rec.lfbw?.primaryPubkey;
        requires(
          !primary ||
            (Array.isArray(peers) &&
              peers.some(
                (p) =>
                  p.pubkey === primary &&
                  (p.connected || p.state === "connected" || p.state === "ready"),
              )),
          "Your primary node needs to reconnect before this wallet can send over Lightning. It retries by itself, so try again in a minute.",
          "PRIMARY_DOWN",
        );
        const arriving = await this._arrivingFunds(needed, rec);
        requires(
          false,
          arriving ||
            `You can send up to ${formatSats(sendable)} sats over Lightning right now, which is not enough for this payment and its fee.`,
          "INSUFFICIENT_FUNDS",
        );
      };
      if (amount > sendable) await refuseShortfall(amount);
      const estimate = await this._post(
        "/payment/estimate",
        {
          bolt11: target.invoice,
          ...(decodedAmount == null ? { amountSats: amount } : {}),
        },
        true,
      );
      estimatedFeeSats = integerField(estimate.estimatedFeeSats, "payment fee");
      if (!(amount + estimatedFeeSats <= sendable))
        await refuseShortfall(amount + estimatedFeeSats);
      // The review shows, and the payment is held to, a maximum: the
      // estimate plus headroom for rounding and a retry.
      feeSats = estimatedFeeSats + LIGHTNING_FEE_HEADROOM_SATS;
      if (estimate.warning) warnings.push(estimate.warning);
      destination = target.invoice;
      description = text(decoded.description) || description;
      route = "lightning";
      path = "/invoice/pay-safe";
      body = {
        bolt11: target.invoice,
        ...(decodedAmount == null ? { amountSats: amount } : {}),
        maxFeeSats: feeSats,
      };
    } else {
      amount = positiveSats(amount);
      destination = target.address;
      route = "bitcoin";
      const [channels, fees] = await Promise.all([
        this._get("/channels"),
        this._get("/fees/estimates"),
      ]);
      if (fundingCoin) {
        feeSats = DIRECT_FUNDING_FEE_HEADROOM_SATS;
        expiresAt = Math.min(expiresAt, parsed.funding.expiresAt);
        path = "/direct-funding/send";
        body = {
          request: parsed.funding.envelope,
          amountSats: amount,
          feeHeadroomSats: feeSats,
          address: destination,
        };
        warnings.push(
          "Paid as direct funding. Your coin becomes the recipient's channel funding in one transaction.",
        );
        this._assertEpoch(epoch);
        const review = {
          id: uid(),
          destination,
          description,
          amountSats: amount,
          feeSats,
          feeLabel: "Maximum network fee",
          totalSats: amount + feeSats,
          route,
          method: "direct-funding",
          expiresAt,
          warnings,
        };
        this._sendReviews.set(review.id, {
          review: clone(review),
          walletId: this.connection.walletId,
          path,
          body,
          envelope: parsed.funding.envelope,
        });
        return review;
      }
      if (parsed.funding && !this._fundingDeclined.has(parsed.funding.envelope))
        warnings.push(
          "This request accepts direct funding, which needs a confirmed coin outside your channel. Paying the address instead.",
        );
      const home = homeChannel(channels, rec.lfbw.primaryPubkey);
      requires(
        home,
        "Your wallet is still getting ready to send to a Bitcoin address. Wait for its funds to become available.",
        "NO_CHANNEL",
      );
      // Sending to a Bitcoin address splices the channel, which spends the
      // channel's funding output. While that output is unconfirmed the splice
      // is a child of an unconfirmed parent: a refused broadcast is now retried
      // by the engine (Beignet 0.17.0 keeps a zero-conf splice's transaction
      // until the chain has it), but the payment still cannot settle before
      // the funding does, and the engine reports no confirmation depth of its
      // own for a zero-conf channel. Wait for the funding instead of starting
      // a payment that can only sit behind its parent.
      requires(
        home.fundingConfirmed !== false,
        "This wallet's channel is still waiting for its own funding transaction to confirm. Sending to a Bitcoin address becomes available once it does. You can still send over Lightning now.",
        "FUNDING_UNCONFIRMED",
      );
      const feeRate = positiveSats(fees.normal);
      const feeratePerkw = feeRate * 250;
      const quote = await this._post(
        "/channel/splice-quote",
        { channelId: home.channelId, direction: "out", feeratePerkw },
        true,
      );
      feeSats = integerField(quote.feeSats, "transaction fee");
      if (!(amount <= integerField(quote.maxAmountSats, "send limit"))) {
        const arriving = await this._arrivingFunds(
          amount,
          rec,
          quote.maxAmountSats,
        );
        requires(
          false,
          arriving ||
            "The available balance is too low for this payment and its fee.",
          "INSUFFICIENT_FUNDS",
        );
      }
      path = "/channel/splice-out";
      body = {
        channelId: home.channelId,
        amountSats: amount,
        feeratePerkw,
        address: destination,
      };
      warnings.push("Completes after one confirmation.");
    }
    this._assertEpoch(epoch);
    const review = {
      id: uid(),
      destination,
      description,
      amountSats: amount,
      feeSats,
      feeLabel:
        route === "lightning" ? "Maximum routing fee" : "Estimated network fee",
      ...(estimatedFeeSats != null ? { estimatedFeeSats } : {}),
      totalSats: amount + feeSats,
      route,
      expiresAt,
      warnings,
    };
    this._sendReviews.set(review.id, {
      review: clone(review),
      walletId: this.connection.walletId,
      path,
      body,
      paymentHash,
    });
    return review;
  }
  async send(review) {
    const held = this._sendReviews.get(review?.id);
    requires(
      held && held.walletId === this.connection.walletId,
      "Review this payment again before sending.",
      "INVALID_REVIEW",
    );
    requires(
      JSON.stringify(review) === JSON.stringify(held.review),
      "The payment changed. Review it again before sending.",
      "REVIEW_CHANGED",
    );
    requires(
      held.review.expiresAt > this._now(),
      "This fee quote expired. Review the payment again.",
      "QUOTE_EXPIRED",
    );
    if (held.paymentHash)
      requires(
        !this._paymentLocks.has(`${held.walletId}:${held.paymentHash}`),
        "This payment was already submitted. Check Activity before sending again.",
        "ALREADY_SUBMITTED",
      );
    if (held.envelope)
      requires(
        !this._paymentLocks.has(`${held.walletId}:df:${held.envelope}`),
        "This payment was already submitted. Check Activity before sending again.",
        "ALREADY_SUBMITTED",
      );
    this._sendReviews.delete(review.id);
    if (held.paymentHash)
      this._paymentLocks.add(`${held.walletId}:${held.paymentHash}`);
    if (held.envelope)
      this._paymentLocks.add(`${held.walletId}:df:${held.envelope}`);
    if (held.path === "/direct-funding/send") {
      const result = await this._sendDirectFunding(review, held);
      this._recordSubmission(review, held, result);
      return result;
    }
    let result;
    try {
      const response = await this._post(
        held.path,
        held.path === "/channel/splice-out"
          ? {
              ...held.body,
              requestId: review.id,
              quotedFeeSats: review.feeSats,
              description: boundedDescription(review.description),
            }
          : held.body,
      );
      const status =
        held.path === "/channel/splice-out"
          ? response?.ok === false
            ? "failed"
            : response?.status
            ? activityStatus(response.status)
            : response &&
              (response.txid || response.spliceTxid || response.ok === true)
            ? "pending"
            : "uncertain"
          : response?.status
          ? activityStatus(response.status)
          : "uncertain";
      result = {
        id: review.id,
        status,
        amountSats: review.amountSats,
        feeSats:
          response?.feeSats == null
            ? review.feeSats
            : integerField(response.feeSats, "payment fee"),
        feeKnown: true,
        feeEstimated:
          held.path === "/channel/splice-out" || response?.feeSats == null,
        ...(response?.paymentHash || held.paymentHash
          ? { paymentHash: response?.paymentHash || held.paymentHash }
          : {}),
        ...(response?.txid || response?.spliceTxid
          ? { txid: response.txid || response.spliceTxid }
          : {}),
        message:
          status === "completed"
            ? "Payment sent."
            : status === "pending"
            ? "Payment submitted. Follow its progress in Activity."
            : status === "failed"
            ? text(response?.failureDescription) ||
              "The wallet declined this payment."
            : "The payment result is unknown. Check Activity before sending again.",
      };
    } catch (error) {
      result = {
        id: review.id,
        status: knownRefusal(error) ? "failed" : "uncertain",
        amountSats: review.amountSats,
        feeSats: review.feeSats,
        feeKnown: true,
        feeEstimated: true,
        ...(held.paymentHash ? { paymentHash: held.paymentHash } : {}),
        message: knownRefusal(error)
          ? error.message
          : "The connection ended without a final result. The payment may still complete. Check Activity; do not send it again.",
      };
    }
    this._recordSubmission(review, held, result);
    return result;
  }
  /**
   * Pay a direct-funding request once. The engine rejects only before the
   * witness leaves, so a throw or a pre-witness status means nothing was
   * spent: the result is a failure, the envelope is remembered as declined,
   * and the next review of the same request quotes a plain address payment.
   * The route is never changed inside this call; the user reviews the other
   * one. Anything after the witness is a payment out of our hands and is
   * shown as it stands.
   */
  async _sendDirectFunding(review, held) {
    let answer;
    try {
      answer = await this._post(held.path, {
        ...held.body,
        requestId: review.id,
        description: boundedDescription(review.description),
      });
    } catch (error) {
      // In-process, every throw is pre-witness by the engine's contract. Over
      // a host connection only a coded refusal is certain; a lost connection
      // is not, and stays uncertain like any other lost payment response.
      if (this.embedded || knownRefusal(error)) {
        answer = error instanceof Error ? error : new Error(String(error));
      } else {
        return {
          id: review.id,
          status: "uncertain",
          amountSats: review.amountSats,
          feeSats: review.feeSats,
          feeKnown: true,
          feeEstimated: true,
          message:
            "The connection ended without a final result. The payment may still complete. Check Activity; do not send it again.",
        };
      }
    }
    const outcome = fundingOutcome(answer);
    if (outcome.kind === "fallback") {
      this._fundingDeclined.add(held.envelope);
      this._paymentLocks.delete(`${held.walletId}:df:${held.envelope}`);
      return {
        id: review.id,
        status: "failed",
        amountSats: review.amountSats,
        feeSats: review.feeSats,
        feeKnown: true,
        feeEstimated: true,
        message: `${outcome.reason.replace(/\.?$/, ".")} Nothing was sent. Review again to pay the address.`,
      };
    }
    const status = outcome.settled
      ? outcome.status === "CONFIRMED"
        ? "completed"
        : "pending"
      : outcome.failed
      ? "failed"
      : "pending";
    return {
      id: review.id,
      status,
      amountSats: review.amountSats,
      feeSats: review.feeSats,
      feeKnown: true,
      feeEstimated: true,
      ...(outcome.txid ? { txid: outcome.txid } : {}),
      message: describeFunding(outcome),
    };
  }
  _recordSubmission(review, held, result) {
    if (result.status === "failed" && held.paymentHash)
      this._paymentLocks.delete(`${held.walletId}:${held.paymentHash}`);
    const reference = result.paymentHash || result.txid || review.id;
    this._localActivity.unshift({
      walletId: held.walletId,
      id: `submission:${review.id}`,
      kind: "sent",
      title:
        result.status === "uncertain"
          ? "Payment result unknown"
          : result.status === "failed"
          ? "Payment declined"
          : review.method === "direct-funding"
          ? "Direct funding sent"
          : "Payment sent",
      description: review.description || result.message,
      amountSats: result.amountSats,
      feeSats: result.feeSats,
      feeKnown: result.feeKnown,
      feeEstimated: result.feeEstimated,
      status: result.status,
      timestamp: this._now(),
      reference,
      ...(result.paymentHash ? { paymentHash: result.paymentHash } : {}),
      ...(result.txid ? { txid: result.txid } : {}),
    });
  }
  async quoteReceive({ amountSats, description, mode } = {}) {
    validateReceiveMode(mode);
    const epoch = this._epoch;
    const amount = amountOptional(amountSats);
    const rec = await this._record();
    const [channels, peers] = await Promise.all([
      this._get("/channels"),
      this._get("/peers"),
    ]);
    const connected = peers.some(
      (p) =>
        p.pubkey === rec.lfbw.primaryPubkey &&
        (p.connected || p.state === "connected" || p.state === "ready"),
    );
    let plan = planInvoice({
      wantedSats: amount || 0,
      channels,
      primaryPubkey: rec.lfbw.primaryPubkey,
      setup: rec.lfbw.setup,
      primaryConnected: connected,
    });
    let offlineQuote;
    // Receiving offline is an opt-in, never the default, on every surface
    // (umbrel 0.23.1 made the same change). The default plan is a plain
    // invoice over existing inbound capacity, or a JIT invoice when the
    // primary has to provide the capacity: it funds on the first payment and
    // takes its fee then. The embedded client used to prefer the offline lane
    // whenever the engine advertised it, which asked the primary to fund a
    // channel ahead of any payment (a fee-free open a primary is never meant
    // to give) and failed every receive against a primary that offers no
    // offline settlement.
    if (mode === "offline") {
      const config = await this.getConfig();
      requires(
        config.offlineReceiveAvailable === true,
        "This wallet does not support offline receiving.",
        "RECEIVE_UNAVAILABLE",
      );
      requires(amount != null, "Enter an amount for this payment request.", "AMOUNT_REQUIRED");
      offlineQuote = await this._get(`/receive/quote?amountSats=${amount}`);
      requires(offlineQuote?.available === true, "Your node cannot prepare this payment request right now. Try again shortly.", "RECEIVE_UNAVAILABLE");
      // A host's daemon answers an amount no channel can hold offline with a
      // direct-funding plan (beignet #925), which would fail verification
      // after the review. Refuse it here instead.
      requires(
        offlineQuote.mode !== "direct-funding",
        "No channel can hold an offline receive right now. It needs a channel with your primary node that holds none of your balance. Turn off Receive offline to create an ordinary payment request.",
        "RECEIVE_UNAVAILABLE",
      );
      plan = { kind: "offline" };
    }
    requires(
      plan.kind !== "refuse",
      plan.code === "PRIMARY_DOWN"
        ? "Your primary node needs to reconnect before creating this request."
        : "Your wallet is still getting ready. Retry setup from Settings.",
      plan.code || "NOT_READY",
    );
    let feeSats = 0;
    let feePolicy;
    const warnings = [];
    if (plan.kind === "jit") {
      requires(
        amount != null,
        "Enter an amount so your primary node can quote the receive fee.",
        "AMOUNT_REQUIRED",
      );
      const query = `?lspPubkey=${encodeURIComponent(
        rec.lfbw.primaryPubkey,
      )}&amountSats=${amount}&targetRemainingInboundSat=${INBOUND_HEADROOM_SATS}`;
      let quote;
      try {
        quote = await this._get("/jit/quote" + query);
      } catch (error) {
        throw jitReceiveError(error, "quote");
      }
      requires(
        quote.accepted === true && quote.withinCeilings === true,
        quote.reason ||
          "The primary node cannot provide capacity for this amount within your fee limit.",
        "RECEIVE_UNAVAILABLE",
      );
      feeSats = integerField(
        quote.feeSats ?? receiveFee(amount, quote.flatFeeSat, quote.feePpm),
        "receive fee",
      );
      feePolicy = {
        maxFlatFeeSat: integerField(quote.flatFeeSat, "receive fee"),
        maxFeePpm: integerField(quote.feePpm, "receive fee rate"),
      };
      requires(
        feeSats < amount,
        "The receive fee would use the entire amount. Request more sats.",
        "RECEIVE_FEE_TOO_HIGH",
      );
      if (feeSats > 0)
        warnings.push(
          `${formatSats(
            feeSats,
          )} sats are deducted if your primary provides new capacity.`,
        );
    }
    this._assertEpoch(epoch);
    const quote = {
      id: uid(),
      amountSats: amount,
      description: boundedDescription(description),
      feeSats,
      netSats: amount == null ? null : amount - feeSats,
      expiresAt: this._now() + 60000,
      warnings,
    };
    this._receiveQuotes.set(quote.id, {
      quote: clone(quote),
      walletId: this.connection.walletId,
      plan: plan.kind,
      rec,
      feePolicy,
      offlineQuote,
    });
    return quote;
  }
  async receive(quote) {
    const epoch = this._epoch;
    const held = this._receiveQuotes.get(quote?.id);
    requires(
      held && held.walletId === this.connection.walletId,
      "Review this receive request again.",
      "INVALID_REVIEW",
    );
    requires(
      JSON.stringify(quote) === JSON.stringify(held.quote),
      "The receive request changed. Review it again.",
      "REVIEW_CHANGED",
    );
    requires(
      quote.expiresAt > this._now(),
      "The receive quote expired. Review the request again.",
      "QUOTE_EXPIRED",
    );
    this._receiveQuotes.delete(quote.id);
    const amount = quote.amountSats;
    let address;
    let lightningOnly = false;
    try {
      const addressResult = await this._post("/address/new", {});
      this._assertEpoch(epoch);
      address = addressResult?.address;
      requires(
        parsePayment(address, { network: held.rec.network }).kind === "onchain",
        "The wallet returned an invalid receive address.",
        "INVALID_RESPONSE",
      );
    } catch (error) {
      if (error?.code !== "RECEIVE_ADDRESS_LIMIT") throw error;
      this._assertEpoch(epoch);
      lightningOnly = true;
    }
    const body = {
      ...(amount != null ? { amountSats: amount } : {}),
      description: quote.description,
      expirySecs: 600,
    };
    let invoice;
    try {
      invoice = await this._post(
        held.plan === "offline" ? "/receive/invoice" : held.plan === "jit" ? "/jit/invoice" : "/invoice/create",
        held.plan === "offline"
          ? { ...body, requestId: quote.id, quote: held.offlineQuote }
          : held.plan === "jit"
          ? {
              ...body,
              lspPubkey: held.rec.lfbw.primaryPubkey,
              targetRemainingInboundSat: INBOUND_HEADROOM_SATS,
              // Beignet 0.15.0 collects an opening fee two ways. `skim` takes it
              // out of the delivery, which is what quoteReceive priced and what
              // netSats reports. `hop` instead bills the sender through the
              // invoice hint. Name the mode rather than inherit a default.
              feeMode: "skim",
              ...held.feePolicy,
            }
          : body,
      );
    } catch (error) {
      // The engine creates the invoice only after the JIT authorization ACK.
      // An untyped lost response remains uncertain and is never rewritten here.
      throw held.plan === "jit" ? jitReceiveError(error, "invoice") : error;
    }
    this._assertEpoch(epoch);
    requires(held.plan !== "offline" || invoice?.offlineReceive === true, "Your payment request could not be verified. Check Activity before trying again.", "INVALID_RESPONSE");
    const parsed = parsePayment(invoice?.bolt11, { network: held.rec.network });
    requires(
      parsed.kind === "bolt11",
      "The wallet returned an invalid invoice. Check Activity before creating another request.",
      "INVALID_RESPONSE",
    );
    requires(
      parsed.amountSats == null || parsed.amountSats === amount,
      "The invoice amount differs from your request. Do not share it.",
      "AMOUNT_CONFLICT",
    );
    const decoded = await this._post(
      "/invoice/decode",
      { bolt11: invoice.bolt11 },
      true,
    );
    this._assertEpoch(epoch);
    requires(
      typeof decoded.paymentHash === "string" &&
        (!invoice.paymentHash || invoice.paymentHash === decoded.paymentHash),
      "The wallet returned inconsistent payment details. Do not share this request.",
      "INVALID_RESPONSE",
    );
    const invoiceExpiry =
      (Number(decoded.timestamp) + Number(decoded.expiry ?? 3600)) * 1000;
    requires(
      Number.isFinite(invoiceExpiry) && invoiceExpiry > this._now(),
      "The created request has expired. Create a new receive request.",
      "INVOICE_EXPIRED",
    );
    const actualFee =
      held.plan === "jit"
        ? receiveFee(amount, invoice.flatFeeSat, invoice.feePpm)
        : 0;
    requires(
      actualFee <= quote.feeSats,
      "The primary node changed its fee. This request was created but should not be shared; review a new quote.",
      "FEE_CHANGED",
    );
    // A daemon older than 0.15.0 reports no mode at all, which can only be skim.
    requires(
      held.plan !== "jit" ||
        invoice.feeMode == null ||
        invoice.feeMode === "skim",
      "The primary node changed how it collects its fee. This request was created but should not be shared; review a new quote.",
      "FEE_MODE_CHANGED",
    );
    let funding;
    let fundingExpires;
    const warnings = [...quote.warnings];
    if (lightningOnly)
      warnings.push(
        "This request accepts Lightning. Bitcoin receiving will be available again after an existing Bitcoin receive address is used.",
      );
    else if (held.plan !== "offline")
      try {
        const f = await this._post("/direct-funding/request", {
          ...(amount != null ? { amountSats: amount } : {}),
          ...(held.rec.reach?.host
            ? { host: held.rec.reach.host, port: held.rec.reach.port }
            : {}),
        });
        if (typeof f?.request === "string" && f.expiresAt > this._now()) {
          funding = f.request;
          fundingExpires = f.expiresAt;
        } else
          warnings.push(
            "Direct funding was unavailable; this request supports ordinary Bitcoin and Lightning payments.",
          );
      } catch {
        warnings.push(
          "Direct funding was unavailable; this request supports ordinary Bitcoin and Lightning payments.",
        );
      }
    this._assertEpoch(epoch);
    const expiresAt = Math.min(invoiceExpiry, fundingExpires || Infinity);
    requires(
      expiresAt > this._now(),
      "The created request expired while waiting for your host. Create a new request.",
      "INVOICE_EXPIRED",
    );
    const request = {
      id: quote.id,
      uri: lightningOnly
        ? invoice.bolt11
        : buildBip21({
            address,
            amountSats: amount || undefined,
            message: quote.description,
            lightning: invoice.bolt11,
            funding,
          }),
      ...(address ? { address } : {}),
      ...(lightningOnly ? { bitcoinTracking: "lightning-only" } : {}),
      bolt11: invoice.bolt11,
      ...(invoice.offlineReceive === true ? { offlineReceive: true } : {}),
      paymentHash: decoded.paymentHash,
      amountSats: amount,
      description: quote.description,
      feeSats: actualFee,
      expiresAt,
      warnings,
      demo: false,
    };
    try {
      const saved = await this._post("/receive/requests", { request });
      this._assertEpoch(epoch);
      return publicStoredRequest(saved?.request);
    } catch (error) {
      if (error?.code === "WALLET_CHANGED") throw error;
      throw new WalletError(
        "The invoice was created, but its full request could not be saved. Check Activity before creating another request.",
        "REQUEST_SAVE_FAILED",
        error?.status,
      );
    }
  }
  async importReceiveRequest(uri, expectedPaymentHash) {
    const epoch = this._epoch;
    const record = await this._record();
    this._assertEpoch(epoch);
    const parsed = parsePayment(uri, { network: record.network, now: 0 });
    requires(
      parsed.kind === "onchain" && parsed.lightning?.kind === "bolt11",
      "Paste the original request containing both its Bitcoin address and Lightning invoice.",
      "INVALID_REQUEST",
    );
    const decoded = await this._post(
      "/invoice/decode",
      { bolt11: parsed.lightning.invoice },
      true,
    );
    this._assertEpoch(epoch);
    const hash = text(decoded.paymentHash).toLowerCase();
    requires(
      /^[a-f0-9]{64}$/.test(hash),
      "The original request has an invalid invoice.",
      "INVALID_REQUEST",
    );
    requires(
      expectedPaymentHash == null ||
        hash === text(expectedPaymentHash).toLowerCase(),
      "This request belongs to a different invoice. Paste the original request for this activity.",
      "REQUEST_MISMATCH",
    );
    const invoices = await this._get("/invoices");
    this._assertEpoch(epoch);
    requires(
      Array.isArray(invoices) &&
        invoices.some(
          (invoice) =>
            text(invoice.paymentHash).toLowerCase() === hash &&
            text(invoice.bolt11).toLowerCase() ===
              parsed.lightning.invoice.toLowerCase(),
        ),
      "This invoice was not issued by the selected wallet.",
      "REQUEST_NOT_OWNED",
    );
    const amount = amountOptional(decoded.amountSats);
    requires(
      parsed.amountSats == null || parsed.amountSats === amount,
      "The request and invoice amounts differ.",
      "AMOUNT_CONFLICT",
    );
    const request = {
      id: `import-${hash}`,
      uri: text(uri).trim(),
      address: parsed.address,
      bolt11: parsed.lightning.invoice,
      paymentHash: hash,
      amountSats: amount,
      description: boundedDescription(parsed.message || decoded.description),
      feeSats: 0,
      expiresAt:
        (Number(decoded.timestamp) + Number(decoded.expiry ?? 3600)) * 1000,
      warnings: [],
      demo: false,
    };
    const saved = await this._post("/receive/requests", { request });
    this._assertEpoch(epoch);
    const canonical = publicStoredRequest(saved?.request);
    this._receiveStatusCache.delete(hash);
    return canonical;
  }
  async _reconcileReceiveActivity({
    activity,
    savedRequests,
    payments,
    invoices,
    notes,
  }) {
    const epoch = this._epoch;
    let registryUnavailable = false;
    try {
      this._savedReceiveRequests = publicStoredRequests(savedRequests);
    } catch {
      registryUnavailable = true;
    }
    let anyUnavailable = registryUnavailable;
    const requests = this._savedReceiveRequests;
    const cache = this._receiveStatusCache;
    const now = this._now();
    for (const request of requests) {
      if (
        request.bitcoinTracking === "ambiguous" &&
        cache.get(request.paymentHash)?.status?.method === "bitcoin"
      )
        cache.delete(request.paymentHash);
      const paid = activity.find(
        (row) =>
          row.paymentHash === request.paymentHash &&
          row.kind === "received" &&
          row.status === "completed" &&
          !row.txid,
      );
      if (paid)
        cache.set(request.paymentHash, {
          checkedAt: now,
          status: {
            phase: "completed",
            receivedSats: paid.amountSats,
            confirmedSats: paid.amountSats,
            pendingSats: 0,
            method: "lightning",
            paymentHash: request.paymentHash,
            activityId: paid.id,
            txids: [],
          },
        });
    }
    for (const request of requests) {
      if (
        request.bitcoinTracking === "lightning-only" &&
        !cache.has(request.paymentHash)
      )
        cache.set(request.paymentHash, {
          checkedAt: now,
          status: {
            phase: "waiting",
            receivedSats: 0,
            confirmedSats: 0,
            pendingSats: 0,
            method: "lightning",
            paymentHash: request.paymentHash,
            txids: [],
          },
        });
    }
    // A full wallet refresh checks at most two address histories concurrently.
    // Oldest observations rotate first; foreground request tracking stays fresh.
    const due = requests
      .filter((request) => {
        if (
          registryUnavailable ||
          request.bitcoinTracking === "ambiguous" ||
          request.bitcoinTracking === "lightning-only"
        )
          return false;
        const previous = cache.get(request.paymentHash);
        const ttl = previous?.failed
          ? 60000
          : previous?.status?.phase === "completed"
          ? 300000
          : 30000;
        return !previous || now - previous.checkedAt >= ttl;
      })
      .sort(
        (a, b) =>
          (cache.get(a.paymentHash)?.checkedAt ?? 0) -
            (cache.get(b.paymentHash)?.checkedAt ?? 0) ||
          (b.createdAt ?? 0) - (a.createdAt ?? 0),
      )
      .slice(0, 2);
    await Promise.all(
      due.map(async (request) => {
        try {
          const status = await this._receiveStatusFor(
            request,
            payments,
            invoices,
            true,
          );
          this._assertEpoch(epoch);
          cache.set(request.paymentHash, { status, checkedAt: now });
        } catch {
          if (epoch === this._epoch)
            cache.set(request.paymentHash, {
              ...cache.get(request.paymentHash),
              failed: true,
              checkedAt: now,
            });
        }
      }),
    );
    this._assertEpoch(epoch);
    const replacements = new Map();
    const covered = new Map();
    for (const request of requests) {
      const existing = activity.find(
        (row) => row.paymentHash === request.paymentHash,
      );
      // Self-pay/outgoing records remain separate; never relabel them as income.
      if (existing?.kind === "sent") continue;
      const observation = cache.get(request.paymentHash);
      const status = observation?.status;
      const received = status && status.phase !== "waiting";
      const row = {
        ...(existing || {}),
        id: existing?.id || `payment:${request.paymentHash}`,
        kind: received ? "received" : "request",
        title: received
          ? status.phase === "partial"
            ? "Partial payment received"
            : "Payment received"
          : "Payment request",
        description: request.description || existing?.description || "",
        amountSats: received ? status.receivedSats : request.amountSats ?? 0,
        feeSats: status?.method === "lightning" ? existing?.feeSats ?? 0 : 0,
        feeKnown:
          status?.method === "lightning" ? existing?.feeKnown ?? false : false,
        feeEstimated: false,
        status: received
          ? status.phase === "completed"
            ? "completed"
            : "pending"
          : request.expiresAt <= now
          ? "expired"
          : "pending",
        timestamp: existing?.timestamp || request.createdAt || 0,
        reference: request.paymentHash,
        paymentHash: request.paymentHash,
        address: request.address,
        receiveRequest: request,
        ...(status ? { receiveStatus: status } : {}),
        ...(status?.txid ? { txid: status.txid } : {}),
        ...(!observation ||
        observation.failed ||
        registryUnavailable ||
        (request.bitcoinTracking === "ambiguous" &&
          status?.method !== "lightning")
          ? { receiveStatusUnavailable: true }
          : {}),
      };
      if (row.receiveStatusUnavailable) anyUnavailable = true;
      replacements.set(request.paymentHash, row);
      if (status?.method === "bitcoin")
        for (const tx of status.transactions ?? [])
          covered.set(tx.txid, (covered.get(tx.txid) || 0) + tx.amountSats);
    }
    const result = activity
      .filter((row) => !replacements.has(row.paymentHash))
      .flatMap((row) => {
        if (row.kind !== "received" || !row.txid || !covered.has(row.txid))
          return [row];
        const remainder = row.amountSats - covered.get(row.txid);
        // A batch can also pay other wallet addresses. Keep that unlinked value
        // instead of duplicating all the already-attributed request outputs.
        return remainder > 0 ? [{ ...row, amountSats: remainder }] : [];
      });
    if (anyUnavailable)
      notes.push(
        "Some receive requests are still being checked. Their last known status is shown.",
      );
    return [...result, ...replacements.values()];
  }
  async getReceiveStatus(request) {
    const epoch = this._epoch;
    const [payments, invoices] = await Promise.all([
      this._get("/payments"),
      this._get("/invoices"),
    ]);
    this._assertEpoch(epoch);
    const status = await this._receiveStatusFor(request, payments, invoices);
    this._assertEpoch(epoch);
    this._receiveStatusCache.set(request.paymentHash.toLowerCase(), {
      status,
      checkedAt: this._now(),
    });
    return status;
  }
  async _receiveStatusFor(request, payments, invoices, registered = false) {
    const epoch = this._epoch;
    const lightningOnly = request?.bitcoinTracking === "lightning-only";
    const parsed = parsePayment(request?.address);
    const paymentHash = text(request?.paymentHash).toLowerCase();
    requires(
      !request?.demo &&
        (lightningOnly
          ? !request.address &&
            parsePayment(request.uri, { now: 0 }).kind === "bolt11"
          : parsed.kind === "onchain") &&
        /^[a-f0-9]{64}$/.test(paymentHash),
      "Check the original receive request before tracking this payment.",
      "INVALID_REQUEST",
    );
    const amount = amountOptional(request.amountSats);
    const address = parsed.address;
    this._assertEpoch(epoch);
    requires(
      !this._closed,
      "Unlock your local wallet before continuing.",
      "ENGINE_CLOSED",
    );
    requires(
      Array.isArray(payments) && Array.isArray(invoices),
      "The wallet returned incomplete receive tracking details.",
      "INVALID_RESPONSE",
    );
    const matchesHash = (entry) =>
      text(entry?.paymentHash).toLowerCase() === paymentHash;
    const lightning = mergeActivity(
      {
        payments: payments
          .filter(matchesHash)
          .map((entry) => ({ ...entry, paymentHash })),
        invoices: invoices
          .filter(matchesHash)
          .map((entry) => ({ ...entry, paymentHash })),
      },
      this._now(),
    ).find(
      (entry) => entry.kind === "received" && entry.status === "completed",
    );
    // A settled invoice proves fulfillment even when JIT fees make its actual
    // receipt smaller than the requested face amount. Never infer this from a
    // same-amount payment, an issued invoice, or a pending incoming HTLC.
    if (lightning)
      return {
        phase: "completed",
        receivedSats: lightning.amountSats,
        confirmedSats: lightning.amountSats,
        pendingSats: 0,
        method: "lightning",
        paymentHash,
        activityId: lightning.id,
        txids: [],
      };
    if (lightningOnly)
      return {
        phase: "waiting",
        receivedSats: 0,
        confirmedSats: 0,
        pendingSats: 0,
        method: "lightning",
        paymentHash,
        txids: [],
      };
    if (!registered) {
      // Another client can register a second invoice using an old host's
      // reused address. Never rely on the QR's original uniqueness flag.
      const registry = publicStoredRequests(
        await this._get("/receive/requests"),
      );
      this._assertEpoch(epoch);
      const known = registry.find((entry) => entry.paymentHash === paymentHash);
      requires(
        !known || known.address === address,
        "The saved request has a different Bitcoin address.",
        "REQUEST_MISMATCH",
      );
      requires(
        !registry.some(
          (entry) =>
            entry.address === address &&
            (entry.bitcoinTracking === "ambiguous" ||
              entry.paymentHash !== paymentHash),
        ),
        "This Bitcoin address was used for more than one request. Its Bitcoin payments cannot be assigned to a specific request; check Bitcoin Activity. Lightning payments are still tracked by invoice.",
        "AMBIGUOUS_RECEIVE_ADDRESS",
      );
    }
    requires(
      request.bitcoinTracking !== "ambiguous",
      "This Bitcoin address was used for more than one request. Its Bitcoin payments cannot be assigned to a specific request; check Bitcoin Activity. Lightning payments are still tracked by invoice.",
      "AMBIGUOUS_RECEIVE_ADDRESS",
    );
    // A settled Lightning payment must not wait for a separate Electrum read.
    const receipt = await this._get(
      `/receive/onchain?address=${encodeURIComponent(address)}`,
    );
    this._assertEpoch(epoch);
    requires(
      !this._closed,
      "Unlock your local wallet before continuing.",
      "ENGINE_CLOSED",
    );
    requires(
      receipt?.address === address && Array.isArray(receipt.transactions),
      "The wallet returned incomplete address receipt details.",
      "INVALID_RESPONSE",
    );
    const transactions = new Map();
    for (const tx of receipt.transactions) {
      const txid = text(tx?.txid).toLowerCase();
      requires(
        /^[a-f0-9]{64}$/.test(txid) && typeof tx?.confirmed === "boolean",
        "The wallet returned invalid address receipt details.",
        "INVALID_RESPONSE",
      );
      const amountSats = integerField(tx.amountSats, "address receipt amount");
      const previous = transactions.get(txid);
      requires(
        !previous ||
          (previous.amountSats === amountSats &&
            previous.confirmed === tx.confirmed),
        "The wallet returned conflicting address receipt details.",
        "INVALID_RESPONSE",
      );
      transactions.set(txid, { txid, amountSats, confirmed: tx.confirmed });
    }
    let receivedSats = 0;
    let confirmedSats = 0;
    for (const tx of transactions.values()) {
      receivedSats = integerField(
        receivedSats + tx.amountSats,
        "received total",
      );
      if (tx.confirmed)
        confirmedSats = integerField(
          confirmedSats + tx.amountSats,
          "confirmed receipt total",
        );
    }
    const txids = [...transactions.values()]
      .filter((tx) => tx.amountSats > 0)
      .map((tx) => tx.txid)
      .sort();
    const phase =
      receivedSats === 0
        ? "waiting"
        : amount != null && receivedSats < amount
        ? "partial"
        : confirmedSats >= (amount ?? receivedSats)
        ? "completed"
        : "pending";
    return {
      phase,
      receivedSats,
      confirmedSats,
      pendingSats: receivedSats - confirmedSats,
      transactions: [...transactions.values()].filter(
        (tx) => tx.amountSats > 0,
      ),
      txids,
      ...(txids.length
        ? {
            method: "bitcoin",
            txid: txids[0],
            activityId: `transaction:${txids[0]}`,
          }
        : {}),
    };
  }
  async updatePrimary(uri) {
    const epoch = this._epoch;
    const primaryUri = validatePrimaryUri(uri);
    const rec = await this._record();
    this._assertEpoch(epoch);
    const result = await this._request(
      `/api/wallets/${encodeURIComponent(rec.id)}`,
      "PATCH",
      {
        lfbw: {
          enabled: true,
          primaryUri,
          trusted: true,
          initialChannelSats: 0,
        },
        ...(primaryUri.includes(".onion:") ? { tor: true } : {}),
      },
    );
    this._sendReviews.clear();
    this._receiveQuotes.clear();
    return publicWallet(result);
  }
  async retrySetup() {
    await this._request(this._managerWalletPath("/lfbw/setup"), "POST", {});
  }
}

// Preview runs wholly in memory and never touches a transport or real wallet.
export class DemoWalletClient {
  constructor() {
    this.demo = true;
    this.connection = { url: "demo:", token: "", walletId: "demo-wallet" };
    this.wallet = {
      id: "demo-wallet",
      name: "Everyday wallet",
      network: "mainnet",
      status: "running",
      lfbw: {
        enabled: true,
        setup: "ready",
        primaryUri: DEFAULT_PRIMARY_URI,
        primaryPubkey: DEFAULT_PRIMARY_URI.split("@")[0],
      },
    };
    this._balance = 284650;
    this._sendReviews = new Map();
    this._receiveQuotes = new Map();
    this._activity = [
      {
        id: "demo-1",
        kind: "received",
        title: "Payment received",
        description: "Friday funds",
        amountSats: 150000,
        feeSats: 0,
        status: "completed",
        timestamp: Date.now() - 3600000,
        reference: "demo-received-1",
      },
      {
        id: "demo-2",
        kind: "sent",
        title: "Payment sent",
        description: "Morning coffee",
        amountSats: 4200,
        feeSats: 2,
        status: "completed",
        timestamp: Date.now() - 86400000,
        reference: "demo-sent-2",
      },
      {
        id: "demo-3",
        kind: "received",
        title: "Bitcoin received",
        description: "Savings top-up",
        amountSats: 50000,
        feeSats: 0,
        status: "pending",
        timestamp: Date.now() - 172800000,
        reference: "demo-received-3",
      },
      {
        id: "demo-4",
        kind: "sent",
        title: "Payment sent",
        description: "Lunch with Alex",
        amountSats: 18450,
        feeSats: 4,
        status: "completed",
        timestamp: Date.now() - 259200000,
        reference: "demo-sent-4",
      },
    ];
  }
  async getConfig() {
    return {
      defaultNetwork: "mainnet",
      defaultElectrum: null,
      hasDefaultElectrum: false,
      supportedNetworks: ["mainnet", "testnet", "regtest"],
      electrumPresets: [],
      torAvailable: true,
      lfbwAvailable: true,
      jitQuoteAvailable: true,
      recoveryAvailable: true,
    };
  }
  async getRecoveryPhrase() {
    throw new WalletError(
      "Preview wallets have no recovery phrase.",
      "DEMO_ONLY",
    );
  }
  async getRecoveryStatus() {
    return {
      mode: "off", state: "disabled", importPending: false, importComplete: false,
      autoApply: { enabled: false, phase: "idle", lastReason: null },
      capsuleCount: 0, backupChannelCount: null, channels: [],
    };
  }
  async listWallets() {
    return [clone(this.wallet)];
  }
  selectWallet(id) {
    requires(id === this.wallet.id, "Choose the preview wallet.", "NO_WALLET");
  }
  async createWallet({ name, network = "mainnet", primaryUri, mnemonic, recoveryAutoApply } = {}) {
    requires(mnemonic === undefined && recoveryAutoApply !== true,
      "Recovery phrases cannot be imported into a preview wallet.", "DEMO_ONLY");
    this.wallet = {
      ...this.wallet,
      name: boundedDescription(name) || "My wallet",
      network,
      lfbw: {
        ...this.wallet.lfbw,
        primaryUri: validatePrimaryUri(primaryUri || DEFAULT_PRIMARY_URI),
      },
    };
    return clone(this.wallet);
  }
  async snapshot() {
    return {
      wallet: clone(this.wallet),
      balance: {
        totalSats: this._balance + 50000,
        availableSats: this._balance,
        pendingSats: 50000,
        receivableSats: 715350,
      },
      activity: clone(this._activity),
      primary: {
        uri: this.wallet.lfbw.primaryUri,
        connected: true,
        setup: "ready",
      },
      notes: [
        "50,000 sats are arriving. They will become available after confirmation.",
      ],
      updatedAt: Date.now(),
      demo: true,
    };
  }
  async prepareSend({ request, amountSats } = {}) {
    const parsed = parsePayment(request, { network: this.wallet.network });
    const preview = ["demo", "demo:coffee"].includes(
      text(request).trim().toLowerCase(),
    );
    requires(
      preview || !["empty", "invalid"].includes(parsed.kind),
      parsed.message ||
        "Paste a request, or type demo to try a preview payment.",
      "INVALID_REQUEST",
    );
    const fixed = parsed.amountSats ?? parsed.lightning?.amountSats;
    const typed = amountOptional(amountSats);
    requires(
      fixed == null || typed == null || fixed === typed,
      "The entered amount differs from the payment request.",
      "AMOUNT_CONFLICT",
    );
    const amount = positiveSats(fixed ?? typed ?? (preview ? 4200 : null));
    const route =
      parsed.kind === "onchain" && !parsed.lightning ? "bitcoin" : "lightning";
    const feeSats =
      route === "bitcoin" ? 350 : Math.max(1, Math.ceil(amount * 0.0005));
    requires(
      amount + feeSats <= this._balance,
      "Your preview balance is too low.",
      "INSUFFICIENT_FUNDS",
    );
    const review = {
      id: uid(),
      destination: preview ? "Preview recipient" : request,
      description: preview
        ? "Coffee with a friend"
        : parsed.message || "Preview payment",
      amountSats: amount,
      feeSats,
      feeLabel:
        route === "lightning" ? "Maximum routing fee" : "Estimated network fee",
      totalSats: amount + feeSats,
      route,
      expiresAt: Date.now() + 60000,
      warnings: ["Preview only. No real money will move."],
    };
    this._sendReviews.set(review.id, clone(review));
    return review;
  }
  async send(review) {
    const held = this._sendReviews.get(review?.id);
    requires(
      held && JSON.stringify(held) === JSON.stringify(review),
      "Review this payment again.",
      "INVALID_REVIEW",
    );
    requires(
      held.expiresAt > Date.now(),
      "The quote expired. Review again.",
      "QUOTE_EXPIRED",
    );
    this._sendReviews.delete(review.id);
    this._balance -= review.totalSats;
    const status = review.route === "bitcoin" ? "pending" : "completed";
    this._activity.unshift({
      id: review.id,
      kind: "sent",
      title: "Payment sent",
      description: review.description,
      amountSats: review.amountSats,
      feeSats: review.feeSats,
      status,
      timestamp: Date.now(),
      reference: `demo:${review.id}`,
    });
    return {
      id: review.id,
      status,
      amountSats: review.amountSats,
      feeSats: review.feeSats,
      message:
        status === "completed"
          ? "Preview payment sent. No real money moved."
          : "Preview payment is confirming. No real money moved.",
    };
  }
  async quoteReceive({ amountSats, description, mode } = {}) {
    validateReceiveMode(mode);
    requires(
      mode !== "offline",
      "This wallet does not support offline receiving.",
      "RECEIVE_UNAVAILABLE",
    );
    const amount = amountOptional(amountSats);
    const quote = {
      id: uid(),
      amountSats: amount,
      description: boundedDescription(description),
      feeSats: 0,
      netSats: amount,
      expiresAt: Date.now() + 60000,
      warnings: ["Preview only. This request cannot receive real funds."],
    };
    this._receiveQuotes.set(quote.id, clone(quote));
    return quote;
  }
  async receive(quote) {
    const held = this._receiveQuotes.get(quote?.id);
    requires(
      held && JSON.stringify(held) === JSON.stringify(quote),
      "Review this request again.",
      "INVALID_REVIEW",
    );
    requires(
      held.expiresAt > Date.now(),
      "This quote expired.",
      "QUOTE_EXPIRED",
    );
    this._receiveQuotes.delete(quote.id);
    // Deliberately non-payable QR: a preview must never send funds to an example address.
    const request = {
      id: quote.id,
      uri: `beignet-demo:request/${quote.id}?amount=${quote.amountSats || 0}`,
      address: "Preview only, no Bitcoin address",
      bolt11: "",
      paymentHash: `demo:${quote.id}`,
      amountSats: quote.amountSats,
      description: quote.description,
      feeSats: 0,
      expiresAt: Date.now() + 600000,
      warnings: quote.warnings,
      demo: true,
    };
    this._activity.unshift({
      id: quote.id,
      kind: "request",
      title: "Payment request",
      description: quote.description,
      amountSats: quote.amountSats || 0,
      feeSats: 0,
      status: "pending",
      timestamp: Date.now(),
      reference: request.paymentHash,
      paymentHash: request.paymentHash,
      receiveRequest: clone(request),
    });
    return request;
  }
  async getReceiveStatus(request) {
    requires(
      request?.demo === true && text(request.paymentHash).startsWith("demo:"),
      "Choose a preview receive request.",
      "INVALID_REQUEST",
    );
    const activity = this._activity.find(
      (entry) =>
        entry.reference === request.paymentHash &&
        entry.kind === "received" &&
        entry.status === "completed",
    );
    return {
      phase: activity ? "completed" : "waiting",
      receivedSats: activity?.amountSats || 0,
      confirmedSats: activity?.amountSats || 0,
      pendingSats: 0,
      txids: [],
      ...(activity
        ? {
            method: "lightning",
            paymentHash: request.paymentHash,
            activityId: activity.id,
          }
        : {}),
    };
  }
  async importReceiveRequest() {
    throw new WalletError(
      "Preview wallets cannot import real payment requests.",
      "DEMO_ONLY",
    );
  }
  async updatePrimary(uri) {
    this.wallet.lfbw.primaryUri = validatePrimaryUri(uri);
    return clone(this.wallet);
  }
  async startWallet() {}
  async refreshWallet() {}
  async retrySetup() {}
  async diagnostics() {
    return { checkedAt: Date.now(), demo: true };
  }
}

/**
 * Runs the same wallet flows against an engine in this device/process or its
 * worker. The runtime owns the seed, database, local lifecycle and network
 * transports. It exposes raw results for the existing route-shaped commands;
 * this adapter never creates an HTTP request or falls back to a wallet host.
 */
export class EmbeddedWalletClient extends WalletClient {
  constructor({ runtime, walletId } = {}) {
    requires(
      runtime && typeof runtime.request === "function",
      "A local wallet engine is required.",
      "ENGINE_REQUIRED",
    );
    // Base construction initializes only review state. Its HTTP transport is
    // deliberately unusable; every command dispatches through _request below.
    super(
      {
        url: "http://127.0.0.1",
        token: "unused-local-runtime",
        ...(walletId ? { walletId } : {}),
      },
      {
        fetch: () => {
          throw new WalletError(
            "A local wallet never uses the host transport.",
            "EMBEDDED_HTTP_FORBIDDEN",
          );
        },
      },
    );
    this.connection = Object.freeze({
      url: "embedded:",
      token: "",
      ...(walletId ? { walletId } : {}),
    });
    this.embedded = true;
    this._runtime = runtime;
    this._closed = false;
    this._runtimeClosed = false;
    this._closingPromise = undefined;
  }
  async _request(path, method = "GET", body, readOnly = method === "GET") {
    requires(
      !this._closed,
      "Unlock your local wallet before continuing.",
      "ENGINE_CLOSED",
    );
    try {
      return await this._runtime.request({
        method,
        path,
        ...(body !== undefined ? { body: clone(body) } : {}),
      });
    } catch (error) {
      if (error instanceof WalletError) throw error;
      const message =
        text(error?.message) ||
        (readOnly
          ? "The local wallet engine is unavailable. Unlock it and refresh."
          : "The local wallet did not confirm the result. Check Activity before attempting this action again.");
      const code =
        text(error?.code) ||
        (readOnly ? "ENGINE_UNAVAILABLE" : "RESULT_UNCERTAIN");
      throw new WalletError(
        message,
        code,
        typeof error?.status === "number" ? error.status : undefined,
      );
    }
  }
  async close() {
    if (this._runtimeClosed) return;
    if (this._closingPromise) return this._closingPromise;
    this._closed = true;
    this._sendReviews.clear();
    this._receiveQuotes.clear();
    this._closingPromise = (async () => {
      try {
        if (typeof this._runtime.close === "function")
          await this._runtime.close();
        this._runtimeClosed = true;
      } finally {
        this._closingPromise = undefined;
      }
    })();
    return this._closingPromise;
  }
}
