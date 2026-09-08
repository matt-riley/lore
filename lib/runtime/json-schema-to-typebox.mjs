const UNSUPPORTED_KEYS = Object.freeze([
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "$ref",
  "$dynamicRef",
  "if",
  "then",
  "else",
  "patternProperties",
  "prefixItems",
  "unevaluatedProperties",
]);

function schemaOptions(schema) {
  const options = {};
  if (typeof schema?.description === "string") {
    options.description = schema.description;
  }
  if (Object.hasOwn(schema ?? {}, "default")) {
    options.default = schema.default;
  }
  return options;
}

function jsonType(schema) {
  const raw = schema?.type;
  if (Array.isArray(raw)) {
    const nonNull = raw.filter((entry) => entry !== "null");
    return nonNull[0];
  }
  return raw;
}

function assertSupported(schema) {
  for (const key of UNSUPPORTED_KEYS) {
    if (Object.hasOwn(schema, key)) {
      throw new Error(`json-schema-to-typebox: unsupported construct ${key}`);
    }
  }
}

function convert(schema, Type) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("json-schema-to-typebox: schema must be an object");
  }
  assertSupported(schema);

  if (Object.hasOwn(schema, "const")) {
    return Type.Literal(schema.const);
  }

  if (Array.isArray(schema.enum)) {
    if (schema.enum.length === 0) {
      throw new Error("json-schema-to-typebox: empty enum");
    }
    const literals = schema.enum.map((value) => Type.Literal(value));
    return literals.length === 1
      ? literals[0]
      : Type.Union(literals, schemaOptions(schema));
  }

  const type = jsonType(schema);
  if (type === "string") {
    return Type.String(schemaOptions(schema));
  }
  if (type === "number" || type === "integer") {
    return Type.Number(schemaOptions(schema));
  }
  if (type === "boolean") {
    return Type.Boolean(schemaOptions(schema));
  }
  if (type === "array" || schema.items) {
    if (typeof Type.Array !== "function") {
      throw new Error("json-schema-to-typebox: unsupported construct array");
    }
    if (!schema.items || Array.isArray(schema.items)) {
      throw new Error("json-schema-to-typebox: unsupported construct tuple items");
    }
    return Type.Array(convert(schema.items, Type), schemaOptions(schema));
  }
  if (type === "object" || schema.properties || type === undefined) {
    return convertObject(schema, Type);
  }
  throw new Error(`json-schema-to-typebox: unsupported construct ${String(type ?? "unknown")}`);
}

function convertObject(schema, Type) {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const mapped = {};
  for (const [key, propertySchema] of Object.entries(properties)) {
    let converted = convert(propertySchema, Type);
    if (!required.has(key)) {
      converted = Type.Optional(converted);
    }
    mapped[key] = converted;
  }
  return Type.Object(mapped, schemaOptions(schema));
}

/**
 * Map a JSON Schema fragment to TypeBox. Supported: object, string, number,
 * boolean, optional, enum, const. Arrays of those types are also mapped so
 * lore_retain / lore_validate can register; other constructs throw.
 */
export function jsonSchemaToTypeBox(schema, Type) {
  if (Type == null || typeof Type.Object !== "function") {
    throw new Error("json-schema-to-typebox: TypeBox Type is required");
  }
  return convert(schema, Type);
}
