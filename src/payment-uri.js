/**
 * Payment strings: reading what someone hands you, and writing what you hand out.
 *
 * A wallet is given payment strings by people, not by programs: pasted out of a
 * chat window, scanned off a screen, typed from a phone. This file turns any of
 * them into one answer to one question, "what is this, and what is it asking
 * for", and refuses cleanly when the answer is "nothing you can pay".
 *
 * Two rules run through all of it.
 *
 * The parser routes; the daemon decides. Nothing here is an authorization to
 * pay. It works out which rail a string belongs on and pulls the fields off it
 * so the form can be filled in, and it will refuse a string it can prove is not
 * payable. Whether an invoice's signature is good, whether a route exists,
 * whether an address is one this wallet can actually spend to: those belong to
 * the daemon, which is the only thing here that knows.
 *
 * Money is never parsed as a float. BIP21 amounts are decimal BTC, and
 * Number('4.35') * 1e8 is 434999999.99999994, so a rounding choice decides
 * whether the payee is short a satoshi. The conversion is done on the digits
 * with BigInt, and only crosses to a JS number at the boundary, where the
 * largest amount that can exist (2.1e15 sats) is still an exact integer.
 */

import { decodeFundingEnvelope } from './funding-envelope.js';

// The most satoshis that can ever exist. Anything above it is a typo or a
// hostile string, never a payment.
const MAX_MONEY_SATS = 2100000000000000n;

// BIP21 amounts are decimal BTC and nothing else. Exponent form, a leading
// sign, a thousands separator and a stray unit are all outside the grammar,
// and Number() would quietly accept every one of them.
const BTC_DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

// A paste is a person's clipboard, not a payload. Cap it before any regex sees
// it, so a pathological string costs a length check and nothing more.
const MAX_INPUT = 8192;

// Zero width joiners, byte order marks, non-breaking spaces and line
// separators. All of them ride along with copied text, and none of them are
// visible in the field they land in.
const INVISIBLE = /[\u00a0\u1680\u2000-\u200d\u2028\u2029\u202f\u205f\u3000\ufeff]/g;

// Marks that reorder text on screen, so what is shown and what would be paid
// are two different strings.
const BIDI_CONTROL = /[\u202a-\u202e\u2066-\u2069]/;

/** Human sentences for the refusals that do not carry their own. */
const MESSAGES = {
	INPUT_TOO_LONG: 'That is too long to be a payment request.',
	BIDI_CONTROL:
		'This text contains characters that reorder what you see, so the address on screen may not be the address you would pay. Retype it or copy it again from the source.',
	AMOUNT_EMPTY: 'This payment request has an empty amount.',
	AMOUNT_NOT_DECIMAL:
		'The amount in this payment request is not a plain decimal number of bitcoin, so it cannot be read safely. Enter the amount yourself.',
	AMOUNT_SUB_SATOSHI:
		'The amount in this payment request is smaller than one satoshi, which cannot be paid on-chain.',
	AMOUNT_OVER_MAX_MONEY: 'The amount in this payment request is larger than every bitcoin that will ever exist.',
	BIP21_NO_PAYABLE_TARGET: 'This payment request has nothing in it to pay.',
	DUPLICATE_AMOUNT:
		'This payment request names two different amounts. Ask for a new one rather than guessing which is meant.',
	MALFORMED_PERCENT_ENCODING:
		'This payment request is damaged: part of it is not valid text. Copy it again from the source.',
	AMOUNT_CONFLICT:
		'The on-chain amount and the Lightning invoice in this request disagree. Ask for a new one.',
	BASE58_CASE_DESTROYED:
		'This address arrived in capitals. Capitalisation is part of an address of this kind, so it cannot be recovered. Ask for it again.',
	B32_MIXED_CASE:
		'This address mixes upper and lower case, which a valid one never does. Copy it again from the source.',
	B32_CHECKSUM:
		'This address fails its own checksum, so it is mistyped or was cut short. Check the last few characters.',
	B32_LENGTH: 'This is too short to be an address.',
	B32_SEPARATOR: 'This is not a valid address.',
	B32_BAD_CHAR: 'This address contains a character no address can contain.',
	B32_CHAR_RANGE: 'This address contains a character no address can contain.',
	ADDR_UNKNOWN_HRP: 'This is not a bitcoin address.',
	ADDR_EMPTY_PROGRAM: 'This is not a valid address.',
	ADDR_BAD_WITNESS_VERSION: 'This is not a valid address.',
	ADDR_BAD_PADDING: 'This address fails its own checks, so it is mistyped or was cut short.',
	ADDR_PROGRAM_LENGTH: 'This address is the wrong length.',
	ADDR_V0_LENGTH: 'This address is the wrong length.',
	ADDR_V0_NEEDS_BECH32: 'This address uses the wrong checksum for its type, so it is mistyped.',
	ADDR_V1_NEEDS_BECH32M: 'This address uses the wrong checksum for its type, so it is mistyped.',
	NOT_PAYABLE: 'This does not look like an address, an invoice or an offer.',
	NON_ASCII: 'This contains characters an address cannot contain. Copy it again from the source.',
	BOLT11_MIXED_CASE:
		'This invoice mixes upper and lower case, which a valid one never does. Copy it again from the source.',
	BOLT11_NO_SEPARATOR: 'This is not a complete Lightning invoice.',
	BOLT11_UNKNOWN_PREFIX: 'This is not a Lightning invoice this wallet can read.',
	BOLT11_BAD_AMOUNT: 'The amount in this Lightning invoice cannot be read.',
	BOLT11_SUB_MSAT: 'This Lightning invoice asks for less than a millisatoshi, which cannot be paid.',
	BOLT11_CHECKSUM:
		'This invoice fails its own checksum, so it is incomplete or was mistyped. Copy the whole of it again.',
	BOLT11_TRUNCATED:
		'This invoice is too short to be a whole one, so the end of it is missing. Copy the whole of it again.',
	LNURL_UNSUPPORTED: 'That is an LNURL. This wallet pays invoices and offers, not LNURL.',
	BOLT12_REQUEST_UNSUPPORTED:
		'That is a BOLT12 invoice request, not something you can pay. Ask for an offer (it starts with lno1) instead.',
	LIGHTNING_ADDRESS_UNSUPPORTED:
		'That is a Lightning address. This wallet pays invoices and offers, so ask the recipient for one.',
	SILENT_PAYMENT_UNSUPPORTED: 'That is a silent payment address, which this wallet cannot pay yet.',
	EXTENDED_KEY:
		'That is an extended public key, which is a whole wallet rather than an address. Ask for a single address to pay.',
	PRIVATE_KEY:
		'That looks like a private key. Never paste a private key into a send box, and treat any coins it holds as spent.',
	DESCRIPTOR: 'That is an output descriptor, not an address.',
	NOSTR_KEY: 'That is a nostr key, not a bitcoin address.'
};

