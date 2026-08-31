import { Type, type Static } from "@sinclair/typebox";

const Percentage = Type.Number({ minimum: 0, maximum: 100 });
const NonNegativeInteger = Type.Integer({ minimum: 0 });

export const CriticalityRuleSchema = Type.Object(
  {
    pathPrefix: Type.String({ minLength: 1, maxLength: 500 }),
    area: Type.String({ minLength: 1, maxLength: 120 }),
    businessCriticality: Percentage
  },
  { additionalProperties: false }
);

export const RiskMetricsSchema = Type.Object(
  {
    businessCriticality: Type.Optional(Percentage),
    bugCount: Type.Optional(NonNegativeInteger),
    coverage: Type.Optional(Percentage),
    mutationScore: Type.Optional(Percentage),
    previousFailureRate: Type.Optional(Percentage),
    changesLast90Days: Type.Optional(NonNegativeInteger),
    relatedTests: Type.Optional(NonNegativeInteger)
  },
  { additionalProperties: false }
);

export const QualityEvidenceSchema = Type.Object(
  {
    regression: Type.Optional(
      Type.Object(
        {
          passed: NonNegativeInteger,
          failed: NonNegativeInteger,
          criticalFailures: NonNegativeInteger
        },
        { additionalProperties: false }
      )
    ),
    mutationScore: Type.Optional(Percentage),
    api: Type.Optional(
      Type.Object(
        {
          passed: NonNegativeInteger,
          failed: NonNegativeInteger
        },
        { additionalProperties: false }
      )
    ),
    flakyRate: Type.Optional(Percentage),
    coverage: Type.Optional(Percentage),
    mitigationCoverage: Type.Optional(Percentage),
    criticalSecurityIssues: Type.Optional(NonNegativeInteger),
    survivedCriticalMutants: Type.Optional(NonNegativeInteger)
  },
  { additionalProperties: false }
);

/**
 * Evidence that no adapter can execute yet. Regression, API and flakiness results are
 * deliberately absent: in the asynchronous flow they come only from a real execution.
 */
export const SuppliedEvidenceSchema = Type.Object(
  {
    mutationScore: Type.Optional(Percentage),
    coverage: Type.Optional(Percentage),
    mitigationCoverage: Type.Optional(Percentage),
    criticalSecurityIssues: Type.Optional(NonNegativeInteger),
    survivedCriticalMutants: Type.Optional(NonNegativeInteger)
  },
  { additionalProperties: false }
);

export const CreateDeterministicAnalysisRequestSchema = Type.Object(
  {
    project: Type.Object(
      {
        name: Type.String({ minLength: 1, maxLength: 120 }),
        slug: Type.String({ minLength: 1, maxLength: 120, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" })
      },
      { additionalProperties: false }
    ),
    repository: Type.Object(
      {
        name: Type.String({ minLength: 1, maxLength: 200 }),
        provider: Type.Optional(Type.Union([Type.Literal("LOCAL"), Type.Literal("GITHUB")])),
        branch: Type.String({ minLength: 1, maxLength: 300 }),
        baseSha: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        headSha: Type.String({ minLength: 1, maxLength: 64 })
      },
      { additionalProperties: false }
    ),
    gitDiff: Type.String({ minLength: 1, maxLength: 2_000_000 }),
    criticalityRules: Type.Optional(Type.Array(CriticalityRuleSchema, { maxItems: 200 })),
    riskMetrics: Type.Optional(RiskMetricsSchema),
    qualityEvidence: Type.Optional(QualityEvidenceSchema)
  },
  { additionalProperties: false }
);

/** Intake for the asynchronous flow: the analysis is queued and a worker executes it. */
export const CreateAnalysisRequestSchema = Type.Object(
  {
    project: Type.Object(
      {
        name: Type.String({ minLength: 1, maxLength: 120 }),
        slug: Type.String({ minLength: 1, maxLength: 120, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" })
      },
      { additionalProperties: false }
    ),
    repository: Type.Object(
      {
        name: Type.String({ minLength: 1, maxLength: 200 }),
        provider: Type.Optional(Type.Union([Type.Literal("LOCAL"), Type.Literal("GITHUB")])),
        branch: Type.String({ minLength: 1, maxLength: 300 }),
        baseSha: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        headSha: Type.String({ minLength: 1, maxLength: 64 })
      },
      { additionalProperties: false }
    ),
    gitDiff: Type.String({ minLength: 1, maxLength: 2_000_000 }),
    criticalityRules: Type.Optional(Type.Array(CriticalityRuleSchema, { maxItems: 200 })),
    riskMetrics: Type.Optional(RiskMetricsSchema),
    suppliedEvidence: Type.Optional(SuppliedEvidenceSchema)
  },
  { additionalProperties: false }
);

export const AnalysisIdParamsSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 100 })
  },
  { additionalProperties: false }
);

export type CreateAnalysisRequest = Static<typeof CreateAnalysisRequestSchema>;
export type CreateDeterministicAnalysisRequest = Static<
  typeof CreateDeterministicAnalysisRequestSchema
>;
export type SuppliedEvidenceInput = Static<typeof SuppliedEvidenceSchema>;
export type AnalysisIdParams = Static<typeof AnalysisIdParamsSchema>;
