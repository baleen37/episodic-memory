// Hand-maintained type declarations; keep in sync with check-dependencies.mjs
export function getNativeSqliteVecPackageName(platformName?: string, architecture?: string): string | null;
export function getNativeSqliteVecExtensionPath(root?: string, platformName?: string, architecture?: string): string | null;
export function checkDependencies(root?: string): { installed: boolean; missing: string[]; error?: string };
export function checkBuildNeeded(): { needsBuild: boolean; reason: string };
export function installDependencies(silent?: boolean): Promise<void>;
export function runBuild(): Promise<void>;
export function analyzeError(error: Error): { cause: string; fix: string };