const WARNINGS = {
	NONSTANDARD_SLASHES: 'This request was written with slashes after the scheme, which is not the usual form. It was read anyway.',
	FRAGMENT_STRIPPED: 'Everything after the # in this request was ignored, as it is not part of a payment.',
	DUPLICATE_PARAM: 'This request names the same field twice. The first one was used.',
	TEXT_PARAM_TRUNCATED:
		'Part of the message in this request could not be read, most likely an unescaped & in it, so the message may be cut short.',
	LN_PAYLOAD_UNPARSEABLE:
		'This request also carried a Lightning invoice, but it could not be read. The on-chain details were used.',
	CASE_FOLDED_FROM_QR: 'This arrived in capitals, as QR codes often are. It was converted back to lower case.',
	PUNCTUATION_STRIPPED: 'Punctuation around it was dropped, as it is not part of the address.',
	WHITESPACE_REPAIRED: 'Line breaks inside this were removed, as they are not part of it.',
	AMOUNT_ZERO: 'This request asks for an amount of zero, which means the payer chooses. No amount was filled in.',
	FUNDING_UNREADABLE:
		'This request carries a direct-funding request this wallet cannot read, so it will be paid as an ordinary transaction.',
	FUNDING_EXPIRED:
		'The direct-funding request this carries has expired, so it will be paid as an ordinary transaction. The address is still good.',
	FUNDING_WRONG_CHAIN:
		'The direct-funding request this carries is for a different network, so it will be paid as an ordinary transaction.'
};

/* ------------------------------------------------------------------ money */

/**
 * A decimal BTC string to an integer number of satoshis.
 *
 * Digits only, assembled with BigInt: nothing here can round. Fractional digits
 * past the eighth are refused rather than rounded away, since a request for
 * 0.000000001 BTC is a request that cannot be paid, and quietly turning it into
 * zero or one satoshi is worse than saying so.
 */
export function btcStringToSats(input) {
	if (typeof input !== 'string') return { ok: false, code: 'AMOUNT_NOT_DECIMAL' };
	const s = input.trim();
	if (s === '') return { ok: false, code: 'AMOUNT_EMPTY' };
	if (!BTC_DECIMAL.test(s)) return { ok: false, code: 'AMOUNT_NOT_DECIMAL' };
	const dot = s.indexOf('.');
	const whole = dot === -1 ? s : s.slice(0, dot);
	const fracRaw = dot === -1 ? '' : s.slice(dot + 1);
	for (let i = 8; i < fracRaw.length; i++) {
		if (fracRaw[i] !== '0') return { ok: false, code: 'AMOUNT_SUB_SATOSHI' };
	}
	const frac = (fracRaw + '00000000').slice(0, 8);
	const sats = BigInt((whole === '' ? '0' : whole) + frac);
	if (sats > MAX_MONEY_SATS) return { ok: false, code: 'AMOUNT_OVER_MAX_MONEY' };
	// Safe to narrow: MAX_MONEY in satoshis is well inside Number's exact range,
	// and every consumer of this (the amount field, /send, /tx/quote) is a number.
	return { ok: true, sats: Number(sats) };
}

/**
 * An integer number of satoshis to the decimal BTC string BIP21 wants.
 *
 * Written by slicing the digits rather than dividing, so no value can come back
 * in exponent form ("1e-8" for a single satoshi) or a rounding artefact.
 */
