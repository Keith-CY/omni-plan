import webpush from "web-push";
import { CaptureStore, type TokenScope } from "./store";

const [command, action, ...args] = process.argv.slice(2);

if (command === "vapid" && action === "generate") {
  const keys = webpush.generateVAPIDKeys();
  process.stdout.write(`VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\n`);
  process.exit(0);
}

const store = new CaptureStore();
try {
  if (command === "token" && action === "create") {
    const scope = args[1] === "owner" ? "owner" : args[1] === "capture" ? "capture" : undefined;
    if (!scope) usage("Choose capture or owner scope.");
    const created = store.createToken(args[0] || "Personal device", scope as TokenScope);
    process.stdout.write(`${JSON.stringify(created, null, 2)}\n`);
    process.stdout.write("Store the token now. Only its SHA-256 hash remains in the database.\n");
  } else if (command === "token" && action === "list") {
    process.stdout.write(`${JSON.stringify(store.listTokens(), null, 2)}\n`);
  } else if (command === "token" && action === "revoke" && args[0]) {
    process.stdout.write(`${JSON.stringify({ revoked: store.revokeToken(args[0]) })}\n`);
  } else {
    usage();
  }
} finally {
  store.close();
}

function usage(message?: string): never {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write("Usage:\n  bun server/cli.ts vapid generate\n  bun server/cli.ts token create <name> <capture|owner>\n  bun server/cli.ts token list\n  bun server/cli.ts token revoke <id>\n");
  process.exit(1);
}
