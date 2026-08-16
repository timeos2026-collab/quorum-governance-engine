import { dbObservations, dbJobRuns, type ObservationSourceType } from './db';
import { GENERATORS, GENERATOR_VERSION } from './generators';

/**
 * Ingestion runner — the single write path into the evidence layer.
 *
 * Guarantees:
 *  - Every run opens a `coreJobRuns` row before doing any work and closes it
 *    with a status, counts and errors. A run that crashes still leaves a row.
 *  - Observations are keyed deterministically, so re-running a run key is a
 *    no-op rather than a duplicate or an overwrite. Historical evidence is
 *    never mutated.
 *  - `dataOrigin: 'simulated'` is stamped on everything until a real feed is
 *    wired in.
 */

/** Groups a timestamp into a stable bucket so scheduled reruns are idempotent. */
export function bucketRunKey(sourceType: ObservationSourceType, at: Date, bucketMs: number) {
  return `${sourceType}:${Math.floor(at.getTime() / bucketMs)}`;
}

export type IngestResult = {
  jobRunId: string;
  status: 'succeeded' | 'failed' | 'skipped';
  written: number;
  skipped: number;
  errors: string[];
};

export async function runIngestion({
  sourceType,
  runKey,
  trigger,
  triggeredBy,
}: {
  sourceType: ObservationSourceType;
  runKey: string;
  trigger: 'cron' | 'manual';
  triggeredBy?: string;
}): Promise<IngestResult> {
  const jobId = `evidence.ingest.${sourceType}`;

  // A run key that already exists means this exact run was already recorded.
  // Replay must not fork history, so we stop here and report the prior run.
  const existing = await dbJobRuns.findOne({ jobId, runKey });
  if (existing) {
    return {
      jobRunId: existing._id.toString(),
      status: 'skipped',
      written: 0,
      skipped: existing.observationsWritten,
      errors: [],
    };
  }

  const startedAt = new Date();
  const { insertedId } = await dbJobRuns.insertOne({
    jobId,
    runKey,
    trigger,
    triggeredBy,
    startedAt,
    status: 'running',
    inputSnapshot: JSON.stringify({ sourceType, runKey, registrySnapshotAt: startedAt.toISOString() }),
    outputSummary: '',
    observationsWritten: 0,
    observationsSkipped: 0,
    errors: [],
    generatorVersion: GENERATOR_VERSION,
    sourceCoverage: [],
    dataOrigin: 'simulated',
  });
  const jobRunId = insertedId.toString();

  const errors: string[] = [];
  let written = 0;
  let skipped = 0;
  const coverage = new Set<string>();

  try {
    const drafts = await GENERATORS[sourceType](runKey, startedAt);

    for (const d of drafts) {
      const observationKey = `${jobId}:${runKey}:${d.relevantEntityId}:${d.metric}`;
      coverage.add(d.source);
      try {
        await dbObservations.insertOne({
          observationKey,
          sourceType: d.sourceType,
          source: d.source,
          observedAt: d.observedAt,
          retrievalTimestamp: startedAt,
          verifiability: d.verifiability,
          relevantEntityType: d.relevantEntityType,
          relevantEntityId: d.relevantEntityId,
          relevantJurisdictionId: d.relevantJurisdictionId,
          metric: d.metric,
          value: d.value,
          unit: d.unit,
          statement: d.statement,
          jobRunId,
          generatorVersion: GENERATOR_VERSION,
          dataOrigin: 'simulated',
          createdAt: startedAt,
        });
        written++;
      } catch (e) {
        // Duplicate key = this observation already exists for this run key.
        // That is the replay guarantee working, not a failure.
        const message = (e as Error).message ?? String(e);
        if (message.includes('E11000') || message.toLowerCase().includes('duplicate')) {
          skipped++;
        } else {
          errors.push(`${observationKey}: ${message}`);
        }
      }
    }

    const endedAt = new Date();
    await dbJobRuns.updateOne(
      { _id: insertedId },
      {
        $set: {
          endedAt,
          status: errors.length > 0 ? 'failed' : 'succeeded',
          observationsWritten: written,
          observationsSkipped: skipped,
          errors,
          sourceCoverage: [...coverage],
          outputSummary: `${written} observations written, ${skipped} already present, ${errors.length} errors across ${coverage.size} sources in ${endedAt.getTime() - startedAt.getTime()}ms.`,
        },
      }
    );

    return {
      jobRunId,
      status: errors.length > 0 ? 'failed' : 'succeeded',
      written,
      skipped,
      errors,
    };
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    await dbJobRuns.updateOne(
      { _id: insertedId },
      {
        $set: {
          endedAt: new Date(),
          status: 'failed',
          observationsWritten: written,
          observationsSkipped: skipped,
          errors: [...errors, message],
          sourceCoverage: [...coverage],
          outputSummary: `Run aborted: ${message}`,
        },
      }
    );
    return { jobRunId, status: 'failed', written, skipped, errors: [...errors, message] };
  }
}
