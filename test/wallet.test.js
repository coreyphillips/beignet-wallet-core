import test from "node:test";
import assert from "node:assert/strict";
import {
  WalletClient,
  EmbeddedWalletClient,
  DemoWalletClient,
  DEFAULT_PRIMARY_URI,
  LIGHTNING_FEE_HEADROOM_SATS,
  parseSats,
  parsePayment,
  btcStringToSats,
  normalizeConnection,
  mergeActivity,
} from "../src/index.js";
import { bech32Encode, convertBits } from "../src/payment-uri.js";
import { arrivingFundsNote, CHANNELIZE_FLOOR_SATS } from "../src/lfbw.js";
import {
  base64urlDecode,
  base64urlEncode,
  encodeFundingEnvelope,
} from "../src/funding-envelope.js";

const NOW = 1788600000000;
const PK = DEFAULT_PRIMARY_URI.split("@")[0];
const ADDRESS = bech32Encode("bc", [
  0,
  ...convertBits(new Array(20).fill(7), 8, 5, true),
]);
const INVOICE = bech32Encode("lnbc100u", new Array(111).fill(0)); // 10,000 sats, fixture daemon validates signature.
const HASH = "ab".repeat(32);
const record = {
  id: "wallet-1",
  name: "My wallet",
  network: "mainnet",
  status: "running",
  lfbw: {
    enabled: true,
    primaryUri: DEFAULT_PRIMARY_URI,
    primaryPubkey: PK,
    setup: "ready",
  },
};
const channel = {
  channelId: "channel-1",
  peerPubkey: PK,
  htlcUsable: true,
  state: "NORMAL",
  localBalanceSats: 200000,
  remoteBalanceSats: 100000,
};
const result = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});
function fixture(overrides = {}) {
  let now = NOW;
  const calls = [];
  const storedRequests = [];
  const defaults = {
    "/api/wallets": [record],
    "/api/wallets/wallet-1": record,
    "/api/wallets/wallet-1/activity": [],
    "/api/wallets/wallet-1/start": record,
    "/wallet/refresh": { refreshed: true },
    "/api/config": {
      defaultNetwork: "mainnet",
      defaultElectrum: null,
      supportedNetworks: ["mainnet", "regtest"],
      lfbwAvailable: true,
    },
    "/info": { pendingCloseBalanceSats: 0, erroredBalanceSats: 0 },
    "/balance": { onchain: 2000, lightning: 200000, splicingSats: 500 },
    "/liquidity": { sendableSats: 190000 },
    "/channels": [channel],
    "/utxos": [{ height: 0, valueSats: 2000 }],
    "/peers": [{ pubkey: PK, state: "connected" }],
    "/payments": [],
    "/invoices": [],
    "/transactions": [],
    "GET /receive/requests": () => ({ requests: storedRequests }),
    "POST /receive/requests": ({ request }) => {
      const saved = { ...request, createdAt: NOW };
      storedRequests.push(saved);
      return { request: saved };
    },
    "/receive/onchain": {
      address: ADDRESS,
      receivedSats: 0,
      confirmedSats: 0,
      transactions: [],
    },
    "/invoice/decode": (_body, _query, seen) => ({
      paymentHash: HASH,
      amountSats: 10000,
      description: "Coffee",
      timestamp: seen.some((c) =>
        ["/invoice/create", "/jit/invoice"].includes(c.path),
      )
        ? NOW / 1000
        : NOW / 1000 - 60,
      expiry: seen.some((c) =>
        ["/invoice/create", "/jit/invoice"].includes(c.path),
      )
        ? 600
        : 3600,
    }),
    "/payment/estimate": { estimatedFeeSats: 7, warning: "Route estimate" },
    "/fees/estimates": { normal: 2 },
    "/channel/splice-quote": { feeSats: 225, maxAmountSats: 180000 },
    "/invoice/pay-safe": {
      status: "COMPLETED",
      paymentHash: HASH,
      amountSats: 10000,
      feeSats: 5,
      preimage: "secret-never-exposed",
    },
    "/channel/splice-out": { txid: "cd".repeat(32), ok: true },
    "/address/new": { address: ADDRESS },
    "/invoice/create": {
      bolt11: INVOICE,
      paymentHash: HASH,
      amountSats: 10000,
      createdAt: NOW,
      expiry: 600,
    },
    "/jit/invoice": {
      bolt11: INVOICE,
      paymentHash: HASH,
      amountSats: 10000,
      createdAt: NOW,
      expiry: 600,
      flatFeeSat: 10,
      feePpm: 101,
    },
    "/direct-funding/request": {
      request: encodeFundingEnvelope({
        nodeId: PK,
        expiresAt: NOW + 600000,
        amountSats: 10000,
      }),
      expiresAt: NOW + 600000,
    },
    "/mnemonic": { mnemonic: new Array(12).fill("fixture-word").join(" ") },
  };
  const client = new WalletClient(
    { url: "http://127.0.0.1:8787", token: "test-token", walletId: record.id },
    {
      now: () => now,
      fetch: async (url, options) => {
        const path = new URL(url).pathname.replace(
          /^\/wallets\/[^/]+\/api/,
          "",
        );
        const query = new URL(url).search;
        const body = options.body ? JSON.parse(options.body) : undefined;
        calls.push({ path, query, ...options, body });
        const handler =
          overrides[`${options.method} ${path}`] ??
          overrides[path] ??
          defaults[`${options.method} ${path}`] ??
          defaults[path];
        if (handler === undefined)
          throw new Error("Unhandled fixture route: " + path);
        const value =
          typeof handler === "function"
            ? await handler(body, query, calls)
            : handler;
        if (value instanceof Error) throw value;
        return value?.response
          ? value.response
          : result({ ok: true, result: value });
      },
    },
  );
  return {
    client,
    calls,
    storedRequests,
    setNow: (value) => {
      now = value;
    },
  };
}

function embeddedFixture(overrides = {}) {
  const backing = fixture(overrides);
  const client = new EmbeddedWalletClient({
    walletId: record.id,
    runtime: {
      async request(command) {
        const response = await backing.client._fetch(
          "http://fixture" + command.path,
          {
            method: command.method,
            ...(command.body === undefined
              ? {}
              : { body: JSON.stringify(command.body) }),
          },
        );
        const envelope = await response.json();
        if (!envelope.ok)
          throw Object.assign(
            new Error(envelope.error.message),
            envelope.error,
            { status: response.status },
          );
        return envelope.result;
      },
    },
  });
  client._now = backing.client._now;
  return { client, calls: backing.calls, setNow: backing.setNow };
}

test("whole-satoshi parsing never rounds or accepts exponent notation", () => {
  assert.equal(parseSats("2100000000000000"), 2100000000000000);
  for (const value of [
    "",
    "1.1",
    "1e4",
    "0x10",
    "-1",
    "1,000",
    NaN,
    Infinity,
    null,
    2100000000000001,
  ])
    assert.throws(() => parseSats(value));
  assert.deepEqual(btcStringToSats("4.35"), { ok: true, sats: 435000000 });
  assert.equal(btcStringToSats("0.000000001").ok, false);
});

test("routing rejects wrong networks, bidi controls, duplicate conflicting amounts and fractional-sat invoices", () => {
  assert.equal(parsePayment(ADDRESS, { network: "regtest" }).kind, "invalid");
  assert.equal(parsePayment("\u202e" + ADDRESS).kind, "invalid");
  assert.equal(
    parsePayment(`bitcoin:${ADDRESS}?amount=0.0001&amount=0.0002`).kind,
    "invalid",
  );
  const fractional = bech32Encode("lnbc10p", new Array(111).fill(0));
  assert.equal(parsePayment(fractional).code, "FRACTIONAL_SAT_INVOICE");
});

test("connection credentials never ride URL and nonlocal cleartext is refused", () => {
  for (const url of [
    "http://192.168.1.2:8787",
    "https://a:secret@example.test",
    "https://example.test?token=secret",
    "https://example.test/api",
    "ftp://localhost",
  ])
    assert.throws(() => normalizeConnection({ url, token: "secret" }));
  assert.equal(
    normalizeConnection({ url: "http://10.0.2.2:8787", token: "secret" }).url,
    "http://10.0.2.2:8787",
  );
  assert.throws(() =>
    normalizeConnection({ url: "https://example.test", token: "abc\nxyz" }),
  );
});

test("snapshot merges paid invoices once and does not leak preimages or metadata secrets", async () => {
  const { client } = fixture({
    "/payments": [
      {
        paymentHash: HASH,
        direction: "INCOMING",
        status: "COMPLETED",
        amountSats: 10000,
        preimage: "TOP-SECRET",
        metadata: { secret: "TOP-SECRET" },
        createdAt: NOW,
      },
    ],
    "/invoices": [
      {
        paymentHash: HASH,
        status: "PAID",
        amountSats: 10000,
        description: "Lunch",
        paymentSecret: "TOP-SECRET",
        createdAt: NOW,
      },
    ],
  });
  const snapshot = await client.snapshot();
  assert.equal(snapshot.activity.length, 1);
  assert.equal(snapshot.activity[0].description, "Lunch");
  assert.equal(snapshot.balance.totalSats, 202500);
  assert.equal(snapshot.balance.pendingSats, 2500);
  assert.ok(!JSON.stringify(snapshot).includes("TOP-SECRET"));
});

test("embedded receive recognizes settlement when snapshot reads straddle a paid invoice", async () => {
  const { client } = embeddedFixture({
    "/payments": [
      {
        paymentHash: HASH,
        direction: "INCOMING",
        status: "PENDING",
        amountSats: 9988,
        feeSats: 12,
        createdAt: NOW,
      },
    ],
    "/invoices": [
      {
        paymentHash: HASH,
        status: "PAID",
        amountSats: 10000,
        description: "Lunch",
        createdAt: NOW / 1000,
        expiry: 600,
      },
    ],
  });
  const request = await client.receive(
    await client.quoteReceive({ amountSats: 10000, description: "Lunch" }),
  );
  const snapshot = await client.snapshot();
  const received = snapshot.activity.find(
    (item) =>
      item.paymentHash === request.paymentHash &&
      item.kind === "received" &&
      item.status === "completed",
  );
  assert.ok(received, "the receive screen can match the paid request");
  assert.equal(snapshot.activity.length, 1);
  assert.equal(received.amountSats, 9988);
  assert.equal(received.feeSats, 12);
  assert.equal(received.feeKnown, true);
  assert.equal(received.description, "Lunch");
});

test("invoice merging distinguishes unfulfilled requests without downgrading receipts or promoting outgoing payments", () => {
  for (const [direction, paymentStatus, invoiceStatus, expected, kind] of [
    ["INCOMING", "PENDING", "PENDING", "pending", "request"],
    ["INCOMING", "PENDING", "EXPIRED", "expired", "request"],
    ["INCOMING", "PENDING", "FAILED", "failed", "request"],
    ["INCOMING", "PENDING", "CANCELLED", "failed", "request"],
    ["INCOMING", "FAILED", "PENDING", "pending", "request"],
    ["INCOMING", "COMPLETED", "PENDING", "completed", "received"],
    ["INCOMING", "COMPLETED", "EXPIRED", "completed", "received"],
    ["OUTGOING", "PENDING", "PAID", "pending", "sent"],
    ["OUTGOING", "COMPLETED", "EXPIRED", "completed", "sent"],
  ]) {
    const rows = mergeActivity(
      {
        payments: [
          {
            paymentHash: HASH,
            direction,
            status: paymentStatus,
            amountSats: 10000,
            createdAt: NOW,
          },
        ],
        invoices: [
          {
            paymentHash: HASH,
            status: invoiceStatus,
            amountSats: 10000,
            createdAt: NOW / 1000,
            expiry: 600,
          },
        ],
      },
      NOW,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, expected);
    assert.equal(rows[0].kind, kind);
    if (kind === "request") assert.equal(rows[0].title, "Payment request");
  }
});

test("embedded unpaid invoice stays a request with its issued amount and expires without claiming receipt", async () => {
  const { client, setNow } = embeddedFixture({
    "/payments": [
      {
        paymentHash: HASH,
        direction: "INCOMING",
        status: "PENDING",
        amountSats: 9988,
        feeSats: 12,
        createdAt: NOW,
      },
    ],
    "/invoices": [
      {
        paymentHash: HASH,
        status: "PENDING",
        amountSats: 10000,
        description: "Lunch",
        createdAt: NOW / 1000,
        expiry: 600,
      },
    ],
  });
  const request = await client.receive(
    await client.quoteReceive({ amountSats: 10000, description: "Lunch" }),
  );
  for (const [time, status] of [
    [NOW, "pending"],
    [NOW + 600000, "expired"],
  ]) {
    setNow(time);
    const snapshot = await client.snapshot();
    assert.equal(snapshot.activity.length, 1);
    const activity = snapshot.activity[0];
    assert.equal(activity.paymentHash, request.paymentHash);
    assert.equal(activity.kind, "request");
    assert.equal(activity.title, "Payment request");
    assert.equal(activity.status, status);
    assert.equal(activity.amountSats, 10000);
    assert.equal(activity.feeKnown, false);
    assert.equal(activity.description, "Lunch");
  }
});

