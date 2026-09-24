import { useEffect, useState } from "react";
import { healthService } from "../services/healthService";
import type { HealthStatus } from "../types/health";

type State =
  { status: "loading" } | { status: "success"; data: HealthStatus } | { status: "error"; message: string };

export function useHealth(): State {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    healthService
      .getHealth()
      .then((data) => {
        if (!cancelled) setState({ status: "success", data });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
