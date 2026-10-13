import {ApplicationError} from '../domain/errors.mjs';

/** Record intent only. Background admission owns node reads, quota and dispatch. */
export class SubmitTrainingTask {
  constructor({queue, catalog, resources, clock = Date.now}) {
    this.queue = queue; this.catalog = catalog; this.resources = resources; this.clock = clock;
  }

  async execute(actor, input) {
    if (await this.queue.request(actor, input.requestId, this.clock())) {
      // The journal compares the complete immutable payload on a repeated submit.
      // Prior acknowledgement recovery must not depend on a node being online.
      return this.queue.enqueue(actor, input, this.clock());
    }
    await this.#requireCandidate(actor, input);
    await this.resources.intent(input);
    // Native policy validation is asynchronous; recheck current account/project.
    await this.#requireCandidate(actor, input);
    return this.queue.enqueue(actor, input, this.clock());
  }

  async #requireCandidate(actor, input) {
    const result = await this.catalog.candidates(actor, input, this.clock());
    if (!result.candidates.length) throw new ApplicationError('TRAINING_NO_ELIGIBLE_MACHINE');
  }
}
