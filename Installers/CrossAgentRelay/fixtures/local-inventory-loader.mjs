const bridge = new URL("../../../MCP-Servers/bridges/relay/", import.meta.url);
const publicFaces = [new URL("cli.mjs", bridge).href, new URL("server.mjs", bridge).href];
const fixture = new URL("./local-inventory-install.mjs", import.meta.url).href;

export function resolve(specifier, context, nextResolve) {
  if (specifier === "./local-address.mjs" && publicFaces.includes(context.parentURL)) {
    return nextResolve(fixture, context);
  }
  return nextResolve(specifier, context);
}
