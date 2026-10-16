// Rule family "server": server/serve.mjs and server/wall.mjs. Gate id: "server".
export const family = 'server';
export const gate = 'server';
export const rules = {
  DF_SERVER_DECIDE_REFUSED: { gate, blocking: true, exit: 3,
    message: 'POST /api/proposals/<id>/decide lacked the JSON content type, the X-Dotfield-Owner header or a same-origin Sec-Fetch-Site.',
    repair: 'Decide from the inbox page opened with the TTY-printed /inbox?t= URL; cross-origin requests are refused by design.' },
  DF_SERVER_WALL_REFUSED: { gate, blocking: true, exit: 3,
    message: 'A non-local request reached a private_live room or a sensitive field set.',
    repair: 'Use the server from the same machine, or set DOTFIELD_TRUSTED_PROXY_WALL=1 only when a wall sits in front.' },
  DF_SERVER_LISTEN_FAILED: { gate, blocking: true,
    message: 'The local server exited before it could serve: the port is already in use or the listener failed.',
    repair: 'Stop the other dotfield serve (or whatever holds the port), or pass a free --port; a server that did not start is reported as an error, never as ok.' },
  DF_SERVER_ROUTE_UNKNOWN: { gate, blocking: true,
    message: 'No route matches the request path.',
    repair: 'Use the routes listed in references/RULES.md (health, api/registry, api/rooms/<id>/..., api/proposals, renders, inbox).' },
  DF_SERVER_METHOD_NOT_ALLOWED: { gate, blocking: true,
    message: 'The HTTP method is not allowed on this route.',
    repair: 'Use GET for reads and POST for propose and decide.' },
  DF_SERVER_BODY_INVALID: { gate, blocking: true,
    message: 'The request body is not the JSON shape the route expects.',
    repair: 'Send application/json matching the route schema; the message names the DF_SCHEMA_* finding.' },
  DF_SERVER_BODY_TOO_LARGE: { gate, blocking: true,
    message: 'The request body exceeds the server limit.',
    repair: 'Split the proposal; approval.max_records_per_proposal bounds one request.' },
  DF_SERVER_ROOM_UNKNOWN: { gate, blocking: true,
    message: 'The room id in the path is not in the registry.',
    repair: 'Use a room id from GET /api/registry.' },
};
