# ste-lint's rule mapping (ASD-STE100, Issue 9, 2025-01-15)

This is the full mapping from each check in `ste-lint/src/lint.ts` to the writing rule in Part 1 of ASD-STE100 that it enforces. It also says why the rules that are not checked are not checked. Source: the free PDF at `https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf`.

## Checked

| Check | Severity | Rule | Note |
| --- | --- | --- | --- |
| Sentence over 25 words | fail | 6.3 | 25 is the descriptive-writing cap |
| Sentence over 20 words | warn | 5.1 | 20 is the procedural cap; this action cannot reliably tell an instruction from a description, so it warns at 20 and fails at 25 |
| Contraction | fail | 4.2 | closed word list, zero ambiguity |
| `should` / `shall` / `could` / `might` / `would` | fail | dictionary: MUST (v), and the "Do not use COULD (v)" note under CAN (v) | `should`/`shall`/`might`/`would` are simply absent from the dictionary; `may` is excluded on purpose (calendar month collision) |
| Semicolon | fail | 8.1 | STE allows every standard punctuation mark except this one |
| Comma splice | fail | 5.3, and 8.1 by extension | rule 8.1 bans the semicolon because rule 5.3 allows one instruction per sentence, so a comma put in its place breaks the same rule and must fail the same way -- see "The comma-splice check" below |
| Hard-wrapped paragraph | fail | none -- a house rule, see "The no-wrapping rule" below | a paragraph is one line, so the reader's window decides the width |
| Parenthetical text counted as one word | correctness fix, not a new check | 8.5 | without this, `(refer to paragraphs 2 thru 5)` would inflate a sentence's word count against the 20/25 caps |
| Noun cluster of 4+ content words | warn | 2.1 | "no more than three words"; warn because the stopword list is a heuristic |
| Passive voice (`is`/`was`/... + `-ed`) | warn | 3.6 | warn because rule 3.6 itself permits passive voice when the agent is unknown, which this regex cannot tell |
| Perfect / future perfect tense (`has`/`have`/`had`/`will have` + participle) | warn | 3.2, 3.4 | warn, not fail, because "have" + a word ending in "-ed" is also the ordinary "have + adjective + noun" pattern ("have limited options"), which is not perfect tense |
| Progressive tense (`is`/`are`/`was`/`were` + `-ing`) | warn | 3.2, 3.5 | excludes the STE-approved adjective/pronoun/preposition "-ing" words (`mating`, `missing`, `remaining`, `something`, `during`) right after a bare "to be"; does NOT exclude the approved noun forms (`lighting`, `opening`, `routing`, `servicing`), because without an article ("is opening", not "is an opening") that spelling almost always signals the banned progressive verb, not the noun |
| Word not approved in the dictionary (rule 1.1-1.3) | warn | Part 2 (Dictionary) | see "The dictionary check" below |
| Paragraph over 6 sentences | warn | 6.6 | a list line never adds to the count -- see "The paragraph-length check" below |

## The unit every rule is measured over

Every rule reads a **block**: a paragraph with its wrapped lines rejoined into one string (`src/blocks.ts`). A block ends at a blank line, a heading, a blockquote, an HTML comment, or a table row. A list item is a block of its own. A heading is a headline rather than a sentence. A blockquote is somebody else's words. A comment is markup.

The reason is rule 6.3. Prose files are hard-wrapped near 90 columns, so one 25-word sentence normally spans two or three physical lines. A checker that reads one line at a time never sees that sentence. It sees three fragments of eight or nine words, and each fragment passes. That made the sentence cap unenforceable on precisely the documents this action is pointed at. It also made re-wrapping a paragraph a way to clear a finding without shortening anything. The same fix lets the tense rules see "has\nbeen", which a line split used to hide.

Each block keeps an offset map back to its source lines. A finding still names the line its sentence starts on.

## A blanked span is one word, not none