test("a pending incoming payment without an issued invoice remains an incoming payment", () => {
  const rows = mergeActivity({
    payments: [
      {
        paymentHash: HASH,
        direction: "INCOMING",
        status: "PENDING",
        amountSats: 10000,
        createdAt: NOW,
      },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "received");
  assert.equal(rows[0].status, "pending");
  assert.equal(rows[0].amountSats, 10000);
});

test("missing reads do not silently become zero balances or empty history", async () => {
  const { client } = fixture({ "/payments": new Error("disconnected") });
  await assert.rejects(client.snapshot(), { code: "NETWORK_ERROR" });
});

test("primary setup errors survive public records and snapshots as safe actionable diagnostics", async () => {
  const cases = [
    [
      "Failed to connect to 02abc@mint.local:9103: Primary node refused connection at mint.local:9103. Check that it is running and listening on this port.",
      "The primary node refused the connection.",
    ],
    [
      "Failed to connect to 02abc@mint.local:9103: Primary node hostname could not be resolved: mint.local. Check the address and local network.",
      "The primary node's address could not be resolved.",
    ],
    [
      "Failed to connect to 02abc@mint.local:9103: Primary node connection timed out at mint.local:9103. Check the address, port, and network.",
      "The primary node connection timed out.",
    ],
    [
      "Electrum server TLS certificate could not be verified at server.example:9999. Check the server and certificate.",
      "The Bitcoin server's secure connection could not be verified.",
    ],
    [
      "Failed to connect to 02abc@mint.local:9103: Primary node is unreachable at mint.local:9103. Check the network connection.",
      "The primary node is unreachable.",
    ],
    [
      "Failed to connect to 02abc@mint.local:9103: Primary node connection is unavailable at mint.local:9103. Check the address, port, and network.",
      "Primary setup could not complete.",
    ],
    [
      "Bitcoin network mismatch: wrong genesis",
      "The Bitcoin server is on a different network.",
    ],
    [
      "SOCKS proxy connection failed",
      "The private network connection is unavailable.",
    ],
    [
      "Authentication failed: token=TOP-SECRET",
      "The connection could not be authenticated.",
    ],
    [
      "Peer did not negotiate option_zeroconf",
      "The primary node does not support a required wallet feature.",
    ],
  ];
  for (const [setupError, expected] of cases) {
    const failed = {
      ...record,
      lfbw: { ...record.lfbw, setup: "failed", setupError },
    };
    const { client } = fixture({
      "/api/wallets": [failed],
      "/api/wallets/wallet-1": failed,
    });
    const listed = (await client.listWallets())[0];
    const snapshot = await client.snapshot();
    assert.ok(listed.lfbw.setupError.startsWith(expected));
    assert.equal(snapshot.primary.setupError, listed.lfbw.setupError);
    assert.equal(snapshot.wallet.lfbw.setupError, listed.lfbw.setupError);
    assert.ok(!JSON.stringify(snapshot).includes("TOP-SECRET"));
  }
});

test("setup diagnostics never reflect arbitrary payloads and remain available when daemon reads fail", async () => {
  const setupError =
    "Unexpected result: mnemonic=TOP-SECRET password=TOP-SECRET https://user:TOP-SECRET@relay.example/?token=TOP-SECRET\n at private/file.ts:12";
  const failed = {
    ...record,
    lfbw: { ...record.lfbw, setup: "failed", setupError },
  };
  const { client } = fixture({
    "/api/wallets": [failed],
    "/api/wallets/wallet-1": failed,
    "/balance": new Error("daemon stopped"),
  });
  const listed = await client.listWallets();
  assert.match(listed[0].lfbw.setupError, /Check.*retry setup/);
  assert.ok(!JSON.stringify(listed).includes("TOP-SECRET"));
  assert.ok(!JSON.stringify(listed).includes("private/file"));
  await assert.rejects(client.snapshot(), { code: "NETWORK_ERROR" });
  for (const absent of [
    undefined,
    null,
    "",
    "   ",
    { message: "TOP-SECRET" },
  ]) {
    const withoutError = {
      ...record,
      lfbw: { ...record.lfbw, setupError: absent },
    };
    const next = fixture({ "/api/wallets/wallet-1": withoutError }).client;
    const snapshot = await next.snapshot();
    assert.equal(Object.hasOwn(snapshot.primary, "setupError"), false);
    assert.equal(Object.hasOwn(snapshot.wallet.lfbw, "setupError"), false);
  }
});

test("prepare/send picks BIP21 Lightning, caps fee, is single use and no signature secrets escape", async () => {
  const { client, calls } = fixture();
  const review = await client.prepareSend({
    request: `bitcoin:${ADDRESS}?amount=0.0001&lightning=${INVOICE}`,
  });
  assert.equal(review.route, "lightning");
  assert.equal(review.amountSats, 10000);
  // The fixture estimates 7 sats; the review and the cap allow 10 more.
  assert.equal(review.estimatedFeeSats, 7);
  assert.equal(review.feeSats, 17);
  assert.equal(review.totalSats, 10017);
  assert.equal(calls.filter((c) => c.path === "/invoice/pay-safe").length, 0);
  const sent = await client.send(review);
  assert.equal(sent.status, "completed");
  assert.equal(sent.feeSats, 5);
  assert.ok(!JSON.stringify(sent).includes("secret-never-exposed"));
  const payment = calls.find((c) => c.path === "/invoice/pay-safe");
  assert.deepEqual(payment.body, { bolt11: INVOICE, maxFeeSats: 17 });
  assert.equal(payment.headers.Authorization, "Bearer test-token");
  assert.equal(payment.redirect, "error");
  await assert.rejects(client.send(review), { code: "INVALID_REVIEW" });
  await assert.rejects(client.prepareSend({ request: INVOICE }), {
    code: "ALREADY_SUBMITTED",
  });
});

test("amount conflicts and expired invoices never dispatch", async () => {
  const { client, calls } = fixture({
    "/invoice/decode": {
      paymentHash: HASH,
      amountSats: 10000,
      timestamp: NOW / 1000 - 3601,
      expiry: 3600,
    },
  });
  await assert.rejects(
    client.prepareSend({ request: INVOICE, amountSats: 9999 }),
    { code: "AMOUNT_CONFLICT" },
  );
  await assert.rejects(client.prepareSend({ request: INVOICE }), {
    code: "INVOICE_EXPIRED",
  });
  assert.equal(
    calls.some((c) => c.path === "/invoice/pay-safe"),
    false,
  );
});

test("mutation or expiry of review refuses payment, and default BOLT11 expiry is 3600 seconds", async () => {
  const { client, setNow } = fixture({
    "/invoice/decode": {
      paymentHash: HASH,
      amountSats: 10000,
      timestamp: NOW / 1000 - 10,
    },
  });
  const review = await client.prepareSend({ request: INVOICE });
  await assert.rejects(client.send({ ...review, amountSats: 1 }), {
    code: "REVIEW_CHANGED",
  });
  setNow(NOW + 60001);
  await assert.rejects(client.send(review), { code: "QUOTE_EXPIRED" });
});

test("address payments quote and submit one splice-out; settlement remains pending", async () => {
  const { client, calls } = fixture();
  const review = await client.prepareSend({
    request: ADDRESS,
    amountSats: 10000,
  });
  assert.equal(review.route, "bitcoin");
  assert.equal(review.feeSats, 225);
  assert.deepEqual(calls.find((c) => c.path === "/channel/splice-quote").body, {
    channelId: "channel-1",
    direction: "out",
    feeratePerkw: 500,
  });
  const sent = await client.send(review);
  assert.equal(sent.status, "pending");
  assert.deepEqual(calls.find((c) => c.path === "/channel/splice-out").body, {
    channelId: "channel-1",
    amountSats: 10000,
    feeratePerkw: 500,
    address: ADDRESS,
    requestId: review.id,
    quotedFeeSats: 225,
    description: "",
  });
});

test("a lost payment response is uncertain, recorded locally, never retried or paid on another route", async () => {
  const { client, calls } = fixture({
    "/invoice/pay-safe": new Error("connection lost"),
  });
  const review = await client.prepareSend({
    request: `bitcoin:${ADDRESS}?lightning=${INVOICE}`,
  });
  const sent = await client.send(review);
  assert.equal(sent.status, "uncertain");
  assert.equal((await client.snapshot()).activity[0].status, "uncertain");
  await assert.rejects(client.send(review));
  assert.equal(calls.filter((c) => c.path === "/invoice/pay-safe").length, 1);
  assert.equal(
    calls.filter((c) => c.path === "/channel/splice-out" || c.path === "/send")
      .length,
    0,
  );
});

test("a daemon pending result stays pending and duplicate submit stays locked", async () => {
  const { client } = fixture({
    "/invoice/pay-safe": { status: "PENDING", paymentHash: HASH },
  });
  const review = await client.prepareSend({ request: INVOICE });
  assert.equal((await client.send(review)).status, "pending");
  await assert.rejects(client.prepareSend({ request: INVOICE }), {
    code: "ALREADY_SUBMITTED",
  });
});

test("receive reuses inbound capacity and returns unified URI with signed funding envelope", async () => {
  const { client, calls } = fixture();
  const quote = await client.quoteReceive({
    amountSats: 10000,
    description: "Lunch",
  });
  assert.equal(quote.feeSats, 0);
  assert.ok(!calls.some((c) => c.path === "/invoice/create"));
  const request = await client.receive(quote);
  const parsed = parsePayment(request.uri, { network: "mainnet", now: NOW });
  assert.equal(parsed.kind, "onchain");
  assert.equal(parsed.lightning.invoice, INVOICE);
  assert.equal(parsed.funding.amountSats, 10000);
  assert.equal(parsed.message, "Lunch");
  assert.equal(request.expiresAt, NOW + 600000);
  await assert.rejects(client.receive(quote), { code: "INVALID_REVIEW" });
});

test("receive without inbound requires online primary and quoted fee policy is capped with exact ceil rounding", async () => {
  const { client, calls } = fixture({
    "/channels": [],
    "/jit/quote": {
      accepted: true,
      withinCeilings: true,
      flatFeeSat: 10,
      feePpm: 101,
      feeSats: 12,
    },
  });
  await assert.rejects(client.quoteReceive({}), { code: "AMOUNT_REQUIRED" });
  const quote = await client.quoteReceive({ amountSats: 10000 });
  assert.equal(quote.netSats, 9988);
  const request = await client.receive(quote);
  assert.equal(request.feeSats, 12);
  const body = calls.find((c) => c.path === "/jit/invoice").body;
  assert.equal(body.maxFlatFeeSat, 10);
  assert.equal(body.maxFeePpm, 101);
  assert.equal(body.expirySecs, 600);
  const offline = fixture({ "/channels": [], "/peers": [] });
  await assert.rejects(offline.client.quoteReceive({ amountSats: 10000 }), {
    code: "PRIMARY_DOWN",
  });
});

test("embedded JIT quote timeout explains the provider check without creating an invoice or address", async () => {
  const { client, calls } = embeddedFixture({
    "/channels": [],
    "/jit/quote": Object.assign(new Error("internal quote timeout detail"), {
      code: "JIT_TIMEOUT",
      status: 504,
    }),
  });
  await assert.rejects(client.quoteReceive({ amountSats: 10000 }), (error) => {
    assert.equal(error.code, "JIT_TIMEOUT");
    assert.equal(error.status, 504);
    assert.match(error.message, /was connected but did not answer/);
    assert.match(
      error.message,
      /If you run.*check that Liquidity provider is enabled/,
    );
    assert.doesNotMatch(error.message, /internal quote timeout detail/);
    return true;
  });
  assert.ok(calls.every((call) => call.method === "GET"));
  assert.equal(calls.filter((call) => call.path === "/jit/quote").length, 1);
  assert.equal(client._receiveQuotes.size, 0);
});

test("JIT authorization timeout has stage-specific guidance and never replaces another refusal or uncertain result", async () => {
  for (const code of ["JIT_TIMEOUT", "JIT_REFUSED", "RESULT_UNCERTAIN"]) {
    const original = "Original authorization result";
    const { client, calls } = embeddedFixture({
      "/channels": [],
      "/jit/quote": {
        accepted: true,
        withinCeilings: true,
        flatFeeSat: 10,
        feePpm: 101,
        feeSats: 12,
      },
      "/jit/invoice": Object.assign(new Error(original), { code, status: 503 }),
    });
    const quote = await client.quoteReceive({ amountSats: 10000 });
    await assert.rejects(client.receive(quote), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.status, 503);
      if (code === "JIT_TIMEOUT") {
        assert.match(error.message, /no invoice was created/);
        assert.match(error.message, /Review the amount and try again/);
      } else assert.equal(error.message, original);
      return true;
    });
    assert.equal(
      calls.filter((call) => call.path === "/address/new").length,
      1,
    );
    assert.equal(
      calls.filter((call) => call.path === "/jit/invoice").length,
      1,
    );
    assert.ok(
      !calls.some((call) =>
        [
          "/invoice/create",
          "/direct-funding/request",
          "/invoice/decode",
        ].includes(call.path),
      ),
    );
    const authorization = calls.find(
      (call) => call.path === "/jit/invoice",
    ).body;
    assert.equal(authorization.maxFlatFeeSat, 10);
    assert.equal(authorization.maxFeePpm, 101);
    await assert.rejects(client.receive(quote), { code: "INVALID_REVIEW" });
  }
  const declined = embeddedFixture({
    "/channels": [],
    "/jit/quote": {
      accepted: false,
      withinCeilings: true,
      reason: "Provider funding limit reached",
    },
  });
  await assert.rejects(declined.client.quoteReceive({ amountSats: 10000 }), {
    code: "RECEIVE_UNAVAILABLE",
    message: "Provider funding limit reached",
  });
  assert.ok(declined.calls.every((call) => call.method === "GET"));
});

test("only host JIT quote reads outlast the engine's 15-second reply window", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { client } = fixture({ "/channels": [] });
  const fetch = client._fetch;
  let quoteSignal, configSignal;
  client._fetch = (url, options) => {
    const path = new URL(url).pathname;
    if (!path.endsWith("/jit/quote") && path !== "/api/config")
      return fetch(url, options);
    return new Promise((resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => reject(new Error("aborted")),
        { once: true },
      );
      if (path.endsWith("/jit/quote")) {
        quoteSignal = options.signal;
        // The engine's timeout plus a little host response latency.
        setTimeout(
          () =>
            resolve(
              result(
                {
                  ok: false,
                  error: {
                    code: "JIT_TIMEOUT",
                    message: "timed out waiting for the LSP JIT quote",
                  },
                },
                504,
              ),
            ),
          16000,
        );
      } else configSignal = options.signal;
    });
  };
  const quote = assert.rejects(client.quoteReceive({ amountSats: 10000 }), {
    code: "JIT_TIMEOUT",
    status: 504,
  });
  for (let i = 0; !quoteSignal && i < 30; i++) await Promise.resolve();
  assert.ok(quoteSignal);
  t.mock.timers.tick(15000);
  assert.equal(quoteSignal.aborted, false);
  t.mock.timers.tick(1000);
  await quote;
  assert.equal(quoteSignal.aborted, false);
  const config = assert.rejects(client.getConfig(), { code: "NETWORK_ERROR" });
  assert.ok(configSignal);
  t.mock.timers.tick(14999);
  assert.equal(configSignal.aborted, false);
  t.mock.timers.tick(1);
  await config;
  assert.equal(configSignal.aborted, true);
});

test("optional direct-funding absence remains visible while returning valid unified ordinary request", async () => {
  const { client } = fixture({
    "/direct-funding/request": {
      response: result({ ok: false, error: { code: "NOT_FOUND" } }, 404),
    },
  });
  const request = await client.receive(
    await client.quoteReceive({ amountSats: 10000 }),
  );
  assert.ok(!request.uri.includes("bgnq="));
  assert.ok(request.uri.includes("lightning="));
  assert.ok(request.warnings.length > 0);
});

test("create matches manager wrapper, enables peer backups and exposes phrase only in creation response", async () => {
  const phrase = new Array(12).fill("fixture-only").join(" ");
  const { client, calls } = fixture({
    "POST /api/wallets": { record, mnemonic: phrase },
    "PATCH /api/wallets/wallet-1": record,
  });
  const created = await client.createWallet({
    name: "New",
    network: "mainnet",
    electrum: { host: "electrum.local", port: 50002, tls: true },
  });
  assert.equal(created.id, record.id);
  assert.equal(created.mnemonic, phrase);
  const body = calls.find(
    (c) => c.path === "/api/wallets" && c.method === "POST",
  ).body;
  assert.equal(body.lfbw.primaryUri, DEFAULT_PRIMARY_URI);
  assert.equal(body.recoveryMode, "peer-storage");
  assert.equal(body.tor, true);
  assert.equal(body.electrum.host, "electrum.local");
  assert.ok(!JSON.stringify(await client.snapshot()).includes(phrase));
  await client.updatePrimary(DEFAULT_PRIMARY_URI);
  assert.equal(
    calls.find((c) => c.method === "PATCH").body.lfbw.primaryUri,
    DEFAULT_PRIMARY_URI,
  );
  assert.equal((await client.getRecoveryPhrase()).split(" ").length, 12);
});

