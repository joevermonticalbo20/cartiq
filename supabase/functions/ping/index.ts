// Boot probe: minimal function to isolate project-level vs code-level
// BOOT_ERROR. If /ping works but /api doesn't, the api bundle is at fault.
Deno.serve(() => Response.json({ pong: true }));
