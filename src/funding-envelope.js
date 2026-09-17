/**
 * The direct-funding payment request a beignet wallet puts in a BIP21 URI as
 * `bgnq` (envelope v3, the layout the engine freezes in
 * src/lightning/direct-funding/envelope.ts):
 *
 *   0   u8   version (3)
 *   1   16   request_id
 *   17  32   chain_hash
 *   49  33   receiver_node_id
 *   82  u48  expires_at (milliseconds since epoch)
 *   88  u8   flags (bit 0: amount_sat present)
 *   89  u64  amount_sat, when bit 0 is set
 *   +0  32   receipt_hash
 *   +32 33   encryption_key
 *   +65 u8   num_transports, then length-prefixed descriptors
 *   tail 65  signature
 *
 * Only the first seven fields are read here, and only to SHOW the payer who
 * is asking, for how much, and until when, before the daemon is involved.
 * Nothing about paying turns on this reading: the daemon decodes the whole
 * envelope again, verifies the signature against the receiver node id, and
 * refuses a foreign chain, so a request this decoder gets wrong is one the
 * daemon refuses rather than one that pays the wrong thing. That is also why
 * a reading failure is a null and never a throw.
 */

const VERSION = 3;
const HEADER_BYTES = 89;
const AMOUNT_BYTES = 8;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

// BOLT chain_hash values (genesis hashes in internal byte order), the same
// table the engine's channel and watchtower code carries.
const CHAIN_HASHES = {
	'6fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000': 'mainnet',
	'43497fd7f826957108f4a30fd9cec3aeba79972084e90ead01ea330900000000': 'testnet',
	'06226e46111a0b59caaf126043eb5bbf28c34f3a5e332a1fc7b2b73cf188910f': 'regtest'
};

function toHex(bytes) {
	let out = '';
	for (const b of bytes) out += b.toString(16).padStart(2, '0');
	return out;
}

function fromHex(hex) {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

/** Unpadded base64url to bytes, or null when the string is not canonical. */
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function base64urlDecode(text) {
  if (typeof text !== 'string' || !text || !BASE64URL.test(text) || text.length % 4 === 1) return null;
  const bytes = []; let value = 0; let bits = 0;
  for (const char of text) {
    value = (value << 6) | BASE64_ALPHABET.indexOf(char); bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((value >> bits) & 255); }
  }
  const result = new Uint8Array(bytes);
  return base64urlEncode(result) === text ? result : null;
}
export function base64urlEncode(bytes) {
  let result = ''; let value = 0; let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 6) { bits -= 6; result += BASE64_ALPHABET[(value >> bits) & 63]; }
  }
  if (bits) result += BASE64_ALPHABET[(value << (6 - bits)) & 63];
  return result;
}

/**
 * What a payment request says about itself, or null when the string is not a
 * v3 envelope this decoder can read.
 *
 * Returns { version, requestId, chainHash, network, nodeId, expiresAt, amountSats }:
 * `network` is the chain the request binds to (null for an unknown chain),
 * `expiresAt` is milliseconds since the epoch, `amountSats` is null when the
 * receiver left the amount to the payer.
 */
export function decodeFundingEnvelope(text) {
	const bytes = base64urlDecode(text);
	if (!bytes || bytes.length < HEADER_BYTES) return null;
	if (bytes[0] !== VERSION) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const flags = bytes[88];
	const hasAmount = (flags & 1) === 1;
	if (hasAmount && bytes.length < HEADER_BYTES + AMOUNT_BYTES) return null;
	const expiresAt = view.getUint16(82) * 2 ** 32 + view.getUint32(84);
	let amountSats = null;
	if (hasAmount) {
		const amount = (BigInt(view.getUint32(89)) << 32n) | BigInt(view.getUint32(93));
		if (amount > BigInt(Number.MAX_SAFE_INTEGER)) return null;
		amountSats = Number(amount);
	}
	const chainHash = toHex(bytes.subarray(17, 49));
	return {
		version: VERSION,
		requestId: toHex(bytes.subarray(1, 17)),
		chainHash,
		network: CHAIN_HASHES[chainHash] || null,
		nodeId: toHex(bytes.subarray(49, 82)),
		expiresAt,
		amountSats
	};
}

/** The chain_hash the engine writes for a network, or null for one it has no name for. */
export function chainHashFor(network) {
	const hit = Object.entries(CHAIN_HASHES).find(([, name]) => name === network);
	return hit ? hit[0] : null;
}

/**
 * A structurally valid v3 envelope for tests and the demo. The signature and
 * the encryption key are filler: nothing that reads an envelope outside the
 * daemon verifies them, and the daemon is not in the loop for either use.
 */
export function encodeFundingEnvelope({
	nodeId,
	expiresAt,
	amountSats = null,
	network = 'mainnet',
	requestId,
	transports = []
} = {}) {
	const id = requestId ? fromHex(requestId) : new Uint8Array(16).map((_, i) => (i * 37 + 11) & 0xff);
	const chain = fromHex(chainHashFor(network) || chainHashFor('mainnet'));
	const node = fromHex(nodeId);
	const hasAmount = amountSats != null;
	const descriptors = transports.map((t) => {
		const host = new TextEncoder().encode(t.host);
		const body = new Uint8Array(1 + host.length + 2);
		body[0] = host.length;
		body.set(host, 1);
		body[1 + host.length] = (t.port >> 8) & 0xff;
		body[2 + host.length] = t.port & 0xff;
		// type 1 (direct peer), then a u16 length, then the body.
		const out = new Uint8Array(3 + body.length);
		out[0] = 1;
		out[1] = (body.length >> 8) & 0xff;
		out[2] = body.length & 0xff;
		out.set(body, 3);
		return out;
	});
	const descriptorBytes = descriptors.reduce((n, d) => n + d.length, 0);
	const total = HEADER_BYTES + (hasAmount ? AMOUNT_BYTES : 0) + 32 + 33 + 1 + descriptorBytes + 65;
	const bytes = new Uint8Array(total);
	const view = new DataView(bytes.buffer);
	bytes[0] = VERSION;
	bytes.set(id, 1);
	bytes.set(chain, 17);
	bytes.set(node, 49);
	view.setUint16(82, Math.floor(expiresAt / 2 ** 32));
	view.setUint32(84, expiresAt % 2 ** 32);
	bytes[88] = hasAmount ? 1 : 0;
	let at = HEADER_BYTES;
	if (hasAmount) {
		view.setBigUint64(at, BigInt(amountSats));
		at += AMOUNT_BYTES;
	}
	for (let i = 0; i < 32; i++) bytes[at + i] = (i * 53 + 7) & 0xff; // receipt hash
	at += 32;
	bytes[at] = 0x02;
	for (let i = 1; i < 33; i++) bytes[at + i] = (i * 29 + 3) & 0xff; // encryption key
	at += 33;
	bytes[at++] = descriptors.length;
	for (const d of descriptors) {
		bytes.set(d, at);
		at += d.length;
	}
	for (let i = 0; i < 65; i++) bytes[at + i] = (i * 17 + 1) & 0xff; // signature
	return base64urlEncode(bytes);
}
