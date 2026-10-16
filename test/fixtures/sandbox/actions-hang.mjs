// Never settles and keeps the event loop alive; the sandbox timeout must end it.
// (Without the interval Node would exit 13 on the unsettled await instead.)
export const hang = () => new Promise(() => { setInterval(() => {}, 1000); });
