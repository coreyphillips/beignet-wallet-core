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
    primaryPubkey?: string | null;
    primaryWalletId?: string | null;
    setup?: string;
    /** Safe user-facing diagnostic; raw engine messages are never exposed. */
    setupError?: string;
    trusted?: boolean;
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
  status: PaymentStatus;
  timestamp: number;
  reference: string;
  txid?: string;
  paymentHash?: string;
  address?: string;
  receiveRequest?: ReceiveRequestDetails;
  receiveStatus?: ReceiveStatus;
  receiveStatusUnavailable?: boolean;
}
export interface WalletSnapshot {
  wallet: WalletRecord;
  balance: {
    totalSats: number;
    availableSats: number;
    pendingSats: number;
    receivableSats: number;
    /**
     * The most an offline receive can take right now, 0 when no channel can
     * hold one. Absent when the engine does not say (a host's daemon).
     */
    offlineReceivableSats?: number;
  };
  activity: Activity[];
  primary: {
    uri: string;
    connected: boolean;
    setup: string;
    /** Safe user-facing diagnostic; absent when setup has no recorded error. */
    setupError?: string;
  };
  notes: string[];
  updatedAt: number;
  demo: boolean;
}
export interface SendInput {
  request: string;
  amountSats?: number | string | null;
}
export interface SendReview {
  id: string;
  destination: string;
  description: string;
  amountSats: number;
  feeSats: number;
  feeLabel: string;
  totalSats: number;
  route: "lightning" | "bitcoin";
  /** Present when a Bitcoin route pays a direct-funding request instead of the address. */
  method?: "direct-funding";
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
  txid?: string;
  paymentHash?: string;
  message: string;
}
export interface ReceiveInput {
  amountSats?: number | string | null;
  description?: string;
  /**
   * Omit for the default, which is unified: ordinary Lightning over existing
   * inbound, or JIT when the primary has to provide the capacity, with Bitcoin
   * and direct funding when available. Offline is an opt-in on every surface:
   * it requires advertised support and never falls back to unified.
   */
  mode?: "unified" | "offline";
}
export interface ReceiveQuote {
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
  method?: "lightning" | "bitcoin";
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
  jitQuoteAvailable?: boolean;
  recoveryAvailable?: boolean;
  recoveryAutoApplyAvailable?: boolean;
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
  channels?:
    | {
        channelId: string;
        withPrimary: boolean;
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
  prepareSend(input: SendInput): Promise<SendReview>;
  send(review: SendReview): Promise<SendResult>;
  quoteReceive(input?: ReceiveInput): Promise<ReceiveQuote>;
  receive(quote: ReceiveQuote): Promise<ReceiveRequest>;
  getReceiveStatus(request: ReceiveRequest): Promise<ReceiveStatus>;
  importReceiveRequest(
    uri: string,
    expectedPaymentHash?: string,
  ): Promise<ReceiveRequest>;
  updatePrimary(uri: string): Promise<WalletRecord>;
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
export class WalletClient implements WalletClientInterface {
  constructor(
    connection: Connection,
    options?: { fetch?: typeof globalThis.fetch; now?: () => number },
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
  prepareSend(input: SendInput): Promise<SendReview>;
  send(review: SendReview): Promise<SendResult>;
  quoteReceive(input?: ReceiveInput): Promise<ReceiveQuote>;
  receive(quote: ReceiveQuote): Promise<ReceiveRequest>;
  getReceiveStatus(request: ReceiveRequest): Promise<ReceiveStatus>;
  importReceiveRequest(
    uri: string,
    expectedPaymentHash?: string,
  ): Promise<ReceiveRequest>;
  updatePrimary(uri: string): Promise<WalletRecord>;
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
  prepareSend(input: SendInput): Promise<SendReview>;
  send(review: SendReview): Promise<SendResult>;
  quoteReceive(input?: ReceiveInput): Promise<ReceiveQuote>;
  receive(quote: ReceiveQuote): Promise<ReceiveRequest>;
  getReceiveStatus(request: ReceiveRequest): Promise<ReceiveStatus>;
  importReceiveRequest(
    uri: string,
    expectedPaymentHash?: string,
  ): Promise<ReceiveRequest>;
  updatePrimary(uri: string): Promise<WalletRecord>;
  startWallet(): Promise<void>;
  refreshWallet(): Promise<void>;
  retrySetup(): Promise<void>;
  diagnostics(): Promise<WalletDiagnostics>;
}
export const DEFAULT_PRIMARY_URI: string;
export const DEFAULT_HOST_URL: string;
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
  constructor(options: { runtime: EmbeddedRuntime; walletId?: string });
  readonly embedded: true;
  close(): Promise<void>;
}
