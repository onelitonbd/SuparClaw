// Which build this daemon is (see `buildStamp` in scripts/build.mjs).
//
// A daemon that cannot say which build it is cannot be diagnosed: "the model
// switch still doesn't work" has to be checkable against the code that is
// actually running on the phone, not assumed. The value is `version+<source
// hash>`, hashed over `src/` and `package.json` — identical sources always
// produce the identical stamp, and it never claims a commit it cannot know.
// `unknown` only appears when the bundle was built without the define.
declare const __BUILD_STAMP__: string;

export const BUILD_STAMP: string = typeof __BUILD_STAMP__ === "string" ? __BUILD_STAMP__ : "unknown";
