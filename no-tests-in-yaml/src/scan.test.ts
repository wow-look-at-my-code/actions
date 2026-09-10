import assert from 'node:assert/strict';
import {test} from 'node:test';
import {findFindings, findRunBlocks, formatFinding} from './scan';

function findingsIn(yaml: string): ReturnType<typeof findFindings> {
	return findRunBlocks(yaml).flatMap(block => findFindings(block));
}

test('a block scalar run script is read whole, with its own line numbers', () => {
	const yaml = ['jobs:', '  a:', '    steps:', '      - run: |', '          set -e', '          make', '      - uses: ./x'].join('\n');
	assert.deepEqual(findRunBlocks(yaml), [{startLine: 5, lines: ['          set -e', '          make']}]);
});

test('an inline run command is one line', () => {
	assert.deepEqual(findRunBlocks('      - run: npm ci\n'), [{startLine: 1, lines: ['npm ci']}]);
});

test('a run block ends at the next key at or under its own indent', () => {
	const yaml = ['      - run: |', '          make', '        env:', '          A: b'].join('\n');
	assert.deepEqual(findRunBlocks(yaml), [{startLine: 2, lines: ['          make']}]);
});

test('an ordinary build step is not a test', () => {
	const yaml = ['      - run: |', '          set -euo pipefail', '          npm ci', '          npm run build', '          ./gradlew assemble'].join('\n');
	assert.deepEqual(findingsIn(yaml), []);
});

test('a step that fails on its own exit code is not a test', () => {
	const yaml = ['      - run: |', '          set -euo pipefail', '          go-toolchain', '          dats --no-sandbox test tests/'].join('\n');
	assert.deepEqual(findingsIn(yaml), []);
});

test('writing a test file is a finding', () => {
	const yaml = ["      - run: |", "          cat > main_test.go <<'EOF'", '          package main', '          EOF'].join('\n');
	const findings = findingsIn(yaml);
	assert.equal(findings.length, 1);
	assert.equal(findings[0].rule, 'test-file-written');
	assert.equal(findings[0].line, 2);
});

test('every test-file naming convention counts', () => {
	for (const name of ['main_test.go', 'scan.test.ts', 'thing.spec.js', 'test_parser.py', 'widget_spec.rb', 'FooTest.java', 'cli.dats', 'conftest.py']) {
		const yaml = ['      - run: |', `          cat > ${name} <<EOF`, '          EOF'].join('\n');
		assert.equal(findingsIn(yaml).length, 1, `${name} must be recognized as a test file`);
	}
});

test('writing an ordinary source or config file is not a finding', () => {
	for (const name of ['main.go', 'go.mod', 'package.json', 'compose.yaml', 'notes.md']) {
		const yaml = ['      - run: |', `          cat > ${name} <<EOF`, '          EOF'].join('\n');
		assert.deepEqual(findingsIn(yaml), [], `${name} must not be read as a test file`);
	}
});

test('a grep whose failure branch ends the step is an assertion', () => {
	const yaml = ['      - run: |', '          set -e', '          grep -q "READY" out.log || { echo "::error::never became ready"; exit 1; }'].join('\n');
	const findings = findingsIn(yaml);
	assert.equal(findings.length, 1);
	assert.equal(findings[0].rule, 'assertion');
});

test('a negated check in an if is an assertion', () => {
	const yaml = ['      - run: |', '          if ! grep -q "INOPERATIVE" captured.err; then', '            echo "::error::the guard said nothing"', '            exit 1', '          fi'].join('\n');
	assert.equal(findingsIn(yaml).filter(finding => finding.rule === 'assertion').length > 0, true);
});

test('a case arm that annotates and exits is an assertion', () => {
	const yaml = ['      - run: |', '          case "$got" in', '            *"host: linux"*) ;;', '            *) echo "::error::wrong host: ${got}"; exit 1 ;;', '          esac'].join('\n');
	const findings = findingsIn(yaml);
	assert.equal(findings.length, 1);
	assert.equal(findings[0].line, 4);
});

test('a bracket comparison that ends the step is an assertion', () => {
	const yaml = ['      - run: |', '          [ "$(head -c 6 dist/app)" = "MZqFpD" ] || exit 1'].join('\n');
	assert.equal(findingsIn(yaml).length, 1);
});

test('an assertion helper function is a finding', () => {
	const yaml = ['      - run: |', '          assert_contains() {', '            grep -q "$2" "$1"', '          }'].join('\n');
	const findings = findingsIn(yaml);
	assert.equal(findings[0].rule, 'assert-helper');
});

test('a grep that only routes output never fires', () => {
	const yaml = ['      - run: |', '          set -e', '          grep -c ERROR build.log', '          docker images | grep myapp'].join('\n');
	assert.deepEqual(findingsIn(yaml), []);
});

test('an error annotation with no exit is a report, not an assertion', () => {
	const yaml = ['      - run: |', '          set -e', '          echo "::error::the upload endpoint answered 503"'].join('\n');
	assert.deepEqual(findingsIn(yaml), []);
});

test('a finding names its file, its line, its rule and the remedy', () => {
	const yaml = ["      - run: |", "          cat > api_test.go <<'EOF'", '          EOF'].join('\n');
	const message = formatFinding('.github/workflows/ci.yml', findingsIn(yaml)[0]);
	assert.match(message, /^\.github\/workflows\/ci\.yml:2: /);
	assert.match(message, /\[test-file-written\]/);
	assert.match(message, /api_test\.go is a test file/);
});