test("committed wallet creation preserves its backup and bounded nonempty warning notices", async () => {
  const phrase = new Array(12).fill("fixture-only").join(" ");
  const warning = "Wallet saved. Reopen it before adding another network.";
  const { client } = fixture({
    "POST /api/wallets": {
      record,
      mnemonic: phrase,
      warnings: [
        `  ${warning}  `,
        "",
        "  ",
        null,
        { message: "Not a string" },
        1,
        "x".repeat(600),
        "Notice three",
        "Notice four",
        "Notice five",
        "Notice six",
      ],
    },
  });
  const created = await client.createWallet();
  assert.equal(created.id, record.id);
  assert.equal(created.mnemonic, phrase);
  assert.deepEqual(created.warnings, [
    warning,
    "x".repeat(512),
    "Notice three",
    "Notice four",
    "Notice five",
  ]);
  assert.equal(client.connection.walletId, record.id);
  assert.ok(!JSON.stringify(await client.snapshot()).includes(warning));
  for (const warnings of [undefined, null, [], "Not an array", [null, " "]]) {
    const next = fixture({
      "POST /api/wallets": { record, mnemonic: phrase, warnings },
    }).client;
    const result = await next.createWallet();
    assert.equal(result.mnemonic, phrase);
    assert.equal(Object.hasOwn(result, "warnings"), false);
  }
});

test("selection changes discard fee reviews", async () => {
  const { client } = fixture();
  const review = await client.prepareSend({ request: INVOICE });
  client.selectWallet("wallet-2");
  await assert.rejects(client.send(review), { code: "INVALID_REVIEW" });
});

test("funding base64 does not require browser globals and rejects noncanonical bits", () => {
  for (const bytes of [[], [1], [1, 2], [1, 2, 3], [255, 254, 253, 252]]) {
    const a = Uint8Array.from(bytes);
    const encoded = base64urlEncode(a);
    if (encoded) assert.deepEqual(base64urlDecode(encoded), a);
  }
  assert.equal(base64urlDecode("AR"), null);
  assert.equal(base64urlDecode("a"), null);
  assert.equal(base64urlDecode("AA="), null);
});

test("preview is isolated per instance and QR cannot receive real funds", async () => {
  const a = new DemoWalletClient();
  const b = new DemoWalletClient();
  const before = (await b.snapshot()).balance.availableSats;
  const review = await a.prepareSend({ request: "demo:coffee" });
  await a.send(review);
  assert.equal((await b.snapshot()).balance.availableSats, before);
  assert.equal(
    (await a.snapshot()).balance.availableSats,
    before - review.totalSats,
  );
  const request = await a.receive(await a.quoteReceive({ amountSats: 1000 }));
  assert.equal(parsePayment(request.uri).kind, "invalid");
  assert.equal(request.demo, true);
});

test("activity expiry and transaction direction preserve semantics and stable identifiers", () => {
  const rows = mergeActivity(
    {
      invoices: [
        {
          paymentHash: HASH,
          amountSats: 10,
          createdAt: NOW - 100000,
          expiry: 30,
          status: "PENDING",
        },
      ],
      transactions: [
        {
          txid: "tx",
          type: "sent",
          valueSats: -200,
          feeSats: 5,
          confirmed: false,
          timestamp: NOW / 1000,
        },
      ],
    },
    NOW,
  );
  assert.equal(rows[0].kind, "sent");
  assert.equal(rows[0].timestamp, NOW);
  assert.equal(rows[1].status, "expired");
});

test("canonical balances count disconnected, restore-held and parked-splice funds once, preserving recovery buckets", async () => {
  const { client } = fixture({
    "/balance": { onchain: 2000, lightning: 30000, splicingSats: 4000 },
    "/info": { pendingCloseBalanceSats: 5000, erroredBalanceSats: 6000 },
    "/liquidity": { sendableSats: 0 },
    "/channels": [
      {
        ...channel,
        state: "NORMAL",
        htlcUsable: false,
        restoreRecencyUnproven: true,
        localBalanceSats: 10000,
      },
      {
        ...channel,
        channelId: "disconnected",
        state: "AWAITING_REESTABLISH",
        htlcUsable: false,
        localBalanceSats: 20000,
      },
      {
        ...channel,
        channelId: "parked",
        state: "SPLICING",
        htlcUsable: false,
        localBalanceSats: 4000,
      },
      {
        ...channel,
        channelId: "opening",
        state: "AWAITING_FUNDING_CONFIRMED",
        htlcUsable: false,
        localBalanceSats: 3000,
        fundingTxid: "observed",
      },
      {
        ...channel,
        channelId: "unbroadcast",
        state: "SENT_FUNDING_CREATED",
        htlcUsable: false,
        localBalanceSats: 2000,
        fundingTxid: "not-observed",
      },
    ],
    "/transactions": [
      {
        txid: "observed",
        type: "sent",
        valueSats: -3000,
        feeSats: 1,
        confirmed: false,
        timestamp: NOW,
      },
    ],
  });
  const snapshot = await client.snapshot();
  assert.equal(snapshot.balance.totalSats, 50000);
  assert.equal(snapshot.balance.availableSats, 0);
  assert.equal(snapshot.balance.pendingSats, 20000);
  assert.ok(snapshot.notes.some((note) => note.includes("recovery attention")));
  assert.ok(
    snapshot.notes.every(
      (note) => !/Lightning|on-chain|channel|splice/.test(note),
    ),
  );
});

test("two prepared reviews cannot submit the same invoice twice", async () => {
  const { client, calls } = fixture();
  const first = await client.prepareSend({ request: INVOICE });
  const second = await client.prepareSend({ request: INVOICE });
  await client.send(first);
  await assert.rejects(client.send(second), { code: "ALREADY_SUBMITTED" });
  assert.equal(calls.filter((c) => c.path === "/invoice/pay-safe").length, 1);
});

test("wallet identifiers cannot escape their route", () => {
  for (const id of ["..", "../other", ".", "wallet?token=abc", ""])
    assert.throws(
      () =>
        new WalletClient({
          url: "http://localhost:8787",
          token: "test-token",
          walletId: id,
        }),
      { code: "INVALID_WALLET" },
    );
});

test("ambiguous proxy timeout never reports a failed payment", async () => {
  const { client } = fixture({
    "/invoice/pay-safe": {
      response: result(
        { ok: false, error: { code: "TIMEOUT", message: "Proxy timeout" } },
        408,
      ),
    },
  });
  assert.equal(
    (await client.send(await client.prepareSend({ request: INVOICE }))).status,
    "uncertain",
  );
});

test("automatic funding is displayed as an internal transfer while explicit sends stay sent", () => {
  const input = {
    channels: [{ fundingTxid: "funding" }],
    transactions: [
      {
        txid: "funding",
        type: "sent",
        valueSats: -50000,
        feeSats: 150,
        confirmed: true,
        timestamp: NOW,
      },
    ],
  };
  assert.equal(mergeActivity(input)[0].kind, "transfer");
  assert.equal(
    mergeActivity({ ...input, sentTxids: ["funding"] })[0].kind,
    "sent",
  );
});

test("durable host submissions survive reconnect and replace local tracking without duplicates", async () => {
  let submissions = [];
  const overrides = {
    "/api/wallets/wallet-1/activity": () => submissions,
    "/channel/splice-out": (body) => {
      submissions = [
        {
          id: `submission:${body.requestId}`,
          kind: "sent",
          title: "Bitcoin payment",
          description: body.description,
          amountSats: body.amountSats,
          feeSats: body.quotedFeeSats,
          status: "pending",
          timestamp: NOW,
          reference: body.requestId,
          address: body.address,
          hiddenSecret: "NEVER-EXPOSE",
        },
      ];
      return { ok: true, requestId: body.requestId, status: "pending" };
    },
  };
  const first = fixture(overrides);
  const review = await first.client.prepareSend({
    request: ADDRESS,
    amountSats: 10000,
  });
  assert.equal((await first.client.send(review)).status, "pending");
  assert.equal((await first.client.snapshot()).activity.length, 1);
  const reconnected = fixture(overrides);
  const snapshot = await reconnected.client.snapshot();
  assert.equal(snapshot.activity.length, 1);
  assert.equal(snapshot.activity[0].id, `submission:${review.id}`);
  assert.equal(snapshot.activity[0].status, "pending");
  assert.ok(!JSON.stringify(snapshot).includes("NEVER-EXPOSE"));
  const txid = "34".repeat(32);
  submissions = [
    { ...submissions[0], status: "completed", reference: txid, txid },
  ];
  overrides["/transactions"] = [
    {
      txid,
      type: "sent",
      valueSats: -10000,
      feeSats: 225,
      confirmed: true,
      timestamp: NOW,
    },
  ];
  const settled = await first.client.snapshot();
  assert.equal(settled.activity.length, 1);
  assert.equal(settled.activity[0].status, "completed");
  assert.equal(settled.activity[0].txid, txid);
});

test("host uncertain splice response stays uncertain and durable record is visible on reconnect", async () => {
  let lastRequest;
  const overrides = {
    "/channel/splice-out": (body) => {
      lastRequest = body;
      return { ok: true, requestId: body.requestId, status: "uncertain" };
    },
    "/api/wallets/wallet-1/activity": () =>
      lastRequest
        ? [
            {
              id: `submission:${lastRequest.requestId}`,
              title: "Payment result unknown",
              amountSats: lastRequest.amountSats,
              feeSats: lastRequest.quotedFeeSats,
              status: "uncertain",
              timestamp: NOW,
              reference: lastRequest.requestId,
            },
          ]
        : [],
  };
  const first = fixture(overrides);
  assert.equal(
    (
      await first.client.send(
        await first.client.prepareSend({ request: ADDRESS, amountSats: 10000 }),
      )
    ).status,
    "uncertain",
  );
  assert.equal(
    (await fixture(overrides).client.snapshot()).activity[0].status,
    "uncertain",
  );
});

test("a missing durable journal read does not silently hide pending sends", async () => {
  const { client } = fixture({
    "/api/wallets/wallet-1/activity": new Error("disconnected"),
  });
  await assert.rejects(client.snapshot(), { code: "NETWORK_ERROR" });
});

test("starting and synchronizing are explicit actions, not mutations from snapshot", async () => {
  const { client, calls } = fixture();
  await client.snapshot();
  assert.ok(
    !calls.some(
      (call) => call.path.endsWith("/start") || call.path === "/wallet/refresh",
    ),
  );
  await client.startWallet();
  await client.refreshWallet();
  assert.equal(
    calls.find((call) => call.path.endsWith("/start")).method,
    "POST",
  );
  assert.equal(
    calls.find((call) => call.path === "/wallet/refresh").method,
    "POST",
  );
  assert.ok(calls.find((call) => call.path === "/wallet/refresh").signal);
  const demo = new DemoWalletClient();
  await demo.startWallet();
  await demo.refreshWallet();
});

test("late payment completion remains scoped to its original wallet after selection changes", async () => {
  let complete;
  const wait = new Promise((resolve) => {
    complete = resolve;
  });
  const { client } = fixture({
    "/invoice/pay-safe": () => wait,
    "/api/wallets/wallet-2": { ...record, id: "wallet-2" },
    "/api/wallets/wallet-2/activity": [],
  });
  const send = client.send(await client.prepareSend({ request: INVOICE }));
  client.selectWallet("wallet-2");
  complete({ status: "COMPLETED", paymentHash: HASH, feeSats: 4 });
  assert.equal((await send).status, "completed");
  assert.equal((await client.snapshot()).activity.length, 0);
  client.selectWallet("wallet-1");
  assert.equal((await client.snapshot()).activity[0].status, "completed");
});

test("unknown daemon fees are marked unavailable and quoted submission fees remain estimates", async () => {
  const rows = mergeActivity({
    payments: [
      {
        paymentHash: HASH,
        amountSats: 10000,
        status: "COMPLETED",
        direction: "INCOMING",
        createdAt: NOW,
      },
    ],
    invoices: [
      {
        paymentHash: "other",
        amountSats: 5000,
        status: "PAID",
        createdAt: NOW,
      },
    ],
  });
  assert.ok(rows.every((row) => row.feeKnown === false));
  const { client } = fixture({
    "/invoice/pay-safe": { status: "COMPLETED", paymentHash: HASH },
  });
  const result = await client.send(
    await client.prepareSend({ request: INVOICE }),
  );
  assert.equal(result.feeEstimated, true);
  assert.equal((await client.snapshot()).activity[0].feeEstimated, true);
  const journal = fixture({
    "/api/wallets/wallet-1/activity": [
      {
        id: "submission:old",
        amountSats: 100,
        feeSats: 0,
        feeKnown: false,
        feeEstimated: true,
        status: "pending",
        timestamp: NOW,
        reference: "old",
      },
    ],
  });
  const old = (await journal.client.snapshot()).activity[0];
  assert.equal(old.feeKnown, false);
  assert.equal(old.feeEstimated, true);
});

test("embedded mode dispatches directly to engine and never invokes host fetch", async () => {
  const { EmbeddedWalletClient } = await import("../src/index.js");
  const engineCalls = [];
  const fixtureClient = fixture();
  let closes = 0;
  const runtime = {
    async request(command) {
      engineCalls.push(command);
      const envelope = await fixtureClient.client._fetch(
        "http://fixture" + command.path,
        {
          method: command.method,
          ...(command.body === undefined
            ? {}
            : { body: JSON.stringify(command.body) }),
        },
      );
      const payload = await envelope.json();
      if (!payload.ok)
        throw Object.assign(new Error(payload.error.message), payload.error);
      return payload.result;
    },
    async close() {
      closes++;
    },
  };
  const client = new EmbeddedWalletClient({ runtime, walletId: "wallet-1" });
  client._now = () => NOW;
  client._fetch = () => {
    throw new Error("HTTP MUST NOT BE USED");
  };
  assert.equal(client.connection.url, "embedded:");
  assert.equal(client.connection.token, "");
  assert.equal(client.demo, false);
  const snapshot = await client.snapshot();
  assert.equal(snapshot.wallet.id, "wallet-1");
  const review = await client.prepareSend({ request: INVOICE });
  assert.equal((await client.send(review)).status, "completed");
  const payment = engineCalls.find((call) =>
    call.path.endsWith("/invoice/pay-safe"),
  );
  assert.equal(payment.body.maxFeeSats, review.feeSats);
  assert.ok(!engineCalls.some((call) => "headers" in call || "token" in call));
  await client.close();
  await client.close();
  assert.equal(closes, 1);
  await assert.rejects(client.snapshot(), { code: "ENGINE_CLOSED" });
});

