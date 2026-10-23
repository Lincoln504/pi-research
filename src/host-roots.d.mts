export const HOST_PACKAGES: string[];
export function candidateNodeModulesDirs(options?: { spawnNpm?: boolean }): string[];
export function findHostPackages(names?: string[]): { found: Map<string, string>; missing: string[] };
export function hostDirs(found: Map<string, string>): string[];
