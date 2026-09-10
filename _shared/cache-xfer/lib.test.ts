import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {ENVELOPE_MAGIC, EnvelopeHeader, KEY_PREFIX, LEGACY_VERSION_SEED, VERSION_SEED, encodeEnvelope, handoffKey, handoffRestorePrefix, handoffVersion, legacyHandoffKey, legacyHandoffRestorePrefix, legacyHandoffVersion, nameFromKey, parseEnvelope, runRestorePrefix, validateName} from './lib';

// Pins the wire-level constants every cache-xfer action must agree on. Run
// once by release.yml's test-cache-xfer job -- shared/ has no package.json,
// so the per-action test matrix never reaches it.

test('pinned wire constants', () => {
	assert.equal(KEY_PREFIX, 'cache-xfer');
	assert.equal(VERSION_SEED, 'wow-look-at-my/actions/cache-xfer/v2');
	assert.equal(LEGACY_VERSION_SEED, 'wow-look-at-my/actions/cache-xfer/v1');
	assert.equal(ENVELOPE_MAGIC, 'WXFR1');
});

test('handoffKey layout is run-id-first', () => {
	assert.equal(handoffKey('go-build', '123456', '2'), 'cache-xfer-123456-go-build-2');
});

test('handoffKey rejects oversized keys', () => {
	assert.throws(() => handoffKey('x'.repeat(600), '1', '1'), /at most 512/);
});

test('handoffRestorePrefix layout', () => {
	assert.equal(handoffRestorePrefix('go-build', '123456'), 'cache-xfer-123456-go-build-');
	assert.ok(handoffKey('go-build', '123456', '7').startsWith(handoffRestorePrefix('go-build', '123456')));
});

test('runRestorePrefix covers every key of the run and no other run', () => {
	assert.equal(runRestorePrefix('123456'), 'cache-xfer-123456-');
	assert.ok(handoffKey('go-build', '123456', '1').startsWith(runRestorePrefix('123456')));
	assert.ok(handoffKey('other-name', '123456', '3').startsWith(runRestorePrefix('123456')));
	// The dash after the run id anchors it: run 123 never matches run 1234.
	assert.ok(!handoffKey('go-build', '1234', '1').startsWith(runRestorePrefix('123')));
	// The old (name-first) layout never matches a run-scoped prefix — that
	// mismatch is deliberate: nameless discovery must not see v1 entries.
	assert.ok(!legacyHandoffKey('go-build', '123456', '1').startsWith(runRestorePrefix('123456')));
});

test('nameFromKey parses current-layout keys only', () => {
	assert.equal(nameFromKey('cache-xfer-123456-go-build-1', '123456'), 'go-build');
	assert.equal(nameFromKey(handoffKey('go-build-42', '123456', '7'), '123456'), 'go-build-42');
	// Round-trips a name with dash-digit segments (per-job hand-off names).
	assert.equal(nameFromKey(handoffKey('name-with-2-digits', '99', '1'), '99'), 'name-with-2-digits');
	// Other runs, old-layout keys, and foreign namespaces yield undefined.
	assert.equal(nameFromKey('cache-xfer-999999-go-build-1', '123456'), undefined);
	assert.equal(nameFromKey(legacyHandoffKey('go-build', '123456', '1'), '123456'), undefined);
	assert.equal(nameFromKey('setup-go-Linux-123456-1', '123456'), undefined);
	assert.equal(nameFromKey('cache-xfer-123456-', '123456'), undefined);
});

test('handoffVersion is sha256 of the literal seed', () => {
	const expected = createHash('sha256').update('wow-look-at-my/actions/cache-xfer/v2').digest('hex');
	assert.equal(handoffVersion(), expected);
	assert.match(handoffVersion(), /^[0-9a-f]{64}$/);
});

test('TRANSITION: legacy key layout and version match what v1 producers saved', () => {
	assert.equal(legacyHandoffKey('go-build', '123456', '2'), 'cache-xfer-go-build-123456-2');
	assert.equal(legacyHandoffRestorePrefix('go-build', '123456'), 'cache-xfer-go-build-123456-');
	assert.equal(legacyHandoffVersion(), createHash('sha256').update('wow-look-at-my/actions/cache-xfer/v1').digest('hex'));
	assert.notEqual(legacyHandoffVersion(), handoffVersion());
});

test('validateName', () => {
	assert.doesNotThrow(() => validateName('go-build'));
	assert.throws(() => validateName(''), /must not be empty/);
	assert.throws(() => validateName('a,b'), /commas/);
});

test('envelope round-trip (tar mode)', () => {
	const header: EnvelopeHeader = {mode: 'tar', codec: 'zstd', name: 'go-build'};
	const encoded = encodeEnvelope(header);
	const parsed = parseEnvelope(Buffer.concat([encoded, Buffer.from('payload-bytes')]));
	assert.deepEqual(parsed.header, header);
	assert.equal(parsed.dataOffset, encoded.length);
});

test('envelope round-trip (raw mode)', () => {
	const header: EnvelopeHeader = {mode: 'raw', codec: 'zstd', name: 'toolchain', basename: 'go-toolchain', fileMode: 0o755};
	const parsed = parseEnvelope(encodeEnvelope(header));
	assert.deepEqual(parsed.header, header);
});

test('envelope name is optional on parse (v1 archives predate it)', () => {
	const parsed = parseEnvelope(encodeEnvelope({mode: 'tar', codec: 'zstd'}));
	assert.equal(parsed.header.name, undefined);
});

test('envelope magic starts the archive', () => {
	assert.ok(encodeEnvelope({mode: 'tar', codec: 'zstd'}).subarray(0, 5).equals(Buffer.from('WXFR1')));
});

test('parseEnvelope rejects bad input', () => {
	assert.throws(() => parseEnvelope(Buffer.from('NOTIT' + '\0\0\0\0')), /magic/);
	assert.throws(() => parseEnvelope(Buffer.from('WX')), /truncated/);
	const truncated = encodeEnvelope({mode: 'tar', codec: 'zstd'});
	assert.throws(() => parseEnvelope(truncated.subarray(0, truncated.length - 2)), /truncated/);
	assert.throws(() => parseEnvelope(mangleHeader({mode: 'zip'})), /mode 'zip'/);
	assert.throws(() => parseEnvelope(mangleHeader({mode: 'tar', codec: 'lz4'})), /codec 'lz4'/);
	assert.throws(() => parseEnvelope(mangleHeader({mode: 'tar', codec: 'zstd', name: ''})), /name/);
	assert.throws(() => parseEnvelope(mangleHeader({mode: 'tar', codec: 'zstd', name: 42})), /name/);
	assert.throws(() => parseEnvelope(mangleHeader({mode: 'raw', codec: 'zstd'})), /basename/);
	assert.throws(() => parseEnvelope(mangleHeader({mode: 'raw', codec: 'zstd', basename: '../evil'})), /basename/);
	assert.throws(() => parseEnvelope(mangleHeader({mode: 'raw', codec: 'zstd', basename: 'a/b'})), /basename/);
	assert.throws(() => parseEnvelope(mangleHeader({mode: 'raw', codec: 'zstd', basename: 'ok', fileMode: -5})), /fileMode/);
});

/** Build an envelope around an arbitrary (possibly invalid) header object. */
function mangleHeader(header: object): Buffer {
	const json = Buffer.from(JSON.stringify(header), 'utf8');
	const len = Buffer.alloc(4);
	len.writeUInt32BE(json.length, 0);
	return Buffer.concat([Buffer.from('WXFR1', 'latin1'), len, json]);
}