export function satsToBtcString(sats) {
	const n = typeof sats === 'bigint' ? sats : BigInt(Math.round(Number(sats) || 0));
	const neg = n < 0n;
	const digits = (neg ? -n : n).toString().padStart(9, '0');
	const whole = digits.slice(0, -8);
	const frac = digits.slice(-8).replace(/0+$/, '');
	return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/* ----------------------------------------------------------------- bech32 */

const B32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const B32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32M_CONST = 0x2bc830a3;

function bech32Polymod(values) {
	let chk = 1;
	for (const v of values) {
		const top = chk >> 25;
		chk = ((chk & 0x1ffffff) << 5) ^ v;
		for (let i = 0; i < 5; i++) {
			if ((top >> i) & 1) chk ^= B32_GENERATOR[i];
		}
	}
	return chk >>> 0;
}

function hrpExpand(hrp) {
	const out = [];
	for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
	out.push(0);
	for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
	return out;
}

/**
 * Decode a bech32 or bech32m string, checksum and all.
 *
 * `maxLength` is a parameter because the 90-character cap belongs to addresses
 * alone: a Lightning invoice carrying route hints runs past 700 characters and
 * is not malformed for it.
 */
export function bech32Decode(str, { maxLength = 90 } = {}) {
	if (typeof str !== 'string') return { ok: false, code: 'B32_LENGTH' };
	if (str.length < 8 || str.length > maxLength) return { ok: false, code: 'B32_LENGTH' };
	const hasLower = /[a-z]/.test(str);
	const hasUpper = /[A-Z]/.test(str);
	// A bech32 string is all one case. Mixed case is not a case to fold, it is
	// evidence the string has been through something that damaged it.
	if (hasLower && hasUpper) return { ok: false, code: 'B32_MIXED_CASE' };
	const s = str.toLowerCase();
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 33 || c > 126) return { ok: false, code: 'B32_CHAR_RANGE' };
	}
	// The separator is the LAST '1', not the first: '1' is not in the data
	// charset, so anything before the final one belongs to the prefix.
	const sep = s.lastIndexOf('1');
	if (sep < 1 || sep + 7 > s.length) return { ok: false, code: 'B32_SEPARATOR' };
	const hrp = s.slice(0, sep);
	const data = [];
	for (const ch of s.slice(sep + 1)) {
		const v = B32_CHARSET.indexOf(ch);
		if (v === -1) return { ok: false, code: 'B32_BAD_CHAR' };
		data.push(v);
	}
	const chk = bech32Polymod(hrpExpand(hrp).concat(data));
	const encoding = chk === 1 ? 'bech32' : chk === BECH32M_CONST ? 'bech32m' : null;
	if (!encoding) return { ok: false, code: 'B32_CHECKSUM' };
	return { ok: true, hrp, data: data.slice(0, -6), encoding };
}

/** The inverse, for anything that needs to hand out a well formed string. */
export function bech32Encode(hrp, data, encoding = 'bech32') {
	const constant = encoding === 'bech32m' ? BECH32M_CONST : 1;
	const polymod = bech32Polymod(hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0])) ^ constant;
	const checksum = [];
	for (let i = 0; i < 6; i++) checksum.push((polymod >> (5 * (5 - i))) & 31);
	return `${hrp}1${data.concat(checksum).map((v) => B32_CHARSET[v]).join('')}`;
}

/** Regroup bits, the 8-to-5 direction being what an address body needs. */
export function convertBits(data, from, to, pad) {
	let acc = 0;
	let bits = 0;
	const out = [];
	const maxv = (1 << to) - 1;
	for (const value of data) {
		if (value < 0 || value >> from !== 0) return null;
		acc = (acc << from) | value;
		bits += from;
		while (bits >= to) {
			bits -= to;
			out.push((acc >> bits) & maxv);
		}
	}
	if (pad) {
		if (bits > 0) out.push((acc << (to - bits)) & maxv);
	} else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
		return null;
	}
	return out;
}

/* ---------------------------------------------------------------- addresses */

// Which chains a prefix belongs to. `tb` is a family rather than one chain
// (testnet, signet, testnet4); the manager only ever runs testnet of those, so
// that is what it maps to, and the same is true of the base58 forms, which
// testnet and regtest share outright.
const SEGWIT_HRP = { bc: ['mainnet'], tb: ['testnet'], bcrt: ['regtest'] };
const BASE58_ADDRESS = /^[123mn][a-km-zA-HJ-NP-Z1-9]{24,38}$/;

const NETWORK_LABEL = { mainnet: 'mainnet', testnet: 'testnet', regtest: 'regtest' };

function witnessLabel(version, programLength) {
	if (version === 0) return programLength === 20 ? 'SegWit' : 'SegWit script';
	if (version === 1 && programLength === 32) return 'Taproot';
	return `witness v${version}`;
}

/**
 * What kind of address is this, and which chain is it for.
 *
 * bech32 addresses are checked to the checksum, which is the whole point of
 * having one: a truncated or mistyped address is caught here rather than
 * discovered by the daemon after a round trip. Base58 addresses are checked for
 * shape only. Their checksum is a double SHA-256, which the browser only offers
 * asynchronously, and this has to answer on a keystroke; the daemon verifies it
 * before anything is broadcast.
 */
