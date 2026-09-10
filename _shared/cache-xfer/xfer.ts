import {ChildProcess, spawn} from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import {once} from 'events';
import {pipeline} from 'stream/promises';
import {EnvelopeHeader, MAX_HEADER_BYTES, encodeEnvelope, parseEnvelope} from './lib';

// zstd is the fastest codec preinstalled on ALL GitHub-hosted runners:
// per the actions/runner-images software manifests (checked 2026-07-17),
// ubuntu-24.04, macos-15 (arm64), and windows-2025 all ship zstd 1.5.7,
// while lz4 is preinstalled only on ubuntu. Negative compression levels
// (--fast=N) trade ratio for speed, which is the right trade for a
// same-run hand-off that lives minutes. No --long: raising the window
// requires matching decompressor settings (the same portability reason
// @actions/cache uses its 'zstd-without-long' mode everywhere).
const ZSTD_COMPRESS_ARGS = ['-T0', '--fast=2', '-c'];
const ZSTD_DECOMPRESS_ARGS = ['-d', '-T0', '-c'];

/** Collect (a bounded tail of) a child's stderr for error messages. */
function collectStderr(proc: ChildProcess): {read: () => string} {
	let out = '';
	proc.stderr?.on('data', (chunk: Buffer) => {
		out = (out + chunk.toString()).slice(-8192);
	});
	return {read: () => out.trim()};
}

async function waitExit(proc: ChildProcess, name: string, stderr: {read: () => string}): Promise<void> {
	const [code, signal] = (await once(proc, 'close')) as [number | null, string | null];
	if (code !== 0) {
		const detail = stderr.read();
		throw new Error(`${name} exited with ${code === null ? `signal ${signal}` : `code ${code}`}${detail ? `: ${detail}` : ''}`);
	}
}

/**
 * Every way the runtime reports "the child's stdin went away", none of which
 * means the transfer failed:
 *
 *   ERR_STREAM_PREMATURE_CLOSE — the pipe's `close` beat the writable's
 *                                `finish`, so pipeline()'s completion check
 *                                fired first
 *   EPIPE                      — a write reached a pipe with no reader
 *   ECANCELED                  — writes were still queued when the pipe was
 *                                torn down, so the runtime cancelled them
 *   ERR_STREAM_DESTROYED       — a write was issued after the teardown
 */
const STDIN_TEARDOWN_CODES = new Set(['ERR_STREAM_PREMATURE_CLOSE', 'EPIPE', 'ECANCELED', 'ERR_STREAM_DESTROYED']);

/**
 * Feed `source` into a child's stdin.
 *
 * The child's exit status is the authority on whether the transfer worked --
 * NOT the pipeline's teardown. When a child exits, the runtime closes its
 * stdin pipe, and any code above can surface even though every byte was
 * delivered and the child exited 0. Which event wins is scheduling luck, so
 * awaiting the pipeline verbatim fails a successful hand-off at random --
 * measured at ~2.5% of unpacks of a 16 MB payload, which is what a downstream
 * publish job hit on an otherwise green build.
 *
 * Swallowing them hides nothing: a child that really failed exits non-zero and
 * waitExit() reports it, with its stderr attached. Failures on the SOURCE side
 * (a truncated archive, a read error) carry other codes and still propagate.
 */
export async function pipeIntoStdin(source: NodeJS.ReadableStream, stdin: NodeJS.WritableStream): Promise<void> {
	try {
		await pipeline(source, stdin);
	} catch (err) {
		if (!STDIN_TEARDOWN_CODES.has(String((err as NodeJS.ErrnoException).code))) {
			throw err;
		}
	}
}

/** Await every stage; surface the first failure after all have settled. */
async function awaitStages(stages: Array<Promise<void>>): Promise<void> {
	const results = await Promise.allSettled(stages);
	for (const result of results) {
		if (result.status === 'rejected') {
			throw result.reason instanceof Error ? result.reason : new Error(String(result.reason));
		}
	}
}

/**
 * The tar invocation. On non-Windows this is simply `tar` from PATH. On
 * Windows both tars in the image work for our stream usage, but GNU tar
 * (Git's, sometimes first on PATH) treats `C:` in paths as a remote-host
 * prefix, so it needs --force-local and forward slashes — the same handling
 * @actions/cache applies in lib/internal/tar.js (getTarArgs/getTarPath,
 * IS_WINDOWS branches; GNU-ness sniffed via `tar --version` like
 * cacheUtils.getGnuTarPathOnWindows does).
 */
async function tarInvocation(): Promise<{cmd: string; extraArgs: string[]; fixPath: (p: string) => string}> {
	if (process.platform !== 'win32') {
		return {cmd: 'tar', extraArgs: [], fixPath: p => p};
	}
	const probe = spawn('tar', ['--version']);
	let version = '';
	probe.stdout?.on('data', (chunk: Buffer) => (version += chunk.toString()));
	await once(probe, 'close');
	const isGnu = version.includes('GNU tar');
	return {
		cmd: 'tar',
		extraArgs: isGnu ? ['--force-local'] : [],
		fixPath: p => p.replace(/\\/g, '/')
	};
}

