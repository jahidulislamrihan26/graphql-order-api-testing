import { GraphQLError, Kind, type FragmentDefinitionNode, type SelectionSetNode, type ValidationRule } from 'graphql';

/** Rejects queries nested deeper than `max` levels, so one request cannot ask the database for an unbounded amount of work. */
export const depthLimit = (max: number): ValidationRule => (context) => ({
  Document: {
    leave(document) {
      const fragments = new Map<string, FragmentDefinitionNode>();
      for (const def of document.definitions) if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);

      const depth = (set: SelectionSetNode | undefined, seen: string[]): number => {
        if (!set) return 0;
        let deepest = 0;
        for (const sel of set.selections) {
          if (sel.kind === Kind.FIELD) {
            if (sel.name.value.startsWith('__')) continue;
            deepest = Math.max(deepest, 1 + depth(sel.selectionSet, seen));
          } else if (sel.kind === Kind.INLINE_FRAGMENT) {
            deepest = Math.max(deepest, depth(sel.selectionSet, seen));
          } else if (sel.kind === Kind.FRAGMENT_SPREAD && !seen.includes(sel.name.value)) {
            deepest = Math.max(deepest, depth(fragments.get(sel.name.value)?.selectionSet, [...seen, sel.name.value]));
          }
        }
        return deepest;
      };

      for (const def of document.definitions) {
        if (def.kind !== Kind.OPERATION_DEFINITION) continue;
        const d = depth(def.selectionSet, []);
        if (d > max) context.reportError(new GraphQLError(`Query is nested ${d} levels deep; the limit is ${max}`, { extensions: { code: 'QUERY_TOO_DEEP' } }));
      }
    },
  },
});
