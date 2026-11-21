const bridge = new URL("../../../MCP-Servers/bridges/relay/", import.meta.url);
const publicFaces = [new URL("cli.mjs", bridge).href, new URL("server.mjs", bridge).href];
const fixture = new URL("./local-inventory-install.mjs", import.meta.url).href;
const deliveryFixture = new URL("./local-delivery-install.mjs", import.meta.url).href;
const deliveryCallers = [...publicFaces, new URL("addressed-send.mjs", bridge).href];

export function resolve(specifier, context, nextResolve) {
  if (specifier === "./local-address.mjs" && publicFaces.includes(context.parentURL)) {
    return nextResolve(fixture, context);
  }
  if (specifier === "./installed-delivery.mjs" && deliveryCallers.includes(context.parentURL)) {
    return nextResolve(deliveryFixture, context);
  }
  return nextResolve(specifier, context);
}
