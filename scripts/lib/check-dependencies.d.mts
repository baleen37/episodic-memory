// Hand-maintained type declarations; keep in sync with check-dependencies.mjs
export function checkDependencies(): { installed: boolean; missing: string[]; error?: string };
export function checkBuildNeeded(): { needsBuild: boolean; reason: string };
export function installDependencies(silent?: boolean): Promise<void>;
export function runBuild(): Promise<void>;
export function analyzeError(error: Error): { cause: string; fix: string };