test("embedded engine error preserves uncertain payment semantics and never falls back to host", async () => {
  const { EmbeddedWalletClient } = await import("../src/index.js");
  const backing = fixture();
  let submits = 0;
  const client = new EmbeddedWalletClient({
    walletId: "wallet-1",
    runtime: {
      async request(command) {
        if (command.path.endsWith("/invoice/pay-safe")) {
          submits++;
          throw new Error("Worker disconnected");
        }
        const response = await backing.client._fetch(
          "http://fixture" + command.path,
          {
            method: command.method,
            ...(command.body === undefined
              ? {}
              : { body: JSON.stringify(command.body) }),
          },
        );
        return (await response.json()).result;
      },
    },
  });
  client._now = () => NOW;
  const review = await client.prepareSend({ request: INVOICE });
  assert.equal((await client.send(review)).status, "uncertain");
  await assert.rejects(client.send(review), { code: "INVALID_REVIEW" });
  assert.equal(submits, 1);
});

test("embedded engine errors retain structured refusal codes across worker RPC", async () => {
  const { EmbeddedWalletClient } = await import("../src/index.js");
  const client = new EmbeddedWalletClient({
    runtime: {
      async request() {
        throw {
          message: "Wallet is locked",
          code: "WALLET_LOCKED",
          status: 423,
        };
      },
    },
  });
  await assert.rejects(client.listWallets(), {
    code: "WALLET_LOCKED",
    status: 423,
  });
  assert.throws(() => new EmbeddedWalletClient({ runtime: {} }), {
    code: "ENGINE_REQUIRED",
  });
});

test("failed embedded durable shutdown remains retryable without unlocking financial commands", async () => {
  const { EmbeddedWalletClient } = await import("../src/index.js");
  let attempts = 0;
  const client = new EmbeddedWalletClient({
    runtime: {
      request: () => [],
      close: async () => {
        attempts++;
        if (attempts === 1) throw new Error("Durable flush unavailable");
      },
    },
  });
  await assert.rejects(client.close(), /Durable flush unavailable/);
  await assert.rejects(client.listWallets(), { code: "ENGINE_CLOSED" });
  await client.close();
  await client.close();
  assert.equal(attempts, 2);
});

test("host and embedded tracking follow exact address receipts through partial, pending and confirmed payment", async () => {
  for (const makeClient of [fixture, embeddedFixture]) {
    const tx1 = "12".repeat(32);
    const tx2 = "34".repeat(32);
    let transactions = [];
    const { client, calls } = makeClient({
      "/receive/onchain": (_body, query) => {
        assert.equal(new URLSearchParams(query).get("address"), ADDRESS);
        return { address: ADDRESS, transactions };
      },
      // The wallet-net amount can include other addresses and fees. Tracking
      // must not use this tempting but unrelated value or its timestamp.
      "/transactions": [
        {
          txid: tx1,
          type: "received",
          address: ADDRESS,
          valueSats: 10000,
          confirmed: true,
          timestamp: NOW,
        },
      ],
    });
    const request = await client.receive(
      await client.quoteReceive({ amountSats: 10000 }),
    );
    const before = calls.length;
    assert.equal((await client.getReceiveStatus(request)).phase, "waiting");
    transactions = [
      { txid: tx1, amountSats: 6000, confirmed: false, height: 0 },
    ];
    let status = await client.getReceiveStatus(request);
    assert.equal(status.phase, "partial");
    assert.equal(status.receivedSats, 6000);
    assert.equal(status.confirmedSats, 0);
    transactions.push({
      txid: tx2,
      amountSats: 4000,
      confirmed: false,
      height: -1,
    });
    status = await client.getReceiveStatus(request);
    assert.equal(status.phase, "pending");
    assert.equal(status.receivedSats, 10000);
    assert.equal(status.pendingSats, 10000);
    assert.equal(status.method, "bitcoin");
    transactions[0] = { ...transactions[0], confirmed: true, height: 102 };
    status = await client.getReceiveStatus(request);
    assert.equal(status.phase, "pending");
    assert.equal(status.confirmedSats, 6000);
    assert.equal(status.pendingSats, 4000);
    transactions[1] = { ...transactions[1], confirmed: true, height: 103 };
    // Duplicate history rows are counted once, including repeated outputs
    // that the engine has already summed into the same transaction amount.
    transactions.push({ ...transactions[1] });
    status = await client.getReceiveStatus(request);
    assert.equal(status.phase, "completed");
    assert.equal(status.receivedSats, 10000);
    assert.equal(status.confirmedSats, 10000);
    assert.equal(status.pendingSats, 0);
    assert.deepEqual(status.txids, [tx1, tx2]);
    assert.equal(status.activityId, `transaction:${tx1}`);
    assert.ok(calls.slice(before).every((call) => call.method === "GET"));
    assert.ok(
      calls
        .slice(before)
        .every((call) =>
          [
            "/payments",
            "/invoices",
            "/receive/requests",
            "/receive/onchain",
          ].includes(call.path),
        ),
    );
  }
});

test("receive tracking requires exact paid Lightning proof and accepts its net amount after JIT fees", async () => {
  let payments = [
    {
      paymentHash: "ef".repeat(32),
      direction: "INCOMING",
      status: "COMPLETED",
      amountSats: 10000,
      createdAt: NOW,
    },
  ];
  let invoiceStatus = "PENDING";
  const { client } = embeddedFixture({
    "/payments": () => payments,
    "/invoices": () => [
      {
        paymentHash: HASH,
        status: invoiceStatus,
        amountSats: 10000,
        createdAt: NOW / 1000,
        expiry: 600,
      },
    ],
  });
  const request = await client.receive(
    await client.quoteReceive({ amountSats: 10000 }),
  );
  assert.equal(
    (await client.getReceiveStatus(request)).phase,
    "waiting",
    "same amount and time do not match another hash",
  );
  payments = [
    {
      paymentHash: HASH,
      direction: "INCOMING",
      status: "PENDING",
      amountSats: 9988,
      feeSats: 12,
      createdAt: NOW,
    },
  ];
  assert.equal(
    (await client.getReceiveStatus(request)).phase,
    "waiting",
    "a pending invoice is not a receipt",
  );
  invoiceStatus = "PAID";
  const paid = await client.getReceiveStatus(request);
  assert.equal(paid.phase, "completed");
  assert.equal(paid.method, "lightning");
  assert.equal(paid.receivedSats, 9988);
  assert.equal(paid.confirmedSats, 9988);
  assert.equal(paid.pendingSats, 0);
  assert.equal(paid.paymentHash, request.paymentHash);
  assert.deepEqual(paid.txids, []);
  payments[0] = { ...payments[0], direction: "OUTGOING", status: "COMPLETED" };
  assert.equal(
    (await client.getReceiveStatus(request)).phase,
    "waiting",
    "an outgoing payment is not receipt evidence",
  );
});

test("amountless address tracking waits for confirmation and observed replacement can remove pending funds", async () => {
  const txid = "56".repeat(32);
  let transactions = [{ txid, amountSats: 10000, confirmed: false }];
  const { client } = fixture({
    "/receive/onchain": () => ({ address: ADDRESS, transactions }),
  });
  const request = {
    address: ADDRESS,
    paymentHash: HASH,
    amountSats: null,
    demo: false,
  };
  assert.equal((await client.getReceiveStatus(request)).phase, "pending");
  transactions = [];
  assert.equal((await client.getReceiveStatus(request)).phase, "waiting");
  transactions = [{ txid, amountSats: 10000, confirmed: true }];
  assert.equal((await client.getReceiveStatus(request)).phase, "completed");
});

test("settled Lightning tracking returns without querying unavailable Bitcoin tracking", async () => {
  for (const makeClient of [fixture, embeddedFixture]) {
    const { client, calls } = makeClient({
      "/payments": [
        {
          paymentHash: HASH.toUpperCase(),
          direction: "INCOMING",
          status: "PENDING",
          amountSats: 9988,
          feeSats: 12,
          createdAt: NOW,
        },
      ],
      "/invoices": [
        {
          paymentHash: HASH,
          status: "PAID",
          amountSats: 10000,
          createdAt: NOW / 1000,
          expiry: 600,
        },
      ],
      "/receive/onchain": () => {
        throw new Error("Bitcoin server unavailable");
      },
    });
    const status = await client.getReceiveStatus({
      address: ADDRESS,
      paymentHash: HASH,
      amountSats: 10000,
      demo: false,
    });
    assert.equal(status.phase, "completed");
    assert.equal(status.method, "lightning");
    assert.equal(
      status.receivedSats,
      9988,
      "case-normalized hash retains actual receipt amount",
    );
    assert.ok(!calls.some((call) => call.path === "/receive/onchain"));
  }
});

test("missing, malformed or conflicting exact receipt data never becomes waiting or completed", async () => {
  const txid = "78".repeat(32);
  const request = {
    address: ADDRESS,
    paymentHash: HASH,
    amountSats: 10000,
    demo: false,
  };
  for (const response of [
    {},
    { address: "another-address", transactions: [] },
    {
      address: ADDRESS,
      transactions: [{ txid, amountSats: -1, confirmed: true }],
    },
    {
      address: ADDRESS,
      transactions: [{ txid, amountSats: 0.5, confirmed: true }],
    },
    {
      address: ADDRESS,
      transactions: [{ txid, amountSats: 10000, confirmed: "true" }],
    },
    {
      address: ADDRESS,
      transactions: [{ txid: "invalid", amountSats: 10000, confirmed: true }],
    },
    {
      address: ADDRESS,
      transactions: [
        { txid, amountSats: 10000, confirmed: true },
        { txid, amountSats: 10000, confirmed: false },
      ],
    },
    {
      address: ADDRESS,
      transactions: [
        { txid, amountSats: 10000, confirmed: true },
        { txid, amountSats: 20000, confirmed: true },
      ],
    },
  ]) {
    const { client } = fixture({ "/receive/onchain": response });
    await assert.rejects(client.getReceiveStatus(request), {
      code: "INVALID_RESPONSE",
    });
  }
  const { client } = fixture({ "/receive/onchain": new Error("disconnected") });
  await assert.rejects(client.getReceiveStatus(request), {
    code: "NETWORK_ERROR",
  });
});

test("receive tracking discards late results after wallet selection changes", async () => {
  let complete;
  let queried;
  const started = new Promise((resolve) => {
    queried = resolve;
  });
  const response = new Promise((resolve) => {
    complete = resolve;
  });
  const { client } = embeddedFixture({
    "/receive/onchain": () => {
      queried();
      return response;
    },
  });
  const request = {
    address: ADDRESS,
    paymentHash: HASH,
    amountSats: 10000,
    demo: false,
  };
  const pending = client.getReceiveStatus(request);
  await started;
  client.selectWallet("wallet-2");
  complete({
    address: ADDRESS,
    transactions: [
      { txid: "90".repeat(32), amountSats: 10000, confirmed: true },
    ],
  });
  await assert.rejects(pending, { code: "WALLET_CHANGED" });
});

test("preview receive tracking stays isolated and never accepts a real request", async () => {
  const client = new DemoWalletClient();
  const request = await client.receive(
    await client.quoteReceive({ amountSats: 10000 }),
  );
  assert.deepEqual(await client.getReceiveStatus(request), {
    phase: "waiting",
    receivedSats: 0,
    confirmedSats: 0,
    pendingSats: 0,
    txids: [],
  });
  await assert.rejects(
    client.getReceiveStatus({
      address: ADDRESS,
      paymentHash: HASH,
      demo: false,
    }),
    { code: "INVALID_REQUEST" },
  );
});

test("receive saves the original unified request before exposing it and a failed save does not create another invoice", async () => {
  let finish, started;
  const began = new Promise((resolve) => {
    started = resolve;
  });
  const saved = new Promise((resolve) => {
    finish = resolve;
  });
  let original;
  const { client, calls } = fixture({
    "POST /receive/requests": ({ request }) => {
      original = request;
      started();
      return saved;
    },
  });
  const quote = await client.quoteReceive({ amountSats: 10000 });
  let exposed = false;
  const pending = client.receive(quote).then((request) => {
    exposed = true;
    return request;
  });
  await began;
  assert.equal(exposed, false);
  assert.equal(original.paymentHash, HASH);
  assert.ok(original.uri.includes(ADDRESS));
  finish({ request: { ...original, createdAt: NOW } });
  assert.equal((await pending).uri, original.uri);
  assert.equal(
    calls.filter((call) => call.path === "/invoice/create").length,
    1,
  );
  const failure = fixture({
    "POST /receive/requests": new Error("disk unavailable"),
  });
  await assert.rejects(
    failure.client.receive(
      await failure.client.quoteReceive({ amountSats: 10000 }),
    ),
    { code: "REQUEST_SAVE_FAILED" },
  );
  assert.equal(
    failure.calls.filter((call) => call.path === "/invoice/create").length,
    1,
  );
});

test("saved unified requests survive client restart and reconcile exact Bitcoin partial, pending and completed activity without duplicates", async () => {
  const issued = fixture();
  const request = await issued.client.receive(
    await issued.client.quoteReceive({
      amountSats: 10000,
      description: "Lunch",
    }),
  );
  const txid = "11".repeat(32);
  let amountSats = 4000,
    confirmed = false,
    lookups = 0;
  const restored = embeddedFixture({
    "GET /receive/requests": { requests: issued.storedRequests },
    "/payments": [
      {
        paymentHash: HASH,
        direction: "INCOMING",
        status: "PENDING",
        amountSats: 10000,
        createdAt: NOW,
      },
    ],
    "/invoices": [
      {
        paymentHash: HASH,
        bolt11: INVOICE,
        status: "EXPIRED",
        amountSats: 10000,
        createdAt: NOW / 1000 - 1000,
        expiry: 600,
      },
    ],
    "/transactions": () => [
      {
        txid,
        type: "received",
        valueSats: amountSats,
        confirmed,
        timestamp: NOW,
      },
    ],
    "/receive/onchain": () => {
      lookups++;
      return {
        address: ADDRESS,
        transactions: [{ txid, amountSats, confirmed }],
      };
    },
  });
  for (const [amount, settled, phase, status] of [
    [4000, false, "partial", "pending"],
    [10000, false, "pending", "pending"],
    [10000, true, "completed", "completed"],
  ]) {
    amountSats = amount;
    confirmed = settled;
    // The foreground status watcher refreshes the same cache used by Activity.
    await restored.client.getReceiveStatus(request);
    const snapshot = await restored.client.snapshot();
    assert.equal(snapshot.activity.length, 1);
    const row = snapshot.activity[0];
    assert.equal(row.id, `payment:${HASH}`);
    assert.equal(row.kind, "received");
    assert.equal(row.status, status);
    assert.equal(row.amountSats, amount);
    assert.equal(row.receiveStatus.phase, phase);
    assert.equal(row.receiveRequest.uri, request.uri);
    assert.equal(row.receiveRequest.legacy, undefined);
    assert.equal(row.txid, txid);
  }
  const before = lookups;
  await restored.client.snapshot();
  assert.equal(
    lookups,
    before,
    "confirmed observations are cached during normal snapshots",
  );
  const cold = fixture({
    "GET /receive/requests": { requests: issued.storedRequests },
    "/receive/onchain": {
      address: ADDRESS,
      transactions: [{ txid, amountSats: 10000, confirmed: true }],
    },
  });
  assert.equal(
    (await cold.client.snapshot()).activity[0].status,
    "completed",
    "registered request still settles after invoice pruning and client restart",
  );
});