export function classifyAddress(address) {
	if (typeof address !== 'string' || address === '') return { ok: false, code: 'NOT_PAYABLE' };
	// eslint-disable-next-line no-control-regex
	if (/[^\x20-\x7e]/.test(address)) return { ok: false, code: 'NON_ASCII' };
	const lower = address.toLowerCase();
	if (Object.keys(SEGWIT_HRP).some((p) => lower.startsWith(`${p}1`))) {
		const decoded = bech32Decode(address, { maxLength: 90 });
		if (!decoded.ok) return decoded;
		// The chain comes from the decoded prefix, never from the leading
		// characters. They are not the same thing: the separator is the LAST '1',
		// so a string like `bc1q1…` starts with `bc1` while its actual prefix is
		// `bc1q`, which is no chain at all. Reading the chain off the front and
		// the address off the back would let such a string through as a payable
		// mainnet address.
		const networks = SEGWIT_HRP[decoded.hrp];
		if (!networks) return { ok: false, code: 'ADDR_UNKNOWN_HRP' };
		if (decoded.data.length === 0) return { ok: false, code: 'ADDR_EMPTY_PROGRAM' };
		const version = decoded.data[0];
		if (version > 16) return { ok: false, code: 'ADDR_BAD_WITNESS_VERSION' };
		const program = convertBits(decoded.data.slice(1), 5, 8, false);
		if (!program) return { ok: false, code: 'ADDR_BAD_PADDING' };
		if (program.length < 2 || program.length > 40) return { ok: false, code: 'ADDR_PROGRAM_LENGTH' };
		if (version === 0 && program.length !== 20 && program.length !== 32) {
			return { ok: false, code: 'ADDR_V0_LENGTH' };
		}
		if (version === 0 && decoded.encoding !== 'bech32') return { ok: false, code: 'ADDR_V0_NEEDS_BECH32' };
		if (version !== 0 && decoded.encoding !== 'bech32m') return { ok: false, code: 'ADDR_V1_NEEDS_BECH32M' };
		return {
			ok: true,
			// Lower case is the canonical form. An address that arrived in capitals
			// off a QR code is the same address, and every consumer of this expects
			// the canonical one.
			address: lower,
			networks,
			type: witnessLabel(version, program.length),
			// A witness version this wallet has never heard of is still a valid
			// address someone can be paid at. Flag it rather than refuse it.
			forwardCompatible: version > 1
		};
	}
	if (BASE58_ADDRESS.test(address)) {
		const legacy = address[0] === '1' || address[0] === 'm' || address[0] === 'n';
		return {
			ok: true,
			address,
			// Testnet and regtest share base58 prefixes outright, so this is as far
			// as the string itself can narrow it.
			networks: address[0] === '1' || address[0] === '3' ? ['mainnet'] : ['testnet', 'regtest'],
			type: legacy ? 'Legacy' : 'P2SH',
			forwardCompatible: false
		};
	}
	if (/^[13][A-Z0-9]{24,38}$/.test(address)) return { ok: false, code: 'BASE58_CASE_DESTROYED' };
	return { ok: false, code: 'NOT_PAYABLE' };
}

/* ------------------------------------------------------------------ BOLT11 */

// Longest first: lnbc is a prefix of lnbcrt, and lntb of lntbs.
const BOLT11_PREFIXES = [
	['lnbcrt', 'regtest'],
	['lntbs', 'signet'],
	['lnbc', 'mainnet'],
	['lntb', 'testnet']
];
const MSAT_PER_BTC = 100000000000n;
const MULTIPLIER = { '': 1n, m: 1000n, u: 1000000n, n: 1000000000n, p: 1000000000000n };

// The two fields BOLT11 requires of every invoice, in bech32 characters: a
// 35-bit timestamp at the front and a 520-bit signature at the back, five bits
// to the character. Everything between them is optional, so this is the floor.
const BOLT11_MIN_DATA = 35 / 5 + 520 / 5;

/**
 * Read the human readable part of a BOLT11 invoice: which chain it is for, and
 * how much it asks for.
 *
 * This is the part of an invoice that can be trusted without the daemon,
 * because it is plain text rather than encoded data. Everything past the
 * separator (the payee, the description, the expiry, the route hints, and
 * whether the signature is any good) is the daemon's to decode.
 */
export function parseBolt11Hrp(invoice) {
	if (typeof invoice !== 'string') return { ok: false, code: 'BOLT11_NO_SEPARATOR' };
	const hasLower = /[a-z]/.test(invoice);
	const hasUpper = /[A-Z]/.test(invoice);
	if (hasLower && hasUpper) return { ok: false, code: 'BOLT11_MIXED_CASE' };
	const s = invoice.toLowerCase();
	const sep = s.lastIndexOf('1');
	if (sep < 1 || sep + 7 > s.length) return { ok: false, code: 'BOLT11_NO_SEPARATOR' };
	const hrp = s.slice(0, sep);
	const hit = BOLT11_PREFIXES.find(([prefix]) => hrp.startsWith(prefix));
	if (!hit) return { ok: false, code: 'BOLT11_UNKNOWN_PREFIX' };
	const [prefix, network] = hit;
	const rest = hrp.slice(prefix.length);
	// No amount in the prefix means "any amount", which is not the same as zero.
	if (rest === '') return { ok: true, network, amountMsat: null };
	const m = /^(\d+)([munp]?)$/.exec(rest);
	if (!m) return { ok: false, code: 'BOLT11_BAD_AMOUNT' };
	const scaled = BigInt(m[1]) * MSAT_PER_BTC;
	const divisor = MULTIPLIER[m[2]];
	// The pico multiplier can express a tenth of a millisatoshi, which is not an
	// amount anything can pay.
	if (scaled % divisor !== 0n) return { ok: false, code: 'BOLT11_SUB_MSAT' };
	return { ok: true, network, amountMsat: scaled / divisor };
}

/* ------------------------------------------------------------------ BIP21 */

