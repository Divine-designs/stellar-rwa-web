/**
 * Tests for issue #518 — TRY_AGAIN_LATER and DUPLICATE status handling in
 * invokeContract's sendTransaction step.
 *
 * invokeContract is the only public entry point for writes; we test its
 * behaviour by mocking the Soroban RPC server at the module level.
 */

import type { ContractError as ContractErrorType } from "@/lib/stellar";

// ---------------------------------------------------------------------------
// Lightweight helpers that mirror the subset of @stellar/stellar-sdk used
// inside invokeContract so we don't have to fully build real XDR.
// ---------------------------------------------------------------------------

const FAKE_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// We mock the entire @stellar/stellar-sdk module so we can control what the
// RPC server returns from sendTransaction / getTransaction without a live node.
jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");

  class FakeAccount {
    accountId() { return "GAIQGTOBTTLLDJ4SWGGESM7UWJ2DI4K3ZNHUSHPDKJL2IE5FKY3BSRAA"; }
    sequenceNumber() { return "0"; }
    incrementSequenceNumber() {}
  }

  class FakeContract {
    call(_method: string, ..._args: unknown[]) { return { type: "call" }; }
  }

  class FakeTransactionBuilder {
    addOperation() { return this; }
    setTimeout() { return this; }
    build() {
      return {
        toXDR: () => "fakexdr",
        toEnvelope: () => ({}),
      };
    }
    static fromXDR(_xdr: string, _passphrase: string) {
      return { toXDR: () => "fakexdr" };
    }
  }

  const rpc = {
    Server: jest.fn(),
    Api: {
      ...actual.rpc.Api,
      isSimulationError: jest.fn().mockReturnValue(false),
      GetTransactionStatus: actual.rpc.Api.GetTransactionStatus,
    },
    assembleTransaction: jest.fn().mockReturnValue({ build: () => ({ toXDR: () => "preparedxdr" }) }),
  };

  return {
    ...actual,
    Account: FakeAccount,
    Contract: FakeContract,
    TransactionBuilder: FakeTransactionBuilder,
    rpc,
  };
});

const fakeSigner = async (xdr: string) => xdr;

/**
 * `getServer` caches a server per network at module scope. A spy on a
 * statically-imported `getServer` doesn't reach that cache once it's
 * populated — the cached entry from whichever test ran first wins for every
 * test after it, which is why these tests used to bleed into each other.
 * Instead, reset the module registry and re-require both the SDK mock and
 * lib/stellar fresh for every test, so each gets its own empty cache and
 * `new rpc.Server()` is actually invoked again.
 */
function freshStellar(sendStatus: string) {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sdk = require("@stellar/stellar-sdk");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const stellar = require("@/lib/stellar");

  const mockServer = {
    getAccount: jest.fn().mockResolvedValue({}),
    simulateTransaction: jest.fn().mockResolvedValue({
      result: { retval: undefined },
      minResourceFee: "100",
    }),
    sendTransaction: jest.fn().mockResolvedValue({
      status: sendStatus,
      hash: FAKE_HASH,
    }),
    getTransaction: jest.fn().mockResolvedValue({
      status: sdk.rpc.Api.GetTransactionStatus.SUCCESS,
      returnValue: undefined,
    }),
  };
  (sdk.rpc.Server as jest.Mock).mockReturnValue(mockServer);

  return { mockServer, invokeContract: stellar.invokeContract as typeof import("@/lib/stellar").invokeContract };
}

