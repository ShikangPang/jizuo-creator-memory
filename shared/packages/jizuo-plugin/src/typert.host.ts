import { JIZUO_INVOCATIONS, PACKAGE_NAME } from "./remote-contract.ts";

export const TYPERT = {
  package: PACKAGE_NAME,
  face: "host" as const,
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: JIZUO_INVOCATIONS,
};
