/**
 * ESLint rule: no-callable-primitive-intersection
 * --------------------------------------------------------------------------
 * Flags a TypeScript *type definition* that intersects a primitive
 * (`string` / `number` / `boolean` / `bigint`, or a string/number/boolean
 * literal type) with an inline object type that contains a CALLABLE member
 * (a method, call/construct signature, or a function-typed property).
 *
 *   type OutputStream = string & { json<T>(): T };   // <-- flagged
 *
 * WHY THIS IS A BUG MAGNET
 * ------------------------
 * A callable member (`json<T>(): T`) cannot exist on a primitive value -- a raw
 * `string` has no own callable properties. To satisfy the type at runtime, the
 * value MUST be a boxed wrapper object (`Object.assign(new String(value), {...})`).
 * That boxed object lies about being a primitive:
 *
 *   - `typeof boxed === 'object'`, not `'string'`        (breaks strict typeof APIs)
 *   - `boxed === "x"` is ALWAYS `false`                  (reference vs. primitive)
 *   - `fs.writeFileSync(path, boxed)` and other native   (they expect a real string
 *     APIs misbehave or throw                              or Buffer, not a String obj)
 *
 * This is the exact root cause of the `out.stdout === "x"` / `fs.writeFileSync`
 * class of bugs.
 *
 * WHY *CALLABLE-ONLY* BY DEFAULT (avoiding false positives)
 * ---------------------------------------------------------
 * The classic SAFE "phantom brand" / nominal-typing pattern --
 *
 *   type UserId = string & { readonly __brand: unique symbol };
 *
 * -- keeps the runtime value a genuine primitive. The brand member is purely a
 * compile-time fiction; it is never materialized, so a `UserId` really is a
 * `string` at runtime and all primitive semantics hold. Intersection-with-object
 * is therefore NOT inherently dangerous -- only the presence of a member that
 * *must exist at runtime as a callable* is. So the default keys on a callable
 * member, not on intersection-with-object in general, and the safe brand stays
 * clean.
 *
 * The `requireCallable: false` ("blunt") option broadens to flag a primitive
 * intersected with ANY non-empty inline object members. That WILL flag
 * legitimate phantom brands (a false positive), which is exactly why it is
 * opt-in and the default is callable-only.
 *
 * AST-ONLY -- no type information required
 * ---------------------------------------
 * This rule uses only AST selectors (no `parserServices` / type-checker), so it
 * needs no `tsconfig` and no `parserOptions.project`. Consequence: it can only
 * inspect INLINE object literal parts (`string & { ... }`). A primitive
 * intersected with a NAMED interface reference (`string & SomeInterface`) cannot
 * be resolved without type info and is NOT flagged -- see the caveats in the
 * README. (The companion type-aware comparison rule and the `no-new-wrappers`
 * boxing guard cover the runtime/usage side regardless.)
 */

'use strict';

/** Keyword primitive nodes that count as "the primitive side" of the intersection. */
const PRIMITIVE_KEYWORDS = new Set([
  'TSStringKeyword',
  'TSNumberKeyword',
  'TSBooleanKeyword',
  'TSBigIntKeyword',
]);

/**
 * Is this intersection member a "primitive" for our purposes?
 *  - one of the keyword primitives above, OR
 *  - a TSLiteralType whose literal value is a string / number / boolean
 *    (e.g. `"x"`, `3`, `true`). A `null`/`undefined`/regex/bigint literal is
 *    intentionally NOT treated as a primitive here (the spec lists only the four
 *    keywords plus string/number/boolean literals).
 */
function isPrimitiveMember(node) {
  if (PRIMITIVE_KEYWORDS.has(node.type)) return true;
  if (node.type === 'TSLiteralType') {
    const lit = node.literal;
    // String / numeric / boolean literal => `lit.value` is a JS string/number/boolean.
    // (A bigint literal yields `typeof value === 'bigint'`; a regex/null does not match.)
    if (lit && lit.type === 'Literal') {
      const t = typeof lit.value;
      return t === 'string' || t === 'number' || t === 'boolean';
    }
  }
  return false;
}

