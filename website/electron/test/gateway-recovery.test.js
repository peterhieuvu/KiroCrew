const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  chooseRecoveryStrategy,
  classifyAdoptedOwnership,
  GatewayOwnership,
  waitForServiceRebind,
  waitForProcessExit,
} = require("../gateway-recovery");

describe("chooseRecoveryStrategy", () => {
  it("respawns when we spawned the gateway", () => {
    assert.equal(chooseRecoveryStrategy({ ownership: GatewayOwnership.SPAWNED }), "respawn");
  });

  // Regression guard for the lid-close / network-switch crash: on the reuse
  // path (remote-tunnel setup) the port-holder is our SSH forward, not a
  // backend we spawned. Recovery must NOT kill the port or spawn a local
  // backend — it must wait for the tunnel to heal and reconnect.
  it("reconnects (never respawns) for an external gateway", () => {
    assert.equal(chooseRecoveryStrategy({ ownership: GatewayOwnership.EXTERNAL }), "reconnect");
  });

  // Ownership defaults to external when unknown: the safe strategy is the
  // non-destructive reconnect, never a port-kill.
  it("defaults to reconnect when ownership is falsy/unknown", () => {
    assert.equal(chooseRecoveryStrategy(), "reconnect");
    assert.equal(chooseRecoveryStrategy({}), "reconnect");
    assert.equal(chooseRecoveryStrategy({ ownership: undefined }), "reconnect");
    assert.equal(chooseRecoveryStrategy({ ownership: null }), "reconnect");
  });

  // Regression guard for the adopted-gateway dead window: an adopted LOCAL
  // same-family gateway that dies never comes back on its own, so it must get
  // the bounded wait-then-respawn strategy, not the indefinite tunnel wait.
  it("bounded reconnect-then-respawn for an adopted local same-family gateway", () => {
    assert.equal(
      chooseRecoveryStrategy({ ownership: GatewayOwnership.ADOPTED_LOCAL }),
      "reconnect-bounded",
    );
  });

  // A service-classified adoption is still a local same-family gateway, so it
  // takes the same bounded strategy; the manager-rebind grace is layered on by
  // the caller, not by this decision.
  it("bounded reconnect-then-respawn for an adopted service gateway", () => {
    assert.equal(
      chooseRecoveryStrategy({ ownership: GatewayOwnership.ADOPTED_SERVICE }),
      "reconnect-bounded",
    );
  });

  // The never-evict/never-respawn behavior is preserved ONLY for genuinely
  // external gateways: the indefinite tunnel-heal wait.
  it("keeps the indefinite reconnect for external/tunnel gateways", () => {
    assert.equal(chooseRecoveryStrategy({ ownership: GatewayOwnership.EXTERNAL }), "reconnect");
  });
});

describe("classifyAdoptedOwnership", () => {
  it("maps a same-family service owner to adopted-service", () => {
    assert.equal(
      classifyAdoptedOwnership({ sameFamily: true, owner: "service" }),
      GatewayOwnership.ADOPTED_SERVICE,
    );
  });

  it("maps a same-family kirocrew owner to adopted-local", () => {
    assert.equal(
      classifyAdoptedOwnership({ sameFamily: true, owner: "kirocrew" }),
      GatewayOwnership.ADOPTED_LOCAL,
    );
  });

  // A same-family probe with no positively-identified Kiro Crew owner (tunnel,
  // unknown, or an unprobeable Windows holder) is not ours to respawn.
  it("stays external when the owner is not a Kiro Crew process", () => {
    assert.equal(classifyAdoptedOwnership({ sameFamily: true, owner: "none" }), GatewayOwnership.EXTERNAL);
    assert.equal(classifyAdoptedOwnership({ sameFamily: true, owner: undefined }), GatewayOwnership.EXTERNAL);
  });

  // Not same-family = external regardless of owner.
  it("stays external when the family probe did not match", () => {
    assert.equal(
      classifyAdoptedOwnership({ sameFamily: false, owner: "service" }),
      GatewayOwnership.EXTERNAL,
    );
  });

  // Guards the invariant the single-state model relies on: a reuse classification
  // can never yield SPAWNED, so a classify write can never overwrite spawn ownership.
  it("never returns SPAWNED for any input", () => {
    for (const sameFamily of [true, false]) {
      for (const owner of ["service", "kirocrew", "none", "", undefined]) {
        assert.notEqual(
          classifyAdoptedOwnership({ sameFamily, owner }),
          GatewayOwnership.SPAWNED,
        );
      }
    }
  });
});

