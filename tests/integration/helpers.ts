import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { SignatureCache } from "../../src/cache.js";
import { loadConfig } from "../../src/config.js";
import { createProxyApp, type ProxyAppOptions } from "../../src/proxy.js";
import { createMockUpstream, type MockUpstream } from "./mockServer.js";

export interface ProxyTestRig {
  mock: MockUpstream;
  cache: SignatureCache;
  proxyUrl: string;
  server: Server;
  close: () => Promise<void>;
}

/** Fresh mock upstream + proxy app per test: total cache/request isolation. */
export async function startProxyAndMock(
  env: NodeJS.ProcessEnv = {},
  proxyOptions?: ProxyAppOptions,
): Promise<ProxyTestRig> {
  const mock = await createMockUpstream();
  const config = loadConfig({
    PORT: "0",
    HOST: "127.0.0.1",
    UPSTREAM_BASE_URL: mock.url,
    ...env,
  });
  const { app, cache } = createProxyApp(config, proxyOptions);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    mock,
    cache,
    server,
    proxyUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      cache.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await mock.close();
    },
  };
}
