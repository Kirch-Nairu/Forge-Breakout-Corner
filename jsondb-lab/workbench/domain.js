'use strict';

const DOMAIN_VERSION = 1;

const unresolvedDomains = [
  {
    id: 'kirion-saturn',
    label: 'KIRION SATURN',
    status: 'UNRESOLVED_DOMAIN',
    reason: 'No trustworthy definition was available from current memory or live GitHub sources. Seeder must not invent semantics.'
  },
  {
    id: 'project-second-brain',
    label: 'PROJECT SECOND BRAIN',
    status: 'UNRESOLVED_DOMAIN',
    reason: 'No trustworthy definition was available from current memory or live GitHub sources. Seeder must not invent semantics.'
  }
];

const domains = [
  {
    id: 'forge',
    label: 'KIRION FORGE',
    role: 'governed engineering control plane',
    colorRole: 'authority',
    summary: 'Projects, features/work packages, exact SHAs, handoffs, evidence, CI/QA, findings, rework, acceptance, promotion, audit and contribution.'
  },
  {
    id: 'earth',
    label: 'KIRION EARTH',
    role: 'engineering reasoning and research',
    colorRole: 'reasoning',
    summary: 'Architecture decisions, requirements, research cases, design questions, tradeoffs and engineering conclusions.'
  },
  {
    id: 'jupiter',
    label: 'KIRION JUPITER',
    role: 'cybersecurity and adversarial assurance',
    colorRole: 'security',
    summary: 'Synthetic assets, findings, controls, detections, threat models, authorization boundaries and SOC-like event streams.'
  },
  {
    id: 'mars',
    label: 'KIRION MARS',
    role: 'data, RAG, ML and evaluation',
    colorRole: 'data',
    summary: 'Datasets, chunks, embeddings, retrieval/evaluation runs, indexes and training/evaluation pipeline evidence.'
  }
];