describe("waitForServiceRebind", () => {
  const instantSleep = () => Promise.resolve();

  // A service-managed holder that released its port mid-restart is respawned
  // by its manager (launchd KeepAlive / systemd Restart=). Spawning locally in
  // that window races the manager for the bind — one side exits EADDRINUSE —
  // so a rebind within the grace must be adopted, never raced.
  it("reports rebound as soon as the port is bound again", async () => {
    let probes = 0;
    const verdict = await waitForServiceRebind({
      isPortBound: async () => ++probes >= 3, // rebinds on the third probe
      sleep: instantSleep,
      graceMs: 10_000,
    });
    assert.equal(verdict, "rebound");
    assert.equal(probes, 3);
  });

  // The service classification also matches orphans (a gateway reparented to
  // init has PPID 1 but no manager), so the grace must EXPIRE into a local
  // spawn — a blanket "never respawn after a service holder" would recreate
  // the adopted-gateway dead window for orphan exits.
  it("reports spawn when the grace expires with the port still free", async () => {
    const t0 = Date.now();
    let now = t0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const verdict = await waitForServiceRebind({
        isPortBound: async () => false,
        sleep: async () => { now += 1_000; },
        graceMs: 5_000,
      });
      assert.equal(verdict, "spawn");
    } finally {
      Date.now = realNow;
    }
  });

  // An immediate rebind (manager beat our first probe) short-circuits without
  // sleeping at all.
  it("adopts an already-rebound port without waiting", async () => {
    let slept = false;
    const verdict = await waitForServiceRebind({
      isPortBound: async () => true,
      sleep: async () => { slept = true; },
      graceMs: 10_000,
    });
    assert.equal(verdict, "rebound");
    assert.equal(slept, false);
  });
});

describe("waitForProcessExit", () => {
  // A graceful stop releases the LISTEN socket before the process exits, and
  // the gateway.lock flock is held for the process lifetime. Spawning on
  // port-free alone gets the replacement refused by the singleton lock; these
  // tests lock in the wait-for-exit gate that closes that window.
  it("returns exited once every watched pid is dead", async () => {
    const alive = new Set([111, 222]);
    let polls = 0;
    const verdict = await waitForProcessExit({
      pids: [111, 222],
      isAlive: (p) => alive.has(p),
      sleep: async () => { polls += 1; if (polls === 1) alive.delete(111); if (polls === 2) alive.delete(222); },
      timeoutMs: 60_000,
    });
    assert.equal(verdict, "exited");
  });

  it("returns timeout when a pid outlives the grace (spawn proceeds, lock refusal surfaces honestly)", async () => {
    let now = Date.now();
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const verdict = await waitForProcessExit({
        pids: [111],
        isAlive: () => true,
        sleep: async () => { now += 1_000; },
        timeoutMs: 5_000,
      });
      assert.equal(verdict, "timeout");
    } finally {
      Date.now = realNow;
    }
  });

  // Empty/invalid pid sets (probe failed, Windows without lsof) degrade to a
  // no-op — same behavior as before this gate existed, never a hang.
  it("degrades to exited immediately with no watchable pids", async () => {
    let slept = false;
    for (const pids of [[], null, undefined, [0, -3, NaN]]) {
      const verdict = await waitForProcessExit({
        pids,
        isAlive: () => { throw new Error("must not be called"); },
        sleep: async () => { slept = true; },
      });
      assert.equal(verdict, "exited");
    }
    assert.equal(slept, false);
  });
});
