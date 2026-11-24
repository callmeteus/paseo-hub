import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { describe, it } from "vitest";
import { createLogger } from "./logger.js";
import { assertOneFailure, FailureLogStream } from "./test-utils/failure-logs.js";
import {
  finalizeSignalShutdown,
  handleDaemonUpgradeRequest,
  shutdownProductionServer,
} from "./index.js";

class UpgradeSocket extends Duplex {
  destroyedByOwner = false;

  override _read(): void {}
  override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ): void {
    done();
  }
  override destroy(error?: Error): this {
    this.destroyedByOwner = true;
    return super.destroy(error);
  }
}

describe("production server failure ownership", () => {
  it("logs and terminates a rejecting daemon upgrade exactly once", async () => {
    const canary = "daemon-upgrade-secret-a991";
    const stream = new FailureLogStream();
    const socket = new UpgradeSocket();

    await handleDaemonUpgradeRequest({
      request: { method: "GET", url: `/api/daemons/connect?credential=${canary}` },
      socket,
      handle: () => Promise.reject(new Error(canary)),
      logger: createLogger(stream),
    });

    assert.equal(socket.destroyedByOwner, true);
    const record = assertOneFailure(stream, {
      operation: "daemon.upgrade",
      component: "daemons",
      canary,
    });
    assert.equal(record["method"], "GET");
    assert.equal(record["path"], "/api/daemons/connect");
  });

  it("logs a shutdown rejection exactly once and returns a fatal outcome", async () => {
    const canary = "shutdown-secret-817c";
    const stream = new FailureLogStream();

    const clean = await shutdownProductionServer(
      () => Promise.reject(new Error(canary)),
      createLogger(stream),
    );

    assert.equal(clean, false);
    assertOneFailure(stream, {
      operation: "server.shutdown",
      component: "server",
      canary,
    });
  });
});

describe("signal shutdown finalization", () => {
  it("exits cleanly after a clean graceful shutdown and cancels the watchdog", async () => {
    const exits: number[] = [];
    let cancels = 0;

    await finalizeSignalShutdown(Promise.resolve(true), {
      exit: (code) => {
        exits.push(code);
      },
      after: () => () => {
        cancels += 1;
      },
    });

    assert.deepEqual(exits, [0]);
    assert.equal(cancels, 1);
  });

  it("exits fatally when graceful shutdown reports an unclean outcome", async () => {
    const exits: number[] = [];

    await finalizeSignalShutdown(Promise.resolve(false), {
      exit: (code) => {
        exits.push(code);
      },
      after: () => () => {},
    });

    assert.deepEqual(exits, [1]);
  });

  it("exits fatally when graceful shutdown rejects", async () => {
    const exits: number[] = [];

    await finalizeSignalShutdown(Promise.reject(new Error("shutdown hung")), {
      exit: (code) => {
        exits.push(code);
      },
      after: () => () => {},
    });

    assert.deepEqual(exits, [1]);
  });

  it("force-exits if graceful shutdown never settles", async () => {
    const exits: number[] = [];
    let fireWatchdog: (() => void) | undefined;

    // A promise that never settles models a shutdown stuck on an open socket.
    void finalizeSignalShutdown(new Promise<boolean>(() => {}), {
      exit: (code) => {
        exits.push(code);
      },
      after: (_ms, fn) => {
        fireWatchdog = fn;
        return () => {};
      },
    });

    assert.ok(fireWatchdog);
    fireWatchdog?.();
    assert.deepEqual(exits, [1]);
  });
});