/**
 * Write a BIP21 payment request.
 *
 * With nothing attached this is just the address, which is what should be shown
 * and shared when nothing is being asked for: a bare address is understood by
 * every wallet and every exchange, and a URI is not.
 *
 * With an address, an amount, a label and a message, the parameter order and the
 * omissions match what the daemon's own encoder produces, so such a request is
 * indistinguishable from one written by `beignet address --bip21`.
 *
 * `lightning` goes beyond the daemon's encoder, which has no such parameter. It
 * is the one form of request a payer can settle on either rail: the address is
 * there for a wallet that only reads BIP21, the invoice for one that prefers
 * Lightning, and neither has to be handed out separately. BTCPay and Phoenix
 * emit these, `parsePayment` reads them, and until now nothing here could write
 * one. It is written last so a request without it is byte-identical to before,
 * and unescaped because bech32 is alphanumeric throughout, which is also what
 * keeps a QR of it in the alphanumeric mode.
 */
export function buildBip21({ address, amountSats, label, message, lightning, funding } = {}) {
	if (!address) return '';
	const params = [];
	// The same ceiling btcStringToSats enforces on the way in. Without it the two
	// halves of this file disagree about what an amount is, and a request written
	// here comes back AMOUNT_OVER_MAX_MONEY when read here.
	const sats = Math.min(Math.floor(Number(amountSats) || 0), Number(MAX_MONEY_SATS));
	// An amount of zero is not an amount. Emitting `amount=0` would tell the
	// payer's wallet to send nothing, which no one means by leaving it blank.
	if (sats > 0) params.push(`amount=${satsToBtcString(sats)}`);
	// A field holding nothing but spaces is a field nobody filled in.
	const trimmedLabel = String(label ?? '').trim();
	const trimmedMessage = String(message ?? '').trim();
	if (trimmedLabel) params.push(`label=${encodeURIComponent(trimmedLabel)}`);
	if (trimmedMessage) params.push(`message=${encodeURIComponent(trimmedMessage)}`);
	const trimmedLightning = String(lightning ?? '').trim();
	if (trimmedLightning) params.push(`lightning=${trimmedLightning}`);
	// A direct-funding request (beignet envelope v3, BIP21 parameter bgnq): a
	// beignet payer's on-chain payment becomes this wallet's channel funding.
	// Base64url throughout, so it needs no escaping either; anything else is
	// not an envelope and is left out rather than handed to payers.
	const trimmedFunding = String(funding ?? '').trim();
	if (trimmedFunding && /^[A-Za-z0-9_-]+$/.test(trimmedFunding)) params.push(`bgnq=${trimmedFunding}`);
	return params.length ? `bitcoin:${address}?${params.join('&')}` : address;
}

/* ------------------------------------------------------------------ parse */

const KNOWN_PARAMS = new Set(['amount', 'label', 'message', 'lightning', 'bgnq']);
const TRAILING_PUNCTUATION = /[.,;:!?)'"\]}»›>]+$/;
const WRAPPERS = [
	['<', '>'],
	['"', '"'],
	["'", "'"],
	['(', ')'],
	['[', ']'],
	['«', '»'],
	['“', '”'],
	['‘', '’']
];

function refuse(code, message) {
	return { kind: 'invalid', code, message: message || MESSAGES[code] || MESSAGES.NOT_PAYABLE };
}

function warn(warnings, code, message) {
	warnings.push({ code, message: message || WARNINGS[code] });
	return warnings;
}

/** Characters that ride along with copied text and are invisible in a field. */
function stripInvisibles(text) {
	return text.replace(INVISIBLE, ' ').trim();
}

/**
 * Nothing payable contains whitespace, so inside a token it is damage, usually
 * a mail client wrapping a long line.
 *
 * Only joined back up where a checksum can confirm the repair was right, which
 * is every bech32 string and therefore every invoice, offer and modern address.
 * A base58 address has no checksum this can check, so a guess at where it broke
 * would be a guess about where money goes, and it is left alone to be refused.
 */
function squeeze(token, warnings) {
	if (!/^(ln|bc1|tb1|bcrt1)/i.test(token)) return token;
	const tight = token.replace(/\s+/g, '');
	if (tight !== token) warn(warnings, 'WHITESPACE_REPAIRED');
	return tight;
}

function schemeOf(text) {
	const colon = text.indexOf(':');
	if (colon < 1) return null;
	const scheme = text.slice(0, colon).toLowerCase();
	return scheme === 'bitcoin' || scheme === 'lightning' ? scheme : null;
}

/**
 * A string that begins `ln`: an invoice, an offer, or one of the several other
 * things that share those two letters and are not payable here.
 */
