export const explode = () => { throw new Error('boom from the module'); };
export const exits = () => { process.exit(7); };
export const quiet = () => { process.exit(0); };
