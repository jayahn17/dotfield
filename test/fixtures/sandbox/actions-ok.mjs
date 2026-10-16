// A well-behaved actions module: pure functions over records, no fs.
export const tag = (records, input) => records.map((r) => ({ ...r, tag: input.tag }));
export const double = async (records) => records.map((r) => ({ ...r, n: r.n * 2 }));
export const nothing = () => undefined;
export const notAFunction = 42;