test("legacy invoices retain their exact Lightning QR without inventing an address or linking a same-amount Bitcoin payment", async () => {
  const { client } = fixture({
    "/invoices": [
      {
        paymentHash: HASH,
        bolt11: INVOICE,
        status: "PENDING",
        amountSats: 10000,
        createdAt: NOW / 1000,
        expiry: 600,
      },
    ],
    "/transactions": [
      {
        txid: "22".repeat(32),
        type: "received",
        valueSats: 10000,
        address: ADDRESS,
        confirmed: true,
        timestamp: NOW,
      },
    ],
  });
  const snapshot = await client.snapshot();
  assert.equal(snapshot.activity.length, 2);
  const invoice = snapshot.activity.find((row) => row.paymentHash === HASH);
  assert.equal(invoice.kind, "request");
  assert.equal(invoice.status, "pending");
  assert.equal(invoice.receiveRequest.uri, INVOICE);
  assert.equal(invoice.receiveRequest.legacy, true);
  assert.equal(invoice.receiveRequest.address, undefined);
});

test("linking an original URI checks the selected hash and wallet-issued invoice before persisting", async () => {
  const issued = fixture();
  const request = await issued.client.receive(
    await issued.client.quoteReceive({ amountSats: 10000 }),
  );
  const { client, calls } = fixture({
    "/invoices": [{ paymentHash: HASH, bolt11: INVOICE }],
    "/invoice/decode": {
      paymentHash: HASH,
      amountSats: 10000,
      timestamp: NOW / 1000 - 1000,
      expiry: 600,
    },
  });
  await assert.rejects(
    client.importReceiveRequest(request.uri, "33".repeat(32)),
    { code: "REQUEST_MISMATCH" },
  );
  assert.equal(
    calls.filter((call) => call.path === "/receive/requests").length,
    0,
  );
  const imported = await client.importReceiveRequest(request.uri, HASH);
  assert.equal(imported.uri, request.uri);
  assert.equal(imported.paymentHash, HASH);
  assert.ok(
    imported.expiresAt < NOW,
    "archived request linking does not require an unexpired invoice",
  );
  const other = fixture();
  await assert.rejects(other.client.importReceiveRequest(request.uri, HASH), {
    code: "REQUEST_NOT_OWNED",
  });
  assert.ok(!other.calls.some((call) => call.path === "/receive/requests"));
});

test("receipt lookup failures preserve balances and registered QR metadata without falsely completing requests", async () => {
  const issued = fixture();
  await issued.client.receive(
    await issued.client.quoteReceive({ amountSats: 10000 }),
  );
  const { client } = fixture({
    "GET /receive/requests": { requests: issued.storedRequests },
    "/receive/onchain": new Error("offline"),
  });
  const snapshot = await client.snapshot();
  assert.equal(snapshot.balance.totalSats, 202500);
  assert.equal(snapshot.activity[0].kind, "request");
  assert.equal(snapshot.activity[0].status, "pending");
  assert.equal(snapshot.activity[0].receiveStatusUnavailable, true);
  assert.equal(
    snapshot.activity[0].receiveRequest.uri,
    issued.storedRequests[0].uri,
  );
  assert.ok(
    snapshot.notes.some((note) => note.includes("still being checked")),
  );
});

test("linked receipt activity preserves unlinked batch output value and never removes an outgoing record", async () => {
  const issued = fixture();
  await issued.client.receive(
    await issued.client.quoteReceive({ amountSats: 10000 }),
  );
  const txid = "44".repeat(32);
  for (const [type, value, remaining] of [
    ["received", 15000, 5000],
    ["sent", 15000, 15000],
  ]) {
    const { client } = fixture({
      "GET /receive/requests": { requests: issued.storedRequests },
      "/transactions": [
        { txid, type, valueSats: value, confirmed: true, timestamp: NOW },
      ],
      "/receive/onchain": {
        address: ADDRESS,
        transactions: [{ txid, amountSats: 10000, confirmed: true }],
      },
    });
    const snapshot = await client.snapshot();
    assert.equal(snapshot.activity.length, 2);
    assert.equal(
      snapshot.activity.find((row) => row.id === `transaction:${txid}`)
        .amountSats,
      remaining,
    );
    assert.equal(
      snapshot.activity.find((row) => row.paymentHash === HASH).amountSats,
      10000,
    );
  }
});

test("funding transfer history follows channel readiness without regressing completed history when offline", () => {
  const txid = "55".repeat(32);
  for (const [state, htlcUsable, expected] of [
    ["AWAITING_FUNDING_CONFIRMED", false, "pending"],
    ["AWAITING_CHANNEL_READY", false, "pending"],
    ["NORMAL", true, "completed"],
    ["NORMAL", false, "completed"],
    ["CLOSED", false, "completed"],
    ["SPLICING", false, "completed"],
  ]) {
    const rows = mergeActivity({
      channels: [{ fundingTxid: txid, state, htlcUsable }],
      transactions: [
        {
          txid,
          type: "sent",
          valueSats: 10000,
          confirmed: true,
          timestamp: NOW,
        },
      ],
    });
    assert.equal(rows[0].kind, "transfer");
    assert.equal(rows[0].status, expected, state);
  }
});

test("a reused registered address invalidates cached Bitcoin attribution while Lightning remains exact", async () => {
  const issued = fixture();
  const original = await issued.client.receive(
    await issued.client.quoteReceive({ amountSats: 10000 }),
  );
  const txid = "66".repeat(32);
  let requests = issued.storedRequests;
  let paid = false,
    reads = 0;
  const { client } = fixture({
    "GET /receive/requests": () => ({ requests }),
    "/invoices": () => [
      {
        paymentHash: HASH,
        bolt11: INVOICE,
        amountSats: 10000,
        createdAt: NOW / 1000,
        expiry: 600,
        status: paid ? "PAID" : "PENDING",
      },
    ],
    "/transactions": [
      {
        txid,
        type: "received",
        valueSats: 10000,
        confirmed: true,
        timestamp: NOW,
      },
    ],
    "/receive/onchain": () => {
      reads++;
      return {
        address: ADDRESS,
        transactions: [{ txid, amountSats: 10000, confirmed: true }],
      };
    },
  });
  assert.equal((await client.getReceiveStatus(original)).phase, "completed");
  requests = [
    { ...requests[0], bitcoinTracking: "ambiguous" },
    {
      ...requests[0],
      id: "request-two",
      paymentHash: "77".repeat(32),
      bitcoinTracking: "ambiguous",
    },
  ];
  await assert.rejects(client.getReceiveStatus(original), {
    code: "AMBIGUOUS_RECEIVE_ADDRESS",
  });
  let snapshot = await client.snapshot();
  assert.equal(reads, 1, "ambiguous addresses are not queried or attributed");
  assert.equal(
    snapshot.activity.filter((row) => row.kind === "request").length,
    2,
  );
  assert.equal(
    snapshot.activity.find((row) => row.paymentHash === HASH)
      .receiveStatusUnavailable,
    true,
  );
  assert.equal(
    snapshot.activity.find((row) => row.paymentHash === HASH).receiveRequest
      .bitcoinTracking,
    "ambiguous",
  );
  assert.ok(snapshot.activity.some((row) => row.id === `transaction:${txid}`));
  paid = true;
  assert.equal((await client.getReceiveStatus(original)).method, "lightning");
  snapshot = await client.snapshot();
  assert.equal(
    snapshot.activity.find((row) => row.paymentHash === HASH).status,
    "completed",
  );
  assert.equal(reads, 1);
});

test("snapshot request lookup work is bounded and rotates unchecked requests without hiding metadata", async () => {
  const issued = fixture();
  const first = await issued.client.receive(
    await issued.client.quoteReceive({ amountSats: 10000 }),
  );
  const requests = Array.from({ length: 5 }, (_, i) => ({
    ...first,
    id: `request-${i}`,
    paymentHash: `${i + 1}`.repeat(64),
    createdAt: NOW + i,
    address: bech32Encode("bc", [
      0,
      ...convertBits(new Array(20).fill(i + 10), 8, 5, true),
    ]),
  }));
  let queries = 0;
  const { client } = fixture({
    "GET /receive/requests": { requests },
    "/receive/onchain": (_body, query) => {
      queries++;
      return {
        address: new URLSearchParams(query).get("address"),
        transactions: [],
      };
    },
  });
  assert.equal((await client.snapshot()).activity.length, 5);
  assert.equal(queries, 2);
  await client.snapshot();
  assert.equal(queries, 4);
  await client.snapshot();
  assert.equal(queries, 5);
  await client.snapshot();
  assert.equal(queries, 5);
});

test("one unavailable receive lookup does not mark another completed request unavailable", async () => {
  const issued = fixture();
  const first = await issued.client.receive(
    await issued.client.quoteReceive({ amountSats: 10000 }),
  );
  const second = {
    ...first,
    id: "second-request",
    paymentHash: "88".repeat(32),
    address: bech32Encode("bc", [
      0,
      ...convertBits(new Array(20).fill(8), 8, 5, true),
    ]),
  };
  const { client } = fixture({
    "GET /receive/requests": { requests: [first, second] },
    "/receive/onchain": (_body, query) => {
      const address = new URLSearchParams(query).get("address");
      if (address === first.address)
        throw new Error("first request lookup unavailable");
      return {
        address,
        transactions: [
          { txid: "99".repeat(32), amountSats: 10000, confirmed: true },
        ],
      };
    },
  });
  await client.getReceiveStatus(second);
  const snapshot = await client.snapshot();
  assert.equal(
    snapshot.activity.find((row) => row.paymentHash === first.paymentHash)
      .receiveStatusUnavailable,
    true,
  );
  const completed = snapshot.activity.find(
    (row) => row.paymentHash === second.paymentHash,
  );
  assert.equal(completed.status, "completed");
  assert.equal(completed.receiveStatusUnavailable, undefined);
});

test("only a typed address gap limit creates and persists a Lightning-only request without Bitcoin lookups", async () => {
  for (const makeClient of [fixture, embeddedFixture]) {
    let paid = false;
    const registered = [];
    const { client, calls } = makeClient({
      "/address/new": {
        response: result(
          {
            ok: false,
            error: {
              code: "RECEIVE_ADDRESS_LIMIT",
              message: "Unused receive address limit reached",
            },
          },
          409,
        ),
      },
      "POST /receive/requests": ({ request }) => {
        const canonical = {
          ...request,
          address: null,
          bitcoinTracking: "lightning-only",
          createdAt: NOW,
        };
        registered.push(canonical);
        return { request: canonical };
      },
      "/invoices": () => [
        {
          paymentHash: HASH,
          bolt11: INVOICE,
          amountSats: 10000,
          status: paid ? "PAID" : "PENDING",
          createdAt: NOW / 1000,
          expiry: 600,
        },
      ],
      "/direct-funding/request": () => {
        throw new Error(
          "Must not mint Bitcoin funding on Lightning-only request",
        );
      },
      "/receive/onchain": () => {
        throw new Error("Must not query Bitcoin for Lightning-only request");
      },
    });
    const request = await client.receive(
      await client.quoteReceive({ amountSats: 10000 }),
    );
    assert.equal(request.uri, INVOICE);
    assert.equal(request.address, undefined);
    assert.equal(request.bitcoinTracking, "lightning-only");
    assert.ok(
      request.warnings.some((warning) => warning.includes("accepts Lightning")),
    );
    assert.equal(
      calls.filter((call) => call.path === "/invoice/create").length,
      1,
    );
    assert.equal(
      calls.filter((call) => call.path === "/direct-funding/request").length,
      0,
    );
    assert.equal(registered.length, 1);
    const before = calls.length;
    assert.equal((await client.getReceiveStatus(request)).phase, "waiting");
    paid = true;
    assert.equal((await client.getReceiveStatus(request)).phase, "completed");
    assert.ok(
      calls
        .slice(before)
        .every((call) => ["/payments", "/invoices"].includes(call.path)),
    );
    const cold = makeClient({
      "GET /receive/requests": { requests: registered },
      "/invoices": [],
      "/receive/onchain": () => {
        throw new Error("No Bitcoin tracking after restart");
      },
    });
    const snapshot = await cold.client.snapshot();
    assert.equal(snapshot.activity.length, 1);
    assert.equal(snapshot.activity[0].kind, "request");
    assert.equal(snapshot.activity[0].receiveRequest.address, undefined);
    assert.equal(snapshot.activity[0].receiveRequest.uri, INVOICE);
    assert.equal(
      snapshot.activity[0].receiveRequest.bitcoinTracking,
      "lightning-only",
    );
    assert.equal(snapshot.activity[0].receiveStatusUnavailable, undefined);
    assert.ok(!cold.calls.some((call) => call.path === "/receive/onchain"));
  }
});

test("other address failures cannot silently become Lightning-only requests", async () => {
  for (const code of [
    "ADDRESS_FAILED",
    "DISCONNECTED",
    "RESULT_UNCERTAIN",
    "INVALID_PARAMS",
  ]) {
    const { client, calls } = embeddedFixture({
      "/address/new": {
        response: result(
          {
            ok: false,
            error: { code, message: "Address operation did not complete" },
          },
          503,
        ),
      },
    });
    await assert.rejects(
      client.receive(await client.quoteReceive({ amountSats: 10000 })),
      { code },
    );
    assert.ok(
      !calls.some((call) =>
        [
          "/invoice/create",
          "/jit/invoice",
          "/direct-funding/request",
          "/receive/requests",
        ].includes(call.path),
      ),
    );
  }
  const invalid = fixture({ "/address/new": { address: "invalid-address" } });
  await assert.rejects(
    invalid.client.receive(
      await invalid.client.quoteReceive({ amountSats: 10000 }),
    ),
    { code: "INVALID_RESPONSE" },
  );
  assert.ok(!invalid.calls.some((call) => call.path === "/invoice/create"));
});

test("Lightning-only gap fallback preserves JIT authorization caps and fee-change refusal", async () => {
  for (const changed of [false, true]) {
    const { client, calls } = embeddedFixture({
      "/channels": [],
      "/address/new": {
        response: result(
          {
            ok: false,
            error: { code: "RECEIVE_ADDRESS_LIMIT", message: "Gap reached" },
          },
          409,
        ),
      },
      "/jit/quote": {
        accepted: true,
        withinCeilings: true,
        flatFeeSat: 10,
        feePpm: 101,
        feeSats: 12,
      },
      "/jit/invoice": {
        bolt11: INVOICE,
        paymentHash: HASH,
        amountSats: 10000,
        flatFeeSat: changed ? 100 : 10,
        feePpm: 101,
      },
    });
    const quote = await client.quoteReceive({ amountSats: 10000 });
    if (changed)
      await assert.rejects(client.receive(quote), { code: "FEE_CHANGED" });
    else {
      const request = await client.receive(quote);
      assert.equal(request.feeSats, 12);
      assert.equal(request.bitcoinTracking, "lightning-only");
    }
    const authorized = calls.find((call) => call.path === "/jit/invoice");
    assert.equal(authorized.body.maxFlatFeeSat, 10);
    assert.equal(authorized.body.maxFeePpm, 101);
    assert.ok(!calls.some((call) => call.path === "/direct-funding/request"));
    if (changed)
      assert.ok(!calls.some((call) => call.path === "/receive/requests"));
  }
});

