export type Network = "mainnet" | "testnet" | "regtest";
export type PaymentStatus =
  | "completed"
  | "pending"
  | "uncertain"
  | "failed"
  | "expired";
export interface Connection {
  url: string;
  token: string;
  walletId?: string;
}
export interface WalletRecord {
  id: string;
  name: string;
  network: Network;
  status: string;
  lfbw?: {
    enabled: boolean;
    mode?: "external" | "internal";
    primaryUri?: string | null;
    primaryFallbackUri?: string | null;
    primaryPubkey?: string | null;
    primaryWalletId?: string | null;
    setup?: string;
    /** Safe user-facing diagnostic; raw engine messages are never exposed. */
    setupError?: string;
    trusted?: boolean;
    offlineReceiveAvailable?: boolean | null;
    offlineReceiveReason?: string | null;
    /**
     * The ranked primaries as the wallet record mirrors the engine's list,
     * rank 1 first, each with the facts the engine does not hold (trust, an
     * onion fallback for an Iroh primary, its setup state) and whether it is
     * connected. Absent on an engine with one primary (the scalar fields above).
     */
    primaries?: Array<{
      pubkey: string;
      uri: string | null;
      fallbackUri?: string | null;
      trusted?: boolean;
      setup?: string;
      setupError?: string;
      connected?: boolean;
      offlineReceiveAvailable?: boolean | null;
      offlineReceiveReason?: string | null;
    }>;
    /** The fill threshold in sats; null means no cap (the first-ranked primary always takes the receive). */
    primariesThresholdSat?: number | null;
    /** The primary a receive that names no peer goes to, or null with none. */
    receiveTarget?: string | null;
    /** Peers this wallet still holds live channels with that are not ranked primaries; their balance stays in the total. */
    retainedPeers?: Array<{ pubkey: string; channelCount: number; balanceSat: number }>;
    /** A payer this wallet has not paired with is growing the home channel; the splice locks at depth. */
    unpairedFunding?: { at: number };
    /** The home channel's last splice conflict or revert, while it is worth telling. */
    lastSplice?: {
      state: "conflicted" | "reverted";
      spliceTxid: string | null;
      conflictTxid: string | null;
      at: number;
    };
    /** The wallet's last channelize decision: a wait with its reason, a move, or a failure. */
    lastChannelize?: {
      action: "wait" | "splice-in" | "open" | "open-v2" | "failed";
      at: number;
      reason?: string;
      error?: string;
      code?: string;
      feeSats?: number;
      amountSats?: number;
      retryAt?: number;
      fallbackFrom?: string;
    };
    /** The last direct-funding offer this wallet answered, and why. */
    lastOffer?: {
      state: "accepted" | "declined" | "failed" | "completed";
      reason: string | null;
      at: number;
    };
  };
}
export interface Activity {
  id: string;
  kind: "sent" | "received" | "request" | "transfer";
  title: string;
  description: string;
  amountSats: number;
  feeSats: number;
  feeKnown?: boolean;
  feeEstimated?: boolean;
  payAll?: PayAllAmounts;
  drain?: DrainProgress;
  status: PaymentStatus;
  timestamp: number;
  reference: string;
  txid?: string;
  paymentHash?: string;
  address?: string;
  /**
   * Set, with status `failed`, on an on-chain transaction the engine reports
   * as dropped: unconfirmed and gone from its server, because it was
   * replaced, a conflicting spend of its inputs confirmed, or the mempool
   * evicted it. It will not confirm and is not in the balance.
   */
  dropped?: true;
  receiveRequest?: ReceiveRequestDetails;
  receiveStatus?: ReceiveStatus;
  receiveStatusUnavailable?: boolean;
  /** An address paid out of several channels in one transaction: the engine's channel-send record behind this row. */
  channelSend?: { kind: "single" | "composite"; id: string; stage?: string };
}
/** Why one ranked primary did not take a steered receive. */
export interface ReceiveSteerSkip {
  pubkey: string;
  /** 1-based configured rank. */
  rank: number;
  /** `budget`: not tried, the walk's budget ran out before it. */
  stage: "connect" | "attempt" | "budget";
  code: string;
  message: string;
}
/** One ranked primary as the engine and the wallet record know it now. */
export interface PrimaryStatus {
  pubkey: string;
  /** 1 is the highest rank. */
  rank: number;
  uri: string;
  /** A v3 onion address for the same key, for an Iroh primary. */
  fallbackUri?: string | null;
  connected: boolean;
  setup: string;
  /** Safe user-facing diagnostic; absent when setup has no recorded error. */
  setupError?: string;
  trusted?: boolean;
  /** Our local balance summed over our usable channels with it. */
  balanceSat: number;
  channelCount: number;
  belowThreshold?: boolean;
  /** Whether a receive that names no peer would go to this primary. */
  isReceiveTarget: boolean;
  /** 1-based position in the order a receive tries the primaries. */
  selectionOrder: number;
  offlineReceiveAvailable?: boolean | null;
  offlineReceiveReason?: string | null;
}
/** The ranked primaries policy: the engine owns it, the apps display and edit it. */
export interface PrimariesPolicy {
  /** Sats of local balance a primary is filled to before receives move on; null means no cap. */
  thresholdSat: number | null;
  /** The pubkey a receive that names no peer would go to, or null with no primaries. */
  receiveTarget: string | null;
  /** Rank order. */
  primaries: PrimaryStatus[];
}
export interface AddPrimaryInput {
  /** `pubkey@host:port`, `pubkey@iroh:endpoint-id` or a Porch link, `pubkey@wss://relay/v1/p/route-id`. */
  uri: string;
  /** A v3 onion address for the same key, for an Iroh primary. */
  fallbackUri?: string | null;
  /** 1-based rank to insert at; the default is last. */
  rank?: number;
}
export interface WalletSnapshot {
  wallet: WalletRecord;
  balance: {
    totalSats: number;
    availableSats: number;
    pendingSats: number;
    /**
     * What `pendingSats` is made of. The six parts always sum to it. Every
     * snapshot carries it; the field is optional so a host's own snapshot
     * fixtures and older readings still type-check.
     */
    pending?: {
      /** Unconfirmed deposits. */
      unconfirmedSats: number;
      /** Confirmed on-chain funds not yet in a channel. */
      confirmedSats: number;
      /** Funding a channel that is still opening. */
      openingSats: number;
      /** Moving into the channel through a splice. */
      splicingSats: number;
      /** Coming back from a channel that is closing. */
      closingSats: number;
      /** Held up and needing recovery attention. */
      erroredSats: number;
    };
    receivableSats: number;
    /**
     * The most an offline receive can take right now, 0 when no channel can
     * hold one. Absent when the engine does not say (a host's daemon).
     */
    offlineReceivableSats?: number;
    /** Already reserved inbound, informational and never subtracted from availableSats. */
    reservedInboundSats?: number;
    unresolvedOfflineSlots?: number;
  };
  offlineReservations?: OfflineReservation[];
  activity: Activity[];
  primary: {
    uri: string;
    fallbackUri?: string | null;
    connected: boolean;
    setup: string;
    offlineReceiveAvailable?: boolean | null;
    offlineReceiveReason?: string | null;
    /** Safe user-facing diagnostic; absent when setup has no recorded error. */
    setupError?: string;
  };
  /**
   * The ranked primaries, rank 1 first, when the engine ranks them
   * (`getConfig().primariesAvailable`); `primary` above is rank 1.
   */
  primaries?: PrimaryStatus[];
  primariesThresholdSat?: number | null;
  /** The primary a receive that names no peer would go to. */
  primariesReceiveTarget?: string | null;
  notes: string[];
  updatedAt: number;
  demo: boolean;
}
export interface SendInput {
  request: string;
  amountSats?: number | string | null;
  max?: boolean;
  /**
   * Whole sats per virtual byte for a payment to a Bitcoin address, 1 to
   * MAX_FEE_RATE. Ignored on the Lightning, direct-funding and drain routes,
   * which price themselves.
   */
  feeRate?: number;
}
export interface MaxInput {
  request: string;
  feeRate?: number;
}
/** The engine's estimates when a Bitcoin review was priced, whole sats per virtual byte. */
export interface FeeRates {
  fast: number;
  normal: number;
  slow: number;
  minimum: number;
}
export type KeptReason = "none" | "reserve" | "commitment-cost" | "unavailable";
export interface MaxQuote {
  /** A pay-all recipient minimum, or the resolved address output. No review is held. */
  amountSats: number;
  keptSats: number;
  keptReason: KeptReason;
}
export interface PayAllAmounts {
  /** Exact decimal millisatoshis. These strings must never pass through Number. */
  debitMsat: string;
  maxFeeMsat: string;
  deliveredMsat: string;
  feeMsat: string;
  remainderMsat: string;
}
export interface DrainProgress {
  /** Monotonic coordinator revision, including reorg updates. */
  revision: number;
  requestId: string;
  phase: "review" | "preparing" | "closing" | "sweeping" | "pending" | "cancelling" | "cancelled" | "completed";
  address: string;
  amountSats: number;
  feeSats: number;
  debitSats: number;
  reviewedDebitSats: number;
  closeAmountSats: number;
  closeFeeSats: number;
  sweepAmountSats: number;
  sweepFeeSats: number;
  feeEstimated: boolean;
  txids: string[];
  createdAt: number;
  expiresAt: number;
  startedAt?: number;
  residualSats?: number;
}
export interface DrainInput { address: string; }
export interface SendReview {
  id: string;
  destination: string;
  description: string;
  amountSats: number;
  /** The Lightning fee cap, or the estimated network fees for a drain. */
  feeSats: number;
  feeLabel: string;
  /** Lightning only: the fee of the route that was priced, usually what is paid. */
  estimatedFeeSats?: number;
  /** The reviewed debit. Pay-all rounds its ceiling up; drain closing fees may change. */
  totalSats: number;
  max?: true;
  keptSats?: number;
  keptReason?: KeptReason;
  /** Pay-all bounds are independent facts, not a sum of rounded amounts. */
  minRecipientSats?: number;
  maxFeeSats?: number;
  debitSats?: number;
  debitMsat?: string;
  maxFeeMsat?: string;
  route: "lightning" | "bitcoin";
  /** Present when a Bitcoin route pays a direct-funding request instead of the address. */
  method?: "direct-funding" | "drain";
  drain?: DrainProgress;
  /** A Bitcoin splice only: the rate the quote was priced at, the one given or the engine's normal. */
  feeRate?: number;
  /** A Bitcoin splice only: the engine's estimates at quote time, for choosing another rate. */
  feeRates?: FeeRates;
  /**
   * A Bitcoin payment out of several channels in one transaction (the
   * engine's channel-send plan), when no single channel covers the amount.
   */
  channelSend?: { kind: "composite"; channels: number };
  expiresAt: number;
  warnings: string[];
}
export interface SendResult {
  id: string;
  status: Exclude<PaymentStatus, "expired">;
  amountSats: number;
  feeSats: number;
  feeKnown?: boolean;
  feeEstimated?: boolean;
  payAll?: PayAllAmounts;
  drain?: DrainProgress;
  txid?: string;
  paymentHash?: string;
  /** The engine's channel-send record behind a payment out of several channels. */
  channelSend?: { kind: "composite"; channels: number; id: string };
  message: string;
}
export interface OfflineReservation {
  channelId: string;
  state: string;
  concurrent: boolean;
  concurrentVersion?: 1 | 2;
  reservedInboundSats: number;
  unresolvedSlots: number;
}
export interface ReceiveInput {
  /** Refresh an interrupted offline request without changing its identity or profile. */
  requestId?: string;
  amountSats?: number | string | null;
  description?: string;
  /**
   * Omit for the default, which is unified: ordinary Lightning over existing
   * inbound, or JIT when the primary has to provide the capacity, with Bitcoin
   * and direct funding when available. Offline is an opt-in on every surface:
   * it requires advertised support and never falls back to unified.
   */
  mode?: "unified" | "offline";
  /**
   * The primary (33-byte pubkey, hex) to quote at. Omitted, the engine's
   * ranked primaries choose, and the quote names the one that took it.
   */
  peer?: string;
}
export interface ReceiveQuote {
  mode?: "offline";
  concurrentVersion?: 1 | 2;
  /** The primary that took a JIT or offline quote (the one named, or the one the ranked list chose). */
  peer?: string;
  /** Steered quotes only: the primaries passed over before this one. */
  skipped?: ReceiveSteerSkip[];
  id: string;
  amountSats: number | null;
  description: string;
  feeSats: number;
  netSats: number | null;
  expiresAt: number;
  warnings: string[];
}
export interface ReceiveRequest {
  offlineReceive?: boolean;
  /** The primary a JIT or offline request was created with. */
  peer?: string;
  id: string;
  uri: string;
  address?: string;
  bolt11: string;
  paymentHash: string;
  amountSats: number | null;
  description: string;
  feeSats: number;
  expiresAt: number;
  warnings: string[];
  demo: boolean;
  createdAt?: number;
  bitcoinTracking?: "unique" | "ambiguous" | "lightning-only";
}
/** Legacy invoices have their original Lightning code but no inferred address. */
export type ReceiveRequestDetails = Omit<ReceiveRequest, "address"> & {
  address?: string;
  legacy?: boolean;
};
export interface ReceiveStatus {
  phase: "waiting" | "partial" | "pending" | "completed";
  /** Exact address-output total, or the settled Lightning receipt amount. */
  receivedSats: number;
  /** Confirmed address-output total, or the settled Lightning receipt amount. */
  confirmedSats: number;
  pendingSats: number;
  /**
   * "direct-funding" when the payer funded this wallet's channel instead of
   * paying the invoice or the address: pending while the splice or open is
   * locking, completed once the channel is on it.
   */
  method?: "lightning" | "bitcoin" | "direct-funding";
  /** The splice or open transaction a direct-funding payment went into. */
  fundingTxid?: string;
  activityId?: string;
  paymentHash?: string;
  /** All matching Bitcoin transaction IDs, deduplicated and sorted. */
  txids: string[];
  /** First matching Bitcoin transaction, for an optional Activity link. */
  txid?: string;
  transactions?: Array<{
    txid: string;
    amountSats: number;
    confirmed: boolean;
  }>;
}
export interface ElectrumServer {
  host: string;
  port: number;
  tls: boolean;
}
export interface HostConfig {
  defaultNetwork: Network;
  defaultElectrum: ElectrumServer | null;
  hasDefaultElectrum: boolean;
  supportedNetworks: Network[];
  electrumPresets: Array<
    ElectrumServer & {
      id?: string;
      label?: string;
      name?: string;
      note?: string;
      network?: Network;
    }
  >;
  torAvailable: boolean;
  lfbwAvailable: boolean;
  offlineReceiveAvailable?: boolean;
  concurrentOfflineReceiveAvailable?: boolean;
  jitQuoteAvailable?: boolean;
  drainAvailable?: boolean;
  recoveryAvailable?: boolean;
  recoveryAutoApplyAvailable?: boolean;
  /** The engine ranks several primaries and steers receives through them. */
  primariesAvailable?: boolean;
  /** An address can be paid out of several channels in one transaction. */
  channelSendAvailable?: boolean;
  engineVersion?: string;
}
export interface CreatedWallet extends WalletRecord {
  mnemonic?: string;
  /** Creation-only notices supplied by the wallet, limited to five 512-character strings. */
  warnings?: string[];
}
export interface CreateWalletInput {
  name?: string;
  network?: Network;
  primaryUri?: string;
  electrum?: ElectrumServer;
  /** An existing recovery phrase to restore instead of generating a new one. */
  mnemonic?: string;
  /** Explicit browser import opt-in. The previous wallet must be closed. */
  recoveryAutoApply?: boolean;
}
/** Public recovery progress only, without capsules, keys or transport credentials. */
export interface WalletRecoveryStatus {
  mode: "off" | "peer-storage" | "async-remote" | "quorum";
  state: "disabled" | "running" | "restore-required" | "restoring" | "restart-required" | "fenced";
  importPending: boolean;
  importComplete: boolean;
  autoApply: {
    enabled: boolean;
    phase: "idle" | "settling" | "applying" | "applied" | "refused";
    lastReason: string | null;
  };
  capsuleCount: number;
  backupChannelCount: number | null;
  channels: {
    channelId: string;
    status: string;
    restoreRecencyUnproven: boolean;
    fundingUnidentified: boolean;
  }[];
}
/** One read of what the engine reports about itself, for the owner to inspect. */
export interface WalletDiagnostics {
  primaryTransport?: 'iroh-direct' | 'iroh-relay' | 'iroh-unknown' | 'tor' | 'tcp' | 'ws' | null;
  primaryRttMs?: number | null;
  checkedAt: number;
  demo?: boolean;
  wallet?: WalletRecord["lfbw"] | null;
  blockHeight?: number | null;
  electrumConnected?: boolean | null;
  primaryConnected?: boolean | null;
  balance?: { onchain: number; lightning: number; splicingSats: number } | null;
  sendableSats?: number | null;
  /** The network map routes are found on (GET /graph/info). */
  graph?: { nodes: number; channels: number; lastSyncAt: number | null } | null;
  utxos?: { valueSats: number; height: number }[] | null;
  /** Each ranked primary's connection, when the engine ranks them. */
  primaries?:
    | {
        pubkey: string;
        rank: number;
        connected: boolean;
        transport: 'iroh-direct' | 'iroh-relay' | 'iroh-unknown' | 'tor' | 'tcp' | 'ws' | null;
        rttMs: number | null;
      }[]
    | null;
  channels?:
    | {
        channelId: string;
        withPrimary: boolean;
        /** The configured rank of the channel's peer, or null when it is not a ranked primary. */
        peerRank?: number | null;
        state: string;
        htlcUsable: boolean | null;
        fundingConfirmed: boolean | null;
        fundingTxid: string | null;
        capacitySats: number;
        localBalanceSats: number;
        remoteBalanceSats: number;
        pendingSpliceLocalBalanceSats?: number;
        payThroughSplice?: boolean;
        restoreRecencyUnproven?: boolean;
        fundingUnaccounted?: boolean;
      }[]
    | null;
  directFunding?: {
    lspPubkey: string | null;
    lspHost: string | null;
    lspPort: number | null;
    allowSplice: boolean | null;
    allowUnpairedSplice: boolean | null;
    unpairedSpliceDepth: number | null;
    minAmountSat: number | null;
  } | null;
}
export interface WalletClientInterface {
  readonly connection: Connection;
  readonly demo: boolean;
  selectWallet(id: string): void;
  getConfig(): Promise<HostConfig>;
  getRecoveryPhrase(): Promise<string>;
  getRecoveryStatus(): Promise<WalletRecoveryStatus>;
  listWallets(): Promise<WalletRecord[]>;
  createWallet(input?: CreateWalletInput): Promise<CreatedWallet>;
  snapshot(): Promise<WalletSnapshot>;
  quoteMax(input: MaxInput): Promise<MaxQuote>;
  prepareSend(input: SendInput): Promise<SendReview>;
  prepareDrain(input: DrainInput): Promise<SendReview>;
  getDrain(requestId: string): Promise<DrainProgress>;
  cancelDrain(requestId: string): Promise<DrainProgress>;
  send(review: SendReview): Promise<SendResult>;
  quoteReceive(input?: ReceiveInput): Promise<ReceiveQuote>;
  receive(quote: ReceiveQuote): Promise<ReceiveRequest>;
  getReceiveStatus(request: ReceiveRequest): Promise<ReceiveStatus>;
  importReceiveRequest(
    uri: string,
    expectedPaymentHash?: string,
  ): Promise<ReceiveRequest>;
  updatePrimary(uri: string, fallbackUri?: string): Promise<WalletRecord>;
  listPrimaries(): Promise<PrimariesPolicy>;
  addPrimary(input: AddPrimaryInput): Promise<PrimariesPolicy>;
  removePrimary(pubkey: string): Promise<PrimariesPolicy>;
  reorderPrimaries(pubkeys: string[]): Promise<PrimariesPolicy>;
  setPrimariesThreshold(sats: number | null): Promise<PrimariesPolicy>;
  startWallet(): Promise<void>;
  refreshWallet(): Promise<void>;
  retrySetup(): Promise<void>;
  diagnostics(): Promise<WalletDiagnostics>;
}
export class WalletError extends Error {
  code: string;
  status?: number;
  constructor(message: string, code?: string, status?: number);
}
/**
 * Where a client keeps each wallet's completed activity between launches.
 * `load` returns the rows the client last saved for the wallet (anything
 * malformed is ignored); `save` receives every completed row, newest first.
 * Without a store the ledger lives in memory for the client's lifetime.
 */
