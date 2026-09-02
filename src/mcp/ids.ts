import { Buffer } from 'node:buffer';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_PUBLIC_PATTERN = /^e_([A-Za-z0-9_-]{22})$/;
const TEXT_PUBLIC_PATTERN = /^e~([A-Za-z0-9_-]+)$/;

function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replaceAll('-', ''), 'hex');
}

function uuidFromBytes(bytes: Buffer): string {
  if (bytes.length !== 16) throw new Error('Invalid compact memory id.');
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/** Return a short, reversible ID for the MCP surface. */
export function compactMemoryId(canonicalId: string): string {
  if (UUID_PATTERN.test(canonicalId)) {
    return `e_${uuidBytes(canonicalId).toString('base64url')}`;
  }
  return `e~${Buffer.from(canonicalId, 'utf8').toString('base64url')}`;
}

/** Resolve a public ID, while accepting canonical IDs for direct callers. */
export function expandMemoryId(publicId: string): string {
  const uuidMatch = UUID_PUBLIC_PATTERN.exec(publicId);
  if (uuidMatch) {
    try {
      return uuidFromBytes(Buffer.from(uuidMatch[1], 'base64url'));
    } catch {
      throw new Error('Invalid compact memory id.');
    }
  }

  if (publicId.startsWith('e_')) {
    throw new Error('Invalid compact memory id.');
  }

  const textMatch = TEXT_PUBLIC_PATTERN.exec(publicId);
  if (textMatch) {
    try {
      const canonicalId = Buffer.from(textMatch[1], 'base64url').toString('utf8');
      if (!canonicalId) throw new Error('empty id');
      return canonicalId;
    } catch {
      throw new Error('Invalid compact memory id.');
    }
  }

  if (publicId.startsWith('e~')) {
    throw new Error('Invalid compact memory id.');
  }

  return publicId;
}
