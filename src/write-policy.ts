// Write-policy classification for the general context plane. Pure logic, no DB:
// decides what lifecycle status a new fact starts in, whether it may ever be
// auto-confirmed, and which status transitions are legal. The DB engine
// (general.ts) enforces these decisions; nothing else may set fact status.

/** Who/what produced the statement — the trust boundary of the write. */
export type TrustLevel =
  | "deterministic" // git, parsers, test runners, tool-returned structured records
  | "user_explicit" // the owner said it, meaning clear
  | "agent_inference" // an agent's own conclusion or guess
  | "external_content"; // web pages, emails, retrieved documents (prompt-injectable)

export type FactStatus =
  | "candidate" // extracted, unreviewed — never authoritative
  | "proposed" // queued for human review (sensitive or contradicting)
  | "confirmed" // authoritative memory
  | "disputed" // contradicted by newer evidence, unresolved
  | "superseded" // replaced by a newer confirmed fact (valid_to stamped)
  | "invalidated"; // reviewed and rejected

export type Sensitivity = "public" | "internal" | "personal" | "secret";

/** Predicate categories that always need human review before confirmation. */
export const SENSITIVE_PREDICATE_PATTERNS: RegExp[] = [
  /prefer|likes|dislikes|wants|intends|motivat/i, // inferred preferences/intent
  /relationship|married|partner|dating|family|friend/i, // personal relationships
  /medical|diagnos|health|medication/i,
  /financial|salary|income|debt|owns_account|bank/i,
  /legal|criminal|lawsuit/i,
  /credential|password|secret|token|api_key|identity_number|ssn|passport/i,
];

export interface WriteClassification {
  /** Status the fact is created with. */
  initialStatus: FactStatus;
  /** True when the engine may promote straight to confirmed without a human. */
  autoConfirm: boolean;
  /** True when confirmation requires an explicit human approval actor. */
  requiresHumanReview: boolean;
  /** True when the source is prompt-injectable and must be flagged. */
  injectionRisk: boolean;
  reason: string;
}

export function isSensitivePredicate(predicate: string): boolean {
  return SENSITIVE_PREDICATE_PATTERNS.some((re) => re.test(predicate));
}

/**
 * Decide the lifecycle entry point for a new fact.
 * Rules (spec: write-policy):
 *  - deterministic sources auto-confirm (commits, hashes, parser symbols, test results)
 *    UNLESS the predicate is sensitive (a tool can still surface a credential).
 *  - explicit user statements auto-confirm for non-sensitive predicates.
 *  - agent inference is always a candidate; sensitive inference must be proposed
 *    and can only be confirmed by a human.
 *  - external content NEVER auto-confirms and is flagged as injection risk.
 *  - a contradiction of an existing confirmed fact always forces review.
 */
export function classifyWrite(input: {
  trust: TrustLevel;
  predicate: string;
  sensitivity: Sensitivity;
  contradictsConfirmed?: boolean;
}): WriteClassification {
  const sensitive =
    isSensitivePredicate(input.predicate) ||
    input.sensitivity === "personal" ||
    input.sensitivity === "secret";
  const injectionRisk = input.trust === "external_content";

  if (input.contradictsConfirmed) {
    return {
      initialStatus: "proposed",
      autoConfirm: false,
      requiresHumanReview: true,
      injectionRisk,
      reason: "contradicts an existing confirmed fact; resolution needs review",
    };
  }
  if (injectionRisk) {
    return {
      initialStatus: "candidate",
      autoConfirm: false,
      requiresHumanReview: true,
      injectionRisk: true,
      reason: "external content is prompt-injectable; never auto-confirmed",
    };
  }
  if (sensitive) {
    return {
      initialStatus: input.trust === "user_explicit" ? "proposed" : "candidate",
      autoConfirm: false,
      requiresHumanReview: true,
      injectionRisk: false,
      reason: "sensitive predicate or sensitivity class requires human review",
    };
  }
  if (input.trust === "deterministic" || input.trust === "user_explicit") {
    return {
      initialStatus: "confirmed",
      autoConfirm: true,
      requiresHumanReview: false,
      injectionRisk: false,
      reason:
        input.trust === "deterministic"
          ? "deterministic source (git/parser/test/tool record)"
          : "explicit user statement, non-sensitive",
    };
  }
  return {
    initialStatus: "candidate",
    autoConfirm: false,
    requiresHumanReview: false,
    injectionRisk: false,
    reason: "agent inference starts as candidate; promote after verification",
  };
}

/** Legal status transitions; anything else is rejected by the engine. */
const TRANSITIONS: Record<FactStatus, FactStatus[]> = {
  candidate: ["proposed", "confirmed", "invalidated", "superseded"],
  proposed: ["confirmed", "invalidated"],
  confirmed: ["disputed", "superseded", "invalidated"],
  disputed: ["confirmed", "superseded", "invalidated"],
  superseded: [],
  invalidated: [],
};

export function canTransition(from: FactStatus, to: FactStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Guard a promotion to confirmed: candidates from non-human paths may only be
 * confirmed by a human actor when the original classification demanded review.
 */
export function assertPromotionAllowed(opts: {
  from: FactStatus;
  to: FactStatus;
  requiresHumanReview: boolean;
  humanApproved: boolean;
}): void {
  if (!canTransition(opts.from, opts.to)) {
    throw new Error(`Illegal fact transition ${opts.from} → ${opts.to}`);
  }
  if (opts.to === "confirmed" && opts.requiresHumanReview && !opts.humanApproved) {
    throw new Error(
      "This fact requires explicit human approval to confirm (sensitive, contradicting, or external-content origin)",
    );
  }
}