export interface ActivityStore {
  load(
    walletId: string,
  ): Activity[] | null | undefined | Promise<Activity[] | null | undefined>;
  save(walletId: string, rows: Activity[]): void | Promise<void>;
}
export class WalletClient implements WalletClientInterface {
  constructor(
    connection: Connection,
    options?: {
      fetch?: typeof globalThis.fetch;
      now?: () => number;
      store?: ActivityStore;
    },
  );
  readonly connection: Connection;
  readonly demo: boolean;
  selectWallet(id: string): void;
  getConfig(): Promise<HostConfig>;
  getRecoveryPhrase(): Promise<string>;
  getRecoveryStatus(): Promise<WalletRecoveryStatus>;
  listWallets(): Promise<WalletRecord[]>;
  createWallet(input?: CreateWalletInput): Promise<CreatedWallet>;
  snapshot(): Promise<WalletSnapshot>;
  quoteMax(input: MaxInput): Promise<MaxQuote>;
  prepareSend(input: SendInput): Promise<SendReview>;
  prepareDrain(input: DrainInput): Promise<SendReview>;
  getDrain(requestId: string): Promise<DrainProgress>;
  cancelDrain(requestId: string): Promise<DrainProgress>;
  send(review: SendReview): Promise<SendResult>;
  quoteReceive(input?: ReceiveInput): Promise<ReceiveQuote>;
  receive(quote: ReceiveQuote): Promise<ReceiveRequest>;
  getReceiveStatus(request: ReceiveRequest): Promise<ReceiveStatus>;
  importReceiveRequest(
    uri: string,
    expectedPaymentHash?: string,
  ): Promise<ReceiveRequest>;
  updatePrimary(uri: string, fallbackUri?: string): Promise<WalletRecord>;
  listPrimaries(): Promise<PrimariesPolicy>;
  addPrimary(input: AddPrimaryInput): Promise<PrimariesPolicy>;
  removePrimary(pubkey: string): Promise<PrimariesPolicy>;
  reorderPrimaries(pubkeys: string[]): Promise<PrimariesPolicy>;
  setPrimariesThreshold(sats: number | null): Promise<PrimariesPolicy>;
  startWallet(): Promise<void>;
  refreshWallet(): Promise<void>;
  retrySetup(): Promise<void>;
  diagnostics(): Promise<WalletDiagnostics>;
}
export class DemoWalletClient implements WalletClientInterface {
  constructor();
  readonly connection: Connection;
  readonly demo: boolean;
  selectWallet(id: string): void;
  getConfig(): Promise<HostConfig>;
  getRecoveryPhrase(): Promise<string>;
  getRecoveryStatus(): Promise<WalletRecoveryStatus>;
  listWallets(): Promise<WalletRecord[]>;
  createWallet(input?: CreateWalletInput): Promise<CreatedWallet>;
  snapshot(): Promise<WalletSnapshot>;
  quoteMax(input: MaxInput): Promise<MaxQuote>;
  prepareSend(input: SendInput): Promise<SendReview>;
  prepareDrain(input: DrainInput): Promise<SendReview>;
  getDrain(requestId: string): Promise<DrainProgress>;
  cancelDrain(requestId: string): Promise<DrainProgress>;
  send(review: SendReview): Promise<SendResult>;
  quoteReceive(input?: ReceiveInput): Promise<ReceiveQuote>;
  receive(quote: ReceiveQuote): Promise<ReceiveRequest>;
  getReceiveStatus(request: ReceiveRequest): Promise<ReceiveStatus>;
  importReceiveRequest(
    uri: string,
    expectedPaymentHash?: string,
  ): Promise<ReceiveRequest>;
  updatePrimary(uri: string, fallbackUri?: string): Promise<WalletRecord>;
  listPrimaries(): Promise<PrimariesPolicy>;
  addPrimary(input: AddPrimaryInput): Promise<PrimariesPolicy>;
  removePrimary(pubkey: string): Promise<PrimariesPolicy>;
  reorderPrimaries(pubkeys: string[]): Promise<PrimariesPolicy>;
  setPrimariesThreshold(sats: number | null): Promise<PrimariesPolicy>;
  startWallet(): Promise<void>;
  refreshWallet(): Promise<void>;
  retrySetup(): Promise<void>;
  diagnostics(): Promise<WalletDiagnostics>;
}
export const DEFAULT_PRIMARY_URI: string;
export const DEFAULT_HOST_URL: string;
/** Routing fee a Lightning send may pay above the estimate. */
export const LIGHTNING_FEE_HEADROOM_SATS: number;
/** The highest fee rate a splice takes, in sats per virtual byte. */
export const MAX_FEE_RATE: number;
export function parseSats(input: string | number): number;
export function formatSats(input: number): string;
export function validatePrimaryUri(input: string): string;
export function normalizeConnection(connection: Connection): Connection;
export function btcStringToSats(
  input: string,
): { ok: true; sats: number } | { ok: false; code: string };
export function satsToBtcString(sats: number | bigint): string;
export function buildBip21(input?: {
  address?: string;
  amountSats?: number;
  message?: string;
  label?: string;
  lightning?: string;
  funding?: string;
}): string;
export interface PaymentWarning {
  code: string;
  message: string;
}
export type ParsedPayment =
  | { kind: "empty" }
  | { kind: "invalid"; code: string; message: string }
  | {
      kind: "bolt11";
      invoice: string;
      network: string;
      amountSats: number | null;
      warnings: PaymentWarning[];
    }
  | {
      kind: "bolt12";
      offer: string;
      amountSats?: number | null;
      warnings: PaymentWarning[];
    }
  | {
      kind: "onchain";
      address: string;
      amountSats?: number | null;
      label?: string;
      message?: string;
      lightning?: ParsedPayment | null;
      funding?: {
        envelope: string;
        expiresAt: number;
        amountSats: number | null;
        /** What the receiver records a payment of this request under. */
        receiptHash: string | null;
      } | null;
      warnings: PaymentWarning[];
    };
