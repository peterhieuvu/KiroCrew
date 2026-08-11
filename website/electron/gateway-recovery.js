"use strict";
//
// Pure, injectable recovery-strategy decision, extracted from main.js so it can
// be unit-tested without Electron (mirrors gateway-liveness.js / gateway-wait.js
// / gateway-stop.js).
//
// PROBLEM: the post-handoff liveness monitor fires onUnresponsive whenever
// /api/status stops answering. main.js used to react ONE way — assume a wedged
// local backend and force-kill the port + respawn. That is correct only when WE
// spawned the gateway. On the reuse path the port-holder is someone else's
// process, and in the remote-tunnel setup (localhost:<port> is an SSH forward to
// a remote gateway) an unresponsive probe almost always means the SSH tunnel
// dropped (lid close, Wi-Fi<->Ethernet handoff, VPN blip), not a wedged backend.
// Killing the port would tear down the tunnel; the old code then fell through to
// a terminal error dialog that QUIT the app on any button — including Retry (the
// perceived "crash on Retry" on network change).
//
// This helper is the single source of truth for that fork: given whether we own
// the gateway, return which recovery strategy to run. Keeping it pure means the
// ownership rule is covered by tests independently of the Electron plumbing.

/**
 * How this app relates to the gateway on :PORT — the single source of truth for
 * recovery decisions. Exactly one ownership state is live at a time; setting it
 * overwrites the prior state, so no stale adopted/service classification can
 * survive an ownership change.
 *
 *   spawned         — this app spawned the bundled backend on this port; recovery
 *                     owns the child and may kill+respawn it.
 *   adopted-local   — reuse path; the port-holder was positively identified as a
 *                     LOCAL same-family Kiro Crew process. Not ours to kill, but
 *                     its death is permanent (no tunnel will resurrect it), so
 *                     recovery waits a BOUNDED interval and then respawns.
 *   adopted-service — an adopted-local holder that is SERVICE-classified (a real
 *                     launchd/systemd unit, or an init-reparented orphan). A
 *                     manager may respawn it, so recovery grace-waits for a
 *                     rebind before spawning to avoid racing the bind.
 *   external        — a tunnel or unidentified holder, and the safe default when
 *                     ownership is unknown: never kill or spawn locally; re-probe
 *                     until it heals, then reconnect.
 *
 * @enum {string}
 */
const GatewayOwnership = Object.freeze({
  SPAWNED: "spawned",
  ADOPTED_LOCAL: "adopted-local",
  ADOPTED_SERVICE: "adopted-service",
  EXTERNAL: "external",
});

/**
 * Classify a REUSE-path port-holder into an ownership state. A holder is "ours
 * in spirit" only when the family probe matched AND the LISTEN owner is a
 * Kiro Crew process; a "service" owner further selects the service-managed
 * case. A tunnel, an unidentified owner, or a failed probe stays external — on
 * Windows the owner cannot be probed, so an adopted holder classifies external
 * there and takes the conservative reconnect path.
 *
 * @param {object} o
 * @param {boolean} o.sameFamily  the /api/health family check matched
 * @param {string} [o.owner]      the LISTEN owner ("kirocrew" | "service" | …)
 * @returns {string} a {@link GatewayOwnership} value
 */
function classifyAdoptedOwnership({ sameFamily, owner } = {}) {
  if (!sameFamily) return GatewayOwnership.EXTERNAL;
  if (owner === "service") return GatewayOwnership.ADOPTED_SERVICE;
  if (owner === "kirocrew") return GatewayOwnership.ADOPTED_LOCAL;
  return GatewayOwnership.EXTERNAL;
}

/**
 * Decide how to recover an unresponsive gateway from its ownership state.
 *
 * @param {object} [o]
 * @param {string} [o.ownership]  a {@link GatewayOwnership} value describing how
 *                                this app relates to the port-holder. Unknown or
 *                                falsy is treated as external — the safe,
 *                                non-destructive default.
 * @returns {"respawn" | "reconnect-bounded" | "reconnect"}
 *   "respawn"           — spawned: we own the child; kill the wedged tree, free
 *                         the port, spawn a fresh backend, re-run the boot flow.
 *   "reconnect-bounded" — adopted-local / adopted-service: a local same-family
 *                         gateway we do not own. Never kill it, but its death is
 *                         not a tunnel blip, so wait a BOUNDED interval and then
 *                         spawn once the port clears. (The service-manager rebind
 *                         grace for adopted-service is applied by the caller.)
 *   "reconnect"         — external/unknown: tunnel or unidentified holder; never
 *                         kill it or spawn locally; re-probe until it heals, then
 *                         reconnect (re-fetching a token, since the drop likely
 *                         invalidated the old one).
 */
