#!/usr/bin/env node
process.title = "pi";
process.emitWarning = (() => { });
await import("./register-bedrock.js");
await import("../cli.js");
export {};
//# sourceMappingURL=cli.js.map