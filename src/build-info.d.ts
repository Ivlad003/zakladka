// Set in vite.config.ts when the app is built; read through src/lib/version.ts.

/** The version shown to the reader, e.g. "0.1.26". */
declare const __APP_VERSION__: string;
/** Short id of the commit the build was made from; empty when it is not known. */
declare const __BUILD_COMMIT__: string;
/** ISO time at which this build was made. */
declare const __BUILD_TIME__: string;
