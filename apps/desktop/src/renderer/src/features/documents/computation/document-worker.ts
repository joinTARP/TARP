// lockdown 只能发生在专属 Worker；UI realm 与房主 Bun server 均不执行此入口。
import "ses";

lockdown();
await import("./document-worker-runtime");
