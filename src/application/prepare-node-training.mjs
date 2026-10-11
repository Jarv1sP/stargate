/** Trusted node preparation only; compilation does not grant permission to execute. */
export class PrepareNodeTraining {
  constructor({compiler, bindings}) {this.compiler = compiler; this.bindings = bindings;}
  async execute(input, pool) {
    const compiled = await this.compiler.compile(input, pool);
    return this.bindings.prepareTraining(compiled);
  }
}
