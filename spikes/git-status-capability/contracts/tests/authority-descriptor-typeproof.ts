import {
  type ContractCapabilities,
  DESCRIPTOR_OPERATION_POLICY,
  installDescriptorPrimitiveMediator,
  type CapabilityDescriptor,
  type CloseOwner,
  type DescriptorOperation,
  type DescriptorPrimitiveInvocation,
  type DescriptorPrimitiveMediator
} from "../lib/capabilities";
import type { DescriptorIngressOperation } from "../lib/ingress";

type Assert<Condition extends true> = Condition;

type ExpectedCanonicalDescriptorOperation =
  | "open_root"
  | "openat"
  | "mark_retained"
  | "fstat_sync"
  | "read_sync"
  | "close_sync";
type CanonicalPolicyKey = keyof typeof DESCRIPTOR_OPERATION_POLICY;
type DescriptorIngressVocabulary =
  | "open_root"
  | "open_relative"
  | "read_retained";
type IngressOperation = DescriptorIngressOperation["operation"];
type ExpectedDescriptorPrimitiveInvocation = () => unknown;
type ExpectedDescriptorPrimitiveMediator = (
  operation: DescriptorOperation,
  invoke: DescriptorPrimitiveInvocation
) => undefined;

type CanonicalOperationIncludesEveryPolicyKey = Assert<
  CanonicalPolicyKey extends DescriptorOperation ? true : false
>;
type CanonicalPolicyIncludesEveryOperation = Assert<
  DescriptorOperation extends CanonicalPolicyKey ? true : false
>;
type CanonicalExpectationIncludesEveryOperation = Assert<
  DescriptorOperation extends ExpectedCanonicalDescriptorOperation ? true : false
>;
type CanonicalOperationIncludesEveryExpectation = Assert<
  ExpectedCanonicalDescriptorOperation extends DescriptorOperation ? true : false
>;
type IngressExpectationIncludesEveryOperation = Assert<
  IngressOperation extends DescriptorIngressVocabulary ? true : false
>;
type IngressOperationIncludesEveryExpectation = Assert<
  DescriptorIngressVocabulary extends IngressOperation ? true : false
>;
type IngressVocabularyIsDistinctFromCanonical = Assert<
  DescriptorOperation extends IngressOperation ? false : IngressOperation extends DescriptorOperation ? false : true
>;
type DescriptorPrimitiveInvocationIsErasedCallback = Assert<
  DescriptorPrimitiveInvocation extends ExpectedDescriptorPrimitiveInvocation
    ? ExpectedDescriptorPrimitiveInvocation extends DescriptorPrimitiveInvocation ? true : false
    : false
>;
type DescriptorPrimitiveMediatorUsesOnlyCanonicalOperationAndInvocation = Assert<
  DescriptorPrimitiveMediator extends ExpectedDescriptorPrimitiveMediator
    ? ExpectedDescriptorPrimitiveMediator extends DescriptorPrimitiveMediator ? true : false
    : false
>;
type ExpectedDescriptorPrimitiveInstaller = (mediator: ExpectedDescriptorPrimitiveMediator) => void;
type DescriptorPrimitiveInstallerUsesExactMediator = Assert<
  typeof installDescriptorPrimitiveMediator extends ExpectedDescriptorPrimitiveInstaller
    ? ExpectedDescriptorPrimitiveInstaller extends typeof installDescriptorPrimitiveMediator ? true : false
    : false
>;
type PublicCloseParameters = Parameters<ContractCapabilities["close"]>;
type PublicCloseHasOnlyDescriptorAndOwner = Assert<
  PublicCloseParameters extends [CapabilityDescriptor, CloseOwner]
    ? [CapabilityDescriptor, CloseOwner] extends PublicCloseParameters ? true : false
    : false
>;

if (false) {
  // @ts-expect-error Descriptor mediation cannot return a Promise.
  installDescriptorPrimitiveMediator(async (_operation, _invoke) => undefined);
}

if (false) {
  const capabilities = null as unknown as ContractCapabilities;
  // @ts-expect-error Public close accepts only an opaque descriptor and owner.
  capabilities.close({} as CapabilityDescriptor, "unretained", () => false);
}

export type DescriptorOperationTypeProof = readonly [
  CanonicalOperationIncludesEveryPolicyKey,
  CanonicalPolicyIncludesEveryOperation,
  CanonicalExpectationIncludesEveryOperation,
  CanonicalOperationIncludesEveryExpectation,
  IngressExpectationIncludesEveryOperation,
  IngressOperationIncludesEveryExpectation,
  IngressVocabularyIsDistinctFromCanonical,
  DescriptorPrimitiveInvocationIsErasedCallback,
  DescriptorPrimitiveMediatorUsesOnlyCanonicalOperationAndInvocation,
  DescriptorPrimitiveInstallerUsesExactMediator,
  PublicCloseHasOnlyDescriptorAndOwner
];
