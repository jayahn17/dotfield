export const env = () => ({ keys: Object.keys(process.env).sort(), tz: process.env.TZ, sandbox: process.env.DOTFIELD_SANDBOX });