test("a channel whose funding has not confirmed is explained, not presented as settled", async () => {
  // A trusted zero-conf channel reports NORMAL from the moment it opens, so no
  // channel state marks it as arriving. Without the funding check the wallet
  // showed 200,000 sats as ordinary spendable balance with nothing to say the
  // channel itself was still only a mempool promise.
  const { client } = embeddedFixture({
    "/channels": [{ ...channel, fundingConfirmed: false }],
  });
  const snapshot = await client.snapshot();
  const note = snapshot.notes.find((n) => n.includes("has not confirmed yet"));
  assert.ok(note, "expected a note about the unconfirmed funding");
  assert.match(note, /200,000 sats are in a transfer/);
  assert.match(note, /Lightning sends work now/);
  assert.match(note, /Bitcoin address sends wait/);
  // The funds are genuinely spendable over Lightning, so the sendable figure is
  // deliberately unchanged. Understating it would block payments that work.
  assert.equal(snapshot.balance.availableSats, 190000);
});

test("a confirmed channel says nothing, and an unknown one does not guess", async () => {
  for (const fundingConfirmed of [true, undefined]) {
    const { client } = embeddedFixture({
      "/channels": [{ ...channel, ...(fundingConfirmed === undefined ? {} : { fundingConfirmed }) }],
    });
    const snapshot = await client.snapshot();
    // A chain lookup that failed reports nothing rather than "unconfirmed": it
    // must not turn into a claim about someone's money.
    assert.ok(!snapshot.notes.some((n) => n.includes("has not confirmed yet")));
  }
});

test("a Bitcoin send is refused while the channel's own funding is unconfirmed", async () => {
  // The splice spends the channel funding output. On a zero-conf channel the
  // engine drops its durable rebroadcast obligation as soon as the peer says
  // the splice is locked, which is before any chain evidence exists, so a
  // broadcast the network refuses is neither retried nor recorded: the payment
  // never arrives and never reports a failure. Refuse rather than start it.
  const { client, calls } = embeddedFixture({
    "/channels": [{ ...channel, fundingConfirmed: false }],
  });
  await assert.rejects(
    client.prepareSend({ request: ADDRESS, amountSats: 2000 }),
    (error) => {
      assert.equal(error.code, "FUNDING_UNCONFIRMED");
      assert.match(error.message, /waiting for its own funding transaction/);
      assert.match(error.message, /still send over Lightning now/);
      return true;
    },
  );
  // Nothing was quoted or submitted, so there is no half-started payment.
  assert.ok(!calls.some((c) => c.path === "/channel/splice-quote"));

  // Lightning is unaffected: those funds really are spendable.
  const lightning = await client.prepareSend({ request: INVOICE });
  assert.equal(lightning.route, "lightning");

  // A confirmed channel sends to an address as before.
  const { client: settled } = embeddedFixture({
    "/channels": [{ ...channel, fundingConfirmed: true }],
  });
  const ok = await settled.prepareSend({ request: ADDRESS, amountSats: 2000 });
  assert.equal(ok.route, "bitcoin");

  // An unknown funding state is not treated as unconfirmed.
  const { client: unknown } = embeddedFixture({ "/channels": [channel] });
  const still = await unknown.prepareSend({ request: ADDRESS, amountSats: 2000 });
  assert.equal(still.route, "bitcoin");
});

test("a payment within the total but above what can be sent explains what is arriving", async () => {
  // The fixture holds 202,500 sats in total (200,000 Lightning, 2,000 arriving
  // on-chain, 500 in a splice) but can only send 180,000 out to an address.
  // For a payment 2,000 over that, "Not enough funds" would be wrong: the
  // money is there, it is just moving.
  const { client } = embeddedFixture();
  await assert.rejects(
    client.prepareSend({ request: ADDRESS, amountSats: 182000 }),
    (error) => {
      assert.equal(error.code, "INSUFFICIENT_FUNDS");
      assert.match(error.message, /2,000 sats more than you can send/);
      assert.match(error.message, /2,000 sats arriving on-chain/);
      assert.match(error.message, /500 sats rejoin your balance/);
      assert.match(error.message, /request stays here to try again/);
      return true;
    },
  );

  // Above the total there is nothing to wait for, so the plain refusal stands.
  const { client: other } = embeddedFixture();
  await assert.rejects(
    other.prepareSend({ request: ADDRESS, amountSats: 900000 }),
    (error) => {
      assert.equal(error.code, "INSUFFICIENT_FUNDS");
      assert.match(error.message, /available balance is too low/);
      assert.doesNotMatch(error.message, /arriving on-chain/);
      return true;
    },
  );
});

test("a shortfall that nothing arriving covers gets the plain refusal", async () => {
  // Total includes the channel reserve, which is never sendable. With nothing
  // arriving, a payment inside that gap used to be told "0 sats on their way
  // into your channel" and that it could try again.
  const { client } = embeddedFixture({
    "/balance": { onchain: 0, lightning: 10500, splicingSats: 0 },
    "/liquidity": { sendableSats: 9500 },
    "/utxos": [],
  });
  await assert.rejects(client.prepareSend({ request: INVOICE }), (error) => {
    assert.equal(error.code, "INSUFFICIENT_FUNDS");
    assert.match(error.message, /You can send up to 9,500 sats over Lightning/);
    assert.doesNotMatch(error.message, /on their way|try again/);
    return true;
  });

  // Something is arriving, but less than the payment is short: the reserve
  // and the splice fee make up the rest, and waiting does not make the
  // payment possible.
  const { client: partly } = embeddedFixture();
  await assert.rejects(
    partly.prepareSend({ request: ADDRESS, amountSats: 195000 }),
    (error) => {
      assert.equal(error.code, "INSUFFICIENT_FUNDS");
      assert.match(error.message, /available balance is too low/);
      assert.doesNotMatch(error.message, /arriving on-chain|try again/);
      return true;
    },
  );
});

test("an explanation that cannot be built never changes the refusal itself", async () => {
  const { client } = embeddedFixture({
    "/utxos": new Error("utxo read failed"),
  });
  await assert.rejects(
    client.prepareSend({ request: ADDRESS, amountSats: 195000 }),
    { code: "INSUFFICIENT_FUNDS" },
  );
});

test("the JIT opening fee is requested as a skim and any other collection mode is refused", async () => {
  // Beignet 0.15.0 added `hop` mode, where the sender pays the opening fee as a
  // routing fee instead of it being deducted. quoteReceive priced a deduction
  // and reported netSats on that basis, so a hop invoice is not the request the
  // user reviewed. An older daemon reports no mode at all, which can only be skim.
  for (const feeMode of [undefined, "skim", "hop"]) {
    const { client, calls } = embeddedFixture({
      "/channels": [],
      "/jit/quote": {
        accepted: true,
        withinCeilings: true,
        flatFeeSat: 10,
        feePpm: 101,
        feeSats: 12,
      },
      "/jit/invoice": {
        bolt11: INVOICE,
        paymentHash: HASH,
        amountSats: 10000,
        flatFeeSat: 10,
        feePpm: 101,
        ...(feeMode === undefined ? {} : { feeMode }),
      },
    });
    const quote = await client.quoteReceive({ amountSats: 10000 });
    assert.equal(quote.feeSats, 12);
    assert.equal(quote.netSats, 9988);
    if (feeMode === "hop") {
      await assert.rejects(client.receive(quote), {
        code: "FEE_MODE_CHANGED",
      });
      // A request whose terms were not the reviewed ones is never registered
      // for sharing, exactly as a changed fee amount is not.
      assert.ok(!calls.some((call) => call.path === "/receive/requests"));
    } else {
      const request = await client.receive(quote);
      assert.equal(request.feeSats, 12);
    }
    // The mode we accept is named on the wire rather than inherited from a
    // daemon-side default that could change under us.
    const authorized = calls.find((call) => call.path === "/jit/invoice");
    assert.equal(authorized.body.feeMode, "skim");
  }
});

test("a missing Bitcoin address is accepted only for an explicit Lightning-only request", async () => {
  for (const request of [
    { uri: INVOICE, paymentHash: HASH, amountSats: 10000, demo: false },
    {
      uri: INVOICE,
      paymentHash: HASH,
      amountSats: 10000,
      demo: false,
      address: ADDRESS,
      bitcoinTracking: "lightning-only",
    },
  ]) {
    await assert.rejects(fixture().client.getReceiveStatus(request), {
      code: "INVALID_REQUEST",
    });
  }
});

test("an expired Lightning-only request still recognizes exact settlement and retains archived metadata", async () => {
  let paid = false;
  const { client, setNow, calls } = fixture({
    "/address/new": {
      response: result(
        {
          ok: false,
          error: { code: "RECEIVE_ADDRESS_LIMIT", message: "Gap reached" },
        },
        409,
      ),
    },
    "/invoices": () => [
      {
        paymentHash: HASH,
        bolt11: INVOICE,
        amountSats: 10000,
        createdAt: NOW / 1000,
        expiry: 600,
        status: paid ? "PAID" : "EXPIRED",
      },
    ],
  });
  const request = await client.receive(
    await client.quoteReceive({ amountSats: 10000 }),
  );
  setNow(request.expiresAt + 1);
  assert.equal((await client.getReceiveStatus(request)).phase, "waiting");
  paid = true;
  const status = await client.getReceiveStatus(request);
  assert.equal(status.phase, "completed");
  assert.equal(status.paymentHash, request.paymentHash);
  const row = (await client.snapshot()).activity.find(
    (item) => item.paymentHash === HASH,
  );
  assert.equal(row.status, "completed");
  assert.equal(row.receiveRequest.uri, request.uri);
  assert.equal(row.receiveRequest.expiresAt, request.expiresAt);
  assert.ok(!calls.some((call) => call.path === "/receive/onchain"));
});

test("the arriving-funds note speaks in the wallet's own terms, never the manager's controls", () => {
  const status = {
    canSend: 1000,
    total: 60000,
    unconfirmed: 0,
    confirmedOnchain: 50000,
    feeWait: { feeSats: 3000, amountSats: 50000 },
    pending: 50000,
    pendingChannels: [],
  };
  const note = arrivingFundsNote(5000, status);
  assert.match(note, /waiting for a lower network fee/);
  assert.doesNotMatch(note, /Overview|Move now anyway/);
  // The floor the copy quotes is the constant the manager enforces.
  const small = arrivingFundsNote(5000, {
    ...status,
    feeWait: null,
    confirmedOnchain: CHANNELIZE_FLOOR_SATS - 1,
  });
  assert.match(small, new RegExp(CHANNELIZE_FLOOR_SATS.toLocaleString("en-US")));
});

test("the arriving-funds note only speaks when what is arriving covers the shortfall", () => {
  // 1,000 sats of the 100,000 total are the channel reserve.
  const status = {
    canSend: 99000,
    total: 100000,
    unconfirmed: 0,
    confirmedOnchain: 0,
    feeWait: null,
    pending: 0,
    pendingChannels: [],
  };
  assert.equal(arrivingFundsNote(99500, status), null);
  const arriving = { ...status, total: 100300, unconfirmed: 300, pending: 300 };
  assert.equal(arrivingFundsNote(99500, arriving), null);
  const note = arrivingFundsNote(99200, arriving);
  assert.match(note, /200 sats more than you can send/);
  assert.match(note, /300 sats arriving on-chain/);
});

test("an existing recovery phrase is sent once for a restore and checked for shape first", async () => {
  const phrase = new Array(24).fill("fixture-only").join(" ");
  const { client, calls } = fixture({
    "POST /api/wallets": { record, mnemonic: phrase },
  });
  const created = await client.createWallet({
    name: "Restored",
    network: "mainnet",
    mnemonic: `  ${phrase.toUpperCase()}  `,
  });
  assert.equal(created.id, record.id);
  const body = calls.find(
    (c) => c.path === "/api/wallets" && c.method === "POST",
  ).body;
  assert.equal(body.mnemonic, phrase);
  await assert.rejects(
    client.createWallet({ network: "mainnet", mnemonic: "only five words here now" }),
    (error) => error.code === "INVALID_MNEMONIC",
  );
  // No phrase means the engine generates one, as before.
  const { calls: plain, client: fresh } = fixture({
    "POST /api/wallets": { record, mnemonic: phrase },
  });
  await fresh.createWallet({ network: "mainnet" });
  assert.equal(
    "mnemonic" in plain.find((c) => c.path === "/api/wallets").body,
    false,
  );
});

test("a stranger's funding and a splice revert are explained in the wallet's notes", async () => {
  const withLfbw = (extra) => ({
    ...record,
    lfbw: { ...record.lfbw, ...extra },
  });
  let { client } = fixture({
    "/api/wallets/wallet-1": withLfbw({ unpairedFunding: { at: NOW - 1000 } }),
  });
  let snapshot = await client.snapshot();
  assert.ok(snapshot.wallet.lfbw.unpairedFunding);
  assert.ok(
    snapshot.notes.some((n) => n.includes("locks after three confirmations")),
    snapshot.notes.join(" | "),
  );
  ({ client } = fixture({
    "/api/wallets/wallet-1": withLfbw({
      lastSplice: { state: "conflicted", spliceTxid: "aa", conflictTxid: "bb", at: NOW },
    }),
  }));
  snapshot = await client.snapshot();
  assert.equal(snapshot.wallet.lfbw.lastSplice.state, "conflicted");
  assert.ok(snapshot.notes.some((n) => n.includes("being restored")));
  ({ client } = fixture({
    "/api/wallets/wallet-1": withLfbw({
      lastSplice: { state: "reverted", spliceTxid: "aa", conflictTxid: "bb", at: NOW - 1000 },
    }),
  }));
  snapshot = await client.snapshot();
  assert.ok(snapshot.notes.some((n) => n.includes("was restored")));
  // An old revert is no longer news.
  ({ client } = fixture({
    "/api/wallets/wallet-1": withLfbw({
      lastSplice: { state: "reverted", spliceTxid: "aa", conflictTxid: "bb", at: NOW - 2 * 60 * 60 * 1000 },
    }),
  }));
  snapshot = await client.snapshot();
  assert.ok(!snapshot.notes.some((n) => n.includes("restored")));
  // An unknown state never reaches the record.
  ({ client } = fixture({
    "/api/wallets/wallet-1": withLfbw({ lastSplice: { state: "weird", at: NOW } }),
  }));
  snapshot = await client.snapshot();
  assert.equal(snapshot.wallet.lfbw.lastSplice, undefined);
});

// ── Direct funding from this wallet ──────────────────────────────────────────

const FUNDING_URI = () =>
  `bitcoin:${ADDRESS}?amount=0.0001&bgnq=${encodeFundingEnvelope({
    nodeId: PK,
    expiresAt: NOW + 600000,
    amountSats: 10000,
  })}`;
const CONFIRMED_COIN = [{ height: 800000, valueSats: 30000 }];

