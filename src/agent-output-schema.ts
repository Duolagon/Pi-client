import { compile, type Validator } from "@earendil-works/pi-schema";
import { MAX_AGENT_OUTPUT } from "./delegation-limits.ts";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type AgentOutputSchema = Record<string, JsonValue>;

const MAX_SCHEMA_BYTES = 16 * 1024;
const MAX_DEPTH = 20;
const MAX_SCHEMA_NODES = 512;
const MAX_OUTPUT_NODES = 4096;
const schemaTypes = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const blockedKeywords = ["$ref", "$dynamicRef", "$recursiveRef", "pattern", "patternProperties"];
const schemaLists = ["allOf", "anyOf", "oneOf", "prefixItems"];
const schemaMaps = ["properties", "dependentSchemas", "$defs", "definitions"];
const schemaChildren = ["items", "additionalItems", "contains", "not", "if", "then", "else",
	"additionalProperties", "unevaluatedProperties", "unevaluatedItems", "propertyNames"];
const validators = new WeakMap<AgentOutputSchema, Validator>();

function isRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Bound the tree before serializing or walking a value received from another process. */
function boundedJson(value: unknown, maxBytes: number, maxNodes: number): JsonValue {
	let nodes = 0;
	let textBytes = 0;
	const addText = (text: string) => {
		textBytes += Buffer.byteLength(text);
		if (textBytes > maxBytes) throw new Error("JSON size limit exceeded");
	};
	const visit = (node: unknown, depth: number): void => {
		if (++nodes > maxNodes || depth > MAX_DEPTH) throw new Error("JSON structure limit exceeded");
		if (node === null || typeof node === "boolean" || (typeof node === "number" && Number.isFinite(node))) return;
		if (typeof node === "string") { addText(node); return; }
		if (Array.isArray(node)) {
			for (const child of node) visit(child, depth + 1);
			return;
		}
		if (!isRecord(node)) throw new Error("Expected a JSON value");
		for (const [key, child] of Object.entries(node)) {
			addText(key);
			visit(child, depth + 1);
		}
	};
	visit(value, 0);
	const encoded = JSON.stringify(value);
	if (Buffer.byteLength(encoded) > maxBytes) throw new Error("JSON size limit exceeded");
	return JSON.parse(encoded) as JsonValue;
}

function checkSchemaNode(value: unknown): void {
	if (typeof value === "boolean") return;
	if (!isRecord(value)) throw new Error("A schema node must be an object or boolean");
	for (const keyword of blockedKeywords)
		if (Object.hasOwn(value, keyword)) throw new Error(`Unsupported keyword ${keyword}; use inline constraints`);
	if (value.type !== undefined) {
		const types = Array.isArray(value.type) ? value.type : [value.type];
		if (!types.length || !types.every((type) => typeof type === "string" && schemaTypes.has(type)))
			throw new Error("Invalid schema type");
	}
	if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.length)) throw new Error("Invalid enum");
	if (value.required !== undefined && (!Array.isArray(value.required) || !value.required.every((key) => typeof key === "string")))
		throw new Error("Invalid required properties");
	for (const keyword of ["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties", "minContains", "maxContains"]) {
		const bound = value[keyword];
		if (bound !== undefined && (typeof bound !== "number" || !Number.isSafeInteger(bound) || bound < 0)) throw new Error(`Invalid ${keyword}`);
	}
	for (const keyword of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]) {
		const bound = value[keyword];
		if (bound !== undefined && (typeof bound !== "number" || (keyword === "multipleOf" && bound <= 0))) throw new Error(`Invalid ${keyword}`);
	}
	for (const keyword of schemaChildren)
		if (value[keyword] !== undefined) checkSchemaNode(value[keyword]);
	for (const keyword of schemaLists) {
		const branches = value[keyword];
		if (branches === undefined) continue;
		if (!Array.isArray(branches) || !branches.length) throw new Error(`Invalid ${keyword}`);
		for (const branch of branches) checkSchemaNode(branch);
	}
	for (const keyword of schemaMaps) {
		const entries = value[keyword];
		if (entries === undefined) continue;
		if (!isRecord(entries)) throw new Error(`Invalid ${keyword}`);
		for (const child of Object.values(entries)) checkSchemaNode(child);
	}
	if (value.dependencies !== undefined) {
		if (!isRecord(value.dependencies)) throw new Error("Invalid dependencies");
		for (const child of Object.values(value.dependencies)) {
			if (!Array.isArray(child)) checkSchemaNode(child);
			else if (!child.every((key) => typeof key === "string")) throw new Error("Invalid dependencies");
		}
	}
}

/** A self-contained JSON Schema from the parent, validated before task creation. */
export function parseAgentOutputSchema(value: unknown): AgentOutputSchema {
	try {
		const schema = boundedJson(value, MAX_SCHEMA_BYTES, MAX_SCHEMA_NODES);
		if (!isRecord(schema)) throw new Error("Expected a JSON Schema object");
		checkSchemaNode(schema);
		validators.set(schema as AgentOutputSchema, compile(schema));
		return schema as AgentOutputSchema;
	} catch (error) {
		throw new Error(`Invalid output_schema: ${error instanceof Error ? error.message.slice(0, 300) : "invalid schema"}`);
	}
}

export function validateAgentOutput(schema: AgentOutputSchema, value: unknown): JsonValue {
	const clean = boundedJson(value, MAX_AGENT_OUTPUT, MAX_OUTPUT_NODES);
	const validator = validators.get(schema) ?? compile(schema);
	if (!validator.check(clean)) throw new Error("JSON does not match output_schema");
	return clean;
}

export function parseAgentOutputText(text: string): unknown {
	if (Buffer.byteLength(text) > MAX_AGENT_OUTPUT) throw new Error("Structured result exceeds the output size limit");
	const clean = text.trim();
	const fenced = clean.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
	return JSON.parse(fenced?.[1] ?? clean);
}

/** ACP has no native schema parameter. Keep the retry focused on formatting the existing result. */
export function acpOutputInstruction(schema: AgentOutputSchema): string {
	return `Return the final result as a single JSON value matching this JSON Schema. Do not add prose or Markdown.\n${JSON.stringify(schema)}`;
}