/**
 * Does a single object *member* node constitute a CALLABLE member?
 *   - TSMethodSignature              ->  `foo(): T`
 *   - TSCallSignatureDeclaration     ->  `(): T`
 *   - TSConstructSignatureDeclaration->  `new (): T`
 *   - TSPropertySignature whose value annotation is a
 *       TSFunctionType / TSConstructorType  ->  `run: () => void` / `make: new () => T`
 */
function isCallableMember(member) {
  switch (member.type) {
    case 'TSMethodSignature':
    case 'TSCallSignatureDeclaration':
    case 'TSConstructSignatureDeclaration':
      return true;
    case 'TSPropertySignature': {
      // `prop: <type>` parses as a TSPropertySignature whose `.typeAnnotation`
      // is a TSTypeAnnotation wrapper; the real type is one level deeper.
      const inner = member.typeAnnotation && member.typeAnnotation.typeAnnotation;
      return !!inner && (inner.type === 'TSFunctionType' || inner.type === 'TSConstructorType');
    }
    default:
      return false;
  }
}

/**
 * Given an object-ish intersection member, decide whether it is "object members
 * worth flagging" under the current options.
 *
 * Returns one of:
 *   'callable'  -> contains at least one callable member
 *   'nonempty'  -> has >=1 member but none callable (only matters in blunt mode)
 *   null        -> not an object member type, or an empty `{}`
 *
 * Handles:
 *   - TSTypeLiteral : an inline `{ ... }` with a `members` array.
 *   - TSMappedType  : `{ [K in U]: V }`. A mapped type has a single value type
 *                     annotation (`.typeAnnotation`); if that value is a
 *                     function/constructor type, the mapped type produces
 *                     callable members.
 */
function classifyObjectMember(node) {
  if (node.type === 'TSTypeLiteral') {
    if (!node.members || node.members.length === 0) return null; // empty `{}`
    if (node.members.some(isCallableMember)) return 'callable';
    return 'nonempty';
  }
  if (node.type === 'TSMappedType') {
    const value = node.typeAnnotation; // value type of the mapped type (already unwrapped)
    if (value && (value.type === 'TSFunctionType' || value.type === 'TSConstructorType')) {
      return 'callable';
    }
    // A mapped type always introduces members; treat as non-empty for blunt mode.
    return 'nonempty';
  }
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow intersecting a primitive type with an inline object that has a callable member, ' +
        'which forces the runtime value to be a boxed object that lies about being a primitive.',
      recommended: true,
    },
    schema: [
      {
        type: 'object',
        properties: {
          requireCallable: {
            type: 'boolean',
            description:
              'When true (default), only flag intersections whose object part has a callable member. ' +
              'When false ("blunt" mode), flag a primitive intersected with ANY non-empty inline object ' +
              'members -- note this also flags legitimate phantom brands (false positives).',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      callable:
        '`string & { ... }` intersects a primitive with a callable member, so its runtime value must be a ' +
        'boxed object -- it then lies about being a primitive (`=== "x"` is always false; it fails ' +
        '`fs`/strict-typeof APIs). Define the helper as a separate type or wrapper instead of intersecting ' +
        'it onto the primitive.',
      blunt:
        '`string & { ... }` intersects a primitive with object members (blunt mode). If any member must ' +
        'exist at runtime, the value becomes a boxed object that lies about being a primitive. (If this is ' +
        'a type-only phantom brand it is safe -- enable the default `requireCallable: true` to allow it.)',
    },
  },

  create(context) {
    const options = context.options[0] || {};
    const requireCallable = options.requireCallable !== false; // default TRUE

    return {
      TSIntersectionType(node) {
        const members = node.types || [];

        // (a) the primitive side
        const hasPrimitive = members.some(isPrimitiveMember);
        if (!hasPrimitive) return;

        // (b) the object side -- classify every object-ish member
        let sawCallable = false;
        let sawNonEmpty = false;
        for (const m of members) {
          const kind = classifyObjectMember(m);
          if (kind === 'callable') sawCallable = true;
          else if (kind === 'nonempty') sawNonEmpty = true;
        }

        if (sawCallable) {
          context.report({ node, messageId: 'callable' });
        } else if (!requireCallable && sawNonEmpty) {
          context.report({ node, messageId: 'blunt' });
        }
      },
    };
  },
};