test("a request with a direct-funding envelope is paid as direct funding when a confirmed coin covers it", async () => {
  const { client, calls } = embeddedFixture({
    "/utxos": CONFIRMED_COIN,
    "/direct-funding/send": {
      offerId: "of".repeat(16),
      status: "SIGNED_PENDING",
      fundingTxid: "ef".repeat(32),
      amountSat: 10000,
    },
  });
  const review = await client.prepareSend({ request: FUNDING_URI() });
  assert.equal(review.route, "bitcoin");
  assert.equal(review.method, "direct-funding");
  assert.equal(review.feeSats, 1000);
  assert.equal(review.feeLabel, "Maximum network fee");
  assert.ok(review.warnings.some((w) => w.includes("direct funding")));
  assert.ok(!calls.some((c) => c.path === "/channel/splice-quote"));
  const sent = await client.send(review);
  assert.equal(sent.status, "pending");
  assert.equal(sent.txid, "ef".repeat(32));
  assert.equal(sent.feeEstimated, true);
  const call = calls.find((c) => c.path === "/direct-funding/send");
  assert.equal(call.body.amountSats, 10000);
  assert.equal(call.body.feeHeadroomSats, 1000);
  assert.equal(call.body.requestId, review.id);
  assert.ok(typeof call.body.request === "string");
  assert.ok(!calls.some((c) => c.path === "/channel/splice-out"));
  // The same request cannot be sent twice.
  await assert.rejects(client.send(review));
  const row = (await client.snapshot()).activity.find(
    (a) => a.id === `submission:${review.id}`,
  );
  assert.equal(row.status, "pending");
  assert.equal(row.title, "Direct funding sent");
});

test("without a covering confirmed coin the same request pays the address by splice-out", async () => {
  const { client, calls } = embeddedFixture();
  const review = await client.prepareSend({ request: FUNDING_URI() });
  assert.equal(review.route, "bitcoin");
  assert.equal(review.method, undefined);
  assert.equal(review.feeSats, 225);
  assert.ok(review.warnings.some((w) => w.includes("Paying the address instead")));
  assert.ok(calls.some((c) => c.path === "/channel/splice-quote"));
  // A coin that covers the amount but not the fee ceiling is not enough.
  const { client: thin } = embeddedFixture({
    "/utxos": [{ height: 800000, valueSats: 10500 }],
  });
  const tight = await thin.prepareSend({ request: FUNDING_URI() });
  assert.equal(tight.method, undefined);
});

test("a settled direct funding is completed, a failed one is failed, and neither is followed by a splice-out", async () => {
  const { client, calls } = embeddedFixture({
    "/utxos": CONFIRMED_COIN,
    "/direct-funding/send": {
      offerId: "aa".repeat(16),
      status: "CONFIRMED",
      fundingTxid: "ef".repeat(32),
    },
  });
  const done = await client.send(await client.prepareSend({ request: FUNDING_URI() }));
  assert.equal(done.status, "completed");
  assert.equal(done.txid, "ef".repeat(32));
  const { client: failing, calls: failingCalls } = embeddedFixture({
    "/utxos": CONFIRMED_COIN,
    "/direct-funding/send": {
      offerId: "bb".repeat(16),
      status: "FAILED",
      caveat: "The receiver never broadcast the funding.",
    },
  });
  const failed = await failing.send(
    await failing.prepareSend({ request: FUNDING_URI() }),
  );
  assert.equal(failed.status, "failed");
  assert.match(failed.message, /did not complete/);
  assert.match(failed.message, /never broadcast/);
  assert.ok(!calls.concat(failingCalls).some((c) => c.path === "/channel/splice-out"));
});

test("a pre-witness refusal spends nothing, and the next review pays the address", async () => {
  for (const answer of [
    { offerId: "cc".repeat(16), status: "OFFERED" },
    Object.assign(new Error("offer declined: too many concurrent funding sessions"), {
      code: "OFFER_DECLINED",
    }),
  ]) {
    const { client, calls } = embeddedFixture({
      "/utxos": CONFIRMED_COIN,
      "/direct-funding/send": answer,
    });
    const review = await client.prepareSend({ request: FUNDING_URI() });
    assert.equal(review.method, "direct-funding");
    const sent = await client.send(review);
    assert.equal(sent.status, "failed");
    assert.match(sent.message, /Nothing was sent/);
    assert.match(sent.message, /Review again to pay the address/);
    assert.ok(!calls.some((c) => c.path === "/channel/splice-out"));
    // The refusal is certain, so the request is not offered as a direct
    // funding again: the next review is the ordinary address payment.
    const again = await client.prepareSend({ request: FUNDING_URI() });
    assert.equal(again.method, undefined);
    assert.equal(again.feeSats, 225);
    assert.ok(!again.warnings.some((w) => w.includes("accepts direct funding")));
    const paid = await client.send(again);
    assert.equal(paid.status, "pending");
    assert.equal(calls.filter((c) => c.path === "/direct-funding/send").length, 1);
    assert.equal(calls.filter((c) => c.path === "/channel/splice-out").length, 1);
  }
});

test("a lost host connection during a direct funding stays uncertain and is never retried", async () => {
  const { client, calls } = fixture({
    "/utxos": CONFIRMED_COIN,
    "/direct-funding/send": new Error("connection lost"),
  });
  const review = await client.prepareSend({ request: FUNDING_URI() });
  const sent = await client.send(review);
  assert.equal(sent.status, "uncertain");
  assert.ok(!calls.some((c) => c.path === "/channel/splice-out"));
  await assert.rejects(client.send(review));
  // Still locked: the same envelope is not re-offered while its outcome is unknown.
  await assert.rejects(
    client.send(await client.prepareSend({ request: FUNDING_URI() })),
    { code: "ALREADY_SUBMITTED" },
  );
});

test("the wallet's last channelize decision and last offer answer pass through sanitized", async () => {
  const withLfbw = (extra) => ({ ...record, lfbw: { ...record.lfbw, ...extra } });
  const { client } = fixture({
    "/api/wallets/wallet-1": withLfbw({
      lastChannelize: {
        action: "failed",
        at: NOW - 1000,
        error: "peer lacks option_splice",
        code: "SPLICING_NOT_NEGOTIATED",
        retryAt: NOW + 119000,
        body: { channelId: "never-exposed" },
      },
      lastOffer: { state: "declined", reason: "no liquidity peer", at: NOW - 500 },
    }),
  });
  const snapshot = await client.snapshot();
  assert.deepEqual(snapshot.wallet.lfbw.lastChannelize, {
    action: "failed",
    at: NOW - 1000,
    error: "peer lacks option_splice",
    code: "SPLICING_NOT_NEGOTIATED",
    retryAt: NOW + 119000,
  });
  assert.deepEqual(snapshot.wallet.lfbw.lastOffer, {
    state: "declined",
    reason: "no liquidity peer",
    at: NOW - 500,
  });
  const { client: odd } = fixture({
    "/api/wallets/wallet-1": withLfbw({
      lastChannelize: { action: "explode", at: NOW },
      lastOffer: { state: "weird", at: NOW },
    }),
  });
  const plain = await odd.snapshot();
  assert.equal("lastChannelize" in plain.wallet.lfbw, false);
  assert.equal("lastOffer" in plain.wallet.lfbw, false);
});

test("confirmed on-chain funds say what the wallet is doing with them", async () => {
  const withLfbw = (extra) => ({ ...record, lfbw: { ...record.lfbw, ...extra } });
  const confirmed = {
    "/balance": { onchain: 30000, lightning: 200000, splicingSats: 0 },
    "/utxos": [{ height: 800000, valueSats: 30000 }],
  };
  let { client } = fixture({
    ...confirmed,
    "/api/wallets/wallet-1": withLfbw({
      lastChannelize: { action: "failed", at: NOW - 1000, error: "peer disconnected" },
    }),
  });
  let notes = (await client.snapshot()).notes;
  let note = notes.find((n) => n.startsWith("30,000 sats confirmed"));
  assert.ok(note, notes.join(" | "));
  assert.match(note, /Moving them failed\. peer disconnected\. Retrying\./);
  assert.ok(!notes.some((n) => /Moving them now|Automatic setup/.test(n)));
  ({ client } = fixture({
    ...confirmed,
    "/api/wallets/wallet-1": withLfbw({
      lastChannelize: { action: "failed", at: NOW - 10 * 60 * 1000, error: "peer disconnected" },
    }),
  }));
  note = (await client.snapshot()).notes.find((n) => n.startsWith("30,000 sats confirmed"));
  assert.match(note, /Refresh to try again/);
  ({ client } = fixture({
    ...confirmed,
    "/api/wallets/wallet-1": withLfbw({
      lastChannelize: { action: "wait", reason: "splicing", at: NOW - 1000 },
    }),
  }));
  note = (await client.snapshot()).notes.find((n) => n.startsWith("30,000 sats confirmed"));
  assert.match(note, /once the current transfer confirms/);
  ({ client } = fixture({
    ...confirmed,
    "/api/wallets/wallet-1": withLfbw({
      lastChannelize: { action: "splice-in", amountSats: 28000, at: NOW - 1000 },
    }),
  }));
  note = (await client.snapshot()).notes.find((n) => n.startsWith("30,000 sats confirmed"));
  assert.match(note, /Moving them now/);
  ({ client } = fixture(confirmed));
  note = (await client.snapshot()).notes.find((n) => n.startsWith("30,000 sats confirmed"));
  assert.match(note, /Moving them now/);
  // Below the floor the wait is the rule, whatever the last decision said.
  ({ client } = fixture({
    "/balance": { onchain: 20000, lightning: 200000, splicingSats: 0 },
    "/utxos": [{ height: 800000, valueSats: 20000 }],
  }));
  note = (await client.snapshot()).notes.find((n) => n.startsWith("20,000 sats confirmed"));
  assert.match(note, /move at 25,000 sats/);
});

test("diagnostics gather the engine's figures in one read and never carry secrets", async () => {
  const { client } = fixture({
    "/info": { blockHeight: 800123, pendingCloseBalanceSats: 0, erroredBalanceSats: 0 },
    "/health": { electrumConnected: true },
    "/graph/info": { nodeCount: 5244, channelCount: 27537, lastSyncAt: 1790000000000 },
    "/direct-funding/config": {
      lspPubkey: PK,
      lspHost: "relay.example",
      lspPort: 9102,
      allowSplice: true,
      allowUnpairedSplice: true,
      unpairedSpliceDepth: 3,
      minAmountSat: 5000,
    },
  });
  const d = await client.diagnostics();
  assert.equal(d.blockHeight, 800123);
  assert.equal(d.electrumConnected, true);
  assert.equal(d.primaryConnected, true);
  assert.equal(d.sendableSats, 190000);
  assert.equal(d.channels[0].withPrimary, true);
  assert.equal(d.channels[0].state, "NORMAL");
  assert.equal(d.directFunding.allowUnpairedSplice, true);
  assert.equal(d.utxos[0].valueSats, 2000);
  assert.deepEqual(d.graph, { nodes: 5244, channels: 27537, lastSyncAt: 1790000000000 });
  assert.equal(JSON.stringify(d).includes("fixture-word"), false);
  // A read that fails leaves its field null rather than failing the whole picture.
  const { client: partial } = fixture({ "/direct-funding/config": new Error("no") });
  assert.equal((await partial.diagnostics()).directFunding, null);
  assert.equal((await partial.diagnostics()).graph, null, "an engine without /graph/info");
  assert.deepEqual(Object.keys(await new DemoWalletClient().diagnostics()).sort(), ["checkedAt", "demo"]);
});

test("a unified request with an invoice and an envelope goes over Lightning when it can, else by direct funding", async () => {
  const unified = () =>
    `bitcoin:${ADDRESS}?amount=0.0001&lightning=${INVOICE}&bgnq=${encodeFundingEnvelope({
      nodeId: PK,
      expiresAt: NOW + 600000,
      amountSats: 10000,
    })}`;
  // Enough Lightning: the invoice is the payment, the coin stays put.
  const { client: lightning, calls } = embeddedFixture({ "/utxos": CONFIRMED_COIN });
  const overLightning = await lightning.prepareSend({ request: unified() });
  assert.equal(overLightning.route, "lightning");
  assert.equal(overLightning.method, undefined);
  assert.ok(!calls.some((c) => c.path === "/direct-funding/send"));
  // No Lightning to send with: the coin funds the recipient's channel.
  const { client: fresh, calls: freshCalls } = embeddedFixture({
    "/utxos": CONFIRMED_COIN,
    "/liquidity": { sendableSats: 0 },
    "/payment/estimate": new Error("Unable to estimate payment"),
    "/direct-funding/send": { offerId: "dd".repeat(16), status: "SIGNED_PENDING", fundingTxid: "ef".repeat(32) },
  });
  const direct = await fresh.prepareSend({ request: unified() });
  assert.equal(direct.route, "bitcoin");
  assert.equal(direct.method, "direct-funding");
  assert.equal((await fresh.send(direct)).status, "pending");
  assert.ok(!freshCalls.some((c) => c.path === "/payment/estimate"));
  // No coin and no Lightning: the Lightning refusal stands, unchanged.
  const { client: broke } = embeddedFixture({
    "/liquidity": { sendableSats: 0 },
    "/payment/estimate": new Error("Unable to estimate payment"),
  });
  await assert.rejects(broke.prepareSend({ request: unified() }));
});

test("embedded receiving prepares an offline invoice and preserves its coverage after saving", async () => {
  const terms = { available:true, peer:PK, amountSats:10000, feeSats:0, terms:{feeBaseMsat:0,feePpm:0}, expiresAt:NOW+60000 };
  const {client,calls}=embeddedFixture({
    "/api/config":{offlineReceiveAvailable:true},
    "/receive/quote":terms,
    "/receive/invoice":{bolt11:INVOICE,paymentHash:HASH,offlineReceive:true},
  });
  const quote=await client.quoteReceive({amountSats:10000,mode:"offline"});
  const request=await client.receive(quote);
  assert.equal(request.offlineReceive,true);
  const create=calls.find(c=>c.path==="/receive/invoice");
  assert.deepEqual(create.body.quote,terms);assert.equal(create.body.requestId,quote.id);
  assert.ok(!calls.some(c=>["/invoice/create","/jit/invoice","/direct-funding/request"].includes(c.path)));
});
test("unsupported offline provider never silently downgrades to an online-only invoice",async()=>{
  const {client,calls}=embeddedFixture({"/api/config":{offlineReceiveAvailable:true},"/receive/quote":Object.assign(Error("Your node did not answer the receive request."),{code:"RECEIVE_UNAVAILABLE"})});
  await assert.rejects(client.quoteReceive({amountSats:10000,mode:"offline"}),{code:"RECEIVE_UNAVAILABLE"});
  assert.ok(!calls.some(c=>["/invoice/create","/jit/invoice","/address/new"].includes(c.path)));
  await assert.rejects(client.quoteReceive({mode:"offline"}),{code:"AMOUNT_REQUIRED"});
});
test("embedded receiving defaults to JIT with no channel and never asks the offline lane", async () => {
  const { client, calls } = embeddedFixture({
    "/api/config": { offlineReceiveAvailable: true },
    "/channels": [],
    "/jit/quote": {
      accepted: true,
      withinCeilings: true,
      flatFeeSat: 10,
      feePpm: 101,
      feeSats: 12,
    },
  });
  const quote = await client.quoteReceive({ amountSats: 10000 });
  assert.equal(quote.netSats, 9988);
  const request = await client.receive(quote);
  assert.equal(request.offlineReceive, undefined);
  assert.equal(request.feeSats, 12);
  assert.equal(calls.find((call) => call.path === "/jit/invoice").body.feeMode, "skim");
  assert.equal(
    calls.filter((call) => call.path === "/direct-funding/request").length,
    1,
  );
  assert.ok(
    !calls.some((call) =>
      ["/api/config", "/receive/quote", "/receive/invoice", "/invoice/create"].includes(call.path),
    ),
  );
});
test("embedded receiving defaults to a plain invoice over existing inbound", async () => {
  const { client, calls } = embeddedFixture({
    "/api/config": { offlineReceiveAvailable: true },
  });
  const quote = await client.quoteReceive({ amountSats: 10000 });
  assert.equal(quote.feeSats, 0);
  const request = await client.receive(quote);
  assert.equal(request.offlineReceive, undefined);
  assert.equal(calls.filter((call) => call.path === "/invoice/create").length, 1);
  assert.ok(
    !calls.some((call) =>
      ["/api/config", "/receive/quote", "/receive/invoice", "/jit/quote", "/jit/invoice"].includes(call.path),
    ),
  );
});