export function parsePayment(
  input: string,
  options?: { network?: string; now?: number },
): ParsedPayment;
export function mergeActivity(
  input: {
    payments?: Array<Record<string, unknown>>;
    invoices?: Array<Record<string, unknown>>;
    transactions?: Array<Record<string, unknown>>;
    channels?: Array<Record<string, unknown>>;
    sentTxids?: string[];
  },
  now?: number,
): Activity[];

export interface EmbeddedRuntimeRequest {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
}
/** Local engine or worker RPC. Raw route results; never a remote wallet host. */
export interface EmbeddedRuntime {
  request(request: EmbeddedRuntimeRequest): unknown | Promise<unknown>;
  close?(): void | Promise<void>;
}
export class EmbeddedWalletClient extends WalletClient {
  constructor(options: {
    runtime: EmbeddedRuntime;
    walletId?: string;
    store?: ActivityStore;
  });
  readonly embedded: true;
  close(): Promise<void>;
}

export interface ParsedPrimary {
  pubkey: string;
  host: string;
  port: number;
  uri: string;
  transport?:
    | { type: "iroh"; endpointId: string; relayUrl?: string }
    /** A Porch link: the relay's WebSocket URL with the node's route id. `host` is the relay's and `port` is 0. */
    | { type: "ws"; url: string };
}
export function parsePrimaryUri(input: string): ParsedPrimary;
export function parsePrimaryFallback(primary: ParsedPrimary, input?: string): ParsedPrimary | undefined;
