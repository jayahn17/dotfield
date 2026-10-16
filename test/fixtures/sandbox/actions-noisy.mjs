// Logs to stdout, which corrupts the one JSON document the protocol expects.
export const chatty = (records) => {
  console.log('progress: working');
  return records;
};
