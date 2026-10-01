import { useEffect } from "react";
import { errorFeedback, reportClientError, type ErrorContext } from "@jizuo/contracts";

/** Use for stored/job errors; diagnostics are written after render, never during it. */
export function ErrorText({ error, operation, fallback, effect }: { error: unknown } & ErrorContext) {
  useEffect(() => { if (error) reportClientError(error, { operation, effect }); }, [error, operation, effect]);
  return <>{errorFeedback(error, { operation, fallback, effect }).message}</>;
}
