export interface SchemaValidationResult {
	valid: boolean;
	errors: string[];
}

function typeOfValue(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

/** Validate a value against a JSON Schema subset used by StructuredOutput. */
export function validateJsonSchema(
	schema: unknown,
	value: unknown,
	path = "$",
	depth = 0,
): SchemaValidationResult {
	if (depth > 32) return { valid: false, errors: [`${path}: schema recursion depth exceeded`] };
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		return { valid: false, errors: [`${path}: invalid JSON schema`] };
	}
	const def = schema as Record<string, unknown>;
	const errors: string[] = [];

	if (Array.isArray(def.enum)) {
		const matched = def.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value));
		if (!matched) {
			errors.push(`${path}: value must be one of ${JSON.stringify(def.enum)}`);
			return { valid: false, errors };
		}
	}

	if (def.type !== undefined) {
		const allowed = Array.isArray(def.type) ? (def.type as unknown[]).map(String) : [String(def.type)];
		const actual = typeOfValue(value);
		const matchesType = allowed.some((expected) => {
			if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
			return actual === expected;
		});
		if (!matchesType) {
			errors.push(`${path}: expected type ${allowed.join("|")}, got ${actual}`);
			return { valid: false, errors };
		}
	}

	if (typeof value === "string") {
		if (typeof def.minLength === "number" && value.length < def.minLength) {
			errors.push(`${path}: string length ${value.length} < minLength ${def.minLength}`);
		}
		if (typeof def.maxLength === "number" && value.length > def.maxLength) {
			errors.push(`${path}: string length ${value.length} > maxLength ${def.maxLength}`);
		}
	}

	if (typeof value === "number") {
		if (typeof def.minimum === "number" && value < def.minimum) {
			errors.push(`${path}: number ${value} < minimum ${def.minimum}`);
		}
		if (typeof def.maximum === "number" && value > def.maximum) {
			errors.push(`${path}: number ${value} > maximum ${def.maximum}`);
		}
	}

	if (Array.isArray(value)) {
		if (typeof def.minItems === "number" && value.length < def.minItems) {
			errors.push(`${path}: array length ${value.length} < minItems ${def.minItems}`);
		}
		if (typeof def.maxItems === "number" && value.length > def.maxItems) {
			errors.push(`${path}: array length ${value.length} > maxItems ${def.maxItems}`);
		}
		if (def.items && typeof def.items === "object") {
			for (let i = 0; i < value.length; i++) {
				const child = validateJsonSchema(def.items, value[i], `${path}[${i}]`, depth + 1);
				errors.push(...child.errors);
			}
		}
	}

	if (value && typeof value === "object" && !Array.isArray(value)) {
		const obj = value as Record<string, unknown>;
		const properties =
			def.properties && typeof def.properties === "object" && !Array.isArray(def.properties)
				? (def.properties as Record<string, unknown>)
				: undefined;
		if (Array.isArray(def.required)) {
			for (const reqKey of def.required) {
				if (typeof reqKey === "string" && !(reqKey in obj)) {
					errors.push(`${path}: missing required property '${reqKey}'`);
				}
			}
		}
		if (properties) {
			for (const [key, propSchema] of Object.entries(properties)) {
				if (key in obj) {
					const child = validateJsonSchema(propSchema, obj[key], `${path}.${key}`, depth + 1);
					errors.push(...child.errors);
				}
			}
			if (def.additionalProperties === false) {
				for (const key of Object.keys(obj)) {
					if (!(key in properties)) {
						errors.push(`${path}: unexpected additional property '${key}'`);
					}
				}
			}
		}
	}

	return { valid: errors.length === 0, errors };
}
