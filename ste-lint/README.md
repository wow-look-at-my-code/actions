# ste-lint

Checks prose against the mechanical subset of ASD-STE100, Simplified Technical English. Sentence length, contractions, banned modal verbs, semicolons, and comma splices fail the run. Complex verb tenses, passive voice, long noun clusters, and dictionary word choice only warn.

```yaml
- uses: wow-look-at-my/actions@ste-lint#latest
  with:
    files: docs/**/*.md
```

## What fails the run

A sentence over `hard-max-words` (25). A contraction. `should`, `shall`, `could`, `might`, or `would` (use `must`, `must not`, or `can`). A semicolon. A comma that joins two clauses.

**A sentence is measured as a sentence, not as a line.** Prose files are hard-wrapped, so one sentence normally spans two or three physical lines. A checker that reads one line at a time sees three short fragments. It passes a 30-word sentence, which makes the cap unenforceable on exactly the documents it aims at. Every rule here reads a paragraph with its lines rejoined. Each finding still names the line its sentence starts on.

**A comma splice is the banned semicolon, spelled differently.** Rule 5.3 allows one instruction per sentence, which is why rule 8.1 bans the semicolon. So `A, B` breaks the same rule as `A; B` and fails the same way.

The pattern is narrow on purpose. The words before the comma must already carry a finite verb, and at least three words. The words after it must open a clause with a subject and a finite verb. An introductory phrase in front of a clause stays untouched, as does a subordinate clause. "Under the alt screen, there is no scrollback" is ordinary English.

## What only warns

Sentence length in the band between the two caps. Passive voice. A long noun cluster. A complex verb tense: perfect, future perfect, or progressive. STE approves only the infinitive, the imperative, and the three simple tenses. A paragraph over six sentences, where a list line never counts, which matches the standard's own convention. A word the ASD-STE100 dictionary does not approve.

The dictionary is extracted from the standard's free PDF. See `docs/ste-lint-spec-mapping.md` for what was deliberately left out and why. It covers the words this checker cannot safely flag, because they are approved under one sense and banned under another, like "as".

Each of these is a heuristic with real false positives. A check people learn to ignore is worse than no check at all.

## What it cannot check

Every writing rule that needs real semantic judgment rather than a pattern. For example, whether a sentence has one topic or two. Or whether an omitted article is genuinely ambiguous. See `docs/ste-lint-spec-mapping.md` for the full rule-by-rule mapping, and for why each unchecked rule stays unchecked.

ASD's own FAQ says it does not endorse a tool "claimed to be 'fully compliant'" with the standard. This action does not claim that either.

## What it does not read

A heading, a blockquote, a table row, a fenced or inline code span, any text inside double quotes, and a leading YAML frontmatter block (`---` to `---`). A quotation is another voice, code is not prose, and frontmatter is data.

A blanked span keeps its length, so every finding still points at the line it came from. It opens with one letter, which counts the span as the one word it is. That letter also lets a sentence that opens with a code span split from the sentence before it.

## The step guard

The action prints the ref it runs as, so a rolled-back `uses:` reaches the log. It fails if its own step carries `continue-on-error: true`. A step allowed to fail is not a gate. When it cannot read the workflow file to check, it says so at error level rather than staying quiet.

## The fixtures

`fixtures/` holds prose that broke this checker. Each file names the counts it must report, and `src/fixtures.test.ts` walks the directory and compares. Add a file there for a rule that fires on correct prose. Add one for a rule that stays silent on prose it was written to catch.

## Running it locally

Pass file patterns and the same code prints the same report. A finding count is then a command, rather than a number somebody remembers:

```sh
node dist/index.js '**/*.md'
```

It exits 1 on a failing finding, and 2 when the patterns match nothing.

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `files` | `**/*.md` | Glob patterns, separated by whitespace or commas |
| `hard-max-words` | `25` | A sentence longer than this fails |
| `warn-max-words` | `20` | A sentence longer than this warns |

**Neither cap goes above 25.** Rule 6.3 sets that number. A larger value does not configure the rule, it removes it from the calling workflow. Either input is refused above 25, by name. A smaller value is a stricter house style. It is accepted.

Matching no files fails the run. A check that reads nothing passes for the wrong reason.

## Outputs

| Output | Meaning |
| --- | --- |
| `files` | How many files were checked |
| `violations` | How many findings failed the run |
