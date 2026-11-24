import type { ExternalApprovalRequest, ExternalProvider } from "../external-types.ts";

interface QuestionField {
	id: string;
	label: string;
	description?: string;
	options: { value: string; label: string }[];
	multiple: boolean;
	required: boolean;
	min: number;
	max: number;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function schemaOptions(node: Record<string, unknown>): QuestionField["options"] {
	if (Array.isArray(node.enum)) return node.enum.flatMap((value) => text(value) ? [{ value, label: value }] : []);
	const variants = node.oneOf ?? node.anyOf;
	if (!Array.isArray(variants)) return [];
	return variants.flatMap((value) => {
		const option = record(value);
		const key = text(option.const);
		return key ? [{ value: key, label: text(option.title) ?? key }] : [];
	});
}

/** Preserve native answer keys. Claude identifies answers by question text; Codex uses IDs. */
export function externalQuestionFields(request: ExternalApprovalRequest, executor: ExternalProvider): QuestionField[] | undefined {
	if (request.kind !== "question" || request.options?.length) return undefined;
	const questions = request.input.questions;
	if (Array.isArray(questions) && questions.length > 0 && questions.length <= 100) {
		const fields = questions.flatMap((value): QuestionField[] => {
			const question = record(value);
			const label = text(question.question);
			const id = executor === "claude" ? label : text(question.id);
			if (!label || !id || id.length > 500) return [];
			const options = Array.isArray(question.options) ? question.options.flatMap((item) => {
				const option = text(record(item).label);
				return option ? [{ value: option, label: option }] : [];
			}) : [];
			const multiple = question.multiSelect === true;
			if (multiple && !options.length) return [];
			return [{ id, label, description: text(question.header), options, required: true, multiple, min: 1, max: 100 }];
		});
		return fields.length === questions.length && new Set(fields.map((item) => item.id)).size === fields.length ? fields : undefined;
	}
	const schema = record(request.input.requestedSchema);
	if (schema.type !== "object") return undefined;
	const fields: QuestionField[] = [];
	const properties = Object.entries(record(schema.properties));
	if (!properties.length || properties.length > 100) return undefined;
	for (const [id, value] of properties) {
		const node = record(value);
		const multiple = node.type === "array";
		const options = schemaOptions(multiple ? record(node.items) : node);
		if ((!multiple && node.type !== "string") || (multiple && !options.length) || !text(id) || id.length > 500) return undefined;
		const required = Array.isArray(schema.required) && schema.required.includes(id);
		const min = multiple && typeof node.minItems === "number" && Number.isInteger(node.minItems) ? Math.max(0, node.minItems) : 0;
		const max = multiple && typeof node.maxItems === "number" && Number.isInteger(node.maxItems) ? Math.min(100, node.maxItems) : 100;
		fields.push({ id, label: text(node.title) ?? id, description: text(node.description), options, required, multiple,
			min: required ? Math.max(1, min) : min, max });
	}
	return fields;
}