function parseLightning(token, warnings, opts) {
	const tight = squeeze(token, warnings);
	const lower = tight.toLowerCase();
	if (lower.startsWith('lnurl1')) return refuse('LNURL_UNSUPPORTED');
	if (lower.startsWith('lnr1') || lower.startsWith('lni1')) return refuse('BOLT12_REQUEST_UNSUPPORTED');
	if (lower.startsWith('lno1')) {
		// An offer carries no checksum and does not name its chain in the string
		// itself, so there is nothing here to verify. The daemon reads it.
		if (tight !== lower) warn(warnings, 'CASE_FOLDED_FROM_QR');
		return { kind: 'bolt12', offer: lower, warnings };
	}
	const hrp = parseBolt11Hrp(tight);
	if (!hrp.ok) return refuse(hrp.code);
	// An invoice is bech32, so it carries a checksum, and a truncated or mistyped
	// one can be caught here rather than by a round trip to the daemon. The
	// 90-character cap does not apply: an invoice with route hints in it runs
	// past 700 and is not malformed for that.
	const checksum = bech32Decode(tight, { maxLength: MAX_INPUT });
	if (!checksum.ok || checksum.encoding !== 'bech32') return refuse('BOLT11_CHECKSUM');
	// A checksum alone does not make an invoice. BOLT11's data part is a 35-bit
	// timestamp and a 520-bit signature with the tagged fields between them, so a
	// string shorter than the two of them together has had the end cut off, and a
	// truncation that lands on a valid checksum is exactly the case the checksum
	// cannot catch. The specification's own "String is too short" vector is one:
	// 103 characters of data where 111 is the floor.
	if (checksum.data.length < BOLT11_MIN_DATA) return refuse('BOLT11_TRUNCATED');
	if (tight !== tight.toLowerCase()) warn(warnings, 'CASE_FOLDED_FROM_QR');
	const invoice = tight.toLowerCase();
	const wanted = opts.network;
	if (wanted && hrp.network !== wanted) {
		return refuse(
			'WRONG_NETWORK',
			`This invoice is for ${NETWORK_LABEL[hrp.network] || hrp.network}, and this wallet is on ${wanted}. It cannot be paid from here.`
		);
	}
	if (hrp.amountMsat != null && hrp.amountMsat % 1000n !== 0n) return refuse('FRACTIONAL_SAT_INVOICE', 'This wallet displays whole sats. Ask for an invoice with a whole-satoshi amount.');
	if (hrp.amountMsat != null && hrp.amountMsat / 1000n > MAX_MONEY_SATS) return refuse('AMOUNT_OVER_MAX_MONEY');
	return {
		kind: 'bolt11',
		invoice,
		network: hrp.network,
		amountSats: hrp.amountMsat == null ? null : Number(hrp.amountMsat / 1000n),
		warnings
	};
}

