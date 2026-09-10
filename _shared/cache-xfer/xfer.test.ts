import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {Readable} from 'node:stream';
import {packToFile, pipeIntoStdin, readEnvelope, unpackFromFile} from './xfer';

// Local pack/unpack round-trips (spawns real tar + zstd; no cache service).

async function tempDir(): Promise<string> {
	return fsp.mkdtemp(path.join(os.tmpdir(), 'cache-xfer-test-'));
}

test('directory round-trip preserves tree, exec bits, symlinks, dotfiles', async t => {
	const src = await tempDir();
	const work = await tempDir();
	const dest = path.join(await tempDir(), 'restored');
	t.after(async () => {
		for (const dir of [src, work, path.dirname(dest)]) {
			await fsp.rm(dir, {recursive: true, force: true});
		}
	});

	await fsp.mkdir(path.join(src, 'sub', 'deep'), {recursive: true});
	await fsp.writeFile(path.join(src, 'plain.txt'), 'hello handoff');
	await fsp.writeFile(path.join(src, 'sub', 'deep', 'nested.bin'), Buffer.from([0, 1, 2, 254, 255]));
	await fsp.writeFile(path.join(src, 'tool'), '#!/bin/sh\necho ok\n', {mode: 0o755});
	await fsp.writeFile(path.join(src, '.hidden'), 'dotfile survives');
	await fsp.symlink('plain.txt', path.join(src, 'link'));

	const archive = path.join(work, 'archive.wxfr');
	const packed = await packToFile(src, archive, 'tree-handoff');
	assert.equal(packed.mode, 'tar');
	assert.equal(packed.codec, 'zstd');
	assert.equal(packed.name, 'tree-handoff');

	const {header} = await readEnvelope(archive);
	assert.deepEqual(header, packed);

	const unpacked = await unpackFromFile(archive, dest);
	assert.equal(unpacked.mode, 'tar');

	assert.equal(await fsp.readFile(path.join(dest, 'plain.txt'), 'utf8'), 'hello handoff');
	assert.deepEqual(await fsp.readFile(path.join(dest, 'sub', 'deep', 'nested.bin')), Buffer.from([0, 1, 2, 254, 255]));
	assert.equal(await fsp.readFile(path.join(dest, '.hidden'), 'utf8'), 'dotfile survives');
	const toolMode = (await fsp.stat(path.join(dest, 'tool'))).mode & 0o777;
	assert.equal(toolMode & 0o111, 0o111, `exec bits survive (got ${toolMode.toString(8)})`);
	assert.equal(await fsp.readlink(path.join(dest, 'link')), 'plain.txt');
});

test('single-file round-trip uses raw mode and restores basename + mode', async t => {
	const src = await tempDir();
	const work = await tempDir();
	const dest = path.join(await tempDir(), 'raw-out');
	t.after(async () => {
		for (const dir of [src, work, path.dirname(dest)]) {
			await fsp.rm(dir, {recursive: true, force: true});
		}
	});

	const file = path.join(src, 'go-toolchain');
	const body = Buffer.concat([Buffer.from('binary-ish '), Buffer.from([0, 7, 255])]);
	await fsp.writeFile(file, body, {mode: 0o755});

	const archive = path.join(work, 'archive.wxfr');
	const packed = await packToFile(file, archive, 'toolchain');
	assert.equal(packed.mode, 'raw');
	assert.equal(packed.name, 'toolchain');
	assert.equal(packed.basename, 'go-toolchain');
	assert.equal((packed.fileMode as number) & 0o111, 0o111);

	const unpacked = await unpackFromFile(archive, dest);
	assert.equal(unpacked.mode, 'raw');
	const restored = path.join(dest, 'go-toolchain');
	assert.deepEqual(await fsp.readFile(restored), body);
	assert.equal((await fsp.stat(restored)).mode & 0o111, 0o111);
});

test('packToFile rejects a missing path', async () => {
	const work = await tempDir();
	await assert.rejects(packToFile(path.join(work, 'nope'), path.join(work, 'a.wxfr'), 'x'), /does not exist/);
	await fsp.rm(work, {recursive: true, force: true});
});

test('unpackFromFile rejects a non-envelope file', async () => {
	const work = await tempDir();
	const bogus = path.join(work, 'bogus');
	await fsp.writeFile(bogus, 'this is not an envelope at all');
	await assert.rejects(unpackFromFile(bogus, path.join(work, 'out')), /magic/);
	await fsp.rm(work, {recursive: true, force: true});
});

// A child that exits 0 having read only a prefix of what we send closes its
// stdin under the writer: EPIPE mid-write, or ERR_STREAM_PREMATURE_CLOSE when
// the pipe's `close` beats the writable's `finish`. Both mean the child is
// done, not that the transfer failed -- awaiting the raw pipeline here is what
// failed ~2.5% of real 16 MB unpacks, with every byte extracted correctly.
test('pipeIntoStdin resolves when the child exits 0 before draining its stdin', async () => {
	for (let attempt = 0; attempt < 20; attempt++) {
		const child = spawn('sh', ['-c', 'head -c 16 >/dev/null'], {stdio: ['pipe', 'ignore', 'ignore']});
		const big = Readable.from([Buffer.alloc(4 * 1024 * 1024, 7), Buffer.alloc(4 * 1024 * 1024, 9)]);
		await pipeIntoStdin(big, child.stdin!);
	}
});

test('pipeIntoStdin rethrows failures that are not a child closing its stdin', async () => {
	const child = spawn('cat', {stdio: ['pipe', 'ignore', 'ignore']});
	const boom = new Readable({
		read() {
			this.destroy(Object.assign(new Error('disk fell off'), {code: 'EIO'}));
		}
	});
	await assert.rejects(pipeIntoStdin(boom, child.stdin!), /disk fell off/);
	child.kill();
});

// The race is scheduling-dependent, so one round-trip proves nothing; a batch
// makes a reintroduced bare pipeline overwhelmingly likely to show up, and
// every restore is checked byte-for-byte rather than just for absence of throw.
test('repeated directory round-trips neither fail nor lose bytes', async t => {
	const src = await tempDir();
	const work = await tempDir();
	t.after(async () => {
		for (const dir of [src, work]) {
			await fsp.rm(dir, {recursive: true, force: true});
		}
	});

	// Big enough that tar/zstd stay busy across several pipe buffers; that is
	// what opens the window between the child's exit and the writable's finish.
	const bodies = new Map<string, Buffer>();
	for (let i = 0; i < 4; i++) {
		const body = Buffer.alloc(1024 * 1024, i + 1);
		bodies.set(`blob${i}.bin`, body);
		await fsp.writeFile(path.join(src, `blob${i}.bin`), body);
	}

	const archive = path.join(work, 'batch.wxfr');
	await packToFile(src, archive, 'batch-handoff');

	for (let i = 0; i < 25; i++) {
		const dest = path.join(work, `out-${i}`);
		await unpackFromFile(archive, dest);
		for (const [name, body] of bodies) {
			assert.deepEqual(await fsp.readFile(path.join(dest, name)), body, `iteration ${i}: ${name}`);
		}
		await fsp.rm(dest, {recursive: true, force: true});
	}
});
