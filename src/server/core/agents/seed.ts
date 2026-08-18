import { dbAgents } from './db';
import { CORE_AGENTS } from './roster';

/**
 * Upserts the code-defined agent roster into `coreAgents`.
 *
 * The roster is authored in code (reasoning cannot live in the database), but a
 * row per agent exists so operators can disable an agent and so the audit trail
 * can name the mandate and confidence ceiling in force at decision time.
 * Idempotent — safe to re-run, and it never clobbers the `enabled` flag.
 */
export async function seedAgentRoster() {
  const now = new Date();

  for (const a of CORE_AGENTS) {
    await dbAgents.upsertOne(
      { agentId: a.agentId },
      {
        $set: {
          name: a.name,
          discipline: a.discipline,
          mandate: a.mandate,
          sourceScope: a.sourceScope,
          metricScope: a.metricScope,
          maxConfidence: a.maxConfidence,
          agentVersion: a.agentVersion,
          dataOrigin: 'seed',
          updatedAt: now,
        },
        $setOnInsert: {
          agentId: a.agentId,
          // Operator intent, not roster metadata — never overwritten on re-seed.
          enabled: true,
          createdAt: now,
        },
      }
    );
  }

  return `Seeded ${CORE_AGENTS.length} core agents.`;
}
