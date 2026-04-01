import { execFile, spawnSync } from "child_process";
import { existsSync, readFileSync, statSync, watch } from "fs";
import { dirname, join, resolve } from "path";
/**
 * Find git metadata paths by walking up from cwd.
 * Handles both regular git repos (.git is a directory) and worktrees (.git is a file).
 */
function findGitPaths() {
    let dir = process.cwd();
    while (true) {
        const gitPath = join(dir, ".git");
        if (existsSync(gitPath)) {
            try {
                const stat = statSync(gitPath);
                if (stat.isFile()) {
                    const content = readFileSync(gitPath, "utf8").trim();
                    if (content.startsWith("gitdir: ")) {
                        const gitDir = resolve(dir, content.slice(8).trim());
                        const headPath = join(gitDir, "HEAD");
                        if (!existsSync(headPath))
                            return null;
                        const commonDirPath = join(gitDir, "commondir");
                        const commonGitDir = existsSync(commonDirPath)
                            ? resolve(gitDir, readFileSync(commonDirPath, "utf8").trim())
                            : gitDir;
                        return { repoDir: dir, commonGitDir, headPath };
                    }
                }
                else if (stat.isDirectory()) {
                    const headPath = join(gitPath, "HEAD");
                    if (!existsSync(headPath))
                        return null;
                    return { repoDir: dir, commonGitDir: gitPath, headPath };
                }
            }
            catch {
                return null;
            }
        }
        const parent = dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
}
/** Ask git for the current branch. Returns null on detached HEAD or if git is unavailable. */
function resolveBranchWithGitSync(repoDir) {
    const result = spawnSync("git", ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], {
        cwd: repoDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    });
    const branch = result.status === 0 ? result.stdout.trim() : "";
    return branch || null;
}
/** Ask git for the current branch asynchronously. Returns null on detached HEAD or if git is unavailable. */
function resolveBranchWithGitAsync(repoDir) {
    return new Promise((resolvePromise) => {
        execFile("git", ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], {
            cwd: repoDir,
            encoding: "utf8",
        }, (error, stdout) => {
            if (error) {
                resolvePromise(null);
                return;
            }
            const branch = stdout.trim();
            resolvePromise(branch || null);
        });
    });
}
/**
 * Provides git branch and extension statuses - data not otherwise accessible to extensions.
 * Token stats, model info available via ctx.sessionManager and ctx.model.
 */
export class FooterDataProvider {
    static WATCH_DEBOUNCE_MS = 500;
    extensionStatuses = new Map();
    cachedBranch = undefined;
    gitPaths = undefined;
    headWatcher = null;
    reftableWatcher = null;
    branchChangeCallbacks = new Set();
    availableProviderCount = 0;
    refreshTimer = null;
    refreshInFlight = false;
    refreshPending = false;
    disposed = false;
    constructor() {
        this.gitPaths = findGitPaths();
        this.setupGitWatcher();
    }
    /** Current git branch, null if not in repo, "detached" if detached HEAD */
    getGitBranch() {
        if (this.cachedBranch === undefined) {
            this.cachedBranch = this.resolveGitBranchSync();
        }
        return this.cachedBranch;
    }
    /** Extension status texts set via ctx.ui.setStatus() */
    getExtensionStatuses() {
        return this.extensionStatuses;
    }
    /** Subscribe to git branch changes. Returns unsubscribe function. */
    onBranchChange(callback) {
        this.branchChangeCallbacks.add(callback);
        return () => this.branchChangeCallbacks.delete(callback);
    }
    /** Internal: set extension status */
    setExtensionStatus(key, text) {
        if (text === undefined) {
            this.extensionStatuses.delete(key);
        }
        else {
            this.extensionStatuses.set(key, text);
        }
    }
    /** Internal: clear extension statuses */
    clearExtensionStatuses() {
        this.extensionStatuses.clear();
    }
    /** Number of unique providers with available models (for footer display) */
    getAvailableProviderCount() {
        return this.availableProviderCount;
    }
    /** Internal: update available provider count */
    setAvailableProviderCount(count) {
        this.availableProviderCount = count;
    }
    /** Internal: cleanup */
    dispose() {
        this.disposed = true;
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        if (this.headWatcher) {
            this.headWatcher.close();
            this.headWatcher = null;
        }
        if (this.reftableWatcher) {
            this.reftableWatcher.close();
            this.reftableWatcher = null;
        }
        this.branchChangeCallbacks.clear();
    }
    notifyBranchChange() {
        for (const cb of this.branchChangeCallbacks)
            cb();
    }
    scheduleRefresh() {
        if (this.disposed)
            return;
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = null;
            void this.refreshGitBranchAsync();
        }, FooterDataProvider.WATCH_DEBOUNCE_MS);
    }
    async refreshGitBranchAsync() {
        if (this.disposed)
            return;
        if (this.refreshInFlight) {
            this.refreshPending = true;
            return;
        }
        this.refreshInFlight = true;
        try {
            const nextBranch = await this.resolveGitBranchAsync();
            if (this.disposed)
                return;
            if (this.cachedBranch !== undefined && this.cachedBranch !== nextBranch) {
                this.cachedBranch = nextBranch;
                this.notifyBranchChange();
                return;
            }
            this.cachedBranch = nextBranch;
        }
        finally {
            this.refreshInFlight = false;
            if (this.refreshPending && !this.disposed) {
                this.refreshPending = false;
                this.scheduleRefresh();
            }
        }
    }
    resolveGitBranchSync() {
        try {
            if (!this.gitPaths)
                return null;
            const content = readFileSync(this.gitPaths.headPath, "utf8").trim();
            if (content.startsWith("ref: refs/heads/")) {
                const branch = content.slice(16);
                return branch === ".invalid" ? (resolveBranchWithGitSync(this.gitPaths.repoDir) ?? "detached") : branch;
            }
            return "detached";
        }
        catch {
            return null;
        }
    }
    async resolveGitBranchAsync() {
        try {
            if (!this.gitPaths)
                return null;
            const content = readFileSync(this.gitPaths.headPath, "utf8").trim();
            if (content.startsWith("ref: refs/heads/")) {
                const branch = content.slice(16);
                return branch === ".invalid"
                    ? ((await resolveBranchWithGitAsync(this.gitPaths.repoDir)) ?? "detached")
                    : branch;
            }
            return "detached";
        }
        catch {
            return null;
        }
    }
    setupGitWatcher() {
        if (!this.gitPaths)
            return;
        // Watch the directory containing HEAD, not HEAD itself.
        // Git uses atomic writes (write temp, rename over HEAD), which changes the inode.
        // fs.watch on a file stops working after the inode changes.
        try {
            this.headWatcher = watch(dirname(this.gitPaths.headPath), (_eventType, filename) => {
                if (!filename || filename.toString() === "HEAD") {
                    this.scheduleRefresh();
                }
            });
        }
        catch {
            // Silently fail if we can't watch
        }
        // In reftable repos, branch switches update files in the reftable directory
        // instead of HEAD. Watch it separately so the footer picks up those changes.
        const reftableDir = join(this.gitPaths.commonGitDir, "reftable");
        if (existsSync(reftableDir)) {
            try {
                this.reftableWatcher = watch(reftableDir, () => {
                    this.scheduleRefresh();
                });
            }
            catch {
                // Silently fail if we can't watch
            }
        }
    }
}
//# sourceMappingURL=footer-data-provider.js.map