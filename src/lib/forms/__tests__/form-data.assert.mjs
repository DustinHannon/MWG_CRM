// Run: npx tsx src/lib/forms/__tests__/form-data.assert.mjs
// Pure-logic assertions for the form-data helpers (no test framework here).
import assert from "node:assert/strict";
import { formDataToObject } from "../form-data.ts";

const mk = (pairs) => { const f = new FormData(); for (const [k, v] of pairs) f.append(k, v); return f; };

let o = formDataToObject(mk([["name", ""], ["city", "  "]]), { emptyMode: "keep" });
assert.equal(o.name, "", '"keep" must preserve empty string');
assert.equal(o.city, "  ", '"keep" must preserve whitespace');

o = formDataToObject(mk([["name", ""], ["city", "  "], ["ok", "x"]]), { emptyMode: "trim" });
assert.ok(!("name" in o) && !("city" in o) && o.ok === "x", '"trim" drops blanks');

o = formDataToObject(mk([["a", ""], ["b", " "]]), { emptyMode: "exact" });
assert.ok(!("a" in o) && o.b === " ", '"exact" keeps whitespace');

const withFile = mk([["ok", "x"]]);
withFile.append("attachment", new File(["data"], "a.txt"));
o = formDataToObject(withFile, { emptyMode: "keep" });
assert.ok(o.attachment instanceof File, '"keep" passes File entries through unchanged');

console.log("form-data assertions passed");