function chooseRecoveryStrategy({ ownership } = {}) {
  if (ownership === GatewayOwnership.SPAWNED) return "respawn";
  if (
    ownership === GatewayOwnership.ADOPTED_LOCAL ||
    ownership === GatewayOwnership.ADOPTED_SERVICE
  ) {
    return "reconnect-bounded";
  }
  return "reconnect";
}

// launchd throttles KeepAlive respawns to ~10s between starts; systemd's
// default RestartSec is far shorter. 15s covers both with margin, and the
// cost of over-waiting lands only on the orphan case (a one-time delay
// before we spawn), never on a live rebind (we adopt the instant it binds).
const SERVICE_REBIND_GRACE_MS = 15_000;

/**
 * After a SERVICE-classified port-holder releases the port, the OS service
 * manager (launchd KeepAlive / systemd Restart=) may be about to respawn it:
 * at the moment the socket closes, a transient release during a service
 * restart is indistinguishable from a permanent exit. Spawning immediately
 * races the manager for the port — one side loses with EADDRINUSE.
 *
 * But "service-classified" does not guarantee a manager will respawn it: an
 * orphaned gateway reparents to init (PPID 1) and classifies as
 * service-managed too, and an orphan has no KeepAlive — nothing will ever
 * rebind. So: wait a bounded grace for a rebind, report "rebound" the moment
 * something takes the port back (the caller adopts/reconnects to it), and
 * report "spawn" only when the grace expires with the port still free.
 *
 * Pure/injectable so the decision is unit-testable without Electron.
 *
 * @param {object} o
 * @param {() => Promise<boolean>} o.isPortBound  does the port have a LISTEN owner again?
 * @param {(ms:number) => Promise<void>} o.sleep
 * @param {number} [o.graceMs]
 * @param {number} [o.pollMs]
 * @returns {Promise<"rebound" | "spawn">}
 */
async function waitForServiceRebind({ isPortBound, sleep, graceMs = SERVICE_REBIND_GRACE_MS, pollMs = 500 }) {
  const deadline = Date.now() + graceMs;
  for (;;) {
    if (await isPortBound()) return "rebound";
    if (Date.now() >= deadline) return "spawn";
    await sleep(pollMs);
  }
}

// A graceful gateway stop releases the LISTEN socket EARLY — the process keeps
// running to drain in-flight turns and flush session files, and it holds the
// exclusive gateway.lock flock for its full lifetime. So "port is free" does
// NOT mean "safe to spawn": a replacement started in that window is refused by
// the singleton lock and exits, then the incumbent exits — leaving no gateway
// at all. This helper waits (bounded) for the captured incumbent pids to
// actually die; the kernel releases the flock atomically on process exit.
// Pure/injectable for unit tests. 15s comfortably covers the backend's
// graceful-stop budget (drain ≤5s + flush) after the port has already cleared.
const INCUMBENT_EXIT_GRACE_MS = 15_000;

async function waitForProcessExit({ pids, isAlive, sleep, timeoutMs = INCUMBENT_EXIT_GRACE_MS, pollMs = 250 }) {
  const watched = (pids || []).filter((p) => Number.isInteger(p) && p > 0);
  if (!watched.length) return "exited";
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!watched.some((p) => isAlive(p))) return "exited";
    if (Date.now() >= deadline) return "timeout";
    await sleep(pollMs);
  }
}

module.exports = {
  GatewayOwnership,
  classifyAdoptedOwnership,
  chooseRecoveryStrategy,
  waitForServiceRebind,
  waitForProcessExit,
  SERVICE_REBIND_GRACE_MS,
  INCUMBENT_EXIT_GRACE_MS,
};
