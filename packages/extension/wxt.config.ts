import { defineConfig } from "wxt";

/**
 * Local relays, for working on the relay itself. Development builds only:
 * a published wallet has no business reaching into somebody's localhost,
 * and store review asks about every host a wallet can talk to.
 *
 * `pnpm dev` and `pnpm build:dev` include them; `pnpm build` and `pnpm zip`
 * (production mode) do not.
 */
const DEV_HOSTS = [
  "http://localhost:8787/*",
  "http://127.0.0.1:8787/*",
  // A second local port, for driving the screens against a stand-in
  // exchange while the real one is unreachable.
  "http://localhost:8788/*",
  "http://127.0.0.1:8788/*",
];

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: ({ mode }) => ({
    name: "Oyster",
    description: "A self-custody wallet for Pearl.",
    // sidePanel: the wallet can live down the side of the window instead
    // of in a popup, chosen in Settings.
    // clipboardRead: the Paste buttons on Send and the wrapped PRL page.
    // Without it navigator.clipboard.readText() throws NotAllowedError and
    // the button looks broken.
    // notifications: tells you when PRL arrives while the popup is closed.
    permissions: ["storage", "alarms", "sidePanel", "clipboardRead", "notifications"],
    // The indexers and Oyster's relay. safe.trade is never contacted
    // directly by the extension.
    host_permissions: [
      "https://blockbook.pearlresearch.ai/*",
      "https://blockbook.testnet.pearlresearch.ai/*",
      // Oyster's relay: PRL price, charts, trading and cash.
      // TODO(domain): swap for the real domain before publishing.
      "https://167-99-2-180.sslip.io/*",
      ...(mode === "development" ? DEV_HOSTS : []),
    ],
  }),
});
