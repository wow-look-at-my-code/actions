// @ts-check
'use strict';

/**
 * ESLint rule: no-branded-primitive-comparison
 * ---------------------------------------------
 * Flags equality comparisons (`===`, `!==`, `==`, `!=`, and `switch`/`case`)
 * against a "branded primitive" / "fake string" type -- a primitive type fused
 * with object members, e.g.
 *
 *     type OutputStream = string & { json<T = any>(): T };
 *
 * At runtime a value of such a type is a *boxed* object (a `String`/`Number`/
 * `Boolean` wrapper instance), NOT a primitive. Therefore:
 *
 *     declare const s: OutputStream;
 *     s === "ready"   // ALWAYS false: object identity vs. a primitive literal
 *
 * The TypeScript type system happily lets you write this comparison (the
 * intersection is assignable on the `string` side), but it is a silent footgun:
 * the strict-equality check can never be true. This rule catches it.
 *
 * Implementation: this is a *type-aware* rule. It uses
 * `@typescript-eslint/utils` `ESLintUtils.getParserServices(context)` to obtain
 * the TypeScript `TypeChecker` and the AST<->TS-node map, then inspects the TS
 * type of each operand. So the consuming config MUST enable type information
 * (`parserOptions.projectService: true`, or a `project` tsconfig).
 */

const { ESLintUtils } = require('@typescript-eslint/utils');

// We talk to the TypeScript compiler API directly for the type-flag checks.
// `typescript` is a peer of @typescript-eslint and is always present wherever
// this rule can actually run (type-aware linting requires it).
const ts = require('typescript');

const createRule = ESLintUtils.RuleCreator(
	(name) =>
		`https://github.com/your-org/eslint-rules/blob/main/docs/${name}.md`,
);

/**
 * Primitive type flags whose presence in an intersection constituent means
 * "this constituent is the primitive side of a branded primitive". We include
 * the literal flags too (`StringLiteral`, `NumberLiteral`, `BooleanLiteral`)
 * because `"x" & { ... }` is just as boxed as `string & { ... }`.
 *
 * Note: `ts.TypeFlags.StringLike` is a convenience bitmask that already
 * includes `String | StringLiteral`; likewise `NumberLike` / `BooleanLike`.
 * We OR them explicitly for clarity and forward-compatibility.
 */
const PRIMITIVE_FLAGS =
	ts.TypeFlags.StringLike |
	ts.TypeFlags.NumberLike |
	ts.TypeFlags.BooleanLike;

/**
 * Classify the primitive *kind* wrapped by a branded primitive, so we can offer
 * a coercion suggestion that is actually correct for that kind:
 *   - a boxed String  -> `String(x)` recovers the primitive,
 *   - a boxed Number  -> `String(x)` would give "42", which is wrong; the right
 *                        coercion is `x.valueOf()` (or `Number(x)`),
 *   - a boxed Boolean -> `Boolean(x)` is always `true` for any object, also
 *                        wrong; the right coercion is `x.valueOf()`.
 *
 * Returns 'string' | 'number' | 'boolean' | 'mixed'. We walk every constituent
 * (descending into the boolean union-distribution case) and collect which
 * primitive flags appear; if exactly one kind appears we return it, otherwise
 * 'mixed' (and we fall back to the safe, universal `.valueOf()` suggestion).
 *
 * @param {import('typescript').Type} type
 * @returns {'string' | 'number' | 'boolean' | 'mixed'}
 */
function brandedPrimitiveKind(type) {
	let sawString = false;
	let sawNumber = false;
	let sawBoolean = false;

	/** @param {import('typescript').Type} t */
	const visit = (t) => {
		if (t.isUnion() || t.isIntersection()) {
			t.types.forEach(visit);
			return;
		}
		if (t.flags & ts.TypeFlags.StringLike) sawString = true;
		if (t.flags & ts.TypeFlags.NumberLike) sawNumber = true;
		if (t.flags & ts.TypeFlags.BooleanLike) sawBoolean = true;
	};
	visit(type);

	const kinds = [sawString, sawNumber, sawBoolean].filter(Boolean).length;
	if (kinds !== 1) return 'mixed';
	if (sawString) return 'string';
	if (sawNumber) return 'number';
	return 'boolean';
}

/**
 * A "plain primitive" for the *other* operand (the low-false-positive gate):
 * a string/number/boolean, a literal of one of those, or the bigint/symbol
 * primitives. A value of one of these types is genuinely a primitive at
 * runtime, so comparing it `===` against a boxed branded primitive is
 * guaranteed false. We deliberately also accept `null`/`undefined` operands as
 * "primitive-ish" since `boxedObject === null` is likewise always false.
 *
 * We require the WHOLE type to be primitive-ish: every constituent of a union
 * must be primitive-ish, and the type must not itself be a branded primitive.
 */
const PLAIN_PRIMITIVE_FLAGS =
	ts.TypeFlags.StringLike |
	ts.TypeFlags.NumberLike |
	ts.TypeFlags.BooleanLike |
	ts.TypeFlags.BigIntLike |
	ts.TypeFlags.ESSymbolLike |
	ts.TypeFlags.Null |
	ts.TypeFlags.Undefined;