/** A bare address, with the well known things that are not one named as such. */
function parseAddress(token, warnings, opts) {
	const tight = squeeze(token, warnings);
	const lower = tight.toLowerCase();
	if (/^(x|y|z|v|t|u)pub[1-9a-km-zA-HJ-NP-Z]{20,}$/.test(tight)) return refuse('EXTENDED_KEY');
	if (/^(wpkh|pkh|sh|tr|wsh|combo|addr|raw)\(/.test(lower)) return refuse('DESCRIPTOR');
	if (/^(5[HJK]|[KL][1-9A-HJ-NP-Za-km-z]|c[1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{48,50}$/.test(tight)) {
		return refuse('PRIVATE_KEY');
	}
	if (lower.startsWith('npub1')) return refuse('NOSTR_KEY');
	if (lower.startsWith('sp1') || lower.startsWith('tsp1')) return refuse('SILENT_PAYMENT_UNSUPPORTED');
	if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(tight)) return refuse('LIGHTNING_ADDRESS_UNSUPPORTED');

	const classified = classifyAddress(tight);
	if (!classified.ok) return refuse(classified.code);
	if (tight !== classified.address) warn(warnings, 'CASE_FOLDED_FROM_QR');
	const wanted = opts.network;
	if (wanted && !classified.networks.includes(wanted)) {
		const theirs = classified.networks.map((n) => NETWORK_LABEL[n] || n).join(' or ');
		return refuse(
			'WRONG_NETWORK',
			`That is a ${theirs} address, and this wallet is on ${wanted}. Paying it would send the coins nowhere they can be spent.`
		);
	}
	return {
		kind: 'onchain',
		isRequest: false,
		address: classified.address,
		addressType: classified.type,
		forwardCompatible: classified.forwardCompatible,
		networks: classified.networks,
		amountSats: null,
		label: '',
		message: '',
		lightning: null,
		funding: null,
		warnings
	};
}

/** `bitcoin:<address>?amount=&label=&message=&lightning=` */
function parseBip21(text, warnings, opts) {
	let body = text.slice(text.indexOf(':') + 1);
	if (body.startsWith('//')) {
		body = body.slice(2);
		warn(warnings, 'NONSTANDARD_SLASHES');
	}
	const hash = body.indexOf('#');
	if (hash !== -1) {
		body = body.slice(0, hash);
		warn(warnings, 'FRAGMENT_STRIPPED');
	}
	// The first question mark opens the query, and every one after it belongs to
	// whatever field it lands in. BIP21 builds label and message out of RFC 3986
	// query characters less '=' and '&', and '?' is one of them, so "Lunch?" is
	// an ordinary thing for a payee to write and nothing has to escape it. The
	// splits below do the separating: '&' between fields, the first '=' within
	// one, which leaves a stray '?' inside an amount to be refused by the amount
	// itself rather than by the shape of the string.
	const mark = body.indexOf('?');
	const addressPart = mark === -1 ? body : body.slice(0, mark);
	const query = mark === -1 ? '' : body.slice(mark + 1);

	const params = new Map();
	// The repeats themselves, not just which keys repeated: whether two amounts
	// are a contradiction or one clumsy encoder writing the same figure twice
	// cannot be answered without them.
	const duplicated = new Map();
	for (const pair of query.split('&')) {
		if (!pair) continue;
		const eq = pair.indexOf('=');
		let key;
		let value;
		try {
			key = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq));
			value = eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1));
		} catch (_) {
			// decodeURIComponent throws on a half written escape, which is exactly
			// what a damaged copy and paste produces.
			return refuse('MALFORMED_PERCENT_ENCODING');
		}
		// A field with no '=' at all is usually the tail of a message with an
		// unescaped & in it, which means the message on screen is not the message
		// that was written.
		if (eq === -1 && !KNOWN_PARAMS.has(key.toLowerCase())) warn(warnings, 'TEXT_PARAM_TRUNCATED');
		if (params.has(key)) {
			duplicated.set(key, (duplicated.get(key) || []).concat(value));
			continue; // first one wins
		}
		params.set(key, value);
	}

	for (const key of params.keys()) {
		const lower = key.toLowerCase();
		// BIP21 reserves req- for fields a payer must understand to pay correctly.
		// Not understanding one is precisely the case it was invented for.
		if (lower.startsWith('req-')) {
			return refuse(
				'UNSUPPORTED_REQ_PARAM',
				`This payment request requires "${key}", which this wallet does not support. Paying it could pay the wrong thing.`
			);
		}
		// A key that differs from a field this wallet knows only by case would be
		// silently ignored, and silently ignoring an amount is how the wrong sum
		// gets sent.
		if (key !== lower && KNOWN_PARAMS.has(lower)) {
			return refuse(
				'PARAM_CASE_MISMATCH',
				`This payment request writes "${key}" in capitals, so its value cannot be trusted to mean what it looks like. Ask for a new one.`
			);
		}
	}

	// Two amounts that name the same figure are a badly built string, not a
	// contradiction, and telling the payer their request "names two different
	// amounts" would be false about the one thing they cannot check themselves.
	// Two that genuinely differ leave no way to tell which was meant, so those
	// are still refused.
	if (duplicated.has('amount')) {
		const first = btcStringToSats(params.get('amount'));
		// An amount that cannot be read at all is refused below, on its own terms.
		if (first.ok) {
			const agree = duplicated.get('amount').every((other) => {
				const parsed = btcStringToSats(other);
				return parsed.ok && parsed.sats === first.sats;
			});
			if (!agree) return refuse('DUPLICATE_AMOUNT');
		}
	}
	if (duplicated.size > 0) warn(warnings, 'DUPLICATE_PARAM');

	let amountSats = null;
	if (params.has('amount')) {
		const parsed = btcStringToSats(params.get('amount'));
		if (!parsed.ok) return refuse(parsed.code);
		// Zero is grammatical, and it means the payer chooses.
		if (parsed.sats === 0) warn(warnings, 'AMOUNT_ZERO');
		else amountSats = parsed.sats;
	}

	// A request may carry an invoice alongside the address. It is read here so
	// the two can be checked against each other, but a broken one is not allowed
	// to take the on-chain address down with it.
	let lightning = null;
	const lnValue = params.get('lightning');
	if (lnValue) {
		const inner = parseLightning(lnValue.replace(/^lightning:/i, ''), [], opts);
		if (inner.kind === 'bolt11' || inner.kind === 'bolt12') lightning = inner;
		else warn(warnings, 'LN_PAYLOAD_UNPARSEABLE');
	}

	// A direct-funding request may ride alongside the address (beignet envelope
	// v3 under `bgnq`). Read here to show the payer who is asking and to hold
	// the amounts to each other; a request that cannot be read, has expired or
	// names another chain is dropped with a warning and the address is paid
	// as an ordinary transaction, which is what the request's author expects
	// of a wallet that cannot honor it.
	let funding = null;
	const fundingValue = params.get('bgnq');
	if (fundingValue) {
		const env = decodeFundingEnvelope(fundingValue);
		if (!env) warn(warnings, 'FUNDING_UNREADABLE');
		else if (opts.network && env.network && env.network !== opts.network) warn(warnings, 'FUNDING_WRONG_CHAIN');
		else if (env.expiresAt <= (opts.now ?? Date.now())) warn(warnings, 'FUNDING_EXPIRED');
		else {
			funding = {
				envelope: fundingValue,
				nodeId: env.nodeId,
				network: env.network,
				expiresAt: env.expiresAt,
				amountSats: env.amountSats
			};
		}
	}

	const address = squeeze(addressPart, warnings);
	if (!address) {
		// `bitcoin:?lightning=lnbc…` is the ordinary shape of a Lightning-only QR.
		if (lightning) return { ...lightning, warnings: warnings.concat(lightning.warnings || []) };
		return refuse('BIP21_NO_PAYABLE_TARGET');
	}

	const onchain = parseAddress(address, warnings, opts);
	if (onchain.kind !== 'onchain') {
		// The address is unpayable, but an invoice that came with it may not be.
		if (lightning) return { ...lightning, warnings: warnings.concat(lightning.warnings || []) };
		return onchain;
	}

	// Two amounts that disagree is not something to resolve by preference. One of
	// them is wrong, and there is no way to tell which.
	if (amountSats != null && lightning?.amountSats != null && lightning.amountSats !== amountSats) {
		return refuse('AMOUNT_CONFLICT');
	}
	// The same rule for the funding request: its fixed amount is signed by the
	// receiver, and the daemon refuses a send that contradicts it, so a request
	// whose two halves disagree is refused here rather than paid short.
	if (amountSats != null && funding?.amountSats != null && funding.amountSats !== amountSats) {
		return refuse('AMOUNT_CONFLICT');
	}

	return {
		...onchain,
		isRequest: true,
		amountSats: amountSats ?? funding?.amountSats ?? null,
		label: params.get('label') || '',
		message: params.get('message') || '',
		lightning,
		funding
	};
}

