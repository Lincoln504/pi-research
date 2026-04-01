import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { globSync } from "glob";
import path from "path";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { ensureTool } from "../../utils/tools-manager.js";
import { resolveToCwd } from "./path-utils.js";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.js";
function toPosixPath(value) {
    return value.split(path.sep).join("/");
}
const findSchema = Type.Object({
    pattern: Type.String({
        description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
    }),
    path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
});
const DEFAULT_LIMIT = 1000;
const defaultFindOperations = {
    exists: existsSync,
    // This is a placeholder. Actual fd execution happens in execute() when no custom glob is provided.
    glob: () => [],
};
function formatFindCall(args, theme) {
    const pattern = str(args?.pattern);
    const rawPath = str(args?.path);
    const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
    const limit = args?.limit;
    const invalidArg = invalidArgText(theme);
    let text = theme.fg("toolTitle", theme.bold("find")) +
        " " +
        (pattern === null ? invalidArg : theme.fg("accent", pattern || "")) +
        theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
    if (limit !== undefined) {
        text += theme.fg("toolOutput", ` (limit ${limit})`);
    }
    return text;
}
function formatFindResult(result, options, theme, showImages) {
    const output = getTextOutput(result, showImages).trim();
    let text = "";
    if (output) {
        const lines = output.split("\n");
        const maxLines = options.expanded ? lines.length : 20;
        const displayLines = lines.slice(0, maxLines);
        const remaining = lines.length - maxLines;
        text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
        if (remaining > 0) {
            text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
        }
    }
    const resultLimit = result.details?.resultLimitReached;
    const truncation = result.details?.truncation;
    if (resultLimit || truncation?.truncated) {
        const warnings = [];
        if (resultLimit)
            warnings.push(`${resultLimit} results limit`);
        if (truncation?.truncated)
            warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
        text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
    }
    return text;
}
export function createFindToolDefinition(cwd, options) {
    const customOps = options?.operations;
    return {
        name: "find",
        label: "find",
        description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
        promptSnippet: "Find files by glob pattern (respects .gitignore)",
        parameters: findSchema,
        async execute(_toolCallId, { pattern, path: searchDir, limit }, signal, _onUpdate, _ctx) {
            return new Promise((resolve, reject) => {
                if (signal?.aborted) {
                    reject(new Error("Operation aborted"));
                    return;
                }
                const onAbort = () => reject(new Error("Operation aborted"));
                signal?.addEventListener("abort", onAbort, { once: true });
                (async () => {
                    try {
                        const searchPath = resolveToCwd(searchDir || ".", cwd);
                        const effectiveLimit = limit ?? DEFAULT_LIMIT;
                        const ops = customOps ?? defaultFindOperations;
                        // If custom operations provide glob(), use that instead of fd.
                        if (customOps?.glob) {
                            if (!(await ops.exists(searchPath))) {
                                reject(new Error(`Path not found: ${searchPath}`));
                                return;
                            }
                            const results = await ops.glob(pattern, searchPath, {
                                ignore: ["**/node_modules/**", "**/.git/**"],
                                limit: effectiveLimit,
                            });
                            signal?.removeEventListener("abort", onAbort);
                            if (results.length === 0) {
                                resolve({
                                    content: [{ type: "text", text: "No files found matching pattern" }],
                                    details: undefined,
                                });
                                return;
                            }
                            // Relativize paths against the search root for stable output.
                            const relativized = results.map((p) => {
                                if (p.startsWith(searchPath))
                                    return toPosixPath(p.slice(searchPath.length + 1));
                                return toPosixPath(path.relative(searchPath, p));
                            });
                            const resultLimitReached = relativized.length >= effectiveLimit;
                            const rawOutput = relativized.join("\n");
                            const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
                            let resultOutput = truncation.content;
                            const details = {};
                            const notices = [];
                            if (resultLimitReached) {
                                notices.push(`${effectiveLimit} results limit reached`);
                                details.resultLimitReached = effectiveLimit;
                            }
                            if (truncation.truncated) {
                                notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
                                details.truncation = truncation;
                            }
                            if (notices.length > 0) {
                                resultOutput += `\n\n[${notices.join(". ")}]`;
                            }
                            resolve({
                                content: [{ type: "text", text: resultOutput }],
                                details: Object.keys(details).length > 0 ? details : undefined,
                            });
                            return;
                        }
                        // Default implementation uses fd.
                        const fdPath = await ensureTool("fd", true);
                        if (!fdPath) {
                            reject(new Error("fd is not available and could not be downloaded"));
                            return;
                        }
                        // Build fd arguments.
                        const args = [
                            "--glob",
                            "--color=never",
                            "--hidden",
                            "--max-results",
                            String(effectiveLimit),
                        ];
                        // Include .gitignore files from the search tree.
                        const gitignoreFiles = new Set();
                        const rootGitignore = path.join(searchPath, ".gitignore");
                        if (existsSync(rootGitignore))
                            gitignoreFiles.add(rootGitignore);
                        try {
                            const nestedGitignores = globSync("**/.gitignore", {
                                cwd: searchPath,
                                dot: true,
                                absolute: true,
                                ignore: ["**/node_modules/**", "**/.git/**"],
                            });
                            for (const file of nestedGitignores)
                                gitignoreFiles.add(file);
                        }
                        catch {
                            // ignore
                        }
                        for (const gitignorePath of gitignoreFiles)
                            args.push("--ignore-file", gitignorePath);
                        args.push(pattern, searchPath);
                        const result = spawnSync(fdPath, args, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
                        signal?.removeEventListener("abort", onAbort);
                        if (result.error) {
                            reject(new Error(`Failed to run fd: ${result.error.message}`));
                            return;
                        }
                        const output = result.stdout?.trim() || "";
                        if (result.status !== 0) {
                            const errorMsg = result.stderr?.trim() || `fd exited with code ${result.status}`;
                            if (!output) {
                                reject(new Error(errorMsg));
                                return;
                            }
                        }
                        if (!output) {
                            resolve({
                                content: [{ type: "text", text: "No files found matching pattern" }],
                                details: undefined,
                            });
                            return;
                        }
                        const lines = output.split("\n");
                        const relativized = [];
                        for (const rawLine of lines) {
                            const line = rawLine.replace(/\r$/, "").trim();
                            if (!line)
                                continue;
                            const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
                            let relativePath = line;
                            if (line.startsWith(searchPath)) {
                                relativePath = line.slice(searchPath.length + 1);
                            }
                            else {
                                relativePath = path.relative(searchPath, line);
                            }
                            if (hadTrailingSlash && !relativePath.endsWith("/"))
                                relativePath += "/";
                            relativized.push(toPosixPath(relativePath));
                        }
                        const resultLimitReached = relativized.length >= effectiveLimit;
                        const rawOutput = relativized.join("\n");
                        const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
                        let resultOutput = truncation.content;
                        const details = {};
                        const notices = [];
                        if (resultLimitReached) {
                            notices.push(`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
                            details.resultLimitReached = effectiveLimit;
                        }
                        if (truncation.truncated) {
                            notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
                            details.truncation = truncation;
                        }
                        if (notices.length > 0) {
                            resultOutput += `\n\n[${notices.join(". ")}]`;
                        }
                        resolve({
                            content: [{ type: "text", text: resultOutput }],
                            details: Object.keys(details).length > 0 ? details : undefined,
                        });
                    }
                    catch (e) {
                        signal?.removeEventListener("abort", onAbort);
                        reject(e);
                    }
                })();
            });
        },
        renderCall(args, theme, context) {
            const text = context.lastComponent ?? new Text("", 0, 0);
            text.setText(formatFindCall(args, theme));
            return text;
        },
        renderResult(result, options, theme, context) {
            const text = context.lastComponent ?? new Text("", 0, 0);
            text.setText(formatFindResult(result, options, theme, context.showImages));
            return text;
        },
    };
}
export function createFindTool(cwd, options) {
    return wrapToolDefinition(createFindToolDefinition(cwd, options));
}
/** Default find tool using process.cwd() for backwards compatibility. */
export const findToolDefinition = createFindToolDefinition(process.cwd());
export const findTool = createFindTool(process.cwd());
//# sourceMappingURL=find.js.map