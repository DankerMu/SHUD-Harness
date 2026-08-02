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

type ExactTuple<Actual extends readonly unknown[], Expected extends readonly unknown[]> =
  [Actual] extends [Expected] ? [Expected] extends [Actual] ? true : false : false;

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
type DescriptorPrimitiveInvocationParametersAreExact = Assert<
  ExactTuple<Parameters<DescriptorPrimitiveInvocation>, []>
>;
type DescriptorPrimitiveMediatorUsesOnlyCanonicalOperationAndInvocation = Assert<
  DescriptorPrimitiveMediator extends ExpectedDescriptorPrimitiveMediator
    ? ExpectedDescriptorPrimitiveMediator extends DescriptorPrimitiveMediator ? true : false
    : false
>;
type DescriptorPrimitiveMediatorParametersAreExact = Assert<
  ExactTuple<
    Parameters<DescriptorPrimitiveMediator>,
    [operation: DescriptorOperation, invoke: DescriptorPrimitiveInvocation]
  >
>;
type ExpectedDescriptorPrimitiveInstaller = (mediator: ExpectedDescriptorPrimitiveMediator) => void;
type DescriptorPrimitiveInstallerUsesExactMediator = Assert<
  typeof installDescriptorPrimitiveMediator extends ExpectedDescriptorPrimitiveInstaller
    ? ExpectedDescriptorPrimitiveInstaller extends typeof installDescriptorPrimitiveMediator ? true : false
    : false
>;
type DescriptorPrimitiveInstallerParametersAreExact = Assert<
  ExactTuple<Parameters<typeof installDescriptorPrimitiveMediator>, [mediator: ExpectedDescriptorPrimitiveMediator]>
>;
type PublicCloseParameters = Parameters<ContractCapabilities["close"]>;
type PublicCloseHasOnlyDescriptorAndOwner = Assert<
  ExactTuple<PublicCloseParameters, [descriptor: CapabilityDescriptor, owner: CloseOwner]>
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

if (false) {
  const invocation = null as unknown as DescriptorPrimitiveInvocation;
  const mediator = null as unknown as DescriptorPrimitiveMediator;
  // @ts-expect-error Primitive invocation has no control parameters.
  invocation(() => undefined);
  // @ts-expect-error Primitive mediation has only operation and invocation parameters.
  mediator("open_root", invocation, () => undefined);
  // @ts-expect-error The installer has only one mediator parameter.
  installDescriptorPrimitiveMediator(mediator, () => undefined);
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
  DescriptorPrimitiveInvocationParametersAreExact,
  DescriptorPrimitiveMediatorUsesOnlyCanonicalOperationAndInvocation,
  DescriptorPrimitiveMediatorParametersAreExact,
  DescriptorPrimitiveInstallerUsesExactMediator,
  DescriptorPrimitiveInstallerParametersAreExact,
  PublicCloseHasOnlyDescriptorAndOwner
];