/**
 * Does this individual (non-intersection, non-union) type contribute object
 * "members" -- i.e. is it the `{ ...members }` side of a branded primitive?
 *
 * We count it as member-contributing if it exposes any of:
 *   - own/declared properties (`getProperties()` non-empty),
 *   - call signatures (e.g. `string & (() => void)`),
 *   - construct signatures,
 *   - index signatures (string/number).
 *
 * IMPORTANT: a bare primitive does NOT report zero properties -- the checker
 * returns its *apparent* prototype members (e.g. `string` reports ~50:
 * `length`, `slice`, ...; `number` reports `toFixed`, etc.). So this helper
 * alone cannot distinguish the primitive side from the object side. The caller
 * (`isBrandedPrimitive`) handles that by only ever invoking this on a
 * constituent that is NOT itself flagged primitive -- the genuine
 * `{ ...members }` object literal/interface side. This function only answers
 * "does this object-typed constituent actually carry members?".
 *
 * @param {import('typescript').Type} t
 * @param {import('typescript').TypeChecker} checker
 * @returns {boolean}
 */
function contributesObjectMembers(t, checker) {
	// Properties declared by the object literal / interface side.
	if (t.getProperties().length > 0) return true;

	// Call / construct signatures (function-shaped intersection members).
	if (checker.getSignaturesOfType(t, ts.SignatureKind.Call).length > 0) {
		return true;
	}
	if (checker.getSignaturesOfType(t, ts.SignatureKind.Construct).length > 0) {
		return true;
	}

	// Index signatures: `string & { [k: string]: unknown }`.
	if (checker.getIndexInfoOfType(t, ts.IndexKind.String)) return true;
	if (checker.getIndexInfoOfType(t, ts.IndexKind.Number)) return true;

	return false;
}

/**
 * Is a single INTERSECTION type a branded primitive: does it have BOTH
 *   (a) at least one primitive constituent (string/number/boolean, incl.
 *       literals), AND
 *   (b) at least one constituent that contributes object members?
 *
 * That shape is exactly `primitive & { ...members }` -- a value that the type
 * system treats as a string/number/boolean but that is a boxed object at
 * runtime.
 *
 * @param {import('typescript').Type} type  an intersection type
 * @param {import('typescript').TypeChecker} checker
 * @returns {boolean}
 */
function intersectionIsBranded(type, checker) {
	if (!type.isIntersection()) return false;

	let hasPrimitiveSide = false;
	let hasObjectMemberSide = false;

	for (const constituent of type.types) {
		if (constituent.flags & PRIMITIVE_FLAGS) {
			hasPrimitiveSide = true;
		}
		// A constituent counts as the object "members" side only if it is NOT
		// itself flagged primitive. (The primitive side reports apparent
		// prototype members too, so without this guard `string` would be
		// double-counted as the object side.)
		if (
			!(constituent.flags & PRIMITIVE_FLAGS) &&
			contributesObjectMembers(constituent, checker)
		) {
			hasObjectMemberSide = true;
		}
	}

	return hasPrimitiveSide && hasObjectMemberSide;
}

/**
 * Is `type` a "branded primitive"?
 *
 * Two shapes qualify:
 *
 *  1. A direct intersection `primitive & { ...members }`
 *     (covers `string`/`number` brands -- see {@link intersectionIsBranded}).
 *
 *  2. A UNION in which *every* member is itself a branded-primitive
 *     intersection. This is the `boolean & { ...members }` case: TypeScript
 *     decomposes `boolean` into `true | false` and DISTRIBUTES the
 *     intersection, so `boolean & { __brand }` is represented as
 *     `(true & { __brand }) | (false & { __brand })` -- a union, not an
 *     intersection, at the top level. Each member is a boxed object at runtime,
 *     so the whole union is still an always-false comparison target. We require
 *     *every* member to be branded so we never misfire on a union like
 *     `OutputStream | string` (where the plain-`string` arm could legitimately
 *     match a literal).
 *
 * @param {import('typescript').Type} type
 * @param {import('typescript').TypeChecker} checker
 * @returns {boolean}
 */
function isBrandedPrimitive(type, checker) {
	if (type.isIntersection()) {
		return intersectionIsBranded(type, checker);
	}
	if (type.isUnion()) {
		return type.types.every((member) =>
			intersectionIsBranded(member, checker),
		);
	}
	return false;
}

/**
 * Is `type` a "plain primitive" suitable as the OTHER operand -- i.e. a value
 * that is genuinely a primitive (or null/undefined) at runtime, so that
 * `brandedPrimitive === thisOperand` is provably always false?
 *
 * Requirements:
 *   - it is NOT itself a branded primitive, and
 *   - every constituent (unwrapping unions) is one of the plain-primitive
 *     flags above. A bare `string`, the literal `"x"`, `1`, `true`, `null`,
 *     `undefined`, or a union of those all qualify.
 *
 * @param {import('typescript').Type} type
 * @param {import('typescript').TypeChecker} checker
 * @returns {boolean}
 */
