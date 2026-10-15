// Stub for Node-only modules referenced by Emscripten glue code. The browser
// code paths never call into these, but bundlers still need a resolution
// target for the guarded Node branches.
export default {};
export const promises = {};
export const readFileSync = () => {
  throw new Error("node fs is not available in the browser");
};
export const existsSync = () => false;
export const join = (...parts: string[]) => parts.join("/");
export const dirname = (value: string) => value.split("/").slice(0, -1).join("/");
