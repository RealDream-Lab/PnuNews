// A request that never reached the server (no internet, the server is down, the connection dropped) ends in the browser's own
// error, in English and different in every browser: «Failed to fetch» (Chrome), «Load failed» (Safari), «NetworkError when
// attempting to fetch resource.» (Firefox). That text used to reach the reader under the news. This turns it into a Persian
// message and marks the error (`network: true`, `status: 0`) so a caller can tell it from an answer of the server.
export const NETWORK_ERROR_MESSAGE = 'ارتباط با سرور برقرار نشد؛ اتصال اینترنت را بررسی کنید و دوباره تلاش کنید.';

export async function fetchOrExplain(url, options) {
  try {
    return await fetch(url, options);
  } catch (error) {
    if (error?.name === 'AbortError') throw error; // a request cancelled on purpose is not a network failure
    const explained = new Error(NETWORK_ERROR_MESSAGE, { cause: error });
    explained.network = true;
    explained.status = 0;
    throw explained;
  }
}
