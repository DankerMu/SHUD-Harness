export const SOURCE_PROFILE = Object.freeze({ bytes: 65_536, depth: 12, nodes: 2_048, items: 512 });
export const SOURCE_METADATA_PROFILE = Object.freeze({ bytes: 262_144, depth: 32, nodes: 32_768, items: 8_192 });

export const SYNTHETIC_DIGEST = "069f34220c6059b162d9bf16cada6a345eb5d9b3235bd813dde4d72402a2e4dd";
export const SYNTHETIC_FRAME_BYTES = 152;
export const SOURCE_MANIFEST = "spikes/git-status-capability/contracts/source-input-v1.paths";
export const CONTRACT_METADATA = "spikes/git-status-capability/contracts/contract-v1.json";
export const SYNTHETIC_FRAME = "spikes/git-status-capability/contracts/goldens/source-input-v1.synthetic.frame";
export const SYNTHETIC_SIDECAR = "spikes/git-status-capability/contracts/goldens/source-input-v1.synthetic.sha256";

export const SUCCESS_SCHEMA = "shud.git-status-capability.contract-check-receipt.v1";
export const ERROR_SCHEMA = "shud.git-status-capability.contract-error.v1";
