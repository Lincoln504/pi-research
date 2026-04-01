import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";
// Handle both default and named exports
const Ajv = AjvModule.default || AjvModule;
const addFormats = addFormatsModule.default || addFormatsModule;
// Detect if we're in a browser extension environment with strict CSP
// Chrome extensions with Manifest V3 don't allow eval/Function constructor
const isBrowserExtension = typeof globalThis !== "undefined" && globalThis.chrome?.runtime?.id !== undefined;
function canUseRuntimeCodegen() {
    if (isBrowserExtension) {
        return false;
    }
    try {
        new Function("return true;");
        return true;
    }
    catch {
        return false;
    }
}
// Create a singleton AJV instance with formats only when runtime code generation is available.
let ajv = null;
if (canUseRuntimeCodegen()) {
    try {
        ajv = new Ajv({
            allErrors: true,
            strict: false,
            coerceTypes: true,
        });
        addFormats(ajv);
    }
    catch (_e) {
        console.warn("AJV validation disabled due to CSP restrictions");
    }
}
/**
 * Finds a tool by name and validates the tool call arguments against its TypeBox schema
 * @param tools Array of tool definitions
 * @param toolCall The tool call from the LLM
 * @returns The validated arguments
 * @throws Error if tool is not found or validation fails
 */
export function validateToolCall(tools, toolCall) {
    const tool = tools.find((t) => t.name === toolCall.name);
    if (!tool) {
        throw new Error(`Tool "${toolCall.name}" not found`);
    }
    return validateToolArguments(tool, toolCall);
}
/**
 * Validates tool call arguments against the tool's TypeBox schema
 * @param tool The tool definition with TypeBox schema
 * @param toolCall The tool call from the LLM
 * @returns The validated (and potentially coerced) arguments
 * @throws Error with formatted message if validation fails
 */
export function validateToolArguments(tool, toolCall) {
    // Skip validation in environments where runtime code generation is unavailable.
    if (!ajv || !canUseRuntimeCodegen()) {
        return toolCall.arguments;
    }
    // Compile the schema.
    const validate = ajv.compile(tool.parameters);
    // Clone arguments so AJV can safely mutate for type coercion
    const args = structuredClone(toolCall.arguments);
    // Validate the arguments (AJV mutates args in-place for type coercion)
    if (validate(args)) {
        return args;
    }
    // Format validation errors nicely
    const errors = validate.errors
        ?.map((err) => {
        const path = err.instancePath ? err.instancePath.substring(1) : err.params.missingProperty || "root";
        return `  - ${path}: ${err.message}`;
    })
        .join("\n") || "Unknown validation error";
    const errorMessage = `Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`;
    throw new Error(errorMessage);
}
//# sourceMappingURL=validation.js.map