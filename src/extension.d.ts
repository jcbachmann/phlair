// The part of the WebExtension API the extension uses (storage permission).

interface ExtensionStorageArea {
  get(defaults: Record<string, unknown>): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

interface ExtensionApi {
  storage: { local: ExtensionStorageArea };
}

declare var browser: ExtensionApi | undefined;
declare var chrome: ExtensionApi | undefined;
