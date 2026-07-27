const JSON_VALUE_TYPES = new Set(["string", "number", "boolean"]);

function canonicalize(value, state, path) {
  if (value === null) {
    return null;
  }

  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new TypeError(`Invalid Date at ${path}.`);
    }
    return value.toISOString();
  }

  const valueType = typeof value;
  if (JSON_VALUE_TYPES.has(valueType)) {
    if (valueType === "number") {
      if (!Number.isFinite(value)) {
        throw new TypeError(`Non-finite number at ${path}.`);
      }
      return Object.is(value, -0) ? 0 : value;
    }
    return value;
  }

  if (valueType !== "object") {
    throw new TypeError(`Non-JSON value at ${path}.`);
  }

  if (state.seen.has(value)) {
    throw new TypeError(`Circular JSON value at ${path}.`);
  }
  state.seen.add(value);

  let result;
  if (Array.isArray(value)) {
    result = value.map((item, index) =>
      canonicalize(item, state, `${path}[${index}]`),
    );
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Non-plain object at ${path}.`);
    }

    result = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalize(value[key], state, `${path}.${key}`);
    }
  }

  state.seen.delete(value);
  return result;
}

export function canonicalJsonValue(value) {
  return canonicalize(value, { seen: new WeakSet() }, "$");
}

export function canonicalStringify(value) {
  return JSON.stringify(canonicalJsonValue(value));
}

export function canonicalJsonByteLength(value) {
  return Buffer.byteLength(canonicalStringify(value), "utf8");
}

export function canonicalJsonEquals(left, right) {
  try {
    return canonicalStringify(left) === canonicalStringify(right);
  } catch {
    return false;
  }
}

export function assertCanonicalJsonCopy(jsonText, value) {
  if (typeof jsonText !== "string") {
    throw new TypeError("Canonical JSON copy must be a string.");
  }

  const expected = canonicalStringify(value);
  if (jsonText !== expected) {
    throw new TypeError("JSON compatibility copy is not canonical or identical.");
  }

  return true;
}
