// Capture the process start once, before any child can be recorded.
export const BRIDGE_BOOT_AT = Date.now() - Math.floor(process.uptime() * 1000);
