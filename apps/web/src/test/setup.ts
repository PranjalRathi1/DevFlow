import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Testing Library's automatic cleanup-between-tests relies on detecting a
// global afterEach; this project imports test APIs explicitly rather than
// using Vitest's `globals: true`, so it must be registered here instead —
// otherwise every render() in a file accumulates in the same jsdom
// document, and later assertions in the same file start matching multiple
// leftover elements from earlier tests.
afterEach(() => {
  cleanup();
});
