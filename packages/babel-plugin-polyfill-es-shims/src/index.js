// @flow

import defineProvider, {
  type Utils,
  type MetaDescriptor,
} from "@babel/helper-define-polyfill-provider";

import polyfills from "../data/polyfills.json";

import {
  type Descriptor,
  Globals,
  StaticProperties,
  InstanceProperties,
} from "./mappings";

export default defineProvider<{||}>(function({
  shouldInjectPolyfill,
  assertDependency,
  createMetaResolver,
  debug,
  babel: { template, types: t },
}) {
  const expr = template.expression.ast;

  const resolvePolyfill = createMetaResolver<Descriptor[]>({
    global: Globals,
    static: StaticProperties,
    instance: InstanceProperties,
  });

  function createDescIterator(
    cb: (Descriptor, Utils, Object) => void,
    instance?: (MetaDescriptor, *, Utils, Object) => void,
  ) {
    return (meta, utils, path) => {
      const resolved = resolvePolyfill(meta);
      if (!resolved) return;

      if (instance && resolved.kind === "instance") {
        instance(meta, resolved, utils, path);
        return;
      }

      for (const desc of resolved.desc) {
        if (shouldInjectPolyfill(desc.name)) cb(desc, utils, path);
      }
    };
  }

  function injectDefault(desc, utils) {
    assertDependency(desc.package, desc.version);
    debug(desc.name);

    return utils.injectDefaultImport(desc.package, desc.name);
  }

  const seen = new WeakSet();

  return {
    name: "es-shims",
    polyfills,

    usageGlobal: createDescIterator((desc, utils) => {
      if (desc.global === false) return;

      assertDependency(desc.package, desc.version);

      utils.injectGlobalImport(`${desc.package}/auto.js`);

      debug(desc.name);
    }),

    usagePure: createDescIterator(
      (desc, utils, path) => {
        path.replaceWith(injectDefault(desc, utils));
      },
      (meta, resolved, utils, path) => {
        if (seen.has(path.node)) return;
        seen.add(path.node);

        const isCall = path.parentPath.isCallExpression({ callee: path.node });

        if (
          // This is the actual method for sure.
          meta.kind === "property" &&
          meta.placement === "prototype" &&
          meta.object != null
        ) {
          const desc = resolved.desc[0];
          if (!shouldInjectPolyfill(desc.name)) return;

          const id = injectDefault(desc, utils);

          if (isCall) {
            path.parentPath.unshiftContainer("arguments", path.node.object);
            path.replaceWith(id);
          } else if (
            path.parentPath.isMemberExpression({
              object: path.node,
              computed: false,
            }) &&
            path.parent.property.name === "call" &&
            path.parentPath.parentPath.isCallExpression({ callee: path.parent })
          ) {
            path.parentPath.replaceWith(id);
          } else {
            path.replaceWith(expr`${id}.getPolyfill()`);
          }
        } else {
          let tmp;
          let parent;
          let replacement = path.node;
          const { object } = path.node;

          for (const desc of resolved.desc) {
            const { thisCheck } = desc;
            if (!thisCheck || !shouldInjectPolyfill(desc.name)) continue;

            if (!tmp) {
              tmp = path.scope.generateUidIdentifierBasedOnNode(object);
              path.scope.push({ id: tmp });
              path.get("object").replaceWith(tmp);
            }

            const id = injectDefault(desc, utils);

            replacement = t.conditionalExpression(
              thisCheck(tmp),
              isCall ? id : expr`${id}.getPolyfill()`,
              replacement,
            );

            parent = parent ?? replacement;
          }

          if (!parent) return;

          replacement = expr`(${tmp} = ${object}, ${replacement})`;

          if (isCall) {
            parent.alternate = expr`Function.call.bind(${parent.alternate})`;
            path.parentPath.unshiftContainer("arguments", tmp);
          }

          path.replaceWith(replacement);
        }
      },
    ),
  };
});