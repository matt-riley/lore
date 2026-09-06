import assert from "node:assert/strict";
import test from "node:test";
import { searchDocs } from "../src/scripts/search.mjs";

const entries = [
  { title: "Memory", description: "Keep context", body: "Install an extension", url: "/memory/" },
  { title: "Install Lore", description: "Get started", body: "Copilot setup", url: "/install/" },
  { title: "Pi integration", description: "Use a shared store", body: "Install Pi with Node", url: "/pi/" },
];
test("search ranks title matches above incidental body mentions", () => {
  assert.equal(searchDocs(entries, "INSTALL")[0].url, "/install/");
});
test("multiple terms must all match and whitespace is normalized", () => {
  assert.deepEqual(searchDocs(entries, "  install   pi ").map(({ url }) => url), ["/pi/"]);
});
test("empty query suggests guides and unmatched input returns no results", () => {
  assert.deepEqual(searchDocs(entries, "  "), entries);
  assert.deepEqual(searchDocs(entries, "<script>"), []);
});
test("punctuated queries use the same word boundaries as document text", () => {
  assert.equal(searchDocs(entries, "install-pi")[0].url, "/pi/");
});
