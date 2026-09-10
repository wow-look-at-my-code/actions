import assert from "node:assert/strict";
import { test } from "node:test";
import { isDefaultBranch, nextVersion, parseArgs } from "./args";

test("a value containing a space arrives whole", () => {
	const options = parseArgs(["--source", "run-once", "--message", "Release the thing"]);
	assert.equal(options.source, "run-once");
	assert.equal(options.message, "Release the thing");
});

test("name defaults to the source directory", () => {
	assert.equal(parseArgs(["--source", "ste-lint"]).name, "ste-lint");
	assert.equal(parseArgs(["--source", "ste-lint", "--name", "lint"]).name, "lint");
});

// It gave a side branch its own tag prefix. Nothing installed those tags, and
// no caller in the org ever passed it.
test("include-branch is gone, and an unknown flag is refused rather than ignored", () => {
	assert.throws(() => parseArgs(["--source", "x", "--include-branch"]), /Unknown option/);
});

test("source is required", () => {
	assert.throws(() => parseArgs([]), /--source is required/);
});

test("an unknown option is refused rather than ignored", () => {
	assert.throws(() => parseArgs(["--source", "x", "--latest"]), /Unknown option: --latest/);
});

test("a flag with no value left is refused", () => {
	assert.throws(() => parseArgs(["--source"]), /--source needs a value/);
});

// The bug this guards: yq prints "null" for a missing field, which used to
// mint a tag named "widget#null".
test("a version that is not digits is refused", () => {
	for (const bad of ["null", "1.2", "v3", "-1", ""]) {
		if (bad === "") continue;
		assert.throws(() => parseArgs(["--source", "x", "--version", bad]), /positive integer/, bad);
	}
	assert.equal(parseArgs(["--source", "x", "--version", "7"]).version, "7");
});

test("main and master are the default branch", () => {
	assert.equal(isDefaultBranch("master"), true);
	assert.equal(isDefaultBranch("main"), true);
	assert.equal(isDefaultBranch("claude/fix"), false);
});

test("the next version is one past the highest published number", () => {
	assert.equal(nextVersion(["widget#1", "widget#9", "widget#10"], "widget"), 11);
	assert.equal(nextVersion([], "widget"), 1);
	assert.equal(nextVersion([""], "widget"), 1);
});

// #latest and another action's series both match a naive prefix scan.
test("only this prefix's numbered tags count", () => {
	const tags = ["widget#latest", "widget#3", "widget-extra#99", "widget/branch#50", "other#7"];
	assert.equal(nextVersion(tags, "widget"), 4);
});

test("a prefix carrying regex metacharacters is matched literally", () => {
	assert.equal(nextVersion(["a.c#5", "abc#9"], "a.c"), 6);
});
