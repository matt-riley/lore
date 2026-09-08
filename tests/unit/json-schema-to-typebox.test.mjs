import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { LORE_CAPABILITY_SPECS } from "../../lib/capabilities/capability-manifest.mjs";
import { jsonSchemaToTypeBox } from "../../lib/runtime/json-schema-to-typebox.mjs";
import { DEFAULT_MODEL_TOOL_NAMES } from "../../lib/runtime/tool-registry.mjs";

function createTypeRecorder() {
  const wrap = (kind, value, options) => ({ kind, value, options });
  return {
    Object: (properties, options) => wrap("object", properties, options),
    String: (options) => wrap("string", null, options),
    Number: (options) => wrap("number", null, options),
    Boolean: (options) => wrap("boolean", null, options),
    Optional: (value) => wrap("optional", value),
    Union: (values, options) => wrap("union", values, options),
    Literal: (value) => wrap("const", value),
    Array: (items, options) => wrap("array", items, options),
  };
}

describe("jsonSchemaToTypeBox", () => {
  test("maps object/string/number/boolean/optional/enum/const", () => {
    const Type = createTypeRecorder();
    const converted = jsonSchemaToTypeBox({
      type: "object",
      properties: {
        prompt: { type: "string", description: "Prompt" },
        limit: { type: "number" },
        verbose: { type: "boolean" },
        mode: { type: "string", enum: ["prompt", "session_start"] },
        locked: { const: "yes" },
      },
      required: ["prompt"],
    }, Type);

    assert.equal(converted.kind, "object");
    assert.equal(converted.value.prompt.kind, "string");
    assert.equal(converted.value.prompt.options.description, "Prompt");
    assert.equal(converted.value.limit.kind, "optional");
    assert.equal(converted.value.limit.value.kind, "number");
    assert.equal(converted.value.verbose.value.kind, "boolean");
    assert.equal(converted.value.mode.value.kind, "union");
    assert.deepEqual(converted.value.mode.value.value.map((entry) => entry.value), ["prompt", "session_start"]);
    assert.equal(converted.value.locked.value.kind, "const");
    assert.equal(converted.value.locked.value.value, "yes");
  });

  test("throws on unsupported constructs and missing TypeBox", () => {
    const Type = createTypeRecorder();
    assert.throws(
      () => jsonSchemaToTypeBox({ oneOf: [{ type: "string" }] }, Type),
      /unsupported construct oneOf/,
    );
    assert.throws(
      () => jsonSchemaToTypeBox({ type: "string" }, null),
      /TypeBox Type is required/,
    );
  });

  test("converts every default model tool schema from the manifest", () => {
    const Type = createTypeRecorder();
    for (const name of DEFAULT_MODEL_TOOL_NAMES) {
      const spec = LORE_CAPABILITY_SPECS.find((entry) => entry.name === name);
      assert.ok(spec, name);
      const converted = jsonSchemaToTypeBox(spec.parameters, Type);
      assert.equal(converted.kind, "object", name);
    }
  });
});
