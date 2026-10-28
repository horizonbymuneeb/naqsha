// Compatibility entry point so `node --test test/` runs every suite.
// The package is ESM ("type": "module"), so this file imports instead of requiring;
// each test file registers its own node:test cases on import.
//
// Preferred invocations:
//   node --test test/
//   node --test "test/*.test.mjs"
//   node --test
import "./validate.test.mjs";
import "./schema.test.mjs";
import "./cli.test.mjs";
import "./render.test.mjs";
import "./demo.test.mjs";
import "./convert.test.mjs";
import "./repair.test.mjs";
import "./to-mermaid.test.mjs";
import "./types-relational.test.mjs";
import "./types-time.test.mjs";
