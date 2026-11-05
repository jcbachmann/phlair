/** The version and time of the build, set by build.mjs. */
declare const __BUILD__: string;

/** The project (its hashtag, without "#") that feedback tasks get, or "" (PHLAIR_FEEDBACK_PROJECT). */
declare const __FEEDBACK_PROJECT__: string;

/** Which build this is: the userscript, the browser extension, or the script of the Phorge library (phorge/). */
declare const __TARGET__: "userscript" | "extension" | "phorge";

/** Javelin, Phorge's Javascript library, as far as the script installed in Phorge uses it. */
declare const JX: { behavior(name: string, init: (config: any) => void): void };
