import test from "node:test";
import { assertRelayBoundary } from "./relay";

test("application files do not construct the relay store", () => {
  assertRelayBoundary();
});