function isPlainPrimitiveOperand(type, checker) {
	if (isBrandedPrimitive(type, checker)) return false;

	/** @param {import('typescript').Type} t */
	const everyConstituentIsPlain = (t) => {
		if (t.isUnion()) return t.types.every(everyConstituentIsPlain);
		// An intersection that is NOT a branded primitive but still mixes in an
		// object is not a plain primitive -- bail out to stay conservative.
		if (t.isIntersection()) return false;
		return (t.flags & PLAIN_PRIMITIVE_FLAGS) !== 0;
	};

	return everyConstituentIsPlain(type);
}

const rule = createRule({
	name: 'no-branded-primitive-comparison',
	meta: {
		type: 'problem',
		docs: {
			description:
				'Disallow equality comparisons against branded primitive ' +
				'("fake string/number/boolean") types, which are boxed objects ' +
				'at runtime and therefore always compare unequal to a primitive.',
		},
		hasSuggestions: true,
		schema: [],
		messages: {
			brandedComparison:
				"`{{typeText}}` is a branded primitive (a primitive intersected " +
				'with object members) -- at runtime it is a boxed object, so this ' +
				'comparison is always false. Coerce with `String(x)` (or read its ' +
				'primitive value) before comparing.',
			coerce:
				'Wrap the operand in `{{coercion}}` to compare its primitive value.',
		},
	},
	defaultOptions: [],
	create(context) {
		// Parser services give us the bridge from ESTree nodes to TS nodes and
		// the program's TypeChecker. This THROWS if type information is not
		// available -- which is the correct, loud failure for a type-aware rule
		// that was wired up without `projectService`/`project`.
		const services = ESLintUtils.getParserServices(context);
		const checker = services.program.getTypeChecker();

		/**
		 * Resolve the TS type of an ESTree node via parser services.
		 * @param {import('@typescript-eslint/utils').TSESTree.Node} node
		 */
		const typeOf = (node) => services.getTypeAtLocation(node);

		/**
		 * Inspect a pair of operand nodes. If exactly one side is a branded
		 * primitive and the other side is a plain primitive, report on the
		 * branded operand (the always-false footgun).
		 *
		 * @param {import('@typescript-eslint/utils').TSESTree.Node} left
		 * @param {import('@typescript-eslint/utils').TSESTree.Node} right
		 */
		function checkOperandPair(left, right) {
			const leftType = typeOf(left);
			const rightType = typeOf(right);

			const leftBranded = isBrandedPrimitive(leftType, checker);
			const rightBranded = isBrandedPrimitive(rightType, checker);

			// If BOTH sides are branded primitives, identity could in principle
			// hold (same boxed object), so we do not flag -- we only flag the
			// branded-vs-plain-primitive case that is *provably* always false.
			if (leftBranded === rightBranded) return;

			const brandedNode = leftBranded ? left : right;
			const brandedType = leftBranded ? leftType : rightType;
			const otherType = leftBranded ? rightType : leftType;

			// Precision gate: the OTHER operand must be a genuine primitive, so
			// the comparison is guaranteed false at runtime. This keeps us from
			// firing on `brandedString === someOtherObject`, where the result is
			// not necessarily constant.
			if (!isPlainPrimitiveOperand(otherType, checker)) return;

			const typeText = checker.typeToString(brandedType);

			// Tailor the coercion suggestion to the wrapped primitive kind so the
			// autofix is actually correct: `String(x)` only recovers the value of
			// a boxed *String*; for boxed Number/Boolean (and mixed) `.valueOf()`
			// is the universally-correct unwrap.
			const kind = brandedPrimitiveKind(brandedType);
			const sourceCode = context.sourceCode;
			const text = sourceCode.getText(brandedNode);
			const needsParens =
				brandedNode.type !== 'Identifier' &&
				brandedNode.type !== 'MemberExpression' &&
				brandedNode.type !== 'CallExpression';
			const wrapped = needsParens ? `(${text})` : text;
			const coercion =
				kind === 'string' ? `String(${text})` : `${wrapped}.valueOf()`;

			context.report({
				node: brandedNode,
				messageId: 'brandedComparison',
				data: { typeText },
				suggest: [
					{
						messageId: 'coerce',
						data: { coercion },
						fix(fixer) {
							return fixer.replaceText(brandedNode, coercion);
						},
					},
				],
			});
		}

		return {
			// `a === b`, `a !== b`, `a == b`, `a != b`
			BinaryExpression(node) {
				if (
					node.operator !== '===' &&
					node.operator !== '!==' &&
					node.operator !== '==' &&
					node.operator !== '!='
				) {
					return;
				}
				checkOperandPair(node.left, node.right);
			},

			// `switch (disc) { case test: ... }` -- each `case` test is compared
			// against the discriminant with `===` semantics at runtime.
			SwitchStatement(node) {
				for (const switchCase of node.cases) {
					if (switchCase.test == null) continue; // `default:` has no test
					checkOperandPair(node.discriminant, switchCase.test);
				}
			},
		};
	},
});

module.exports = rule;
