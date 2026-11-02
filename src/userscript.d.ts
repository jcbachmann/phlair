// The cross-origin request of userscript managers (Violentmonkey, Tampermonkey,
// Greasemonkey), as far as the editor uses it. Not defined in the extension.

interface GmResponse {
  status: number;
  response: Blob;
  responseHeaders: string;
}

interface GmRequest {
  method: "GET";
  url: string;
  responseType: "blob";
  /** Without the user's cookies for the other site. */
  anonymous: boolean;
  timeout: number;
  onload: (response: GmResponse) => void;
  onerror: () => void;
  ontimeout: () => void;
}

declare const GM: { xmlHttpRequest?: (request: GmRequest) => unknown } | undefined;
declare const GM_xmlhttpRequest: ((request: GmRequest) => unknown) | undefined;