// Order matters: referenced collections are created before collections that point at them.
const collections = [
  {
    name: 'workbench_seed_runs',
    domain: 'forge',
    purpose: 'Every synthetic workload run and its requested benchmark profile.',
    unique: ['runKey'],
    indexes: [
      { name: 'seed_runs_scenario', fields: ['scenario'] },
      { name: 'seed_runs_status', fields: ['status'] }
    ]
  },
  {
    name: 'kirion_projects',
    domain: 'forge',
    purpose: 'Synthetic KIRION engineering projects/repositories.',
    unique: ['projectKey'],
    indexes: [
      { name: 'projects_domain', fields: ['domain'] },
      { name: 'projects_status', fields: ['status'] },
      { name: 'projects_priority', fields: ['priority'] },
      { name: 'projects_seed_run', fields: ['seedRunId'] }
    ]
  },
  {
    name: 'forge_work_packages',
    domain: 'forge',
    purpose: 'Bounded engineering work packages with exact authority/evidence state.',
    unique: ['workPackageKey'],
    foreignKeys: [
      { field: 'projectId', references: { collection: 'kirion_projects', field: 'id' }, onDelete: 'restrict' }
    ],
    indexes: [
      { name: 'work_packages_project', fields: ['projectId'] },
      { name: 'work_packages_state', fields: ['state'] },
      { name: 'work_packages_priority', fields: ['priority'] },
      { name: 'work_packages_owner', fields: ['owner'] },
      { name: 'work_packages_seed_run', fields: ['seedRunId'] }
    ]
  },
  {
    name: 'forge_evidence',
    domain: 'forge',
    purpose: 'Evidence manifests, review artifacts, negative-test evidence and acceptance records.',
    unique: ['evidenceKey'],
    foreignKeys: [
      { field: 'workPackageId', references: { collection: 'forge_work_packages', field: 'id' }, onDelete: 'restrict' }
    ],
    indexes: [
      { name: 'evidence_work_package', fields: ['workPackageId'] },
      { name: 'evidence_type', fields: ['evidenceType'] },
      { name: 'evidence_state', fields: ['state'] },
      { name: 'evidence_seed_run', fields: ['seedRunId'] }
    ]
  },
  {
    name: 'forge_ci_runs',
    domain: 'forge',
    purpose: 'Synthetic CI/QA/acceptance gate executions.',
    unique: ['runKey'],
    foreignKeys: [
      { field: 'workPackageId', references: { collection: 'forge_work_packages', field: 'id' }, onDelete: 'restrict' }
    ],
    indexes: [
      { name: 'ci_work_package', fields: ['workPackageId'] },
      { name: 'ci_status', fields: ['status'] },
      { name: 'ci_gate', fields: ['gate'] },
      { name: 'ci_seed_run', fields: ['seedRunId'] }
    ]
  },
  {
    name: 'earth_cases',
    domain: 'earth',
    purpose: 'Architecture/research reasoning cases and design decisions.',
    unique: ['caseKey'],
    foreignKeys: [
      { field: 'projectId', references: { collection: 'kirion_projects', field: 'id' }, onDelete: 'restrict' }
    ],
    indexes: [
      { name: 'earth_project', fields: ['projectId'] },
      { name: 'earth_kind', fields: ['kind'] },
      { name: 'earth_status', fields: ['status'] },
      { name: 'earth_priority', fields: ['priority'] },
      { name: 'earth_seed_run', fields: ['seedRunId'] }
    ]
  },
  {
    name: 'jupiter_assets',
    domain: 'jupiter',
    purpose: 'Synthetic systems/assets used for defensive security workloads.',
    unique: ['assetKey'],
    indexes: [
      { name: 'jupiter_asset_class', fields: ['assetClass'] },
      { name: 'jupiter_asset_exposure', fields: ['exposure'] },
      { name: 'jupiter_asset_risk', fields: ['risk'] },
      { name: 'jupiter_asset_seed_run', fields: ['seedRunId'] }
    ]
  },
  {
    name: 'jupiter_findings',
    domain: 'jupiter',
    purpose: 'Synthetic defensive findings/control gaps with no real exploit payloads.',
    unique: ['findingKey'],
    foreignKeys: [
      { field: 'assetId', references: { collection: 'jupiter_assets', field: 'id' }, onDelete: 'restrict' }
    ],
    indexes: [
      { name: 'jupiter_finding_asset', fields: ['assetId'] },
      { name: 'jupiter_finding_severity', fields: ['severity'] },
      { name: 'jupiter_finding_status', fields: ['status'] },
      { name: 'jupiter_finding_category', fields: ['category'] },
      { name: 'jupiter_finding_seed_run', fields: ['seedRunId'] }
    ]
  },
  {
    name: 'jupiter_events',
    domain: 'jupiter',
    purpose: 'High-volume synthetic SOC/detection stream using documentation networks and .test domains.',
    unique: ['eventKey'],
    foreignKeys: [
      { field: 'assetId', references: { collection: 'jupiter_assets', field: 'id' }, onDelete: 'restrict' }
    ],
    indexes: [
      { name: 'jupiter_event_asset', fields: ['assetId'] },
      { name: 'jupiter_event_type', fields: ['eventType'] },
      { name: 'jupiter_event_severity', fields: ['severity'] },
      { name: 'jupiter_event_disposition', fields: ['disposition'] },
      { name: 'jupiter_event_seed_run', fields: ['seedRunId'] }
    ]
  },
  {
    name: 'mars_datasets',
    domain: 'mars',
    purpose: 'Synthetic dataset/evaluation corpora for RAG and ML pipeline workloads.',
    unique: ['datasetKey'],
    indexes: [
      { name: 'mars_dataset_status', fields: ['status'] },
      { name: 'mars_dataset_modality', fields: ['modality'] },
      { name: 'mars_dataset_seed_run', fields: ['seedRunId'] }
    ]
  },
  {
    name: 'mars_chunks',
    domain: 'mars',
    purpose: 'Synthetic RAG chunks with small numeric embeddings for vector/full-text experiments.',
    unique: ['chunkKey'],
    foreignKeys: [
      { field: 'datasetId', references: { collection: 'mars_datasets', field: 'id' }, onDelete: 'restrict' }
    ],
    indexes: [
      { name: 'mars_chunk_dataset', fields: ['datasetId'] },
      { name: 'mars_chunk_topic', fields: ['topic'] },
      { name: 'mars_chunk_seed_run', fields: ['seedRunId'] }
    ]
  },
  {
    name: 'mars_evaluations',
    domain: 'mars',
    purpose: 'Synthetic retrieval/model evaluation outcomes.',
    unique: ['evaluationKey'],
    foreignKeys: [
      { field: 'datasetId', references: { collection: 'mars_datasets', field: 'id' }, onDelete: 'restrict' }
    ],
    indexes: [
      { name: 'mars_eval_dataset', fields: ['datasetId'] },
      { name: 'mars_eval_metric', fields: ['metric'] },
      { name: 'mars_eval_status', fields: ['status'] },
      { name: 'mars_eval_seed_run', fields: ['seedRunId'] }
    ]
  },
  {
    name: 'benchmark_records',
    domain: 'benchmark',
    purpose: 'Purpose-built mixed-cardinality workload for planner, index, aggregation and history benchmarks.',
    unique: ['benchKey'],
    indexes: [
      { name: 'benchmark_priority', fields: ['priority'] },
      { name: 'benchmark_status', fields: ['status'] },
      { name: 'benchmark_domain', fields: ['domain'] },
      { name: 'benchmark_hot_key', fields: ['hotKey'] },
      { name: 'benchmark_seed_run', fields: ['seedRunId'] },
      { name: 'benchmark_domain_priority', fields: ['domain', 'priority'] }
    ]
  }
];

