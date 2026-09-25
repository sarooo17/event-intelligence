function assertRecord(value, message) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(message);
  }
  return value;
}

function schemaTypes(schema) {
  if (Array.isArray(schema?.type)) return schema.type.map(String);
  return schema?.type === undefined ? [] : [String(schema.type)];
}

export function assertJsonSchemaValue(schemaInput, value, path = '$') {
  if (!schemaInput || Array.isArray(schemaInput) || typeof schemaInput !== 'object') {
    return;
  }
  const schema = schemaInput;

  if (
    Object.prototype.hasOwnProperty.call(schema, 'const') &&
    !Object.is(schema.const, value)
  ) {
    throw new Error(`JSON Schema violation at ${path}: const mismatch`);
  }

  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((entry) => Object.is(entry, value))
  ) {
    throw new Error(`JSON Schema violation at ${path}: value not in enum`);
  }

  const types = schemaTypes(schema);
  if (types.length) {
    const matches = types.some((type) => {
      if (type === 'null') return value === null;
      if (type === 'array') return Array.isArray(value);
      if (type === 'object') {
        return value !== null && !Array.isArray(value) && typeof value === 'object';
      }
      if (type === 'integer') return Number.isInteger(value);
      if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
      if (type === 'string') return typeof value === 'string';
      if (type === 'boolean') return typeof value === 'boolean';
      return false;
    });
    if (!matches) {
      throw new Error(
        `JSON Schema violation at ${path}: expected ${types.join('|')}`,
      );
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      throw new Error(`JSON Schema violation at ${path}: string too short`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      throw new Error(`JSON Schema violation at ${path}: string too long`);
    }
    if (typeof schema.pattern === 'string') {
      const re = new RegExp(schema.pattern);
      if (!re.test(value)) {
        throw new Error(`JSON Schema violation at ${path}: pattern mismatch`);
      }
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      throw new Error(`JSON Schema violation at ${path}: below minimum`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      throw new Error(`JSON Schema violation at ${path}: above maximum`);
    }
  }

  if (value !== null && !Array.isArray(value) && typeof value === 'object') {
    const record = value;
    const required = Array.isArray(schema.required)
      ? schema.required.map(String)
      : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) {
        throw new Error(
          `JSON Schema violation at ${path}: missing required property ${key}`,
        );
      }
    }

    const properties =
      schema.properties &&
      !Array.isArray(schema.properties) &&
      typeof schema.properties === 'object'
        ? schema.properties
        : {};

    for (const [key, childSchema] of Object.entries(properties)) {
      if (
        Object.prototype.hasOwnProperty.call(record, key) &&
        childSchema &&
        !Array.isArray(childSchema) &&
        typeof childSchema === 'object'
      ) {
        assertJsonSchemaValue(childSchema, record[key], `${path}.${key}`);
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          throw new Error(
            `JSON Schema violation at ${path}: unexpected property ${key}`,
          );
        }
      }
    }
  }

  if (
    Array.isArray(value) &&
    schema.items &&
    !Array.isArray(schema.items) &&
    typeof schema.items === 'object'
  ) {
    value.forEach((entry, index) =>
      assertJsonSchemaValue(schema.items, entry, `${path}[${index}]`),
    );
  }
}

export function assertJsonObject(value, message) {
  return assertRecord(value, message);
}
