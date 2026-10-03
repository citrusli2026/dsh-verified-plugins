/**
 * schema.ts — a minimal JSON Schema (2020-12 subset) validator.
 *
 * Zero dependencies, deliberately. This project verifies third-party supply
 * chains; growing its own dependency tree to validate a document would be a
 * poor argument. The subset is exactly what
 * schemas/dsh.plugin.report.v1.schema.json uses:
 *
 *   type, const, enum, required, properties, additionalProperties,
 *   items, minItems, minimum, pattern, $ref (#/$defs/...)
 *
 * Anything outside the subset is *reported as unsupported* rather than
 * silently ignored, so the schema cannot quietly outgrow this validator.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ValidationIssue {
  path: string;
  message: string;
}

type Schema = Record<string, unknown>;

const SUPPORTED_KEYWORDS = new Set([
  '$schema',
  '$id',
  '$defs',
  '$ref',
  'title',
  'description',
  'type',
  'const',
  'enum',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'minItems',
  'minimum',
  'pattern',
]);

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function resolveRef(ref: string, root: Schema): Schema | undefined {
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = root;
  for (const rawPart of ref.slice(2).split('/')) {
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node as Schema | undefined;
}

/** Reports schema keywords this validator does not implement. */
export function findUnsupportedKeywords(schema: Schema, path = '$'): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      issues.push({ path, message: `unsupported schema keyword "${key}" — implement it or remove it` });
      continue;
    }
    if (key === 'properties' && value && typeof value === 'object') {
      for (const [prop, sub] of Object.entries(value as Record<string, Schema>)) {
        issues.push(...findUnsupportedKeywords(sub, `${path}.properties.${prop}`));
      }
    }
    if (key === '$defs' && value && typeof value === 'object') {
      for (const [name, sub] of Object.entries(value as Record<string, Schema>)) {
        issues.push(...findUnsupportedKeywords(sub, `${path}.$defs.${name}`));
      }
    }
    if (key === 'items' && value && typeof value === 'object') {
      issues.push(...findUnsupportedKeywords(value as Schema, `${path}.items`));
    }
  }
  return issues;
}

export function validateAgainst(value: unknown, schema: Schema, root: Schema = schema, path = '$'): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (typeof schema.$ref === 'string') {
    const target = resolveRef(schema.$ref, root);
    if (!target) {
      issues.push({ path, message: `unresolvable $ref "${schema.$ref}"` });
      return issues;
    }
    return validateAgainst(value, target, root, path);
  }

  if (schema.const !== undefined) {
    if (JSON.stringify(value) !== JSON.stringify(schema.const)) {
      issues.push({ path, message: `expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}` });
    }
  }

  if (Array.isArray(schema.enum)) {
    const allowed = schema.enum as unknown[];
    if (!allowed.some((a) => JSON.stringify(a) === JSON.stringify(value))) {
      issues.push({ path, message: `value ${JSON.stringify(value)} is not one of ${allowed.map((a) => JSON.stringify(a)).join(', ')}` });
    }
  }

  if (schema.type !== undefined) {
    const allowed = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
    const actual = typeOf(value);
    const ok =
      allowed.includes(actual) ||
      (actual === 'integer' && allowed.includes('number')) ||
      (actual === 'number' && Number.isInteger(value) && allowed.includes('integer'));
    if (!ok) {
      issues.push({ path, message: `expected type ${allowed.join(' | ')}, got ${actual}` });
      return issues;
    }
  }

  if (typeof value === 'string' && typeof schema.pattern === 'string') {
    if (!new RegExp(schema.pattern).test(value)) {
      issues.push({ path, message: `value ${JSON.stringify(value)} does not match pattern ${schema.pattern}` });
    }
  }

  if (typeof value === 'number' && typeof schema.minimum === 'number' && value < schema.minimum) {
    issues.push({ path, message: `value ${value} is below minimum ${schema.minimum}` });
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      issues.push({ path, message: `expected at least ${schema.minItems} item(s), got ${value.length}` });
    }
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, i) => {
        issues.push(...validateAgainst(item, schema.items as Schema, root, `${path}[${i}]`));
      });
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>;

    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!Object.hasOwn(record, key)) issues.push({ path, message: `missing required property "${key}"` });
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(props, key)) {
          issues.push({ path, message: `unexpected property "${key}"` });
        }
      }
    }

    for (const [key, subSchema] of Object.entries(props)) {
      if (!Object.hasOwn(record, key)) continue;
      issues.push(...validateAgainst(record[key], subSchema, root, `${path}.${key}`));
    }
  }

  return issues;
}