/**
 * Read whatever was pasted.
 *
 * Returns one of:
 *   { kind: 'empty' }
 *   { kind: 'onchain', address, amountSats, label, message, lightning, … }
 *   { kind: 'bolt11', invoice, network, amountSats }
 *   { kind: 'bolt12', offer }
 *   { kind: 'invalid', code, message }
 *
 * `opts.network` is the wallet's chain. Given it, an address or invoice for a
 * different chain is refused here rather than accepted and failed later, which
 * matters because the daemon's on-chain send does not check the network itself
 * and fails deep in transaction building with a message about something else.
 *
 * This reads the whole string or nothing. It will not go hunting for an address
 * inside a paragraph: a wallet that picks a payment target out of surrounding
 * text can be made to pick the wrong one.
 */
export function parsePayment(input, opts = {}) {
	try {
		return readPayment(input, opts);
	} catch (_) {
		// A backstop, not a strategy. Every path below is written to return a
		// refusal rather than throw, but this runs inside a render, so a throw that
		// slipped through would take the whole page down and lose whatever else the
		// user had half filled in. No pasted string is worth that.
		return refuse('NOT_PAYABLE');
	}
}

function readPayment(input, opts) {
	if (typeof input !== 'string' || input.trim() === '') return { kind: 'empty' };
	if (input.length > MAX_INPUT) return refuse('INPUT_TOO_LONG');
	// Marks that reorder text on screen make the address shown and the address
	// paid two different strings. There is no safe reading of one.
	if (BIDI_CONTROL.test(input)) return refuse('BIDI_CONTROL');

	const warnings = [];
	let text = stripInvisibles(input);
	// Copied out of a sentence or a chat message, a payment string arrives wrapped
	// in whatever punctuation surrounded it. None of these characters appear in an
	// address, an invoice or an offer, so unwrapping cannot change what is paid.
	for (let pass = 0; pass < 3; pass++) {
		const pair = WRAPPERS.find(([open, close]) => text.length > 2 && text.startsWith(open) && text.endsWith(close));
		if (!pair) break;
		text = text.slice(1, -1).trim();
		warn(warnings, 'PUNCTUATION_STRIPPED');
	}
	if (!text) return { kind: 'empty' };

	const scheme = schemeOf(text);
	if (scheme === 'bitcoin') return parseBip21(text, warnings, opts);
	if (scheme === 'lightning') return parseLightning(text.slice(text.indexOf(':') + 1), warnings, opts);

	const first = attempt(text, warnings, opts);
	if (first.kind !== 'invalid') return first;

	// Copied out of a sentence, a bare address arrives with the sentence's
	// punctuation stuck to it. None of that punctuation can appear in an address,
	// an invoice or an offer, so dropping it cannot change what is being paid,
	// and it is only dropped when doing so turns a refusal into a reading.
	const trimmed = text.replace(TRAILING_PUNCTUATION, '');
	if (trimmed !== text && trimmed !== '') {
		const retry = attempt(trimmed, warn(warnings.slice(), 'PUNCTUATION_STRIPPED'), opts);
		if (retry.kind !== 'invalid') return retry;
	}
	return first;
}

function attempt(text, warnings, opts) {
	return /^ln/i.test(text) ? parseLightning(text, warnings, opts) : parseAddress(text, warnings, opts);
}

/* -------------------------------------------------------------- half typed */

// The shortest string that could be a whole invoice: the shortest prefix, the
// separator, the timestamp and signature every invoice must carry, and the
// checksum. A real one runs past 200, since a payment hash and a payment secret
// are required tagged fields on top of this.
const SHORTEST_INVOICE = 'lnbc'.length + 1 + BOLT11_MIN_DATA + 6;
// The base58 form bottoms out here, and it is also the floor for anything whose
// prefix says nothing about how long it should be.
const SHORTEST_BASE58_ADDRESS = 26;
// The exotic short witness versions BIP350 allows, like the 14-character
// bc1sw50qgdz25j. Valid, and not a string anyone types.
const SHORTEST_BECH32_ADDRESS = 14;
// A witness program's length in bech32 characters, by the version character that
// precedes it: version 0 is 20 or 32 bytes, so 32 characters is its floor, and
// version 1 is always the 32 bytes of a taproot output key.
const PROGRAM_CHARS = { q: 32, p: 52 };

/** hrp, separator, witness version, program, six checksum characters. */
function shortestAddress(body) {
	const hit = /^(bc|tb|bcrt)1([a-z0-9])/i.exec(body);
	if (!hit) return SHORTEST_BASE58_ADDRESS;
	const program = PROGRAM_CHARS[hit[2].toLowerCase()];
	return program ? hit[1].length + 2 + program + 6 : SHORTEST_BECH32_ADDRESS;
}

/**
 * Is this string too short for a refusal about it to mean anything?
 *
 * A field being typed into holds half of something for as long as it takes to
 * write the rest, and every refusal this file can make is true of half a valid
 * string. Telling someone their invoice "fails its own checksum, so it is
 * incomplete or was mistyped. Copy the whole of it again" while their caret is
 * still in the field is both the harshest thing the form can say and the wrong
 * advice for what they are doing: it is incomplete because they have not
 * finished writing it.
 *
 * Length is the signal that separates the two, and the prefix says how long the
 * finished thing should be, so the question is answered here rather than guessed
 * at by each caller.
 */
export function tooShortToJudge(input) {
	const text = typeof input === 'string' ? input.trim() : '';
	if (text === '') return true;
	// A scheme is something a person pastes rather than types, so what follows it
	// is what the length is about.
	const body = schemeOf(text) ? text.slice(text.indexOf(':') + 1) : text;
	if (/^ln/i.test(body)) return body.length < SHORTEST_INVOICE;
	return body.length < shortestAddress(body);
}
