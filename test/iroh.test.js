import test from "node:test";
import assert from "node:assert/strict";
import {
  validatePrimaryUri,
  parsePrimaryUri,
  parsePrimaryFallback,
} from "../src/index.js";
const key = "02" + "a".repeat(64);
const uri = `${key}@iroh:${"b".repeat(
  64
)}?relay=https%3A%2F%2Frelay.example%2F`;
test("Iroh QR addresses normalize and keep the relay hint", () => {
  assert.equal(validatePrimaryUri(` ${uri} `), uri);
  assert.equal(
    parsePrimaryUri(uri).transport.relayUrl,
    "https://relay.example/"
  );
  assert.equal(
    validatePrimaryUri(`${key}@iroh:${"a".repeat(52)}`),
    `${key}@iroh:${"0".repeat(64)}`
  );
  for (const bad of [
    uri + "&relay=https://other.example",
    uri.replace("https%3A%2F%2Frelay.example%2F", "file%3A%2F%2F%2Ftmp"),
    `${key}@iroh:bad`,
  ])
    assert.throws(() => validatePrimaryUri(bad), { code: "INVALID_PRIMARY" });
});
test("optional fallback requires the same node identity and a valid onion address", () => {
  const primary = parsePrimaryUri(uri);
  const fallback = `${key}@${"a".repeat(56)}.onion:9735`;
  assert.equal(parsePrimaryFallback(primary, fallback).uri, fallback);
  assert.throws(() =>
    parsePrimaryFallback(primary, fallback.replace(key, "03" + "b".repeat(64)))
  );
  assert.throws(() => parsePrimaryFallback(primary, `${key}@example.com:9735`));
  assert.equal(parsePrimaryFallback(primary, ""), undefined);
});
