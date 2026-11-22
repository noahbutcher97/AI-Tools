const doctor = new URL("../readiness.mjs", import.meta.url).href;
const installation = new URL("./watcher-doctor-install.mjs", import.meta.url).href;

export function resolve(specifier, context, next) {
  if (context.parentURL === doctor && ["./fleet.mjs", "./provider-process.mjs"].includes(specifier)) {
    return next(installation, context);
  }
  return next(specifier, context);
}