const collectionByName = Object.fromEntries(collections.map(item => [item.name, item]));
const allowedCollections = new Set(collections.map(item => item.name));

const scales = {
  smoke: {
    label: 'Smoke',
    description: 'CI-sized workload that proves every domain path.',
    projects: 4,
    workPackages: 24,
    evidence: 48,
    ciRuns: 40,
    earthCases: 24,
    jupiterAssets: 12,
    jupiterFindings: 36,
    jupiterEvents: 120,
    marsDatasets: 6,
    marsChunks: 48,
    marsEvaluations: 24,
    benchmarkRecords: 300
  },
  demo: {
    label: 'Demo',
    description: 'Interactive local demo with enough data to make Observatory visibly busy.',
    projects: 12,
    workPackages: 180,
    evidence: 360,
    ciRuns: 300,
    earthCases: 160,
    jupiterAssets: 80,
    jupiterFindings: 280,
    jupiterEvents: 1800,
    marsDatasets: 24,
    marsChunks: 480,
    marsEvaluations: 160,
    benchmarkRecords: 4000
  },
  load: {
    label: 'Load',
    description: 'Serious local workload for planner/index/history observation.',
    projects: 30,
    workPackages: 600,
    evidence: 1200,
    ciRuns: 1000,
    earthCases: 500,
    jupiterAssets: 180,
    jupiterFindings: 900,
    jupiterEvents: 8000,
    marsDatasets: 60,
    marsChunks: 2400,
    marsEvaluations: 500,
    benchmarkRecords: 15000
  },
  stress: {
    label: 'Stress',
    description: 'Heavy JSON workload. Expect intentionally expensive full-state validation/index rebuild behavior.',
    projects: 60,
    workPackages: 1500,
    evidence: 2800,
    ciRuns: 2200,
    earthCases: 1000,
    jupiterAssets: 400,
    jupiterFindings: 2200,
    jupiterEvents: 22000,
    marsDatasets: 120,
    marsChunks: 7000,
    marsEvaluations: 1200,
    benchmarkRecords: 40000
  }
};

module.exports = {
  DOMAIN_VERSION,
  domains,
  unresolvedDomains,
  collections,
  collectionByName,
  allowedCollections,
  scales
};