A code span and a quotation are replaced rather than deleted. A finding still names its line. The replacement keeps the span's length and opens with one letter (`blankSpan`).

The letter matters twice. A technical name is a word, and pure whitespace counted as none, which made every sentence around one measure short. A sentence that opens with a code span also needs a character to split on. Without one it joins the sentence before it, and the pair measures as one long sentence.

A quotation ends at the next quotation mark or at the next blank line, whichever comes first. Prose contains unbalanced quotation marks: an opening one on a term, a possessive, a foot mark. Pairing across a whole document put every later span at the wrong place, and one of them swallowed a real semicolon.

## The comma-splice check

A comma that joins two independent clauses is the semicolon rule 8.1 bans, written with a different character. Without this check, `A; B` becomes `A, B` in one search-and-replace and the semicolon rule means nothing.

The pattern is deliberately narrow, because an introductory phrase in front of a clause is ordinary English and is not a splice:

- The words **before** the comma must already carry a finite verb, and at least three words. "Under the alt screen, there is no scrollback" opens with a phrase, not a clause. That comma is left alone.
- The words **after** the comma must open a clause. That means a subject from a closed list, then a finite verb from a closed list. At most two words come between them. A coordinating conjunction in between is allowed, because rule 5.3 bans the joined sentence whether or not an "and" appears in it.

Both lists are closed, so the check misses a splice built from verbs outside them. That is the intended trade: a rule that fails a build must not fire on correct prose.

## The no-wrapping rule

This one is a house rule. ASD-STE100 governs the words in a sentence and says nothing about where a line ends in a file, so this check claims no rule number. It fails a build anyway, because a hard wrap costs more than it looks.

A wrap is one author's guess at one reader's window, frozen into the file. Every later edit reflows the block, so a two-word change and a full rewrite produce the same diff, and a reviewer cannot tell them apart. A wrap also hides length: nobody writes twelve lines by accident, and everybody writes the same text as one wrapped paragraph by accident.

The check reports every physical line that continues the line above it, inside a block (`src/blocks.ts` already finds these. Every rule reads a block with its wrapped lines rejoined). A code fence, a table, a heading, a blockquote and an HTML comment end a block, so none of them can report a wrap. A leading YAML frontmatter block (`---` to `---`) is skipped whole, before any block forms, for the same reason. One key per line is its correct shape, not a wrap. A list item is a block of its own. A second item is therefore not a wrap and an indented continuation under one item is.

## The caps only move downward

`hard-max-words` and `warn-max-words` are refused above 25 (`src/inputs.ts`). Rule 6.3 sets that number, so `hard-max-words: 500` does not configure the rule, it removes it, in one line of YAML that reads like a setting. A smaller value is a stricter house style and is accepted, which is why the check is a ceiling rather than a fixed constant.

## The step guard

None of the rules above matter if the step is switched off, and neither way of switching it off leaves a trace in its output. So the action reports the ref it runs as on every run. That puts a moved or rolled-back `uses:` in the log. It also FAILS when it finds its own step wrapped in `continue-on-error: true`. A step that is allowed to fail is not a gate.

It reads the workflow named by `GITHUB_WORKFLOW_REF` out of the checkout. When it cannot read that file it names the check it cannot make, at error level, rather than passing over it. A check that did not happen is never a check that passed.

## The dictionary check

`src/ste100-banned-words.ts` is extracted from the free PDF at `asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf` (no login, no paywall) -- Part 2 of the standard, the ~2,100-entry alphabetical dictionary (about 900 approved words, about 1,200 banned words each with a suggested replacement). Only the word and its suggested replacement(s) are extracted. ASD's approved-meaning prose and its STE/non-STE example sentences are never taken. Those are their creative writing, not factual data.

The extraction is narrowed on purpose:

