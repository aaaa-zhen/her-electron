/**
 * Base class for all Her tools.
 *
 * Each tool subclass must define:
 *   - name        (string)
 *   - description (string)
 *   - input_schema (object — JSON Schema)
 *   - execute(input, ctx)  → Promise<string | { content, is_error? }>
 *
 * Optional overrides:
 *   - timeout     (ms, default 30 000)
 */
class BaseTool {
  /** Override in subclass */
  get name() { throw new Error("Tool must define 'name'"); }
  get description() { throw new Error("Tool must define 'description'"); }
  get input_schema() { throw new Error("Tool must define 'input_schema'"); }
  get timeout() { return 30000; }

  /** Return the Anthropic-compatible tool definition */
  definition() {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  /**
   * Validate input against input_schema.
   * Returns null if valid, or a string describing the first error.
   */
  validate(input) {
    const schema = this.input_schema;
    if (!schema || schema.type !== "object") return null;

    // Check required fields
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (input[key] === undefined || input[key] === null) {
          return `Missing required parameter: ${key}`;
        }
      }
    }

    // Check property types (lightweight — not a full JSON Schema validator)
    if (schema.properties) {
      for (const [key, prop] of Object.entries(schema.properties)) {
        const value = input[key];
        if (value === undefined || value === null) continue;
        if (prop.type === "string" && typeof value !== "string") {
          return `Parameter "${key}" must be a string`;
        }
        if (prop.type === "number" && typeof value !== "number") {
          return `Parameter "${key}" must be a number`;
        }
        if (prop.type === "integer" && (typeof value !== "number" || !Number.isInteger(value))) {
          return `Parameter "${key}" must be an integer`;
        }
        if (prop.type === "boolean" && typeof value !== "boolean") {
          return `Parameter "${key}" must be a boolean`;
        }
        if (prop.type === "array" && !Array.isArray(value)) {
          return `Parameter "${key}" must be an array`;
        }
        if (prop.type === "object" && (typeof value !== "object" || Array.isArray(value))) {
          return `Parameter "${key}" must be an object`;
        }
        if (prop.enum && !prop.enum.includes(value)) {
          return `Parameter "${key}" must be one of: ${prop.enum.join(", ")}`;
        }
      }
    }

    return null;
  }

  /**
   * Execute the tool.  Override in subclass.
   * @param {object} input - validated tool input
   * @param {object} ctx   - shared context { paths, stores, emit, execAsync, ... }
   * @returns {Promise<string|{content:string, is_error?:boolean}>}
   */
  async execute(input, ctx) {
    throw new Error(`Tool "${this.name}" has no execute() implementation`);
  }
}

module.exports = { BaseTool };
