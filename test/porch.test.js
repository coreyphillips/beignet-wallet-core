import test from "node:test";
import assert from "node:assert/strict";
import {
  DemoWalletClient,
  validatePrimaryUri,
  parsePrimaryUri,
  parsePrimaryFallback,
} from "../src/index.js";

const key = "02" + "a".repeat(64);
const route = "k3vq" + "a".repeat(28);
const link = `${key}@wss://relay.example/v1/p/${route}`;

test("a Porch link parses to the relay's WebSocket URL, with the route kept and no TCP address", () => {
  assert.equal(validatePrimaryUri(` ${link} `), link);
  assert.deepEqual(parsePrimaryUri(link), {
    pubkey: key,
    host: "relay.example",
    port: 0,
    transport: { type: "ws", url: `wss://relay.example/v1/p/${route}` },
    uri: link,
  });
});

test("a Porch link has one written form: lower case scheme, host and key, and no default port", () => {
  const upper = `${key.toUpperCase()}@WSS://Relay.Example:443/v1/p/${route}`;
  assert.equal(validatePrimaryUri(upper), link);
  assert.equal(
    validatePrimaryUri(`${key}@wss://relay.example:8443/v1/p/${route}`),
    `${key}@wss://relay.example:8443/v1/p/${route}`
  );
  assert.equal(
    validatePrimaryUri(`${key}@ws://127.0.0.1:80/v1/p/${route}`),
    `${key}@ws://127.0.0.1/v1/p/${route}`
  );
  assert.equal(
    parsePrimaryUri(`${key}@wss://[2001:db8::1]:2114/v1/p/${route}`).host,
    "2001:db8::1"
  );
});

test("a relay is reached without TLS only on this device or its own network", () => {
  for (const host of [
    "127.0.0.1:2114",
    "localhost:2114",
    "[::1]:2114",
    "10.0.2.2:2114",
    "192.168.1.20:2114",
    "172.16.0.5:2114",
    "172.31.255.1:2114",
  ])
    assert.equal(
      validatePrimaryUri(`${key}@ws://${host}/v1/p/${route}`),
      `${key}@ws://${host}/v1/p/${route}`
    );
  for (const host of [
    "relay.example",
    "relay.example:2114",
    "8.8.8.8:2114",
    "172.32.0.1:2114",
    "172.15.0.1:2114",
    "192.169.1.1:2114",
    "11.0.0.1",
    "127.0.0.256",
    "10.example.com",
  ])
    assert.throws(
      () => validatePrimaryUri(`${key}@ws://${host}/v1/p/${route}`),
      { code: "INVALID_PRIMARY", message: /must use wss:\/\// },
      host
    );
});

test("any other WebSocket address is refused, as is an onion relay", () => {
  for (const address of [
    "wss://relay.example",
    "wss://relay.example/",
    "wss://relay.example/v1/p/",
    `wss://relay.example/v1/p/${route.slice(1)}`,
    `wss://relay.example/v1/p/${route}a`,
    `wss://relay.example/v1/p/${route.toUpperCase()}`,
    `wss://relay.example/v1/p/${route.replace("k", "1")}`,
    `wss://relay.example/v1/p/${route}/`,
    `wss://relay.example/v1/p/${route}?token=1`,
    `wss://relay.example/v1/p/${route}#x`,
    `wss://relay.example/v2/p/${route}`,
    `wss://relay.example/v1/h/${route}`,
    `wss://user:pass@relay.example/v1/p/${route}`,
    `wss://relay.example:0/v1/p/${route}`,
    `wss://relay.example:65536/v1/p/${route}`,
    `wss://relay.example:/v1/p/${route}`,
    `wss:///v1/p/${route}`,
    `wss://relay example/v1/p/${route}`,
    `https://relay.example/v1/p/${route}`,
  ])
    assert.throws(
      () => validatePrimaryUri(`${key}@${address}`),
      { code: "INVALID_PRIMARY" },
      address
    );
  for (const scheme of ["ws", "wss"])
    assert.throws(
      () =>
        validatePrimaryUri(
          `${key}@${scheme}://${"a".repeat(56)}.onion/v1/p/${route}`
        ),
      { code: "INVALID_PRIMARY", message: /onion relay/ }
    );
});

test("a Porch primary takes no onion fallback, and a blank one means none", async () => {
  const primary = parsePrimaryUri(link);
  assert.throws(() =>
    parsePrimaryFallback(primary, `${key}@${"a".repeat(56)}.onion:9735`)
  );
  assert.equal(parsePrimaryFallback(primary, ""), undefined);
  assert.equal(parsePrimaryFallback(primary, "   "), undefined);
  const client = new DemoWalletClient();
  await assert.rejects(
    client.updatePrimary(link, `${key}@${"a".repeat(56)}.onion:9735`),
    { code: "INVALID_PRIMARY" }
  );
});

test("the preview takes a Porch link as a primary", async () => {
  const client = new DemoWalletClient();
  await client.updatePrimary(link);
  assert.equal((await client.snapshot()).primary.uri, link);
});