describe("invokeContract — sendTransaction status handling (#518)", () => {
  it("throws a clear ContractError for TRY_AGAIN_LATER without polling", async () => {
    const { mockServer, invokeContract } = freshStellar("TRY_AGAIN_LATER");

    await expect(
      invokeContract(
        "testnet",
        "GAIQGTOBTTLLDJ4SWGGESM7UWJ2DI4K3ZNHUSHPDKJL2IE5FKY3BSRAA",
        "CBX5SMLTXX6JP4HA5GQIO2V6QM7WCUGL2GZ6D4U773HMRI6RXISKPUR3",
        "transfer",
        [],
        fakeSigner,
      ),
    ).rejects.toMatchObject({
      name: "ContractError",
      message: expect.stringContaining("congested"),
    });

    // Must NOT poll after TRY_AGAIN_LATER — the hash was never accepted.
    expect(mockServer.getTransaction).not.toHaveBeenCalled();
  });

  it("TRY_AGAIN_LATER error detail includes the hash", async () => {
    const { invokeContract } = freshStellar("TRY_AGAIN_LATER");

    let caught: ContractErrorType | undefined;
    try {
      await invokeContract(
        "testnet",
        "GAIQGTOBTTLLDJ4SWGGESM7UWJ2DI4K3ZNHUSHPDKJL2IE5FKY3BSRAA",
        "CBX5SMLTXX6JP4HA5GQIO2V6QM7WCUGL2GZ6D4U773HMRI6RXISKPUR3",
        "transfer",
        [],
        fakeSigner,
      );
    } catch (e) {
      caught = e as ContractErrorType;
    }
    expect(caught).toBeDefined();
    expect(caught?.detail).toContain(FAKE_HASH);
  });

  it("DUPLICATE falls through to poll and returns success", async () => {
    const { mockServer, invokeContract } = freshStellar("DUPLICATE");

    await expect(
      invokeContract(
        "testnet",
        "GAIQGTOBTTLLDJ4SWGGESM7UWJ2DI4K3ZNHUSHPDKJL2IE5FKY3BSRAA",
        "CBX5SMLTXX6JP4HA5GQIO2V6QM7WCUGL2GZ6D4U773HMRI6RXISKPUR3",
        "transfer",
        [],
        fakeSigner,
      ),
    ).resolves.toMatchObject({ hash: FAKE_HASH });

    // Polling should have been called for DUPLICATE.
    expect(mockServer.getTransaction).toHaveBeenCalledWith(FAKE_HASH);
  });

  it("PENDING falls through to poll as before", async () => {
    const { mockServer, invokeContract } = freshStellar("PENDING");

    await expect(
      invokeContract(
        "testnet",
        "GAIQGTOBTTLLDJ4SWGGESM7UWJ2DI4K3ZNHUSHPDKJL2IE5FKY3BSRAA",
        "CBX5SMLTXX6JP4HA5GQIO2V6QM7WCUGL2GZ6D4U773HMRI6RXISKPUR3",
        "transfer",
        [],
        fakeSigner,
      ),
    ).resolves.toMatchObject({ hash: FAKE_HASH });

    expect(mockServer.getTransaction).toHaveBeenCalledWith(FAKE_HASH);
  });

  it("throws ContractError for ERROR status with network-rejected message", async () => {
    const { mockServer, invokeContract } = freshStellar("ERROR");
    (mockServer.sendTransaction as jest.Mock).mockResolvedValue({
      status: "ERROR",
      hash: FAKE_HASH,
      errorResult: { message: "bad tx" },
    });

    await expect(
      invokeContract(
        "testnet",
        "GAIQGTOBTTLLDJ4SWGGESM7UWJ2DI4K3ZNHUSHPDKJL2IE5FKY3BSRAA",
        "CBX5SMLTXX6JP4HA5GQIO2V6QM7WCUGL2GZ6D4U773HMRI6RXISKPUR3",
        "transfer",
        [],
        fakeSigner,
      ),
    ).rejects.toMatchObject({
      name: "ContractError",
      message: expect.stringContaining("rejected"),
    });

    expect(mockServer.getTransaction).not.toHaveBeenCalled();
  });

  it("throws ContractError for unknown status codes", async () => {
    const { invokeContract } = freshStellar("UNKNOWN_FUTURE_STATUS");

    await expect(
      invokeContract(
        "testnet",
        "GAIQGTOBTTLLDJ4SWGGESM7UWJ2DI4K3ZNHUSHPDKJL2IE5FKY3BSRAA",
        "CBX5SMLTXX6JP4HA5GQIO2V6QM7WCUGL2GZ6D4U773HMRI6RXISKPUR3",
        "transfer",
        [],
        fakeSigner,
      ),
    ).rejects.toMatchObject({
      name: "ContractError",
      message: expect.stringContaining("UNKNOWN_FUTURE_STATUS"),
    });
  });
});
