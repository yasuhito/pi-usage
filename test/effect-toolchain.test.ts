import { expect, layer } from "@effect/vitest";
import { Context, Effect, Fiber, Layer, TestClock } from "effect";

class TestValue extends Context.Tag("TestValue")<TestValue, string>() {
  static readonly layer = Layer.succeed(TestValue, "available");
}

layer(TestValue.layer)("Effect test toolchain", (it) => {
  it.scoped("provides layers, scopes, fibers, and virtual time", () =>
    Effect.gen(function* () {
      const value = yield* TestValue;
      const resource = yield* Effect.acquireRelease(
        Effect.succeed("acquired"),
        () => Effect.void,
      );
      const fiber = yield* Effect.fork(
        Effect.sleep("1 hour").pipe(Effect.as("complete")),
      );

      yield* TestClock.adjust("1 hour");

      expect(value).toBe("available");
      expect(resource).toBe("acquired");
      expect(yield* Fiber.join(fiber)).toBe("complete");
    }),
  );
});
