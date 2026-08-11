export type FilterValue = string | number | boolean | null;

export interface Operator {
  eq?: FilterValue;
  ne?: FilterValue;
  in?: FilterValue[];
  nin?: FilterValue[];
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  contains?: string;
  icontains?: string;
}

export type Filters = Record<string, unknown> & {
  AND?: Filters[];
  OR?: Filters[];
  NOT?: Filters;
};

const SCOPING_KEYS = ['user_id', 'agent_id', 'run_id'] as const;

/** main.py: search() rejects filters lacking any session scope. */
export function assertScoped(filters: Filters): void {
  const hasScope = SCOPING_KEYS.some(key => filters[key] !== undefined);
  if (!hasScope) {
    throw new Error('filters must include at least one of: user_id, agent_id, run_id');
  }
}

function field(key: string): string {
  return `json_extract(metadata, '$.${key}')`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, m => `\\${m}`);
}

function operatorClause(key: string, op: Operator, params: unknown[]): string {
  const parts: string[] = [];
  const col = field(key);

  if ('eq' in op) { parts.push(`${col} = ?`); params.push(op.eq); }
  if ('ne' in op) { parts.push(`${col} != ?`); params.push(op.ne); }
  if (op.in) {
    parts.push(`${col} IN (${op.in.map(() => '?').join(', ')})`);
    params.push(...op.in);
  }
  if (op.nin) {
    parts.push(`${col} NOT IN (${op.nin.map(() => '?').join(', ')})`);
    params.push(...op.nin);
  }
  if ('gt' in op) { parts.push(`${col} > ?`); params.push(op.gt); }
  if ('gte' in op) { parts.push(`${col} >= ?`); params.push(op.gte); }
  if ('lt' in op) { parts.push(`${col} < ?`); params.push(op.lt); }
  if ('lte' in op) { parts.push(`${col} <= ?`); params.push(op.lte); }
  if (op.contains !== undefined) {
    // GLOB is case-sensitive; LIKE is not.
    parts.push(`${col} GLOB ?`);
    params.push(`*${op.contains}*`);
  }
  if (op.icontains !== undefined) {
    parts.push(`${col} LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(op.icontains)}%`);
  }

  return parts.length > 1 ? `(${parts.join(' AND ')})` : (parts[0] ?? '1=1');
}

export function buildFilterSql(filters: Filters): { clause: string; params: unknown[] } {
  const params: unknown[] = [];
  const clause = build(filters, params);
  return { clause, params };
}

function build(filters: Filters, params: unknown[]): string {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined) continue;

    if (key === 'AND') {
      const sub = (value as Filters[]).map(f => build(f, params)).filter(Boolean);
      if (sub.length) parts.push(`(${sub.join(' AND ')})`);
      continue;
    }
    if (key === 'OR') {
      const sub = (value as Filters[]).map(f => build(f, params)).filter(Boolean);
      if (sub.length) parts.push(`(${sub.join(' OR ')})`);
      continue;
    }
    if (key === 'NOT') {
      const sub = build(value as Filters, params);
      if (sub) parts.push(`NOT (${sub})`);
      continue;
    }

    if (value === '*') {
      parts.push(`${field(key)} IS NOT NULL`);
      continue;
    }
    if (Array.isArray(value)) {
      parts.push(`${field(key)} IN (${value.map(() => '?').join(', ')})`);
      params.push(...value);
      continue;
    }
    if (value !== null && typeof value === 'object') {
      parts.push(operatorClause(key, value as Operator, params));
      continue;
    }
    parts.push(`${field(key)} = ?`);
    params.push(value);
  }

  return parts.join(' AND ');
}
