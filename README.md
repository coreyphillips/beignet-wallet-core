# Beignet wallet core

Dependency-free ES modules shared by the native and web apps. In host mode, the host holds keys and runs Beignet. In embedded mode, the local portable engine owns keys and runs inside the device or browser worker. This package supplies the same wallet interface for both modes; it never changes an embedded request into a host request. See [CONTRACT.md](CONTRACT.md) for the UI contract.

```js
import { WalletClient } from '@beignet/wallet-core';

const wallet = new WalletClient({ url: 'https://your-wallet-host.example', token });
const wallets = await wallet.listWallets();
wallet.selectWallet(wallets[0].id);
const snapshot = await wallet.snapshot();
const review = await wallet.prepareSend({ request: recipientRequest });
// Show amount, fee, recipient, expiry and warnings. Send only after confirmation.
const result = await wallet.send(review);
```

`DemoWalletClient` is an explicitly selected, isolated in-memory preview. It never calls `fetch`, and its receive QR is deliberately non-payable. `demo` and `demo:coffee` are sample send inputs in preview only.

## Payment behavior

- Parse integer sats and decimal Bitcoin amounts without floating-point rounding. The whole-sat UI refuses fractional-sat invoices. Validate request checksums, network, conflicting amounts, required BIP21 parameters and invisible directional controls before requesting a quote.
- Prefer a valid embedded Lightning invoice in BIP21. Lightning quotes set a `maxFeeSats` cap on `/invoice/pay-safe`. A Bitcoin address uses the primary channel's quoted `/channel/splice-out` path. Fee quotes expire after at most 60 seconds and are bound to the selected wallet and original payment details.
- Send is single-use. Pending is not success. Transport loss or an unrecognized result means **uncertain**; no retry or alternative payment route is attempted. The host durably journals Bitcoin address sends before forwarding them, using a unique request ID to prevent replay. Reconnecting restores these submissions through `/api/wallets/:id/activity`. Matching verified transaction records replace local placeholders. Unknown results remain uncertain until the host obtains payment evidence; no completion is inferred from a balance change.
- Receive quotes disclose capacity fees before minting an invoice. Exact integer fee calculation rounds up, matching Beignet. The quoted flat fee and proportional fee become ceilings on JIT creation. An existing channel's capacity is reused first. One BIP21 request carries address, invoice and direct-funding `bgnq` where available. Signed invoice expiry is read from the daemon, so a delayed response does not extend its lifetime.
- BOLT12 offers are recognized but cannot be submitted in this version: Beignet's offer payment API does not provide a bounded-fee review contract. Ask for a one-time Lightning invoice instead. LNURL and Lightning addresses are not supported.

## Balances and activity

A failed snapshot read throws instead of displaying zero. Total includes the daemon's distinct Lightning, Bitcoin, splice, pending-close and errored buckets. Opening-channel balances are added only after their funding transaction is observed, avoiding double counting funds still held as UTXOs. Disconnected and restore-held channel balances are already included in the daemon's Lightning balance. Available uses its spendable liquidity figure, which excludes reserves.

Payments and invoices share their payment hash, so a paid request becomes one received item. Matching channel funding transactions display as internal transfers. Explicit submitted Bitcoin sends retain their sent label. General activity exposes no payment preimage, seed, payment secret or unrestricted metadata. `feeKnown:false` means the daemon did not disclose a fee; `feeEstimated:true` means the value is a reviewed quote rather than an actual charge. Missing fees are never labeled as a known zero. Some recovery actions and transfers away from a previous primary still need advanced management tools. In host mode these are available through the host; embedded mode does not yet expose them. The journal reports its verified status; a pending initiation is not a confirmed transaction.

## Startup and synchronization

`startWallet()` starts the selected host wallet only when the UI explicitly invokes it, such as selecting a stopped wallet. `refreshWallet()` performs the daemon's safe wallet refresh; use it before a manual refresh or pull-to-refresh snapshot. Snapshots themselves only read. The daemon already launches a bounded background startup sync, so the client does not duplicate it on every poll. A failed refresh remains an error rather than a zero balance.

## Connection and recovery

Bearer tokens remain in memory in this package. The caller chooses secure storage, and must never serialize the creation response because it may contain a mnemonic. HTTP is accepted only for loopback and Android emulator host `10.0.2.2`; remote hosts require HTTPS. URLs containing embedded credentials, query strings or paths are rejected. Fetches omit cookies, request no-store caching, and refuse redirects.

New wallets enable peer-storage channel recovery. Seed words alone do not contain the latest Lightning channel state; the host data and peer recovery capabilities still matter. Creation returns the manager's mnemonic to the deliberate backup view once. `getRecoveryPhrase()` is an explicit authenticated read for that same view, and the phrase must be cleared when it closes. No real recovery phrases are used in tests.

## Verification

```sh
npm ci
npm test
npm run typecheck
```

Node tests cover the real manager response wrappers and daemon request bodies with an injected transport, including fee ceilings, JIT creation, unified receive parsing, expiry, duplicate prevention, uncertain/pending outcomes, privacy, balance accounting and demo isolation. The type check verifies the public declarations and native/web consumer contract. A fixture invoice is not a cryptographically signed real invoice; daemon signature verification remains authoritative in a connected wallet.

The payment URI, funding envelope and LFBW reference logic were adapted from the sibling `beignet-umbrel/manager/ui/src/lib` implementation. This package changes no files in that source project. The funding codec is platform-independent and needs no browser `atob`/`btoa` globals; the serializer's test-only envelope encoder is not used for real funding requests.

## Embedded integration

```js
import { EmbeddedWalletClient } from '@beignet/wallet-core';

// runtime is a real createPortableRuntime(...) instance or its worker RPC.
const wallet = new EmbeddedWalletClient({ runtime });
const wallets = await wallet.listWallets();
if (wallets.length) wallet.selectWallet(wallets[0].id);
```

The runtime accepts `request({method,path,body})` and returns raw command results. It owns wallet creation, local seed/database storage, networking and the durable payment journal. `EmbeddedWalletClient` performs no HTTP calls and supplies no fake engine or silent host fallback. It reuses the same amount parsing, review binding, fee limits, single-use dispatch, uncertain-result handling and activity normalization as host mode.

## License

MIT. See [LICENSE](LICENSE).
