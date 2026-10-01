import type { TypertRemoteContribution } from "@deepseek-ai/dsh-typert-protocol";

import { JIZUO_INVOCATIONS, PACKAGE_NAME } from "./remote-contract.ts";

export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: PACKAGE_NAME,
  descriptors: JIZUO_INVOCATIONS,
};

export default TYPERT_REMOTE;
