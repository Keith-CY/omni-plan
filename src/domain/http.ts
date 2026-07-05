export const browserFetch = ((
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
) => globalThis.fetch.call(globalThis, input, init)) as typeof fetch;
