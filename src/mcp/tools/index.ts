/**
 * MCP tool definitions.
 */

export { searchTool } from './search.js';
export { getObservationsTool } from './get-observations.js';
export { readTool } from './read.js';

import { searchTool } from './search.js';
import { getObservationsTool } from './get-observations.js';
import { readTool } from './read.js';

export const allTools = [searchTool, getObservationsTool, readTool];