/**
 * Pack `sourcePath` into the envelope archive at `archivePath`, stamping the
 * hand-off `name` into the envelope header (what lets a nameless download
 * report which hand-off it picked).
 *
 * A single regular file takes the raw fast path: its bytes stream straight
 * through zstd with no tar process, and the envelope carries basename +
 * permission bits. A directory is captured as its CONTENTS: `tar -cf - -C
 * <dir> .` piped through zstd (exec bits, symlinks, and dotfiles preserved
 * by tar). Nothing is ever buffered whole in JS — header write aside, both
 * paths are pure child-process streaming.
 */
export async function packToFile(sourcePath: string, archivePath: string, name: string): Promise<EnvelopeHeader> {
	let stats: fs.Stats;
	try {
		stats = await fsp.stat(sourcePath);
	} catch {
		throw new Error(`path '${sourcePath}' does not exist; nothing to hand off`);
	}

	let header: EnvelopeHeader;
	if (stats.isFile()) {
		header = {
			mode: 'raw',
			codec: 'zstd',
			name,
			basename: path.basename(path.resolve(sourcePath)),
			fileMode: stats.mode & 0o7777
		};
	} else if (stats.isDirectory()) {
		header = {mode: 'tar', codec: 'zstd', name};
	} else {
		throw new Error(`path '${sourcePath}' is neither a regular file nor a directory`);
	}

	const out = fs.createWriteStream(archivePath);
	out.write(encodeEnvelope(header));

	const zstd = spawn('zstd', ZSTD_COMPRESS_ARGS, {stdio: ['pipe', 'pipe', 'pipe']});
	const zstdErr = collectStderr(zstd);
	const stages: Array<Promise<void>> = [pipeline(zstd.stdout, out), waitExit(zstd, 'zstd', zstdErr)];

	if (header.mode === 'raw') {
		stages.push(pipeIntoStdin(fs.createReadStream(sourcePath), zstd.stdin));
	} else {
		const tarSpec = await tarInvocation();
		const tar = spawn(tarSpec.cmd, ['-cf', '-', ...tarSpec.extraArgs, '-C', tarSpec.fixPath(sourcePath), '.'], {
			stdio: ['ignore', 'pipe', 'pipe']
		});
		const tarErr = collectStderr(tar);
		stages.push(pipeIntoStdin(tar.stdout, zstd.stdin), waitExit(tar, 'tar', tarErr));
	}

	await awaitStages(stages);
	return header;
}

/** Read and validate the envelope prefix of an archive file. */
export async function readEnvelope(archivePath: string): Promise<{header: EnvelopeHeader; dataOffset: number}> {
	const fh = await fsp.open(archivePath, 'r');
	try {
		const buf = Buffer.alloc(5 + 4 + MAX_HEADER_BYTES);
		const {bytesRead} = await fh.read(buf, 0, buf.length, 0);
		return parseEnvelope(buf.subarray(0, bytesRead));
	} finally {
		await fh.close();
	}
}

/**
 * Unpack the envelope archive at `archivePath` into the directory `destDir`
 * (created if missing). Returns the envelope header.
 */
export async function unpackFromFile(archivePath: string, destDir: string): Promise<EnvelopeHeader> {
	const {header, dataOffset} = await readEnvelope(archivePath);
	await fsp.mkdir(destDir, {recursive: true});

	const src = fs.createReadStream(archivePath, {start: dataOffset});
	const zstd = spawn('zstd', ZSTD_DECOMPRESS_ARGS, {stdio: ['pipe', 'pipe', 'pipe']});
	const zstdErr = collectStderr(zstd);
	const stages: Array<Promise<void>> = [pipeIntoStdin(src, zstd.stdin), waitExit(zstd, 'zstd', zstdErr)];

	if (header.mode === 'raw') {
		const destFile = path.join(destDir, header.basename as string);
		stages.push(pipeline(zstd.stdout, fs.createWriteStream(destFile)));
		await awaitStages(stages);
		if (header.fileMode !== undefined) {
			await fsp.chmod(destFile, header.fileMode);
		}
	} else {
		const tarSpec = await tarInvocation();
		const tar = spawn(tarSpec.cmd, ['-xf', '-', ...tarSpec.extraArgs, '-C', tarSpec.fixPath(destDir)], {
			stdio: ['pipe', 'ignore', 'pipe']
		});
		const tarErr = collectStderr(tar);
		stages.push(pipeIntoStdin(zstd.stdout, tar.stdin), waitExit(tar, 'tar', tarErr));
		await awaitStages(stages);
	}
	return header;
}
