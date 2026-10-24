// Starts the follow-up / hold-expiry scheduler when the Node server boots.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.MATCHIRE_DISABLE_SCHEDULER) return;
  const { tick } = await import("./lib/engine");
  const run = () => tick().catch((e) => console.error("Scheduler tick failed", e));
  setTimeout(run, 5_000);
  setInterval(run, 60_000);
}
