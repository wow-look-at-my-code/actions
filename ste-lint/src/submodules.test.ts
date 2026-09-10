import assert from 'node:assert/strict';
import {test} from 'node:test';
import {inSubmodule, submodulePaths} from './submodules';

const gitmodules = `[submodule "vendor/thing"]
	path = vendor/thing
	url = https://github.com/owner/thing.git
[submodule "docs-site"]
	path = docs-site/
	url = https://github.com/owner/docs-site.git
`;

test('every path key in .gitmodules is a submodule path', () => {
	assert.deepEqual(submodulePaths(gitmodules), ['docs-site', 'vendor/thing']);
});

test('a file with no path key contributes nothing', () => {
	assert.deepEqual(submodulePaths(''), []);
	assert.deepEqual(submodulePaths('[submodule "x"]\n\turl = https://example.com/x.git\n'), []);
});

test('a submodule swallows the files under it, and nothing else', () => {
	const skip = inSubmodule(submodulePaths(gitmodules));
	assert.equal(skip('vendor/thing/README.md'), true);
	assert.equal(skip('vendor/thing/docs/deep/note.md'), true);
	assert.equal(skip('docs-site/index.md'), true);
	assert.equal(skip('./vendor/thing/README.md'), true);
	assert.equal(skip('README.md'), false);
	assert.equal(skip('vendor/README.md'), false);
	assert.equal(skip('docs-site-notes/README.md'), false);
});

// The path names a directory, so the entry itself is never a file to read.
test('the submodule path on its own is not a file this check reads', () => {
	const skip = inSubmodule(['vendor/thing']);
	assert.equal(skip('vendor/thing'), false);
});

test('a repo with no submodules skips nothing', () => {
	const skip = inSubmodule([]);
	assert.equal(skip('vendor/thing/README.md'), false);
});