- **A word is dropped if it is also approved under some other sense.** For example "as" is banned as a conjunction ("do it as you go") but approved as a preposition ("used as a spacer"). This checker matches text, not part of speech, so it cannot tell the senses apart. A checker that cannot tell the senses apart must not flag the word at all.
- **`should`/`shall`/`could`/`might`/`would`/`may` are excluded.** These are already covered precisely by the hand-coded modal-verb check above.
- **Entries the parser cannot confidently read are dropped, not guessed at.** A handful of multi-word headwords ("provided that", "so that") and a few entries whose alternative wording did not match a clean `WORD (pos)` pattern are left out. A silently-wrong "not approved" verdict is worse than a missed one.

Even with that narrowing, this stays a warning and never a failure. The reason is visible in this very repo. STE bans generic-English "action" in favor of "step"/"procedure"/"task". This repository's own domain vocabulary is GitHub *Actions*. A context-blind word match cannot tell a banned generic noun from an approved technical noun. Rule 1.5-1.9 explicitly allows company- and industry-specific technical nouns outside the general dictionary. So a repo full of "run the action" sees this warning often. That is expected, not a parsing bug.

To regenerate after a new ASD-STE100 issue, download the PDF and run `pdftotext -layout` on it. Parse the `Part 2 – Dictionary` section for lines that open at column 0 with `word (pos)`. A lowercase word is not approved. An uppercase one is approved. Collect the indented `WORD (pos)` continuation lines as suggested alternatives for a not-approved entry. Apply the same narrowing as above before regenerating `ste100-banned-words.ts`.

## The paragraph-length check

Rule 6.6's own worked example counts an entire introductory sentence plus its vertical list as ONE sentence, not one sentence per list line. This repo's Markdown is full of long bulleted lists. Counting one sentence per list line makes this warning fire constantly on ordinary, compliant docs. So a line matching the list-marker pattern (`- `, `* `, `1. `, ...) never adds to a paragraph's sentence count. The paragraph's own intro line already supplies the one sentence the list belongs to. That line usually ends in a colon, with no `.`/`!`/`?` to split on. This matches the standard's convention directly, instead of approximating it.

## The fixtures

`ste-lint/fixtures/` holds prose that broke this checker, kept as the document it broke on. Two kinds are equally worth keeping. The first is a rule that fired on correct prose. The second is a rule that stayed silent on prose it was written to catch.

Each file opens with an `<!-- expect: ... -->` header naming the counts the checker must report for it. `src/fixtures.test.ts` walks the directory and compares. A file with no header fails the run, and a header that names a rule this checker does not report fails the run as well. So a fixture nobody asserts on cannot sit in the directory and look like coverage.

## Not checked, and why

- **One topic per sentence (rule 4.1).** Detecting "does this sentence contain one idea or two" needs semantics this tool does not have.
- **One instruction per sentence (rule 5.2).** The rule's own examples show joining two instructions with "and" is CORRECT when the actions happen at the same time ("Hold the panel in its open position and install the fastener") and WRONG otherwise. A mechanical "flag every 'and' between two verbs" check fails the compliant examples in the standard itself.
- **Omitted words (rule 4.2, the non-contraction half).** Telling "a sentence is missing its subject" from "a sentence has no subject because it is an imperative" needs a parser this tool does not have.
- **Articles (rule 4.5).** The rule gives worked examples where dropping an article is correct ("Solvents can cause damage to paint" -- no article, because it is a general statement) and examples where an article is required. A missing-article heuristic fails the standard's own compliant examples.
- **"Every word must be in the approved list" (rule 1.1-1.3, the other direction from the dictionary check above).** Rule 1.5-1.9 explicitly permits technical nouns specific to a company, industry, or subject field outside the general dictionary. A blanket "not in the list" check flags exactly that permitted vocabulary: this repo's own `action` (GitHub Actions), `runner`, `workflow`, and so on. That is actively wrong per the standard, not just noisy. The banned-word-with-suggested- replacement check above is the direction that stays accurate.
