// Which build of the app this is. The values are worked out when the app is built (buildInfo in
// vite.config.ts) and shown in the library and in the settings, so that a reader can tell which
// version a device runs — a phone holds on to an installed app longer than one expects.

/**
 * The version, e.g. "0.1.26": the first two numbers come from package.json, the third is the number
 * of commits the build was made from and grows by itself with every change. A "+" at the end marks a
 * build made from files that were not committed yet.
 */
export const appVersion: string = __APP_VERSION__;

/** Short id of the commit the build was made from; empty when it is not known. */
export const buildCommit: string = __BUILD_COMMIT__;

/** When this build was made. */
export const buildTime = (): Date => new Date(__BUILD_TIME__);
