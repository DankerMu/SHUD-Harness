import {
  DESCRIPTOR_OPERATION_POLICY,
  type DescriptorOperation
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

export type DescriptorOperationTypeProof = readonly [
  CanonicalOperationIncludesEveryPolicyKey,
  CanonicalPolicyIncludesEveryOperation,
  CanonicalExpectationIncludesEveryOperation,
  CanonicalOperationIncludesEveryExpectation,
  IngressExpectationIncludesEveryOperation,
  IngressOperationIncludesEveryExpectation,
  IngressVocabularyIsDistinctFromCanonical
];
