import {ApplicationError} from '../domain/errors.mjs';

/** Internal scale proposal: reuse native legal counts, then atomically reserve the delta. */
export class ReserveTaskExpansion {
  constructor({authority, validator, claims, clock = Date.now}) {
    this.authority = authority; this.validator = validator; this.claims = claims; this.clock = clock;
  }
  async execute(jobId, change) {
    const {submission} = await this.authority.context(jobId);
    if (!submission.resources.autoScaleUp) throw new ApplicationError('INVALID_COMPUTE_EXPANSION');
    const validated = await this.validator.intent(submission);
    if (!validated.allowedGpuCounts.includes(change.sourceGpuCount) || !validated.allowedGpuCounts.includes(change.targetGpuCount)) {
      throw new ApplicationError('INVALID_COMPUTE_EXPANSION');
    }
    return this.claims.reserveExpansionForTask(jobId, change, this.clock());
  }
}
