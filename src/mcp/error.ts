/**
 * MCP error handling utilities.
 */

/**
 * Convert unknown error to user-friendly error message.
 */
export function handleError(error: unknown): string {
  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }
  return `Error: ${String(error)}`;
}
