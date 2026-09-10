// Validate workflow YAML against the LIVE GitHub workflow schema.
//
// Why not action-validator for this: its schema is vendored into a wasm blob
// (@action-validator/core, pinned at 0.6.0 with no newer release) and has
// fallen behind GitHub. It rejects permission scopes that are generally
// available -- `artifact-metadata` among them -- so a correct workflow fails
// validation with "Additional property 'artifact-metadata' is not allowed".
// Fetching schemastore's github-workflow.json at run time keeps the check
// current instead of pinning it to whenever the wasm was last rebuilt.
//
// Usage: node validate-workflows.mjs <schema.json> <workflow.yml>...
// Exits non-zero, listing every violation, if any file fails.

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import * as yaml from 'js-yaml';
import { readFileSync } from 'node:fs';

const [schemaPath, ...files] = process.argv.slice(2);
if (!schemaPath || files.length === 0) {
  console.error('usage: validate-workflows.mjs <schema.json> <workflow.yml>...');
  process.exit(2);
}

// strict:false because schemastore uses keywords ajv does not police (and a
// warning storm about the schema itself would bury real workflow errors).
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

let validate;
try {
  validate = ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')));
} catch (e) {
  console.error(`Could not compile the workflow schema: ${e.message}`);
  process.exit(2);
}

let failed = 0;
for (const file of files) {
  let doc;
  try {
    doc = yaml.load(readFileSync(file, 'utf8'));
  } catch (e) {
    failed++;
    console.error(`FAIL ${file}\n      unparseable YAML: ${e.message}`);
    continue;
  }
  if (validate(doc)) {
    console.log(`OK   ${file}`);
    continue;
  }
  failed++;
  console.error(`FAIL ${file}`);
  for (const err of validate.errors) {
    console.error(`      ${err.instancePath || '/'} ${err.message}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} workflow file(s) failed schema validation`);
  process.exit(1);
}
console.log(`\n${files.length} workflow file(s) validated`);