test("explicit unified receive uses JIT and direct funding despite advertised offline support", async () => {
  const { client, calls } = embeddedFixture({
    "/api/config": { offlineReceiveAvailable: true },
    "/channels": [],
    "/jit/quote": {
      accepted: true,
      withinCeilings: true,
      flatFeeSat: 10,
      feePpm: 101,
      feeSats: 12,
    },
  });
  const quote = await client.quoteReceive({
    amountSats: 10000,
    mode: "unified",
  });
  assert.equal(quote.netSats, 9988);
  assert.ok(calls.every((call) => call.method === "GET"));
  await assert.rejects(client.receive({ ...quote, mode: "offline" }), {
    code: "REVIEW_CHANGED",
  });
  const request = await client.receive(quote);
  const parsed = parsePayment(request.uri, { network: "mainnet", now: NOW });
  assert.equal(parsed.kind, "onchain");
  assert.equal(parsed.address, ADDRESS);
  assert.equal(parsed.lightning.invoice, INVOICE);
  assert.equal(parsed.funding.amountSats, 10000);
  assert.equal(request.feeSats, 12);
  assert.equal(request.offlineReceive, undefined);
  const body = calls.find((call) => call.path === "/jit/invoice").body;
  assert.equal(body.feeMode, "skim");
  assert.equal(body.maxFlatFeeSat, 10);
  assert.equal(body.maxFeePpm, 101);
  assert.equal(
    calls.filter((call) => call.path === "/direct-funding/request").length,
    1,
  );
  assert.ok(
    !calls.some((call) =>
      ["/receive/quote", "/receive/invoice", "/invoice/create"].includes(call.path),
    ),
  );
  await assert.rejects(client.receive(quote), { code: "INVALID_REVIEW" });
});

test("explicit unified receive reuses inbound capacity and includes direct funding", async () => {
  const { client, calls } = embeddedFixture({
    "/api/config": { offlineReceiveAvailable: true },
  });
  const quote = await client.quoteReceive({
    amountSats: 10000,
    mode: "unified",
  });
  assert.equal(quote.feeSats, 0);
  const request = await client.receive(quote);
  const parsed = parsePayment(request.uri, { network: "mainnet", now: NOW });
  assert.equal(parsed.kind, "onchain");
  assert.equal(parsed.lightning.invoice, INVOICE);
  assert.equal(parsed.funding.amountSats, 10000);
  assert.equal(request.offlineReceive, undefined);
  assert.equal(calls.filter((call) => call.path === "/invoice/create").length, 1);
  assert.equal(
    calls.filter((call) => call.path === "/direct-funding/request").length,
    1,
  );
  assert.ok(
    !calls.some((call) =>
      ["/receive/quote", "/receive/invoice", "/jit/quote", "/jit/invoice"].includes(call.path),
    ),
  );
});

test("invalid receive modes fail before any network request", async () => {
  for (const make of [fixture, embeddedFixture]) {
    const { client, calls } = make();
    for (const mode of ["auto", "", null, false, 1, {}]) {
      await assert.rejects(client.quoteReceive({ amountSats: 10000, mode }), {
        code: "INVALID_PARAMS",
      });
    }
    assert.equal(calls.length, 0);
    assert.equal(client._receiveQuotes.size, 0);
  }
  await assert.rejects(
    new DemoWalletClient().quoteReceive({ amountSats: 10000, mode: "auto" }),
    { code: "INVALID_PARAMS" },
  );
});

test("explicit offline receive requires advertised support without falling back", async () => {
  for (const make of [fixture, embeddedFixture]) {
    for (const advertised of [undefined, false, "true"]) {
      const { client, calls } = make({
        "/api/config": { offlineReceiveAvailable: advertised },
      });
      await assert.rejects(
        client.quoteReceive({ amountSats: 10000, mode: "offline" }),
        { code: "RECEIVE_UNAVAILABLE" },
      );
      assert.ok(calls.every((call) => call.method === "GET"));
      assert.ok(
        !calls.some((call) => ["/receive/quote", "/jit/quote"].includes(call.path)),
      );
      assert.equal(client._receiveQuotes.size, 0);
    }
  }
  await assert.rejects(
    new DemoWalletClient().quoteReceive({ amountSats: 10000, mode: "offline" }),
    { code: "RECEIVE_UNAVAILABLE" },
  );
});

test("explicit offline receive retains its reservation when advertised", async () => {
  const terms = {
    available: true,
    peer: PK,
    amountSats: 10000,
    feeSats: 0,
    terms: { feeBaseMsat: 0, feePpm: 0 },
    expiresAt: NOW + 60000,
  };
  for (const make of [fixture, embeddedFixture]) {
    const { client, calls } = make({
      "/api/config": { offlineReceiveAvailable: true },
      "/receive/quote": terms,
      "/receive/invoice": {
        bolt11: INVOICE,
        paymentHash: HASH,
        offlineReceive: true,
      },
    });
    const quote = await client.quoteReceive({ amountSats: 10000, mode: "offline" });
    const request = await client.receive(quote);
    assert.equal(request.offlineReceive, true);
    const create = calls.find((call) => call.path === "/receive/invoice");
    assert.deepEqual(create.body.quote, terms);
    assert.equal(create.body.requestId, quote.id);
    assert.ok(
      !calls.some((call) =>
        ["/invoice/create", "/jit/invoice", "/direct-funding/request"].includes(call.path),
      ),
    );
  }
});

test("channel recovery import requires an explicit phrase and supported browser engine", async () => {
  const mnemonic = new Array(12).fill("fixture-only").join(" ");
  const { client, calls } = embeddedFixture({
    "/api/config": { recoveryAutoApplyAvailable: true },
    "POST /api/wallets": { record, mnemonic },
  });
  const created = await client.createWallet({ mnemonic, recoveryAutoApply: true });
  assert.equal(created.id, record.id);
  const creations = calls.filter(c => c.path === "/api/wallets" && c.method === "POST");
  assert.equal(creations.length, 1);
  assert.equal(creations[0].body.recoveryAutoApply, true);
  assert.equal(creations[0].body.mnemonic, mnemonic);
  assert.equal(creations[0].body.recoveryMode, "peer-storage");
  assert.equal(calls[0].path, "/api/config");
  for (const make of [fixture, embeddedFixture]) {
    const unsupported = make({ "/api/config": { recoveryAvailable: true } });
    await assert.rejects(unsupported.client.createWallet({ mnemonic, recoveryAutoApply: true }), { code: "RECOVERY_UNAVAILABLE" });
    assert.ok(unsupported.calls.every(c => c.method === "GET"));
  }
});

test("invalid or empty import phrases never fall through to fresh wallet creation", async () => {
  const { client, calls } = embeddedFixture();
  for (const mnemonic of ["", "   ", null, 42, [], "too few words"]) {
    await assert.rejects(client.createWallet({ mnemonic }), { code: "INVALID_MNEMONIC" });
  }
  await assert.rejects(client.createWallet({ recoveryAutoApply: true }), { code: "INVALID_MNEMONIC" });
  await assert.rejects(client.createWallet({ recoveryAutoApply: "true" }), { code: "INVALID_PARAMS" });
  assert.equal(calls.length, 0);
  const demo = new DemoWalletClient();
  await assert.rejects(demo.createWallet({ mnemonic: "fixture phrase" }), { code: "DEMO_ONLY" });
});

test("ordinary wallet creation never opts into automatic capsule import", async () => {
  const { client, calls } = embeddedFixture({ "POST /api/wallets": { record } });
  await client.createWallet();
  const create = calls.find(c => c.path === "/api/wallets");
  assert.equal("recoveryAutoApply" in create.body, false);
  assert.equal("mnemonic" in create.body, false);
});

const recoveryFixture = () => ({
  mode: "peer-storage", state: "running", importPending: false, importComplete: true,
  autoApply: { enabled: true, phase: "idle", lastReason: null },
  capsules: { candidates: 1, best: { channelCount: 1, secretCapsule: "not-for-ui" } },
  guardians: [{ auth: "not-for-ui" }],
  node: { channels: [{ channelId: HASH, status: "restore_recency_unproven", restoreRecencyUnproven: true, secret: "not-for-ui" }] },
});

test("recovery progress preserves restrictions across reopen and excludes private backup data", async () => {
  const { client, calls } = embeddedFixture({ "/recovery/status": recoveryFixture() });
  assert.deepEqual(await client.getRecoveryStatus(), {
    mode: "peer-storage", state: "running", importPending: false, importComplete: true,
    autoApply: { enabled: true, phase: "idle", lastReason: null },
    capsuleCount: 1, backupChannelCount: 1,
    channels: [{ channelId: HASH, status: "restore_recency_unproven", restoreRecencyUnproven: true, fundingUnidentified: false }],
  });
  assert.ok(calls.every(c => c.method === "GET"));
  const demo = await new DemoWalletClient().getRecoveryStatus();
  assert.equal(demo.state, "disabled");
  assert.equal(demo.importComplete, false);
});

test("incomplete recovery status never appears successfully restored", async () => {
  for (const bad of [null, {}, { ...recoveryFixture(), autoApply: {} },
    { ...recoveryFixture(), node: { channels: [{ channelId: "bad", status: "ready" }] } }]) {
    const { client } = embeddedFixture({ "/recovery/status": () => bad });
    await assert.rejects(client.getRecoveryStatus(), { code: "INVALID_RESPONSE" });
  }
});

test("recovery progress rejects an answer from a previously selected wallet", async () => {
  const { client } = embeddedFixture({ "/recovery/status": () => {
    client.selectWallet("another-wallet");
    return recoveryFixture();
  } });
  await assert.rejects(client.getRecoveryStatus(), { code: "WALLET_CHANGED" });
});

test("the snapshot carries how much an offline receive can take only when the engine says", async () => {
  const { client } = embeddedFixture({ "/receive/offline": { maxSats: 30000 } });
  assert.equal((await client.snapshot()).balance.offlineReceivableSats, 30000);
  const { client: none } = embeddedFixture({ "/receive/offline": { maxSats: 0 } });
  assert.equal((await none.snapshot()).balance.offlineReceivableSats, 0);
  // A host's daemon has no such route: unknown, not 0.
  const { client: host } = fixture();
  assert.equal("offlineReceivableSats" in (await host.snapshot()).balance, false);
  const { client: odd } = embeddedFixture({ "/receive/offline": { maxSats: -1 } });
  assert.equal("offlineReceivableSats" in (await odd.snapshot()).balance, false);
});

test("a host's direct-funding answer to an offline quote is refused before the review", async () => {
  const { client, calls } = fixture({
    "/api/config": { offlineReceiveAvailable: true },
    "/receive/quote": { available: true, mode: "direct-funding", peer: PK, amountSats: 10000, feeSats: 0, minAmountSat: 5000, expiresAt: NOW + 60000 },
  });
  await assert.rejects(client.quoteReceive({ amountSats: 10000, mode: "offline" }), {
    code: "RECEIVE_UNAVAILABLE",
    message: /No channel can hold an offline receive right now/,
  });
  assert.ok(!calls.some((c) => ["/receive/invoice", "/invoice/create", "/jit/invoice"].includes(c.path)));
});

test("a Lightning send checks what can be sent before asking for a route", async () => {
  // A primary that is away leaves the channel unable to send, which is not a
  // low balance and must not read as one.
  const { client: away, calls: awayCalls } = embeddedFixture({
    "/liquidity": { sendableSats: 0 },
    "/peers": [],
  });
  await assert.rejects(away.prepareSend({ request: INVOICE }), {
    code: "PRIMARY_DOWN",
    message: /primary node needs to reconnect/,
  });
  assert.ok(!awayCalls.some((c) => c.path === "/payment/estimate"));
  // Connected but short: the balance refusal, before any estimate.
  const { client: short, calls: shortCalls } = embeddedFixture({
    "/liquidity": { sendableSats: 5000 },
  });
  await assert.rejects(short.prepareSend({ request: INVOICE }), {
    code: "INSUFFICIENT_FUNDS",
  });
  assert.ok(!shortCalls.some((c) => c.path === "/payment/estimate"));
  // Enough for the amount but not the fee: refused after the estimate.
  const { client: fee } = embeddedFixture({
    "/liquidity": { sendableSats: 10003 },
  });
  await assert.rejects(fee.prepareSend({ request: INVOICE }), {
    code: "INSUFFICIENT_FUNDS",
  });
  // The engine's own reason for a missing route reaches the caller unchanged.
  const reason = Object.assign(
    new Error("No route found. The recipient is not in this wallet's map of the Lightning network."),
    { code: "NO_ROUTE" },
  );
  const { client: noRoute } = embeddedFixture({ "/payment/estimate": reason });
  await assert.rejects(noRoute.prepareSend({ request: INVOICE }), {
    code: "NO_ROUTE",
    message: /not in this wallet's map/,
  });
});

test("the Lightning fee cap never falls below the route the estimate priced", async () => {
  // The engine floors the estimate to whole sats and enforces the cap in
  // msat: a 1,024 msat route estimated as 1 sat was refused at a 1,000 msat
  // cap with "Route fee exceeds maximum". The cap now has headroom.
  const { client, calls } = embeddedFixture({
    "/payment/estimate": { estimatedFeeSats: 1 },
  });
  const review = await client.prepareSend({ request: INVOICE });
  assert.equal(review.estimatedFeeSats, 1);
  assert.equal(review.feeSats, 1 + LIGHTNING_FEE_HEADROOM_SATS);
  assert.equal(review.feeLabel, "Maximum routing fee");
  await client.send(review);
  const payment = calls.find((c) => c.path === "/invoice/pay-safe");
  assert.ok(payment.body.maxFeeSats * 1000 >= 1024, "the priced route fits under the cap");
  // Bitcoin sends carry no estimate field: their fee is the network fee.
  const onchain = await embeddedFixture().client.prepareSend({ request: ADDRESS, amountSats: 2000 });
  assert.equal("estimatedFeeSats" in onchain, false);
});
